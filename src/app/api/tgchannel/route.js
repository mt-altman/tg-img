export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';

// 定义通用的 CORS 头，方便复用
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', // 允许 OPTIONS 方法
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24小时
};

// 处理 CORS 预检请求 (OPTIONS)
export async function OPTIONS(request) {
    return new Response(null, {
        status: 204, // No Content
        headers: corsHeaders,
    });
}

/**
 * 根据文件 MIME 类型获取 Telegram API 的终结点和表单字段名
 * @param {string} fileType - 文件的 MIME 类型
 * @returns {{endpoint: string, formFieldName: string}}
 */
function getTelegramEndpoint(fileType) {
    if (fileType.startsWith('image/')) return { endpoint: 'sendPhoto', formFieldName: 'photo' };
    if (fileType.startsWith('video/')) return { endpoint: 'sendVideo', formFieldName: 'video' };
    if (fileType.startsWith('audio/')) return { endpoint: 'sendAudio', formFieldName: 'audio' };
    // 默认为文档类型
    return { endpoint: 'sendDocument', formFieldName: 'document' };
}

/**
 * 从 Telegram API 的响应中提取文件信息
 * @param {object} responseData - Telegram API 返回的 JSON 对象
 * @returns {{file_id: string, file_name: string} | null}
 */
function extractFileData(responseData) {
    if (!responseData.ok) {
        return null;
    }
    const result = responseData.result;
    if (result.photo) {
        // Telegram 会为图片生成多个尺寸，选择最大尺寸的图片
        const largestPhoto = result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        );
        return { file_id: largestPhoto.file_id, file_name: largestPhoto.file_unique_id };
    }
    const file = result.document || result.video || result.audio;
    if (file) {
        return { file_id: file.file_id, file_name: file.file_name || file.file_unique_id };
    }
    return null;
}

/**
 * 插入图片信息到数据库
 * @param {D1Database} db - D1 数据库实例
 * @param {string} src - 文件路径
 * @param {string} referer - 请求来源
 * @param {string} ip - 客户端 IP
 * @param {number} rating - 内容评级
 * @param {string} time - 当前时间
 */
async function insertImageData(db, src, referer, ip, rating, time) {
    try {
        await db.prepare(
            `INSERT INTO imginfo (url, referer, ip, rating, total, time) VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(src, referer, ip, rating, time).run();
    } catch (error) {
        // 在生产环境中，更详细地记录错误，而不是简单地忽略
        console.error("Database insert error:", error);
    }
}

/**
 * 获取格式化的当前时间 (东八区)
 * @returns {string}
 */
function getNowTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * 获取文件路径
 * @param {object} env
 * @param {string} file_id
 * @returns {Promise<string|null>}
 */
async function getFilePath(env, file_id) {
	const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${file_id}`;
	try {
		const response = await fetch(url);
		const data = await response.json();
		if (data.ok) {
			return data.result.file_path;
		}
		console.error('Failed to get file path from Telegram:', data);
		return null;
	} catch (error) {
		console.error('Error fetching file path:', error);
		return null;
	}
}


/**
 * 获取内容评级
 * @param {object} env
 * @param {string} file_id
 * @returns {Promise<number>}
 */
async function getRating(env, file_id) {
    const filePath = await getFilePath(env, file_id);
    if (!filePath) {
        return -1; // 获取文件路径失败
    }

    const ratingApi = env.RATINGAPI || (env.ModerateContentApiKey ? `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&` : null);
    if (!ratingApi) {
        return 0; // 未配置评级 API
    }

    try {
        const fullApiUrl = `${ratingApi}url=https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;
        const response = await fetch(fullApiUrl);
        const data = await response.json();
        return data.rating_index ?? -1; // 使用空值合并运算符简化
    } catch (error) {
        console.error("Rating API error:", error);
        return -1; // API 请求异常
    }
}


// 主处理函数
export async function POST(request) {
    try {
        const { env } = getRequestContext();
        const requestUrl = new URL(request.url);

        // 1. 更安全、高效地获取客户端信息
        const clientIp = request.headers.get('CF-Connecting-IP') || 'IP not found';
        const referer = request.headers.get('Referer') || "Referer not found";

        const formData = await request.formData();
        const file = formData.get('file');

        // 2. 增加对上传文件的校验
        if (!file || !(file instanceof File)) {
            return new Response(JSON.stringify({ message: 'File not provided or is invalid.' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // 3. 简化文件类型判断逻辑
        const { endpoint, formFieldName } = getTelegramEndpoint(file.type);

        // 4. 转发文件到 Telegram
        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_CHAT_ID);
        telegramFormData.append(formFieldName, file, file.name); // 增加文件名

        const telegramApiUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`;
        const telegramResponse = await fetch(telegramApiUrl, {
            method: "POST",
            body: telegramFormData,
        });

        const telegramResult = await telegramResponse.json();

        // 5. 统一和改进的错误处理
        if (!telegramResponse.ok || !telegramResult.ok) {
            console.error("Failed to upload to Telegram. API Response:", JSON.stringify(telegramResult));
            return new Response(JSON.stringify({
                message: "Failed to upload file to Telegram.",
                telegram_response: telegramResult,
            }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); // Bad Gateway
        }

        const fileData = extractFileData(telegramResult);
        if (!fileData) {
            console.error("Could not extract file data from Telegram response:", JSON.stringify(telegramResult));
            return new Response(JSON.stringify({ message: 'Could not process Telegram response.' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const responsePayload = {
            url: `${requestUrl.origin}/api/cfile/${fileData.file_id}`,
            code: 200,
            name: fileData.file_name,
        };

        // 6. 异步执行非关键任务（数据库写入和评级）
        // `ctx.waitUntil` 允许响应立即返回给客户端，而让这些任务在后台继续执行
        const { ctx } = getRequestContext();
        ctx.waitUntil((async () => {
            if (env.IMG) {
                const nowTime = getNowTime();
                const ratingIndex = await getRating(env, fileData.file_id);
                await insertImageData(env.IMG, `/cfile/${fileData.file_id}`, referer, clientIp, ratingIndex, nowTime);
            }
        })());

        // 立即返回成功响应给用户
        return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("An unexpected error occurred in the POST handler:", error);
        return new Response(JSON.stringify({ message: `An unexpected error occurred: ${error.message}` }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}

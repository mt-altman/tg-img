export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';

// 1. 定义通用的 CORS 头，供所有响应复用
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', // 允许 GET, POST, OPTIONS 方法
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400', // 24小时
};

// 2. 处理 CORS 预检请求 (OPTIONS)
export async function OPTIONS(request) {
    return new Response(null, {
        status: 204, // No Content
        headers: corsHeaders,
    });
}

// 3. 核心 GET 请求处理函数 (用于下载/展示文件)
export async function GET(request, { params }) {
  const { name: file_id } = params; // `name` 对应路由中的 [name]
  const { env, ctx } = getRequestContext();
  const req_url = new URL(request.url);

  // 规范化获取 IP 的方式，优先使用 Cloudflare 提供的标准头
  const clientIp = request.headers.get('CF-Connecting-IP') || 'IP not found';
  const referer = request.headers.get('Referer') || "Referer not found";

  try {
    // 步骤 1: 获取临时的文件路径
    const file_path = await getFilePathFromTelegram(env, file_id);

    if (!file_path) {
      return new Response(JSON.stringify({
        message: "从 Telegram API 获取文件路径失败。请检查 file_id 是否有效或服务器日志。",
        success: false
      }), {
        status: 502, // Bad Gateway, 表示上游服务器问题
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 步骤 2: 使用临时路径下载文件
    const fileName = file_path.split('/').pop();
    const fileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${file_path}`;
    const telegramResponse = await fetch(fileUrl);

    if (!telegramResponse.ok) {
       const errorText = await telegramResponse.text();
       return new Response(JSON.stringify({
          message: `从 Telegram API 下载文件失败。上游API返回: ${errorText}`,
          success: false
        }), {
          status: telegramResponse.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // 检查 Referer 决定是否记录日志和进行评级
    const isAdminReferer = referer.startsWith(`${req_url.origin}/admin`) || referer.startsWith(`${req_url.origin}/list`);
    
    if (isAdminReferer || !env.IMG) {
      const responseHeaders = new Headers(telegramResponse.headers);
      responseHeaders.set("Content-Disposition", `inline; filename="${fileName}"`);
      return new Response(telegramResponse.body, { status: 200, headers: responseHeaders });
    }

    // 对于外部访问，执行日志记录和评级检查
    const fileBuffer = await telegramResponse.arrayBuffer();
    const nowTime = getNowTime();
    const urlPath = `/api/cfile/${file_id}`;

    ctx.waitUntil(insertViewLog(env.IMG, urlPath, referer, clientIp, nowTime));

    const ratingInfo = await getRatingFromDb(env.IMG, urlPath, ctx);
    if (ratingInfo && ratingInfo.rating === 3) { // 假设 3 是屏蔽等级
      return Response.redirect(`${req_url.origin}/img/blocked.png`, 302);
    }
    
    const responseHeaders = new Headers(telegramResponse.headers);
    responseHeaders.set("Content-Disposition", `inline; filename="${fileName}"`);
    return new Response(fileBuffer, { status: 200, headers: responseHeaders });

  } catch (error) {
    console.error("GET handler unexpected error:", error);
    return new Response(JSON.stringify({
      message: `服务器内部错误: ${error.message}`,
      success: false
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}


// 4. 核心 POST 请求处理函数 (用于上传文件)
export async function POST(request) {
    try {
        const { env, ctx } = getRequestContext();
        const requestUrl = new URL(request.url);

        const clientIp = request.headers.get('CF-Connecting-IP') || 'IP not found';
        const referer = request.headers.get('Referer') || "Referer not found";

        const formData = await request.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof File)) {
            return new Response(JSON.stringify({ message: '未提供文件或文件无效。' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { endpoint, formFieldName } = getTelegramEndpoint(file.type);

        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_CHAT_ID);
        telegramFormData.append(formFieldName, file, file.name);

        const telegramApiUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${endpoint}`;
        const telegramResponse = await fetch(telegramApiUrl, { method: "POST", body: telegramFormData });
        const telegramResult = await telegramResponse.json();

        if (!telegramResponse.ok || !telegramResult.ok) {
            console.error("上传到 Telegram 失败。API 响应:", JSON.stringify(telegramResult));
            return new Response(JSON.stringify({ message: "上传文件到 Telegram 失败。", telegram_response: telegramResult }), 
                { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const fileData = extractFileData(telegramResult);
        if (!fileData) {
            console.error("无法从 Telegram 响应中提取文件数据:", JSON.stringify(telegramResult));
            return new Response(JSON.stringify({ message: '无法处理 Telegram 的响应。' }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const responsePayload = {
            url: `${requestUrl.origin}/api/cfile/${fileData.file_id}`,
            code: 200,
            name: fileData.file_name,
        };

        // 异步执行非关键任务（数据库写入和评级）
        ctx.waitUntil((async () => {
            if (env.IMG) {
                const nowTime = getNowTime();
                const ratingIndex = await getRatingFromApi(env, fileData.file_id);
                await insertUploadData(env.IMG, `/api/cfile/${fileData.file_id}`, referer, clientIp, ratingIndex, nowTime);
            }
        })());

        // 立即返回成功响应给用户
        return new Response(JSON.stringify(responsePayload), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("POST 处理函数中发生意外错误:", error);
        return new Response(JSON.stringify({ message: `发生意外错误: ${error.message}` }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
}


// --- 辅助函数 ---

// -- 通用函数 --
function getNowTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric',
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

// -- GET 请求相关的辅助函数 --

async function getFilePathFromTelegram(env, file_id) {
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${file_id}`;
  try {
    // 移除固定的 User-Agent，使用 Cloudflare Functions 的默认值，特征性更弱
    const res = await fetch(url);
    const responseData = await res.json();
    if (responseData.ok) return responseData.result.file_path;
    
    console.error("getFile_path failed:", responseData.description || "Unknown error");
    return null;
  } catch (error) {
    console.error("Error in getFile_path fetch:", error);
    return null;
  }
}

async function insertViewLog(DB, url, referer, ip, time) {
  try {
    await DB.prepare('INSERT INTO tgimglog (url, referer, ip, time) VALUES (?, ?, ?, ?)')
      .bind(url, referer, ip, time).run();
  } catch (e) {
    console.error("插入 tgimglog 失败:", e);
  }
}

async function getRatingFromDb(DB, urlPath, ctx) {
    try {
        const ps = DB.prepare(`SELECT rating FROM imginfo WHERE url = ?`).bind(urlPath);
        const result = await ps.first();
        if (result) {
            ctx.waitUntil(DB.prepare(`UPDATE imginfo SET total = total + 1 WHERE url = ?;`).bind(urlPath).run());
        }
        return result;
    } catch (e) {
        console.error("从数据库获取评级失败:", e);
        return null;
    }
}

// -- POST 请求相关的辅助函数 --

function getTelegramEndpoint(fileType) {
    if (fileType.startsWith('image/')) return { endpoint: 'sendPhoto', formFieldName: 'photo' };
    if (fileType.startsWith('video/')) return { endpoint: 'sendVideo', formFieldName: 'video' };
    if (fileType.startsWith('audio/')) return { endpoint: 'sendAudio', formFieldName: 'audio' };
    return { endpoint: 'sendDocument', formFieldName: 'document' };
}

function extractFileData(responseData) {
    if (!responseData.ok) return null;
    const result = responseData.result;
    if (result.photo) {
        const largestPhoto = result.photo.reduce((prev, current) => (prev.file_size > current.file_size) ? prev : current);
        return { file_id: largestPhoto.file_id, file_name: largestPhoto.file_unique_id };
    }
    const file = result.document || result.video || result.audio;
    if (file) return { file_id: file.file_id, file_name: file.file_name || file.file_unique_id };
    return null;
}

async function insertUploadData(db, src, referer, ip, rating, time) {
    try {
        await db.prepare(`INSERT INTO imginfo (url, referer, ip, rating, total, time) VALUES (?, ?, ?, ?, 1, ?)`)
          .bind(src, referer, ip, rating, time).run();
    } catch (error) {
        console.error("插入 imginfo 失败:", error);
    }
}

async function getRatingFromApi(env, file_id) {
    const filePath = await getFilePathFromTelegram(env, file_id);
    if (!filePath) return -1;

    const ratingApiBase = env.RATINGAPI || (env.ModerateContentApiKey ? `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&` : null);
    if (!ratingApiBase) return 0;

    try {
        const fullFileUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${filePath}`;
        const ratingApiUrl = `${ratingApiBase}url=${encodeURIComponent(fullFileUrl)}`;
        const response = await fetch(ratingApiUrl);
        const data = await response.json();
        return data.rating_index ?? -1;
    } catch (error) {
        console.error("调用评级 API 出错:", error);
        return -1;
    }
}

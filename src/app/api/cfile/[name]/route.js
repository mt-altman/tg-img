export const runtime = 'edge';
import { getRequestContext } from '@cloudflare/next-on-pages';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400', // 24 hours
  'Content-Type': 'application/json'
};

export async function GET(request, { params }) {
  const { name } = params
  let { env, cf, ctx } = getRequestContext();

  let req_url = new URL(request.url);

  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || (request.socket ? request.socket.remoteAddress : null);
  const clientIp = ip ? ip.split(',')[0].trim() : 'IP not found';
  const Referer = request.headers.get('Referer') || "Referer not found";

  try {
    const file_path = await getFile_path(env, name);
    

    if (file_path === "error") {
      // **修复点 1**: 当 getFile_path 返回 "error" 时，提供一个明确的错误信息
      return Response.json({
        status: 500,
        message: `从 Telegram API 获取文件路径失败 (Failed to get file path from Telegram API).`,
        success: false
      }, {
        status: 500,
        headers: corsHeaders,
      });

    } else {
      const fileName = file_path.split('/').pop();
      const res = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${file_path}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      if (res.ok) {
        const fileBuffer = await res.arrayBuffer();
        if (Referer == req_url.origin + "/admin" || Referer == req_url.origin + "/list" || Referer == req_url.origin + "/" || !env.IMG) {
          return new Response(fileBuffer, {
            headers: {
              "Content-Disposition": `attachment; filename=${fileName}`,
              // 建议添加 Content-Type，让浏览器知道如何处理文件
              // "Content-Type": "image/jpeg", // or other appropriate type
            },
          });
        } else {
          const nowTime = await get_nowTime()
          await insertTgImgLog(env.IMG, `/cfile/${name}`, Referer, clientIp, nowTime);
          const rating = await getRating(env.IMG, `/cfile/${name}`);

          if (rating) {
            try {
              // 异步执行，不需要等待其完成
              ctx.waitUntil(env.IMG.prepare(`UPDATE imginfo SET total = total + 1 WHERE url = ?;`).bind(`/cfile/${name}`).run());
            } catch (error) {
              console.log(error);
            }
            if (rating.rating == 3) {
              return Response.redirect(`${req_url.origin}/img/blocked.png`, 302);
            } else {
              return new Response(fileBuffer, {
                headers: {
                  "Content-Disposition": `attachment; filename=${fileName}`,
                },
              });
            }
          } else {
            // **修复点 2**: 当数据库中没有评级信息时，返回明确提示
            // 可以在这里添加首次获取评级的逻辑
            return Response.json({
              status: 404,
              message: `无法找到该资源的评级信息 (Rating information not found for this resource).`,
              success: false
            }, {
              status: 404,
              headers: corsHeaders,
            });
          }
        }
      } else {
        // **修复点 3**: 当从 Telegram 获取文件失败时，返回上游的错误信息
        const errorText = await res.text();
        return Response.json({
          status: res.status,
          message: `从 Telegram API 获取文件失败。上游API返回: ${errorText}`,
          success: false
        }, {
          status: res.status,
          headers: corsHeaders,
        });
      }
    }
  } catch (error) {
    // 顶层 catch 块保持不变，用于捕获意外错误
    return Response.json({
      status: 500,
      message: `服务器内部错误: ${error.message}`,
      success: false
    }, {
      status: 500,
      headers: corsHeaders,
    });
  }
}

async function getFile_path(env, file_id) {
  try {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${file_id}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
    })

    let responseData = await res.json();

    if (responseData.ok && responseData.result.file_path) {
      return responseData.result.file_path;
    } else {
      console.error("getFile_path failed:", responseData.description || "Unknown error");
      return "error";
    }
  } catch (error) {
    console.error("Error in getFile_path:", error);
    return "error";
  }
}

// 插入 tgimglog 记录
async function insertTgImgLog(DB, url, referer, ip, time) {
  try {
    const iImglog = await DB.prepare('INSERT INTO tgimglog (url, referer, ip, time) VALUES (?, ?, ?, ?)')
      .bind(url, referer, ip, time)
      .run();
  } catch (e) {
    console.error("Failed to insert into tgimglog:", e)
  }
}

// 插入 imginfo 记录
async function insertImgInfo(DB, url, referer, ip, rating, time) {
  try {
    const instdata = await DB.prepare(
      `INSERT INTO imginfo (url, referer, ip, rating, total, time) VALUES (?, ?, ?, ?, 1, ?)`
    ).bind(url, referer, ip, rating, time).run();
  } catch (error) {
    console.error("Failed to insert into imginfo:", error);
  };
}

// 从数据库获取鉴黄信息
async function getRating(DB, url) {
    try {
        const ps = DB.prepare(`SELECT rating FROM imginfo WHERE url = ?`).bind(url);
        const result = await ps.first();
        return result; // 如果没有找到，会返回 null
    } catch (e) {
        console.error("Failed to get rating from DB:", e)
        return null; // 出错时也返回 null
    }
}

// 调用 ModerateContent API 鉴黄
async function getModerateContentRating(env, url) {
  try {
    const apikey = env.ModerateContentApiKey
    const ModerateContentUrl = apikey ? `https://api.moderatecontent.com/moderate/?key=${apikey}&` : ""
    const ratingApi = env.RATINGAPI ? `${env.RATINGAPI}?` : ModerateContentUrl;
    
    if (ratingApi) {
      console.log(`Fetching rating from: ${ratingApi}url=https://telegra.ph${url}`);
      const res = await fetch(`${ratingApi}url=https://telegra.ph${url}`);
      const data = await res.json();
      // 使用 hasOwnProperty 确保属性存在
      const rating_index = data.hasOwnProperty('rating_index') ? data.rating_index : -1;
      return rating_index;
    } else {
      return 0; // 没有配置 API，返回默认值
    }
  } catch (error) {
    console.error("Error in getModerateContentRating:", error);
    return -1; // API调用失败
  }
}

async function get_nowTime() {
  const options = {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  };
  const formatter = new Intl.DateTimeFormat('zh-CN', options);
  const parts = formatter.formatToParts(new Date());
  
  const formattedDate = parts.map(p => p.value).join('').replace(/\//g, '-');

  return formattedDate;
}

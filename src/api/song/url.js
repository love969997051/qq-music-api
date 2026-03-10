/**
 * 歌曲播放链接 API
 * GET /api/song/url?mid=xxx&quality=flac
 */

import { batchRequest, jsonResponse, errorResponse, handleOptions } from "../../lib/request.js";
import { getGuid, parseQuality, SongFileType } from "../../lib/common.js";
import { ensureCredentialTable, getCredentialFromDB, parseCredential, saveCredentialToDB } from "../../lib/credential.js";

/**
 * 音质降级顺序
 */
const QUALITY_FALLBACK = ["master", "atmos_2", "atmos_51", "flac", "320", "128"];

/**
 * 获取凭证
 */
async function getCredential(env) {
    await ensureCredentialTable(env.DB);
    let credential = await getCredentialFromDB(env.DB);

    if (!credential && env.INITIAL_CREDENTIAL) {
        const initial = parseCredential(env.INITIAL_CREDENTIAL);
        if (initial) {
            await saveCredentialToDB(env.DB, initial);
            credential = initial;
        }
    }

    return credential;
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === "OPTIONS") {
        return handleOptions();
    }

    if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405);
    }

    try {
        const url = new URL(request.url);
        const midParam = url.searchParams.get("mid");
        const requestedQuality = url.searchParams.get("quality") || "flac";

        if (!midParam) {
            return errorResponse("Missing required parameter: mid", 400);
        }

        const mids = midParam.split(",").map(m => m.trim()).filter(Boolean);

        if (mids.length === 0) {
            return errorResponse("Invalid mid parameter", 400);
        }

        const credential = await getCredential(env);
        const domain = "https://isure.stream.qqmusic.qq.com/";

        const { generateSign } = await import("../../lib/sign.js");
        const { API_CONFIG } = await import("../../lib/common.js");
        const { buildCookies } = await import("../../lib/request.js");

        const startIndex = QUALITY_FALLBACK.indexOf(requestedQuality.toLowerCase());
        const qualityQueue = startIndex >= 0
            ? QUALITY_FALLBACK.slice(startIndex)
            : QUALITY_FALLBACK;

        let actualQuality = requestedQuality;
        let urls = {};
        let requestUrl = ""; // 用于存储最后请求的 URL

        for (const quality of qualityQueue) {
            const fileType = parseQuality(quality);
            const fileNames = mids.map(mid => `${fileType.s}${mid}${mid}${fileType.e}`);

            const params = {
                filename: fileNames,
                guid: getGuid(),
                songmid: mids,
                songtype: mids.map(() => 0),
            };

            const requestData = {
                comm: {
                    ct: "19",
                    cv: 13020508,
                    v: 13020508,
                    format: "json",
                },
                "music.vkey.GetVkey.UrlGetVkey": {
                    module: "music.vkey.GetVkey",
                    method: "UrlGetVkey",
                    param: params,
                },
            };

            if (credential) {
                requestData.comm.qq = String(credential.musicid);
                requestData.comm.authst = credential.musickey;
                requestData.comm.tmeLoginType = String(credential.login_type || 2);
            }

            const signature = await generateSign(requestData);
            requestUrl = `${API_CONFIG.endpoint}?sign=${signature}`; // 存储 URL

            const headers = {
                "Content-Type": "application/json",
                "Referer": "https://y.qq.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Origin": "https://y.qq.com",
            };

            if (credential) {
                headers["Cookie"] = buildCookies(credential);
            }

            const response = await fetch(requestUrl, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(requestData),
            });

            const data = await response.json();
            const result = data["music.vkey.GetVkey.UrlGetVkey"];

            if (!result || result.code !== 0) {
                continue; // 尝试下一个音质
            }

            const midurlinfo = result.data?.midurlinfo || [];
            let hasValidUrl = false;

            for (const info of midurlinfo) {
                const purl = info.purl || info.wifiurl || "";
                if (purl) {
                    urls[info.songmid] = domain + purl;
                    hasValidUrl = true;
                } else {
                    urls[info.songmid] = "";
                }
            }

            if (hasValidUrl) {
                actualQuality = quality;
                break;
            }
        }

        return jsonResponse({
            code: 0,
            data: urls,
            quality: actualQuality,
            request_url: requestUrl // 返回最后成功请求的 URL
        });

    } catch (err) {
        console.error("获取歌曲链接失败:", err);
        return errorResponse(err.message, 500);
    }
}

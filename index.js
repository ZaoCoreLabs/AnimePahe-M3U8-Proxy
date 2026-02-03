import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import nodeFetch from 'node-fetch';
import { CONFIG } from './config.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cookieJar = new Map();

function createSafeSender(res) {
    let sent = false;
    return (statusCode, data) => {
        if (!sent) {
            sent = true;
            res.status(statusCode).send(data);
        }
    };
}

function buildUpstreamHeaders(req, url, headersParam) {
    const headers = {
        "User-Agent": CONFIG.DEFAULT_USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive"
    };

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;
    if (headersParam) {
        try {
            const additionalHeaders = JSON.parse(headersParam);
            Object.entries(additionalHeaders).forEach(([key, value]) => {
                const lk = key.toLowerCase();
                headers[lk] = value;
                if (lk === 'referer' || lk === 'referrer') referer = value;
            });
        } catch (e) { }
    }

    if (referer) {
        let refStr = decodeURIComponent(referer);
        if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) {
            refStr += '/';
        }
        headers['referer'] = refStr;

        try {
            headers['origin'] = new URL(refStr).origin;
        } catch (e) {
            headers['origin'] = refStr;
        }
    }

    if (!headers['origin'] || headers['origin'].includes('localhost')) {
        headers['origin'] = url.origin;
    }
    if (!headers['referer']) {
        headers['referer'] = url.origin;
    }

    const storedCookies = cookieJar.get(url.hostname);
    if (storedCookies) {
        headers['cookie'] = headers['cookie']
            ? `${headers['cookie']}; ${storedCookies}`
            : storedCookies;
    }

    return headers;
}

function updateCookieJar(url, targetResponse) {
    const setCookie = targetResponse.headers.raw()['set-cookie'];
    if (setCookie) {
        const current = cookieJar.get(url.hostname) || "";
        const merged = [...new Set([
            ...current.split('; '),
            ...setCookie.map(c => c.split(';')[0])
        ])].filter(Boolean).join('; ');

        cookieJar.set(url.hostname, merged);
    }
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    res.setHeader('Cache-Control', CONFIG.CACHE_CONTROL);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function proxyPlaylistContent(content, url, headersParam) {
    return content.split("\n").map((line) => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith("#EXTM3U") || trimmed.startsWith("#EXT-X-VERSION")) {
            return line;
        }

        if (trimmed.startsWith("#")) {
            return line.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(abs)}`;
                    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
                    return `${prefix}${proxyUrl}${suffix}`;
                } catch (e) {
                    return match;
                }
            });
        }

        try {
            const abs = new URL(trimmed, url.href).href;
            let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(abs)}`;
            if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
            return proxyUrl;
        } catch (e) {
            return line;
        }
    }).join("\n");
}

async function checkForErrorPage(targetResponse) {
    const type = targetResponse.headers.get('content-type') || "";
    const len = targetResponse.headers.get('content-length');

    if (type.includes('text/html') || (len && parseInt(len) < CONFIG.ERROR_PAGE_SIZE_THRESHOLD)) {
        const clone = targetResponse.clone();
        const text = await clone.text();
        if (text.includes('<html') || text.includes('<!DOCTYPE')) {
            return { isError: true, body: text };
        }
    }

    return { isError: false };
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.get("/m3u8-proxy", async (req, res) => {
    const safeSend = createSafeSender(res);

    try {
        const urlStr = req.query.url;
        if (!urlStr) {
            return safeSend(400, { message: "URL is required" });
        }

        const url = new URL(urlStr);
        const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : "";
        const headers = buildUpstreamHeaders(req, url, headersParam);

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = url.pathname.endsWith(".mp4") ? "0" : "1";

        const targetResponse = await nodeFetch(url.href, {
            headers,
            redirect: 'follow',
            compress: false
        });

        updateCookieJar(url, targetResponse);
        setCorsHeaders(req, res);

        const isPlaylist = url.pathname.toLowerCase().endsWith(".m3u8") ||
            targetResponse.headers.get('content-type')?.includes("mpegURL");

        if (isPlaylist) {
            const content = await targetResponse.text();
            const proxiedContent = proxyPlaylistContent(content, url, headersParam);
            res.setHeader('Content-Type', targetResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
            res.status(200).send(proxiedContent);
        } else {
            const errorCheck = await checkForErrorPage(targetResponse);
            if (errorCheck.isError) {
                return safeSend(502, {
                    message: "Upstream returned error page",
                    body: errorCheck.body.substring(0, 1000)
                });
            }

            targetResponse.headers.forEach((v, k) => {
                if (CONFIG.UPSTREAM_HEADERS.includes(k.toLowerCase())) {
                    res.setHeader(k, v);
                }
            });

            res.writeHead(targetResponse.status);
            if (targetResponse.body) {
                targetResponse.body.pipe(res);
            } else {
                res.end();
            }
        }
    } catch (e) {
        if (!res.headersSent) {
            safeSend(500, { message: e.message });
        }
    }
});

app.listen(CONFIG.PORT, () => {
    console.log(`Server listening on PORT: ${CONFIG.PORT}`);
});

// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel (sfo1/fra1)
const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');
const HlsRewriter = require('../lib/hls_rewriter');
const CookieJar = require('../lib/cookie_jar');
const VideoExtractor = require('../lib/extractor');
const DomSandbox = require('../lib/dom_sandbox');
const EvasionEngine = require('../lib/evasion');
const { AstRewriter } = require('../lib/ast_parser');
const MediaEngine = require('../lib/media_engine');

function extractTargetUrl(req) {
  const fullUrl = req.url || '';

  // Base64 (?b64url=...)
  const b64Match = fullUrl.match(/[?&]b64url=([^&]+)/);
  if (b64Match && b64Match[1]) {
    try {
      return Buffer.from(decodeURIComponent(b64Match[1]), 'base64').toString('utf-8');
    } catch (e) {}
  }

  // Explicit (?url=...)
  const match = fullUrl.match(/[?&]url=([^&]+.*)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  if (req.query && req.query.url) {
    return req.query.url;
  }

  // Session Cookie resolution
  const cookieJar = CookieJar.deserializeFromClientCookie(req);
  const sessionTarget = cookieJar.get('__target_origin');
  if (sessionTarget) {
    try {
      let subPath = fullUrl;
      if (req.query && req.query.fallback_path) {
        subPath = req.query.fallback_path;
        if (!subPath.startsWith('/')) subPath = '/' + subPath;
      }
      return new URL(subPath, sessionTarget).toString();
    } catch (e) {}
  }

  return '';
}

function renderCinemaPlayer(streams, originalPageUrl, proxyHost) {
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;
  const primaryStream = streams[0];
  const proxiedVideoUrl = `${proxyBase}${encodeURIComponent(primaryStream.url)}`;
  const isHls = primaryStream.type.includes('mpegURL') || primaryStream.url.includes('.m3u8');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Industrial Cinema Stream</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #030712; color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    .header { background: #111827; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .info { display: flex; align-items: center; gap: 12px; max-width: 65%; }
    .tag { background: #7c3aed; color: #fff; font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 4px; text-transform: uppercase; }
    .title { font-weight: 600; font-size: 14px; color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; gap: 10px; align-items: center; }
    .btn { background: #1f2937; color: #f3f4f6; text-decoration: none; border: 1px solid rgba(255,255,255,0.1); padding: 7px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
    .btn:hover { background: #374151; }
    .btn-exit { background: #e11d48; border: none; }
    .btn-exit:hover { background: #be123c; }
    .player-container { flex: 1; display: flex; align-items: center; justify-content: center; background: #000; position: relative; }
    video { width: 100%; height: 100%; max-height: calc(100vh - 60px); outline: none; }
  </style>
</head>
<body>
  <div class="header">
    <div class="info">
      <span class="tag">${primaryStream.quality || 'HD'}</span>
      <span class="title">⚡ Direct Stream: ${originalPageUrl}</span>
    </div>
    <div class="actions">
      <a href="${proxiedVideoUrl}" download="video.mp4" class="btn">⬇ Download Stream</a>
      <a href="/" class="btn btn-exit">⚡ Exit Player</a>
    </div>
  </div>
  <div class="player-container">
    <video id="video-element" controls autoplay playsinline controlslist="nodownload"></video>
  </div>
  <script>
    const video = document.getElementById('video-element');
    const streamSrc = "${proxiedVideoUrl}";
    const isHls = ${isHls};

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(streamSrc);
      hls.attachMedia(video);
    } else {
      video.src = streamSrc;
    }
  </script>
</body>
</html>`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let rawTarget = extractTargetUrl(req);
  if (!rawTarget) {
    return res.status(400).json({ error: 'Target URL missing or expired' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';
    const proxyBase = `https://${proxyHost}/api/proxy?url=`;

    // Initialize Virtual Cookie Jar
    const cookieJar = CookieJar.deserializeFromClientCookie(req);
    cookieJar.set('__target_origin', targetObj.origin);

    const evasionHeaders = EvasionEngine.getEvasionHeaders(targetObj.origin);
    const upstreamHeaders = {
      ...evasionHeaders,
      'Cookie': cookieJar.toHeaderString()
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(targetObj.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    const finalTargetUrl = response.url || targetObj.toString();
    const finalOrigin = new URL(finalTargetUrl).origin;
    const contentType = response.headers.get('content-type') || '';

    // Update Virtual Cookie Jar with Upstream Set-Cookie
    const rawSetCookies = response.headers.raw ? response.headers.raw()['set-cookie'] : response.headers.get('set-cookie');
    if (rawSetCookies) {
      cookieJar.addSetCookieHeaders(rawSetCookies, targetObj.origin);
    }

    res.setHeader('Set-Cookie', cookieJar.serializeToClientCookie());

    // Copy Upstream Headers
    const blockedHeaders = [
      'content-length',
      'content-encoding',
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'strict-transport-security',
      'cross-origin-resource-policy',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'transfer-encoding'
    ];

    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!blockedHeaders.includes(lower) && lower !== 'set-cookie') {
        res.setHeader(key, value);
      }
    });

    // 1. Handle HLS Manifests (.m3u8)
    if (contentType.includes('mpegurl') || finalTargetUrl.includes('.m3u8')) {
      const manifestText = await response.text();
      const mediaEngine = new MediaEngine(proxyBase, finalTargetUrl);
      const processed = mediaEngine.processHlsManifest(manifestText);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      return res.status(response.status).send(processed.content);
    }

    // 2. Handle MPEG-DASH Manifests (.mpd)
    if (contentType.includes('dash+xml') || finalTargetUrl.includes('.mpd')) {
      const dashXml = await response.text();
      const mediaEngine = new MediaEngine(proxyBase, finalTargetUrl);
      const processed = mediaEngine.processDashManifest(dashXml);
      res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
      return res.status(response.status).send(processed);
    }

    // 3. Handle JavaScript Assets (Rewrite AST to trap location/cookies)
    if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
      const jsCode = await response.text();
      const astRewriter = new AstRewriter(proxyBase, finalOrigin, finalTargetUrl);
      const transformedJs = astRewriter.rewrite(jsCode);
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      return res.status(response.status).send(transformedJs);
    }

    // 4. Handle HTML Webpages
    if (contentType.includes('text/html')) {
      const bodyText = await response.text();

      // Direct Stream Mode
      const isStreamMode = req.query && (req.query.mode === 'stream' || req.query.action === 'extract');
      if (isStreamMode) {
        const streams = VideoExtractor.extract(bodyText, finalTargetUrl);
        if (streams.length > 0) {
          const cinemaHtml = renderCinemaPlayer(streams, finalTargetUrl, proxyHost);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.status(200).send(cinemaHtml);
        }
      }

      // Inject DomSandbox & Evasion Shields
      const sandboxScript = DomSandbox.generateSandboxScript(proxyBase, finalTargetUrl);
      const evasionScript = EvasionEngine.generateEvasionScript();
      
      const floatingToolbar = `
      <div id="__vproxy_hud" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:rgba(15,23,42,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.15);padding:8px 14px;border-radius:9999px;box-shadow:0 10px 25px rgba(0,0,0,0.6);font-family:sans-serif;font-size:12px;color:#fff;">
        <button onclick="window.history.back()" style="background:#334155;color:#fff;border:none;padding:5px 9px;border-radius:6px;cursor:pointer;font-weight:bold;">◀</button>
        <button onclick="window.history.forward()" style="background:#334155;color:#fff;border:none;padding:5px 9px;border-radius:6px;cursor:pointer;font-weight:bold;">▶</button>
        <button onclick="window.location.reload()" style="background:#334155;color:#fff;border:none;padding:5px 9px;border-radius:6px;cursor:pointer;font-weight:bold;">↻</button>
        <a href="/?mode=stream&url=${encodeURIComponent(finalTargetUrl)}" style="background:#8b5cf6;color:#fff;text-decoration:none;padding:5px 12px;border-radius:6px;font-weight:bold;">🎬 Stream Video</a>
        <a href="/" style="background:#e11d48;color:#fff;text-decoration:none;padding:5px 10px;border-radius:6px;font-weight:bold;">⚡ Exit</a>
      </div>
      `;

      let finalHtml = bodyText;
      const injectionBlock = evasionScript + sandboxScript;

      if (finalHtml.includes('<head>')) {
        finalHtml = finalHtml.replace('<head>', `<head>${injectionBlock}`);
      } else {
        finalHtml = injectionBlock + finalHtml;
      }

      if (finalHtml.includes('</body>')) {
        finalHtml = finalHtml.replace('</body>', `${floatingToolbar}</body>`);
      } else {
        finalHtml = finalHtml + floatingToolbar;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(response.status).send(finalHtml);
    }

    // 5. Binary Media & Chunks
    res.status(response.status);
    if (response.body && typeof response.body.pipe === 'function') {
      return response.body.pipe(res);
    } else {
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    }

  } catch (err) {
    return res.status(500).json({ error: 'Proxy Engine Failure', details: err.message });
  }
};

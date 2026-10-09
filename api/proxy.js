// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel (sfo1/fra1 - Geo-Unblocked)
const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

/**
 * Checks if a URL belongs to a CAPTCHA or security verification provider
 */
function isCaptchaOrVerificationUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('challenges.cloudflare.com') ||
    lower.includes('recaptcha') ||
    lower.includes('gstatic.com/recaptcha') ||
    lower.includes('hcaptcha.com') ||
    lower.includes('turnstile') ||
    lower.includes('cf-challenge')
  );
}

/**
 * Extracts cookies from request header
 */
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
  }
  return list;
}

/**
 * Extracts target URL using query parameters, base64, or the __proxy_target session cookie
 */
function extractTargetUrl(req) {
  const fullUrl = req.url || '';

  // 1. Base64 URL mode (?b64url=...)
  const b64Match = fullUrl.match(/[?&]b64url=([^&]+)/);
  if (b64Match && b64Match[1]) {
    try {
      return Buffer.from(decodeURIComponent(b64Match[1]), 'base64').toString('utf-8');
    } catch (e) {}
  }

  // 2. Explicit ?url= parameter
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

  // 3. Cookie-based target resolution
  const cookies = parseCookies(req);
  if (cookies.__proxy_target) {
    try {
      const baseOrigin = cookies.__proxy_target;
      let pathPart = fullUrl;
      if (req.query && req.query.fallback_path) {
        pathPart = req.query.fallback_path;
        if (!pathPart.startsWith('/')) pathPart = '/' + pathPart;
      }
      return new URL(pathPart, baseOrigin).toString();
    } catch (e) {}
  }

  // 4. Referer header fallback
  const referer = req.headers.referer || '';
  if (referer.includes('url=')) {
    const refMatch = referer.match(/url=([^&]+)/);
    if (refMatch && refMatch[1]) {
      try {
        const parentTarget = decodeURIComponent(refMatch[1]);
        const parentObj = new URL(parentTarget);
        let subPath = req.query.fallback_path || fullUrl;
        if (!subPath.startsWith('/')) subPath = '/' + subPath;
        return new URL(subPath, parentObj.origin).toString();
      } catch (e) {}
    }
  }

  return '';
}

function resolveToAbsolute(val, baseOrigin) {
  try {
    if (!val) return val;
    if (val.startsWith('//')) return 'https:' + val;
    if (val.startsWith('http://') || val.startsWith('https://')) return val;
    return new URL(val, baseOrigin).toString();
  } catch (e) {
    return val;
  }
}

/**
 * Rewrites HTML tags and attributes while allowing CAPTCHA providers to load natively
 */
function rewriteHtml(html, targetOrigin, proxyHost) {
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  let out = html;

  // Rewrite standard DOM attributes
  out = out.replace(
    /(href|src|action|poster|data-src|data-video|data-href)=["']([^"']+)["']/gi,
    (match, attr, val) => {
      if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) {
        return match;
      }
      // Never proxy CAPTCHA scripts/iframes; they must run directly against their providers
      if (isCaptchaOrVerificationUrl(val)) {
        return match;
      }
      const abs = resolveToAbsolute(val, targetOrigin);
      return `${attr}="${proxyBase}${encodeURIComponent(abs)}"`;
    }
  );

  // Rewrite srcset attributes
  out = out.replace(
    /srcset=["']([^"']+)["']/gi,
    (match, val) => {
      const parts = val.split(',').map(item => {
        const trimmed = item.trim();
        const firstSpace = trimmed.indexOf(' ');
        if (firstSpace === -1) {
          if (isCaptchaOrVerificationUrl(trimmed)) return trimmed;
          const abs = resolveToAbsolute(trimmed, targetOrigin);
          return `${proxyBase}${encodeURIComponent(abs)}`;
        }
        const urlPart = trimmed.substring(0, firstSpace);
        const descriptor = trimmed.substring(firstSpace);
        if (isCaptchaOrVerificationUrl(urlPart)) return item;
        const abs = resolveToAbsolute(urlPart, targetOrigin);
        return `${proxyBase}${encodeURIComponent(abs)}${descriptor}`;
      });
      return `srcset="${parts.join(', ')}"`;
    }
  );

  // Rewrite inline CSS url(...)
  out = out.replace(
    /url\(['"]?([^'"\)\s]+)['"]?\)/gi,
    (match, val) => {
      if (val.startsWith('data:') || val.startsWith('#')) return match;
      if (isCaptchaOrVerificationUrl(val)) return match;
      const abs = resolveToAbsolute(val, targetOrigin);
      return `url("${proxyBase}${encodeURIComponent(abs)}")`;
    }
  );

  return out;
}

/**
 * Rewrites external CSS files
 */
function rewriteCss(css, targetOrigin, proxyHost) {
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  return css.replace(
    /url\(['"]?([^'"\)\s]+)['"]?\)/gi,
    (match, val) => {
      if (val.startsWith('data:') || val.startsWith('#')) return match;
      if (isCaptchaOrVerificationUrl(val)) return match;
      const abs = resolveToAbsolute(val, targetOrigin);
      return `url("${proxyBase}${encodeURIComponent(abs)}")`;
    }
  );
}

/**
 * Injects DOM property hooks, CAPTCHA bypass, and a floating proxy controls toolbar
 */
function injectClientHooks(html, finalTargetUrl, proxyHost) {
  const targetObj = new URL(finalTargetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  const script = `
  <script>
    (function() {
      const PROXY_BASE = "${proxyBase}";
      const TARGET_ORIGIN = "${targetObj.origin}";
      const CURRENT_PAGE = "${finalTargetUrl}";

      function isCaptcha(u) {
        if (!u || typeof u !== 'string') return false;
        const l = u.toLowerCase();
        return l.includes('challenges.cloudflare.com') || l.includes('recaptcha') || l.includes('hcaptcha') || l.includes('turnstile');
      }

      // 1. Break frame-busters
      try {
        Object.defineProperty(window, 'top', { get: function() { return window.self; } });
        Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
      } catch(e) {}

      // 2. Wrap arbitrary URLs
      function proxyWrap(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#')) {
          return url;
        }
        if (isCaptcha(url)) return url;
        if (url.startsWith(PROXY_BASE)) return url;

        let absolute = url;
        if (url.startsWith('//')) {
          absolute = 'https:' + url;
        } else if (url.startsWith('/')) {
          absolute = TARGET_ORIGIN + url;
        } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
          try {
            absolute = new URL(url, CURRENT_PAGE).toString();
          } catch(e) {
            absolute = TARGET_ORIGIN + '/' + url;
          }
        }
        return PROXY_BASE + encodeURIComponent(absolute);
      }

      // 3. Intercept Click Navigation
      document.addEventListener('click', function(e) {
        let el = e.target;
        while (el && el.tagName !== 'A') {
          el = el.parentElement;
        }
        if (el && el.href) {
          const rawHref = el.getAttribute('href');
          if (rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:') && !isCaptcha(rawHref)) {
            e.preventDefault();
            window.location.href = proxyWrap(rawHref);
          }
        }
      }, true);

      // 4. Intercept Form Submissions
      document.addEventListener('submit', function(e) {
        if (e.target && e.target.action) {
          const action = e.target.getAttribute('action') || e.target.action;
          if (!isCaptcha(action)) {
            e.target.action = proxyWrap(action);
          }
        }
      }, true);

      // 5. Intercept Fetch & XHR
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        let u = (typeof input === 'string') ? input : (input instanceof Request ? input.url : '');
        if (u && !isCaptcha(u)) {
          if (typeof input === 'string') {
            input = proxyWrap(input);
          } else if (input instanceof Request) {
            input = new Request(proxyWrap(input.url), init);
          }
        }
        return origFetch.call(this, input, init);
      };

      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (url && !isCaptcha(url)) {
          url = proxyWrap(url);
        }
        return origOpen.call(this, method, url, ...args);
      };
    })();
  </script>
  `;

  // Floating Navigation Bar for Direct Full-Window Mode
  const floatingToolbar = `
  <div id="__proxy_floating_bar" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:rgba(15,23,42,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.15);padding:8px 14px;border-radius:9999px;box-shadow:0 10px 25px rgba(0,0,0,0.6);font-family:sans-serif;font-size:12px;color:#fff;">
    <button onclick="window.history.back()" style="background:#334155;color:#fff;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;font-weight:bold;">◀</button>
    <button onclick="window.history.forward()" style="background:#334155;color:#fff;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;font-weight:bold;">▶</button>
    <button onclick="window.location.reload()" style="background:#334155;color:#fff;border:none;padding:4px 8px;border-radius:6px;cursor:pointer;font-weight:bold;">↻</button>
    <a href="/" style="background:#e11d48;color:#fff;text-decoration:none;padding:4px 10px;border-radius:6px;font-weight:bold;">⚡ Exit</a>
  </div>
  `;

  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>${script}`);
  } else {
    html = script + html;
  }

  if (html.includes('</body>')) {
    html = html.replace('</body>', `${floatingToolbar}</body>`);
  } else {
    html = html + floatingToolbar;
  }

  return html;
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
    return res.status(400).json({ error: 'Missing target URL or session expired' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';

    const upstreamHeaders = {
      'User-Agent': req.headers['x-proxy-ua'] || 
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetObj.origin + '/'
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    if (req.headers.cookie) {
      upstreamHeaders['Cookie'] = req.headers.cookie;
    }

    const response = await fetch(targetObj.toString(), {
      method: req.method,
      headers: upstreamHeaders,
      redirect: 'follow'
    });

    const finalTargetUrl = response.url || targetObj.toString();
    const finalOrigin = new URL(finalTargetUrl).origin;
    const contentType = response.headers.get('content-type') || '';

    // Strip restrictive headers
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
      if (!blockedHeaders.includes(lower)) {
        if (lower === 'set-cookie') {
          const cleanedCookie = value
            .replace(/domain=[^;]+;?/gi, '')
            .replace(/samesite=[^;]+;?/gi, 'SameSite=Lax;')
            + '; Path=/';
          res.setHeader('Set-Cookie', cleanedCookie);
        } else {
          res.setHeader(key, value);
        }
      }
    });

    // Handle HTML
    if (contentType.includes('text/html')) {
      res.setHeader('Set-Cookie', `__proxy_target=${encodeURIComponent(finalOrigin)}; Path=/; SameSite=Lax`);

      let bodyText = await response.text();
      bodyText = rewriteHtml(bodyText, finalOrigin, proxyHost);
      bodyText = injectClientHooks(bodyText, finalTargetUrl, proxyHost);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(response.status).send(bodyText);
    } 
    // Handle CSS
    else if (contentType.includes('text/css')) {
      let cssText = await response.text();
      cssText = rewriteCss(cssText, finalOrigin, proxyHost);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.status(response.status).send(cssText);
    } 
    // Handle Images, Media, Streams
    else {
      res.status(response.status);
      if (response.body && typeof response.body.pipe === 'function') {
        return response.body.pipe(res);
      } else {
        const buffer = await response.arrayBuffer();
        return res.send(Buffer.from(buffer));
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'Proxy request error', details: err.message });
  }
};

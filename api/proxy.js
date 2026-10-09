// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel (iad1 - Virginia)
const fetch = globalThis.fetch || require('node-fetch');
const { URL } = require('url');

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

  // 3. Cookie-based target resolution (catches /css, /js, /search without query string)
  const cookies = parseCookies(req);
  if (cookies.__proxy_target) {
    try {
      const baseOrigin = cookies.__proxy_target;
      let pathPart = fullUrl;
      // Strip internal fallback_path query if added by vercel.json
      if (req.query && req.query.fallback_path) {
        pathPart = req.query.fallback_path;
        if (!pathPart.startsWith('/')) pathPart = '/' + pathPart;
      }
      return new URL(pathPart, baseOrigin).toString();
    } catch (e) {}
  }

  // 4. Fallback to Referer header if available
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
 * Rewrites HTML tags and attributes
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
          const abs = resolveToAbsolute(trimmed, targetOrigin);
          return `${proxyBase}${encodeURIComponent(abs)}`;
        }
        const urlPart = trimmed.substring(0, firstSpace);
        const descriptor = trimmed.substring(firstSpace);
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
      const abs = resolveToAbsolute(val, targetOrigin);
      return `url("${proxyBase}${encodeURIComponent(abs)}")`;
    }
  );
}

/**
 * Injects DOM property hooks and frame neutralizers
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

      // 1. Break frame busters
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
          if (rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:')) {
            e.preventDefault();
            window.location.href = proxyWrap(rawHref);
          }
        }
      }, true);

      // 4. Intercept Form Submissions
      document.addEventListener('submit', function(e) {
        if (e.target && e.target.action) {
          e.target.action = proxyWrap(e.target.getAttribute('action') || e.target.action);
        }
      }, true);

      // 5. Intercept Fetch & XHR
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string') {
          input = proxyWrap(input);
        } else if (input instanceof Request) {
          input = new Request(proxyWrap(input.url), init);
        }
        return origFetch.call(this, input, init);
      };

      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (url) url = proxyWrap(url);
        return origOpen.call(this, method, url, ...args);
      };
    })();
  </script>
  `;

  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${script}`);
  }
  return script + html;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('X-Vercel-Proxy-Region', 'iad1-virginia');

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

    // Upstream request headers
    const upstreamHeaders = {
      'User-Agent': req.headers['x-proxy-ua'] || 
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetObj.origin + '/'
    };

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    // Forward cookies if available
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

    // Strip problematic headers
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
      // Set the active session origin cookie so unrouted relative assets (/css, /img) know their target
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
    // Handle Images, Fonts, JS, and Media Streams
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

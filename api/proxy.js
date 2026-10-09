// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel (iad1 - Virginia)
const fetch = require('node-fetch');
const { URL } = require('url');

/**
 * Extracts the true target URL from any query parameter or fallback route
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

  if (req.query.url) {
    return req.query.url;
  }

  // 3. Fallback path handling when sub-assets hit the bare domain
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

/**
 * Resolves a relative URL against a base URL
 */
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
 * Deep rewrite of HTML attributes, inline styles, and srcset
 */
function rewriteHtml(html, targetOrigin, proxyHost) {
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  let out = html;

  // Rewrite standard DOM attributes (href, src, action, poster, data-src, etc.)
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
 * Rewrites CSS stylesheets (@import and url() references)
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
 * Injects client-side hooks, top-level window spoofing, and automatic link proxying
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

      // 1. Bypass Frame-Busters (Pornhub, XNXX, Cloudflare top-level window checks)
      try {
        Object.defineProperty(window, 'top', { get: function() { return window.self; } });
        Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
      } catch(e) {}

      // 2. Wrap arbitrary URLs to route through proxy
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

      // 5. Intercept Fetch
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string') {
          input = proxyWrap(input);
        } else if (input instanceof Request) {
          input = new Request(proxyWrap(input.url), init);
        }
        return origFetch.call(this, input, init);
      };

      // 6. Intercept XMLHttpRequest
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (url) url = proxyWrap(url);
        return origOpen.call(this, method, url, ...args);
      };

      // 7. Intercept setAttribute
      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, val) {
        const lower = name.toLowerCase();
        if (['src', 'href', 'action', 'data-src', 'data-video', 'poster'].includes(lower)) {
          val = proxyWrap(val);
        }
        return origSetAttr.call(this, name, val);
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
    return res.status(400).json({ error: 'Missing target URL' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';

    const headers = {
      'User-Agent': req.headers['x-proxy-ua'] || 
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetObj.origin,
      'Origin': targetObj.origin
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    const response = await fetch(targetObj.toString(), {
      method: req.method,
      headers: headers,
      redirect: 'follow'
    });

    const finalTargetUrl = response.url || targetObj.toString();
    const finalOrigin = new URL(finalTargetUrl).origin;
    const contentType = response.headers.get('content-type') || '';

    // Copy response headers EXCEPT length, encoding, and framing restrictions
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
          // Clean cookie domains to allow cookies to persist on proxy domain
          const cleanedCookie = value
            .replace(/domain=[^;]+;?/gi, '')
            .replace(/samesite=[^;]+;?/gi, 'SameSite=None;')
            + '; Secure; Path=/';
          res.setHeader('Set-Cookie', cleanedCookie);
        } else {
          res.setHeader(key, value);
        }
      }
    });

    // Handle HTML
    if (contentType.includes('text/html')) {
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
    // Handle Images, Video streams, and JS bundles
    else {
      res.status(response.status);
      return response.body.pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Proxy Fetch Failed', message: err.message });
  }
};

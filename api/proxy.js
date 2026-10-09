// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel
const fetch = require('node-fetch');
const { URL } = require('url');

/**
 * Extracts raw target URL from req.url to prevent query string truncation at '&'
 */
function getRawTargetUrl(req) {
  const fullUrl = req.url || '';
  const match = fullUrl.match(/[?&]url=([^&]+.*)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }
  return req.query.url || '';
}

/**
 * Resolves relative and absolute URLs against the current target origin
 */
function resolveUrl(relativeOrAbsolute, baseOrigin) {
  try {
    if (relativeOrAbsolute.startsWith('//')) {
      return 'https:' + relativeOrAbsolute;
    }
    return new URL(relativeOrAbsolute, baseOrigin).toString();
  } catch (e) {
    return relativeOrAbsolute;
  }
}

/**
 * Comprehensive client-side proxy engine injected into HTML responses.
 * Hooks fetch, XHR, DOM attributes, window.location, and cookie access.
 */
function injectProxyScript(html, finalTargetUrl, proxyHost) {
  const targetObj = new URL(finalTargetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  const script = `
  <script>
    (function() {
      const PROXY_BASE = "${proxyBase}";
      const TARGET_ORIGIN = "${targetObj.origin}";
      const CURRENT_TARGET = "${finalTargetUrl}";

      function wrapUrl(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
        if (url.startsWith(PROXY_BASE)) return url;
        
        let absUrl = url;
        if (url.startsWith('//')) {
          absUrl = 'https:' + url;
        } else if (url.startsWith('/')) {
          absUrl = TARGET_ORIGIN + url;
        } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
          try {
            absUrl = new URL(url, CURRENT_TARGET).toString();
          } catch(e) {
            absUrl = TARGET_ORIGIN + '/' + url;
          }
        }
        return PROXY_BASE + encodeURIComponent(absUrl);
      }

      // Hook Fetch
      const origFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string') {
          input = wrapUrl(input);
        } else if (input instanceof Request) {
          input = new Request(wrapUrl(input.url), init);
        }
        return origFetch.call(this, input, init);
      };

      // Hook XHR
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (url) {
          url = wrapUrl(url);
        }
        return origOpen.call(this, method, url, ...args);
      };

      // Hook Element.setAttribute
      const origSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(name, value) {
        const lower = name.toLowerCase();
        if (['src', 'href', 'action', 'data-src', 'data-video', 'poster'].includes(lower)) {
          value = wrapUrl(value);
        }
        return origSetAttribute.call(this, name, value);
      };

      // Hook window.open
      const origOpenWindow = window.open;
      window.open = function(url, ...args) {
        if (url) url = wrapUrl(url);
        return origOpenWindow.call(this, url, ...args);
      };

      // Hook beacon
      if (navigator.sendBeacon) {
        const origBeacon = navigator.sendBeacon;
        navigator.sendBeacon = function(url, data) {
          return origBeacon.call(this, wrapUrl(url), data);
        };
      }
    })();
  </script>
  `;

  // Inject <base> tag to auto-resolve unhandled relative resources
  const baseTag = `<base href="${proxyBase}${encodeURIComponent(finalTargetUrl)}">`;
  
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${baseTag}${script}`);
  }
  return baseTag + script + html;
}

/**
 * Rewrites HTML/CSS strings server-side
 */
function rewriteServerHtml(html, finalTargetUrl, proxyHost) {
  const targetObj = new URL(finalTargetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  let content = html;

  // Rewrite standard attributes
  content = content.replace(
    /(href|src|action|poster|data-src|data-video|data-href)=["']([^"']+)["']/gi,
    (match, attr, val) => {
      if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return match;
      const absUrl = resolveUrl(val, targetObj.origin);
      return `${attr}="${proxyBase}${encodeURIComponent(absUrl)}"`;
    }
  );

  // Rewrite srcset attributes
  content = content.replace(
    /srcset=["']([^"']+)["']/gi,
    (match, val) => {
      const parts = val.split(',').map(part => {
        const [u, d] = part.trim().split(/\s+/);
        if (!u) return part;
        const absUrl = resolveUrl(u, targetObj.origin);
        return `${proxyBase}${encodeURIComponent(absUrl)}${d ? ' ' + d : ''}`;
      });
      return `srcset="${parts.join(', ')}"`;
    }
  );

  // Rewrite CSS url() calls
  content = content.replace(
    /url\(['"]?([^'"]+)['"]?\)/gi,
    (match, val) => {
      if (val.startsWith('data:')) return match;
      const absUrl = resolveUrl(val, targetObj.origin);
      return `url("${proxyBase}${encodeURIComponent(absUrl)}")`;
    }
  );

  return content;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let rawTarget = getRawTargetUrl(req);
  if (!rawTarget) {
    return res.status(400).json({ error: 'Missing target URL parameter' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
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
    const contentType = response.headers.get('content-type') || '';

    // Pass safe headers back
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (![
        'content-security-policy',
        'x-frame-options',
        'strict-transport-security',
        'content-encoding',
        'cross-origin-resource-policy',
        'cross-origin-opener-policy',
        'transfer-encoding'
      ].includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });

    if (contentType.includes('text/html')) {
      let bodyText = await response.text();
      bodyText = rewriteServerHtml(bodyText, finalTargetUrl, proxyHost);
      bodyText = injectProxyScript(bodyText, finalTargetUrl, proxyHost);
      return res.status(response.status).send(bodyText);
    } 
    else if (contentType.includes('text/css')) {
      const bodyText = await response.text();
      const modifiedText = rewriteServerHtml(bodyText, finalTargetUrl, proxyHost);
      return res.status(response.status).send(modifiedText);
    } 
    else {
      res.status(response.status);
      return response.body.pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Proxy request execution failed', details: err.message });
  }
};

// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel (iad1 - Virginia)
const fetch = require('node-fetch');
const { URL } = require('url');

/**
 * Parses target URL supporting raw query strings and Base64 encoded URLs
 */
function extractTargetUrl(req) {
  const fullUrl = req.url || '';
  
  // Base64 URL support (?b64url=...)
  const b64Match = fullUrl.match(/[?&]b64url=([^&]+)/);
  if (b64Match && b64Match[1]) {
    try {
      return Buffer.from(decodeURIComponent(b64Match[1]), 'base64').toString('utf-8');
    } catch (e) {}
  }

  // Standard raw url parameter
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
 * Injects stealth browser overrides, fingerprint masking, and client-side proxy hooks
 */
function injectStealthEngine(html, finalTargetUrl, proxyHost) {
  const targetObj = new URL(finalTargetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  const stealthScript = `
  <script>
    (function() {
      const PROXY_BASE = "${proxyBase}";
      const TARGET_ORIGIN = "${targetObj.origin}";
      const CURRENT_TARGET = "${finalTargetUrl}";

      // Canvas / WebGL Fingerprint Noise Generator
      try {
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          const res = origGetImageData.call(this, x, y, w, h);
          for (let i = 0; i < res.data.length; i += 64) {
            res.data[i] = res.data[i] ^ 1;
          }
          return res;
        };
      } catch(e) {}

      // URL Wrapper Utility
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
        if (url) url = wrapUrl(url);
        return origOpen.call(this, method, url, ...args);
      };

      // Hook SetAttribute
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
    })();
  </script>
  `;

  const baseTag = `<base href="${proxyBase}${encodeURIComponent(finalTargetUrl)}">`;
  
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${baseTag}${stealthScript}`);
  }
  return baseTag + stealthScript + html;
}

function rewriteServerContent(html, finalTargetUrl, proxyHost) {
  const targetObj = new URL(finalTargetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  let content = html;

  content = content.replace(
    /(href|src|action|poster|data-src|data-video|data-href)=["']([^"']+)["']/gi,
    (match, attr, val) => {
      if (val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('#')) return match;
      const absUrl = resolveUrl(val, targetObj.origin);
      return `${attr}="${proxyBase}${encodeURIComponent(absUrl)}"`;
    }
  );

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
  res.setHeader('X-Vercel-Proxy-Region', 'iad1-virginia');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let rawTarget = extractTargetUrl(req);
  if (!rawTarget) {
    return res.status(400).json({ error: 'Missing target URL parameter' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';

    // User-Agent Spoofing via header or custom preset
    const userAgent = req.headers['x-proxy-ua'] || 
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36';

    const referer = req.headers['x-proxy-ref'] || targetObj.origin;

    const headers = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer,
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

    // Strip restrictive headers
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
      bodyText = rewriteServerContent(bodyText, finalTargetUrl, proxyHost);
      bodyText = injectStealthEngine(bodyText, finalTargetUrl, proxyHost);
      return res.status(response.status).send(bodyText);
    } 
    else if (contentType.includes('text/css')) {
      const bodyText = await response.text();
      const modifiedText = rewriteServerContent(bodyText, finalTargetUrl, proxyHost);
      return res.status(response.status).send(modifiedText);
    } 
    else {
      res.status(response.status);
      return response.body.pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Edge Proxy Execution Error', details: err.message });
  }
};

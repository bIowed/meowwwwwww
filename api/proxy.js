// language: JavaScript, file: api/proxy.js, runtime: Node.js (Vercel Serverless), target: Vercel
const fetch = require('node-fetch');
const { URL } = require('url');

/**
 * Injects a client-side interceptor script into HTML responses to automatically 
 * reroute client-side fetch, XHR, and dynamic media loading through the proxy.
 */
function injectClientInterceptor(html, targetUrl, proxyHost) {
  const targetObj = new URL(targetUrl);
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  const scriptTag = `
  <script>
    (function() {
      const PROXY_BASE = "${proxyBase}";
      const TARGET_ORIGIN = "${targetObj.origin}";

      // Intercept fetch API calls
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        let url = (typeof input === 'string') ? input : (input instanceof Request ? input.url : input);
        if (url && !url.startsWith(PROXY_BASE) && !url.startsWith('data:')) {
          if (url.startsWith('/')) {
            url = TARGET_ORIGIN + url;
          }
          input = PROXY_BASE + encodeURIComponent(url);
        }
        return originalFetch.call(this, input, init);
      };

      // Intercept XMLHttpRequest
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (url && !url.startsWith(PROXY_BASE) && !url.startsWith('data:')) {
          if (url.startsWith('/')) {
            url = TARGET_ORIGIN + url;
          }
          url = PROXY_BASE + encodeURIComponent(url);
        }
        return originalOpen.call(this, method, url, ...args);
      };
    })();
  </script>
  `;

  // Insert script right after <head> or at the top of the HTML
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${scriptTag}`);
  }
  return scriptTag + html;
}

/**
 * Rewrites static URLs in HTML/CSS
 */
function rewriteUrls(content, targetUrl, proxyHost) {
  const targetObj = new URL(targetUrl);
  const targetOrigin = targetObj.origin;
  const proxyBase = `https://${proxyHost}/api/proxy?url=`;

  let rewritten = content.replace(
    new RegExp(targetOrigin, 'g'),
    `${proxyBase}${encodeURIComponent(targetOrigin)}`
  );

  rewritten = rewritten.replace(
    /(href|src|action|data-src|data-video)=["'](\/(?!\/)[^"']*)["']/gi,
    (match, attr, path) => {
      const absoluteUrl = new URL(path, targetOrigin).toString();
      return `${attr}="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
    }
  );

  rewritten = rewritten.replace(
    /url\(['"]?(\/(?!\/)[^'"]+)['"]?\)/gi,
    (match, path) => {
      const absoluteUrl = new URL(path, targetOrigin).toString();
      return `url("${proxyBase}${encodeURIComponent(absoluteUrl)}")`;
    }
  );

  return rewritten;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let rawTarget = req.query.url;
  if (!rawTarget) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
    rawTarget = 'https://' + rawTarget;
  }

  try {
    const targetObj = new URL(rawTarget);
    const proxyHost = req.headers.host || 'localhost';

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetObj.origin
    };

    // Forward Range headers for video seeking and media streaming
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const response = await fetch(targetObj.toString(), {
      method: req.method,
      headers: headers,
      redirect: 'follow'
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Copy target headers to response
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!['content-security-policy', 'x-frame-options', 'strict-transport-security', 'content-encoding', 'transfer-encoding'].includes(lowerKey)) {
        res.setHeader(key, value);
      }
    });

    // Handle HTML content
    if (contentType.includes('text/html')) {
      let bodyText = await response.text();
      bodyText = rewriteUrls(bodyText, targetObj.toString(), proxyHost);
      bodyText = injectClientInterceptor(bodyText, targetObj.toString(), proxyHost);
      return res.status(response.status).send(bodyText);
    } 
    // Handle CSS content
    else if (contentType.includes('text/css')) {
      const bodyText = await response.text();
      const modifiedText = rewriteUrls(bodyText, targetObj.toString(), proxyHost);
      return res.status(response.status).send(modifiedText);
    } 
    // Handle Video / Audio / Binary media with streaming buffer
    else {
      res.status(response.status);
      response.body.pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Proxy streaming failed', message: err.message });
  }
};

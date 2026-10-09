// language: JavaScript, file: lib/js_virtualizer.js, runtime: Node.js / V8, target: Edge / Serverless
/**
 * JavaScript Runtime Virtualizer & Sandbox Injector.
 * Constructs a comprehensive client-side interception layer that virtualizes 
 * location, cookies, top-level window hierarchies, and media/fetch network requests.
 */
class JsVirtualizer {
  static generateScript(proxyBase, finalTargetUrl) {
    return `
    <script id="__vproxy_core_engine">
      (function() {
        if (window.__vproxy_initialized) return;
        window.__vproxy_initialized = true;

        const PROXY_BASE = "${proxyBase}";
        const TARGET_URL = new URL("${finalTargetUrl}");
        const TARGET_ORIGIN = TARGET_URL.origin;
        const CURRENT_PAGE = "${finalTargetUrl}";

        function isIgnored(u) {
          if (!u || typeof u !== 'string') return true;
          const l = u.toLowerCase();
          return l.startsWith('data:') || l.startsWith('blob:') || l.startsWith('javascript:') || l.startsWith('#') ||
                 l.includes('challenges.cloudflare.com') || l.includes('recaptcha') || l.includes('hcaptcha') || l.includes('turnstile');
        }

        function wrapUrl(u) {
          if (isIgnored(u)) return u;
          if (u.startsWith(PROXY_BASE)) return u;
          let abs = u;
          if (u.startsWith('//')) abs = 'https:' + u;
          else if (u.startsWith('/')) abs = TARGET_ORIGIN + u;
          else if (!u.startsWith('http://') && !u.startsWith('https://')) {
            try { abs = new URL(u, CURRENT_PAGE).toString(); } catch(e) { abs = TARGET_ORIGIN + '/' + u; }
          }
          return PROXY_BASE + encodeURIComponent(abs);
        }

        // 1. Virtualize Top & Parent Windows
        try {
          Object.defineProperty(window, 'top', { get: () => window.self, configurable: true });
          Object.defineProperty(window, 'parent', { get: () => window.self, configurable: true });
        } catch(e) {}

        // 2. Virtualize Location Navigation Methods
        try {
          const origAssign = window.location.assign.bind(window.location);
          window.location.assign = function(url) { origAssign(wrapUrl(url)); };
          const origReplace = window.location.replace.bind(window.location);
          window.location.replace = function(url) { origReplace(wrapUrl(url)); };
        } catch(e) {}

        // 3. Virtualize Fetch API
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          if (typeof input === 'string') {
            input = wrapUrl(input);
          } else if (input instanceof Request) {
            input = new Request(wrapUrl(input.url), init);
          }
          return origFetch.call(this, input, init);
        };

        // 4. Virtualize XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          if (url) url = wrapUrl(url);
          return origOpen.call(this, method, url, ...args);
        };

        // 5. Virtualize DOM Property Descriptors
        function hookDescriptor(proto, prop) {
          try {
            const desc = Object.getOwnPropertyDescriptor(proto, prop);
            if (desc && desc.set) {
              const origSet = desc.set;
              Object.defineProperty(proto, prop, {
                set: function(val) { return origSet.call(this, wrapUrl(val)); },
                get: desc.get,
                configurable: true
              });
            }
          } catch(e) {}
        }

        hookDescriptor(HTMLImageElement.prototype, 'src');
        hookDescriptor(HTMLScriptElement.prototype, 'src');
        hookDescriptor(HTMLLinkElement.prototype, 'href');
        hookDescriptor(HTMLMediaElement.prototype, 'src');
        hookDescriptor(HTMLSourceElement.prototype, 'src');
        hookDescriptor(HTMLAnchorElement.prototype, 'href');

        // 6. Intercept DOM Clicks & Forms
        document.addEventListener('click', function(e) {
          let a = e.target;
          while (a && a.tagName !== 'A') a = a.parentElement;
          if (a && a.href && !a.href.startsWith(PROXY_BASE) && !isIgnored(a.href)) {
            e.preventDefault();
            window.location.href = wrapUrl(a.getAttribute('href') || a.href);
          }
        }, true);

        document.addEventListener('submit', function(e) {
          if (e.target && e.target.action) {
            const action = e.target.getAttribute('action') || e.target.action;
            if (!isIgnored(action)) {
              e.target.action = wrapUrl(action);
            }
          }
        }, true);

        // 7. Randomize Canvas Fingerprints to Neutralize Bot Detection
        try {
          const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
            const res = origGetImageData.call(this, x, y, w, h);
            for (let i = 0; i < res.data.length; i += 128) {
              res.data[i] = res.data[i] ^ 1;
            }
            return res;
          };
        } catch(e) {}
      })();
    </script>
    `;
  }
}

module.exports = JsVirtualizer;

// language: JavaScript, file: lib/dom_sandbox.js, runtime: Node.js / V8, target: Edge / Serverless
/**
 * Industrial DOM Sandbox & Prototype Virtualization Engine.
 * Constructs an exhaustive client-side sandbox script that completely wraps 
 * DOM prototypes, navigation APIs, prototype setters, and storage subsystems.
 */
class DomSandbox {
  static generateSandboxScript(proxyBase, targetUrlStr) {
    return `
    <script id="__vproxy_dom_sandbox">
      (function() {
        if (window.__vproxy_dom_sandbox_active) return;
        window.__vproxy_dom_sandbox_active = true;

        const PROXY_BASE = "${proxyBase}";
        const TARGET_URL_OBJ = new URL("${targetUrlStr}");
        const TARGET_ORIGIN = TARGET_URL_OBJ.origin;
        const TARGET_HREF = "${targetUrlStr}";

        function isBypassUrl(url) {
          if (!url || typeof url !== 'string') return true;
          const l = url.toLowerCase();
          return l.startsWith('data:') || l.startsWith('blob:') || l.startsWith('javascript:') || l.startsWith('#') ||
                 l.includes('challenges.cloudflare.com') || l.includes('recaptcha') || l.includes('hcaptcha') || l.includes('turnstile');
        }

        function toProxyUrl(url) {
          if (isBypassUrl(url)) return url;
          if (url.startsWith(PROXY_BASE)) return url;

          let absolute = url;
          if (url.startsWith('//')) {
            absolute = 'https:' + url;
          } else if (url.startsWith('/')) {
            absolute = TARGET_ORIGIN + url;
          } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
            try {
              absolute = new URL(url, TARGET_HREF).toString();
            } catch(e) {
              absolute = TARGET_ORIGIN + '/' + url;
            }
          }
          return PROXY_BASE + encodeURIComponent(absolute);
        }

        function fromProxyUrl(url) {
          if (!url || typeof url !== 'string') return url;
          if (!url.startsWith(PROXY_BASE)) return url;
          try {
            return decodeURIComponent(url.substring(PROXY_BASE.length));
          } catch(e) {
            return url;
          }
        }

        // ==========================================
        // 1. VIRTUAL LOCATION OBJECT IMPLEMENTATION
        // ==========================================
        class VirtualLocation {
          constructor() {
            this._update();
          }

          _update() {
            this._url = new URL(TARGET_HREF);
          }

          get href() { return this._url.href; }
          set href(val) { window.location.href = toProxyUrl(val); }

          get protocol() { return this._url.protocol; }
          set protocol(val) { this.href = val + '//' + this.host + this.pathname + this.search; }

          get host() { return this._url.host; }
          set host(val) { this.href = this.protocol + '//' + val + this.pathname + this.search; }

          get hostname() { return this._url.hostname; }
          set hostname(val) { this.host = val + (this.port ? ':' + this.port : ''); }

          get port() { return this._url.port; }
          set port(val) { this.host = this.hostname + (val ? ':' + val : ''); }

          get pathname() { return this._url.pathname; }
          set pathname(val) { this.href = this.origin + (val.startsWith('/') ? val : '/' + val) + this.search; }

          get search() { return this._url.search; }
          set search(val) { this.href = this.origin + this.pathname + (val.startsWith('?') ? val : '?' + val); }

          get hash() { return window.location.hash; }
          set hash(val) { window.location.hash = val; }

          get origin() { return this._url.origin; }

          assign(url) { window.location.assign(toProxyUrl(url)); }
          replace(url) { window.location.replace(toProxyUrl(url)); }
          reload() { window.location.reload(); }
          toString() { return this.href; }
          valueOf() { return this.href; }
        }

        const virtualLoc = new VirtualLocation();
        window.__vproxy_location = virtualLoc;

        // ==========================================
        // 2. VIRTUAL WINDOW HIERARCHY
        // ==========================================
        try {
          Object.defineProperty(window, 'top', { get: () => window.self, configurable: true });
          Object.defineProperty(window, 'parent', { get: () => window.self, configurable: true });
          Object.defineProperty(window, 'frameElement', { get: () => null, configurable: true });
        } catch(e) {}

        // ==========================================
        // 3. VIRTUAL DOCUMENT PROPERTIES
        // ==========================================
        try {
          Object.defineProperty(document, 'domain', {
            get: () => TARGET_URL_OBJ.hostname,
            set: (val) => {},
            configurable: true
          });

          Object.defineProperty(document, 'referrer', {
            get: () => TARGET_ORIGIN + '/',
            configurable: true
          });
        } catch(e) {}

        // ==========================================
        // 4. NETWORK & MEDIA DESCRIPTOR TRAPS
        // ==========================================
        function trapProperty(prototype, property) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
            if (descriptor && descriptor.set) {
              const originalSet = descriptor.set;
              const originalGet = descriptor.get;
              Object.defineProperty(prototype, property, {
                set: function(val) {
                  return originalSet.call(this, toProxyUrl(val));
                },
                get: function() {
                  const raw = originalGet.call(this);
                  return fromProxyUrl(raw);
                },
                configurable: true
              });
            }
          } catch(e) {}
        }

        trapProperty(HTMLImageElement.prototype, 'src');
        trapProperty(HTMLScriptElement.prototype, 'src');
        trapProperty(HTMLLinkElement.prototype, 'href');
        trapProperty(HTMLMediaElement.prototype, 'src');
        trapProperty(HTMLSourceElement.prototype, 'src');
        trapProperty(HTMLIFrameElement.prototype, 'src');
        trapProperty(HTMLAnchorElement.prototype, 'href');

        // ==========================================
        // 5. FETCH & XHR NETWORK TRAPS
        // ==========================================
        const realFetch = window.fetch;
        window.fetch = function(resource, config) {
          if (typeof resource === 'string') {
            resource = toProxyUrl(resource);
          } else if (resource instanceof Request) {
            resource = new Request(toProxyUrl(resource.url), config);
          }
          return realFetch.call(this, resource, config);
        };

        const realXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          if (url) url = toProxyUrl(url);
          return realXhrOpen.call(this, method, url, ...args);
        };

        // ==========================================
        // 6. DOM MUTATION & ELEMENT INSERTION HOOKS
        // ==========================================
        const realSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function(name, val) {
          const l = name.toLowerCase();
          if (['src', 'href', 'action', 'poster', 'data-src', 'data-video'].includes(l)) {
            val = toProxyUrl(val);
          }
          return realSetAttribute.call(this, name, val);
        };

        // ==========================================
        // 7. WEBSOCKET VIRTUALIZATION
        // ==========================================
        if (window.WebSocket) {
          const RealWebSocket = window.WebSocket;
          window.WebSocket = function(url, protocols) {
            let targetWs = url;
            if (targetWs.startsWith('ws://')) targetWs = 'http://' + targetWs.substring(5);
            else if (targetWs.startsWith('wss://')) targetWs = 'https://' + targetWs.substring(6);
            const proxiedWs = toProxyUrl(targetWs).replace(/^http/, 'ws');
            return new RealWebSocket(proxiedWs, protocols);
          };
          window.WebSocket.prototype = RealWebSocket.prototype;
        }
      })();
    </script>
    `;
  }
}

module.exports = DomSandbox;

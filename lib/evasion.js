// language: JavaScript, file: lib/evasion.js, runtime: Node.js / V8, target: Edge / Serverless
/**
 * Anti-Bot Fingerprint Scrambler & Browser Evasion Engine.
 * Neutralizes automated browser detection markers (navigator.webdriver, CDC properties),
 * introduces sub-pixel noise into Canvas/WebGL render pipelines, and normalizes
 * Client Hints headers to mirror authentic Chrome residential browsing sessions.
 */
class EvasionEngine {
  static getEvasionHeaders(targetOrigin) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': targetOrigin + '/'
    };
  }

  static generateEvasionScript() {
    return `
    <script id="__vproxy_evasion_shield">
      (function() {
        if (window.__vproxy_evasion_active) return;
        window.__vproxy_evasion_active = true;

        // 1. Hide automation signals
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
          delete navigator.__proto__.webdriver;
        } catch(e) {}

        // 2. Normalize navigator hardware signatures
        try {
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
          Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
          Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
        } catch(e) {}

        // 3. Canvas 2D Sub-pixel Noise
        try {
          const realGetImageData = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
            const data = realGetImageData.call(this, x, y, w, h);
            // Introduce deterministic, imperceptible pixel parity shift
            for (let i = 0; i < data.data.length; i += 64) {
              data.data[i] = data.data[i] ^ 1;
            }
            return data;
          };
        } catch(e) {}

        // 4. WebGL Vendor & Renderer Masking
        try {
          const realGetParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(param) {
            // UNMASKED_VENDOR_WEBGL
            if (param === 37445) return 'Google Inc. (NVIDIA)';
            // UNMASKED_RENDERER_WEBGL
            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return realGetParameter.call(this, param);
          };
        } catch(e) {}

        // 5. AudioContext Fingerprint Scrambling
        try {
          const realGetChannelData = AudioBuffer.prototype.getChannelData;
          AudioBuffer.prototype.getChannelData = function(channel) {
            const array = realGetChannelData.call(this, channel);
            for (let i = 0; i < array.length; i += 100) {
              array[i] = array[i] + 0.0000001;
            }
            return array;
          };
        } catch(e) {}

        // 6. Permissions Query Virtualization
        if (navigator.permissions && navigator.permissions.query) {
          const realQuery = navigator.permissions.query;
          navigator.permissions.query = function(param) {
            if (param && param.name === 'notifications') {
              return Promise.resolve({ state: Notification.permission });
            }
            return realQuery.call(this, param);
          };
        }
      })();
    </script>
    `;
  }
}

module.exports = EvasionEngine;

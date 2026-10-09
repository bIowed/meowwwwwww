// language: JavaScript, file: lib/cookie_jar.js, runtime: Node.js / V8, target: Edge / Serverless
/**
 * Virtual Cookie Jar Engine.
 * Normalizes, scopes, and serializes cross-domain HTTP cookies so sessions, 
 * age verification flags, and video CDN tokens persist across proxy hops.
 */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  static parse(headerStr) {
    const jar = new CookieJar();
    if (!headerStr) return jar;

    const pairs = headerStr.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx !== -1) {
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        jar.set(key, val);
      }
    }
    return jar;
  }

  set(name, value, domain = '', path = '/') {
    this.cookies.set(name, {
      value,
      domain: domain.replace(/^\./, '').toLowerCase(),
      path: path || '/',
      timestamp: Date.now()
    });
  }

  get(name) {
    const item = this.cookies.get(name);
    return item ? item.value : null;
  }

  addSetCookieHeaders(setCookieHeaders, targetOrigin) {
    if (!setCookieHeaders) return;
    const headersList = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

    for (const raw of headersList) {
      const parts = raw.split(';').map(p => p.trim());
      if (parts.length === 0) continue;

      const firstPart = parts[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx === -1) continue;

      const name = firstPart.substring(0, eqIdx);
      const val = firstPart.substring(eqIdx + 1);

      let domain = '';
      let path = '/';

      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].toLowerCase();
        if (p.startsWith('domain=')) {
          domain = parts[i].substring(7);
        } else if (p.startsWith('path=')) {
          path = parts[i].substring(5);
        }
      }

      this.set(name, val, domain || targetOrigin, path);
    }
  }

  toHeaderString() {
    const list = [];
    for (const [name, data] of this.cookies.entries()) {
      list.push(`${name}=${data.value}`);
    }
    return list.join('; ');
  }

  serializeToClientCookie(cookieName = '__vproxy_session') {
    const obj = {};
    for (const [k, v] of this.cookies.entries()) {
      obj[k] = v.value;
    }
    const jsonStr = JSON.stringify(obj);
    return `${cookieName}=${Buffer.from(jsonStr).toString('base64')}; Path=/; SameSite=Lax; HttpOnly=false`;
  }

  static deserializeFromClientCookie(req, cookieName = '__vproxy_session') {
    const jar = new CookieJar();
    const rawCookies = req.headers && req.headers.cookie;
    if (!rawCookies) return jar;

    const match = rawCookies.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
    if (match && match[1]) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
        const obj = JSON.parse(decoded);
        for (const k of Object.keys(obj)) {
          jar.set(k, obj[k]);
        }
      } catch (e) {}
    }
    return jar;
  }
}

module.exports = CookieJar;

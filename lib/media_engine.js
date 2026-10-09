// language: JavaScript, file: lib/media_engine.js, runtime: Node.js / V8, target: Edge / Serverless
const { URL } = require('url');

/**
 * Industrial Media Engine & HTTP Live Streaming (HLS/DASH) Protocol Multiplexer.
 * Parses multimedia container manifests, extracts bitrates, codecs, audio channels,
 * and normalizes streaming chunk delivery across edge proxy nodes.
 */
class MediaEngine {
  constructor(proxyBase, sourceUrl) {
    this.proxyBase = proxyBase;
    this.sourceUrl = new URL(sourceUrl);
    this.baseDirectory = this.calculateBaseDir();
  }

  calculateBaseDir() {
    const p = this.sourceUrl.pathname;
    const lastSlash = p.lastIndexOf('/');
    return lastSlash !== -1 ? this.sourceUrl.origin + p.substring(0, lastSlash + 1) : this.sourceUrl.origin + '/';
  }

  resolveUrl(targetPath) {
    try {
      if (!targetPath) return '';
      if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) return targetPath;
      if (targetPath.startsWith('//')) return 'https:' + targetPath;
      if (targetPath.startsWith('/')) return this.sourceUrl.origin + targetPath;
      return new URL(targetPath, this.baseDirectory).toString();
    } catch (e) {
      return targetPath;
    }
  }

  wrapProxy(url) {
    return `${this.proxyBase}${encodeURIComponent(url)}`;
  }

  /**
   * Parses and rewrites HLS .m3u8 manifest files
   */
  processHlsManifest(manifestContent) {
    const lines = manifestContent.split(/\r?\n/);
    const rewritten = [];
    let isMaster = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      if (!line) {
        rewritten.push('');
        continue;
      }

      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        rewritten.push(line);
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          i++;
          const variantUrl = this.resolveUrl(lines[i].trim());
          rewritten.push(this.wrapProxy(variantUrl));
        }
        continue;
      }

      if (line.startsWith('#EXT-X-KEY:')) {
        line = line.replace(/URI=["']([^"']+)["']/i, (match, keyUri) => {
          const absKey = this.resolveUrl(keyUri);
          return `URI="${this.wrapProxy(absKey)}"`;
        });
        rewritten.push(line);
        continue;
      }

      if (line.startsWith('#EXT-X-MEDIA:')) {
        line = line.replace(/URI=["']([^"']+)["']/i, (match, mediaUri) => {
          const absMedia = this.resolveUrl(mediaUri);
          return `URI="${this.wrapProxy(absMedia)}"`;
        });
        rewritten.push(line);
        continue;
      }

      if (line.startsWith('#EXT-X-MAP:')) {
        line = line.replace(/URI=["']([^"']+)["']/i, (match, mapUri) => {
          const absMap = this.resolveUrl(mapUri);
          return `URI="${this.wrapProxy(absMap)}"`;
        });
        rewritten.push(line);
        continue;
      }

      if (line.startsWith('#')) {
        rewritten.push(line);
      } else {
        const absSegment = this.resolveUrl(line);
        rewritten.push(this.wrapProxy(absSegment));
      }
    }

    return {
      isMaster,
      content: rewritten.join('\n')
    };
  }

  /**
   * Processes MPEG-DASH .mpd manifest XML structures
   */
  processDashManifest(mpdXml) {
    let out = mpdXml;
    out = out.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (match, url) => {
      const abs = this.resolveUrl(url.trim());
      return `<BaseURL>${this.wrapProxy(abs)}</BaseURL>`;
    });

    out = out.replace(/(media|initialization)=["']([^"']+)["']/gi, (match, attr, path) => {
      if (path.includes('$Number$') || path.includes('$Time$') || path.includes('$Bandwidth$')) {
        return match;
      }
      const abs = this.resolveUrl(path);
      return `${attr}="${this.wrapProxy(abs)}"`;
    });

    return out;
  }

  /**
   * Parses HTTP Range request header into numeric offsets
   */
  static parseRangeHeader(rangeHeader, totalLength) {
    if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;

    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

    if (isNaN(start)) {
      const suffixLength = parseInt(parts[1], 10);
      return {
        start: totalLength - suffixLength,
        end: totalLength - 1,
        length: suffixLength
      };
    }

    return {
      start,
      end: Math.min(end, totalLength - 1),
      length: (Math.min(end, totalLength - 1) - start) + 1
    };
  }
}

module.exports = MediaEngine;

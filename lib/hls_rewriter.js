// language: JavaScript, file: lib/hls_rewriter.js, runtime: Node.js / V8, target: Edge / Serverless
const { URL } = require('url');

/**
 * Industrial HLS (HTTP Live Streaming) .m3u8 playlist rewriter.
 * Parses master playlists and media segment playlists, rewriting all variant 
 * stream URIs, audio renditions, encryption keys, and .ts/.m4s fragments 
 * to continuously route through the proxy.
 */
class HlsRewriter {
  constructor(proxyBase, originalUrl) {
    this.proxyBase = proxyBase;
    this.originalUrl = new URL(originalUrl);
    this.baseUrl = this.originalUrl.origin + this.originalUrl.pathname.substring(0, this.originalUrl.pathname.lastIndexOf('/') + 1);
  }

  resolveUrl(relativeOrAbsolute) {
    try {
      if (relativeOrAbsolute.startsWith('http://') || relativeOrAbsolute.startsWith('https://')) {
        return relativeOrAbsolute;
      }
      if (relativeOrAbsolute.startsWith('//')) {
        return 'https:' + relativeOrAbsolute;
      }
      if (relativeOrAbsolute.startsWith('/')) {
        return this.originalUrl.origin + relativeOrAbsolute;
      }
      return new URL(relativeOrAbsolute, this.baseUrl).toString();
    } catch (e) {
      return relativeOrAbsolute;
    }
  }

  wrapProxy(targetUrl) {
    return `${this.proxyBase}${encodeURIComponent(targetUrl)}`;
  }

  rewrite(manifestText) {
    const lines = manifestText.split(/\r?\n/);
    const rewrittenLines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();

      if (!line) {
        rewrittenLines.push('');
        continue;
      }

      // Handle HLS tag lines
      if (line.startsWith('#')) {
        // Rewrite Encryption Keys (#EXT-X-KEY:METHOD=...,URI="...")
        if (line.startsWith('#EXT-X-KEY:')) {
          line = line.replace(/URI=["']([^"']+)["']/i, (match, keyUri) => {
            const absKey = this.resolveUrl(keyUri);
            return `URI="${this.wrapProxy(absKey)}"`;
          });
        }
        // Rewrite Subtitles / Audio Renditions (#EXT-X-MEDIA:TYPE=AUDIO,...,URI="...")
        else if (line.startsWith('#EXT-X-MEDIA:')) {
          line = line.replace(/URI=["']([^"']+)["']/i, (match, mediaUri) => {
            const absMedia = this.resolveUrl(mediaUri);
            return `URI="${this.wrapProxy(absMedia)}"`;
          });
        }
        // Rewrite Initialization Segments (#EXT-X-MAP:URI="...")
        else if (line.startsWith('#EXT-X-MAP:')) {
          line = line.replace(/URI=["']([^"']+)["']/i, (match, mapUri) => {
            const absMap = this.resolveUrl(mapUri);
            return `URI="${this.wrapProxy(absMap)}"`;
          });
        }

        rewrittenLines.push(line);
      } 
      // Handle Media Segment URIs or Variant Playlist URIs (non-# lines)
      else {
        const absSegment = this.resolveUrl(line);
        rewrittenLines.push(this.wrapProxy(absSegment));
      }
    }

    return rewrittenLines.join('\n');
  }
}

module.exports = HlsRewriter;

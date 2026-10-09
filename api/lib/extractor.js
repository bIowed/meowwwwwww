// language: JavaScript, file: lib/extractor.js, runtime: Node.js / V8, target: Edge / Serverless
const { URL } = require('url');

/**
 * Industrial Video Stream Extractor Engine.
 * Parses raw HTML, inline player configurations, FlashVars, and JSON payloads
 * to extract direct HLS (.m3u8) master manifests and MP4 video streams.
 */
class VideoExtractor {
  static resolve(url, base) {
    try {
      if (!url) return null;
      if (url.startsWith('//')) return 'https:' + url;
      if (url.startsWith('http://') || url.startsWith('https://')) return url;
      return new URL(url, base).toString();
    } catch (e) {
      return null;
    }
  }

  static extract(html, pageUrl) {
    const origin = new URL(pageUrl).origin;
    const streams = [];

    // 1. XVideos & XNXX Player Definitions
    const xnxxHls = html.match(/html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/i);
    if (xnxxHls && xnxxHls[1]) {
      streams.push({ quality: 'HLS Master', type: 'application/x-mpegURL', url: this.resolve(xnxxHls[1], origin) });
    }
    const xnxxHigh = html.match(/html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/i);
    if (xnxxHigh && xnxxHigh[1]) {
      streams.push({ quality: 'High (720p/1080p)', type: 'video/mp4', url: this.resolve(xnxxHigh[1], origin) });
    }
    const xnxxLow = html.match(/html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/i);
    if (xnxxLow && xnxxLow[1]) {
      streams.push({ quality: 'Standard (360p/480p)', type: 'video/mp4', url: this.resolve(xnxxLow[1], origin) });
    }

    // 2. Pornhub Media Definitions
    const phJsonMatch = html.match(/var\s+flashvars_\d+\s*=\s*(\{.+?\});/);
    if (phJsonMatch && phJsonMatch[1]) {
      try {
        const phData = JSON.parse(phJsonMatch[1]);
        if (phData.mediaDefinitions && Array.isArray(phData.mediaDefinitions)) {
          for (const item of phData.mediaDefinitions) {
            if (item.videoUrl && typeof item.videoUrl === 'string') {
              streams.push({
                quality: item.quality ? `${item.quality}p` : 'MP4',
                type: item.format === 'hls' ? 'application/x-mpegURL' : 'video/mp4',
                url: this.resolve(item.videoUrl.replace(/\\\//g, '/'), origin)
              });
            }
          }
        }
      } catch (e) {}
    }

    // Direct JSON videoUrl regex fallback
    const rawVideoUrls = [...html.matchAll(/"videoUrl"\s*:\s*"([^"]+)"/g)];
    for (const m of rawVideoUrls) {
      if (m[1]) {
        const clean = m[1].replace(/\\\//g, '/');
        if (!streams.some(s => s.url === clean)) {
          streams.push({ quality: 'Direct Stream', type: clean.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4', url: this.resolve(clean, origin) });
        }
      }
    }

    // 3. OpenGraph / Twitter Card Video Tags
    const ogVideo = html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/i);
    if (ogVideo && ogVideo[1]) {
      streams.push({ quality: 'HD Stream', type: 'video/mp4', url: this.resolve(ogVideo[1], origin) });
    }

    // 4. Native HTML5 Video & Source tags
    const videoTag = html.match(/<video[^>]+src=["']([^"']+)["']/i);
    if (videoTag && videoTag[1]) {
      streams.push({ quality: 'Native HTML5', type: 'video/mp4', url: this.resolve(videoTag[1], origin) });
    }

    const sourceTags = [...html.matchAll(/<source[^>]+src=["']([^"']+)["'][^>]*>/gi)];
    for (const st of sourceTags) {
      if (st[1]) {
        const typeMatch = st[0].match(/type=["']([^"']+)["']/i);
        streams.push({
          quality: 'Video Source',
          type: typeMatch ? typeMatch[1] : 'video/mp4',
          url: this.resolve(st[1], origin)
        });
      }
    }

    // Filter valid URLs
    return streams.filter(s => s.url && s.url.startsWith('http'));
  }
}

module.exports = VideoExtractor;

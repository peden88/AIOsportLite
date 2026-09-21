const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class StreamFreeProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamFree';
    this.apiUrl = 'https://streamfree.top/streams';
    // Wrap the fetch with our circuit breaker
    this.fetchData = this.circuitBreaker.wrap(
      this.name + '_fetchMain',
      async () => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        // proxyFetch: undici done right (statusCode) + Impit fallback + redirect following
        const res = await this.proxyFetch(this.apiUrl, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
    this.embedFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchEmbed',
      async (url) => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        // NOTE: deliberately no Referer - StreamFree blocks embed requests that carry one
        const res = await this.proxyFetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.text();
      }
    );
    this.streamKeyFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchStreamKey',
      async (url) => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        const res = await this.proxyFetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !data.streams) return [];

      Object.entries(data.streams).forEach(([category, streams]) => {
        const normalizedCategory = this.normalizeCategory(category);
        if (!this.isRetainedEventCategory(normalizedCategory)) return;
        if (Array.isArray(streams)) {
          streams.forEach(s => {
            const id = s.stream_key || s.id;
            if (!id) return;
            matches.push(new MatchEntity({
              id: 'sf_' + id,
              title: s.name,
              category: normalizedCategory,
              date: s.match_timestamp ? (s.match_timestamp * 1000).toString() : null,
              popular: (s.viewers || 0) > 100 ? '1' : '0',
              league: s.league,
              team1: s.team1,
              team2: s.team2,
              thumbnail_url: s.thumbnail_url,
              sources: [{ source: 'streamfree', id: id, original_category: category }]
            }));
          });
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    try {
      const embedUrl = `https://streamfree.top/embed/${matchCategory}/${sourceId}`;
      
      // Scrape internally
      const html = await this.embedFetcher.fire(embedUrl);
      if (!html) return [];

      const match = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
      if (!match) throw new Error("Could not find _0x tokens in StreamFree HTML");

      const tokens = JSON.parse(match[1]);

      // Fetch the stream status to find available qualities.
      // Current API shape: { sources: { "1": { qualities: {...}, available }, ... } }
      const statusUrl = `https://streamfree.top/api/stream-status/${sourceId}`;
      const availableQualities = {};
      try {
        const { safeFetch } = require('../impitClient');
        const statusRes = await safeFetch(statusUrl, {
           headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' }
        });
        if (statusRes.status === 200) {
           const statusData = await statusRes.json();
           for (const s of Object.values(statusData.sources || {})) {
             if (s && s.available && s.qualities) {
               for (const [q, ok] of Object.entries(s.qualities)) {
                 if (ok) availableQualities[q] = true;
               }
             }
           }
         }
      } catch (e) {
        console.warn(`[StreamFree] Failed to fetch stream status for ${sourceId}`);
      }

      // Quality selection driven by the token keys actually present (the API
      // has drifted: 2160p exists now), preferring higher resolution and
      // intersecting with stream-status availability when known.
      const resScore = (q) => { const m = String(q).match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };
      const tokenKeys = Object.keys(tokens).filter(k => tokens[k] && tokens[k]._t);
      const bestQuality =
        tokenKeys.filter(q => availableQualities[q]).sort((a, b) => resScore(b) - resScore(a))[0] ||
        tokenKeys.sort((a, b) => resScore(b) - resScore(a))[0] ||
        null;
      const t = bestQuality ? tokens[bestQuality] : null;

      if (!bestQuality || !t) throw new Error("No suitable stream qualities found");

      // Fetch the stream key to determine if it's on a CDN or origin
      const streamKeyUrl = `https://streamfree.top/get-stream-key/${sourceId}`;
      const streamKeyData = await this.streamKeyFetcher.fire(streamKeyUrl);
      
      let baseUrl = '';
      if (streamKeyData && streamKeyData.is_external && streamKeyData.external_url) {
         baseUrl = streamKeyData.external_url;
      } else {
         const serverName = (streamKeyData && streamKeyData.server_name) ? streamKeyData.server_name : 'origin';
         if (serverName !== 'origin') {
            baseUrl = `https://streamfree.top/live-cdn/${sourceId}${bestQuality}/index.m3u8`;
         } else {
            baseUrl = `https://streamfree.top/live-origin/${sourceId}${bestQuality}/index.m3u8`;
         }
      }
      
      const targetUrl = `${baseUrl}?_t=${t._t}&_e=${t._e}&_n=${t._n}`;

      const referer = embedUrl;
      const { BASE_URL } = require('../config');
      const proxyUrl = `${BASE_URL}${require('../manifestLink').manifestPath(targetUrl, referer, 'https://streamfree.top')}`;

      return [new StreamEntity({
        name: 'StreamFree',
        title: `StreamFree (${bestQuality})`,
        url: proxyUrl,
        behaviorHints: {
          notWebReady: true
        },
        resolution: bestQuality
      })];
    } catch (error) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, error.message);
      return [];
    }
  }
}

module.exports = StreamFreeProvider;

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

const { redactUrl } = require('../redact');
class WatchFootyProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'WatchFooty';
    this.embedIndiaProvider = opts.embedIndiaProvider;
    // Hitting the /all endpoint to fetch 13+ sports instead of just football
    this.apiUrl = 'https://api.watchfooty.st/api/v1/matches/all';
    
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchMatchDetails = this.circuitBreaker.wrap(`${this.name}_fetchMatch`, async (matchId) => {
      const url = `https://api.watchfooty.st/api/v1/match/${matchId}`;
      const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      const res = await this.proxyFetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      
      if (Array.isArray(data)) {
        for (const item of data) {
          const matchId = item.matchId;
          const title = item.title || `${item.teams?.home?.name || 'Home'} vs ${item.teams?.away?.name || 'Away'}`;
          
          // CRITICAL: Only include matches that actually have streams available!
          // WatchFooty returns thousands of livescore-only fixtures with streams: []
          if (!Array.isArray(item.streams) || item.streams.length === 0) {
            continue;
          }

          let status = 'upcoming';
          
          if (item.status === 'in' || item.status === 'live') {
            status = 'live';
          } else if (item.status === 'post' || item.status === 'post-final' || item.status === 'postponed' || item.status === 'cancelled') {
            continue; // Skip ended matches
          }

          const matchTime = item.timestamp ? parseTimezone(item.timestamp, 'UTC') : Date.now();
          
          // Map dynamic sports directly from the API, then discard categories
          // the Lite build does not expose before allocating artwork/entities.
          const category = this.normalizeCategory(item.sport);
          if (!this.isRetainedEventCategory(category)) continue;

          const posterUrl = item.poster ? (
            item.poster.startsWith('//') ? `https:${item.poster}` :
            item.poster.startsWith('http') ? item.poster :
            item.poster.startsWith('/') ? `https://api.watchfooty.st${item.poster}` :
            `https://api.watchfooty.st/${item.poster}`
          ) : null;

          matches.push(new MatchEntity({
            id: `wf_${matchId}`,
            title: title,
            category: category,
            status: status,
            timestamp: matchTime,
            poster: posterUrl,
            background: posterUrl,
            sources: [{ source: 'watchfooty', id: matchId }]
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const data = await this.fetchMatchDetails.fire(sourceId);
      const match = Array.isArray(data) ? data[0] : data;
      
      if (match && match.streams && Array.isArray(match.streams)) {
        let idx = 0;
        for (const s of match.streams) {
          if (s.url) {
            const isDirect = s.url.includes('.m3u8') || s.url.includes('.mp4');
            const entityParams = {
              name: `WatchFooty`,
              title: `WatchFooty Stream ${idx + 1}`,
              resolution: s.quality ? String(s.quality).toUpperCase() : 'SD'
            };
            
            if (isDirect) {
              entityParams.url = s.url;
              entityParams.behaviorHints = {
                notWebReady: true,
                proxyHeaders: {
                  request: {
                    "Origin": "https://watchfooty.st",
                    "Referer": "https://watchfooty.st/",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
                  }
                }
              };
              streams.push(new StreamEntity(entityParams));
            } else if (s.url.includes('sportsembed.su') || s.url.includes('watchfooty.st/embed')) {
              let resolvedViaIframe = false;
              try {
                const { safeFetch } = require('../impitClient');
                const htmlRes = await safeFetch(s.url, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://watchfooty.st/',
                    'Accept': 'text/html'
                  },
                  timeoutMs: 6000
                });
                const html = await htmlRes.text();
                const iframeMatch = html.match(/src="(https?:\/\/[^"]+)"/g);
                if (iframeMatch) {
                  for (const attr of iframeMatch) {
                    const srcMatch = attr.match(/src="(https?:\/\/[^"]+)"/);
                    if (!srcMatch) continue;
                    const iframeSrc = srcMatch[1];
                    try {
                      const iframeHost = new URL(iframeSrc).hostname;
                      if (['embedindia.st', 'embedindia.com', 'embedsport.xyz'].includes(iframeHost)) {
                        console.log(`[WatchFootyProvider] Detected iframe redirect -> ${iframeSrc} for ${matchTitle}. Resolving via iframe provider.`);
                        const iframeReferer = new URL(iframeSrc).origin + '/';
                        
                        if (iframeSrc.includes('embedindia') && this.embedIndiaProvider) {
                            const indiaStreams = await this.embedIndiaProvider.resolveStream(iframeSrc, matchCategory, matchTitle, { referer: iframeReferer });
                            if (indiaStreams.length > 0) {
                                indiaStreams.forEach(s => {
                                    s.name = 'WatchFooty';
                                    s.title = s.title.replace('EmbedIndia', 'WatchFooty');
                                });
                                streams.push(...indiaStreams);
                                resolvedViaIframe = true;
                                break;
                            }
                        }
                      }
                    } catch (_) {}
                  }
                }
              } catch (e) {
                console.warn(`[WatchFootyProvider] Iframe detection failed for ${s.url}: ${e.message}`);
              }

              if (!resolvedViaIframe) {
                try {
                    console.log(`[WatchFootyProvider] Triggering native extraction for: ${s.url}`);
                    const { extractSportsEmbed } = require('./SportsEmbedExtractor');
                    const { BASE_URL } = require('../config');
                    const m3u8Url = await extractSportsEmbed(s.url);
                    if (m3u8Url) {
                        console.log(`[WatchFootyProvider] Successfully extracted M3U8: ${redactUrl(m3u8Url)}`);
                        const proxyUrl = `${BASE_URL}${require('../manifestLink').manifestPath(m3u8Url, 'https://sportsembed.su/', 'https://sportsembed.su')}`;
                        entityParams.url = proxyUrl;
                        entityParams.behaviorHints = { notWebReady: true };
                        streams.push(new StreamEntity(entityParams));
                    }
                } catch (e) {
                    console.error(`[WatchFootyProvider] Native extract failed for ${s.url}`, e.message);
                    entityParams.externalUrl = `/watch?url=${encodeURIComponent(s.url)}&title=${encodeURIComponent(matchTitle || 'WatchFooty')}`;
                    streams.push(new StreamEntity(entityParams));
                }
              }
            } else {
              entityParams.externalUrl = `/watch?url=${encodeURIComponent(s.url)}&title=${encodeURIComponent(matchTitle || 'WatchFooty')}`;
              streams.push(new StreamEntity(entityParams));
            }
          }
          idx++;
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = WatchFootyProvider;

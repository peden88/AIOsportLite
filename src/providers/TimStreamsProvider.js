const BaseProvider = require('./BaseProvider');
const { normalizeGenre } = require('../channelGenres');
const { regionFromCode, splitRegion } = require('../channelRegions');
const MatchEntity = require('../domain/MatchEntity');
const { parseTimezone } = require('../timezone');
const { BASE_URL } = require('../config');

const { redactUrl } = require('../redact');
class TimStreamsProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'TimStreams';

    // Every host this site is known to answer on, newest first. It has moved
    // before -- timstreams.st is dead and timst.cfd is where it lives now -- so
    // the working one is chosen at runtime instead of being pinned here. None
    // of this needs configuring; TIMSTREAMS_HOSTS only exists so an operator
    // can name a domain that did not exist when this was written, without
    // editing source and rebuilding.
    this.hosts = BaseProvider.hostList('TIMSTREAMS_HOSTS', ['timst.cfd', 'timstreams.st']);

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const res = await this.fetchFromHosts('/api/live-upcoming');
      return await res.json();
    });

    // The 24/7 channels, which the schedule above never lists on their own:
    // ESPN, ESPN2, ESPNU, SEC Network and the rest only ever appeared as the
    // embed behind some college game. The same site publishes them as a list,
    // each keyed to an embed that plays whether or not a game is on.
    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_channels`, async () => {
      const res = await this.fetchFromHosts('/api/channels');
      return await res.json();
    });
  }

  async getMatches() {
    const [events, channels] = await Promise.all([
      this.getEventMatches(),
      this.getChannelMatches()
    ]);
    return [...events, ...channels];
  }

  /**
   * The 24/7 channel list, as dateless `networks` entries so they land in the
   * Channels tab and merge with the same channel from any other source.
   *
   * Sources are keyed exactly as an event's are -- the hex of the embed URL --
   * so resolveStream, extraction and the manifest proxy all work unchanged.
   * The upstream `logo` is left out on purpose: it is a thumbnail, not a mark
   * (ABC's is a generic promo still), and the curated channel logo, when the
   * name has one, is what the card should be drawn from.
   */
  async getChannelMatches() {
    try {
      const data = await this.fetchChannels.fire();
      const list = data && Array.isArray(data.channels) ? data.channels : [];
      const genres = new Map(
        (Array.isArray(data && data.genres) ? data.genres : []).map(g => [g.id, g.name])
      );
      // Channels whose embed plays but which the index does not list. SEC
      // Network is the one that matters: its embed answers with a valid
      // playlist through the manifest proxy, the site uses it behind SEC games,
      // and it is simply absent from /api/channels. Added only while the index
      // still lacks a channel of that name, so the day it appears upstream the
      // upstream entry wins.
      const listed = new Set(list.map(c => String((c && c.name) || '').trim().toLowerCase()));
      for (const extra of TimStreamsProvider.UNLISTED_CHANNELS) {
        if (listed.has(extra.name.toLowerCase())) continue;
        list.push({
          url: extra.slug, name: extra.name, genre: null, vip: false,
          streams: [{ name: 'TimStreams', url: `https://epiembeds.online/embed/${extra.slug}`, vip: false }]
        });
      }

      const out = [];
      for (const c of list) {
        if (!c || c.vip || !c.name || !c.url) continue;
        const sources = (c.streams || [])
          .filter(st => st && !st.vip && typeof st.url === 'string' && /^https?:\/\//.test(st.url))
          .map(st => ({
            source: 'timstreams',
            id: Buffer.from(st.url).toString('hex'),
            name: st.name || 'Stream',
            url: st.url
          }));
        if (!sources.length) continue;
        const split = splitRegion(c.name);
        out.push(new MatchEntity({
          id: `ts_ch_${c.url}`,
          title: String(c.name).trim(),
          // The site's flag when it sets one, else a region word at the end of
          // the name ("Sky Sport 1 NZ", "DAZN 1 Germany").
          region: regionFromCode(c.flag) || split.region,
          baseTitle: split.base,
          category: 'networks',
          date: '0',
          popular: '0',
          league: String(genres.get(c.genre) || 'Live TV'),
          genre: normalizeGenre(genres.get(c.genre)) || '',
          thumbnail_url: typeof c.logo === 'string' ? c.logo : '',
          sources
        }));
      }
      return out;
    } catch (error) {
      console.error(`[${this.name}] Error fetching channels:`, error.message);
      return [];
    }
  }

  async getEventMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !Array.isArray(data.events)) return [];

      const genres = data.genres || {};
      
      data.events.forEach((s, index) => {
        const title = s.name || `TimStreams Event ${index}`;
        let rawGenre = s.genre;
        let genreLabel = 'other';
        if (Array.isArray(genres)) {
          const matchedGenre = genres.find(g => g.id === rawGenre);
          if (matchedGenre && matchedGenre.name) {
            genreLabel = matchedGenre.name;
          }
        } else if (typeof rawGenre === 'object' && rawGenre !== null && !Array.isArray(rawGenre)) {
          genreLabel = rawGenre.name || rawGenre.title || 'other';
        } else {
          genreLabel = String(genres[String(rawGenre)]?.name || genres[String(rawGenre)] || rawGenre || 'other');
        }
        
        const category = this.normalizeCategory(genreLabel);
        if (!this.isRetainedEventCategory(category)) return;
        
        let dateMs = Date.now();
        if (s.time) {
          const parsed = parseTimezone(s.time, 'America/New_York');
          if (parsed) dateMs = parsed;
        }
        
        const now = Date.now();
        const FOUR_HOURS = 4 * 60 * 60 * 1000;
        const isLive = dateMs <= now && dateMs > now - FOUR_HOURS;

        const sources = (s.streams || [])
          .filter(st => !st.vip)
          .map(st => {
            let id = st.name || 'Stream';
            if (st.url) {
               id = Buffer.from(st.url).toString('hex');
            }
            return {
              source: 'timstreams',
              id: id,
              name: st.name || 'Stream',
              url: st.url
            };
          });

        if (sources.length > 0) {
          matches.push(new MatchEntity({
            id: `ts_${s.url || index}`,
            title: title,
            category: category,
            date: dateMs.toString(),
            popular: (isLive || s.featured) ? '1' : '0',
            sources: sources,
            thumbnail_url: s.logo || ''
          }));
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.stack);
    }
    return matches;
  }

  /**
   * Decode a XOR-obfuscated script block from TimStreams embed pages.
   */
  decodeObfuscatedScript(html) {
    // 1. Find the obfuscated array
    const arrMatch = html.match(/var\s+\w+\s*=\s*\[([\d,]+)\]/);
    if (!arrMatch) return null;
    const arr = arrMatch[1].split(',').map(Number);
    
    // 2. Find the character decoding loop formula to get the variable names
    // Typically: String.fromCharCode(((_so7[_ix3]^_bw9)-_jr2+256)%256) or &255
    const loopMatch = html.match(/String\.fromCharCode\(\(\([\w\[\]]+\s*\^\s*(\w+)\)\s*-\s*(\w+)\s*\+\s*256\)\s*(?:%|&)\s*(?:256|255)\)/);
    if (!loopMatch) return null;
    
    const xorVarName = loopMatch[1];
    const subVarName = loopMatch[2];
    
    // 3. Find the integer values assigned to those variables
    const xorRegex = new RegExp(xorVarName + '\\s*=\\s*(\\d+)');
    const subRegex = new RegExp(subVarName + '\\s*=\\s*(\\d+)');
    
    const xorMatch = html.match(xorRegex);
    const subMatch = html.match(subRegex);
    
    if (!xorMatch || !subMatch) return null;
    
    const xor = parseInt(xorMatch[1]);
    const sub = parseInt(subMatch[1]);

    // 4. Decrypt natively in Node.js!
    let decoded = '';
    for (let i = 0; i < arr.length; i++) {
      decoded += String.fromCharCode(((arr[i] ^ xor) - sub + 256) % 256);
    }
    return decoded;
  }

  /**
   * Extract the signed m3u8 URL from a TimStreams embed page natively.
   */
  async extractM3u8(embedUrl) {
    try {
      const res = await this.proxyFetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          // Follows whichever host answered, so a rotation cannot leave this
          // pointing at a domain the embed host no longer recognises.
          'Referer': `https://${this.activeHost}/`
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) return null;
      const html = await res.text();

      const decoded = this.decodeObfuscatedScript(html);
      if (!decoded) return null;

      const urlMatch = decoded.match(/https?:\/\/[^\x22\x27<>\s]+\.m3u8/);
      if (!urlMatch) return null;

      const embedDomain = new URL(embedUrl).origin;
      return { m3u8: urlMatch[0], referer: embedDomain };
    } catch (e) {
      console.warn(`[${this.name}] m3u8 extraction failed for ${embedUrl}:`, e.message);
      return null;
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, streamNoParam = null, sourceName = 'timstreams') {
    const streams = [];
    const StreamEntity = require('../domain/StreamEntity');

    try {
      let embedUrls = [];
      try {
        const decoded = Buffer.from(sourceId, 'hex').toString('utf-8');
        if (decoded.startsWith('http')) {
           embedUrls = [{ name: 'Stream', url: decoded }];
        }
      } catch(e) {}

      if (embedUrls.length === 0) {
        const matches = await this.getMatches();
        const match = matches.find(m => m.id === `ts_${sourceId}` || m.sources.some(s => s.id === sourceId));

        if (match) {
          const specific = match.sources.find(s => s.id === sourceId && s.url);
          if (specific) {
            embedUrls = [{ name: specific.name || specific.id, url: specific.url }];
          } else {
            embedUrls = match.sources
              .filter(s => s.url)
              .map(s => ({ name: s.name || s.id, url: s.url }));
          }
        }
      }

      if (embedUrls.length === 0) {
        embedUrls = [{ name: sourceId, url: `https://logic.icelanders.st/embed/${sourceId}` }];
      }

      for (const embed of embedUrls) {
        let m3u8Url = null;
        let referer = new URL(embed.url).origin;
        
        // 1. Try native decryption
        const nativeResult = await this.extractM3u8(embed.url);
        if (nativeResult) {
            m3u8Url = nativeResult.m3u8;
            referer = nativeResult.referer;
        }

        if (m3u8Url) {
          console.log(`[${this.name}] Extracted M3U8 for ${matchTitle}: ${redactUrl(m3u8Url)}`);
          const { BASE_URL } = require('../config');
          const proxyUrl = `${BASE_URL}${require('../manifestLink').manifestPath(m3u8Url, referer, new URL(referer).origin)}`;
            
          streams.push(new StreamEntity({
            name: 'TimStreams',
            title: `TimStreams ${matchTitle}`,
            url: proxyUrl,
            behaviorHints: { 
              notWebReady: true
            },
            resolution: 'HD'
          }));
        }
        
        // Always add web fallback
        streams.push(new StreamEntity({
          name: `Nuvio Web Player`,
          title: `TimStreams (${embed.name}) (Web)`,
          externalUrl: `/watch?url=${encodeURIComponent(embed.url)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

// Embeds verified to play through the manifest proxy but missing from the
// site's own channel index. Each was checked before being added here -- SEC+
// and ACCNX were tried the same way and answer 502, so they are not.
TimStreamsProvider.UNLISTED_CHANNELS = [
  { name: 'SEC Network', slug: 'sec-usa' }
];

module.exports = TimStreamsProvider;

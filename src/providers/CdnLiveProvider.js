const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');
const { regionFromCode } = require('../channelRegions');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// A channel's source id is its player URL behind this marker, so resolveStream
// can tell a 24/7 channel from an event without looking anything up.
const CHANNEL_PREFIX = 'ch:';

// The channel list is one origin that has changed domains before; both names
// answer with the same data.
// Player pages rate-limit hard -- a sweep of about a hundred got this server's
// address a 429 that outlasted the hour. So a decoded playlist URL is kept
// until shortly before its token expires (the token carries its own expiry,
// about four hours out), and after a 429 no player page is asked for a while.
const DECODED_TTL_MS = 3 * 60 * 60 * 1000;
const TOKEN_MARGIN_MS = 15 * 60 * 1000;
const BENCH_AFTER_429_MS = 10 * 60 * 1000;
const DECODED_CACHE_MAX = 500;

// The expiry a CDNLive playlist token carries: base64 of "id:expiryMs:host:sig".
function tokenExpiry(url) {
  const m = /[?&]token=([^&]+)/.exec(String(url || ''));
  if (!m) return 0;
  try {
    const parts = Buffer.from(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8').split(':');
    const ms = Number(parts[1]);
    return Number.isFinite(ms) && ms > Date.now() ? ms : 0;
  } catch (e) {
    return 0;
  }
}

const CHANNEL_LIST_URLS = [
  'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free',
  'https://api.cdnlivetv.is/api/v1/channels/?user=cdnlivetv&plan=free'
];

class CdnLiveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'CDNLiveTV';
    this.apiUrl = 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free';
    this._decoded = new Map();   // player URL -> { url, expiresAt }
    this._benchedUntil = 0;

    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const headers = { 'User-Agent': UA };
      const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    // The 24/7 channels. A second source for ESPN, Fox Sports, the league
    // networks and the rest that does not run through TimStreams' embeds, so
    // one site going dark no longer empties the Channels tab.
    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_channels`, async () => {
      let lastErr = null;
      for (const url of CHANNEL_LIST_URLS) {
        try {
          const res = await this.proxyFetch(url, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(20000)
          });
          if (!res.ok) throw new Error(`channel list responded ${res.status}`);
          return await res.json();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('no channel list host answered');
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
   * The channel list, as dateless `networks` entries.
   *
   * Only channels the list marks online. Every offline one tried answered 503,
   * so listing them would add rows that never play; the list is re-read on each
   * catalog refresh, so a channel that comes back reappears on its own.
   *
   * One entry per name per country. The list reuses names across countries --
   * ESPN three times, ESPN 2 four -- and those are different channels, so each
   * carries its region: channels in different regions never merge, and a name
   * that repeats is labelled with it. Names are otherwise left as the list
   * writes them so each merges with the same channel from another source.
   *
   * Plain ESPN is missing from the list though its player plays, so it is
   * added by hand while the list still lacks it.
   *
   * Nothing is resolved here. The API allows 100 requests a minute and player
   * pages rate-limit sooner, so a stream is decoded only when somebody opens
   * the channel.
   */
  async getChannelMatches() {
    try {
      const data = await this.fetchChannels.fire();
      const list = data && Array.isArray(data.channels) ? data.channels : [];
      const nameOf = (c) => String((c && c.name) || '').trim().toLowerCase();

      // Every country by default. Regions keep a foreign ESPN from merging into
      // the US one, so there is no longer a reason to drop them; set
      // CDNLIVE_COUNTRIES (e.g. "us,gb,ca") to carry fewer.
      const countries = new Set((process.env.CDNLIVE_COUNTRIES || '')
        .split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
      const online = list.filter(c =>
        c && c.name && typeof c.url === 'string' && /^https?:\/\//i.test(c.url)
        && c.status === 'online' && (!countries.size || countries.has(String(c.code || '').toLowerCase())));

      // Plain US ESPN is absent though its player plays. Checked against US
      // entries specifically: foreign ESPNs are listed, so "is ESPN listed"
      // would say yes and the real one would never be added.
      const usListed = new Set(list.filter(c => c && c.code === 'us').map(nameOf));
      if ((!countries.size || countries.has('us')) && !usListed.has('espn')) {
        online.push({
          name: 'ESPN',
          code: 'us',
          url: 'https://cdnlivetv.tv/api/v1/channels/player/?name=ESPN&code=us&user=cdnlivetv&plan=free',
          image: '',
          status: 'online'
        });
      }

      const seen = new Set();
      const picked = [];
      for (const c of online) {
        const key = `${nameOf(c)}|${String(c.code || '').toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picked.push(c);
      }

      return picked.map(c => {
        const title = String(c.name).trim();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return new MatchEntity({
          id: `cdn_ch_${c.code || 'xx'}_${slug}`,
          title,
          region: regionFromCode(c.code),
          baseTitle: title,
          category: 'networks',
          date: '0',
          popular: '0',
          league: 'Live TV',
          // No artwork from the list. Its image links answer 401 whatever is sent
          // -- they need an account -- so every card drawn from one was a
          // placeholder, and every attempt was another request to a host that
          // already rate-limits this server. The logo index supplies the logo.
          sources: [{ source: 'cdnlive', id: CHANNEL_PREFIX + c.url }]
        });
      });
    } catch (err) {
      console.error(`[${this.name}] Failed to get channels:`, err.message);
      return [];
    }
  }

  async getEventMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      const sportMapping = {
        Soccer:'football', Football:'football', Basketball:'basketball', NBA:'basketball',
        NFL:'american_football', NCAA:'american_football', Baseball:'baseball', MLB:'baseball',
        Hockey:'hockey', NHL:'hockey', Motorsport:'motorsport', Tennis:'tennis', Golf:'golf',
        UFC:'mma', WWE:'mma', MMA:'mma', Cricket:'cricket', Darts:'darts', Rugby:'rugby'
      };
      for (const [sportKey,category] of Object.entries(sportMapping)) {
        const events=sportsData[sportKey]; if(!Array.isArray(events))continue;
        for(const item of events){
          if(!Array.isArray(item.channels)||!item.channels.length)continue;
          const matchId=item.gameID||`${item.homeTeam}-vs-${item.awayTeam}`.toLowerCase().replace(/[^a-z0-9-]/g,'-');
          const title=`${item.homeTeam||''} vs ${item.awayTeam||''}`;
          const status=(item.status==='live'||item.status==='in')?'live':'upcoming';
          const matchTime=item.start?parseTimezone(item.start,'UTC'):Date.now();
          matches.push(new MatchEntity({id:`cdn_${matchId}`,title,category,status,timestamp:matchTime,sources:[{source:'cdnlive',id:matchId}]}));
        }
      }
    } catch(err){console.error(`[${this.name}] Failed to get matches:`,err.message)}
    return matches;
  }

  /**
   * The signed playlist URL a CDNLive player page hides, or ''.
   *
   * The page builds the URL at runtime from several base64 fragments joined by
   * a decoder function; the decoder is found by shape, then each fragment it is
   * called with is decoded and concatenated. Shared by events and channels,
   * which use the same player.
   */
  // `opts.strict` (the channel health check) throws where a viewer would just
  // get the web player: paused after a 429, rate-limited, or a page that did not
  // decode. None of those says the channel is dead.
  async decodePlayer(playerUrl, opts = {}) {
    const cached = this._decoded.get(playerUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    if (Date.now() < this._benchedUntil) {
      if (opts.strict) throw new Error('player lookups paused after a 429');
      return '';
    }

    const { safeFetch } = require('../impitClient');
    const urls = [playerUrl];
    if (playerUrl.includes('cdnlivetv.tv')) urls.push(playerUrl.replace('cdnlivetv.tv','cdnlivetv.is'));
    else if (playerUrl.includes('cdnlivetv.is')) urls.push(playerUrl.replace('cdnlivetv.is','cdnlivetv.tv'));

    for (const url of urls) {
      try {
        const origin = new URL(url).origin;
        const playerRes = await safeFetch(url, {
          headers: { 'User-Agent': UA, 'Referer': origin + '/' },
          timeoutMs: 10000
        });
        if (playerRes.status === 429) {
          this._benchedUntil = Date.now() + BENCH_AFTER_429_MS;
          if (opts.strict) throw new Error('player page rate-limited');
          continue;
        }
        if (!playerRes.ok) continue;
        const html = await playerRes.text();
        let m3u8Url = '';

        // Newer pages use literal atob("...") concatenation.
        const concat = html.match(/var\s+[a-zA-Z0-9_]+\s*=\s*(atob\([^;]+;)/);
        if (concat) {
          const re=/atob\s*\(\s*["']([^"']+)["']\s*\)/g; let m;
          while((m=re.exec(concat[1]))!==null){let b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';try{m3u8Url+=Buffer.from(b,'base64').toString('utf8')}catch(_){}}
        }

        // Older pages call a decoder function with base64 variables.
        if (!m3u8Url) {
          const dm=html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{[\s\S]*?atob/);
          if(dm){const name=dm[1],cm=html.match(new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${name}\\([^;]+;`));if(cm){const vr=new RegExp(`${name}\\(([a-zA-Z0-9_]+)\\)`,'g');let vm;while((vm=vr.exec(cm[0]))!==null){const val=html.match(new RegExp(`var\\s+${vm[1]}\\s*=\\s*['"]([^'"]+)['"]`));if(val){let b=val[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';try{m3u8Url+=Buffer.from(b,'base64').toString('utf8')}catch(_){}}}}}
        }

        // Last-resort direct/escaped playlist URL.
        if (!m3u8Url) {
          const direct=html.match(/(https?:\\?\/\\?\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
          if(direct)m3u8Url=direct[1].replace(/\\\//g,'/');
        }
        if (!m3u8Url || !m3u8Url.includes('.m3u8')) continue;

        const exp=tokenExpiry(m3u8Url);
        const expiresAt=exp?Math.min(exp-TOKEN_MARGIN_MS,Date.now()+DECODED_TTL_MS):Date.now()+DECODED_TTL_MS;
        if(this._decoded.size>=DECODED_CACHE_MAX)this._decoded.delete(this._decoded.keys().next().value);
        if(expiresAt>Date.now())this._decoded.set(playerUrl,{url:m3u8Url,expiresAt});
        return m3u8Url;
      } catch (e) {
        if (opts.strict && /rate-limited/.test(e.message)) throw e;
      }
    }
    if (opts.strict) throw new Error('player did not decode');
    return '';
  }

  /**
   * A direct stream when the player decodes, otherwise the player itself as a
   * web stream. The title carries the provider name on purpose: the stream
   * label builder recognises this source by "cdnlive" in the title, and a bare
   * channel name fell through to the Streamed.pk default -- wrong label, and
   * the wrong Referer for playback.
   */
  /** True while player lookups are paused after a 429. */
  isBenched() {
    return Date.now() < this._benchedUntil;
  }

  async resolvePlayer(playerUrl, name, opts = {}) {
    try {
      const m3u8Url = await this.decodePlayer(playerUrl, opts);
      if (m3u8Url) {
        return [new StreamEntity({
          name: 'CDNLiveTV',
          title: `CDNLiveTV (${name})`,
          url: m3u8Url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: { Origin: 'https://cdnlivetv.tv', Referer: 'https://cdnlivetv.tv/', 'User-Agent': UA }
            }
          },
          resolution: 'HD'
        })];
      }
      // Strict: no direct stream is not the same as no channel.
      if (opts.strict) throw new Error('player did not decode');
    } catch (e) {
      if (opts.strict) throw e;
      console.warn(`[${this.name}] Failed to extract m3u8 for ${playerUrl}:`, e.message);
    }
    return [new StreamEntity({
      name: 'CDNLiveTV',
      title: `CDNLiveTV (${name}) (Web Player)`,
      externalUrl: playerUrl,
      resolution: 'HD'
    })];
  }

  async resolveStream(sourceId, matchCategory, matchTitle, opts = {}) {
    if (typeof sourceId === 'string' && sourceId.startsWith(CHANNEL_PREFIX)) {
      return this.resolvePlayer(sourceId.slice(CHANNEL_PREFIX.length), matchTitle || 'Channel', opts);
    }

    const streams = [];
    try {
      const data = await this.fetchMain.fire();
      const sportsData = data?.['cdn-live-tv'] || {};
      let item = null;
      for (const events of Object.values(sportsData)) {
        if (!Array.isArray(events)) continue;
        item = events.find(e =>
          (e.gameID === sourceId) ||
          (`${e.homeTeam}-vs-${e.awayTeam}`.toLowerCase().replace(/[^a-z0-9-]/g, '-') === sourceId)
        );
        if (item) break;
      }

      if (item && Array.isArray(item.channels)) {
        for (const [idx, ch] of item.channels.entries()) {
          if (!ch.url) continue;
          streams.push(...await this.resolvePlayer(ch.url, ch.channel_name || `CDNLive Stream ${idx + 1}`));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = CdnLiveProvider;

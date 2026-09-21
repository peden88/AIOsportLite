// Optional Cloudflare Worker proxies (cloudflare-worker/index.js), from
// CF_PROXY_URL: one worker URL, or several separated by commas to spread the
// requests across free-tier limits. Unset, requests go out directly.
const CF_PROXY_POOL = String(process.env.CF_PROXY_URL || '')
  .split(',').map(s => s.trim()).filter(s => /^https?:\/\//i.test(s));

// Safe impit wrapper — falls back to undici when impit native binary is
// unavailable (ARM64 VPS, Alpine/musl Linux, certain Windows Server builds).
const { safeFetch: _safeFetch } = require('../impitClient');
const { isRetainedEventCategory } = require('../sportsPolicy');

// Pick a random proxy from the pool
function getCfProxyUrl() {
  if (process.env.NODE_ENV === 'test') return null;
  if (CF_PROXY_POOL.length === 0) return null;
  return CF_PROXY_POOL[Math.floor(Math.random() * CF_PROXY_POOL.length)];
}

class BaseProvider {
  // How long a host that just failed is passed over. Long enough that a dead
  // mirror is not re-tried every request, short enough that a site coming back
  // up is picked up on its own without a restart.
  static HOST_BENCH_MS = Number(process.env.HOST_BENCH_MS) || 5 * 60 * 1000;

  constructor({ circuitBreaker }) {
    this.circuitBreaker = circuitBreaker;
    this.name = 'BaseProvider';
  }

  /**
   * Fetch matches from the provider.
   * Should return an array of MatchEntity objects.
   */
  async getMatches() {
    throw new Error('getMatches() must be implemented by subclasses');
  }

  /**
   * Resolve a specific stream source.
   * Should return an array of StreamEntity objects.
   */
  async resolveStream(sourceId, matchCategory, matchTitle) {
    return [];
  }

  /**
   * Helper to normalize category strings across all providers
   */
  normalizeCategory(cat) {
    if (!cat) return 'other';
    if (typeof cat === 'object' && !Array.isArray(cat)) {
      cat = cat.name || cat.title || 'other';
    }
    cat = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cat.includes('americanfootball') || cat.includes('nfl') || cat.includes('afl') || cat.includes('gridiron')) return 'american_football';
    if (cat.includes('soccer') || cat.includes('football')) return 'football';
    if (cat.includes('motor') || cat.includes('racing') || cat.includes('cycling') || cat.includes('f1')) return 'motorsport';
    // 'martialarts' catches TimStreams' "Mixed Martial Arts", which spells out
    // what every other feed abbreviates. It contains none of the other words
    // here -- not even 'mma' -- so it fell through as its own category, which
    // put those fights in Other instead of MMA and, worse, stopped them
    // merging with the same fight from another provider: the aggregator's
    // category guard rejects the pair before it ever compares the titles, so
    // the streams stayed split across two listings.
    if (cat.includes('fight') || cat.includes('mma') || cat.includes('martialarts') || cat.includes('boxing') || cat.includes('wrestling') || cat.includes('knuckle') || cat.includes('ufc')) return 'mma';
    if (cat.includes('basketball') || cat.includes('nba')) return 'basketball';
    if (cat.includes('golf')) return 'golf';
    if (cat.includes('rugby')) return 'rugby';
    if (cat.includes('cricket')) return 'cricket';
    if (cat.includes('tennis')) return 'tennis';
    if (cat.includes('hockey') || cat.includes('nhl')) return 'hockey';
    if (cat.includes('baseball') || cat.includes('mlb')) return 'baseball';
    if (cat.includes('darts')) return 'darts';
    if (cat.includes('liveshow') || cat.includes('uncategorized')) return 'other';
    return cat;
  }

  /** True when a fixture category belongs in the Lite build. */
  isRetainedEventCategory(category) {
    return isRetainedEventCategory(category);
  }

  /**
   * Fetch wrapper that routes through Cloudflare proxy if configured
   */
  async proxyFetch(url, options = {}) {
    const cfProxyUrl = getCfProxyUrl();
    if (cfProxyUrl) {
      const proxyUrl = new URL(cfProxyUrl);
      proxyUrl.searchParams.set('url', url);
      
      if (options.headers) {
        let referer, origin;
        if (options.headers instanceof Headers) {
          referer = options.headers.get('referer') || options.headers.get('Referer');
          origin = options.headers.get('origin') || options.headers.get('Origin');
        } else {
          referer = options.headers.referer || options.headers.Referer;
          origin = options.headers.origin || options.headers.Origin;
        }
        
        if (referer) proxyUrl.searchParams.set('referer', referer);
        if (origin) proxyUrl.searchParams.set('origin', origin);
      }
      
      url = proxyUrl.toString();
    }
    
    // safeFetch tries impit first (browser TLS fingerprint), falls back to
    // undici automatically — works on Windows, Linux x64, ARM64, musl, etc.

    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      // Callers that are trying several hosts in turn need a shorter leash than
      // fifteen seconds, or one dead mirror spends the whole request budget.
      timeoutMs: options.timeoutMs || 15000,
    };

    // safeFetch tries impit first (browser TLS fingerprint), falls back to
    // undici automatically — works on Windows, Linux x64, ARM64, musl, etc.
    return await _safeFetch(url, reqOptions);
  }

  /**
   * The hosts this provider will try, in order.
   *
   * These sites rotate domains -- timstreams.st went dark and came back as
   * timst.cfd, cdnlivetv has been both .tv and .is -- and a provider pinned to
   * one hostname dies the day that happens. Everyone self-hosting then has to
   * wait for a source edit and a rebuild to get their streams back, which is
   * not something to ask of someone who just wanted to run the addon.
   *
   * So a provider names every host it knows and the fetch below picks whichever
   * is answering. `envVar` is an escape hatch, not a requirement: nothing needs
   * setting for the known hosts to work, but if the site moves somewhere nobody
   * has heard of yet, an operator can point at it without touching source.
   */
  static hostList(envVar, known) {
    const extra = String(process.env[envVar] || '')
      .split(',')
      .map(h => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    // Operator's hosts first -- they are the ones with current information.
    return [...new Set([...extra, ...known])];
  }

  /**
   * Fetch `path` from whichever of `this.hosts` is alive, and remember which.
   *
   * Ordinary calls cost one request: the host that worked last time is tried
   * first and almost always answers. The search only happens after a failure.
   *
   * A host that fails is benched for a while rather than retried on every call,
   * because the expensive case is a dead mirror sitting at the front of the
   * list burning a timeout per request. With the bench and the remembered
   * winner, a rotation costs one slow request and then goes back to full speed.
   */
  async fetchFromHosts(path, options = {}) {
    const hosts = this.hosts || [];
    if (!hosts.length) throw new Error(`${this.name}: no hosts configured`);

    this._benched = this._benched || new Map();
    const now = Date.now();
    const benched = h => (this._benched.get(h) || 0) > now;

    // Last winner first, then anything not currently benched, then the benched
    // ones as a last resort -- a bench is a hint, never a refusal to try.
    const ordered = [
      ...(this._activeHost ? [this._activeHost] : []),
      ...hosts.filter(h => h !== this._activeHost && !benched(h)),
      ...hosts.filter(h => h !== this._activeHost && benched(h)),
    ];

    // The host we expect to answer gets a full budget; the rest are probes and
    // get a short one. Giving every candidate the same short leash would have
    // made a slow-but-working site fail where it used to succeed -- a real
    // regression traded for a failure case that does not need that long to
    // detect. Worst case across the list stays under the single-host timeout
    // this replaced, so no path waits longer than it did before.
    const firstTimeout = options.timeoutMs || 10000;
    const probeTimeout = Math.min(firstTimeout, 4000);
    let lastErr = null;

    for (const [i, host] of ordered.entries()) {
      try {
        const res = await this.proxyFetch(`https://${host}${path}`, {
          ...options,
          timeoutMs: i === 0 ? firstTimeout : probeTimeout,
        });
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} from ${host}`);
          this._benched.set(host, Date.now() + BaseProvider.HOST_BENCH_MS);
          continue;
        }
        if (this._activeHost !== host) {
          console.log(`[${this.name}] using host ${host}`);
          this._activeHost = host;
        }
        this._benched.delete(host);
        return res;
      } catch (err) {
        lastErr = err;
        this._benched.set(host, Date.now() + BaseProvider.HOST_BENCH_MS);
      }
    }

    // Every host failed, so the remembered winner is stale: drop it rather than
    // keep sending the next call to a host that just refused.
    this._activeHost = null;
    throw lastErr || new Error(`${this.name}: every host failed`);
  }

  /** The host currently answering, for building Referer/Origin that match. */
  get activeHost() {
    return this._activeHost || (this.hosts && this.hosts[0]) || null;
  }

  /**
   * Helper to normalize strings for fuzzy matching
   */
  normalizeStr(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = BaseProvider;
module.exports.getCfProxyUrl = getCfProxyUrl;

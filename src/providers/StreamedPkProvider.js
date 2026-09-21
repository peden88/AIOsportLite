const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

const { splitRegion } = require('../channelRegions');

// Words that are initials in a channel name, for turning a feed slug back into
// the name people know the channel by.
const CHANNEL_ACRONYMS = new Set(['espn', 'nfl', 'nba', 'mlb', 'nhl', 'tv', 'abc', 'cbs', 'nbc', 'fox', 'sec', 'acc', 'ufc', 'f1', 'bt', 'tnt', 'hbo', 'usa']);
function channelNameFromSlug(slug) {
  return String(slug).split('-').filter(Boolean)
    .map(w => (CHANNEL_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// A stream's language label names its channel after the dash: "Spanish - ESPN
// Deportes". A plain language ("English") names none.
function channelFromLanguage(language) {
  const m = /^\s*[A-Za-z]+\s+-\s+(.+?)\s*$/.exec(String(language || ''));
  if (!m) return null;
  const name = m[1].trim();
  if (!/[a-z]/i.test(name) || /^(stream|feed|backup|link|server|hd|sd)\b/i.test(name)) return null;
  return name;
}

const normChannel = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

class StreamedPkProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamedPk';
    this.embedStProvider = opts.embedStProvider;
    this.embedIndiaProvider = opts.embedIndiaProvider;
    this.apiUrl = 'https://streamed.pk/api';

    this.fetchMatches = this.circuitBreaker.wrap(`${this.name}_fetchMatches`, async () => {
      const res = await this.proxyFetch(`${this.apiUrl}/matches/all`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchLiveMatches = this.circuitBreaker.wrap(`${this.name}_fetchLiveMatches`, async () => {
      const res = await this.proxyFetch(`${this.apiUrl}/matches/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (source, id) => {
      const url = `${this.apiUrl}/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
      const res = await this.proxyFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const [allData, liveData] = await Promise.all([
        this.fetchMatches.fire().catch(() => []),
        this.fetchLiveMatches.fire().catch(() => [])
      ]);

      // Verify which live matches actually have active stream URLs
      const liveVerifiedIds = new Set();
      const liveVerifiedSourceIds = new Set();
      if (Array.isArray(liveData) && liveData.length > 0) {
        await Promise.all(
          liveData.map(async (m) => {
            const liveCategory = this.normalizeCategory(m && m.category);
            if (liveCategory !== 'other' && !this.isRetainedEventCategory(liveCategory)) return;
            const src = (m.sources && m.sources[0]) || { source: 'admin', id: m.id };
            try {
              const streams = await this.fetchStreams.fire(src.source || 'admin', src.id || m.id);
              if (Array.isArray(streams) && streams.length > 0) {
                liveVerifiedIds.add(m.id);
                (m.sources || []).forEach(s => liveVerifiedSourceIds.add(s.id));
              }
            } catch (e) {
              // Stream endpoint error or empty
            }
          })
        );
      }

      if (Array.isArray(allData)) {
        const now = Date.now();
        for (const item of allData) {
          if (!item.id || !item.title) continue;

          const is247Channel = !item.date || Number(item.date) <= 0;
          const normalizedCategory = this.normalizeCategory(item.category);
          // Explicitly-labelled excluded events stop here. Keep unknown/"other"
          // long enough for the aggregator's crest/league classifier to rescue
          // a Football or Rugby fixture whose source did not name its sport.
          if (!is247Channel && normalizedCategory !== 'other' && !this.isRetainedEventCategory(normalizedCategory)) continue;
          // streamed.pk lists its NFL schedule page as an always-on item. It is
          // not a channel and opens to nothing, so it has no place in Channels.
          if (is247Channel && /\bschedule\b/i.test(String(item.title))) continue;
          const isGenuinelyLive = is247Channel || liveVerifiedIds.has(item.id) || (item.sources || []).some(s => liveVerifiedSourceIds.has(s.id));
          const isUpcoming = !is247Channel && item.date && Number(item.date) > now;

          // If it is not a 24/7 channel, not actively live, and not upcoming, it is finished! Skip it.
          if (!is247Channel && !isGenuinelyLive && !isUpcoming) {
            continue;
          }

          const status = is247Channel ? '' : (isGenuinelyLive ? 'live' : 'upcoming');

          // Map sources
          const sources = (item.sources || []).map(s => ({
            source: 'streamedpk',
            id: item.id,
            streamSource: s.source,
            streamId: s.id
          }));

          if (sources.length === 0) {
            sources.push({
              source: 'streamedpk',
              id: item.id
            });
          }

          const posterUrl = item.poster ? (
            item.poster.startsWith('//') ? `https:${item.poster}` :
            item.poster.startsWith('http') ? item.poster :
            item.poster.startsWith('/') ? `https://streamed.pk${item.poster}` :
            `https://streamed.pk/${item.poster}`
          ) : '';
          const homeBadge = item.teams && item.teams.home && item.teams.home.badge ? `https://streamed.pk/api/images/proxy/${item.teams.home.badge}` : '';
          const awayBadge = item.teams && item.teams.away && item.teams.away.badge ? `https://streamed.pk/api/images/proxy/${item.teams.away.badge}` : '';

          // A 24/7 item can carry a whole channel under an event's title.
          // streamed.pk files its ESPN feed (admin-espn) under "US Open" beside
          // a Roland-Garros stream, which hid ESPN, ESPN2, ESPN Deportes and ABC
          // behind a tennis tournament. A feed named for a channel becomes that
          // channel, listed -- and merged with the same channel elsewhere --
          // under its real name. resolveStream reads each source's own
          // streamSource/streamId, so the split feed plays exactly as before.
          if (is247Channel) {
            for (let i = sources.length - 1; i >= 0; i--) {
              const src = sources[i];
              const slug = /^admin-(.+)$/.exec(String(src.streamId || ''));
              if (!slug || src.streamSource !== 'admin') continue;
              const feedChannel = channelNameFromSlug(slug[1]);
              // One feed can carry several channels. admin-espn holds ESPN,
              // ESPN2, ESPN Deportes and ABC, each stream naming its channel in
              // its language label. Listed as one channel, every one of those
              // streams landed on the ESPN tile and the ESPN2, Deportes and ABC
              // tiles got none. So the feed is split by the channel each stream
              // names, and each part plays only its own streams (src.channel in
              // resolveStream). If the list cannot be read, the feed stays one
              // channel, as before.
              let channels = [feedChannel];
              try {
                const list = await this.fetchStreams.fire('admin', src.streamId);
                if (Array.isArray(list) && list.length) {
                  channels = [...new Set(list.map(st => channelFromLanguage(st.language) || feedChannel))];
                }
              } catch (e) { /* one channel */ }
              const byChannel = channels.length > 1 || normChannel(channels[0]) !== normChannel(feedChannel);
              if (!byChannel && normChannel(feedChannel) === normChannel(item.title)) continue;
              sources.splice(i, 1);
              for (const channelName of channels) {
                const own = normChannel(channelName) === normChannel(feedChannel);
                matches.push(new MatchEntity({
                  // Its own prefix: the parent item's id can be the very same
                  // slug ("US Open" is item admin-espn), and the stream lookup
                  // takes the first match by id.
                  id: own ? `spk_ch_${src.streamId}` : `spk_ch_${src.streamId}__${normChannel(channelName)}`,
                  title: channelName,
                  region: splitRegion(channelName).region,
                  baseTitle: splitRegion(channelName).base,
                  category: 'networks',
                  status: '',
                  date: '',
                  popular: '1',
                  sources: [byChannel ? { ...src, channel: channelName } : src]
                }));
              }
            }
            if (sources.length === 0) continue;
          }

          matches.push(new MatchEntity({
            id: `spk_${item.id}`,
            title: item.title,
            region: is247Channel ? splitRegion(item.title).region : '',
            baseTitle: is247Channel ? splitRegion(item.title).base : '',
            category: is247Channel && (item.id.includes('channel') || item.id.includes('network') || item.id.includes('tv') || Number(item.date) <= 0)
              ? (item.category === 'rugby' ? 'rugby' : normalizedCategory)
              : normalizedCategory,
            status: status,
            date: is247Channel ? '' : String(item.date || Date.now()),
            popular: is247Channel ? '1' : (item.popular ? '1' : '0'),
            poster: posterUrl,
            logo: homeBadge,
            background: posterUrl,
            team1: item.teams && item.teams.home ? { name: item.teams.home.name, logo: homeBadge || null } : null,
            team2: item.teams && item.teams.away ? { name: item.teams.away.name, logo: awayBadge || null } : null,
            sources: sources
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    try {
      const streamSource = src.streamSource || 'admin';
      const streamId = src.streamId || sourceId;

      const streamList = await this.fetchStreams.fire(streamSource, streamId);
      if (Array.isArray(streamList)) {
        // Sort streams by viewer count (descending)
        streamList.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));

        // A feed split by channel plays only the streams that name this one;
        // a stream naming no channel belongs to the feed's own channel.
        if (src.channel) {
          const slug = /^admin-(.+)$/.exec(String(streamId));
          const feedChannel = slug ? channelNameFromSlug(slug[1]) : '';
          const wanted = normChannel(src.channel);
          const mine = streamList.filter(st => normChannel(channelFromLanguage(st.language) || feedChannel) === wanted);
          streamList.length = 0;
          streamList.push(...mine);
        }

        // Chunk the stream list to prevent memory spiking on Render (512MB RAM limit).
        // Executing max 3 WASM child processes at a time keeps RAM usage very safe.
        const CHUNK_SIZE = 3;
        for (let i = 0; i < streamList.length; i += CHUNK_SIZE) {
          const chunk = streamList.slice(i, i + CHUNK_SIZE);
          
          const resolvePromises = chunk.map(async (streamItem) => {
            if (!streamItem.embedUrl) return [];
            
            const viewersText = streamItem.viewers != null ? `👥 ${streamItem.viewers} Viewers` : '';
            const baseLabel = streamItem.language ? `${matchTitle} (${streamItem.language})` : `${matchTitle} Stream ${streamItem.streamNo || 1}`;
            const label = viewersText ? `${baseLabel} | ${viewersText}` : baseLabel;
            
            if (streamItem.embedUrl.includes('embedindia') && this.embedIndiaProvider) {
              return await this.embedIndiaProvider.resolveStream(
                streamItem.embedUrl,
                matchCategory,
                label,
                { embedUrl: streamItem.embedUrl }
              );
            } else if (this.embedStProvider) {
              return await this.embedStProvider.resolveStream(
                streamItem.embedUrl,
                matchCategory,
                label,
                { embedUrl: streamItem.embedUrl }
              );
            } else {
              return [new StreamEntity({
                name: 'StreamedPk',
                title: `${label} (Web Player)`,
                externalUrl: `/watch?url=${encodeURIComponent(streamItem.embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
              })];
            }
          });

          const results = await Promise.allSettled(resolvePromises);
          for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
              streams.push(...result.value);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = StreamedPkProvider;
module.exports.channelFromLanguage = channelFromLanguage;

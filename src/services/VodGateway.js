'use strict';

const appServices = require('./AppServiceRegistry');
const { StremioServiceClient, UpstreamServiceError } = require('./StremioServiceClient');

const clients = new Map();

function assertVodEnabled() {
  const cfg = appServices._privateConfig();
  if (!cfg.vod.enabled) {
    throw new UpstreamServiceError('VOD is not enabled on this installation.', {
      statusCode: 503,
      code: 'VOD_DISABLED'
    });
  }
  return cfg;
}

function clientFor(service, clientKind = 'web') {
  const cfg = assertVodEnabled();
  const url = service === 'metadata'
    ? cfg.metadata.manifestUrl
    : (clientKind === 'app' ? cfg.streams.appManifestUrl : cfg.streams.webManifestUrl);

  if (!url) {
    throw new UpstreamServiceError(
      'AIOStreams is not configured for the ' + (clientKind === 'app' ? 'app' : 'web') + ' client.',
      { statusCode: 503, code: 'AIOSTREAMS_CLIENT_NOT_CONFIGURED' }
    );
  }

  const key = service + '|' + clientKind + '|' + url;
  const existing = clients.get(key);
  if (existing) return existing;

  for (const cacheKey of clients.keys()) {
    if (cacheKey.startsWith(service + '|' + clientKind + '|') && cacheKey !== key) {
      clients.delete(cacheKey);
    }
  }

  const client = new StremioServiceClient(url, {
    serviceName: service === 'metadata' ? 'AIOMetadata' : 'AIOStreams'
  });
  clients.set(key, client);
  return client;
}

function validStremioType(type) {
  const value = String(type || '').trim().toLowerCase();
  if (!['movie', 'series'].includes(value)) {
    const err = new Error('VOD type must be movie or series.');
    err.statusCode = 400;
    err.code = 'INVALID_VOD_TYPE';
    throw err;
  }
  return value;
}

function cleanId(id) {
  const value = String(id || '').trim();
  if (!value || value.length > 500) {
    const err = new Error('Missing or invalid content id.');
    err.statusCode = 400;
    err.code = 'INVALID_CONTENT_ID';
    throw err;
  }
  return value;
}

async function catalogs() {
  const descriptors = await clientFor('metadata').catalogDescriptors();

  // The web picker can only render catalogs that are valid with no required
  // Stremio extras. AIOMetadata also advertises function-style catalogs such as
  // Search, Anime Search, People Search and Calendar views; those are invoked
  // through dedicated UI/API flows and fail when treated like ordinary shelves.
  return {
    catalogs: descriptors.filter(descriptor =>
      Array.isArray(descriptor.requiredExtras) &&
      descriptor.requiredExtras.length === 0
    )
  };
}

async function catalog(type, catalogId, extra = {}) {
  return clientFor('metadata').catalog(validStremioType(type), cleanId(catalogId), extra);
}

async function search(query, type) {
  const q = String(query || '').trim();
  if (!q) return { metas: [] };
  if (q.length > 200) {
    const err = new Error('Search query is too long.');
    err.statusCode = 400;
    throw err;
  }
  return clientFor('metadata').search(q, type ? validStremioType(type) : undefined);
}

async function meta(type, id) {
  return clientFor('metadata').meta(validStremioType(type), cleanId(id));
}

function privatePlaybackRow(stream, client) {
  if (!stream || typeof stream !== 'object') return null;

  // AIOStreams deliberately appends notice rows to ordinary Stremio stream
  // responses. They may carry an externalUrl (for example its GitHub page), but
  // they are UI notices rather than media and must never win automatic playback.
  const streamDataType = String(stream.streamData && stream.streamData.type || '').toLowerCase();
  if (['error', 'statistic', 'info'].includes(streamDataType)) return null;

  // Dedicated VOD playback only accepts media URLs. Stremio externalUrl means
  // "leave the player and open another page/app", which violates the one-button
  // in-player contract. AIOStreams may still use external debrid targets inside
  // the failover chain encoded into one of its owned stream.url values.
  const direct = client.absolutizePlaybackUrl(stream.url);
  if (!direct) return null;

  const requestHeaders = stream.behaviorHints &&
    stream.behaviorHints.proxyHeaders &&
    stream.behaviorHints.proxyHeaders.request &&
    typeof stream.behaviorHints.proxyHeaders.request === 'object'
      ? { ...stream.behaviorHints.proxyHeaders.request }
      : undefined;

  // Parse non-sensitive media attributes from AIOStreams' display text, but
  // never carry provider/release labels into the opaque playback model.
  const descriptor = [
    stream.title,
    stream.name,
    stream.description,
    stream.streamData && stream.streamData.filename,
    stream.behaviorHints && stream.behaviorHints.filename
  ].filter(Boolean).map(String).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400);
  const hintedSize = Number(stream.behaviorHints && stream.behaviorHints.videoSize);
  const resolutionMatch = descriptor.match(/\b(2160p|1080p|720p|480p|4K|UHD)\b/i);
  const qualityMatch = descriptor.match(/\b(REMUX|BluRay|BDRip|WEB[- .]?DL|WEBRip|HDTV|DVDRip)\b/i);
  const codecMatch = descriptor.match(/\b(AV1|HEVC|H[ .-]?265|x265|H[ .-]?264|x264)\b/i);
  const visual = [];
  if (/\b(?:DV|DoVi|Dolby[ .-]?Vision)\b/i.test(descriptor)) visual.push('DV');
  if (/\bHDR10\+\b/i.test(descriptor)) visual.push('HDR10+');
  else if (/\bHDR10\b/i.test(descriptor)) visual.push('HDR10');
  else if (/\bHDR\b/i.test(descriptor)) visual.push('HDR');
  if (/\bHLG\b/i.test(descriptor)) visual.push('HLG');

  const audio = [];
  if (/\b(?:TrueHD|TRUE[ .-]?HD)\b/i.test(descriptor)) audio.push('TrueHD');
  else if (/\b(?:EAC3|E-AC-3|DDP|DD\+)\b/i.test(descriptor)) audio.push('DD+');
  else if (/\b(?:AC3|AC-3|DD)\b/i.test(descriptor)) audio.push('DD');
  if (/\bAtmos\b/i.test(descriptor)) audio.push('Atmos');
  if (/\bDTS[ .-]?HD(?:[ .-]?MA)?\b/i.test(descriptor)) audio.push('DTS-HD MA');
  else if (/\bDTS\b/i.test(descriptor)) audio.push('DTS');
  if (/\bAAC\b/i.test(descriptor)) audio.push('AAC');
  const channels = descriptor.match(/\b(7\.1|5\.1|2\.0)\b/);
  if (channels) audio.push(channels[1]);

  const resolution = resolutionMatch
    ? (/^(?:4K|UHD)$/i.test(resolutionMatch[1]) ? '2160p' : resolutionMatch[1].toUpperCase().replace('P','p'))
    : '';
  const quality = qualityMatch ? qualityMatch[1].replace(/[ .]/g, '-').toUpperCase() : '';
  const codec = codecMatch ? codecMatch[1].replace(/[ .-]/g, '').toUpperCase().replace('H265','HEVC').replace('X265','HEVC') : '';


  return {
    url: direct,
    downloadMeta: {
      size: Number.isFinite(hintedSize) && hintedSize > 0 ? hintedSize : 0,
      resolution,
      quality,
      codec,
      visual: [...new Set(visual)].join(' / '),
      audio: [...new Set(audio)].join(' / ')
    },
    playbackMeta: {
      codec,
      audio: [...new Set(audio)].join(' / '),
      visual: [...new Set(visual)].join(' / '),
      quality,
      resolution,
      container: /\.mp4(?:[?#]|$)/i.test(direct) ? 'mp4'
        : /\.m4v(?:[?#]|$)/i.test(direct) ? 'm4v'
        : /\.m3u8(?:[?#]|$)/i.test(direct) ? 'hls'
        : /\.mkv(?:[?#]|$)/i.test(direct) ? 'mkv'
        : ''
    },
    ...(requestHeaders && Object.keys(requestHeaders).length
      ? { behaviorHints: { proxyHeaders: { request: requestHeaders } } }
      : {})
  };
}

async function diagnosticService(service, manifestUrl) {
  if (!manifestUrl) return { configured: false, reachable: false };
  try {
    const client = new StremioServiceClient(manifestUrl, {
      serviceName: service === 'metadata' ? 'AIOMetadata' : 'AIOStreams',
      manifestTtlMs: 1
    });
    const manifest = await client.manifest({ force: true });
    return {
      configured: true,
      reachable: true,
      id: String(manifest.id || ''),
      name: String(manifest.name || ''),
      version: String(manifest.version || ''),
      types: Array.isArray(manifest.types) ? manifest.types.map(String) : [],
      resources: Array.isArray(manifest.resources)
        ? manifest.resources.map(r => typeof r === 'string' ? r : String(r && r.name || '')).filter(Boolean)
        : [],
      catalogCount: Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      error: err && err.code ? String(err.code) : 'UPSTREAM_ERROR'
    };
  }
}

async function diagnostics() {
  const cfg = appServices._privateConfig();
  const [metadata, streamsWeb, streamsApp] = await Promise.all([
    diagnosticService('metadata', cfg.metadata.manifestUrl),
    diagnosticService('streams', cfg.streams.webManifestUrl),
    diagnosticService('streams', cfg.streams.appManifestUrl)
  ]);
  return {
    vodEnabled: cfg.vod.enabled,
    metadata,
    streams: streamsWeb,
    streamsWeb,
    streamsApp
  };
}

async function probe(options = {}) {
  assertVodEnabled();

  let type = options.type ? validStremioType(options.type) : '';
  let id = options.id ? cleanId(options.id) : '';
  let title = '';
  let catalogName = '';
  let catalogId = '';

  if (!id) {
    const descriptors = await clientFor('metadata').catalogDescriptors();
    const candidateCatalogs = descriptors.filter(cat =>
      ['movie', 'series'].includes(cat.type) &&
      Array.isArray(cat.requiredExtras) &&
      cat.requiredExtras.length === 0
    );

    for (const descriptor of candidateCatalogs.slice(0, 12)) {
      try {
        const response = await clientFor('metadata').catalog(descriptor.type, descriptor.id, {});
        const rows = response && Array.isArray(response.metas) ? response.metas
          : response && Array.isArray(response.metasDetailed) ? response.metasDetailed
          : [];
        const picked = rows.find(row => row && row.id);
        if (!picked) continue;
        type = validStremioType(picked.type || descriptor.type);
        id = cleanId(picked.id);
        title = String(picked.name || picked.title || '').slice(0, 200);
        catalogName = String(descriptor.name || descriptor.id).slice(0, 120);
        catalogId = String(descriptor.id).slice(0, 200);
        break;
      } catch (_) {
        // Try the next directly-loadable catalog. One broken upstream catalog
        // must not make the whole service probe fail.
      }
    }
  }

  if (!id || !type) {
    const err = new Error('AIOMetadata did not return a probeable movie or series.');
    err.statusCode = 502;
    err.code = 'NO_PROBE_TITLE';
    throw err;
  }

  const metaResponse = await clientFor('metadata').meta(type, id);
  const meta = metaResponse && metaResponse.meta ? metaResponse.meta : null;
  if (!meta) {
    const err = new Error('AIOMetadata returned no metadata for the probe title.');
    err.statusCode = 502;
    err.code = 'PROBE_META_EMPTY';
    throw err;
  }

  const streamClient = clientFor('streams');
  const streamResponse = await streamClient.streams(type, id);
  const rawStreams = streamResponse && Array.isArray(streamResponse.streams)
    ? streamResponse.streams
    : [];
  const playable = rawStreams
    .map(row => privatePlaybackRow(row, streamClient))
    .filter(Boolean);

  return {
    ok: playable.length > 0,
    content: {
      type,
      id,
      title: String(meta.name || meta.title || title || '').slice(0, 200)
    },
    discovery: {
      catalogId,
      catalogName
    },
    metadata: {
      ok: true,
      hasVideos: Array.isArray(meta.videos) && meta.videos.length > 0
    },
    streams: {
      returned: rawStreams.length,
      playable: playable.length,
      opaqueCompatible: playable.length > 0
    }
  };
}

async function playbackCandidates(type, id, clientKind = 'web') {
  const safeType = validStremioType(type);
  const safeId = cleanId(id);
  const client = clientFor('streams', clientKind === 'app' ? 'app' : 'web');
  const response = await client.streams(safeType, safeId);
  const rows = response && Array.isArray(response.streams) ? response.streams : [];
  const max = Math.max(1, Math.min(50, Number(process.env.VOD_PLAYBACK_CANDIDATE_LIMIT) || 20));
  const candidates = rows.map(row => privatePlaybackRow(row, client)).filter(Boolean);
  // Prefer sources Safari can direct-play first, then sources that only need
  // repackaging/audio conversion. Preserve AIOStreams order inside each tier.
  const compatibilityRank = row => {
    const meta = row.playbackMeta || {};
    if (meta.container === 'hls') return 0;
    const video = String(meta.codec || '').toUpperCase();
    const audio = String(meta.audio || '').toUpperCase();
    const container = String(meta.container || '').toLowerCase();
    const videoNative = !video || video === 'H264' || video === 'HEVC';
    const audioNative = !audio || /(?:AAC|DD\+|DD)(?:\s|\/|$)/.test(audio);
    if ((container === 'mp4' || container === 'm4v') && videoNative && audioNative) return 1;
    if (videoNative && audioNative) return 2;
    if (videoNative) return 3;
    return 4;
  };
  return candidates
    .map((row, index) => ({ row, index, rank:compatibilityRank(row) }))
    .sort((a,b) => a.rank - b.rank || a.index - b.index)
    .slice(0, max)
    .map(item => item.row);
}

async function refreshAioStreams() {
  const cfg = appServices._privateConfig();
  const targets = [
    ['web', cfg.streams.webManifestUrl],
    ['app', cfg.streams.appManifestUrl]
  ];

  for (const key of [...clients.keys()]) {
    if (key.startsWith('streams|')) clients.delete(key);
  }

  const results = {};
  for (const [kind, manifestUrl] of targets) {
    if (!manifestUrl) {
      results[kind] = { configured: false, refreshed: false };
      continue;
    }

    try {
      const client = new StremioServiceClient(manifestUrl, {
        serviceName: 'AIOStreams (' + kind + ')'
      });
      const manifest = await client.manifest({ force: true });
      clients.set('streams|' + kind + '|' + manifestUrl, client);
      results[kind] = {
        configured: true,
        refreshed: true,
        id: String(manifest.id || ''),
        name: String(manifest.name || ''),
        version: String(manifest.version || ''),
        fingerprint: appServices._manifestFingerprint(manifestUrl)
      };
    } catch (err) {
      results[kind] = {
        configured: true,
        refreshed: false,
        error: err && err.code ? String(err.code) : 'UPSTREAM_ERROR'
      };
    }
  }

  return {
    ok: Object.values(results).some(row => row && row.refreshed),
    clients: results
  };
}

module.exports = {
  catalogs,
  catalog,
  search,
  meta,
  playbackCandidates,
  refreshAioStreams,
  diagnostics,
  probe,
  validStremioType,
  _privatePlaybackRow: privatePlaybackRow,
  _clientFor: clientFor,
  _resetForTests() { clients.clear(); }
};

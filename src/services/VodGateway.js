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
  return { catalogs: await clientFor('metadata').catalogDescriptors() };
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

  return {
    url: direct,
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
  const [metadata, streams] = await Promise.all([
    diagnosticService('metadata', cfg.metadata.manifestUrl),
    diagnosticService('streams', cfg.streams.manifestUrl)
  ]);
  return {
    vodEnabled: cfg.vod.enabled,
    metadata,
    streams
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
  return rows.map(row => privatePlaybackRow(row, client)).filter(Boolean).slice(0, max);
}

module.exports = {
  catalogs,
  catalog,
  search,
  meta,
  playbackCandidates,
  diagnostics,
  probe,
  validStremioType,
  _privatePlaybackRow: privatePlaybackRow,
  _clientFor: clientFor,
  _resetForTests() { clients.clear(); }
};

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

function clientFor(service) {
  const cfg = assertVodEnabled();
  const url = service === 'metadata' ? cfg.metadata.manifestUrl : cfg.streams.manifestUrl;
  const key = service + '|' + url;
  const existing = clients.get(key);
  if (existing) return existing;

  for (const cacheKey of clients.keys()) {
    if (cacheKey.startsWith(service + '|') && cacheKey !== key) clients.delete(cacheKey);
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

async function playbackCandidates(type, id) {
  const safeType = validStremioType(type);
  const safeId = cleanId(id);
  const client = clientFor('streams');
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
  validStremioType,
  _privatePlaybackRow: privatePlaybackRow,
  _clientFor: clientFor,
  _resetForTests() { clients.clear(); }
};

'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MANIFEST_TTL_MS = 60 * 1000;

class UpstreamServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'UpstreamServiceError';
    this.statusCode = options.statusCode || 502;
    this.upstreamStatus = options.upstreamStatus;
    this.code = options.code || 'UPSTREAM_ERROR';
  }
}

function normaliseManifestUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new UpstreamServiceError('Service manifest is not configured.', { statusCode: 503, code: 'NOT_CONFIGURED' });
  if (value.startsWith('stremio://')) value = 'https://' + value.slice('stremio://'.length);

  let url;
  try { url = new URL(value); }
  catch { throw new UpstreamServiceError('Configured service manifest URL is invalid.', { statusCode: 503, code: 'INVALID_MANIFEST_URL' }); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UpstreamServiceError('Configured service manifest must use HTTP or HTTPS.', { statusCode: 503, code: 'INVALID_MANIFEST_URL' });
  }
  if (!/\/manifest\.json$/i.test(url.pathname)) {
    throw new UpstreamServiceError('Configured service URL must point to manifest.json.', { statusCode: 503, code: 'INVALID_MANIFEST_URL' });
  }
  return url;
}

function cleanPart(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new UpstreamServiceError(`Invalid ${label}.`, { statusCode: 400, code: 'INVALID_RESOURCE' });
  }
  return text;
}

function encodeExtra(extra = {}) {
  const pairs = [];
  for (const [rawKey, rawValue] of Object.entries(extra)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const key = cleanPart(rawKey, 'extra key').slice(0, 64);
    const value = cleanPart(rawValue, 'extra value').slice(0, 1000);
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    if (pairs.length >= 16) break;
  }
  return pairs.join('&');
}

function requestAuth(url, headers) {
  if (!url.username && !url.password) return;
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  headers.Authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  url.username = '';
  url.password = '';
}

async function fetchJson(urlInput, options = {}) {
  const url = new URL(urlInput.toString());
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'AIOSportLite/1.6 VOD-Gateway',
    ...(options.headers || {})
  };
  requestAuth(url, headers);

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new UpstreamServiceError('Upstream service timed out.', { statusCode: 504, code: 'UPSTREAM_TIMEOUT' });
    }
    throw new UpstreamServiceError('Could not reach upstream service.', { statusCode: 502, code: 'UPSTREAM_UNREACHABLE' });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_) {}
    throw new UpstreamServiceError('Upstream service returned an error.', {
      statusCode: response.status === 404 ? 404 : 502,
      upstreamStatus: response.status,
      code: 'UPSTREAM_HTTP_ERROR'
    });
  }

  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch (_) {}
    throw new UpstreamServiceError('Upstream response was too large.', { statusCode: 502, code: 'UPSTREAM_TOO_LARGE' });
  }

  let text;
  try { text = await response.text(); }
  catch { throw new UpstreamServiceError('Could not read upstream response.', { statusCode: 502, code: 'UPSTREAM_READ_ERROR' }); }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new UpstreamServiceError('Upstream response was too large.', { statusCode: 502, code: 'UPSTREAM_TOO_LARGE' });
  }

  try { return JSON.parse(text); }
  catch { throw new UpstreamServiceError('Upstream service returned invalid JSON.', { statusCode: 502, code: 'UPSTREAM_INVALID_JSON' }); }
}

class StremioServiceClient {
  constructor(manifestUrl, options = {}) {
    this.serviceName = options.serviceName || 'Stremio service';
    this.manifestUrl = normaliseManifestUrl(manifestUrl);
    this.timeoutMs = Number(options.timeoutMs || process.env.VOD_UPSTREAM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.maxBytes = Number(options.maxBytes || process.env.VOD_UPSTREAM_MAX_BYTES) || DEFAULT_MAX_BYTES;
    this.manifestTtlMs = Number(options.manifestTtlMs || process.env.VOD_MANIFEST_TTL_MS) || DEFAULT_MANIFEST_TTL_MS;
    this._manifestCache = null;
  }

  resourceUrl(resource, type, id, extra) {
    const safeResource = cleanPart(resource, 'resource');
    const safeType = cleanPart(type, 'type');
    const safeId = cleanPart(id, 'id');
    const out = new URL(this.manifestUrl.toString());
    const prefix = out.pathname.replace(/\/manifest\.json$/i, '');
    const suffix = safeResource === 'catalog' ? encodeExtra(extra) : '';
    out.pathname =
      prefix +
      '/' + encodeURIComponent(safeResource) +
      '/' + encodeURIComponent(safeType) +
      '/' + encodeURIComponent(safeId) +
      (suffix ? '/' + suffix : '') +
      '.json';
    return out;
  }

  absolutizePlaybackUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let url;
    try { url = new URL(raw, this.manifestUrl.origin); }
    catch { return ''; }
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  }

  async _get(url) {
    return fetchJson(url, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes });
  }

  async manifest(options = {}) {
    const now = Date.now();
    if (!options.force && this._manifestCache && now - this._manifestCache.at < this.manifestTtlMs) {
      return this._manifestCache.value;
    }
    const value = await this._get(this.manifestUrl);
    if (!value || typeof value !== 'object' || !Array.isArray(value.catalogs)) {
      throw new UpstreamServiceError(this.serviceName + ' manifest is not a valid Stremio manifest.', {
        statusCode: 502,
        code: 'INVALID_MANIFEST'
      });
    }
    this._manifestCache = { at: now, value };
    return value;
  }

  async catalog(type, id, extra = {}) {
    return this._get(this.resourceUrl('catalog', type, id, extra));
  }

  async meta(type, id) {
    return this._get(this.resourceUrl('meta', type, id));
  }

  async streams(type, id) {
    return this._get(this.resourceUrl('stream', type, id));
  }

  async catalogDescriptors() {
    const manifest = await this.manifest();
    return (manifest.catalogs || []).map(cat => {
      const extras = Array.isArray(cat.extra) ? cat.extra : [];
      const requiredExtras = extras.filter(x => x && x.isRequired).map(x => String(x.name || '')).filter(Boolean);
      const search = extras.find(x => x && x.name === 'search');
      const genre = extras.find(x => x && x.name === 'genre');
      const skip = extras.find(x => x && x.name === 'skip');
      return {
        id: String(cat.id || ''),
        type: String(cat.type || ''),
        name: String(cat.name || cat.id || ''),
        requiredExtras,
        searchable: !!search,
        supportsSkip: !!skip,
        genres: genre && Array.isArray(genre.options) ? genre.options.map(String) : []
      };
    }).filter(cat => cat.id && cat.type);
  }

  async search(query, type) {
    const q = String(query || '').trim();
    if (!q) return { metas: [] };
    const manifest = await this.manifest();
    const maxCatalogs = Math.max(1, Math.min(50, Number(process.env.VOD_SEARCH_CATALOG_LIMIT) || 20));
    const catalogs = (manifest.catalogs || []).filter(cat => {
      if (!cat || !cat.id || !cat.type) return false;
      if (type && String(cat.type) !== String(type)) return false;
      const extras = Array.isArray(cat.extra) ? cat.extra : [];
      const required = extras.filter(x => x && x.isRequired).map(x => x.name);
      if (!extras.some(x => x && x.name === 'search')) return false;
      return required.every(name => name === 'search');
    }).slice(0, maxCatalogs);

    const settled = await Promise.allSettled(
      catalogs.map(cat => this.catalog(cat.type, cat.id, { search: q }))
    );

    const seen = new Set();
    const metas = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status !== 'fulfilled') continue;
      const body = result.value || {};
      const rows = Array.isArray(body.metas) ? body.metas
        : Array.isArray(body.metasDetailed) ? body.metasDetailed
        : [];
      for (const meta of rows) {
        if (!meta || !meta.id) continue;
        const metaType = String(meta.type || catalogs[i].type || '');
        const key = metaType + ':' + String(meta.id);
        if (seen.has(key)) continue;
        seen.add(key);
        metas.push(meta);
      }
    }
    return { metas };
  }
}

module.exports = {
  StremioServiceClient,
  UpstreamServiceError,
  _normaliseManifestUrl: normaliseManifestUrl,
  _encodeExtra: encodeExtra,
  _fetchJson: fetchJson
};

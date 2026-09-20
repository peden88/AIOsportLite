'use strict';

const appServices = require('./AppServiceRegistry');
const opaquePlayback = require('./OpaquePlayback');

const FETCH_TIMEOUT_MS = Number(process.env.VOD_STREAM_LOOKUP_TIMEOUT_MS) || 30000;

function addonRoot(manifestUrl) {
  const raw = String(manifestUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const suffix = '/manifest.json';
    if (!url.pathname.endsWith(suffix)) return '';
    url.pathname = url.pathname.slice(0, -suffix.length);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function stremioType(contentType, explicit) {
  const given = String(explicit || '').trim().toLowerCase();
  if (given === 'movie' || given === 'series') return given;
  const type = String(contentType || '').trim().toLowerCase();
  if (type === 'movie') return 'movie';
  if (type === 'series' || type === 'episode') return 'series';
  // Anime may be either a movie or a series. AIOMetadata should pass through
  // the canonical Stremio type rather than guessing from an anime label.
  if (type === 'anime') return '';
  return '';
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error(`AIOStreams returned HTTP ${res.status}.`);
      err.statusCode = 502;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve VOD through the ONE installation-wide AIOStreams manifest.
 *
 * AIOStreams returns its already-ranked rows. We preserve that order and hand
 * only the first row to the client. Its owned playback URL carries AIOStreams'
 * failover behaviour; remaining rows stay only in this server-side session as
 * a final recovery layer if the selected playback path itself later dies.
 */
async function startVodPlayback({ contentType, id, stremioType: explicitType }) {
  const manifest = appServices.manifestUrl('streams');
  const root = addonRoot(manifest);
  if (!root) {
    const err = new Error('AIOStreams is not configured.');
    err.statusCode = 503;
    throw err;
  }

  const type = stremioType(contentType, explicitType);
  if (!type) {
    const err = new Error('A canonical Stremio type (movie or series) is required.');
    err.statusCode = 400;
    throw err;
  }

  const contentId = String(id || '').trim();
  if (!contentId) {
    const err = new Error('Missing VOD content id.');
    err.statusCode = 400;
    throw err;
  }

  const url = `${root}/stream/${encodeURIComponent(type)}/${encodeURIComponent(contentId)}.json`;
  const payload = await fetchJson(url);
  const rows = payload && Array.isArray(payload.streams) ? payload.streams : [];
  return opaquePlayback.startResolvedPlayback('vod', `${type}:${contentId}`, rows);
}

module.exports = {
  startVodPlayback,
  _addonRoot: addonRoot,
  _stremioType: stremioType
};

/* AIOPlay shared client data layer.
 * Centralises request cancellation, in-flight coalescing, TTL caching,
 * stale-while-revalidate support, persistent snapshots and canonical IDs.
 * Deliberately framework-free so the existing UI can migrate incrementally.
 */
(() => {
  'use strict';

  const memory = new Map();
  const inFlight = new Map();
  const controllers = new Map();
  const SNAPSHOT_PREFIX = 'aioplay.snapshot.v1:';

  const now = () => Date.now();
  const safeJsonParse = value => {
    try { return JSON.parse(value); } catch (_) { return null; }
  };

  function canonicalMediaKey(item, fallbackType = '') {
    if (!item) return '';
    const type = String(item.type || item.contentType || fallbackType || 'media').toLowerCase().replace('tv', 'series');
    const ids = item.ids || item.externalIds || {};
    const imdb = item.imdbId || item.imdb_id || ids.imdb;
    const tmdb = item.tmdbId || item.tmdb_id || ids.tmdb;
    const kitsu = item.kitsuId || item.kitsu_id || ids.kitsu;
    const raw = item.contentId || item.id || item.videoId;
    if (imdb) return type + ':imdb:' + String(imdb).toLowerCase();
    if (tmdb) return type + ':tmdb:' + String(tmdb);
    if (kitsu) return type + ':kitsu:' + String(kitsu);
    if (raw) return type + ':id:' + String(raw).toLowerCase();
    const name = String(item.name || item.title || '').trim().toLowerCase();
    const year = String(item.year || item.releaseInfo || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
    return name ? type + ':name:' + name + ':' + year : '';
  }

  function canonicalPersonKey(person) {
    if (!person) return '';
    const tmdb = person.tmdbId || person.tmdb_id || person.id;
    if (tmdb && /^\d+$/.test(String(tmdb))) return 'person:tmdb:' + String(tmdb);
    const imdb = person.imdbId || person.imdb_id;
    if (imdb) return 'person:imdb:' + String(imdb).toLowerCase();
    const name = String(person.name || person.title || person).trim().toLowerCase();
    return name ? 'person:name:' + name : '';
  }

  function dedupe(items, keyFn = canonicalMediaKey) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(item => {
      const key = keyFn(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getMemory(key, { ttl = 0, staleTime = Infinity } = {}) {
    const row = memory.get(key);
    if (!row) return null;
    const age = now() - row.at;
    return { value: row.value, age, fresh: !ttl || age < ttl, usable: age < staleTime };
  }

  function setMemory(key, value) {
    memory.set(key, { at: now(), value });
    return value;
  }

  function abortGroup(group) {
    if (!group) return;
    const controller = controllers.get(group);
    if (controller) controller.abort();
    controllers.delete(group);
  }

  async function requestJson(url, options = {}) {
    const {
      key = String(url),
      ttl = 0,
      staleTime = Infinity,
      staleWhileRevalidate = false,
      group = '',
      cancelPrevious = false,
      cache = true,
      fetchOptions = {},
      transform = value => value
    } = options;

    const cached = cache ? getMemory(key, { ttl, staleTime }) : null;
    if (cached?.fresh) return cached.value;

    const execute = async () => {
      if (cancelPrevious && group) abortGroup(group);
      const controller = new AbortController();
      if (group) controllers.set(group, controller);
      const externalSignal = fetchOptions.signal;
      let detach = null;
      if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else {
          const forward = () => controller.abort();
          externalSignal.addEventListener('abort', forward, { once:true });
          detach = () => externalSignal.removeEventListener('abort', forward);
        }
      }
      try {
        const response = await fetch(url, { ...fetchOptions, signal:controller.signal });
        if (!response.ok) {
          const error = new Error('HTTP ' + response.status + ' for ' + url);
          error.status = response.status;
          throw error;
        }
        const value = transform(await response.json());
        if (cache) setMemory(key, value);
        return value;
      } finally {
        detach?.();
        if (group && controllers.get(group) === controller) controllers.delete(group);
      }
    };

    if (cached?.usable && staleWhileRevalidate) {
      if (!inFlight.has(key)) {
        const background = execute().catch(() => cached.value).finally(() => inFlight.delete(key));
        inFlight.set(key, background);
      }
      return cached.value;
    }

    if (inFlight.has(key)) return inFlight.get(key);
    const request = execute().finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  }

  function saveSnapshot(name, value, maxAge = 24 * 60 * 60 * 1000) {
    try {
      localStorage.setItem(SNAPSHOT_PREFIX + name, JSON.stringify({ at:now(), maxAge, value }));
      return true;
    } catch (_) { return false; }
  }

  function loadSnapshot(name) {
    try {
      const row = safeJsonParse(localStorage.getItem(SNAPSHOT_PREFIX + name));
      if (!row || !row.at || now() - row.at > Number(row.maxAge || 0)) return null;
      return row.value;
    } catch (_) { return null; }
  }

  function clearSnapshot(name) {
    try { localStorage.removeItem(SNAPSHOT_PREFIX + name); } catch (_) {}
  }

  window.AIOData = Object.freeze({
    requestJson,
    abortGroup,
    canonicalMediaKey,
    canonicalPersonKey,
    dedupe,
    getMemory,
    setMemory,
    saveSnapshot,
    loadSnapshot,
    clearSnapshot
  });
})();
'use strict';

const crypto = require('crypto');
const { handleStream } = require('../streams');

// Playback alternatives remain server-side. The client receives exactly one
// target at a time and can only ask for the next candidate after a playback
// failure. This keeps source/provider selection out of the user experience.
const SESSION_TTL_MS = Number(process.env.PLAYBACK_SESSION_TTL_MS) || 15 * 60 * 1000;
const MAX_SESSIONS = Number(process.env.PLAYBACK_SESSION_LIMIT) || 1000;
const sessions = new Map();

function now() {
  return Date.now();
}

function cleanup() {
  const cutoff = now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= cutoff) sessions.delete(id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const oldest = [...sessions.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, sessions.size - MAX_SESSIONS);
  for (const [id] of oldest) sessions.delete(id);
}

function opaqueTarget(row) {
  if (!row) return null;
  const direct = typeof row.url === 'string' && row.url.trim();
  const external = typeof row.externalUrl === 'string' && row.externalUrl.trim();
  if (!direct && !external) return null;

  const requestHeaders = row.behaviorHints &&
    row.behaviorHints.proxyHeaders &&
    row.behaviorHints.proxyHeaders.request &&
    typeof row.behaviorHints.proxyHeaders.request === 'object'
      ? { ...row.behaviorHints.proxyHeaders.request }
      : undefined;

  return {
    kind: direct ? 'direct' : 'external',
    url: direct || external,
    ...(row.downloadMeta ? { downloadMeta: { ...row.downloadMeta } } : {}),
    ...(requestHeaders && Object.keys(requestHeaders).length ? { requestHeaders } : {})
  };
}

function publicResult(sessionId, target) {
  if (!target) {
    return {
      ok: false,
      exhausted: true,
      sessionId
    };
  }
  return {
    ok: true,
    exhausted: false,
    sessionId,
    playback: target
  };
}

function normaliseSportsId(matchId) {
  const suppliedId = String(matchId || '').trim();
  if (!suppliedId) return '';
  return suppliedId.startsWith('nuvio_sport_')
    ? suppliedId.slice('nuvio_sport_'.length)
    : suppliedId;
}

function startOpaquePlayback(kind, contentId, rows) {
  cleanup();
  const targets = (Array.isArray(rows) ? rows : []).map(opaqueTarget).filter(Boolean);

  if (!targets.length) {
    return {
      ok: false,
      exhausted: true,
      reason: 'NO_PLAYABLE_STREAM'
    };
  }

  const sessionId = crypto.randomUUID();
  const createdAt = now();
  const session = {
    kind: String(kind || 'unknown'),
    contentId: String(contentId || ''),
    targets,
    cursor: 1,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS
  };
  sessions.set(sessionId, session);
  cleanup();
  return publicResult(sessionId, targets[0]);
}

async function startSportsPlayback(matchId, config) {
  const rawId = normaliseSportsId(matchId);
  if (!rawId) throw Object.assign(new Error('Missing sports event id.'), { statusCode: 400 });

  const result = await handleStream('tv', `nuvio_sport_${rawId}`, config || {});
  return startOpaquePlayback(
    'sport',
    rawId,
    result && Array.isArray(result.streams) ? result.streams : []
  );
}

function nextPlayback(sessionId) {
  cleanup();
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) {
    return {
      ok: false,
      exhausted: true,
      reason: 'PLAYBACK_SESSION_EXPIRED'
    };
  }

  const target = session.targets[session.cursor] || null;
  if (!target) {
    sessions.delete(id);
    return publicResult(id, null);
  }

  session.cursor += 1;
  session.expiresAt = now() + SESSION_TTL_MS;
  return publicResult(id, target);
}

function currentTarget(sessionId) {
  cleanup();
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) return null;
  const index = Math.max(0, session.cursor - 1);
  session.expiresAt = now() + SESSION_TTL_MS;
  return session.targets[index] || null;
}

function downloadCandidates(sessionId) {
  cleanup();
  const session = sessions.get(String(sessionId || '').trim());
  if (!session) return [];
  session.expiresAt = now() + SESSION_TTL_MS;
  return session.targets.map((target, index) => ({
    index,
    meta: target.downloadMeta ? { ...target.downloadMeta } : {}
  }));
}

function targetAt(sessionId, index) {
  cleanup();
  const session = sessions.get(String(sessionId || '').trim());
  const i = Number(index);
  if (!session || !Number.isInteger(i) || i < 0 || i >= session.targets.length) return null;
  session.expiresAt = now() + SESSION_TTL_MS;
  return session.targets[i] || null;
}

function finishPlayback(sessionId) {
  return sessions.delete(String(sessionId || '').trim());
}

function status() {
  cleanup();
  return {
    active: sessions.size,
    ttlMs: SESSION_TTL_MS,
    limit: MAX_SESSIONS
  };
}

module.exports = {
  startSportsPlayback,
  startOpaquePlayback,
  nextPlayback,
  currentTarget,
  downloadCandidates,
  targetAt,
  finishPlayback,
  status,
  _opaqueTarget: opaqueTarget,
  _normaliseSportsId: normaliseSportsId,
  _cleanup: cleanup,
  _sessions: sessions
};

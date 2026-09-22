'use strict';

const crypto = require('crypto');

const LEASE_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.PLAYBACK_LEASE_TTL_MS) || 90 * 1000
);
const leases = new Map();

function now() {
  return Date.now();
}

function clampLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(3, Math.trunc(n))) : 1;
}

function cleanup() {
  const t = now();
  for (const [id, lease] of leases) {
    if (lease.expiresAt <= t) leases.delete(id);
  }
}

function activeForUser(userId) {
  cleanup();
  return [...leases.values()]
    .filter(lease => lease.userId === userId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

function acquire({
  user,
  authSession,
  client = 'web',
  contentType = '',
  contentId = '',
  title = '',
  parentId = '',
  seriesTitle = '',
  season = null,
  episode = null,
  episodeTitle = ''
} = {}) {
  if (!user || !user.id) return null;
  cleanup();

  const limit = clampLimit(user.maxConcurrentStreams);
  const active = activeForUser(user.id);
  if (active.length >= limit) {
    const err = new Error(
      limit === 1
        ? 'This account already has an active stream.'
        : 'This account is already using all ' + limit + ' allowed streams.'
    );
    err.code = 'STREAM_LIMIT_REACHED';
    err.statusCode = 409;
    err.limit = limit;
    err.active = active.length;
    throw err;
  }

  const startedAt = now();
  const lease = {
    id: crypto.randomUUID(),
    userId: user.id,
    username: String(user.username || ''),
    displayName: String(user.displayName || user.username || ''),
    maxConcurrentStreams: limit,
    authSessionId: authSession && authSession.id ? String(authSession.id) : '',
    deviceName: authSession && authSession.deviceName
      ? String(authSession.deviceName)
      : (client === 'app' ? 'TV app' : 'Web browser'),
    client: client === 'app' ? 'app' : 'web',
    contentType: String(contentType || ''),
    contentId: String(contentId || ''),
    title: String(title || '').slice(0, 240),
    parentId: String(parentId || '').slice(0, 240),
    seriesTitle: String(seriesTitle || '').slice(0, 240),
    season: season !== null && season !== undefined && season !== '' && Number.isFinite(Number(season))
      ? Math.trunc(Number(season))
      : null,
    episode: episode !== null && episode !== undefined && episode !== '' && Number.isFinite(Number(episode))
      ? Math.trunc(Number(episode))
      : null,
    episodeTitle: String(episodeTitle || '').slice(0, 240),
    playbackSessionId: '',
    startedAt,
    lastSeenAt: startedAt,
    expiresAt: startedAt + LEASE_TTL_MS
  };
  leases.set(lease.id, lease);
  return { ...lease };
}

function bind(leaseId, playbackSessionId) {
  cleanup();
  const lease = leases.get(String(leaseId || ''));
  if (!lease) return false;
  lease.playbackSessionId = String(playbackSessionId || '');
  lease.lastSeenAt = now();
  lease.expiresAt = lease.lastSeenAt + LEASE_TTL_MS;
  return true;
}

function bySession(playbackSessionId) {
  cleanup();
  const id = String(playbackSessionId || '');
  if (!id) return null;
  for (const lease of leases.values()) {
    if (lease.playbackSessionId === id) return lease;
  }
  return null;
}

function touchLease(leaseId) {
  cleanup();
  const lease = leases.get(String(leaseId || ''));
  if (!lease) return false;
  lease.lastSeenAt = now();
  lease.expiresAt = lease.lastSeenAt + LEASE_TTL_MS;
  return true;
}

function touchSession(playbackSessionId, userId) {
  const lease = bySession(playbackSessionId);
  if (!lease) return false;
  if (userId && lease.userId !== userId) return false;
  return touchLease(lease.id);
}

function releaseLease(leaseId) {
  return leases.delete(String(leaseId || ''));
}

function releaseSession(playbackSessionId) {
  const lease = bySession(playbackSessionId);
  return lease ? leases.delete(lease.id) : false;
}

function releaseUser(userId) {
  cleanup();
  let released = 0;
  for (const [id, lease] of leases) {
    if (lease.userId === userId) {
      leases.delete(id);
      released++;
    }
  }
  return released;
}

function releaseAuthSession(authSessionId) {
  cleanup();
  let released = 0;
  const target = String(authSessionId || '');
  if (!target) return 0;
  for (const [id, lease] of leases) {
    if (lease.authSessionId === target) {
      leases.delete(id);
      released++;
    }
  }
  return released;
}

function enforceLimit(userId, limit) {
  const safeLimit = clampLimit(limit);
  const active = activeForUser(userId);
  const excess = active.slice(safeLimit);
  for (const lease of excess) leases.delete(lease.id);
  return excess.map(lease => ({
    id: lease.id,
    playbackSessionId: lease.playbackSessionId
  }));
}

function isLeaseActive(leaseId) {
  cleanup();
  return leases.has(String(leaseId || ''));
}

function listActive() {
  cleanup();
  return [...leases.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(lease => ({
      id: lease.id,
      userId: lease.userId,
      username: lease.username,
      displayName: lease.displayName,
      maxConcurrentStreams: lease.maxConcurrentStreams,
      client: lease.client,
      deviceName: lease.deviceName,
      contentType: lease.contentType,
      contentId: lease.contentId,
      title: lease.title,
      parentId: lease.parentId,
      seriesTitle: lease.seriesTitle,
      season: lease.season,
      episode: lease.episode,
      episodeTitle: lease.episodeTitle,
      playbackSessionId: lease.playbackSessionId,
      startedAt: lease.startedAt,
      lastSeenAt: lease.lastSeenAt,
      expiresAt: lease.expiresAt
    }));
}

function status() {
  const active = listActive();
  const byUser = {};
  for (const lease of active) {
    byUser[lease.userId] = (byUser[lease.userId] || 0) + 1;
  }
  return {
    active: active.length,
    ttlMs: LEASE_TTL_MS,
    byUser,
    streams: active
  };
}

module.exports = {
  LEASE_TTL_MS,
  acquire,
  bind,
  touchLease,
  touchSession,
  leaseForSession: bySession,
  releaseLease,
  releaseSession,
  releaseUser,
  releaseAuthSession,
  enforceLimit,
  isLeaseActive,
  listActive,
  status,
  _activeForUser: activeForUser,
  _cleanup: cleanup,
  _leases: leases,
  _resetForTests() { leases.clear(); }
};

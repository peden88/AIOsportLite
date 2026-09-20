'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const USERS_FILE = path.join(DATA_DIR, 'app-users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'app-sessions.json');
const SESSION_TTL_MS = Number(process.env.APP_SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const MIN_PASSWORD_LENGTH = Number(process.env.APP_MIN_PASSWORD_LENGTH) || 10;
const SCRYPT_KEYLEN = 64;

let usersState = null;
let sessionsState = null;

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function users() {
  if (!usersState) {
    usersState = readJson(USERS_FILE, { version: 1, users: [] });
    if (!Array.isArray(usersState.users)) usersState.users = [];
  }
  return usersState;
}

function sessions() {
  if (!sessionsState) {
    sessionsState = readJson(SESSIONS_FILE, { version: 1, sessions: [] });
    if (!Array.isArray(sessionsState.sessions)) sessionsState.sessions = [];
  }
  cleanupSessions(false);
  return sessionsState;
}

function saveUsers() {
  atomicWrite(USERS_FILE, users());
}

function saveSessions() {
  atomicWrite(SESSIONS_FILE, sessionsState || { version: 1, sessions: [] });
}

function usernameKey(username) {
  return String(username || '').trim().toLowerCase();
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) {
    const err = new Error('Username must be 3-40 characters using letters, numbers, dot, underscore or hyphen.');
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) {
    const err = new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (value.length > 256) {
    const err = new Error('Password is too long.');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }
  return value;
}

function makePassword(password) {
  const value = validatePassword(password);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, SCRYPT_KEYLEN);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64')
  };
}

function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== 'scrypt' || !stored.salt || !stored.hash) return false;
  try {
    const want = Buffer.from(stored.hash, 'base64');
    const got = crypto.scryptSync(String(password || ''), Buffer.from(stored.salt, 'base64'), want.length);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (_) {
    return false;
  }
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role === 'admin' ? 'admin' : 'user',
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function listUsers() {
  return users().users
    .map(publicUser)
    .sort((a, b) => a.username.localeCompare(b.username));
}

function getUser(id) {
  return users().users.find(u => u.id === id) || null;
}

function getUserByUsername(username) {
  const key = usernameKey(username);
  return users().users.find(u => u.usernameKey === key) || null;
}

function createUser(input = {}) {
  const username = validateUsername(input.username);
  const key = usernameKey(username);
  if (getUserByUsername(username)) {
    const err = new Error('Username already exists.');
    err.code = 'USERNAME_EXISTS';
    throw err;
  }

  const role = input.role === 'admin' ? 'admin' : 'user';
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    username,
    usernameKey: key,
    displayName: String(input.displayName || username).trim().slice(0, 80) || username,
    role,
    enabled: input.enabled !== false,
    password: makePassword(input.password),
    createdAt: now,
    updatedAt: now
  };

  users().users.push(user);
  saveUsers();
  return publicUser(user);
}

function authenticate(username, password) {
  const user = getUserByUsername(username);
  if (!user || user.enabled === false) return null;
  if (!verifyPassword(password, user.password)) return null;
  return publicUser(user);
}

function enabledAdminCount() {
  return users().users.filter(u => u.enabled !== false && u.role === 'admin').length;
}

function updateUser(id, patch = {}) {
  const user = getUser(id);
  if (!user) return null;

  if (patch.username !== undefined) {
    const next = validateUsername(patch.username);
    const nextKey = usernameKey(next);
    const duplicate = users().users.find(u => u.id !== id && u.usernameKey === nextKey);
    if (duplicate) {
      const err = new Error('Username already exists.');
      err.code = 'USERNAME_EXISTS';
      throw err;
    }
    user.username = next;
    user.usernameKey = nextKey;
  }

  if (patch.displayName !== undefined) {
    user.displayName = String(patch.displayName || '').trim().slice(0, 80) || user.username;
  }

  if (patch.role !== undefined) {
    const nextRole = patch.role === 'admin' ? 'admin' : 'user';
    if (user.role === 'admin' && nextRole !== 'admin' && user.enabled !== false && enabledAdminCount() <= 1) {
      const err = new Error('Cannot remove the last enabled administrator.');
      err.code = 'LAST_ADMIN';
      throw err;
    }
    user.role = nextRole;
  }

  if (patch.enabled !== undefined) {
    const nextEnabled = !!patch.enabled;
    if (user.role === 'admin' && user.enabled !== false && !nextEnabled && enabledAdminCount() <= 1) {
      const err = new Error('Cannot disable the last enabled administrator.');
      err.code = 'LAST_ADMIN';
      throw err;
    }
    user.enabled = nextEnabled;
    if (!nextEnabled) revokeUserSessions(id);
  }

  if (patch.password !== undefined && String(patch.password) !== '') {
    user.password = makePassword(patch.password);
    revokeUserSessions(id);
  }

  user.updatedAt = new Date().toISOString();
  saveUsers();
  return publicUser(user);
}

function deleteUser(id) {
  const state = users();
  const i = state.users.findIndex(u => u.id === id);
  if (i === -1) return false;
  const user = state.users[i];
  if (user.role === 'admin' && user.enabled !== false && enabledAdminCount() <= 1) {
    const err = new Error('Cannot delete the last enabled administrator.');
    err.code = 'LAST_ADMIN';
    throw err;
  }
  state.users.splice(i, 1);
  saveUsers();
  revokeUserSessions(id);
  return true;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanupSessions(save = true) {
  if (!sessionsState) {
    sessionsState = readJson(SESSIONS_FILE, { version: 1, sessions: [] });
    if (!Array.isArray(sessionsState.sessions)) sessionsState.sessions = [];
  }
  const before = sessionsState.sessions.length;
  const at = Date.now();
  sessionsState.sessions = sessionsState.sessions.filter(s => Number(s.expiresAt) > at && !!getUser(s.userId));
  if (save && sessionsState.sessions.length !== before) saveSessions();
}

function createSession(userId, options = {}) {
  const user = getUser(userId);
  if (!user || user.enabled === false) {
    const err = new Error('User is disabled or missing.');
    err.code = 'USER_DISABLED';
    throw err;
  }

  cleanupSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const at = Date.now();
  const session = {
    id: crypto.randomUUID(),
    userId,
    tokenHash: tokenHash(token),
    clientType: String(options.clientType || 'web').trim().slice(0, 24) || 'web',
    deviceName: String(options.deviceName || '').trim().slice(0, 80),
    createdAt: at,
    lastSeenAt: at,
    expiresAt: at + SESSION_TTL_MS
  };
  sessionsState.sessions.push(session);
  saveSessions();
  return {
    token,
    session: {
      id: session.id,
      clientType: session.clientType,
      deviceName: session.deviceName,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt
    }
  };
}

function resolveSession(token) {
  const hash = tokenHash(token);
  if (!token || !hash) return null;
  cleanupSessions();
  const session = sessionsState.sessions.find(s => s.tokenHash === hash);
  if (!session) return null;

  const user = getUser(session.userId);
  if (!user || user.enabled === false) return null;

  const at = Date.now();
  if (at - Number(session.lastSeenAt || 0) > 5 * 60 * 1000) {
    session.lastSeenAt = at;
    session.expiresAt = at + SESSION_TTL_MS;
    saveSessions();
  }

  return {
    user: publicUser(user),
    session: {
      id: session.id,
      clientType: session.clientType,
      deviceName: session.deviceName,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt
    }
  };
}

function revokeSessionToken(token) {
  if (!token) return false;
  cleanupSessions(false);
  const hash = tokenHash(token);
  const before = sessionsState.sessions.length;
  sessionsState.sessions = sessionsState.sessions.filter(s => s.tokenHash !== hash);
  if (sessionsState.sessions.length !== before) saveSessions();
  return sessionsState.sessions.length !== before;
}

function revokeSessionId(sessionId, userId) {
  cleanupSessions(false);
  const before = sessionsState.sessions.length;
  sessionsState.sessions = sessionsState.sessions.filter(s => !(s.id === sessionId && (!userId || s.userId === userId)));
  if (sessionsState.sessions.length !== before) saveSessions();
  return sessionsState.sessions.length !== before;
}

function revokeUserSessions(userId) {
  cleanupSessions(false);
  const before = sessionsState.sessions.length;
  sessionsState.sessions = sessionsState.sessions.filter(s => s.userId !== userId);
  if (sessionsState.sessions.length !== before) saveSessions();
  return before - sessionsState.sessions.length;
}

function listUserSessions(userId) {
  cleanupSessions();
  return sessionsState.sessions
    .filter(s => s.userId === userId)
    .map(s => ({
      id: s.id,
      clientType: s.clientType,
      deviceName: s.deviceName,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

function hasUsers() {
  return users().users.length > 0;
}

/**
 * One-time bootstrap only. Once the user database contains any account these
 * variables are ignored; changing them cannot silently change an existing
 * administrator's password.
 */
function bootstrapInitialAdmin() {
  if (hasUsers()) return null;
  const password = process.env.APP_ADMIN_PASSWORD || process.env.AUTH_KEY || '';
  if (!password) return null;
  const username = process.env.APP_ADMIN_USERNAME || 'admin';
  const displayName = process.env.APP_ADMIN_DISPLAY_NAME || 'Administrator';
  const created = createUser({ username, password, displayName, role: 'admin' });
  console.log(`[accounts] Created initial administrator "${created.username}".`);
  return created;
}

module.exports = {
  USERS_FILE,
  SESSIONS_FILE,
  MIN_PASSWORD_LENGTH,
  hasUsers,
  bootstrapInitialAdmin,
  listUsers,
  getUser,
  getUserByUsername,
  createUser,
  authenticate,
  updateUser,
  deleteUser,
  createSession,
  resolveSession,
  revokeSessionToken,
  revokeSessionId,
  revokeUserSessions,
  listUserSessions,
  publicUser,
  _makePassword: makePassword,
  _verifyPassword: verifyPassword,
  _usernameKey: usernameKey,
  _resetForTests() {
    usersState = null;
    sessionsState = null;
  }
};

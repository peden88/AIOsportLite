'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const USERS_FILE = path.join(DATA_DIR, 'app-users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'app-sessions.json');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const SESSION_TTL_MS = Number(process.env.APP_SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 });

let users = null;
let sessions = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function atomicWrite(file, value) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadUsers() {
  if (!users) {
    const data = readJson(USERS_FILE, { version: 1, users: [] });
    users = { version: 1, users: Array.isArray(data.users) ? data.users : [] };
  }
  return users;
}

function loadSessions() {
  if (!sessions) {
    const data = readJson(SESSIONS_FILE, { version: 1, sessions: [] });
    sessions = { version: 1, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
    cleanupSessions(false);
  }
  return sessions;
}

function saveUsers() {
  atomicWrite(USERS_FILE, loadUsers());
}

function saveSessions() {
  atomicWrite(SESSIONS_FILE, loadSessions());
}

function normaliseUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateUsername(value) {
  const username = normaliseUsername(value);
  if (!USERNAME_RE.test(username)) {
    const err = new Error('Username must be 3-32 characters using letters, numbers, dot, dash or underscore.');
    err.code = 'INVALID_USERNAME';
    throw err;
  }
  return username;
}

function cleanDisplayName(value, fallback) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return name || fallback;
}

function passwordOk(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256;
}

function scrypt(password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: params.maxmem || SCRYPT.maxmem
    }, (err, derived) => err ? reject(err) : resolve(derived));
  });
}

async function hashPassword(password) {
  if (!passwordOk(password)) {
    const err = new Error('Password must be between 8 and 256 characters.');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt);
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64url'),
    hash: derived.toString('base64url'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen
  };
}

async function verifyPassword(password, record) {
  if (!passwordOk(password) || !record || record.algorithm !== 'scrypt') return false;
  let salt, want;
  try {
    salt = Buffer.from(record.salt, 'base64url');
    want = Buffer.from(record.hash, 'base64url');
  } catch (_) {
    return false;
  }
  const got = await scrypt(password, salt, {
    N: Number(record.N) || SCRYPT.N,
    r: Number(record.r) || SCRYPT.r,
    p: Number(record.p) || SCRYPT.p,
    keylen: Number(record.keylen) || want.length,
    maxmem: SCRYPT.maxmem
  });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function normaliseConcurrentStreams(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(3, Math.trunc(parsed)));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    enabled: user.enabled !== false,
    maxConcurrentStreams: normaliseConcurrentStreams(user.maxConcurrentStreams, 1),
    createdAt: user.createdAt
  };
}

function findUserById(id) {
  return loadUsers().users.find(u => u.id === id) || null;
}

function findUserByUsername(username) {
  const name = normaliseUsername(username);
  return loadUsers().users.find(u => u.username === name) || null;
}

async function createUser({
  username,
  password,
  displayName,
  role = 'user',
  enabled = true,
  maxConcurrentStreams = 1
}) {
  const name = validateUsername(username);
  if (findUserByUsername(name)) {
    const err = new Error('Username already exists.');
    err.code = 'USERNAME_EXISTS';
    throw err;
  }
  const safeRole = role === 'admin' ? 'admin' : 'user';
  const user = {
    id: crypto.randomUUID(),
    username: name,
    displayName: cleanDisplayName(displayName, name),
    role: safeRole,
    enabled: enabled !== false,
    maxConcurrentStreams: normaliseConcurrentStreams(maxConcurrentStreams, 1),
    password: await hashPassword(password),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  loadUsers().users.push(user);
  saveUsers();
  return publicUser(user);
}

async function updateUser(id, patch = {}) {
  const user = findUserById(id);
  if (!user) return null;

  const nextRole = patch.role !== undefined ? (patch.role === 'admin' ? 'admin' : 'user') : user.role;
  const nextEnabled = patch.enabled !== undefined ? !!patch.enabled : user.enabled !== false;
  if ((!nextEnabled || nextRole !== 'admin') &&
      !loadUsers().users.some(u => u.id !== user.id && u.enabled !== false && u.role === 'admin')) {
    const err = new Error('At least one enabled administrator must remain.');
    err.code = 'LAST_ADMIN';
    throw err;
  }

  const nextPassword = patch.password !== undefined ? await hashPassword(patch.password) : null;
  if (patch.displayName !== undefined) user.displayName = cleanDisplayName(patch.displayName, user.username);
  if (patch.maxConcurrentStreams !== undefined) {
    user.maxConcurrentStreams = normaliseConcurrentStreams(patch.maxConcurrentStreams, 1);
  } else if (user.maxConcurrentStreams === undefined) {
    user.maxConcurrentStreams = 1;
  }
  user.enabled = nextEnabled;
  user.role = nextRole;
  if (nextPassword) user.password = nextPassword;
  user.updatedAt = new Date().toISOString();

  saveUsers();
  if (user.enabled === false) revokeUserSessions(user.id);
  return publicUser(user);
}

function listUsers() {
  return loadUsers().users.map(publicUser);
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function cleanupSessions(write = true) {
  const store = sessions || loadSessions();
  const before = store.sessions.length;
  const t = Date.now();
  store.sessions = store.sessions.filter(s => Number(s.expiresAt) > t && !!findUserById(s.userId));
  if (write && store.sessions.length !== before) saveSessions();
}

function issueSession(userId, { deviceName = '', kind = 'app' } = {}) {
  cleanupSessions();
  const user = findUserById(userId);
  if (!user || user.enabled === false) return null;

  const raw = crypto.randomBytes(32).toString('base64url');
  const createdAt = Date.now();
  const session = {
    id: crypto.randomUUID(),
    tokenHash: sessionHash(raw),
    userId,
    kind: kind === 'web' ? 'web' : 'app',
    deviceName: cleanDisplayName(deviceName, kind === 'web' ? 'Web browser' : 'TV app'),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt: createdAt + SESSION_TTL_MS
  };
  loadSessions().sessions.push(session);
  saveSessions();
  return { token: raw, expiresAt: session.expiresAt, user: publicUser(user) };
}

function tokenFromRequest(req, cookieName) {
  const auth = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (!cookieName) return '';
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === cookieName) return decodeURIComponent(v.join('='));
  }
  return '';
}

function authenticateToken(token) {
  if (!token) return null;
  cleanupSessions();
  const hash = sessionHash(token);
  const session = loadSessions().sessions.find(s => {
    const a = Buffer.from(s.tokenHash || '', 'utf8');
    const b = Buffer.from(hash, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user || user.enabled === false) return null;

  if (Date.now() - Number(session.lastSeenAt || 0) >= TOUCH_INTERVAL_MS) {
    session.lastSeenAt = Date.now();
    saveSessions();
  }
  return { user: publicUser(user), session };
}

function authenticateRequest(req, cookieName = 'als_session') {
  return authenticateToken(tokenFromRequest(req, cookieName));
}

async function login(username, password, options = {}) {
  // Always run scrypt once for an unknown username too, so account existence is
  // not exposed by a cheap-vs-expensive timing difference.
  const user = findUserByUsername(username);
  if (!user || user.enabled === false) {
    // Spend the same dominant cost as a real password check without first
    // generating another password hash (which would make unknown users slower).
    await scrypt(String(password || ''), Buffer.alloc(16));
    return null;
  }
  if (!(await verifyPassword(password, user.password))) return null;
  return issueSession(user.id, options);
}

function revokeToken(token) {
  if (!token) return false;
  const hash = sessionHash(token);
  const store = loadSessions();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(s => s.tokenHash !== hash);
  if (store.sessions.length !== before) saveSessions();
  return store.sessions.length !== before;
}

function revokeSessionById(sessionId, requestingUserId, isAdmin = false) {
  const store = loadSessions();
  const target = store.sessions.find(s => s.id === sessionId);
  if (!target || (!isAdmin && target.userId !== requestingUserId)) return false;
  store.sessions = store.sessions.filter(s => s.id !== sessionId);
  saveSessions();
  return true;
}

function revokeUserSessions(userId) {
  const store = loadSessions();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter(s => s.userId !== userId);
  if (store.sessions.length !== before) saveSessions();
  return before - store.sessions.length;
}

function listSessionsForUser(userId) {
  cleanupSessions();
  return loadSessions().sessions
    .filter(s => s.userId === userId)
    .map(s => ({
      id: s.id,
      kind: s.kind,
      deviceName: s.deviceName,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt
    }));
}

async function bootstrap() {
  if (loadUsers().users.length) return { created: false, users: loadUsers().users.length };

  const envUser = String(process.env.APP_ADMIN_USERNAME || '').trim();
  const envPass = String(process.env.APP_ADMIN_PASSWORD || '');
  if (envUser && envPass) {
    const user = await createUser({
      username: envUser,
      password: envPass,
      displayName: process.env.APP_ADMIN_DISPLAY_NAME || envUser,
      role: 'admin'
    });
    return { created: true, source: 'APP_ADMIN_PASSWORD', user };
  }

  // Seamless migration for an existing single-password install. The legacy
  // secret becomes the first admin's password; it can be changed immediately
  // through the user-management API without changing Stremio install profiles.
  const legacy = String(process.env.AUTH_KEY || '');
  if (legacy) {
    const user = await createUser({
      username: 'admin',
      password: legacy,
      displayName: 'Administrator',
      role: 'admin'
    });
    return { created: true, source: 'AUTH_KEY', user };
  }

  return { created: false, users: 0 };
}

function hasUsers() {
  return loadUsers().users.length > 0;
}

module.exports = {
  bootstrap,
  hasUsers,
  login,
  authenticateRequest,
  authenticateToken,
  tokenFromRequest,
  createUser,
  updateUser,
  listUsers,
  listSessionsForUser,
  revokeSessionById,
  revokeUserSessions,
  revokeToken,
  publicUser,
  _hashPassword: hashPassword,
  _verifyPassword: verifyPassword,
  _normaliseUsername: normaliseUsername,
  _normaliseConcurrentStreams: normaliseConcurrentStreams,
  _resetForTests() { users = null; sessions = null; },
  SESSION_TTL_MS
};

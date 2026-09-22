'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'aioplay-progress.json');
const MAX_ITEMS_PER_USER = Math.max(50, Number(process.env.AIOPLAY_PROGRESS_LIMIT) || 750);
const STARTED_THRESHOLD = 0.02;
const COMPLETED_THRESHOLD = 0.90;

let store = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    store = parsed && typeof parsed === 'object' ? parsed : { version: 1, users: {} };
  } catch (_) {
    store = { version: 1, users: {} };
  }
  if (!store.users || typeof store.users !== 'object') store.users = {};
  return store;
}

function save() {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function cleanString(value, max = 500) {
  const text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return text ? text.slice(0, max) : '';
}

function nullableString(value, max = 4096) {
  const text = cleanString(value, max);
  return text || null;
}

function nullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function safeLong(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed)));
}

function safePercent(value, position, duration) {
  const explicit = Number(value);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
  if (duration > 0) return Math.max(0, Math.min(100, (position / duration) * 100));
  return 0;
}

function normaliseType(value) {
  const type = cleanString(value, 24).toLowerCase();
  if (type === 'tv' || type === 'episode') return 'series';
  return type === 'series' ? 'series' : 'movie';
}

function itemKey(item) {
  const type = normaliseType(item.contentType);
  const contentId = cleanString(item.contentId, 512);
  const videoId = cleanString(item.videoId || contentId, 512);
  if (!contentId) return '';
  if (type === 'series') {
    const season = nullableInt(item.season);
    const episode = nullableInt(item.episode);
    if (season !== null && episode !== null) {
      return ['series', contentId, season, episode].join('|');
    }
    return ['series', contentId, 'video', videoId].join('|');
  }
  return ['movie', contentId].join('|');
}

function normaliseItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const contentId = cleanString(input.contentId, 512);
  const contentType = normaliseType(input.contentType);
  const videoId = cleanString(input.videoId || contentId, 512);
  const name = cleanString(input.name, 300);
  if (!contentId || !videoId || !name) return null;

  const position = safeLong(input.position);
  const duration = safeLong(input.duration);
  const lastWatched = safeLong(input.lastWatched, Date.now()) || Date.now();
  const progressPercent = safePercent(input.progressPercent, position, duration);

  return {
    contentId,
    contentType,
    name,
    poster: nullableString(input.poster),
    backdrop: nullableString(input.backdrop),
    logo: nullableString(input.logo),
    videoId,
    season: nullableInt(input.season),
    episode: nullableInt(input.episode),
    episodeTitle: nullableString(input.episodeTitle, 300),
    position,
    duration,
    lastWatched,
    progressPercent,
    source: cleanString(input.source, 80) || 'aioplay',
    updatedAt: Date.now()
  };
}

function userBucket(userId) {
  const id = cleanString(userId, 128);
  if (!id) throw new Error('Missing user id.');
  const root = load();
  if (!root.users[id] || typeof root.users[id] !== 'object') {
    root.users[id] = { items: {} };
  }
  if (!root.users[id].items || typeof root.users[id].items !== 'object') {
    root.users[id].items = {};
  }
  return root.users[id];
}

function prune(bucket) {
  const rows = Object.entries(bucket.items)
    .sort((a, b) => Number(b[1]?.lastWatched || 0) - Number(a[1]?.lastWatched || 0));
  if (rows.length <= MAX_ITEMS_PER_USER) return;
  bucket.items = Object.fromEntries(rows.slice(0, MAX_ITEMS_PER_USER));
}

function upsert(userId, inputs) {
  const bucket = userBucket(userId);
  const rows = Array.isArray(inputs) ? inputs : [inputs];
  let accepted = 0;
  let ignored = 0;

  for (const input of rows.slice(0, 500)) {
    const item = normaliseItem(input);
    if (!item) {
      ignored++;
      continue;
    }
    const key = itemKey(item);
    if (!key) {
      ignored++;
      continue;
    }
    const current = bucket.items[key];
    if (current && Number(current.lastWatched || 0) > item.lastWatched) {
      ignored++;
      continue;
    }
    bucket.items[key] = item;
    accepted++;
  }

  prune(bucket);
  if (accepted > 0) save();
  return { accepted, ignored };
}

function progressFraction(item) {
  const explicit = Number(item?.progressPercent);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(1, explicit / 100));
  const position = Number(item?.position || 0);
  const duration = Number(item?.duration || 0);
  return duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
}

function list(userId, { continueOnly = false } = {}) {
  const rows = Object.values(userBucket(userId).items)
    .filter(Boolean)
    .sort((a, b) => Number(b.lastWatched || 0) - Number(a.lastWatched || 0));

  if (!continueOnly) return rows;
  return rows.filter(item => {
    const fraction = progressFraction(item);
    return fraction >= STARTED_THRESHOLD && fraction < COMPLETED_THRESHOLD;
  });
}

module.exports = {
  list,
  upsert,
  itemKey,
  STARTED_THRESHOLD,
  COMPLETED_THRESHOLD,
  _resetForTests() { store = null; },
  _file: FILE
};

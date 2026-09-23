'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'aioplay-library.json');
const MAX_ITEMS_PER_USER = Math.max(100, Number(process.env.AIOPLAY_LIBRARY_LIMIT) || 2000);
let store = null;

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function load() {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    store = parsed && typeof parsed === 'object' ? parsed : { version: 1, users: {} };
  } catch (_) { store = { version: 1, users: {} }; }
  if (!store.users || typeof store.users !== 'object') store.users = {};
  return store;
}
function save() {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function text(value, max = 4096) {
  const v = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return v ? v.slice(0, max) : '';
}
function type(value) {
  const v = text(value, 24).toLowerCase();
  return v === 'series' || v === 'tv' ? 'series' : 'movie';
}
function key(item) { return type(item.type || item.contentType) + '|' + text(item.id || item.contentId, 512); }
function normalise(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = text(input.id || input.contentId, 512);
  const name = text(input.name || input.title, 300);
  if (!id || !name) return null;
  return {
    id, type: type(input.type || input.contentType), name,
    poster: text(input.poster) || null,
    background: text(input.background || input.backdrop) || null,
    logo: text(input.logo) || null,
    description: text(input.description, 4000) || null,
    releaseInfo: text(input.releaseInfo, 100) || null,
    runtime: text(input.runtime, 100) || null,
    imdbRating: Number.isFinite(Number(input.imdbRating)) ? Number(input.imdbRating) : null,
    genres: Array.isArray(input.genres) ? input.genres.map(v => text(v, 80)).filter(Boolean).slice(0, 20) : [],
    addedAt: Number(input.addedAt) || Date.now(),
    updatedAt: Date.now()
  };
}
function bucket(userId) {
  const id = text(userId, 128);
  if (!id) throw new Error('Missing user id.');
  const root = load();
  if (!root.users[id] || typeof root.users[id] !== 'object') root.users[id] = { items: {} };
  if (!root.users[id].items || typeof root.users[id].items !== 'object') root.users[id].items = {};
  return root.users[id].items;
}
function list(userId) { return Object.values(bucket(userId)).sort((a,b) => b.addedAt - a.addedAt); }
function add(userId, input) {
  const item = normalise(input);
  if (!item) return null;
  const items = bucket(userId);
  const k = key(item);
  const old = items[k];
  items[k] = { ...item, addedAt: old ? old.addedAt : item.addedAt };
  const ordered = Object.entries(items).sort((a,b) => b[1].addedAt - a[1].addedAt);
  for (const [drop] of ordered.slice(MAX_ITEMS_PER_USER)) delete items[drop];
  save();
  return items[k];
}
function remove(userId, itemType, itemId) {
  const items = bucket(userId);
  const k = type(itemType) + '|' + text(itemId, 512);
  const existed = Boolean(items[k]);
  if (existed) { delete items[k]; save(); }
  return existed;
}
module.exports = { list, add, remove };

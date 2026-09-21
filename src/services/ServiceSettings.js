'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const FILE = path.join(DATA_DIR, 'app-services.json');
let cache = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read() {
  if (cache) return { ...cache };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { version: 1, ...parsed }
      : { version: 1 };
  } catch (_) {
    cache = { version: 1 };
  }
  return { ...cache };
}

function write(next) {
  ensureDir();
  const value = { version: 1, ...(next && typeof next === 'object' ? next : {}) };
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch (_) {}
  cache = value;
  return read();
}

function has(key) {
  return Object.prototype.hasOwnProperty.call(read(), key);
}

function clearCache() {
  cache = null;
}

module.exports = {
  FILE,
  read,
  write,
  has,
  _clearCache: clearCache
};

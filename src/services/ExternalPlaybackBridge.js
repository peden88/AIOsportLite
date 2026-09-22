'use strict';

const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const playbackLeases = require('./PlaybackLeases');

const TOKEN_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.EXTERNAL_PLAYBACK_TTL_MS) || 30 * 60 * 1000
);
const MAX_TOKENS = Math.max(
  100,
  Number(process.env.EXTERNAL_PLAYBACK_TOKEN_LIMIT) || 2000
);

const tokens = new Map();

function now() {
  return Date.now();
}

function cleanup() {
  const cutoff = now();
  for (const [token, record] of tokens) {
    if (record.expiresAt <= cutoff) tokens.delete(token);
  }
  if (tokens.size <= MAX_TOKENS) return;
  const overflow = [...tokens.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, tokens.size - MAX_TOKENS);
  for (const [token] of overflow) tokens.delete(token);
}

function issue(target, options = {}) {
  if (!target || target.kind !== 'direct' || !target.url) return null;
  cleanup();
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = now();
  tokens.set(token, {
    target: {
      url: String(target.url),
      requestHeaders: target.requestHeaders && typeof target.requestHeaders === 'object'
        ? { ...target.requestHeaders }
        : {}
    },
    leaseId: String(options.leaseId || ''),
    createdAt,
    expiresAt: createdAt + TOKEN_TTL_MS
  });
  return {
    token,
    expiresAt: createdAt + TOKEN_TTL_MS
  };
}

function getRecord(token) {
  cleanup();
  const key = String(token || '').trim();
  if (!key) return null;
  const record = tokens.get(key);
  if (!record || record.expiresAt <= now()) {
    tokens.delete(key);
    return null;
  }
  return record;
}

function copyRequestHeaders(req, baseHeaders) {
  const headers = { ...(baseHeaders || {}) };
  const allowed = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
  for (const key of allowed) {
    const value = req.headers[key];
    if (typeof value === 'string' && value) headers[key] = value;
  }
  return headers;
}

function copyResponseHeaders(upstream, res) {
  const allowed = [
    'accept-ranges',
    'cache-control',
    'content-disposition',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified'
  ];
  for (const key of allowed) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

async function handle(req, res) {
  const record = getRecord(req.params.token);
  if (!record) return res.status(410).send('External playback link expired.');
  if (record.leaseId && !playbackLeases.touchLease(record.leaseId)) {
    return res.status(410).send('This account playback session is no longer active.');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });

  try {
    const upstream = await fetch(record.target.url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: copyRequestHeaders(req, record.target.requestHeaders),
      redirect: 'follow',
      signal: controller.signal
    });

    res.status(upstream.status);
    copyResponseHeaders(upstream, res);

    if (req.method === 'HEAD' || !upstream.body) {
      return res.end();
    }

    let lastLeaseTouch = Date.now();
    const guard = new Transform({
      transform(chunk, _enc, callback) {
        if (record.leaseId && Date.now() - lastLeaseTouch >= 20000) {
          lastLeaseTouch = Date.now();
          if (!playbackLeases.touchLease(record.leaseId)) {
            return callback(new Error('playback lease expired'));
          }
        }
        callback(null, chunk);
      }
    });

    Readable.fromWeb(upstream.body)
      .on('error', err => {
        if (!res.destroyed) res.destroy(err);
      })
      .pipe(guard)
      .on('error', err => {
        controller.abort();
        if (!res.destroyed) res.destroy(err);
      })
      .pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error('[external-playback] proxy failed:', err && err.message ? err.message : err);
    if (!res.headersSent) res.status(502).send('External playback source failed.');
    else if (!res.destroyed) res.destroy(err);
  }
}

function status() {
  cleanup();
  return {
    active: tokens.size,
    ttlMs: TOKEN_TTL_MS,
    limit: MAX_TOKENS
  };
}

module.exports = {
  issue,
  handle,
  status,
  _tokens: tokens,
  _cleanup: cleanup
};

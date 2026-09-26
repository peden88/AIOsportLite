/**
 * impitClient.js — Safe impit singleton with undici fallback
 *
 * impit is a native Rust/NAPI addon. On some architectures (ARM64 VPS,
 * Alpine/musl Linux, certain Windows Server builds) the native binary may fail
 * to load. This module wraps every call so a missing or broken impit
 * transparently falls back to undici — callers never need to worry about it.
 *
 * Usage:
 *   const { safeFetch } = require('./impitClient');
 *   const { ok, status, text } = await safeFetch(url, { headers, method });
 */

'use strict';

const { request: undiciRequest, Agent } = require('undici');

const { redactUrl } = require('./redact');
// -- Singleton -----------------------------------------------------------------
// undefined  = not yet probed
// null       = probed and unavailable (native binary missing / bad arch)
// Impit obj  = ready to use
let _impitInstance;

function getImpit() {
  if (_impitInstance !== undefined) return _impitInstance;
  try {
    const { Impit } = require('impit');
    _impitInstance = new Impit();
    console.log('[impitClient] impit native client loaded successfully.');
  } catch (e) {
    _impitInstance = null;
    console.warn(`[impitClient] impit unavailable (${e.message}). All requests will use undici fallback - streams will still work.`);
  }
  return _impitInstance;
}

// -- Shared undici keep-alive agent -------------------------------------------
const _undiciAgent = new Agent({
  // Connecting is the one phase neither headersTimeout nor an AbortSignal
  // reliably bounds here, so the agent has to. Twenty seconds meant a host that
  // accepts nothing cost 24.6 s of a viewer's session, measured against a
  // blackholed address. A host that cannot complete a handshake in five is not
  // going to serve video.
  connect: { timeout: 5000, rejectUnauthorized: false },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 30000,
});

function tooLarge() {
  const err = new Error('response too large');
  err.code = 'E_TOO_LARGE';
  return err;
}

/**
 * A body read with a ceiling. For a URL somebody else chose, "read it all" is
 * an invitation to point it at a file the size of the container's memory.
 * Takes impit's web stream or undici's Node stream alike.
 */
async function readCapped(stream, maxBytes, declaredLength) {
  if (Number(declaredLength) > maxBytes) {
    try { if (stream.cancel) await stream.cancel(); else stream.destroy(); } catch (_) {}
    throw tooLarge();
  }
  // A stream released early can emit 'error'; unheard, that ends the process.
  if (typeof stream.on === 'function') stream.on('error', () => {});
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge();   // leaving the loop releases the stream
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// -- Core helper --------------------------------------------------------------
/**
 * safeFetch - fetches a URL using impit when available, falls back to undici.
 *
 * @param {string} url
 * @param {object} opts   - { method, headers, body, signal, timeoutMs,
 *                            redirect ('manual' to get a 3xx back instead of following it),
 *                            maxBytes (refuse a larger body), dispatcher (for the undici path) }
 * @returns {{ ok, status, location, text: () => string, json: () => object }}
 */
async function safeFetch(url, opts = {}) {
  const { method = 'GET', headers = {}, body, signal, timeoutMs = 15000, redirect, maxBytes = 0, dispatcher } = opts;
  const impit = getImpit();

  // One budget for the whole call, not one per attempt. The fallback below used
  // to start a fresh full timeout after impit had already spent one, so a
  // caller asking for 10 seconds could wait thirty.
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());

  // -- Path A: impit ---------------------------------------------------------
  // Tried twice when the first try was cut off rather than answered: a
  // connection Cloudflare drops mid-handshake comes back on the next one, and
  // the undici fallback behind is refused by the same hosts that needed impit.
  // Never a second try for a timeout -- that budget is spent -- and only when
  // enough of it is left for the retry to mean anything.
  if (impit) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const control = new AbortController();
      let timer = null;
      try {
        const res = await Promise.race([
          impit.fetch(url, redirect
            ? { method, headers, body, signal: control.signal, redirect }
            : { method, headers, body, signal: control.signal }),
          new Promise((_, rej) => {
            timer = setTimeout(() => {
              // Tear the request down as well as giving up on it. Losing the race
              // used to leave the socket open and the timer pending.
              control.abort();
              const err = new Error(`impit timeout ${timeoutMs}ms`);
              err.code = 'E_TIMEOUT';
              rej(err);
            }, remaining());
          }),
        ]);
        const textData = maxBytes
          ? await readCapped(res.body, maxBytes, res.headers.get('content-length'))
          : await res.text();
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          location: res.headers.get('location') || '',
          text: async () => textData,
          json: async () => JSON.parse(textData),
        };
      } catch (impitErr) {
        // Too big is an answer about the file, not a fault in impit.
        if (impitErr && impitErr.code === 'E_TOO_LARGE') throw impitErr;
        // The fallback is for impit being broken, not for impit having already
        // spent the budget. Retrying a host that just failed to answer in the
        // time allowed only spends it twice -- which is how a 4 s budget became
        // 9.6 s against an address that accepts nothing.
        if (Date.now() >= deadline) {
          if (timer) clearTimeout(timer);
          throw impitErr;
        }
        const cutOff = !(impitErr && impitErr.code === 'E_TIMEOUT');
        if (attempt === 1 && cutOff && deadline - Date.now() > 2000) {
          if (timer) clearTimeout(timer);
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        // Transient error - fall through to undici without marking impit broken
        // Redacted: this logs whatever URL was being fetched, and on the stream
        // path that is a signed playlist.
        console.warn(`[impitClient] impit fetch failed (${impitErr.message}), falling back to undici for: ${redactUrl(url)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  // -- Path B: undici --------------------------------------------------------
  // Whatever is left of the budget, not another full one -- and enforced with a
  // signal rather than the timeout options. headersTimeout only starts once the
  // request has been written, so against a host that accepts nothing the
  // agent's 20 s connect timeout governs instead and the budget is ignored.
  // Measured: a blackholed address cost 24.6 s under headersTimeout alone.
  // A signal covers connect, headers and body alike.
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = body;
  let res;
  const MAX_REDIRECT_HOPS = 5;
  for (let hop = 0; ; hop++) {
    const left = remaining();
    const budget = AbortSignal.timeout(left);
    res = await undiciRequest(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      signal: signal ? AbortSignal.any([signal, budget]) : budget,
      headersTimeout: left,
      bodyTimeout: left,
      dispatcher: dispatcher || _undiciAgent,
    });
    const isRedirect = [301,302,303,307,308].includes(res.statusCode);
    if (redirect === 'manual' || !isRedirect || hop >= MAX_REDIRECT_HOPS) break;
    const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
    if (!location) break;
    let next;
    try { next = new URL(location, currentUrl); } catch (_) { break; }
    if (!['http:','https:'].includes(next.protocol)) break;
    try { await res.body.dump(); } catch (_) {}
    if (currentMethod !== 'HEAD' && ![307,308].includes(res.statusCode)) {
      currentMethod = 'GET'; currentBody = undefined;
      if (currentHeaders && currentHeaders.constructor === Object) {
        currentHeaders = { ...currentHeaders };
        delete currentHeaders['content-length']; delete currentHeaders['Content-Length'];
      }
    }
    currentUrl = next.toString();
  }
  const textData = maxBytes
    ? await readCapped(res.body, maxBytes, res.headers['content-length'])
    : await res.body.text();
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    location: String(res.headers.location || ''),
    text: async () => textData,
    json: async () => JSON.parse(textData),
  };
}

/**
 * isImpitAvailable - quick runtime check, useful for startup logs.
 */
function isImpitAvailable() {
  return getImpit() !== null;
}

module.exports = { safeFetch, isImpitAvailable, getImpit };

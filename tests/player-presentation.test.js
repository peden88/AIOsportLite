'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function sourceBetween(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert(a >= 0 && b > a, 'production player functions must be present');
  return html.slice(a, b);
}
const presentation = sourceBetween('    function isStandaloneApplePlayer()', '    function setupPlayerFeatures()');
const playback = sourceBetween('    async function playOpaqueTarget(', '    async function closePlayer(');

class Video extends EventTarget {
  constructor() {
    super();
    this.readyState = 4;
    this.webkitPresentationMode = 'inline';
    this.volume = 1;
    this.style = {};
    this.listeners = new Set();
    this.nativeSupport = 'probably';
    this.pauseCount = 0;
    this.loadCount = 0;
  }
  addEventListener(type, fn, options) { this.listeners.add(fn); super.addEventListener(type, fn, options); }
  removeEventListener(type, fn) { this.listeners.delete(fn); super.removeEventListener(type, fn); }
  canPlayType() { return this.nativeSupport; }
  removeAttribute(name) { delete this[name]; }
  play() { return Promise.resolve(); }
  pause() { this.pauseCount++; }
  load() { this.loadCount++; }
}

function fixture({ standalone = true, apple = true, ipad = false } = {}) {
  const video = new Video(), attrs = new Map(), timers = new Map();
  const notice = { hidden: true, textContent: '' };
  const button = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
  const calls = [], warnings = [];
  const host = { requestFullscreen() { calls.push('container-fullscreen'); } };
  const nodes = { video, playerPip: button, playerPresentationNotice: notice, 'video-container': host,
    loader: { style: {} }, playerStreamInfo: {} };
  const document = {
    pictureInPictureElement: null, pictureInPictureEnabled: true,
    documentElement: { classList: { contains: () => standalone } },
    getElementById: id => nodes[id],
    exitPictureInPicture() { calls.push('exit-standard'); this.pictureInPictureElement = null; },
    exitFullscreen() { calls.push('exit-container'); this.fullscreenElement = null; }
  };
  class Hls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    constructor() { calls.push('hls.js'); }
    on() {}
    loadSource(url) { calls.push(['hls-url', url]); }
    attachMedia(media) { assert.equal(media, video); calls.push('hls-attach'); }
    destroy() { calls.push('hls-destroy'); }
  }
  let timerId = 0;
  const ctx = vm.createContext({
    document,
    navigator: { standalone, userAgent: apple && !ipad ? 'iPhone' : 'Mozilla/5.0',
      platform: ipad ? 'MacIntel' : '', maxTouchPoints: ipad ? 5 : 0 },
    DOMException, URL, console: { warn: (...args) => warnings.push(args) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    hls: null, Hls, location: { href: 'https://example.test/' },
    playbackGeneration: 1, currentPlaybackTarget: null, currentPlaybackKind: 'episode',
    recoverySnapshot: null, currentProgressContext: { position: 120 }, currentPlaybackSession: 'session',
    isSafariBasedBrowser: () => apple,
    showPlaybackLoading: text => calls.push(['loading', text]), showPlayerHud() {},
    armResumePosition: media => { assert.equal(media, video); calls.push('resume-armed'); },
    fetch: async url => {
      calls.push(['prepare', url]);
      return { ok: true, json: async () => ({ ok: true, url: '/api/compatible/master.m3u8', mode: 'copy' }) };
    }
  });
  vm.runInContext(presentation + '\n' + playback, ctx);
  function tick(delay) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      timers.delete(id); timer.fn();
    }
  }
  return { ctx, video, document, notice, calls, warnings, attrs, timers, tick };
}

async function run() {
  let count = 0;
  async function check(name, fn) { await fn(); count++; console.log('PASS ' + name); }

  await check('Apple PWA invokes WebKit directly in the user gesture, without the standard API', async () => {
    const f = fixture(); let gesture = true;
    f.video.webkitSetPresentationMode = mode => {
      assert(gesture); f.calls.push(mode); f.video.webkitPresentationMode = mode;
      f.video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    };
    const pending = f.ctx.togglePlayerPictureInPicture(); gesture = false; await pending;
    assert.deepEqual(f.calls, ['picture-in-picture']);
    assert.equal(f.video.listeners.size, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.video.pauseCount, 0); assert.equal(f.video.loadCount, 0);
  });

  await check('working Safari WebKit entry is retained even when the standard API rejects', async () => {
    const f = fixture({ standalone: false });
    f.video.requestPictureInPicture = () => { throw new Error('must not use standard API'); };
    f.video.webkitSetPresentationMode = mode => { f.video.webkitPresentationMode = mode; };
    await f.ctx.togglePlayerPictureInPicture();
    assert(f.ctx.playerIsInPictureInPicture(f.video)); assert.equal(f.warnings.length, 0);
  });

  await check('a synchronous WebKit failure falls back within the same tap', async () => {
    const f = fixture(); let gesture = true;
    f.video.webkitSetPresentationMode = () => { throw new DOMException('Unavailable', 'NotSupportedError'); };
    f.video.requestPictureInPicture = () => {
      assert(gesture); f.document.pictureInPictureElement = f.video; return Promise.resolve();
    };
    const pending = f.ctx.togglePlayerPictureInPicture(); gesture = false; await pending;
    assert(f.ctx.playerIsInPictureInPicture(f.video)); assert(f.notice.hidden);
  });

  await check('browser uses its standard API when WebKit reports unsupported', async () => {
    const f = fixture({ standalone: false });
    f.video.webkitSupportsPresentationMode = () => false;
    f.video.webkitSetPresentationMode = () => { throw new Error('must retain browser API choice'); };
    f.video.requestPictureInPicture = () => { f.document.pictureInPictureElement = f.video; return Promise.resolve(); };
    await f.ctx.togglePlayerPictureInPicture();
    assert(f.ctx.playerIsInPictureInPicture(f.video)); assert.equal(f.warnings.length, 0);
  });

  await check('non-Apple PWA uses the standard PiP API and can exit it', async () => {
    const f = fixture({ apple: false });
    f.video.requestPictureInPicture = () => { f.document.pictureInPictureElement = f.video; return Promise.resolve(); };
    await f.ctx.togglePlayerPictureInPicture(); await f.ctx.togglePlayerPictureInPicture();
    assert.equal(f.document.pictureInPictureElement, null); assert.deepEqual(f.calls, ['exit-standard']);
  });

  await check('active WebKit PiP exits even when its entry capability probe is false', async () => {
    const f = fixture(); f.video.webkitPresentationMode = 'picture-in-picture';
    f.video.webkitSupportsPresentationMode = () => false;
    f.video.webkitSetPresentationMode = mode => { f.calls.push(mode); f.video.webkitPresentationMode = mode; };
    await f.ctx.togglePlayerPictureInPicture(); assert.deepEqual(f.calls, ['inline']);
  });

  await check('a positive standard capability flag does not hide a platform rejection', async () => {
    const f = fixture();
    f.video.requestPictureInPicture = () => Promise.reject(new DOMException('Denied', 'NotSupportedError'));
    await f.ctx.togglePlayerPictureInPicture();
    assert(!f.notice.hidden); assert.match(f.notice.textContent, /installed app/);
    assert.equal(f.video.pauseCount, 0); assert.equal(f.video.loadCount, 0);
    assert.equal(f.video.listeners.size, 0); assert(!f.attrs.has('aria-busy'));
  });

  await check('silent WebKit no-op is detected, duplicate taps are ignored, and playback is untouched', async () => {
    const f = fixture(); let requests = 0;
    f.video.webkitSetPresentationMode = () => { requests++; };
    const pending = f.ctx.togglePlayerPictureInPicture();
    await f.ctx.togglePlayerPictureInPicture(); assert.equal(requests, 1);
    f.tick(2500); await pending;
    assert(!f.notice.hidden); assert.equal(f.warnings[0][1].error, 'TimeoutError');
    assert.equal(f.video.pauseCount, 0); assert.equal(f.video.loadCount, 0);
    assert.equal(f.video.listeners.size, 0); assert(!f.attrs.has('aria-busy'));
  });

  await check('a delayed PiP event confirms entry and clears the failure timer', async () => {
    const f = fixture(); f.video.webkitSetPresentationMode = () => {};
    const pending = f.ctx.togglePlayerPictureInPicture();
    f.video.webkitPresentationMode = 'picture-in-picture';
    f.video.dispatchEvent(new Event('webkitpresentationmodechanged')); await pending;
    f.tick(2500); assert(f.notice.hidden); assert.equal(f.timers.size, 0);
  });

  await check('changing playback cancels a pending transition without a stale error', async () => {
    const f = fixture(); f.video.webkitSetPresentationMode = () => {};
    const pending = f.ctx.togglePlayerPictureInPicture();
    f.video.dispatchEvent(new Event('emptied')); await pending;
    f.tick(2500); assert(f.notice.hidden); assert.equal(f.warnings.length, 0);
    assert.equal(f.video.listeners.size, 0); assert(!f.attrs.has('aria-busy'));
  });

  await check('an unloaded video asks the user to wait without requesting PiP', async () => {
    const f = fixture(); f.video.readyState = 0;
    f.video.webkitSetPresentationMode = () => { throw new Error('not ready'); };
    await f.ctx.togglePlayerPictureInPicture(); assert.match(f.notice.textContent, /Wait for playback/);
    assert.equal(f.warnings.length, 0);
  });

  await check('Apple PWA uses AVKit fullscreen when element fullscreen is also available', async () => {
    const f = fixture();
    f.video.webkitEnterFullscreen = () => { f.calls.push('native-fullscreen'); f.video.webkitDisplayingFullscreen = true; };
    f.video.webkitExitFullscreen = () => { f.calls.push('exit-native'); f.video.webkitDisplayingFullscreen = false; };
    await f.ctx.enterPlayerFullscreen(); await f.ctx.enterPlayerFullscreen();
    assert.deepEqual(f.calls, ['native-fullscreen', 'exit-native']);
  });

  await check('Safari browser and desktop keep their original fullscreen choice', async () => {
    const f = fixture({ standalone: false });
    f.video.webkitEnterFullscreen = () => { throw new Error('must retain browser behavior'); };
    await f.ctx.enterPlayerFullscreen(); assert.deepEqual(f.calls, ['container-fullscreen']);
    f.document.fullscreenElement = {}; await f.ctx.enterPlayerFullscreen();
    assert.equal(f.calls.at(-1), 'exit-container');
  });

  await check('iPad desktop user agents are recognized, but desktops and Android are excluded', () => {
    assert(fixture({ ipad: true }).ctx.isStandaloneApplePlayer());
    assert(!fixture({ apple: false }).ctx.isStandaloneApplePlayer());
    assert(!fixture({ standalone: false }).ctx.isStandaloneApplePlayer());
  });

  await check('PWA playback still prepares compatibility and attaches that HLS URL natively with resume armed', async () => {
    const f = fixture(); f.video.disableRemotePlayback = true;
    await f.ctx.playOpaqueTarget({ kind: 'direct', url: '/media/original.mkv' }, 1);
    assert(f.calls.some(row => Array.isArray(row) && row[0] === 'prepare'));
    assert(f.calls.includes('resume-armed')); assert(!f.calls.includes('hls.js'));
    assert.equal(f.video.src, '/api/compatible/master.m3u8');
    assert.equal(f.video.disableRemotePlayback, false);
  });

  await check('Safari browser retains hls.js for the same prepared stream', async () => {
    const f = fixture({ standalone: false });
    await f.ctx.playOpaqueTarget({ kind: 'direct', url: '/media/original.mkv' }, 1);
    assert(f.calls.includes('hls.js')); assert(f.calls.includes('hls-attach'));
    assert(f.calls.some(row => Array.isArray(row) && row[0] === 'hls-url' && row[1] === '/api/compatible/master.m3u8'));
  });

  await check('a PWA without native HLS support falls back to hls.js', async () => {
    const f = fixture(); f.video.nativeSupport = '';
    await f.ctx.playOpaqueTarget({ kind: 'direct', url: '/media/original.mkv' }, 1);
    assert(f.calls.includes('hls.js'));
  });

  console.log(count + ' player presentation behavior tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

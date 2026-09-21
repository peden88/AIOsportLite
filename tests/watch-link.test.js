'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-watch-'));
delete process.env.LINK_SECRET;

const { signWatchPath, verifyWatchQuery } = require('../src/manifestLink');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const queryObject = value => {
  const u = new URL(value, 'http://local.invalid');
  return Object.fromEntries(u.searchParams.entries());
};

const raw = '/watch?url=' + encodeURIComponent('https://embed.example.test/game/1') + '&title=Match';
const signed = signWatchPath(raw);
const q = queryObject(signed);

t(true, signed.startsWith('/watch?'), 'watch handoff stays an internal relative URL');
t(true, !!q.sig && /^\d+$/.test(q.exp || ''), 'watch handoff carries signature and expiry');
t(true, verifyWatchQuery(q), 'fresh server-minted watch link verifies');

const withBuffer = { ...q, buf: '20' };
t(true, verifyWatchQuery(withBuffer), 'viewer buffer parameter does not invalidate capability');

const tampered = { ...q, url: 'https://embed.example.test/game/2' };
t(false, verifyWatchQuery(tampered), 'changing playback target invalidates signature');

const modeRaw = '/watch?mode=extract&embed=' + encodeURIComponent('https://embed.example.test/player') + '&referer=' + encodeURIComponent('https://embed.example.test/');
const modeSigned = queryObject(signWatchPath(modeRaw));
t(true, verifyWatchQuery(modeSigned), 'extract-mode watch handoff is signed');
t(false, verifyWatchQuery({ ...modeSigned, mode: 'other' }), 'changing watch mode invalidates signature');
t(false, verifyWatchQuery({ url: q.url }), 'unsigned copied watch URL is rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

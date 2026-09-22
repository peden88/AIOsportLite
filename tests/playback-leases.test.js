'use strict';

const fs = require('fs');
const path = require('path');
const leases = require('../src/services/PlaybackLeases');

let pass = 0, fail = 0;
function t(condition, label) {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : '*** FAIL'}  ${label}`);
}

function user(id, limit) {
  return {
    id,
    username: id,
    displayName: id,
    maxConcurrentStreams: limit
  };
}

console.log('--- playback lease concurrency');
leases._resetForTests();

const first = leases.acquire({
  user: user('u1', 1),
  authSession: { id: 'auth1', deviceName: 'Living room TV' },
  client: 'app',
  contentType: 'movie',
  contentId: 'tt1',
  title: 'Movie One'
});
t(!!first, 'first stream is allowed');
t(leases.bind(first.id, 'play1'), 'lease binds to opaque playback session');

let blocked = false;
try {
  leases.acquire({
    user: user('u1', 1),
    authSession: { id: 'auth2', deviceName: 'Phone' },
    client: 'web',
    contentType: 'movie',
    contentId: 'tt2',
    title: 'Movie Two'
  });
} catch (err) {
  blocked = err && err.code === 'STREAM_LIMIT_REACHED' && err.statusCode === 409;
}
t(blocked, 'second stream is blocked when allowance is one');
t(leases.touchSession('play1', 'u1'), 'owner heartbeat keeps the lease alive');
t(!leases.touchSession('play1', 'other-user'), 'another user cannot heartbeat the lease');
t(leases.releaseSession('play1'), 'normal stop releases the lease');

console.log('--- two and three stream allowances');
const a = leases.acquire({ user: user('u2', 3), contentId: 'a' });
const b = leases.acquire({ user: user('u2', 3), contentId: 'b' });
const c = leases.acquire({ user: user('u2', 3), contentId: 'c' });
t(leases._activeForUser('u2').length === 3, 'allowance three permits three active leases');
let fourthBlocked = false;
try { leases.acquire({ user: user('u2', 3), contentId: 'd' }); }
catch (err) { fourthBlocked = err && err.code === 'STREAM_LIMIT_REACHED'; }
t(fourthBlocked, 'fourth stream is blocked at allowance three');

const revoked = leases.enforceLimit('u2', 1);
t(revoked.length === 2, 'lowering allowance revokes excess streams');
t(leases._activeForUser('u2').length === 1, 'oldest active stream remains after lowering allowance');
t(leases._activeForUser('u2')[0].id === a.id, 'oldest stream is preserved');

console.log('--- expiry and session release');
const expiring = leases.acquire({ user: user('u3', 1), contentId: 'x' });
const raw = leases._leases.get(expiring.id);
raw.expiresAt = Date.now() - 1;
leases._cleanup();
t(!leases.isLeaseActive(expiring.id), 'expired lease is removed automatically');

const sessionLease = leases.acquire({
  user: user('u4', 2),
  authSession: { id: 'auth-session-4' },
  contentId: 'y'
});
t(leases.releaseAuthSession('auth-session-4') === 1, 'signing out a device releases its active streams');
t(!leases.isLeaseActive(sessionLease.id), 'released auth-session lease is gone');

console.log('--- admin UI contracts');
const usersHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'users.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
t(usersHtml.includes('newStreams'), 'user creation has a concurrent stream selector');
t(usersHtml.includes('streamLimit'), 'existing users have a concurrent stream selector');
t(dashboardHtml.includes('id="activeStreams"'), 'dashboard has an active streams section');
t(dashboardHtml.includes('stop-stream'), 'dashboard can stop an active stream');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

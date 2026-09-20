'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-auth-'));
delete process.env.APP_ADMIN_USERNAME;
delete process.env.APP_ADMIN_PASSWORD;
delete process.env.AUTH_KEY;

const auth = require('../src/services/UserAuth');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};

(async () => {
  console.log('--- account creation and password login');
  const admin = await auth.createUser({
    username: 'Admin.User',
    password: 'correct-horse-battery-staple',
    displayName: 'Administrator',
    role: 'admin'
  });
  t('admin.user', admin.username, 'usernames are canonical lower-case');
  t('admin', admin.role, 'administrator role is retained');
  t(undefined, admin.password, 'password hash is never exposed');

  const ordinary = await auth.createUser({
    username: 'viewer_1',
    password: 'viewer-password-123',
    displayName: 'Living Room',
    role: 'user'
  });
  t(2, auth.listUsers().length, 'multiple users persist in one account store');

  const bad = await auth.login('viewer_1', 'wrong-password', { kind: 'app', deviceName: 'TV' });
  t(null, bad, 'wrong password is rejected');

  const session = await auth.login('viewer_1', 'viewer-password-123', { kind: 'app', deviceName: 'Living room TV' });
  t(true, !!session && !!session.token, 'valid password issues an opaque app token');
  t('viewer_1', session.user.username, 'session is tied to the correct account');

  const authenticated = auth.authenticateToken(session.token);
  t('viewer_1', authenticated && authenticated.user.username, 'opaque token authenticates without password reuse');
  t('Living room TV', auth.listSessionsForUser(ordinary.id)[0].deviceName, 'device name is stored for revocation UI');

  console.log('--- revocation and administrator safety');
  const revoked = auth.revokeUserSessions(ordinary.id);
  t(1, revoked, 'administrator can revoke all user sessions');
  t(null, auth.authenticateToken(session.token), 'revoked token cannot authenticate');

  const disabled = await auth.updateUser(ordinary.id, { enabled: false });
  t(false, disabled.enabled, 'ordinary account can be disabled');

  let lastAdminBlocked = false;
  try {
    await auth.updateUser(admin.id, { role: 'user' });
  } catch (err) {
    lastAdminBlocked = err && err.code === 'LAST_ADMIN';
  }
  t(true, lastAdminBlocked, 'last enabled administrator cannot be demoted');

  const secondAdmin = await auth.createUser({
    username: 'admin2',
    password: 'second-admin-password',
    role: 'admin'
  });
  const demoted = await auth.updateUser(admin.id, { role: 'user' });
  t('user', demoted.role, 'administrator can be demoted once another enabled admin exists');

  console.log('--- persistence');
  auth._resetForTests();
  t(3, auth.listUsers().length, 'account store survives module reload/reset');
  t('admin', auth.listUsers().find(u => u.id === secondAdmin.id).role, 'persisted role survives reload');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

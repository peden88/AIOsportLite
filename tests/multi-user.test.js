'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiosportlite-users-'));
delete process.env.AUTH_KEY;
delete process.env.APP_ADMIN_USERNAME;
delete process.env.APP_ADMIN_PASSWORD;

const store = require('../src/services/UserStore');

let pass = 0, fail = 0;
const t = (want, got, label) => {
  const ok = JSON.stringify(want) === JSON.stringify(got);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : '*** FAIL'}  ${label}  (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`);
};
const throwsCode = (fn, code) => {
  try { fn(); return false; } catch (err) { return err && err.code === code; }
};

console.log('--- multi-user account store');
t(false, store.hasUsers(), 'fresh data directory has no users');

const admin = store.createUser({
  username: 'admin',
  displayName: 'Administrator',
  password: 'correct-horse-battery',
  role: 'admin'
});
t('admin', admin.role, 'administrator account is created');
t(false, JSON.stringify(admin).includes('password'), 'public user never exposes password data');
t(false, JSON.stringify(admin).includes('hash'), 'public user never exposes password hash');
t(true, !!store.authenticate('ADMIN', 'correct-horse-battery'), 'username lookup is case-insensitive');
t(null, store.authenticate('admin', 'wrong-password'), 'wrong password is rejected');

const user = store.createUser({
  username: 'viewer.one',
  displayName: 'Viewer One',
  password: 'viewer-password-123',
  role: 'user'
});
t(2, store.listUsers().length, 'multiple users are supported');
t(true, throwsCode(() => store.createUser({
  username: 'VIEWER.ONE',
  password: 'another-password-123'
}), 'USERNAME_EXISTS'), 'duplicate username is rejected case-insensitively');

const session = store.createSession(user.id, { clientType: 'android_tv', deviceName: 'Living Room TV' });
const resolved = store.resolveSession(session.token);
t(user.id, resolved && resolved.user.id, 'TV bearer session resolves to its user');
t('android_tv', resolved && resolved.session.clientType, 'session records client type');
t('Living Room TV', resolved && resolved.session.deviceName, 'session records device name');
t(1, store.listUserSessions(user.id).length, 'user can enumerate their device sessions');

store.updateUser(user.id, { enabled: false });
t(null, store.resolveSession(session.token), 'disabling an account revokes its sessions');

t(true, throwsCode(() => store.updateUser(admin.id, { role: 'user' }), 'LAST_ADMIN'), 'last enabled admin cannot be demoted');

const admin2 = store.createUser({
  username: 'admin.two',
  password: 'second-admin-password',
  role: 'admin'
});
t('user', store.updateUser(admin.id, { role: 'user' }).role, 'admin can be demoted when another enabled admin exists');
t(true, throwsCode(() => store.deleteUser(admin2.id), 'LAST_ADMIN'), 'last enabled admin cannot be deleted');

const onDisk = JSON.parse(fs.readFileSync(store.USERS_FILE, 'utf8'));
const userKeys = Object.keys(onDisk.users[0] || {});
t(false, userKeys.some(k => /addon|manifest|stream.*url|metadata.*url/i.test(k)), 'user schema contains no addon or service-manifest fields');

console.log('--- first-run bootstrap');
for (const file of [store.USERS_FILE, store.SESSIONS_FILE]) {
  try { fs.unlinkSync(file); } catch (_) {}
}
store._resetForTests();
process.env.APP_ADMIN_USERNAME = 'owner';
process.env.APP_ADMIN_PASSWORD = 'owner-password-123';
const boot = store.bootstrapInitialAdmin();
t('owner', boot && boot.username, 'environment can bootstrap the initial admin once');
process.env.APP_ADMIN_PASSWORD = 'changed-password-123';
const secondBoot = store.bootstrapInitialAdmin();
t(null, secondBoot, 'bootstrap variables cannot overwrite an existing admin');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

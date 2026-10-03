import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStatus, ADMIN_CACHE_PREFIX, ADMIN_CACHE_TTL_MS } from '../admin-auth.js';
import { shouldRecord, ACTIVITY_INTERVAL_MS } from '../user-activity.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get length() { return map.size; },
    key: i => [...map.keys()][i],
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

function setup(adminUids = ['admin-1']) {
  const storage = memoryStorage();
  let clock = 1000;
  const reads = [];
  const status = createAdminStatus({
    storage,
    now: () => clock,
    readAdminDoc: async uid => { reads.push(uid); return adminUids.includes(uid); }
  });
  return { storage, status, reads, tick: ms => { clock += ms; }, adminUids };
}

test('isAdmin result is cached in sessionStorage per UID', async () => {
  const f = setup();
  assert.equal(await f.status.check('admin-1'), true);
  assert.equal(await f.status.check('admin-1'), true);
  assert.equal(await f.status.check('user-2'), false);
  assert.equal(await f.status.check('user-2'), false);
  assert.deepEqual(f.reads, ['admin-1', 'user-2']);
  assert.ok(f.storage.getItem(`${ADMIN_CACHE_PREFIX}admin-1`));
  assert.ok(f.storage.getItem(`${ADMIN_CACHE_PREFIX}user-2`));
});

test('cache expires, can be forced and cleared', async () => {
  const f = setup();
  await f.status.check('admin-1');
  f.tick(ADMIN_CACHE_TTL_MS + 1);
  await f.status.check('admin-1');
  await f.status.check('admin-1', { force: true });
  f.adminUids.length = 0; // admin removed
  f.status.clear('admin-1');
  assert.equal(await f.status.check('admin-1'), false);
  assert.equal(f.reads.length, 4);
  f.status.clear();
  assert.equal(f.storage.length, 0);
});

test('signed-out, tampered cache and read errors are handled safely', async () => {
  const f = setup();
  assert.equal(await f.status.check(null), false);
  f.storage.setItem(`${ADMIN_CACHE_PREFIX}user-2`, 'not json');
  assert.equal(await f.status.check('user-2'), false);
  const failing = createAdminStatus({
    storage: f.storage,
    readAdminDoc: async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); }
  });
  await assert.rejects(failing.check('user-3'), /denied/);
  assert.equal(f.storage.getItem(`${ADMIN_CACHE_PREFIX}user-3`), null, 'errors are never cached');
});

test('activity is recorded on first visit, new sign-in, or after the interval', () => {
  assert.equal(shouldRecord(null, { signIn: 1, now: 10 }), true);
  assert.equal(shouldRecord({ at: 10, signIn: 1 }, { signIn: 1, now: 20 }), false);
  assert.equal(shouldRecord({ at: 10, signIn: 1 }, { signIn: 2, now: 20 }), true);
  assert.equal(shouldRecord({ at: 10, signIn: 1 }, { signIn: 1, now: 10 + ACTIVITY_INTERVAL_MS }), true);
});

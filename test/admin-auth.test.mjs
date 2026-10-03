import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminStatus, createActivityMaintenance, ADMIN_CACHE_PREFIX, ADMIN_CACHE_TTL_MS } from '../admin-auth.js';
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

function maintenanceFixture({ allowed = true, size = 901, failBatch = 0 } = {}) {
  const calls = [];
  let commits = 0;
  const fs = {
    collection: (_, name) => name,
    doc: (_, name, uid) => `${name}/${uid}`,
    deleteDoc: async ref => { calls.push(['delete', ref]); },
    getDocs: async name => {
      calls.push(['read', name]);
      return { docs: Array.from({ length: size }, (_, i) => ({ ref: `userActivity/${i}` })) };
    },
    writeBatch: () => {
      const refs = [];
      return {
        delete: ref => refs.push(ref),
        commit: async () => {
          commits += 1;
          if (commits === failBatch) throw new Error('offline');
          calls.push(['batch', refs]);
        }
      };
    }
  };
  const tools = createActivityMaintenance({
    checkAdmin: async options => { calls.push(['admin', options]); return allowed; },
    firebase: async () => ({ fs, db: {} })
  });
  return { tools, calls };
}

test('activity deletion freshly checks admin status and only deletes the activity record', async () => {
  const { tools, calls } = maintenanceFixture();
  await tools.deleteUserActivity('someone');
  assert.deepEqual(calls, [['admin', { force: true }], ['delete', 'userActivity/someone']]);
  await assert.rejects(tools.deleteUserActivity('bad/path'), /Invalid/);
  const denied = maintenanceFixture({ allowed: false });
  await assert.rejects(denied.tools.deleteUserActivity('someone'), { code: 'permission-denied' });
  await assert.rejects(denied.tools.clearUserActivity(), { code: 'permission-denied' });
  assert.equal(denied.calls.some(call => ['read', 'delete', 'batch'].includes(call[0])), false);
});

test('clear activity handles collections beyond one batch and reports only committed deletions', async () => {
  const { tools, calls } = maintenanceFixture();
  const progress = [];
  assert.equal(await tools.clearUserActivity({ onProgress: count => progress.push(count) }), 901);
  assert.deepEqual(progress, [450, 900, 901]);
  assert.deepEqual(calls.filter(call => call[0] === 'batch').map(call => call[1].length), [450, 450, 1]);
  const failing = maintenanceFixture({ failBatch: 2 });
  const partial = [];
  await assert.rejects(failing.tools.clearUserActivity({ onProgress: count => partial.push(count) }), /offline/);
  assert.deepEqual(partial, [450]);
  assert.equal(await maintenanceFixture({ size: 0 }).tools.clearUserActivity(), 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminOrders, parseOrderPath, ADMIN_ORDER_BATCH_SIZE } from '../admin-orders.js';

const path = (uid = 'alice', id = 'JGV-00000001') => `users/${uid}/orders/${id}`;
const order = (extra = {}) => ({ status: 'In Queue', date: '2026-01-01', items: [], total: 5, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(initial = {}) {
  const docs = new Map([['admins/root', {}], ...Object.entries(initial)]);
  const calls = [];
  let authCallback;
  const auth = { currentUser: { uid: 'root' } };
  const snapshot = ref => ({
    id: ref.path.split('/').at(-1), ref,
    exists: () => docs.has(ref.path), data: () => docs.get(ref.path)
  });
  const fs = {
    doc: (_, ...segments) => ({ path: segments.join('/') }),
    collection: (_, ...segments) => ({ path: segments.join('/') }),
    collectionGroup: (_, name) => ({ group: name }),
    serverTimestamp: () => 'SERVER_TIME',
    async getDocFromServer(ref) { calls.push(['admin', ref.path]); return snapshot(ref); },
    async getDocsFromServer(ref) {
      calls.push(['list', ref]);
      return { docs: [...docs.keys()].filter(key => ref.group
        ? key.split('/').at(-2) === ref.group : key.startsWith(`${ref.path}/`))
        .map(key => snapshot({ path: key })) };
    },
    async runTransaction(_, callback) {
      const writes = [];
      const deletes = [];
      const value = await callback({
        get: async ref => snapshot(ref),
        update: (ref, data) => writes.push([ref.path, data]),
        delete: ref => deletes.push(ref.path)
      });
      for (const [key, data] of writes) {
        calls.push(['update', key, data]);
        docs.set(key, { ...docs.get(key), ...data });
      }
      if (deletes.length) {
        calls.push(['batch', [...deletes]]);
        deletes.forEach(key => docs.delete(key));
      }
      return value;
    },
    writeBatch() {
      throw new Error('Destructive writes must not use offline-queued writeBatch.');
    }
  };
  const onUserChanged = callback => { authCallback = callback; callback(auth.currentUser); return () => {}; };
  const changeAuth = user => { auth.currentUser = user; authCallback(user); };
  return { docs, calls, fs, auth, changeAuth,
    api: createAdminOrders({ db: {}, fs, auth, onUserChanged }) };
}

test('only exact canonical order paths are actionable', () => {
  assert.deepEqual(parseOrderPath(path()), { path: path(), uid: 'alice', docId: 'JGV-00000001' });
  for (const invalid of [null, '', 'orders/x', '/users/a/orders/b', 'users/a/orders/b/child/c',
    'other/a/orders/b', 'users//orders/b', 'users/../orders/b', 'users/a/orders/..']) {
    assert.throws(() => parseOrderPath(invalid), { code: 'invalid-order' });
  }
});

test('default scope is own; all scope preserves UID and full path for colliding ids', async () => {
  const f = fixture({ [path('root')]: order(), [path('alice')]: order(), [path('bob')]: order(),
    'archive/orders/legacy': order() });
  assert.deepEqual((await f.api.listOrders()).map(o => o.uid), ['root']);
  const all = await f.api.listOrders('all');
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map(o => o.path)).size, 3);
  assert.ok(all.every(o => o.docId === 'JGV-00000001'));
  await assert.rejects(f.api.listOrders('wrong'), { code: 'invalid-scope' });
  f.docs.delete('admins/root');
  await assert.rejects(f.api.listOrders(), { code: 'permission-denied' });
});

test('listing retains complete original document data for private pre-delete JSON export', async () => {
  const raw = order({
    createdAt: { seconds: 1700000000, nanoseconds: 5 },
    statusUpdatedAt: { seconds: 1700000001, nanoseconds: 6 }, statusUpdatedBy: 'root',
    legacyMetadata: { retain: 'unaltered' }
  });
  const f = fixture({ [path()]: raw });
  const [listed] = await f.api.listOrders('all');
  assert.deepEqual(listed.documentData, raw);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.documentData)), raw);
  assert.equal(listed.path, path());
});

test('transaction updates only allowlisted status metadata and clears old cancellation reason', async () => {
  const raw = order({ shipping: { city: 'Austin' }, notes: 'immutable', legacy: 'preserved' });
  const f = fixture({ [path()]: raw, [path('bob')]: order() });
  const cancelled = await f.api.updateStatus(path(), 'In Queue', 'Cancelled', '  No stock  ');
  assert.equal(cancelled.cancellationReason, 'No stock');
  assert.equal(cancelled.path, path());
  const write = f.calls.find(call => call[0] === 'update')[2];
  assert.deepEqual(write, { status: 'Cancelled', cancellationReason: 'No stock',
    statusUpdatedAt: 'SERVER_TIME', statusUpdatedBy: 'root' });
  assert.equal(f.docs.get(path()).legacy, 'preserved');
  assert.equal(f.docs.get(path('bob')).status, 'In Queue');
  await f.api.updateStatus(path(), 'Cancelled', 'In Progress', 'discard');
  assert.equal(f.docs.get(path()).cancellationReason, '');
});

test('stale status, missing orders, invalid statuses/reasons and revocation cannot mutate', async () => {
  const f = fixture({ [path()]: order({ status: 'Shipped' }) });
  await assert.rejects(f.api.updateStatus(path(), 'In Queue', 'Completed'), { code: 'stale-order' });
  await assert.rejects(f.api.updateStatus(path('missing'), 'In Queue', 'Completed'), { code: 'order-not-found' });
  for (const args of [['In Queue', 'Invalid', ''], ['Invalid', 'Completed', ''],
    ['Shipped', 'Cancelled', 'x'.repeat(501)], ['Shipped', 'Cancelled', null]]) {
    await assert.rejects(f.api.updateStatus(path(), ...args), { code: 'invalid-status' });
  }
  f.docs.delete('admins/root');
  await assert.rejects(f.api.updateStatus(path(), 'Shipped', 'Completed'), { code: 'permission-denied' });
  assert.equal(f.calls.filter(call => call[0] === 'update').length, 0);
});

test('membership is also transactionally checked after the fresh server check', async () => {
  const f = fixture({ [path()]: order() });
  f.fs.getDocFromServer = async () => {
    f.docs.delete('admins/root');
    return { exists: () => true };
  };
  await assert.rejects(f.api.updateStatus(path(), 'In Queue', 'Shipped'), { code: 'permission-denied' });
  assert.equal(f.docs.get(path()).status, 'In Queue');
});

test('same UID signout/login invalidates in-flight reads and transaction callbacks', async () => {
  for (const operation of ['list', 'update']) {
    const f = fixture({ [path()]: order() });
    const wait = deferred();
    f.fs.getDocFromServer = async () => { await wait.promise; return { exists: () => true }; };
    const pending = operation === 'list' ? f.api.listOrders('all') : f.api.updateStatus(path(), 'In Queue', 'Shipped');
    f.changeAuth(null);
    f.changeAuth({ uid: 'root' });
    wait.resolve();
    await assert.rejects(pending, { code: 'stale-user' });
    assert.equal(f.docs.get(path()).status, 'In Queue');
  }
});

test('transaction retries recheck status and membership before staging any update', async () => {
  const f = fixture({ [path()]: order() });
  let staged = 0;
  f.fs.runTransaction = async (_, callback) => {
    const transaction = {
      get: async ref => ({ id: ref.path.split('/').at(-1), exists: () => f.docs.has(ref.path), data: () => f.docs.get(ref.path) }),
      update: () => { staged++; }
    };
    await callback(transaction);
    f.docs.set(path(), order({ status: 'Completed' }));
    return callback(transaction);
  };
  await assert.rejects(f.api.updateStatus(path(), 'In Queue', 'Shipped'), { code: 'stale-order' });
  assert.equal(staged, 1);
  assert.equal(f.calls.filter(call => call[0] === 'admin').length, 2);
});

test('deletion is bounded to 100, deduplicates only captured paths and never queries', async () => {
  const paths = Array.from({ length: 205 }, (_, i) => path('alice', `order-${i}`));
  const f = fixture(Object.fromEntries([...paths, path('bob')].map(key => [key, order()])));
  const progress = [];
  const result = await f.api.deleteOrders([...paths, paths[0]], value => progress.push(value.deleted));
  assert.equal(ADMIN_ORDER_BATCH_SIZE, 100);
  assert.deepEqual(f.calls.filter(c => c[0] === 'batch').map(c => c[1].length), [100, 100, 5]);
  assert.deepEqual(progress, [100, 200, 205]);
  assert.equal(result.deleted, 205);
  assert.equal(result.remaining, 0);
  assert.equal(result.error, null);
  assert.equal(f.calls.filter(c => c[0] === 'admin').length, 3);
  assert.equal(f.calls.some(c => c[0] === 'list'), false);
  assert.equal(f.docs.has(path('bob')), true);
});

test('failed or revoked later batches return precise partial counts and remaining captured paths', async () => {
  for (const revoke of [true, false]) {
    const paths = Array.from({ length: 201 }, (_, i) => path('alice', `order-${i}`));
    const f = fixture(Object.fromEntries(paths.map(key => [key, order()])));
    const failure = Object.assign(new Error('offline'), { code: 'unavailable' });
    let commits = 0;
    const original = f.fs.runTransaction;
    f.fs.runTransaction = async (db, callback) => {
      commits++;
      if (!revoke && commits === 2) throw failure;
      const value = await original(db, callback);
      if (revoke) f.docs.delete('admins/root');
      return value;
    };
    const result = await f.api.deleteOrders(paths);
    assert.equal(result.deleted, 100);
    assert.equal(result.remaining, 101);
    assert.equal(result.failed, 101);
    assert.deepEqual(result.remainingPaths, paths.slice(100));
    assert.equal(result.error.code, revoke ? 'permission-denied' : 'unavailable');
  }
});

test('account invalidation after a committed batch suppresses callbacks and stops later batches', async () => {
  const paths = Array.from({ length: 101 }, (_, i) => path('alice', `order-${i}`));
  const f = fixture(Object.fromEntries(paths.map(key => [key, order()])));
  let callbacks = 0;
  const original = f.fs.runTransaction;
  f.fs.runTransaction = async (db, callback) => {
    const value = await original(db, callback);
    f.changeAuth(null); f.changeAuth({ uid: 'root' });
    return value;
  };
  const result = await f.api.deleteOrders(paths, () => { callbacks++; });
  assert.equal(callbacks, 0);
  assert.equal(result.deleted, 100);
  assert.equal(result.remaining, 1);
  assert.equal(result.error.code, 'stale-user');
  assert.equal(f.calls.filter(c => c[0] === 'batch').length, 1);
});

test('invalid captured paths fail before any delete; empty selections do not query', async () => {
  const f = fixture({ [path()]: order() });
  await assert.rejects(f.api.deleteOrders([path(), 'admins/root']), { code: 'invalid-order' });
  const empty = await f.api.deleteOrders([]);
  assert.equal(empty.deleted, 0);
  assert.equal(f.calls.length, 0);
});

test('explicit invalidation and different-account replacement reject pending operations', async () => {
  for (const invalidate of [f => f.api.invalidate(), f => { f.auth.currentUser = { uid: 'bob' }; }]) {
    const f = fixture({ [path()]: order() });
    const wait = deferred();
    const read = f.fs.getDocsFromServer;
    f.fs.getDocsFromServer = async ref => { await wait.promise; return read(ref); };
    const pending = f.api.listOrders('all');
    await Promise.resolve();
    invalidate(f);
    wait.resolve();
    await assert.rejects(pending, { code: 'stale-user' });
  }
});

test('injected onAuthStateChanged invalidates same-UID session and disposal unsubscribes', async () => {
  const f = fixture({ [path()]: order() });
  let notify;
  let unsubscribed = false;
  const api = createAdminOrders({ db: {}, fs: f.fs, auth: f.auth,
    onAuthStateChanged(auth, callback) {
      assert.equal(auth, f.auth);
      notify = callback;
      callback(auth.currentUser);
      return () => { unsubscribed = true; };
    } });
  const wait = deferred();
  f.fs.getDocFromServer = async () => { await wait.promise; return { exists: () => true }; };
  const pending = api.updateStatus(path(), 'In Queue', 'Shipped');
  notify(null);
  notify(f.auth.currentUser);
  wait.resolve();
  await assert.rejects(pending, { code: 'stale-user' });
  api.dispose();
  assert.equal(unsubscribed, true);
  await assert.rejects(api.listOrders(), { code: 'stale-user' });
});

test('explicit expected UID prevents deferred UI actions from starting as a different account', async () => {
  const f = fixture({ [path()]: order() });
  f.docs.set('admins/other-admin', {});
  f.changeAuth({ uid: 'other-admin' });
  await assert.rejects(f.api.listOrders('all', 'root'), { code: 'stale-user' });
  await assert.rejects(f.api.updateStatus(path(), 'In Queue', 'Cancelled', '', 'root'), { code: 'stale-user' });
  await assert.rejects(f.api.deleteOrders([path()], () => {}, 'root'), { code: 'stale-user' });
  assert.equal(f.calls.length, 0);
});

test('offline deletion fails without queueing writes and cannot resume under a new login', async () => {
  const f = fixture({ [path()]: order() });
  const offline = Object.assign(new Error('offline'), { code: 'unavailable' });
  f.fs.runTransaction = async (_, callback) => {
    await callback({
      get: async () => ({ exists: () => true }),
      delete: () => {}
    });
    throw offline;
  };
  const result = await f.api.deleteOrders([path()]);
  assert.equal(result.deleted, 0);
  assert.deepEqual(result.remainingPaths, [path()]);
  assert.equal(result.error, offline);
  f.changeAuth(null); f.changeAuth({ uid: 'root' });
  assert.equal(f.docs.has(path()), true);
  assert.equal(f.calls.some(call => call[0] === 'batch'), false);
});

test('deletion transaction retries recheck membership and account epoch before staging deletes', async () => {
  for (const revoke of [false, true]) {
    const f = fixture({ [path()]: order() });
    let staged = 0;
    f.fs.runTransaction = async (_, callback) => {
      const transaction = {
        get: async () => ({ exists: () => f.docs.has('admins/root') }),
        delete: () => { staged++; }
      };
      await callback(transaction);
      if (revoke) f.docs.delete('admins/root');
      else { f.changeAuth(null); f.changeAuth({ uid: 'root' }); }
      return callback(transaction);
    };
    const result = await f.api.deleteOrders([path()]);
    assert.equal(result.deleted, 0);
    assert.equal(result.remaining, 1);
    assert.equal(result.error.code, revoke ? 'permission-denied' : 'stale-user');
    assert.equal(staged, 1);
    assert.equal(f.docs.has(path()), true);
  }
});

test('auth switch during deletion transaction membership read stages no destructive writes', async () => {
  for (const nextUid of ['root', 'other-admin']) {
    const f = fixture({ [path()]: order() });
    let staged = 0;
    f.fs.runTransaction = async (_, callback) => callback({
      get: async () => {
        f.changeAuth(null);
        f.changeAuth({ uid: nextUid });
        return { exists: () => true };
      },
      delete: () => { staged++; }
    });
    const result = await f.api.deleteOrders([path()]);
    assert.equal(result.error.code, 'stale-user');
    assert.equal(result.deleted, 0);
    assert.equal(result.remaining, 1);
    assert.equal(staged, 0);
    assert.equal(f.docs.has(path()), true);
  }
});

test('offline server authorization fails before deletion can stage any writes', async () => {
  const f = fixture({ [path()]: order() });
  f.fs.getDocFromServer = async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
  const result = await f.api.deleteOrders([path()]);
  assert.equal(result.error.code, 'unavailable');
  assert.equal(result.deleted, 0);
  assert.equal(f.docs.has(path()), true);
  assert.equal(f.calls.some(call => call[0] === 'batch'), false);
});

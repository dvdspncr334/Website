// Unit tests for the shared cart store (cart-store.js) and the Firestore
// backend adapter (cart-firebase.js), using in-memory fakes for browser
// storage, Firebase Auth and Firestore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCartStore, planMutation, sanitizeItem, safeImg, itemKey, migrateLegacyCart,
  CartError, CART_LIMITS, GUEST_CART_KEY, GUEST_SELECTION_KEY, GUEST_BACKUP_KEY,
  LEGACY_CART_KEY, LEGACY_SELECTION_KEY, ACCOUNT_SELECTION_PREFIX
} from '../cart-store.js';
import { createFirestoreCartBackend } from '../cart-firebase.js';

const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

/* ---------- Fakes ---------- */

// Shared browser storage. Each "tab" gets its own view; writes fire
// `storage` events in the other tabs only, like real browsers.
function createBrowser() {
  const data = new Map();
  const tabs = new Set();
  function view(tab) {
    return {
      getItem: key => (data.has(key) ? data.get(key) : null),
      setItem(key, value) {
        if (tab.quotaExceeded) throw new Error('QuotaExceededError');
        data.set(key, String(value));
        for (const other of tabs) if (other !== tab) other.fire({ key });
      },
      removeItem(key) {
        data.delete(key);
        for (const other of tabs) if (other !== tab) other.fire({ key });
      },
      keys: () => Array.from(data.keys())
    };
  }
  function openTab() {
    const tab = { handlers: [], quotaExceeded: false, fire(event) { for (const h of this.handlers) h(event); } };
    tabs.add(tab);
    tab.local = view(tab);
    const sessionData = new Map();
    tab.session = {
      getItem: key => (sessionData.has(key) ? sessionData.get(key) : null),
      setItem: (key, value) => sessionData.set(key, String(value)),
      removeItem: key => sessionData.delete(key),
      keys: () => Array.from(sessionData.keys())
    };
    tab.sessionData = sessionData;
    return tab;
  }
  return { data, openTab };
}

// Firebase Auth (shared across tabs of one browser) + Firestore server.
function createCloud() {
  const docs = new Map(); // uid -> { items, version }
  const listeners = new Map(); // uid -> Set
  const counters = { writes: 0, transactions: 0 };
  const faults = { subscribe: null, mutation: [], beforeCommit: null, holdSnapshots: false, held: [] };

  function deliver(uid) {
    const doc = docs.get(uid);
    for (const l of listeners.get(uid) || []) {
      const snap = { exists: Boolean(doc), items: doc ? structuredClone(doc.items) : null, fromCache: false };
      const send = () => l.active && l.onData(snap);
      if (faults.holdSnapshots) faults.held.push(send);
      else setImmediate(send);
    }
  }

  function write(uid, items) {
    const prev = docs.get(uid);
    docs.set(uid, { items: structuredClone(items), version: (prev ? prev.version : 0) + 1 });
    counters.writes += 1;
    deliver(uid);
  }

  function browserAuth() {
    const callbacks = new Set();
    return {
      uid: null,
      callbacks,
      emit(uid) {
        this.uid = uid;
        for (const cb of callbacks) setImmediate(() => cb(uid));
      }
    };
  }

  function backendFor(auth) {
    return {
      currentUid: () => auth.uid,
      onAuthChanged(cb) {
        auth.callbacks.add(cb);
        setImmediate(() => cb(auth.uid)); // like onAuthStateChanged's first call
        return () => auth.callbacks.delete(cb);
      },
      subscribeCart(uid, onData, onError) {
        const entry = { onData, active: true };
        setImmediate(() => {
          if (!entry.active) return;
          if (faults.subscribe) { entry.active = false; return onError(faults.subscribe); }
          if (auth.uid !== uid) { entry.active = false; return onError({ code: 'permission-denied' }); }
          if (!listeners.has(uid)) listeners.set(uid, new Set());
          listeners.get(uid).add(entry);
          const doc = docs.get(uid);
          const snap = { exists: Boolean(doc), items: doc ? structuredClone(doc.items) : null, fromCache: false };
          if (faults.holdSnapshots) faults.held.push(() => entry.active && onData(snap));
          else onData(snap);
        });
        return () => {
          entry.active = false;
          listeners.get(uid)?.delete(entry);
        };
      },
      // Optimistic transaction: retries when the doc changed underneath.
      async mutateCart(uid, plan, isCurrent) {
        counters.transactions += 1;
        const fault = faults.mutation.shift();
        if (fault) throw fault;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const before = docs.get(uid);
          const version = before ? before.version : 0;
          await new Promise(resolve => setImmediate(resolve));
          const change = await plan(before ? structuredClone(before.items) : null);
          if (faults.beforeCommit) await faults.beforeCommit();
          if (!isCurrent()) throw new CartError('stale-scope', 'stale');
          if (auth.uid !== uid) throw { code: 'permission-denied' }; // security rules
          const now = docs.get(uid);
          if ((now ? now.version : 0) !== version) continue; // contention -> retry
          if (change.changed) write(uid, change.items);
          return change.result;
        }
        throw { code: 'aborted' };
      }
    };
  }

  return { docs, counters, faults, write, browserAuth, backendFor, release() { const h = faults.held.splice(0); h.forEach(f => f()); } };
}

function openStore(browser, cloud, auth, options = {}) {
  const tab = browser.openTab();
  const store = createCartStore({
    localStorage: tab.local,
    sessionStorage: tab.session,
    loadBackend: options.loadBackend || (async () => cloud.backendFor(auth)),
    onStorageEvent: handler => tab.handlers.push(handler)
  });
  const states = [];
  store.subscribe(state => states.push(state));
  store.start();
  return { store, tab, states, ids: () => store.getState().items.map(i => i.id).sort() };
}

const item = (id, qty = 1, extra = {}) => ({ id, title: id, price: 10, img: 'images/a.png', qty, ...extra });
const guestRaw = browser => browser.data.get(GUEST_CART_KEY);

async function remoteItems(cloud, uid) {
  const doc = cloud.docs.get(uid);
  return doc ? Object.values(doc.items).map(i => `${i.id}x${i.qty}`).sort() : null;
}

/* ---------- Scope isolation ---------- */

test('guest -> A -> guest -> B -> guest keeps every cart isolated and untouched', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store, states } = openStore(browser, cloud, auth);
  assert.equal(store.getState().status, 'loading');
  assert.equal(store.getState().canMutate, false);
  await settle();

  await store.addItem(item('guest-strat', 2));
  const guestSnapshot = guestRaw(browser);
  assert.equal(store.getState().count, 2);

  // A has a saved cart already.
  auth.uid = 'A';
  await cloud.backendFor(auth).mutateCart('A', raw => planMutation(raw, items => items.set('a-tele', sanitizeItem(item('a-tele', 1)))), () => true);
  auth.uid = null;

  states.length = 0;
  auth.emit('A');
  await settle();
  // Old cart and badge were cleared before A's cart was shown.
  assert.equal(states[0].scope, 'account');
  assert.equal(states[0].count, 0);
  assert.equal(states[0].hasData, false);
  assert.equal(store.getState().status, 'ready');
  assert.deepEqual(store.getState().items.map(i => i.id), ['a-tele']);
  await store.addItem(item('a-jazz', 1));
  await settle();
  assert.deepEqual(await remoteItems(cloud, 'A'), ['a-jazzx1', 'a-telex1']);
  assert.equal(guestRaw(browser), guestSnapshot, 'guest storage must not change while signed in');

  auth.emit(null);
  await settle();
  assert.equal(store.getState().scope, 'guest');
  assert.deepEqual(store.getState().items.map(i => `${i.id}x${i.qty}`), ['guest-stratx2']);
  assert.equal(guestRaw(browser), guestSnapshot);

  auth.emit('B');
  await settle();
  assert.equal(store.getState().status, 'ready');
  assert.deepEqual(store.getState().items, [], 'B has no saved cart, so it is empty');
  await store.addItem(item('b-only', 3));
  await settle();
  assert.deepEqual(await remoteItems(cloud, 'B'), ['b-onlyx3']);
  assert.deepEqual(await remoteItems(cloud, 'A'), ['a-jazzx1', 'a-telex1']);

  auth.emit(null);
  await settle();
  assert.deepEqual(store.getState().items.map(i => `${i.id}x${i.qty}`), ['guest-stratx2']);
  assert.equal(guestRaw(browser), guestSnapshot);
});

test('a new account starts empty even when the guest cart has items, and nothing is copied', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store } = openStore(browser, cloud, auth);
  await settle();
  await store.addItem(item('guest-only', 4));
  auth.emit('NEW');
  await settle();
  assert.equal(store.getState().status, 'ready');
  assert.equal(store.getState().count, 0);
  assert.equal(cloud.docs.has('NEW'), false, 'no automatic import into the account');
  assert.equal(cloud.counters.transactions, 0);
});

test('same-account refresh loads the account cart, never the guest cart', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const first = openStore(browser, cloud, auth);
  await settle();
  await first.store.addItem(item('guest-item'));
  auth.emit('A');
  await settle();
  await first.store.addItem(item('a-item', 2));
  await settle();

  // Reload: a new page/store while Firebase restores the same user.
  const reloaded = openStore(browser, cloud, auth);
  assert.equal(reloaded.store.getState().hasData, false);
  await settle();
  assert.deepEqual(reloaded.ids(), ['a-item']);
  assert.equal(reloaded.states.some(s => s.items.some(i => i.id === 'guest-item')), false,
    'the guest cart must never flash while restoring a signed-in session');
});

test('legacy shared cart migrates once to the guest cart only', async () => {
  const browser = createBrowser();
  browser.data.set(LEGACY_CART_KEY, JSON.stringify([item('old-1', 2), item('old-2')]));
  browser.data.set(LEGACY_SELECTION_KEY, JSON.stringify(['old-1']));
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  auth.uid = 'A';
  const { store } = openStore(browser, cloud, auth);
  await settle();
  assert.equal(store.getState().scope, 'account');
  assert.deepEqual(store.getState().items, []);
  assert.equal(cloud.docs.has('A'), false, 'legacy data is never imported into an account');
  assert.equal(browser.data.has(LEGACY_CART_KEY), false);
  assert.equal(browser.data.has(LEGACY_SELECTION_KEY), false);

  auth.emit(null);
  await settle();
  assert.deepEqual(store.getState().items.map(i => `${i.id}x${i.qty}`), ['old-1x2', 'old-2x1']);
  assert.deepEqual(Array.from(store.getSelection()), ['old-1']);

  // Runs only once: a later legacy write (e.g. an old cached tab) is not imported.
  browser.data.set(LEGACY_CART_KEY, JSON.stringify([item('late')]));
  assert.equal(migrateLegacyCart(browser.openTab().local), false);
  assert.equal(JSON.parse(guestRaw(browser)).some(i => i.id === 'late'), false);
});

/* ---------- Stale async work ---------- */

test('cache-only snapshots before server data are not treated as an empty cart', async () => {
  const browser = createBrowser();
  const tab = browser.openTab();
  let push;
  const backend = {
    currentUid: () => 'A',
    onAuthChanged: cb => setImmediate(() => cb('A')),
    subscribeCart: (uid, onData) => { push = onData; return () => {}; },
    mutateCart: async () => { throw new Error('should not be called'); }
  };
  const store = createCartStore({ localStorage: tab.local, sessionStorage: tab.session, loadBackend: async () => backend });
  store.start();
  await settle();
  push({ exists: false, items: null, fromCache: true });
  assert.equal(store.getState().status, 'offline');
  assert.equal(store.getState().hasData, false);
  assert.equal(store.getState().canMutate, false);
  await assert.rejects(store.addItem(item('x')), e => e.code === 'offline');
  push({ exists: true, items: { [await itemKey('srv')]: item('srv') }, fromCache: false });
  assert.equal(store.getState().status, 'ready');
  assert.deepEqual(store.getState().items.map(i => i.id), ['srv']);
  push({ exists: true, items: { [await itemKey('srv')]: item('srv') }, fromCache: true });
  assert.equal(store.getState().status, 'offline', 'connection loss pauses changes but keeps last server data');
});

test('a delayed snapshot from A is ignored after switching to B', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  auth.uid = 'A';
  cloud.write('A', { [await itemKey('a-secret')]: sanitizeItem(item('a-secret')) });
  cloud.faults.holdSnapshots = true;
  const { store } = openStore(browser, cloud, auth);
  await settle();
  assert.equal(store.getState().status, 'loading');
  cloud.faults.holdSnapshots = false;
  auth.emit('B');
  await settle();
  cloud.release(); // A's late snapshot arrives now
  await settle();
  assert.equal(store.getState().scope, 'account');
  assert.equal(store.getState().scopeKey, 'account:B');
  assert.deepEqual(store.getState().items, []);
});

test('an in-flight write from A cannot touch guest or B after an account switch', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store } = openStore(browser, cloud, auth);
  await settle();
  await store.addItem(item('guest-item'));
  const guestSnapshot = guestRaw(browser);
  auth.emit('A');
  await settle();

  let release;
  cloud.faults.beforeCommit = () => new Promise(resolve => { release = resolve; });
  const pendingWrite = store.addItem(item('a-late'));
  await settle();
  assert.equal(store.getState().saving, true);
  cloud.faults.beforeCommit = null;
  auth.emit('B');
  await settle();
  release();
  await assert.rejects(pendingWrite, e => e.code === 'stale-scope');
  await settle();
  assert.equal(cloud.docs.has('A'), false, 'A was not written after the switch');
  assert.equal(cloud.docs.has('B'), false, 'B was never written');
  assert.equal(guestRaw(browser), guestSnapshot);
  assert.equal(store.getState().scopeKey, 'account:B');
  assert.equal(store.getState().error, null, 'stale failures do not leak into the new scope');
  assert.equal(store.getState().pending, 0);
});

test('mutations are rejected while the scope is loading', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store } = openStore(browser, cloud, auth);
  await assert.rejects(store.addItem(item('too-early')), e => e.code === 'not-ready');
  await settle();
  auth.emit('A');
  await new Promise(resolve => setImmediate(resolve)); // auth callback ran; A's cart not loaded yet
  assert.equal(store.getState().scopeKey, 'account:A');
  assert.equal(store.getState().status, 'loading');
  await assert.rejects(store.addItem(item('during-switch')), e => e.code === 'not-ready');
  await settle();
  assert.equal(guestRaw(browser), undefined);
  assert.equal(cloud.docs.has('A'), false);
});

/* ---------- Multi-tab ---------- */

test('multiple tabs follow guest storage changes and shared sign-in switches', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const tab1 = openStore(browser, cloud, auth);
  const tab2 = openStore(browser, cloud, auth);
  await settle();
  await tab1.store.addItem(item('from-tab1'));
  assert.deepEqual(tab2.ids(), ['from-tab1'], 'guest change seen via storage event');

  auth.emit('A'); // Firebase Auth syncs sign-in across tabs
  await settle();
  await tab2.store.addItem(item('a-from-tab2', 2));
  await settle();
  assert.deepEqual(tab1.ids(), ['a-from-tab2']);

  // While signed in, a guest-storage event (e.g. old tab) must not show guest data.
  tab2.tab.fire({ key: GUEST_CART_KEY });
  assert.deepEqual(tab2.ids(), ['a-from-tab2']);

  auth.emit('B');
  await settle();
  assert.deepEqual(tab1.ids(), []);
  assert.deepEqual(tab2.ids(), []);
  auth.emit(null);
  await settle();
  assert.deepEqual(tab1.ids(), ['from-tab1']);
  assert.deepEqual(tab2.ids(), ['from-tab1']);
});

/* ---------- Sync between devices ---------- */

test('concurrent changes from two devices on the same account are not lost', async () => {
  const cloud = createCloud();
  const phoneAuth = cloud.browserAuth();
  const laptopAuth = cloud.browserAuth();
  phoneAuth.uid = 'A';
  laptopAuth.uid = 'A';
  const phone = openStore(createBrowser(), cloud, phoneAuth);
  const laptop = openStore(createBrowser(), cloud, laptopAuth);
  await settle();
  await Promise.all([
    phone.store.addItem(item('strat', 2)),
    laptop.store.addItem(item('strat', 3)),
    laptop.store.addItem(item('tele', 1))
  ]);
  await settle();
  assert.deepEqual(await remoteItems(cloud, 'A'), ['stratx5', 'telex1']);
  assert.deepEqual(phone.store.getState().items.map(i => `${i.id}x${i.qty}`).sort(), ['stratx5', 'telex1']);
  await Promise.all([phone.store.changeQty('strat', -1), laptop.store.removeItems(['tele'])]);
  await settle();
  assert.deepEqual(laptop.store.getState().items.map(i => `${i.id}x${i.qty}`), ['stratx4']);
});

/* ---------- Failures ---------- */

test('load failures surface an error with retry and never show an empty cart', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  auth.uid = 'A';
  cloud.write('A', { [await itemKey('saved')]: sanitizeItem(item('saved')) });
  cloud.faults.subscribe = { code: 'permission-denied' };
  const { store } = openStore(browser, cloud, auth);
  await settle();
  let state = store.getState();
  assert.equal(state.status, 'error');
  assert.equal(state.hasData, false);
  assert.equal(state.canRetry, true);
  assert.match(state.error.message, /permission denied/);
  await assert.rejects(store.addItem(item('x')), e => e.code === 'unavailable');
  cloud.faults.subscribe = null;
  await store.retry();
  await settle();
  state = store.getState();
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.items.map(i => i.id), ['saved']);
});

test('save failures are reported honestly and can be retried', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  auth.uid = 'A';
  const { store } = openStore(browser, cloud, auth);
  await settle();
  cloud.faults.mutation.push({ code: 'unavailable' });
  await assert.rejects(store.addItem(item('net', 2)), e => e instanceof CartError && /connection/.test(e.message));
  await settle();
  let state = store.getState();
  assert.equal(state.saving, false);
  assert.equal(state.error.kind, 'save');
  assert.equal(state.canRetry, true);
  assert.deepEqual(state.items, [], 'nothing is shown as saved after a failure');
  assert.equal(cloud.docs.has('A'), false);
  await store.retry();
  await settle();
  state = store.getState();
  assert.equal(state.error, null);
  assert.deepEqual(state.items.map(i => `${i.id}x${i.qty}`), ['netx2']);
});

test('auth/SDK load failure hides the cart and can be retried', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  let attempts = 0;
  const { store } = openStore(browser, cloud, auth, {
    loadBackend: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('CDN unreachable');
      return cloud.backendFor(auth);
    }
  });
  browser.data.set(GUEST_CART_KEY, JSON.stringify([item('guest')]));
  await settle();
  assert.equal(store.getState().status, 'error');
  assert.equal(store.getState().count, 0);
  await store.retry();
  await settle();
  assert.equal(store.getState().scope, 'guest');
  assert.deepEqual(store.getState().items.map(i => i.id), ['guest']);
});

test('guest storage failures keep the cart unchanged and report the problem', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store, tab } = openStore(browser, cloud, auth);
  await settle();
  await store.addItem(item('kept'));
  tab.quotaExceeded = true;
  await assert.rejects(store.addItem(item('lost')), e => e.code === 'storage');
  assert.deepEqual(store.getState().items.map(i => i.id), ['kept']);
  assert.equal(store.getState().error.kind, 'save');
  tab.quotaExceeded = false;
  await store.retry();
  assert.deepEqual(store.getState().items.map(i => i.id), ['kept', 'lost']);
});

test('unreadable guest data is set aside with a notice instead of being silently dropped', async () => {
  const browser = createBrowser();
  browser.data.set(GUEST_CART_KEY, '{not json');
  const cloud = createCloud();
  const { store } = openStore(browser, cloud, cloud.browserAuth());
  await settle();
  assert.equal(store.getState().status, 'ready');
  assert.match(store.getState().notice, /set aside/);
  assert.equal(browser.data.get(GUEST_BACKUP_KEY), '{not json');
});

/* ---------- Items, variants and selection ---------- */

test('variant identity: options and custom notes are separate lines, same variant merges', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  auth.uid = 'A';
  const { store } = openStore(browser, cloud, auth);
  await settle();
  await store.addItem(item('strat (Right, HSS, Black)', 1));
  await store.addItem(item('strat (Left, HSS, Black)', 1));
  await store.addItem(item('strat (Right, HSS, Custom Color: sunburst)', 1, { price: 230 }));
  await store.addItem(item('strat (Right, HSS, Custom Color: teal)', 1, { price: 230 }));
  await store.addItem(item('strat (Right, HSS, Black)', 2));
  await settle();
  assert.deepEqual(await remoteItems(cloud, 'A'), [
    'strat (Left, HSS, Black)x1',
    'strat (Right, HSS, Black)x3',
    'strat (Right, HSS, Custom Color: sunburst)x1',
    'strat (Right, HSS, Custom Color: teal)x1'
  ]);
  const key = await itemKey('strat (Right, HSS, Black)');
  assert.match(key, /^k[0-9a-f]{64}$/);
  assert.ok(cloud.docs.get('A').items[key]);
});

test('quantities and line counts are bounded', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const { store } = openStore(browser, cloud, cloud.browserAuth());
  await settle();
  const first = await store.addItem(item('big', 98));
  assert.equal(first.clamped, false);
  const second = await store.addItem(item('big', 5));
  assert.equal(second.clamped, true);
  assert.equal(store.getState().items[0].qty, CART_LIMITS.maxQty);
  await assert.rejects(store.addItem(item('zero', 0)), e => e.code === 'invalid-item');
  await assert.rejects(store.addItem(item('frac', 1.5)), e => e.code === 'invalid-item');
  await assert.rejects(store.addItem({ id: 'x'.repeat(400), title: 't', price: 1, qty: 1 }), e => e.code === 'invalid-item');
  await assert.rejects(store.addItem(item('neg', 1, { price: -5 })), e => e.code === 'invalid-item');
  for (let i = 1; i < CART_LIMITS.maxLines; i += 1) await store.addItem(item(`line-${i}`));
  await assert.rejects(store.addItem(item('one-too-many')), e => e.code === 'cart-full');
  await store.changeQty('big', -200);
  assert.equal(store.getState().items.find(i => i.id === 'big').qty, 1);
});

test('selection is scoped: guest selection persists locally, account selection is per-tab and cleared on sign-out', async () => {
  const browser = createBrowser();
  const cloud = createCloud();
  const auth = cloud.browserAuth();
  const { store, tab } = openStore(browser, cloud, auth);
  await settle();
  await store.addItem(item('g1'));
  await store.addItem(item('g2'));
  store.setSelection(['g2']);
  assert.equal(browser.data.get(GUEST_SELECTION_KEY), '["g2"]');

  auth.emit('A');
  await settle();
  await store.addItem(item('a1'));
  await settle();
  assert.deepEqual(Array.from(store.getSelection()), ['a1'], 'guest selection does not apply to A');
  store.setSelection([]);
  assert.equal(tab.sessionData.get(`${ACCOUNT_SELECTION_PREFIX}A`), '[]');
  assert.equal(browser.data.get(GUEST_SELECTION_KEY), '["g2"]');

  auth.emit(null);
  await settle();
  assert.equal(tab.sessionData.has(`${ACCOUNT_SELECTION_PREFIX}A`), false);
  assert.deepEqual(Array.from(store.getSelection()), ['g2']);
});

test('sanitizeItem keeps display data bounded and rejects unsafe image URLs', () => {
  assert.equal(safeImg('javascript:alert(1)'), 'images/placeholder.png');
  assert.equal(safeImg('data:image/png;base64,xx'), 'images/placeholder.png');
  assert.equal(safeImg('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(safeImg('images/Stratocaster/CTS/Black.png'), 'images/Stratocaster/CTS/Black.png');
  assert.deepEqual(sanitizeItem({ id: 7, title: '', price: '179.3415', qty: '250', img: '' }),
    { id: '7', title: 'Item', price: 179.34, img: 'images/placeholder.png', qty: 99 });
  assert.equal(sanitizeItem({ id: '', price: 1 }), null);
  assert.equal(sanitizeItem(null), null);
});

test('planMutation changes only the touched line and keeps other entries intact', async () => {
  const keep = await itemKey('keep');
  const raw = { [keep]: item('keep', 2), kweird: { unexpected: true } };
  const plan = await planMutation(raw, items => items.set('new', sanitizeItem(item('new'))));
  assert.equal(plan.changed, true);
  assert.equal(plan.lastKey, await itemKey('new'));
  assert.deepEqual(plan.items.kweird, { unexpected: true });
  assert.deepEqual(plan.items[keep], item('keep', 2));
  const noop = await planMutation(raw, () => ({}));
  assert.equal(noop.changed, false);
  await assert.rejects(planMutation({}, items => { items.set('a', sanitizeItem(item('a'))); items.set('b', sanitizeItem(item('b'))); }),
    e => e.code === 'internal');
});

/* ---------- Firestore adapter ---------- */

test('Firestore backend uses users/{uid}/carts/current, metadata snapshots and guarded transactions', async () => {
  const calls = [];
  const stored = { items: { k1: item('x') } };
  const fs = {
    doc: (db, ...path) => path.join('/'),
    onSnapshot(ref, options, next) {
      calls.push(['onSnapshot', ref, options]);
      next({ exists: () => true, get: () => stored.items, metadata: { fromCache: true } });
      return () => calls.push(['unsubscribe', ref]);
    },
    serverTimestamp: () => 'SERVER_TIME',
    async runTransaction(db, fn) {
      const tx = {
        get: async ref => ({ exists: () => true, get: () => stored.items, ref }),
        set: (ref, data) => calls.push(['set', ref, data])
      };
      return fn(tx);
    }
  };
  const auth = { currentUser: { uid: 'A' } };
  const backend = createFirestoreCartBackend({ db: 'db', auth, onUserChanged: () => () => {}, fs });
  const seen = [];
  backend.subscribeCart('A', snap => seen.push(snap), () => {});
  assert.deepEqual(calls[0], ['onSnapshot', 'users/A/carts/current', { includeMetadataChanges: true }]);
  assert.deepEqual(seen[0], { exists: true, items: stored.items, fromCache: true });

  await backend.mutateCart('A', async () => ({ changed: true, items: { k2: 1 }, lastKey: 'k2', result: 'ok' }), () => true);
  const set = calls.find(c => c[0] === 'set');
  assert.deepEqual(set, ['set', 'users/A/carts/current', { items: { k2: 1 }, lastKey: 'k2', schema: 1, updatedAt: 'SERVER_TIME' }]);

  calls.length = 0;
  await assert.rejects(
    backend.mutateCart('A', async () => ({ changed: true, items: {}, lastKey: 'k', result: 'x' }), () => false),
    e => e.code === 'stale-scope'
  );
  assert.equal(calls.some(c => c[0] === 'set'), false, 'stale writes are never sent');
  assert.equal(backend.currentUid(), 'A');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIPPING_FIELD_NAMES, normalizeShipping, validateShipping, hasShippingAddress, formatShippingLines, summarizeShipping,
  createOrderId, buildOrder, normalizeOrder, sortOrdersNewestFirst, isValidOrderReference, friendlyAccountError,
  createAccountData, AccountDataError, isValidContactEmail
} from '../account-data.js';

const address = (extra = {}) => ({
  firstName: 'Ada', lastName: 'Lovelace', streetAddress1: '1 Main St', streetAddress2: '', city: 'Austin',
  state: 'TX', postalCode: '78701', country: 'United States', phone: '', deliveryNotes: '', ...extra
});
const item = (id, qty = 1, price = 100) => ({ id, title: id, img: 'images/a.png', qty, price });

test('normalizeShipping trims every field, fills missing ones and drops unknown fields', () => {
  const shipping = normalizeShipping({ firstName: '  Ada ', city: '\tAustin\n', evil: '<script>', phone: 5 });
  assert.deepEqual(Object.keys(shipping), SHIPPING_FIELD_NAMES);
  assert.equal(shipping.firstName, 'Ada');
  assert.equal(shipping.city, 'Austin');
  assert.equal(shipping.phone, '5');
  assert.equal(shipping.lastName, '');
  assert.equal('evil' in shipping, false);
  assert.deepEqual(normalizeShipping(null), Object.fromEntries(SHIPPING_FIELD_NAMES.map(name => [name, ''])));
});

test('validateShipping requires the required fields, accepts any optional phone text and enforces lengths', () => {
  assert.deepEqual(validateShipping(address()), {});
  assert.deepEqual(validateShipping(address({ phone: 'call after 5pm', streetAddress2: 'Apt 4' })), {});
  const errors = validateShipping(address({ firstName: '   ', country: '', postalCode: 'x'.repeat(21) }));
  assert.deepEqual(Object.keys(errors).sort(), ['country', 'firstName', 'postalCode']);
  assert.match(errors.firstName, /required/);
  assert.match(errors.postalCode, /20 characters/);
  assert.equal(Object.keys(validateShipping({})).length, 7);
});

test('address helpers format readable lines and summaries', () => {
  assert.equal(hasShippingAddress(address()), true);
  assert.equal(hasShippingAddress({ phone: '555' }), false);
  assert.deepEqual(formatShippingLines(address({ streetAddress2: 'Apt 4', phone: '555' })),
    ['Ada Lovelace', '1 Main St', 'Apt 4', 'Austin, TX 78701', 'United States', 'Phone: 555']);
  assert.equal(summarizeShipping(address()), 'Ada Lovelace — 1 Main St — Austin, TX, 78701, United States');
});

test('order ids keep the JGV-######## format', () => {
  assert.equal(createOrderId(1700000012345), 'JGV-00012345');
  assert.equal(createOrderId(42), 'JGV-00000042');
  assert.match(createOrderId(), /^JGV-\d{8}$/);
});

test('buildOrder creates an In Queue order with trimmed shipping, notes, email and total', () => {
  const now = new Date(1700000012345);
  const order = buildOrder({ items: [item('strat', 2, 199.99), item('tele', 1, 50)], shipping: address({ city: ' Austin ' }), notes: ' rush ', email: 'a@b.co', now });
  assert.deepEqual(Object.keys(order).sort(), ['date', 'email', 'id', 'items', 'notes', 'shipping', 'status', 'total']);
  assert.equal(order.id, 'JGV-00012345');
  assert.equal(order.date, now.toISOString());
  assert.equal(order.status, 'In Queue');
  assert.equal(order.total, 449.98);
  assert.equal(order.notes, 'rush');
  assert.equal(order.shipping.city, 'Austin');
  assert.deepEqual(order.items[0], { id: 'strat', title: 'strat', img: 'images/a.png', qty: 2, price: 199.99 });
});

test('buildOrder rejects empty carts, invalid items, missing shipping and long notes', () => {
  assert.throws(() => buildOrder({ items: [], shipping: address() }), { code: 'invalid-order' });
  assert.throws(() => buildOrder({ items: [item('a', 0)], shipping: address() }), { code: 'invalid-order' });
  assert.throws(() => buildOrder({ items: [item('a', 1, -5)], shipping: address() }), { code: 'invalid-order' });
  assert.throws(() => buildOrder({ items: Array.from({ length: 51 }, (_, i) => item(`i${i}`)), shipping: address() }), { code: 'invalid-order' });
  assert.throws(() => buildOrder({ items: [item('a')], shipping: address({ city: '' }) }), { code: 'invalid-shipping' });
  assert.throws(() => buildOrder({ items: [item('a')], shipping: address(), notes: 'x'.repeat(1001) }), { code: 'invalid-order' });
});

test('normalizeOrder makes stored orders safe to display', () => {
  const order = normalizeOrder({ status: 'Hacked', items: [{ id: 'a', qty: 'x', price: 'y' }], shipping: { city: ' Austin ' }, createdAt: { toDate: () => new Date(0) } }, 'JGV-00000001');
  assert.equal(order.id, 'JGV-00000001');
  assert.equal(order.docId, 'JGV-00000001');
  assert.equal(order.status, 'In Queue');
  assert.equal(order.date, new Date(0).toISOString());
  assert.deepEqual(order.items, [{ id: 'a', title: 'Item', img: '', qty: 1, price: 0 }]);
  assert.equal(order.total, 0);
  assert.equal(order.shipping.city, 'Austin');
  const sorted = sortOrdersNewestFirst([{ id: 'old', date: '2024-01-01' }, { id: 'bad', date: 'nope' }, { id: 'new', date: '2025-01-01' }]);
  assert.deepEqual(sorted.map(o => o.id), ['new', 'old', 'bad']);
});

test('order references never allow path segments', () => {
  assert.equal(isValidOrderReference('JGV-00000001'), true);
  for (const bad of ['', '../x', 'a/b', 'x'.repeat(65), null]) assert.equal(isValidOrderReference(bad), false);
});

test('friendlyAccountError maps Firestore errors to buyer-friendly messages', () => {
  assert.match(friendlyAccountError({ code: 'permission-denied' }), /Access was denied/);
  assert.match(friendlyAccountError({ code: 'unavailable' }), /Network problem/);
  assert.equal(friendlyAccountError(new AccountDataError('x', 'Custom message.')), 'Custom message.');
  assert.match(friendlyAccountError(new Error('boom')), /Something went wrong/);
});

function fakeFirestore({ existing = {}, failWith = null } = {}) {
  const docs = new Map(Object.entries(existing));
  const calls = [];
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: () => data !== undefined, data: () => data });
  const fs = {
    doc: (_, ...segments) => segments.join('/'),
    collection: (_, ...segments) => segments.join('/'),
    serverTimestamp: () => 'SERVER_TIME',
    getDoc: async path => { calls.push(['get', path]); if (failWith) throw failWith; return snap(path, docs.get(path)); },
    setDoc: async (path, data) => { calls.push(['set', path, data]); if (failWith) throw failWith; docs.set(path, data); },
    deleteDoc: async path => { calls.push(['delete', path]); docs.delete(path); },
    getDocs: async prefix => {
      calls.push(['list', prefix]);
      const matches = [...docs.entries()].filter(([path]) => path.startsWith(`${prefix}/`));
      return { docs: matches.map(([path, data]) => snap(path, data)) };
    },
    runTransaction: async (_, fn) => {
      const writes = [];
      await fn({ get: async path => snap(path, docs.get(path)), set: (path, data) => writes.push([path, data]) });
      for (const [path, data] of writes) { calls.push(['set', path, data]); docs.set(path, data); }
    }
  };
  return { fs, docs, calls };
}

test('account data reads and writes only the signed-in user\'s documents', async () => {
  const { fs, docs, calls } = fakeFirestore();
  const auth = { currentUser: { uid: 'alice', email: 'alice@example.com' } };
  const api = createAccountData({ db: {}, fs, auth });
  assert.equal(await api.loadShipping('alice'), null);
  await api.saveShipping('alice', address({ firstName: ' Ada ' }));
  assert.deepEqual(docs.get('users/alice/profile/shipping'), { ...address(), lastUpdated: 'SERVER_TIME' });
  assert.equal((await api.loadShipping('alice')).firstName, 'Ada');
  const order = buildOrder({ items: [item('strat')], shipping: address(), email: api.currentEmail() });
  await api.placeOrder('alice', order);
  assert.deepEqual(docs.get(`users/alice/orders/${order.id}`), { ...order, createdAt: 'SERVER_TIME' });
  await assert.rejects(api.placeOrder('alice', order), { code: 'order-exists' });
  assert.deepEqual((await api.listOrders('alice')).map(o => o.id), [order.id]);
  assert.equal((await api.getOrder('alice', order.id)).email, 'alice@example.com');
  assert.equal(await api.getOrder('alice', '../profile/shipping'), null);
  await api.deleteShipping('alice');
  assert.equal(docs.has('users/alice/profile/shipping'), false);
  assert.ok(calls.every(call => call[1].startsWith('users/alice/')));
});

test('account data refuses other or stale users and never writes invalid addresses', async () => {
  const { fs, calls } = fakeFirestore();
  const auth = { currentUser: { uid: 'alice', email: 'alice@example.com' } };
  const api = createAccountData({ db: {}, fs, auth });
  for (const call of [() => api.loadShipping('bob'), () => api.saveShipping('bob', address()), () => api.deleteShipping('bob'),
    () => api.listOrders('bob'), () => api.getOrder('bob', 'JGV-00000001'), () => api.loadShipping('alice/../bob')]) {
    await assert.rejects(call(), { code: 'stale-user' });
  }
  await assert.rejects(api.saveShipping('alice', address({ city: '' })), { code: 'invalid-shipping' });
  await assert.rejects(api.placeOrder('alice', { id: 'bad id' }), { code: 'invalid-order' });
  assert.equal(calls.length, 0);

  // The account changes while a read is in flight: the result is dropped.
  const slow = fakeFirestore({ existing: { 'users/alice/profile/shipping': address() } });
  const slowApi = createAccountData({ db: {}, fs: { ...slow.fs, getDoc: async path => { auth.currentUser = { uid: 'bob' }; return slow.fs.getDoc(path); } }, auth });
  auth.currentUser = { uid: 'alice' };
  await assert.rejects(slowApi.loadShipping('alice'), { code: 'stale-user' });
  auth.currentUser = null;
  await assert.rejects(api.listOrders('alice'), { code: 'stale-user' });
});

test('Firestore errors propagate so pages can show retry messages', async () => {
  const failure = Object.assign(new Error('denied'), { code: 'permission-denied' });
  const { fs } = fakeFirestore({ failWith: failure });
  const api = createAccountData({ db: {}, fs, auth: { currentUser: { uid: 'alice' } } });
  await assert.rejects(api.loadShipping('alice'), error => error === failure);
  await assert.rejects(api.saveShipping('alice', address()), error => error === failure);
});

test('Cancelled orders expose trimmed cancellation reasons without changing initial creation', () => {
  assert.equal(normalizeOrder({ status: 'Cancelled', cancellationReason: ' No stock ' }).cancellationReason, 'No stock');
  assert.equal(normalizeOrder({ status: 'Cancelled' }).status, 'Cancelled');
  assert.equal(normalizeOrder({}).cancellationReason, '');
  assert.equal(buildOrder({ items: [item('a')], shipping: address() }).status, 'In Queue');
});

test('same UID signout/login rejects old account read and transaction work', async () => {
  for (const operation of ['read', 'place']) {
    const { fs, docs } = fakeFirestore({ existing: { 'users/alice/profile/shipping': address() } });
    const auth = { currentUser: { uid: 'alice' } };
    let changed;
    const onUserChanged = callback => { changed = callback; callback(auth.currentUser); return () => {}; };
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    if (operation === 'read') {
      const original = fs.getDoc;
      fs.getDoc = async ref => { await wait; return original(ref); };
    } else {
      fs.runTransaction = async (_, callback) => {
        await callback({ get: async () => { await wait; return { exists: () => false }; },
          set: (ref, data) => docs.set(ref, data) });
      };
    }
    const api = createAccountData({ db: {}, fs, auth, onUserChanged });
    const order = buildOrder({ items: [item('a')], shipping: address() });
    const pending = operation === 'read' ? api.loadShipping('alice') : api.placeOrder('alice', order);
    auth.currentUser = null; changed(null);
    auth.currentUser = { uid: 'alice' }; changed(auth.currentUser);
    release();
    await assert.rejects(pending, { code: 'stale-user' });
    assert.equal(docs.has(`users/alice/orders/${order.id}`), false);
  }
});

test('buyer subscriptions show status updates/deletes and suppress stale callbacks after auth changes', () => {
  const auth = { currentUser: { uid: 'alice' } };
  let changed;
  const callbacks = [];
  let stops = 0;
  const fs = {
    doc: (_, ...parts) => parts.join('/'), collection: (_, ...parts) => parts.join('/'),
    onSnapshot(ref, onNext, onError) { callbacks.push({ ref, onNext, onError }); return () => { stops++; }; }
  };
  const api = createAccountData({ db: {}, fs, auth,
    onUserChanged: callback => { changed = callback; callback(auth.currentUser); return () => {}; } });
  const lists = [];
  const details = [];
  const errors = [];
  const offList = api.subscribeOrders('alice', value => lists.push(value), error => errors.push(error));
  const offDetail = api.subscribeOrder('alice', 'JGV-00000001', value => details.push(value), error => errors.push(error));
  const doc = { id: 'JGV-00000001', exists: () => true,
    data: () => ({ status: 'Cancelled', cancellationReason: 'No stock' }) };
  callbacks[0].onNext({ docs: [doc] }); callbacks[1].onNext(doc);
  assert.equal(lists[0][0].status, 'Cancelled');
  assert.equal(details[0].cancellationReason, 'No stock');
  callbacks[0].onNext({ docs: [] }); callbacks[1].onNext({ exists: () => false });
  assert.deepEqual(lists[1], []);
  assert.equal(details[1], null);
  auth.currentUser = null; changed(null);
  auth.currentUser = { uid: 'alice' }; changed(auth.currentUser);
  callbacks.forEach(callback => { callback.onNext(callback.ref.endsWith('orders') ? { docs: [doc] } : doc); callback.onError(new Error('stale')); });
  assert.equal(lists.length, 2);
  assert.equal(details.length, 2);
  assert.equal(errors.length, 0);
  assert.equal(stops, 2);
  offList(); offDetail();
  assert.throws(() => api.subscribeOrders('bob', () => {}), { code: 'stale-user' });
  assert.throws(() => api.subscribeOrder('alice', '../x', () => {}), { code: 'invalid-order' });
});

test('unsubscribing/disposal suppresses already queued listener events and errors', () => {
  const auth = { currentUser: { uid: 'alice' } };
  let next;
  let error;
  let count = 0;
  const fs = { collection: () => 'collection',
    onSnapshot: (_, onNext, onError) => { next = onNext; error = onError; return () => {}; } };
  const api = createAccountData({ db: {}, fs, auth });
  const off = api.subscribeOrders('alice', () => count++, () => count++);
  off(); next({ docs: [] }); error(new Error('ignored'));
  assert.equal(count, 0);
  api.subscribeOrders('alice', () => count++, () => count++);
  api.dispose(); next({ docs: [] }); error(new Error('ignored'));
  assert.equal(count, 0);
});

test('guest orders need a valid contact email and carry the guest marker; account orders do not', () => {
  const now = new Date(1700000012345);
  const guest = buildOrder({ items: [item('strat')], shipping: address(), email: ' buyer@example.com ', guest: true, now });
  assert.equal(guest.guest, true);
  assert.equal(guest.email, 'buyer@example.com');
  assert.equal('guest' in buildOrder({ items: [item('strat')], shipping: address(), email: 'a@b.co', now }), false);
  for (const email of ['', 'not-an-email', 'a@b', 'a b@example.com', `${'x'.repeat(250)}@example.com`]) {
    assert.equal(isValidContactEmail(email), false, email);
    assert.throws(() => buildOrder({ items: [item('strat')], shipping: address(), email, guest: true, now }), { code: 'invalid-email' });
  }
  assert.equal(isValidContactEmail('first.last+tag@shop.example.co.uk'), true);
  assert.equal(normalizeOrder({ ...guest }, guest.id).guest, true);
  assert.equal(normalizeOrder({ ...guest, guest: 'yes' }, guest.id).guest, false);
});

test('anonymous guest sessions can place and read their own orders but never save an address', async () => {
  const { fs, docs, calls } = fakeFirestore();
  const auth = { currentUser: { uid: 'anon1', email: null, isAnonymous: true } };
  const api = createAccountData({ db: {}, fs, auth });
  assert.equal(api.isAnonymous(), true);
  await assert.rejects(api.saveShipping('anon1', address()), { code: 'guest-session' });
  const order = buildOrder({ items: [item('strat')], shipping: address(), email: 'buyer@example.com', guest: true });
  await api.placeOrder('anon1', order);
  assert.deepEqual(docs.get(`users/anon1/orders/${order.id}`), { ...order, createdAt: 'SERVER_TIME' });
  assert.equal((await api.listOrders('anon1'))[0].guest, true);
  await assert.rejects(api.listOrders('alice'), { code: 'stale-user' });
  assert.ok(calls.every(call => call[1].startsWith('users/anon1/orders')));
});

// Per-account shipping address and orders, stored in Firestore:
//   users/{uid}/profile/shipping   one saved shipping address
//   users/{uid}/orders/{orderId}   one document per order
//
// The uid always comes from the signed-in Firebase user. Every read and write
// re-checks that the same user is still signed in, so data never leaks into
// (or gets written for) a different account after a sign-in change. Nothing
// here is stored in browser storage. firestore.rules enforces owner access
// and separately permits constrained admin order maintenance.

const FIRESTORE_SDK_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

export const SHIPPING_FIELDS = Object.freeze([
  { name: 'firstName', label: 'First name', required: true, max: 80, autocomplete: 'given-name' },
  { name: 'lastName', label: 'Last name', required: true, max: 80, autocomplete: 'family-name' },
  { name: 'streetAddress1', label: 'Street address', required: true, max: 120, autocomplete: 'address-line1', wide: true, hint: 'House number and street name.' },
  { name: 'streetAddress2', label: 'Apartment, suite, unit (optional)', required: false, max: 120, autocomplete: 'address-line2', wide: true },
  { name: 'city', label: 'City', required: true, max: 80, autocomplete: 'address-level2' },
  { name: 'state', label: 'State / Province / Region', required: true, max: 80, autocomplete: 'address-level1' },
  { name: 'postalCode', label: 'Postal / ZIP code', required: true, max: 20, autocomplete: 'postal-code' },
  { name: 'country', label: 'Country', required: true, max: 60, autocomplete: 'country-name', list: true },
  { name: 'phone', label: 'Phone (optional)', required: false, max: 40, autocomplete: 'tel', type: 'tel', hint: 'Only used if there is a problem delivering your order.' },
  { name: 'deliveryNotes', label: 'Delivery notes (optional)', required: false, max: 500, multiline: true, wide: true, hint: 'For example: leave at the side door.' }
]);

export const SHIPPING_FIELD_NAMES = Object.freeze(SHIPPING_FIELDS.map(field => field.name));
export const COUNTRY_SUGGESTIONS = Object.freeze([
  'United States', 'Canada', 'United Kingdom', 'Australia', 'New Zealand', 'Ireland', 'Germany', 'France',
  'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Japan', 'Mexico'
]);
export const ORDER_STATUSES = Object.freeze(['In Queue', 'In Progress', 'Shipped', 'Completed', 'Cancelled']);
export const ORDER_NOTES_MAX = 1000;
export const ORDER_MAX_ITEMS = 50;
const ORDER_ID_RE = /^JGV-[0-9]{8}$/;
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class AccountDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountDataError';
    this.code = code;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());
}

// Returns a plain object with every shipping field as a trimmed string.
// Unknown fields are dropped.
export function normalizeShipping(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const shipping = {};
  for (const name of SHIPPING_FIELD_NAMES) shipping[name] = clean(source[name]);
  return shipping;
}

// Returns { fieldName: message } for every invalid field (empty when valid).
export function validateShipping(raw) {
  const shipping = normalizeShipping(raw);
  const errors = {};
  for (const field of SHIPPING_FIELDS) {
    const value = shipping[field.name];
    if (field.required && !value) errors[field.name] = `${field.label} is required.`;
    else if (value.length > field.max) errors[field.name] = `${field.label} must be ${field.max} characters or fewer.`;
  }
  return errors;
}

export function hasShippingAddress(raw) {
  const shipping = normalizeShipping(raw);
  return SHIPPING_FIELDS.some(field => field.required && shipping[field.name]);
}

export function formatShippingLines(raw) {
  const s = normalizeShipping(raw);
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ');
  const cityLine = [s.city, [s.state, s.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [name, s.streetAddress1, s.streetAddress2, cityLine, s.country, s.phone ? `Phone: ${s.phone}` : '']
    .filter(Boolean);
}

export function summarizeShipping(raw) {
  const s = normalizeShipping(raw);
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ');
  const place = [s.city, s.state, s.postalCode, s.country].filter(Boolean).join(', ');
  return [name, s.streetAddress1, place].filter(Boolean).join(' — ');
}

// Keeps the existing order-number format: "JGV-" + last 8 digits of the time.
export function createOrderId(now = Date.now()) {
  return `JGV-${String(Math.floor(now)).padStart(8, '0').slice(-8)}`;
}

function normalizeOrderItem(item) {
  const qty = Number(item && item.qty);
  const price = Number(item && item.price);
  return {
    id: clean(item && item.id),
    title: clean(item && item.title) || 'Item',
    img: clean(item && item.img),
    qty: Number.isInteger(qty) && qty > 0 ? qty : 1,
    price: Number.isFinite(price) && price >= 0 ? price : 0
  };
}

function isValidOrderItem(item) {
  return item && typeof item === 'object'
    && typeof item.id === 'string' && item.id.trim().length > 0 && item.id.length <= 300
    && typeof item.title === 'string' && item.title.trim().length > 0 && item.title.length <= 300
    && (item.img == null || (typeof item.img === 'string' && item.img.length <= 500))
    && Number.isInteger(Number(item.qty)) && Number(item.qty) >= 1 && Number(item.qty) <= 99
    && Number.isFinite(Number(item.price)) && Number(item.price) >= 0 && Number(item.price) <= 100000;
}

// Builds the order document written to users/{uid}/orders/{order.id}
// (createdAt is added as a server timestamp when it is saved).
export function buildOrder({ items, shipping, notes = '', email = '', now = new Date() }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw new AccountDataError('invalid-order', 'Select at least one item to order.');
  if (list.length > ORDER_MAX_ITEMS) throw new AccountDataError('invalid-order', `An order can contain at most ${ORDER_MAX_ITEMS} different items.`);
  if (!list.every(isValidOrderItem)) throw new AccountDataError('invalid-order', 'One of the items in your cart is invalid. Remove it and try again.');
  const address = normalizeShipping(shipping);
  const errors = validateShipping(address);
  if (Object.keys(errors).length) throw new AccountDataError('invalid-shipping', 'Please complete the required shipping fields.');
  const orderNotes = clean(notes);
  if (orderNotes.length > ORDER_NOTES_MAX) throw new AccountDataError('invalid-order', `Order notes must be ${ORDER_NOTES_MAX} characters or fewer.`);
  const orderItems = list.map(normalizeOrderItem);
  const total = Math.round(orderItems.reduce((sum, item) => sum + item.price * item.qty, 0) * 100) / 100;
  return {
    id: createOrderId(now.getTime()),
    date: now.toISOString(),
    status: 'In Queue',
    items: orderItems,
    total,
    shipping: address,
    notes: orderNotes,
    email: clean(email)
  };
}

function toIsoDate(data) {
  if (data && typeof data.date === 'string' && data.date) return data.date;
  const created = data && data.createdAt;
  if (created && typeof created.toDate === 'function') return created.toDate().toISOString();
  return '';
}

// Normalizes an order document read from Firestore for display.
export function normalizeOrder(data, docId = '') {
  const source = data && typeof data === 'object' ? data : {};
  const items = Array.isArray(source.items) ? source.items.map(normalizeOrderItem) : [];
  const total = typeof source.total === 'number' && Number.isFinite(source.total)
    ? source.total
    : items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return {
    id: clean(source.id) || clean(docId),
    docId: clean(docId) || clean(source.id),
    date: toIsoDate(source),
    status: ORDER_STATUSES.includes(source.status) ? source.status : 'In Queue',
    items,
    total,
    shipping: normalizeShipping(source.shipping),
    notes: clean(source.notes),
    email: clean(source.email),
    cancellationReason: clean(source.cancellationReason)
  };
}

export function sortOrdersNewestFirst(orders) {
  const time = order => {
    const value = new Date(order.date).getTime();
    return Number.isNaN(value) ? 0 : value;
  };
  return orders.slice().sort((a, b) => time(b) - time(a));
}

export function isValidOrderReference(id) {
  return typeof id === 'string' && DOC_ID_RE.test(id);
}

export function friendlyAccountError(error) {
  const code = error && error.code;
  if (error instanceof AccountDataError || (error && error.name === 'AccountDataError')) return error.message;
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return 'Access was denied. Sign out and back in, then try again. If it keeps happening, please contact us.';
  }
  if (code === 'unavailable' || code === 'deadline-exceeded' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return 'Network problem. Check your connection and try again.';
  }
  if (code === 'failed-precondition') return 'Our order system isn\'t ready yet. Please try again later.';
  return 'Something went wrong. Please try again.';
}

// Epochs distinguish a new login from the previous session, even for the same UID.
export function createAccountSession({ auth, onUserChanged, onAuthStateChanged }) {
  let epoch = 0;
  let disposed = false;
  let initial = true;
  const uid = () => auth.currentUser ? auth.currentUser.uid : null;
  let observedUid = uid();
  const listeners = new Set();
  function invalidate() {
    epoch += 1;
    for (const listener of [...listeners]) listener();
  }
  const changed = user => {
    const nextUid = user ? (user.uid || user.id) : null;
    if (!initial || nextUid !== observedUid) invalidate();
    initial = false;
    observedUid = nextUid;
  };
  const unsubscribe = onUserChanged ? onUserChanged(changed)
    : onAuthStateChanged ? onAuthStateChanged(auth, changed)
      : typeof auth.onAuthStateChanged === 'function' ? auth.onAuthStateChanged(changed) : null;
  function capture(expectedUid = uid()) {
    const token = { uid: expectedUid, epoch, user: auth.currentUser };
    assertCurrent(token);
    return token;
  }
  function isCurrent(token) {
    return !disposed && token.epoch === epoch && token.user === auth.currentUser
      && token.uid && typeof token.uid === 'string' && !token.uid.includes('/') && uid() === token.uid;
  }
  function assertCurrent(token) {
    if (!isCurrent(token)) throw new AccountDataError('stale-user', 'Your sign-in changed. Please try again.');
  }
  return {
    capture, isCurrent, assertCurrent, invalidate,
    onInvalidate(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    dispose() { disposed = true; invalidate(); if (unsubscribe) unsubscribe(); listeners.clear(); }
  };
}

export function createAccountData({ db, fs, auth, onUserChanged, onAuthStateChanged }) {
  const session = createAccountSession({ auth, onUserChanged, onAuthStateChanged });
  const shippingRef = uid => fs.doc(db, 'users', uid, 'profile', 'shipping');
  const orderRef = (uid, id) => fs.doc(db, 'users', uid, 'orders', id);

  const currentUid = () => (auth.currentUser ? auth.currentUser.uid : null);
  const currentEmail = () => (auth.currentUser && auth.currentUser.email) || '';

  function requireUser(uid) {
    if (!uid || typeof uid !== 'string' || uid.includes('/') || currentUid() !== uid) {
      throw new AccountDataError('stale-user', 'Your sign-in changed. Nothing was saved — please try again.');
    }
  }

  async function loadShipping(uid) {
    requireUser(uid);
    const token = session.capture(uid);
    const snap = await fs.getDoc(shippingRef(uid));
    session.assertCurrent(token);
    return snap.exists() ? normalizeShipping(snap.data()) : null;
  }

  async function saveShipping(uid, raw) {
    requireUser(uid);
    const token = session.capture(uid);
    const shipping = normalizeShipping(raw);
    if (Object.keys(validateShipping(shipping)).length) {
      throw new AccountDataError('invalid-shipping', 'Please complete the required shipping fields.');
    }
    await fs.setDoc(shippingRef(uid), { ...shipping, lastUpdated: fs.serverTimestamp() });
    session.assertCurrent(token);
    return shipping;
  }

  async function deleteShipping(uid) {
    requireUser(uid);
    const token = session.capture(uid);
    await fs.deleteDoc(shippingRef(uid));
    session.assertCurrent(token);
  }

  // Creates the order in a transaction so an existing order is never
  // overwritten. Transactions need the server, so nothing is queued offline.
  async function placeOrder(uid, order) {
    requireUser(uid);
    const token = session.capture(uid);
    if (!order || !ORDER_ID_RE.test(order.id)) throw new AccountDataError('invalid-order', 'This order is invalid. Please try again.');
    const ref = orderRef(uid, order.id);
    await fs.runTransaction(db, async transaction => {
      session.assertCurrent(token);
      const existing = await transaction.get(ref);
      session.assertCurrent(token);
      if (existing.exists()) {
        throw new AccountDataError('order-exists', 'An order with this number already exists. Please press Place Order again.');
      }
      requireUser(uid);
      transaction.set(ref, { ...order, createdAt: fs.serverTimestamp() });
    });
    session.assertCurrent(token);
    return order;
  }

  async function listOrders(uid) {
    requireUser(uid);
    const token = session.capture(uid);
    const snap = await fs.getDocs(fs.collection(db, 'users', uid, 'orders'));
    session.assertCurrent(token);
    return sortOrdersNewestFirst(snap.docs.map(doc => normalizeOrder(doc.data(), doc.id)));
  }

  async function getOrder(uid, id) {
    requireUser(uid);
    const token = session.capture(uid);
    if (!isValidOrderReference(id)) return null;
    const snap = await fs.getDoc(orderRef(uid, id));
    session.assertCurrent(token);
    return snap.exists() ? normalizeOrder(snap.data(), snap.id || id) : null;
  }

  function subscribe(ref, uid, normalize, onNext, onError = () => {}) {
    const token = session.capture(uid);
    let active = true;
    let stop = () => {};
    const off = session.onInvalidate(() => { active = false; stop(); off(); });
    try {
      stop = fs.onSnapshot(ref, snap => {
        if (active && session.isCurrent(token)) onNext(normalize(snap));
      }, error => {
        if (active && session.isCurrent(token)) onError(error);
      });
      if (!active) stop();
    } catch (error) { off(); throw error; }
    return () => { active = false; stop(); off(); };
  }
  function subscribeOrders(uid, onNext, onError) {
    return subscribe(fs.collection(db, 'users', uid, 'orders'), uid,
      snap => sortOrdersNewestFirst(snap.docs.map(doc => normalizeOrder(doc.data(), doc.id))), onNext, onError);
  }
  function subscribeOrder(uid, id, onNext, onError) {
    if (!isValidOrderReference(id)) throw new AccountDataError('invalid-order', 'Invalid order reference.');
    return subscribe(orderRef(uid, id), uid,
      snap => snap.exists() ? normalizeOrder(snap.data(), snap.id || id) : null, onNext, onError);
  }

  return { currentUid, currentEmail, loadShipping, saveShipping, deleteShipping, placeOrder, listOrders, getOrder,
    subscribeOrders, subscribeOrder, invalidate: session.invalidate, dispose: session.dispose };
}

// Loads Firebase Auth and Firestore once, on demand. Firestore uses its
// default in-memory cache, so nothing is persisted in this browser.
let accountDataPromise = null;
export function loadAccountData() {
  if (!accountDataPromise) {
    accountDataPromise = Promise.all([import('./auth-firebase.js'), import(FIRESTORE_SDK_URL)])
      .then(([authModule, fs]) => ({
        ...createAccountData({ db: fs.getFirestore(authModule.app), fs, auth: authModule.auth, onUserChanged: authModule.onUserChanged }),
        onUserChanged: authModule.onUserChanged
      }));
    accountDataPromise.catch(() => { accountDataPromise = null; });
  }
  return accountDataPromise;
}

// Shared cart store.
//
// Keeps two kinds of cart strictly separate:
//   * the browser "guest" cart (signed out), stored in localStorage under GUEST_CART_KEY
//   * each signed-in account's cart, stored in Firestore at users/{uid}/carts/current
//
// Nothing is ever copied, merged or transferred between these scopes. The
// account cart is never cached in browser storage; it is shown only from live
// Firestore snapshots for the currently signed-in Firebase user.
//
// This module has no Firebase imports so it can be unit tested. The Firebase
// specifics live in cart-firebase.js and are injected as a "backend".

export const GUEST_CART_KEY = 'jgv3d_cart_guest';
export const GUEST_SELECTION_KEY = 'jgv3d_cart_selection_guest';
export const GUEST_BACKUP_KEY = 'jgv3d_cart_guest_backup';
export const LEGACY_CART_KEY = 'jgv3d_cart';
export const LEGACY_SELECTION_KEY = 'jgv3d_cart_selection';
export const LEGACY_MIGRATION_KEY = 'jgv3d_cart_legacy_migrated';
export const ACCOUNT_SELECTION_PREFIX = 'jgv3d_cart_selection_account_';
export const CART_SCHEMA_VERSION = 1;
export const PLACEHOLDER_IMG = 'images/placeholder.png';

export const CART_LIMITS = Object.freeze({
  maxLines: 50,
  maxQty: 99,
  maxIdLength: 300,
  maxTitleLength: 300,
  maxImgLength: 500,
  maxPrice: 100000
});

const STALE_SCOPE_MESSAGE = 'Your sign-in changed before this change was saved. Nothing was changed — please try again.';

export class CartError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'CartError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Images are display-only data. Allow http(s) URLs and relative site paths;
// reject other schemes such as javascript: or data:.
export function safeImg(value) {
  const img = typeof value === 'string' ? value.trim() : '';
  if (!img || img.length > CART_LIMITS.maxImgLength) return PLACEHOLDER_IMG;
  if (!/^https?:\/\//i.test(img) && img.includes(':')) return PLACEHOLDER_IMG;
  return img;
}

// Normalises a stored cart line. Returns null when the line can't be used.
// Prices are display data only; they are never trusted as payment amounts.
export function sanitizeItem(raw) {
  if (!isPlainObject(raw)) return null;
  const rawId = raw.id;
  const id = (typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId)))
    ? String(rawId).trim()
    : '';
  if (!id || id.length > CART_LIMITS.maxIdLength) return null;
  const title = (typeof raw.title === 'string' ? raw.title.trim() : '') || 'Item';
  if (title.length > CART_LIMITS.maxTitleLength) return null;
  const priceValue = raw.price === undefined || raw.price === null || raw.price === '' ? 0 : Number(raw.price);
  const price = Number.isFinite(priceValue) ? priceValue : 0;
  if (price < 0 || price > CART_LIMITS.maxPrice) return null;
  let qty = Math.floor(Number(raw.qty));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  qty = Math.min(qty, CART_LIMITS.maxQty);
  return { id, title, price: Math.round(price * 100) / 100, img: safeImg(raw.img), qty };
}

// Validates an item that is about to be added. Unlike sanitizeItem this
// rejects bad quantities instead of silently fixing them.
export function prepareNewItem(input) {
  const qty = Number(input && input.qty);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new CartError('invalid-item', 'Choose a quantity of at least 1.');
  }
  const item = sanitizeItem(input);
  if (!item) throw new CartError('invalid-item', 'This item can\'t be added to the cart.');
  return { item, clamped: qty > CART_LIMITS.maxQty };
}

function sameItem(a, b) {
  return a.id === b.id && a.title === b.title && a.price === b.price && a.img === b.img && a.qty === b.qty;
}

// Firestore map key for a cart line. Deterministic, so the same product
// variant always lands on the same key on every device.
export async function itemKey(id) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return 'k' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Cart operations (applied to a Map of id -> item) ---------- */

export function addOperation(input) {
  const { item, clamped: inputClamped } = prepareNewItem(input);
  return (items) => {
    const existing = items.get(item.id);
    if (existing) {
      const wanted = existing.qty + item.qty;
      const qty = Math.min(CART_LIMITS.maxQty, wanted);
      items.set(item.id, { ...existing, qty, img: item.img });
      return { qty, clamped: inputClamped || wanted > CART_LIMITS.maxQty };
    }
    if (items.size >= CART_LIMITS.maxLines) {
      throw new CartError('cart-full', `Your cart can hold up to ${CART_LIMITS.maxLines} different items.`);
    }
    items.set(item.id, item);
    return { qty: item.qty, clamped: inputClamped };
  };
}

export function changeQtyOperation(id, delta) {
  const step = Math.trunc(Number(delta));
  if (!Number.isFinite(step) || step === 0) throw new CartError('invalid-item', 'Invalid quantity change.');
  return (items) => {
    const existing = items.get(String(id));
    if (!existing) return { missing: true };
    const qty = Math.max(1, Math.min(CART_LIMITS.maxQty, existing.qty + step));
    if (qty !== existing.qty) items.set(existing.id, { ...existing, qty });
    return { qty };
  };
}

export function removeOperation(ids) {
  const list = Array.from(ids || [], id => String(id));
  return (items) => {
    let removed = 0;
    for (const id of list) if (items.delete(id)) removed += 1;
    return { removed };
  };
}

// Applies an operation to the raw Firestore `items` map and returns the new
// map. Only the line touched by the operation is rewritten; other entries
// (including any unreadable ones) are kept exactly as they were.
export async function planMutation(rawItems, operation) {
  const source = isPlainObject(rawItems) ? rawItems : {};
  const existing = new Map();
  for (const [key, value] of Object.entries(source)) {
    const item = sanitizeItem(value);
    if (item && !existing.has(item.id)) existing.set(item.id, { key, item });
  }
  const working = new Map(Array.from(existing, ([id, entry]) => [id, { ...entry.item }]));
  const result = operation(working);

  const items = { ...source };
  const removedKeys = [];
  const changedKeys = [];
  for (const [id, entry] of existing) {
    if (!working.has(id)) {
      delete items[entry.key];
      removedKeys.push(entry.key);
    }
  }
  for (const [id, item] of working) {
    const before = existing.get(id);
    if (before && sameItem(before.item, item)) continue;
    const key = before ? before.key : await itemKey(id);
    items[key] = item;
    changedKeys.push(key);
  }
  if (changedKeys.length > 1 || (changedKeys.length && removedKeys.length)) {
    throw new CartError('internal', 'A cart change may only add or update one item at a time.');
  }
  return {
    changed: changedKeys.length > 0 || removedKeys.length > 0,
    items,
    lastKey: changedKeys[0] || removedKeys[0] || null,
    result
  };
}

/* ---------- Guest (browser) storage ---------- */

function backupRaw(local, raw) {
  try { local.setItem(GUEST_BACKUP_KEY, raw); return true; } catch (e) { return false; }
}

export function readGuestCart(local) {
  const raw = local.getItem(GUEST_CART_KEY);
  if (raw === null || raw === undefined) return { items: [], notice: null };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = undefined; }
  if (!Array.isArray(parsed)) {
    backupRaw(local, raw);
    return { items: [], notice: 'Saved cart data in this browser couldn\'t be read, so it was set aside.' };
  }
  const byId = new Map();
  let skipped = 0;
  for (const value of parsed) {
    const item = sanitizeItem(value);
    if (!item) { skipped += 1; continue; }
    const prior = byId.get(item.id);
    if (prior) prior.qty = Math.min(CART_LIMITS.maxQty, prior.qty + item.qty);
    else if (byId.size < CART_LIMITS.maxLines) byId.set(item.id, item);
    else skipped += 1;
  }
  if (skipped) backupRaw(local, raw);
  return {
    items: Array.from(byId.values()),
    notice: skipped ? `${skipped} saved cart item(s) in this browser couldn't be read and were set aside.` : null
  };
}

// One-time move of the old shared `jgv3d_cart` key into the guest cart.
// That data has no owner (older versions used one cart for everyone on this
// browser), so it becomes guest data only and is never imported into any
// account. Returns true when legacy data was moved.
export function migrateLegacyCart(local) {
  if (local.getItem(LEGACY_MIGRATION_KEY) !== null) return false;
  const legacyCart = local.getItem(LEGACY_CART_KEY);
  const legacySelection = local.getItem(LEGACY_SELECTION_KEY);
  try {
    if (legacyCart !== null) {
      if (local.getItem(GUEST_CART_KEY) === null) local.setItem(GUEST_CART_KEY, legacyCart);
      else local.setItem(GUEST_BACKUP_KEY, legacyCart);
    }
    if (legacySelection !== null && local.getItem(GUEST_SELECTION_KEY) === null) {
      local.setItem(GUEST_SELECTION_KEY, legacySelection);
    }
    local.setItem(LEGACY_MIGRATION_KEY, '1');
  } catch (e) {
    return false; // storage full/blocked: leave legacy data untouched and try again next time
  }
  local.removeItem(LEGACY_CART_KEY);
  local.removeItem(LEGACY_SELECTION_KEY);
  return legacyCart !== null;
}

/* ---------- Error messages ---------- */

function firebaseCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return code.replace(/^firestore\//, '');
}

export function describeCartError(error, action = 'load') {
  if (error instanceof CartError) return error.message;
  const verb = action === 'save' ? 'save your change to' : 'load';
  switch (firebaseCode(error)) {
    case 'permission-denied':
    case 'unauthenticated':
      return `We couldn't ${verb} your account cart (permission denied). Try signing out and back in.`;
    case 'unavailable':
    case 'deadline-exceeded':
      return `We couldn't ${verb} your account cart because the connection failed. Check your connection and try again.`;
    case 'not-found':
    case 'failed-precondition':
      return `We couldn't ${verb} your account cart because the cart database isn't available yet.`;
    case 'resource-exhausted':
      return `We couldn't ${verb} your account cart right now (service busy). Please try again shortly.`;
    case 'aborted':
      return `We couldn't ${verb} your account cart because it changed at the same time on another device. Please try again.`;
    default:
      return `We couldn't ${verb} your account cart. Please try again.`;
  }
}

/* ---------- Store ---------- */

function readJsonArray(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key));
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch (e) {
    return null;
  }
}

export function createCartStore({ localStorage: local, sessionStorage: session, loadBackend, onStorageEvent }) {
  const listeners = new Set();
  let backend = null;
  let startPromise = null;
  let storageListening = false;
  let unsubscribeRemote = null;
  let generation = 0;
  let scope = { kind: 'pending', key: 'pending', uid: null };
  let status = 'loading';
  let items = [];
  let hasData = false;
  let pending = 0;
  let error = null;
  let notice = null;
  let retryAction = null;

  function getState() {
    return Object.freeze({
      scope: scope.kind,
      scopeKey: scope.key,
      status,
      items: items.map(item => ({ ...item })),
      count: items.reduce((sum, item) => sum + item.qty, 0),
      hasData,
      pending,
      saving: pending > 0,
      canMutate: status === 'ready',
      error: error ? { ...error } : null,
      canRetry: Boolean(retryAction),
      notice
    });
  }

  function notify() {
    const state = getState();
    for (const listener of Array.from(listeners)) {
      try { listener(state); } catch (e) { console.error('Cart listener failed:', e); }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    try { listener(getState()); } catch (e) { console.error('Cart listener failed:', e); }
    return () => listeners.delete(listener);
  }

  function accountSelectionKey(uid) {
    return ACCOUNT_SELECTION_PREFIX + uid;
  }

  function purgeAccountSelections(keepUid) {
    if (!session) return;
    const keep = keepUid ? accountSelectionKey(keepUid) : null;
    for (const key of session.keys()) {
      if (key.startsWith(ACCOUNT_SELECTION_PREFIX) && key !== keep) session.removeItem(key);
    }
  }

  function resetVisibleState() {
    items = [];
    hasData = false;
    status = 'loading';
    pending = 0;
    error = null;
    notice = null;
    retryAction = null;
  }

  function loadGuest() {
    const read = readGuestCart(local);
    items = read.items;
    notice = read.notice;
    hasData = true;
    status = 'ready';
    notify();
  }

  function subscribeAccount(uid, gen) {
    const onData = (snap) => {
      if (gen !== generation) return;
      if (snap.fromCache && !hasData) {
        // A cache-only snapshot before any server data is NOT an empty cart.
        status = 'offline';
        notify();
        return;
      }
      const source = snap.exists && isPlainObject(snap.items) ? snap.items : {};
      const parsed = [];
      let skipped = 0;
      for (const value of Object.values(source)) {
        const item = sanitizeItem(value);
        if (item && !parsed.some(p => p.id === item.id)) parsed.push(item);
        else skipped += 1;
      }
      items = parsed;
      notice = skipped ? `${skipped} item(s) in your account cart couldn't be read and are not shown.` : null;
      hasData = true;
      status = snap.fromCache ? 'offline' : 'ready';
      notify();
    };
    const onError = (err) => {
      if (gen !== generation) return;
      unsubscribeRemote = null;
      items = [];
      hasData = false;
      status = 'error';
      error = { kind: 'load', code: firebaseCode(err) || 'unknown', message: describeCartError(err, 'load') };
      retryAction = () => { if (gen === generation) switchScope(uid, true); };
      notify();
    };
    try {
      unsubscribeRemote = backend.subscribeCart(uid, onData, onError);
    } catch (err) {
      onError(err);
    }
  }

  function switchScope(uid, force = false) {
    const key = uid ? `account:${uid}` : 'guest';
    if (!force && key === scope.key) return;
    generation += 1;
    const gen = generation;
    if (unsubscribeRemote) {
      try { unsubscribeRemote(); } catch (e) { /* listener already closed */ }
      unsubscribeRemote = null;
    }
    if (scope.kind === 'account' && scope.uid !== uid && session) {
      session.removeItem(accountSelectionKey(scope.uid));
    }
    scope = uid ? { kind: 'account', key, uid } : { kind: 'guest', key, uid: null };
    resetVisibleState();
    notify(); // clear the previous scope's cart and badge immediately
    if (!uid) {
      purgeAccountSelections(null);
      loadGuest();
      return;
    }
    purgeAccountSelections(uid);
    subscribeAccount(uid, gen);
  }

  function handleStorageEvent(event) {
    if (!event || scope.kind !== 'guest' || status !== 'ready') return;
    if (event.key === null || event.key === GUEST_CART_KEY) loadGuest();
    else if (event.key === GUEST_SELECTION_KEY) notify();
  }

  function start() {
    if (startPromise) return startPromise;
    migrateLegacyCart(local);
    if (onStorageEvent && !storageListening) {
      storageListening = true;
      onStorageEvent(handleStorageEvent);
    }
    startPromise = (async () => {
      try {
        backend = await loadBackend();
        backend.onAuthChanged(uid => switchScope(uid || null));
      } catch (err) {
        console.error('Cart could not start:', err);
        startPromise = null;
        generation += 1;
        scope = { kind: 'pending', key: 'pending', uid: null };
        resetVisibleState();
        status = 'error';
        error = {
          kind: 'start',
          code: 'auth-unavailable',
          message: 'We couldn\'t check whether you\'re signed in, so your cart is hidden. Check your connection and try again.'
        };
        retryAction = () => start();
        notify();
      }
    })();
    return startPromise;
  }

  function notReady() {
    if (status === 'offline') {
      return new CartError('offline', 'You\'re offline. Account cart changes are paused until you reconnect.');
    }
    if (status === 'error') return new CartError('unavailable', 'Your cart isn\'t available right now. Use Retry and try again.');
    return new CartError('not-ready', 'Your cart is still loading. Please try again in a moment.');
  }

  function setSaveError(code, message, operation, gen) {
    error = { kind: 'save', code, message };
    retryAction = () => (gen === generation ? mutate(operation) : Promise.reject(new CartError('stale-scope', STALE_SCOPE_MESSAGE)));
  }

  function clearSaveError() {
    if (error && error.kind === 'save') {
      error = null;
      retryAction = null;
    }
  }

  function mutateGuest(operation, gen) {
    const working = new Map(readGuestCart(local).items.map(item => [item.id, { ...item }]));
    const result = operation(working);
    const nextItems = Array.from(working.values());
    try {
      local.setItem(GUEST_CART_KEY, JSON.stringify(nextItems));
    } catch (err) {
      setSaveError('storage', 'Your cart couldn\'t be saved in this browser (storage is full or blocked). Nothing was changed.', operation, gen);
      notify();
      throw new CartError('storage', error.message, err);
    }
    items = nextItems;
    hasData = true;
    clearSaveError();
    notify();
    return result;
  }

  async function mutate(operation) {
    const gen = generation;
    const current = scope;
    if (status !== 'ready') throw notReady();
    if (current.kind === 'guest') return mutateGuest(operation, gen);
    if (current.kind !== 'account' || !backend || backend.currentUid() !== current.uid) {
      throw new CartError('stale-scope', STALE_SCOPE_MESSAGE);
    }
    pending += 1;
    notify();
    try {
      const result = await backend.mutateCart(
        current.uid,
        raw => planMutation(raw, operation),
        () => gen === generation && backend.currentUid() === current.uid
      );
      if (gen === generation) clearSaveError();
      return result;
    } catch (err) {
      const isInputError = err instanceof CartError && (err.code === 'cart-full' || err.code === 'invalid-item');
      if (gen === generation && !isInputError) {
        setSaveError(firebaseCode(err) || err.code || 'unknown', describeCartError(err, 'save'), operation, gen);
      }
      throw err instanceof CartError ? err : new CartError(firebaseCode(err) || 'unknown', describeCartError(err, 'save'), err);
    } finally {
      if (gen === generation) {
        pending -= 1;
        notify();
      }
    }
  }

  function selectionTarget() {
    if (scope.kind === 'guest') return { storage: local, key: GUEST_SELECTION_KEY };
    if (scope.kind === 'account' && session) return { storage: session, key: accountSelectionKey(scope.uid) };
    return null;
  }

  // Selected item ids for checkout. No stored selection means "all selected".
  function getSelection() {
    const target = selectionTarget();
    if (!target || !hasData) return new Set();
    const ids = items.map(item => item.id);
    const stored = readJsonArray(target.storage, target.key);
    return new Set(stored === null ? ids : ids.filter(id => stored.includes(id)));
  }

  function setSelection(ids) {
    const target = selectionTarget();
    if (!target || !hasData) return false;
    const valid = new Set(items.map(item => item.id));
    const next = Array.from(new Set(Array.from(ids || [], String))).filter(id => valid.has(id));
    try {
      target.storage.setItem(target.key, JSON.stringify(next));
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    start,
    subscribe,
    getState,
    getSelection,
    setSelection,
    addItem: input => {
      let operation;
      try { operation = addOperation(input); } catch (err) { return Promise.reject(err); }
      return mutate(operation);
    },
    changeQty: (id, delta) => {
      let operation;
      try { operation = changeQtyOperation(id, delta); } catch (err) { return Promise.reject(err); }
      return mutate(operation);
    },
    removeItems: ids => mutate(removeOperation(ids)),
    retry: () => {
      const action = retryAction;
      if (!action) return Promise.resolve();
      return Promise.resolve().then(action);
    }
  };
}

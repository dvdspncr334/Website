import { AccountDataError, ORDER_STATUSES, normalizeOrder, sortOrdersNewestFirst, createAccountSession } from './account-data.js';

export const ADMIN_ORDER_BATCH_SIZE = 100;
export const CANCELLATION_REASON_MAX = 500;
const FIRESTORE_SDK_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

export function parseOrderPath(path) {
  if (typeof path !== 'string') throw new AccountDataError('invalid-order', 'Invalid order path.');
  const parts = path.split('/');
  if (parts.length !== 4 || parts[0] !== 'users' || parts[2] !== 'orders'
    || !parts[1] || parts[1].length > 128 || !parts[3] || parts[3].length > 1500
    || parts.some(part => part === '.' || part === '..')) {
    throw new AccountDataError('invalid-order', 'Invalid order path.');
  }
  return { path, uid: parts[1], docId: parts[3] };
}

export function createAdminOrders({ db, fs, auth, onUserChanged, onAuthStateChanged }) {
  const session = createAccountSession({ auth, onUserChanged, onAuthStateChanged });
  const ref = path => fs.doc(db, path);
  const adminRef = uid => fs.doc(db, 'admins', uid);
  function requireAdmin(snap) {
    if (!snap.exists()) throw new AccountDataError('permission-denied', 'Admin access required.');
  }
  async function authorize(token) {
    session.assertCurrent(token);
    const snap = await fs.getDocFromServer(adminRef(token.uid));
    session.assertCurrent(token);
    requireAdmin(snap);
  }
  function normalize(doc, path) {
    const documentData = doc.data();
    return { ...normalizeOrder(documentData, doc.id), ...parseOrderPath(path || doc.ref.path), documentData };
  }

  async function listOrders(scope = 'own', expectedUid) {
    if (!['own', 'all'].includes(scope)) throw new AccountDataError('invalid-scope', 'Invalid order scope.');
    const token = session.capture(expectedUid);
    await authorize(token);
    const collection = scope === 'all' ? fs.collectionGroup(db, 'orders') : fs.collection(db, 'users', token.uid, 'orders');
    const snap = await fs.getDocsFromServer(collection);
    session.assertCurrent(token);
    // Collection-group rules are read-only; unrelated orders collections are never actionable.
    const orders = [];
    for (const doc of snap.docs) {
      const path = doc.ref.path;
      try { parseOrderPath(path); } catch { continue; }
      orders.push(normalize(doc, path));
    }
    return sortOrdersNewestFirst(orders);
  }

  async function updateStatus(path, expectedStatus, status, reason = '', expectedUid) {
    parseOrderPath(path);
    if (!ORDER_STATUSES.includes(expectedStatus) || !ORDER_STATUSES.includes(status)
      || typeof reason !== 'string' || reason.length > CANCELLATION_REASON_MAX) {
      throw new AccountDataError('invalid-status', 'Choose a valid status and a cancellation reason of 500 characters or fewer.');
    }
    const token = session.capture(expectedUid);
    const orderRef = ref(path);
    const result = await fs.runTransaction(db, async transaction => {
      await authorize(token);
      const membership = await transaction.get(adminRef(token.uid));
      session.assertCurrent(token);
      requireAdmin(membership);
      const snap = await transaction.get(orderRef);
      session.assertCurrent(token);
      if (!snap.exists()) throw new AccountDataError('order-not-found', 'This order no longer exists.');
      const data = snap.data();
      if ((data.status || 'In Queue') !== expectedStatus) {
        throw new AccountDataError('stale-order', 'This order changed. Reload it before trying again.');
      }
      const changes = {
        status, cancellationReason: status === 'Cancelled' ? reason.trim() : '',
        statusUpdatedAt: fs.serverTimestamp(), statusUpdatedBy: token.uid
      };
      session.assertCurrent(token);
      transaction.update(orderRef, changes);
      return { ...normalizeOrder({ ...data, ...changes }, snap.id), ...parseOrderPath(path) };
    });
    session.assertCurrent(token);
    return result;
  }

  async function deleteOrders(capturedPaths, onProgress = () => {}, expectedUid) {
    if (!Array.isArray(capturedPaths)) throw new AccountDataError('invalid-order', 'Capture the orders to delete first.');
    const paths = [...new Set(capturedPaths)];
    paths.forEach(parseOrderPath);
    const token = session.capture(expectedUid);
    let deleted = 0;
    let error = null;
    const result = () => ({
      deleted, remaining: paths.length - deleted, failed: error ? paths.length - deleted : 0, error,
      deletedPaths: paths.slice(0, deleted), remainingPaths: paths.slice(deleted)
    });
    for (let i = 0; i < paths.length; i += ADMIN_ORDER_BATCH_SIZE) {
      try {
        const chunk = paths.slice(i, i + ADMIN_ORDER_BATCH_SIZE);
        // Unlike writeBatch, transactions fail offline instead of queueing
        // destructive writes that could outlive this authenticated session.
        await fs.runTransaction(db, async transaction => {
          await authorize(token);
          const membership = await transaction.get(adminRef(token.uid));
          session.assertCurrent(token);
          requireAdmin(membership);
          chunk.forEach(path => transaction.delete(ref(path)));
        });
        deleted += chunk.length;
        session.assertCurrent(token);
        onProgress(result());
      } catch (failure) { error = failure; break; }
    }
    return result();
  }

  return { listOrders, updateStatus, deleteOrders, invalidate: session.invalidate, dispose: session.dispose };
}

export async function loadAdminOrders() {
  const [authModule, fs] = await Promise.all([import('./auth-firebase.js'), import(FIRESTORE_SDK_URL)]);
  return createAdminOrders({ db: fs.getFirestore(authModule.app), fs, auth: authModule.auth, onUserChanged: authModule.onUserChanged });
}

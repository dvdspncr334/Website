// Firestore backend for the shared cart store (cart-store.js).
//
// Account carts live at users/{uid}/carts/current. The uid always comes from
// the signed-in Firebase user; callers can't choose which account to write.
// Firestore uses its default in-memory cache, so no account cart data is
// persisted in this browser.
import { CartError, CART_SCHEMA_VERSION } from './cart-store.js';

const FIRESTORE_SDK_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

export function createFirestoreCartBackend({ db, auth, onUserChanged, fs }) {
  const cartRef = uid => fs.doc(db, 'users', uid, 'carts', 'current');

  return {
    currentUid: () => (auth.currentUser ? auth.currentUser.uid : null),

    onAuthChanged: callback => onUserChanged(user => callback(user ? user.id : null)),

    subscribeCart(uid, onData, onError) {
      return fs.onSnapshot(cartRef(uid), { includeMetadataChanges: true }, snap => {
        onData({
          exists: snap.exists(),
          items: snap.exists() ? snap.get('items') : null,
          fromCache: snap.metadata.fromCache
        });
      }, onError);
    },

    // Runs one cart change in a transaction against the latest server copy,
    // so concurrent changes from other tabs/devices are never lost.
    // Transactions need the server, so nothing is queued while offline.
    mutateCart(uid, plan, isCurrent) {
      const ref = cartRef(uid);
      return fs.runTransaction(db, async transaction => {
        const snap = await transaction.get(ref);
        const change = await plan(snap.exists() ? snap.get('items') : null);
        if (!isCurrent()) {
          throw new CartError('stale-scope', 'Your sign-in changed before this change was saved. Nothing was changed — please try again.');
        }
        if (change.changed) {
          transaction.set(ref, {
            items: change.items,
            lastKey: change.lastKey,
            schema: CART_SCHEMA_VERSION,
            updatedAt: fs.serverTimestamp()
          });
        }
        return change.result;
      });
    }
  };
}

export async function createFirebaseCartBackend() {
  const [{ app, auth, onUserChanged }, fs] = await Promise.all([
    import('./auth-firebase.js'),
    import(FIRESTORE_SDK_URL)
  ]);
  return createFirestoreCartBackend({ db: fs.getFirestore(app), auth, onUserChanged, fs });
}

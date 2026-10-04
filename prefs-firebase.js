// Firestore backend for synced shop/gallery UI preferences (ui-prefs.js).
//
// Each signed-in (non-anonymous) account owns two private documents:
//   users/{uid}/preferences/shop     (options, drafts, view, scroll)
//   users/{uid}/preferences/gallery  (images, view, scroll)
// The uid always comes from the signed-in Firebase user, and firestore.rules
// only lets that owner read/write them. Changes are sent as field-level
// updates (FieldPath segments, so any product id is a safe field name) with
// a server-generated updatedAt; the document is created once with a
// create-if-absent transaction. Firestore uses its default in-memory cache.

const FIRESTORE_SDK_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
export const PREFS_DOCS = ['shop', 'gallery'];
export const PREFS_SCHEMA_VERSION = 1;

function staleScopeError() {
  return Object.assign(new Error('Your sign-in changed before your choices were saved.'), { code: 'stale-scope' });
}

export function createFirestorePrefsBackend({ db, auth, fs }) {
  const prefsRef = (uid, name) => {
    if (!PREFS_DOCS.includes(name)) throw new Error(`Unknown preferences document: ${name}`);
    return fs.doc(db, 'users', uid, 'preferences', name);
  };

  return {
    // Anonymous guest-checkout sessions never sync preferences.
    currentUid() {
      const user = auth.currentUser;
      return user && !user.isAnonymous ? user.uid : null;
    },

    subscribe(uid, name, onData, onError) {
      return fs.onSnapshot(prefsRef(uid, name), { includeMetadataChanges: true }, snap => {
        onData({
          exists: snap.exists(),
          data: snap.exists() ? snap.data() : null,
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites
        });
      }, onError);
    },

    // Resolves true when this call created the document, false when it
    // already existed (another device won the race). Needs the server.
    createIfAbsent(uid, name, fields, isCurrent) {
      const ref = prefsRef(uid, name);
      return fs.runTransaction(db, async transaction => {
        const snap = await transaction.get(ref);
        if (snap.exists()) return false;
        if (!isCurrent()) throw staleScopeError();
        transaction.set(ref, {
          ...fields,
          schema: PREFS_SCHEMA_VERSION,
          changed: [],
          updatedAt: fs.serverTimestamp()
        });
        return true;
      });
    },

    // ops: [{ path: [...segments], value } | { path, del: true }]
    // changed: the product/gallery keys whose entries this write touches.
    update(uid, name, ops, changed) {
      if (this.currentUid() !== uid) return Promise.reject(staleScopeError());
      const args = [];
      for (const op of ops) {
        args.push(new fs.FieldPath(...op.path), op.del ? fs.deleteField() : op.value);
      }
      args.push('changed', changed, 'updatedAt', fs.serverTimestamp());
      return fs.updateDoc(prefsRef(uid, name), ...args);
    }
  };
}

export async function createFirebasePrefsBackend() {
  const [{ app, auth }, fs] = await Promise.all([
    import('./auth-firebase.js'),
    import(FIRESTORE_SDK_URL)
  ]);
  return createFirestorePrefsBackend({ db: fs.getFirestore(app), auth, fs });
}

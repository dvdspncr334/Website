// Admin status helpers. A signed-in user is an admin when the Firestore
// document admins/{uid} exists. This check only decides what admin.html
// shows; the real protection is firestore.rules, which re-checks admins/{uid}
// on every admin read/write.
//
// Results are cached in sessionStorage under a per-UID key for a few minutes
// so moving around the dashboard doesn't re-read Firestore every time.

export const ADMIN_CACHE_PREFIX = 'jgv3d_admin_status_';
export const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;
const FIRESTORE_SDK_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

export function createAdminStatus({ storage, readAdminDoc, now = () => Date.now(), ttlMs = ADMIN_CACHE_TTL_MS }) {
  const keyFor = uid => `${ADMIN_CACHE_PREFIX}${uid}`;

  function readCache(uid) {
    try {
      const raw = storage && storage.getItem(keyFor(uid));
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.isAdmin !== 'boolean' || typeof entry.checkedAt !== 'number') return null;
      const age = now() - entry.checkedAt;
      if (age < 0 || age > ttlMs) return null;
      return entry.isAdmin;
    } catch (e) {
      return null;
    }
  }

  function writeCache(uid, isAdmin) {
    try {
      if (storage) storage.setItem(keyFor(uid), JSON.stringify({ isAdmin, checkedAt: now() }));
    } catch (e) { /* storage full or blocked: just don't cache */ }
  }

  // Errors from readAdminDoc (offline, rules not deployed, ...) are thrown
  // to the caller and never cached.
  async function check(uid, { force = false } = {}) {
    if (!uid) return false;
    if (!force) {
      const cached = readCache(uid);
      if (cached !== null) return cached;
    }
    const isAdmin = Boolean(await readAdminDoc(uid));
    writeCache(uid, isAdmin);
    return isAdmin;
  }

  // Clears one UID's cached status, or every cached admin status.
  function clear(uid) {
    try {
      if (!storage) return;
      if (uid) {
        storage.removeItem(keyFor(uid));
        return;
      }
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
      keys.filter(k => k && k.startsWith(ADMIN_CACHE_PREFIX)).forEach(k => storage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  return { check, clear };
}

// Loads Firebase Auth (auth-firebase.js) and Firestore once, on demand.
let firebasePromise = null;
export function loadFirebase() {
  if (!firebasePromise) {
    firebasePromise = Promise.all([import('./auth-firebase.js'), import(FIRESTORE_SDK_URL)])
      .then(([authModule, fs]) => ({ ...authModule, fs, db: fs.getFirestore(authModule.app) }));
    firebasePromise.catch(() => { firebasePromise = null; });
  }
  return firebasePromise;
}

function sessionStore() {
  try { return window.sessionStorage; } catch (e) { return null; }
}

let defaultStatus = null;
function adminStatus() {
  if (!defaultStatus) {
    defaultStatus = createAdminStatus({
      storage: sessionStore(),
      readAdminDoc: async uid => {
        const { fs, db } = await loadFirebase();
        const snap = await fs.getDoc(fs.doc(db, 'admins', uid));
        return snap.exists();
      }
    });
  }
  return defaultStatus;
}

// True when the current signed-in user has an admins/{uid} document.
// Resolves false when signed out. Pass { force: true } to skip the cache.
export async function isAdmin({ force = false } = {}) {
  const { getSession } = await loadFirebase();
  const user = await getSession();
  return user ? adminStatus().check(user.id, { force }) : false;
}

export function clearAdminCache(uid) {
  adminStatus().clear(uid);
}

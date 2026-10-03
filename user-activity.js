// Records a minimal activity entry for the signed-in user at
// userActivity/{uid}: { email, lastSignInAt, lastActiveAt }. Only admins can
// read these entries (see firestore.rules). They power the admin dashboard's
// "User Activity" list and "add admin by email" lookup. Writes are throttled
// per browser session, and failures are ignored (they never affect the page).
import { loadFirebase } from './admin-auth.js';

export const ACTIVITY_KEY_PREFIX = 'jgv3d_activity_';
export const ACTIVITY_INTERVAL_MS = 15 * 60 * 1000;

// previous: { at, signIn } from the last write in this session (or null).
export function shouldRecord(previous, { signIn, now, interval = ACTIVITY_INTERVAL_MS }) {
  if (!previous || typeof previous.at !== 'number') return true;
  if (previous.signIn !== signIn) return true;
  return now - previous.at >= interval || now < previous.at;
}

function sessionStore() {
  try { return window.sessionStorage; } catch (e) { return null; }
}

function readPrevious(storage, uid) {
  try { return JSON.parse(storage.getItem(ACTIVITY_KEY_PREFIX + uid)); } catch (e) { return null; }
}

export async function startActivityTracking() {
  const { auth, onUserChanged, fs, db } = await loadFirebase();
  const storage = sessionStore();
  onUserChanged(async user => {
    const current = auth.currentUser;
    if (!user || !current || current.uid !== user.id || !current.email) return;
    const signInMs = Date.parse(current.metadata && current.metadata.lastSignInTime);
    const signIn = Number.isFinite(signInMs) ? signInMs : null;
    const now = Date.now();
    if (storage && !shouldRecord(readPrevious(storage, user.id), { signIn, now })) return;
    try {
      await fs.setDoc(fs.doc(db, 'userActivity', user.id), {
        email: current.email,
        lastSignInAt: signIn !== null ? fs.Timestamp.fromMillis(signIn) : fs.serverTimestamp(),
        lastActiveAt: fs.serverTimestamp()
      });
      if (storage) storage.setItem(ACTIVITY_KEY_PREFIX + user.id, JSON.stringify({ at: now, signIn }));
    } catch (e) { /* activity tracking is best-effort */ }
  });
}

// Firebase Authentication module (loaded from Google's CDN; works on GitHub Pages)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

function toUser(u) {
  if (!u) return null;
  return {
    id: u.uid,
    email: u.email || '',
    name: u.displayName || '',
    photoURL: u.photoURL || '',
    provider: (u.providerData[0] && u.providerData[0].providerId) || 'password'
  };
}

// Subscribe to sign-in state changes. Returns an unsubscribe function.
export function onUserChanged(callback) {
  return onAuthStateChanged(auth, (u) => callback(toUser(u)));
}

// One-time check of the current user.
export function getSession() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      unsubscribe();
      resolve(toUser(u));
    });
  });
}

export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  return toUser(result.user);
}

export async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return toUser(result.user);
}

export async function createAccountWithEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return toUser(result.user);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export function signOut() {
  return firebaseSignOut(auth);
}

// Turn Firebase error codes into friendly messages. Returns null for errors
// that should be ignored (e.g. the user closed the Google popup).
export function friendlyError(error) {
  switch (error && error.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/weak-password':
      return 'Password must be at least 6 characters.';
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'Please enter a valid email address.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null;
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    case 'auth/unauthorized-domain':
      return 'Sign-in isn\'t enabled for this domain yet. Please contact support.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

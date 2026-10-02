import { firebaseConfig } from './firebase-config.js';

let initialization;

async function initializeAuth() {
  if (!initialization) {
    initialization = (async () => {
      const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
      if (required.some(key => !firebaseConfig[key] || firebaseConfig[key].includes('YOUR_'))) {
        const error = new Error('Add your Firebase web app configuration to firebase-config.js. See FIREBASE_SETUP.md.');
        error.code = 'auth/missing-config';
        throw error;
      }
      const [appSDK, authSDK] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js')
      ]);
      const auth = authSDK.getAuth(appSDK.initializeApp(firebaseConfig));
      await authSDK.setPersistence(auth, authSDK.browserLocalPersistence);
      return { auth, authSDK };
    })();
  }
  return initialization;
}

export async function getSession() {
  const { auth } = await initializeAuth();
  await auth.authStateReady();
  return auth.currentUser;
}

export async function onSessionChanged(callback) {
  const { auth, authSDK } = await initializeAuth();
  return authSDK.onAuthStateChanged(auth, callback);
}

export async function signIn(email, password) {
  const { auth, authSDK } = await initializeAuth();
  return (await authSDK.signInWithEmailAndPassword(auth, email, password)).user;
}

export async function createAccount(email, password) {
  const { auth, authSDK } = await initializeAuth();
  return (await authSDK.createUserWithEmailAndPassword(auth, email, password)).user;
}

export async function signInWithGoogle() {
  const { auth, authSDK } = await initializeAuth();
  const provider = new authSDK.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await authSDK.signInWithPopup(auth, provider)).user;
}

export async function signOut() {
  const { auth, authSDK } = await initializeAuth();
  await authSDK.signOut(auth);
}

export async function resetPassword(email) {
  const { auth, authSDK } = await initializeAuth();
  await authSDK.sendPasswordResetEmail(auth, email);
}

function errorMessage(error) {
  switch (error.code) {
    case 'auth/missing-config':
      return error.message;
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Unable to sign in. Check your email and password.';
    case 'auth/email-already-in-use':
      return 'Unable to create this account. Try signing in or resetting your password.';
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Choose a stronger password that meets the project password policy (at least six characters).';
    case 'auth/popup-blocked':
      return 'Allow pop-ups for this site, then try Google sign-in again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Google sign-in was cancelled. Please try again.';
    case 'auth/unauthorized-domain':
      return 'This domain is not authorized in Firebase. See FIREBASE_SETUP.md.';
    case 'auth/operation-not-allowed':
      return 'Enable this sign-in provider in Firebase Console. See FIREBASE_SETUP.md.';
    case 'auth/account-exists-with-different-credential':
      return 'Sign in using the method you originally used for this email address.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait before trying again.';
    default:
      return 'Authentication unavailable. Check your connection and Firebase configuration, then reload.';
  }
}

async function setupLoginPage() {
  const form = document.getElementById('email-signin');
  if (!form) return;
  const fields = document.getElementById('auth-fields');
  const status = document.getElementById('auth-status');
  const options = document.getElementById('sign-in-options');
  const signedIn = document.getElementById('signed-in');
  const userLabel = document.getElementById('auth-user');
  const email = document.getElementById('auth-email');
  const password = document.getElementById('auth-password');
  const signOutButton = document.getElementById('sign-out');
  let busy = false;

  function showUser(user) {
    options.hidden = Boolean(user);
    signedIn.hidden = !user;
    userLabel.textContent = user ? `Signed in as ${user.email || user.displayName || 'your account'}` : '';
    status.textContent = user ? 'You are signed in.' : 'Sign in or create an account below.';
    password.value = '';
  }

  async function perform(action, message) {
    if (busy) return;
    busy = true;
    fields.disabled = true;
    signOutButton.disabled = true;
    status.textContent = message;
    try {
      await action();
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      password.value = '';
      busy = false;
      fields.disabled = false;
      signOutButton.disabled = false;
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const signingUp = event.submitter?.id === 'create-account';
    perform(() => signingUp ?
      createAccount(email.value.trim(), password.value) :
      signIn(email.value.trim(), password.value), signingUp ? 'Creating account…' : 'Signing in…');
  });
  document.getElementById('google-signin').addEventListener('click', () => {
    perform(signInWithGoogle, 'Signing in with Google…');
  });
  signOutButton.addEventListener('click', () => perform(signOut, 'Signing out…'));
  document.getElementById('reset-password').addEventListener('click', () => {
    if (!email.reportValidity()) return;
    perform(async () => {
      await resetPassword(email.value.trim());
      status.textContent = 'If an account exists for this email, a password reset email has been sent.';
    }, 'Requesting password reset…');
  });

  try {
    await onSessionChanged(showUser);
    fields.disabled = false;
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

if (typeof document !== 'undefined') setupLoginPage();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'auth-firebase.js'), 'utf8');
const APP_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
const AUTH_URL = 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
const config = {
  apiKey: 'test-api-key', authDomain: 'test.firebaseapp.com',
  projectId: 'test-project', appId: 'test-app'
};

async function fixture(options = {}) {
  const calls = [];
  const listeners = new Set();
  const user = { uid: 'uid-1', email: 'user@example.com', displayName: 'Ada', photoURL: '', providerData: [{ providerId: 'google.com' }] };
  const auth = { currentUser: null };
  const context = vm.createContext({
    localStorage: {
      getItem() { throw new Error('Auth must not read browser storage'); },
      setItem() { throw new Error('Auth must not write browser storage'); },
      removeItem() { throw new Error('Auth must not remove browser storage'); },
      clear() { throw new Error('Auth must not clear browser storage'); }
    }
  });
  function emit(next) {
    auth.currentUser = next;
    for (const cb of listeners) cb(next);
  }
  function authenticate(method) {
    return async (...args) => {
      calls.push([method, ...args]);
      if (options.error) throw options.error;
      emit(user);
      return { user };
    };
  }
  const sdk = {
    getAuth: app => { calls.push(['getAuth', app]); return auth; },
    onAuthStateChanged: (instance, cb) => {
      assert.equal(instance, auth);
      listeners.add(cb);
      // Firebase delivers the initial state asynchronously.
      Promise.resolve().then(() => { if (listeners.has(cb)) cb(auth.currentUser); });
      return () => listeners.delete(cb);
    },
    GoogleAuthProvider: class {},
    signInWithPopup: authenticate('google'),
    signInWithEmailAndPassword: authenticate('email'),
    createUserWithEmailAndPassword: authenticate('create'),
    sendPasswordResetEmail: async (...args) => { calls.push(['reset', ...args]); },
    signOut: async instance => { calls.push(['signOut', instance]); emit(null); }
  };
  async function moduleFor(exports) {
    const m = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
    }, { context });
    await m.link(() => {});
    await m.evaluate();
    return m;
  }
  const modules = {
    [APP_URL]: await moduleFor({ initializeApp: settings => { calls.push(['initializeApp', settings]); return 'app'; } }),
    [AUTH_URL]: await moduleFor(sdk),
    './firebase-config.js': await moduleFor({ firebaseConfig: config })
  };
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(specifier => {
    assert.ok(modules[specifier], `Unexpected import ${specifier}`);
    return modules[specifier];
  });
  await mod.evaluate();
  return { api: mod.namespace, auth, user, calls, emit };
}

test('initializes Firebase once from firebase-config.js and exports app/auth', async () => {
  const f = await fixture();
  assert.deepEqual(f.calls.filter(c => c[0] === 'initializeApp'), [['initializeApp', config]]);
  assert.equal(f.api.app, 'app');
  assert.equal(f.api.auth, f.auth);
});

test('onUserChanged reports sign-in, account switches and sign-out', async () => {
  const f = await fixture();
  const seen = [];
  const unsubscribe = f.api.onUserChanged(u => seen.push(u && u.id));
  await Promise.resolve();
  await f.api.signInWithEmail('user@example.com', 'pw-123456');
  f.emit({ ...f.user, uid: 'uid-2', providerData: [] });
  await f.api.signOut();
  unsubscribe();
  f.emit(f.user);
  assert.deepEqual(seen, [null, 'uid-1', 'uid-2', null]);
});

test('sign-in helpers delegate to Firebase and map the user', async () => {
  const f = await fixture();
  const google = await f.api.signInWithGoogle();
  assert.deepEqual({ ...google }, { id: 'uid-1', email: 'user@example.com', name: 'Ada', photoURL: '', provider: 'google.com' });
  await f.api.createAccountWithEmail('new@example.com', 'pw-123456');
  await f.api.resetPassword('user@example.com');
  assert.deepEqual(f.calls.find(c => c[0] === 'create'), ['create', f.auth, 'new@example.com', 'pw-123456']);
  assert.deepEqual(f.calls.find(c => c[0] === 'reset'), ['reset', f.auth, 'user@example.com']);
  assert.equal(await f.api.getSession().then(u => u.id), 'uid-1');
});

test('sign-in errors propagate and map to friendly messages', async () => {
  const error = { code: 'auth/invalid-credential' };
  const f = await fixture({ error });
  await assert.rejects(f.api.signInWithEmail('a@b.c', 'bad-password'), e => e === error);
  assert.equal(await f.api.getSession(), null);
  assert.equal(f.api.friendlyError(error), 'Incorrect email or password.');
  assert.equal(f.api.friendlyError({ code: 'auth/popup-closed-by-user' }), null);
});

test('auth module has no cart, Firestore or browser storage code', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|firestore|jgv3d_cart|syncCart/i);
});

test('login page uses the shared cart badge and never reads a shared cart key', () => {
  const html = readFileSync(path.join(root, 'login.html'), 'utf8');
  assert.match(html, /from '\.\/auth-firebase\.js'/);
  assert.match(html, /<script type="module" src="mini-cart\.js"><\/script>/);
  assert.match(html, /id="signout-btn"/);
  assert.doesNotMatch(html, /jgv3d_cart|localStorage/);
});

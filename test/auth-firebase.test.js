const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'auth-firebase.js'), 'utf8');
const config = {
  apiKey: 'test-api-key', authDomain: 'test.firebaseapp.com',
  projectId: 'test-project', appId: 'test-app'
};

async function fixture(options = {}) {
  const calls = [];
  const listeners = new Set();
  const user = { uid: 'test-user', email: 'user@example.com' };
  const auth = {
    currentUser: options.user || null,
    authStateReady: options.authStateReady || (async () => {})
  };
  const elements = {};
  if (options.ui) {
    for (const id of [
      'email-signin', 'auth-fields', 'auth-status', 'sign-in-options', 'signed-in',
      'auth-user', 'auth-email', 'auth-password', 'sign-out', 'google-signin', 'reset-password'
    ]) {
      elements[id] = {
        value: '', textContent: '', hidden: id === 'signed-in',
        disabled: id === 'auth-fields', handlers: {},
        addEventListener(type, callback) { this.handlers[type] = callback; },
        reportValidity() { return Boolean(this.value); }
      };
    }
  }
  const context = vm.createContext({
    ...(options.ui ? { document: { getElementById: id => elements[id] } } : {}),
    localStorage: {
      getItem() { throw new Error('Auth must not read cart storage'); },
      setItem() { throw new Error('Auth must not write cart storage'); },
      removeItem() { throw new Error('Auth must not remove cart storage'); },
      clear() { throw new Error('Auth must not clear browser storage'); }
    }
  });
  function emit(nextUser) {
    auth.currentUser = nextUser;
    for (const callback of listeners) callback(nextUser);
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
    browserLocalPersistence: 'firebase-local-persistence',
    setPersistence: async (...args) => {
      calls.push(['setPersistence', ...args]);
      if (options.persistenceError) throw options.persistenceError;
    },
    onAuthStateChanged: (instance, callback) => {
      assert.equal(instance, auth);
      listeners.add(callback);
      callback(auth.currentUser);
      return () => listeners.delete(callback);
    },
    signInWithEmailAndPassword: authenticate('email'),
    createUserWithEmailAndPassword: authenticate('create'),
    signInWithPopup: authenticate('google'),
    GoogleAuthProvider: class {
      setCustomParameters(parameters) { this.parameters = parameters; }
    },
    signOut: async instance => {
      calls.push(['signOut', instance]);
      if (options.error) throw options.error;
      emit(null);
    },
    sendPasswordResetEmail: async (...args) => {
      calls.push(['reset', ...args]);
      if (options.error) throw options.error;
    }
  };
  async function moduleFor(exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(() => {});
    await module.evaluate();
    return module;
  }
  const configModule = await moduleFor({ firebaseConfig: options.config || config });
  const appModule = await moduleFor({
    initializeApp: settings => { calls.push(['initializeApp', settings]); return 'app'; }
  });
  const authModule = await moduleFor(sdk);
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async specifier => {
      calls.push(['import', specifier]);
      if (options.networkError) throw new Error('CDN unreachable');
      if (specifier.endsWith('/firebase-app.js')) return appModule;
      if (specifier.endsWith('/firebase-auth.js')) return authModule;
      throw new Error(`Unexpected SDK import: ${specifier}`);
    }
  });
  await module.link(specifier => {
    assert.equal(specifier, './firebase-config.js');
    return configModule;
  });
  await module.evaluate();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { api: module.namespace, auth, user, calls, emit, elements, settle };
}

test('template configuration fails clearly without loading Firebase', async () => {
  const f = await fixture({ config: { ...config, projectId: 'YOUR_PROJECT_ID' } });
  await assert.rejects(f.api.getSession(), /firebase-config.js/);
  assert.equal(f.calls.length, 0);
});

test('concurrent session requests initialize once and use Firebase persistence', async () => {
  const f = await fixture({ user: { email: 'restored@example.com' } });
  const users = await Promise.all([f.api.getSession(), f.api.getSession()]);
  assert.equal(users[0], f.auth.currentUser);
  assert.equal(users[1], f.auth.currentUser);
  assert.equal(f.calls.filter(call => call[0] === 'initializeApp').length, 1);
  assert.deepEqual(f.calls.find(call => call[0] === 'setPersistence'),
    ['setPersistence', f.auth, 'firebase-local-persistence']);
});

test('getSession waits for Firebase to restore the session', async () => {
  let ready;
  const restored = new Promise(resolve => { ready = resolve; });
  const f = await fixture({ authStateReady: () => restored });
  let resolved = false;
  const session = f.api.getSession().then(user => { resolved = true; return user; });
  await f.settle();
  assert.equal(resolved, false);
  f.auth.currentUser = f.user;
  ready();
  assert.equal(await session, f.user);
});

test('email login, account creation, Google login and reset delegate to Firebase', async () => {
  const f = await fixture();
  assert.equal(await f.api.signIn('user@example.com', 'test-password'), f.user);
  assert.equal(await f.api.createAccount('new@example.com', 'new-password'), f.user);
  assert.equal(await f.api.signInWithGoogle(), f.user);
  await f.api.resetPassword('user@example.com');
  assert.deepEqual(f.calls.find(call => call[0] === 'email'),
    ['email', f.auth, 'user@example.com', 'test-password']);
  assert.deepEqual(f.calls.find(call => call[0] === 'create'),
    ['create', f.auth, 'new@example.com', 'new-password']);
  const provider = f.calls.find(call => call[0] === 'google')[2];
  assert.equal(provider.parameters.prompt, 'select_account');
  assert.deepEqual(f.calls.find(call => call[0] === 'reset'),
    ['reset', f.auth, 'user@example.com']);
});

test('observers track restored sessions, sign-in, cross-tab changes and sign-out', async () => {
  const f = await fixture();
  const seen = [];
  const unsubscribe = await f.api.onSessionChanged(user => seen.push(user));
  await f.api.signIn('user@example.com', 'test-password');
  f.emit({ email: 'other-tab@example.com' });
  await f.api.signOut();
  assert.equal(await f.api.getSession(), null);
  assert.deepEqual(seen.map(user => user?.email || null),
    [null, 'user@example.com', 'other-tab@example.com', null]);
  unsubscribe();
  f.emit(f.user);
  assert.equal(seen.length, 4);
});

test('provider, network and persistence failures propagate without fake sessions', async () => {
  const error = { code: 'auth/invalid-credential' };
  const f = await fixture({ error });
  await assert.rejects(f.api.signIn('user@example.com', 'bad-password'), e => e === error);
  assert.equal(await f.api.getSession(), null);
  const offline = await fixture({ networkError: true });
  await assert.rejects(offline.api.getSession(), /CDN unreachable/);
  const blocked = await fixture({ persistenceError: error });
  await assert.rejects(blocked.api.signInWithGoogle(), e => e === error);
  assert.equal(blocked.calls.some(call => call[0] === 'google'), false);
});

test('login UI reports missing configuration and leaves controls disabled', async () => {
  const f = await fixture({ ui: true, config: { ...config, apiKey: 'YOUR_FIREBASE_API_KEY' } });
  assert.match(f.elements['auth-status'].textContent, /firebase-config.js/);
  assert.equal(f.elements['auth-fields'].disabled, true);
});

test('login UI handles account creation, reload state, safe labels and sign-out', async () => {
  const f = await fixture({ ui: true });
  const e = f.elements;
  e['auth-email'].value = ' new@example.com ';
  e['auth-password'].value = 'test-password';
  e['email-signin'].handlers.submit({
    preventDefault() {}, submitter: { id: 'create-account' }
  });
  await f.settle();
  assert.equal(f.calls.find(call => call[0] === 'create')[2], 'new@example.com');
  assert.equal(e['sign-in-options'].hidden, true);
  assert.equal(e['signed-in'].hidden, false);
  assert.equal(e['auth-password'].value, '');
  f.emit({ email: '<img src=x onerror=alert(1)>' });
  assert.equal(e['auth-user'].textContent, 'Signed in as <img src=x onerror=alert(1)>');
  await e['sign-out'].handlers.click();
  assert.equal(e['signed-in'].hidden, true);
  assert.equal(e['sign-in-options'].hidden, false);
  assert.equal(e['auth-fields'].disabled, false);
  const reloaded = await fixture({ ui: true, user: f.user });
  assert.equal(reloaded.elements['signed-in'].hidden, false);
});

test('login UI prevents duplicate requests and recovers from sign-in errors', async () => {
  const f = await fixture({ ui: true, error: { code: 'auth/invalid-credential' } });
  const e = f.elements;
  e['auth-email'].value = 'user@example.com';
  e['auth-password'].value = 'bad-password';
  const event = { preventDefault() {} };
  e['email-signin'].handlers.submit(event);
  e['email-signin'].handlers.submit(event);
  await f.settle();
  assert.equal(f.calls.filter(call => call[0] === 'email').length, 1);
  assert.match(e['auth-status'].textContent, /Check your email and password/);
  assert.equal(e['auth-fields'].disabled, false);
  assert.equal(e['auth-password'].value, '');
});

test('reset only needs email and Google popup errors are actionable', async () => {
  const f = await fixture({ ui: true });
  f.elements['reset-password'].handlers.click();
  assert.equal(f.calls.some(call => call[0] === 'reset'), false);
  f.elements['auth-email'].value = 'user@example.com';
  f.elements['reset-password'].handlers.click();
  await f.settle();
  assert.match(f.elements['auth-status'].textContent, /If an account exists/);
  const blocked = await fixture({ ui: true, error: { code: 'auth/popup-blocked' } });
  blocked.elements['google-signin'].handlers.click();
  await blocked.settle();
  assert.match(blocked.elements['auth-status'].textContent, /Allow pop-ups/);
});

test('login uses relative modules, existing cart display, and accessible sign-out', () => {
  const html = readFileSync(path.join(root, 'login.html'), 'utf8');
  assert.match(html, /type="module" src="auth-firebase.js"/);
  assert.match(html, /id="auth-email" type="email" autocomplete="email" required/);
  assert.match(html, /id="auth-password" type="password" autocomplete="current-password" required/);
  assert.match(html, /id="sign-out"/);
  assert.match(html, /localStorage.getItem\('jgv3d_cart'\)/);
  assert.doesNotMatch(source, /localStorage|\/auth\/|innerHTML/);
});

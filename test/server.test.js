const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createApp, readConfig } = require('../server');

function environment(overrides = {}) {
  return {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    SITE_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECURE: 'false',
    ...overrides
  };
}

async function fixture(t, options = {}, overrides = {}) {
  const config = readConfig(environment(overrides));
  const server = createApp(config, {
    verifyIdToken: async () => ({
      getPayload: () => ({ sub: 'google-user', email: 'user@example.com', email_verified: true, name: 'Test User' })
    }),
    ...options
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    get: (route, cookie) => fetch(`${base}${route}`, { headers: cookie ? { Cookie: cookie } : {} }),
    post: (route, body, cookie, headers = {}) => fetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

test('configuration rejects placeholders and unsafe production settings', () => {
  assert.throws(() => readConfig({}), /GOOGLE_CLIENT_ID/);
  assert.throws(() => readConfig(environment({ GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com' })));
  assert.throws(() => readConfig(environment({ SESSION_SECRET: 'REPLACE_WITH_A_RANDOM_SESSION_SECRET' })));
  assert.throws(() => readConfig(environment({ SITE_ORIGIN: 'https://example.com', SESSION_COOKIE_SECURE: 'false' })));
  assert.throws(() => readConfig(environment({ NODE_ENV: 'production' })));
  assert.throws(() => readConfig(environment({
    NODE_ENV: 'production', SITE_ORIGIN: 'https://example.com', SESSION_COOKIE_SECURE: 'true'
  })), /REDIS_URL/);
  assert.throws(() => readConfig(environment({ SITE_ORIGIN: 'https://example.com/login.html' })));
  assert.throws(() => readConfig(environment({ TRUST_PROXY: 'true' })));
  assert.throws(() => readConfig(environment({ SESSION_COOKIE_SECURE: 'no' })));
  const config = readConfig(environment({
    NODE_ENV: 'production', SITE_ORIGIN: 'https://example.com', SESSION_COOKIE_SECURE: 'true',
    REDIS_URL: 'redis://localhost:6379', TRUST_PROXY: '1'
  }));
  assert.equal(config.secure, true);
  assert.equal(config.trustProxy, 1);
});

test('config exposes only the public client ID and anonymous requests create no cookies', async t => {
  const app = await fixture(t);
  const response = await app.get('/auth/config');
  assert.deepEqual(await response.json(), { clientId: app.config.clientId });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await (await app.get('/auth/session')).json(), { user: null });
});

test('verified login uses configured audience, persists user, rotates session, and logout invalidates it', async t => {
  let verification;
  const app = await fixture(t, {
    verifyIdToken: async options => {
      verification = options;
      return { getPayload: () => ({
        sub: 'google-user', email: 'user@example.com', email_verified: true, name: 'Test User'
      }) };
    }
  });
  const response = await app.post('/auth/login', { credential: 'test-credential' });
  assert.equal(response.status, 200);
  assert.deepEqual(verification, { idToken: 'test-credential', audience: app.config.clientId });
  const user = { id: 'google-user', email: 'user@example.com', name: 'Test User' };
  assert.deepEqual(await response.json(), { user });
  const cookie = cookieFrom(response);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(response.headers.get('set-cookie'), /Path=\//);
  assert.deepEqual(await (await app.get('/auth/session', cookie)).json(), { user });
  const second = await app.post('/auth/login', { credential: 'test-credential' }, cookie);
  const rotated = cookieFrom(second);
  assert.notEqual(rotated, cookie);
  assert.deepEqual(await (await app.get('/auth/session', cookie)).json(), { user: null });
  const logout = await app.post('/auth/logout', {}, rotated);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.deepEqual(await (await app.get('/auth/session', rotated)).json(), { user: null });
  assert.equal((await app.post('/auth/logout', {})).status, 200);
});

test('production cookies are Secure and host-prefixed behind the trusted HTTPS proxy', async t => {
  const app = await fixture(t, {}, {
    SITE_ORIGIN: 'https://example.com', SESSION_COOKIE_SECURE: 'true', TRUST_PROXY: '1'
  });
  const response = await app.post('/auth/login', { credential: 'test-credential' }, null, {
    'X-Forwarded-Proto': 'https'
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^__Host-jgv3d\.sid=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.match(response.headers.get('set-cookie'), /; HttpOnly/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /Domain=/);
});

test('tampered session cookies cannot authenticate', async t => {
  const app = await fixture(t);
  const login = await app.post('/auth/login', { credential: 'test-credential' });
  const cookie = cookieFrom(login);
  assert.deepEqual(await (await app.get('/auth/session', `${cookie}tampered`)).json(), { user: null });
});

test('foreign/missing origins and non-JSON bodies cannot log in or log out', async t => {
  const app = await fixture(t);
  const login = await app.post('/auth/login', { credential: 'test-credential' });
  const cookie = cookieFrom(login);
  for (const route of ['/auth/login', '/auth/logout']) {
    for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) {
      const response = await app.post(route, { credential: 'test-credential' }, cookie, headers);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
  assert.equal((await (await app.get('/auth/session', cookie)).json()).user.id, 'google-user');
});

test('missing, malformed, and oversized credentials fail without setting sessions', async t => {
  const app = await fixture(t);
  for (const body of [{}, { credential: 123 }, { credential: '' }, { credential: 'x'.repeat(12001) }]) {
    const response = await app.post('/auth/login', body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await app.post('/auth/login', '{')).status, 400);
  assert.equal((await app.post('/auth/login', { credential: 'x'.repeat(17000) })).status, 413);
});

test('login attempts are rate limited before Google verification', async t => {
  let verifications = 0;
  const app = await fixture(t, {
    verifyIdToken: async () => {
      verifications++;
      throw new Error('invalid');
    }
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await app.post('/auth/login', { credential: 'invalid-token' })).status, 401);
  }
  const response = await app.post('/auth/login', { credential: 'invalid-token' });
  assert.equal(response.status, 429);
  assert.equal(verifications, 20);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('invalid, expired, and wrong-audience Google tokens are rejected', async t => {
  const app = await fixture(t, {
    verifyIdToken: async () => { throw new Error('verification failed'); }
  });
  const response = await app.post('/auth/login', { credential: 'invalid-token' });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await (await app.get('/auth/session')).json(), { user: null });
});

test('unverified or incomplete Google profiles are rejected', async t => {
  for (const payload of [null, {}, { sub: 'id', email: 'user@example.com', email_verified: false },
    { sub: 'id', email_verified: true }]) {
    const app = await fixture(t, { verifyIdToken: async () => ({ getPayload: () => payload }) });
    const response = await app.post('/auth/login', { credential: 'test-credential' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('session storage failures return generic errors without leaking details', async t => {
  const session = require('express-session');
  const store = new session.MemoryStore();
  store.set = (id, data, callback) => callback(new Error('private storage details'));
  const app = await fixture(t, { store });
  const response = await app.post('/auth/login', { credential: 'test-credential' });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: 'Authentication service unavailable.' });
});

test('public site assets remain available but backend and configuration files are private', async t => {
  const app = await fixture(t);
  for (const route of ['/', '/login.html', '/cart.html', '/orders.html', '/style.css', '/auth-client.js', '/data/shop.csv']) {
    assert.equal((await app.get(route)).status, 200, route);
  }
  for (const route of ['/server.js', '/.env', '/.env.example', '/package.json', '/package-lock.json',
    '/AUTH_SETUP.md', '/test/server.test.js', '/node_modules/express/package.json']) {
    assert.equal((await app.get(route)).status, 404, route);
  }
});

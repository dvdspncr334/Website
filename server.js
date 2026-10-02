const express = require('express');
const session = require('express-session');
const { OAuth2Client } = require('google-auth-library');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const { rateLimit } = require('express-rate-limit');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const SESSION_TTL = 8 * 60 * 60 * 1000;

function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const clientId = env.GOOGLE_CLIENT_ID;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || clientId.includes('YOUR_GOOGLE_CLIENT_ID') ||
      !clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error('Set GOOGLE_CLIENT_ID to your Google Web application client ID.');
  }
  if (!sessionSecret || sessionSecret.length < 32 || sessionSecret.includes('REPLACE_WITH')) {
    throw new Error('Set SESSION_SECRET to a cryptographically random secret of at least 32 characters.');
  }
  const origin = new URL(env.SITE_ORIGIN || 'http://localhost:3000');
  if (!['http:', 'https:'].includes(origin.protocol) ||
      origin.username || origin.password || origin.href !== `${origin.origin}/`) {
    throw new Error('SITE_ORIGIN must contain only the scheme, host and optional port.');
  }
  if (env.SESSION_COOKIE_SECURE && !['true', 'false'].includes(env.SESSION_COOKIE_SECURE)) {
    throw new Error('SESSION_COOKIE_SECURE must be true or false.');
  }
  const secure = env.SESSION_COOKIE_SECURE !== 'false';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((production && (!secure || origin.protocol !== 'https:')) ||
      (!secure && !loopback)) {
    throw new Error('HTTPS and Secure cookies are required outside local development.');
  }
  if (production && !env.REDIS_URL) {
    throw new Error('REDIS_URL is required in production for persistent shared sessions.');
  }
  const trustProxy = env.TRUST_PROXY || '0';
  if (!/^\d+$/.test(trustProxy)) {
    throw new Error('TRUST_PROXY must be a non-negative proxy hop count.');
  }
  return {
    clientId, sessionSecret, origin: origin.origin, secure,
    trustProxy: Number(trustProxy), redisUrl: env.REDIS_URL
  };
}

function createApp(config, { store, verifyIdToken } = {}) {
  const app = express();
  const googleClient = new OAuth2Client(config.clientId);
  const verify = verifyIdToken || (options => googleClient.verifyIdToken(options));
  const cookieName = config.secure ? '__Host-jgv3d.sid' : 'jgv3d.sid';
  const cookieOptions = {
    httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/'
  };
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 1000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' }
  }));
  app.use('/auth', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST' &&
        (req.get('Origin') !== config.origin || !req.is('application/json'))) {
      return res.status(403).json({ error: 'Request origin or content type not allowed.' });
    }
    next();
  }, express.json({ limit: '16kb' }), session({
    name: cookieName,
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookieOptions, maxAge: SESSION_TTL }
  }));

  app.get('/auth/config', (req, res) => {
    res.json({ clientId: config.clientId });
  });
  app.get('/auth/session', (req, res) => {
    res.json({ user: req.session.user || null });
  });
  app.post('/auth/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please try again later.' }
  }), async (req, res, next) => {
    const credential = req.body?.credential;
    if (typeof credential !== 'string' || !credential || credential.length > 12000) {
      return res.status(400).json({ error: 'A Google ID token is required.' });
    }
    let payload;
    try {
      const ticket = await verify({ idToken: credential, audience: config.clientId });
      payload = ticket.getPayload();
      if (!payload?.sub || !payload.email || payload.email_verified !== true) {
        return res.status(401).json({ error: 'Google account could not be verified.' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid or expired Google ID token.' });
    }
    const user = { id: payload.sub, email: payload.email, name: payload.name || '' };
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.user = user;
      req.session.save(error => {
        if (error) {
          req.session = null;
          return next(error);
        }
        res.json({ user });
      });
    });
  });
  app.post('/auth/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie(cookieName, cookieOptions);
      res.json({ user: null });
    });
  });
  app.use('/auth', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // Never expose the repository root through express.static: it contains server configuration.
  for (const directory of ['images', 'data']) {
    app.use(`/${directory}`, express.static(path.join(__dirname, directory), { dotfiles: 'deny' }));
  }
  const publicFiles = [
    ...readdirSync(__dirname).filter(file => file.endsWith('.html')),
    'style.css', 'order-utils.js', 'auth-client.js'
  ];
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  for (const file of publicFiles) {
    app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, file)));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 :
      error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Authentication service unavailable.' : 'Invalid request body.' });
  });
  return app;
}

async function start() {
  const config = readConfig();
  let store;
  if (config.redisUrl) {
    const redis = createClient({ url: config.redisUrl });
    redis.on('error', () => console.error('Redis connection error.'));
    await redis.connect();
    store = new RedisStore({ client: redis, prefix: 'jgv3d:session:' });
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  createApp(config, { store }).listen(port, () => {
    console.log(`Website server listening on port ${port}.`);
  });
}

if (require.main === module) {
  start().catch(() => {
    console.error('Server startup failed. Check authentication configuration and Redis connectivity.');
    process.exitCode = 1;
  });
}

module.exports = { createApp, readConfig };

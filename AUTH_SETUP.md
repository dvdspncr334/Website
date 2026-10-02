# Google sign-in setup

The website now uses the official Google Identity Services (GIS) button. The
browser sends a Google ID token to Express; `google-auth-library` verifies its
signature, issuer, expiry and audience before a server session is created.
Tokens are not stored in localStorage or returned as application access tokens.
Only the public client ID is exposed by `GET /auth/config`.

## 1. Configure Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select your
   project. In **Google Auth Platform**, configure Branding, Audience and Data
   Access (older consoles call this the OAuth consent screen).
2. Create a **Web application** OAuth client under Clients/Credentials, or use
   your existing Web client.
3. Add **Authorized JavaScript origins** for each exact scheme/host/port:
   - `http://localhost:3000` for development
   - `https://www.jgv3d.com` for production if that is your deployed origin
   Origins do not include `/login.html` or other paths. Add other domains only
   if you actually use them; redirect aliases to one canonical site origin.
4. If the app is in Testing, add the accounts that will test it as test users.
   Complete Google's publishing/verification requirements as applicable.
5. Copy the **client ID** into backend configuration as `GOOGLE_CLIENT_ID`.

**Do not send or commit your client secret.** This GIS ID-token flow needs no
client secret, redirect callback URI, Google+ API, or authorization-code exchange.
Do not follow older Google+ login instructions. It requests identity only, not
access to Drive, Gmail, or other Google APIs.

## 2. Run locally

Install Node.js **22.9 or newer** (a supported LTS release is recommended), then:

```sh
npm ci
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`:

- Replace `GOOGLE_CLIENT_ID` with your real public client ID.
- Replace `SESSION_SECRET` with the generated random value (at least 32 characters).
- Keep `SITE_ORIGIN=http://localhost:3000`, `NODE_ENV=development`,
  `SESSION_COOKIE_SECURE=false`, `TRUST_PROXY=0` for local HTTP testing.
- Leave `REDIS_URL` blank to use development-only in-memory sessions.

Run `npm start` and visit `http://localhost:3000/login.html`. Do not open the HTML
as a `file://` URL or use a separate static server. `.env` is gitignored and loaded
by Node's built-in environment-file support. Hosting-provided environment
variables take precedence.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Required Web application client ID; public, never a client secret. |
| `SESSION_SECRET` | Required random session signing secret; keep private and stable across instances. Changing it signs users out. |
| `SITE_ORIGIN` | Exact browser origin, with scheme and optional port, without a path; defaults to `http://localhost:3000`. |
| `PORT` | Node listener port, defaults to `3000`. |
| `NODE_ENV` | Use `production` on a deployed service. |
| `SESSION_COOKIE_SECURE` | Defaults to `true`; `false` is allowed only for HTTP loopback development, never in production. |
| `TRUST_PROXY` | Trusted proxy hop count, defaults to `0`; typically `1` behind one trusted TLS-terminating proxy. |
| `REDIS_URL` | Required in production; private Redis connection URL, preferably `rediss://` with TLS. Never expose its credentials. |

There is intentionally no `GOOGLE_CLIENT_SECRET` variable.

## 3. Deploy the backend and website

GitHub Pages and other static-only hosts **cannot run Express**. Publishing this
HTML to Pages alone does not enable login. Deploy this repository to a Node-capable
service/container, or route your existing site's `/auth/*` requests through a
trusted reverse proxy to the Node service. The supported arrangement is
**same-origin**: HTML and `/auth/*` share one browser origin. No cross-origin
credentials/CORS configuration is required or enabled.

1. Install dependencies with `npm ci --omit=dev` and start with `npm start`.
   Supply configuration using the host's secret/environment settings, not files
   committed to the repository.
2. Provision a private Redis instance; set `REDIS_URL`. Sessions are stored in
   Redis with expiry. Without Redis, development sessions disappear on restart
   and cannot be shared across processes. Production startup refuses that mode.
3. Set `NODE_ENV=production`, `SITE_ORIGIN=https://your-domain.example`,
   `SESSION_COOKIE_SECURE=true` and your real `GOOGLE_CLIENT_ID`/`SESSION_SECRET`.
4. Terminate HTTPS at your hosting platform or reverse proxy. Set `TRUST_PROXY`
   to the actual trusted hop count. A single proxy commonly requires `1`; use
   `0` if Node directly handles requests. Never allow clients to bypass the
   proxy or spoof forwarded headers. The proxy must forward `Origin` and set
   `X-Forwarded-Proto: https`, or secure session cookies will not be issued.
5. Point DNS at the new hosting service (or configure same-origin proxy routing),
   update Google's Authorized JavaScript origins, and redirect HTTP to HTTPS.
   The existing `CNAME` file is not Node hosting configuration.
6. Apply edge/proxy rate limits to `/auth/login` and request-size/time limits.
   Keep Redis private, enforce TLS where appropriate, restrict access to session
   data, and monitor availability without logging credentials, tokens, cookies,
   Redis URLs or user profiles. Keep Node and dependencies patched.

The server serves only root HTML pages, shared browser JS/CSS, `images/` and
`data/`. Backend source, environment files, package metadata and documentation
are not public. If keeping another static host, also exclude those private files
from that host's publish output.

Cookies are HttpOnly, Secure by default, SameSite=Lax, host-only and scoped to `/`.
Secure deployments use the `__Host-` cookie prefix. Sessions expire after eight
hours without renewal; Google ID tokens are used only to establish the session.
Login rotates the session identifier to prevent fixation. Logout destroys the
server session and expires its cookie. POST requests require the configured
Origin and JSON content type, protecting login/logout from cross-site requests.
Do not strip Origin headers or enable permissive CORS to work around errors.
Logout signs out of this website only, not the user's Google account.

## API and frontend utilities

- `GET /auth/config` → `{ "clientId": "..." }`
- `GET /auth/session` → `{ "user": null }` or a verified `{ id, email, name }`
- `POST /auth/login` with JSON `{ "credential": "<GIS ID token>" }` → `{ "user": ... }`
- `POST /auth/logout` with JSON `{}` → `{ "user": null }`

The auth responses are not cached. `auth-client.js` exports `getSession`,
`signIn`, `signOut` and `initializeGoogleSignIn` for other frontend modules.
It also wires up the login page, renders user text safely, handles load/network
errors, and disables Google automatic account selection after logout.

**Scope:** Cart and orders remain existing browser-local data. Login does not
upload, sync, associate or protect those records, and orders pages remain public.
Real private order history requires a separate server-side order database and
authorization checks using `req.session.user.id` on every protected API. Do not
use browser localStorage or frontend visibility as access control.

## Verification and troubleshooting

Run `npm test` for backend tests (verification is mocked; no Google credentials
or network calls needed), and `npm audit --omit=dev` for dependency checks.

With your real client ID, manually verify:

1. Add items to the cart, open login, and confirm the mini-cart count is unchanged.
2. Sign in with Google; the page shows your email and a sign-out button. Reload
   and confirm the session persists.
3. Inspect the session cookie in browser devtools: HttpOnly, SameSite=Lax and
   Secure in production. Confirm no auth tokens appear in localStorage.
4. Sign out and reload; the Google button returns, the server session is gone,
   and cart/orders data remains unchanged.
5. Try an invalid/expired token: `/auth/login` must return 401 and no new session.
   Requests with a foreign or missing Origin must fail with 403.

If GIS reports an invalid client or origin, check client type, exact Authorized
JavaScript origins, and test-user settings. If the login UI says the host is not
configured, check that `/auth/config` reaches Node rather than a static HTML
fallback. If login succeeds but reload loses the session, inspect HTTPS,
`TRUST_PROXY`, cookies and Redis. Check ad blockers/network restrictions if the
GIS script cannot load. CSP-enabled hosts must allow the GIS script/frame/connect
origins according to [Google's GIS setup guidance](https://developers.google.com/identity/gsi/web/guides/client-library).

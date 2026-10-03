// Static checks for the admin dashboard page wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const admin = read('admin.html');

test('admin page is gated by isAdmin() and redirects to login.html', () => {
  assert.match(admin, /import \{ loadFirebase, isAdmin, clearAdminCache \} from '\.\/admin-auth\.js'/);
  assert.match(admin, /allowed = await isAdmin\(\)/);
  assert.match(admin, /location\.replace\('login\.html\?admin=denied'\)/);
  assert.match(admin, /location\.replace\('login\.html'\)/);
  assert.match(admin, /<div id="admin-app" hidden>/);
});

test('admin page has logout and a link back to the site, but no cart badge', () => {
  assert.match(admin, /id="logout-btn"/);
  assert.match(admin, /href="index\.html">&larr; Back to site/);
  assert.doesNotMatch(admin, /mini-cart/);
  assert.doesNotMatch(admin, /cart-service\.js/);
});

test('admin page renders data with textContent and never logs or stores secrets', () => {
  assert.doesNotMatch(admin, /innerHTML/);
  assert.doesNotMatch(admin, /console\./);
  assert.doesNotMatch(admin, /(localStorage|sessionStorage)\.setItem/);
  assert.match(admin, /id="gh-token" type="password"/);
  assert.match(admin, /https:\/\/api\.github\.com\/repos\//);
});

test('orders are clearly labelled as browser-local demo data', () => {
  assert.match(admin, /Orders are browser-local demo data/);
});

test('activity tracking and admin helpers stay out of auth-firebase.js', () => {
  assert.match(read('mini-cart.js'), /import\('\.\/user-activity\.js'\)/);
  assert.match(read('login.html'), /from '\.\/admin-auth\.js'/);
  assert.match(read('login.html'), /id="admin-link"/);
});

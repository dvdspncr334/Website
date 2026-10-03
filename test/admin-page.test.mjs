// Static checks for the admin dashboard page wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as shopTools from '../shop-csv.js';
import * as adminTools from '../admin-tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const admin = read('admin.html');

test('admin page is gated by isAdmin() and redirects to login.html', () => {
  assert.match(admin, /import \{ loadFirebase, isAdmin, clearAdminCache, deleteUserActivity, clearUserActivity \} from '\.\/admin-auth\.js'/);
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
  assert.match(admin, /auditStorage = window\.sessionStorage/);
  assert.match(admin, /createSessionAudit\(auditStorage\)/);
  assert.doesNotMatch(admin, /recordAudit\([^;]*(?:gh-token|requestHeaders|Authorization)/);
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

test('dashboard is first, all five tabs are linked to accessible panels, and dialogs are native', () => {
  const tabs = [...admin.matchAll(/role="tab" id="([^"]+)" aria-controls="([^"]+)"/g)];
  assert.deepEqual(tabs.map(match => match[1]), ['tab-dashboard', 'tab-shop', 'tab-activity', 'tab-orders', 'tab-settings']);
  for (const [, tab, panel] of tabs) assert.match(admin, new RegExp(`id="${panel}"[^>]+aria-labelledby="${tab}"`));
  assert.match(admin, /openPanel\('panel-dashboard'\)/);
  assert.match(admin, /<dialog id="confirm-dialog"[^>]+aria-labelledby="confirm-title"/);
  assert.match(admin, /<dialog id="bulk-dialog"[^>]+aria-labelledby="bulk-title"/);
  assert.doesNotMatch(admin, /fs\.limit\(50\)/);
  assert.match(read('style.css'), /\.admin-dialog::backdrop/);
  assert.match(read('style.css'), /\.admin-page \[hidden\]/);
  assert.match(admin, /id="bulk-toolbar"[^>]*hidden/);
  for (const label of ['Bulk update status', 'Bulk update discount %', 'Bulk update price']) assert.ok(admin.includes(`>${label}</button>`));
  assert.doesNotMatch(admin, /id="bulk-open"/);
});

// A minimal DOM fixture exercises the actual inline controller without Firebase
// network calls or a browser dependency. Helpers are the production implementations.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.className = '';
    this.classList = { toggle: () => {} };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent ?? String(child)).join(''); }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, handler, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, once: options.once });
    this.listeners.set(type, list);
  }
  emit(type) {
    const list = [...(this.listeners.get(type) || [])];
    this.listeners.set(type, list.filter(item => !item.once));
    return Promise.all(list.map(({ handler }) => handler({ preventDefault() {}, key: '', target: this })));
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => child instanceof Element ? [child, ...child.querySelectorAll('*')] : []);
    return selector === '*' ? descendants : descendants.filter(child => child.tagName === 'INPUT' && child.type === 'checkbox');
  }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  focus() {}
  scrollIntoView() {}
  remove() {}
  showModal() { this.open = true; }
  close(value = '') { this.returnValue = value; this.open = false; this.emit('close'); }
  click() { this.onClick?.(); this.emit('click'); }
}

const validProducts = () => [
  { id: 'alpha', title: 'Alpha', price: '10', img: 'images/a.png', status: 'in-stock' },
  { id: 'beta', title: 'Beta', price: '20', img: 'images/b.png', status: 'preorder' },
  { id: 'gamma', title: 'Gamma', price: '30', img: 'images/c.png', status: 'in-stock' }
].map(product => shopTools.normalizeProduct(product));

function fixture({ users = [], admins = [], failRead = false, failClear = false, failDelete = false, failDownload = false, denied = false, blockedStorage = false } = {}) {
  const elements = new Map();
  for (const match of admin.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el = new Element(match[1]);
    el.id = match[3];
    el.hidden = /\bhidden\b/.test(match[2]);
    el.disabled = /\bdisabled\b/.test(match[2]);
    el.value = /value="([^"]*)"/.exec(match[2])?.[1] || '';
    el.className = /class="([^"]*)"/.exec(match[2])?.[1] || '';
    const panel = /data-panel="([^"]*)"/.exec(match[2])?.[1];
    if (panel) el.dataset.panel = panel;
    elements.set(el.id, el);
  }
  const get = id => elements.get(id) || [...elements.values()].flatMap(el => el.querySelectorAll('*')).find(el => el.id === id);
  get('activity-sort').value = 'lastActiveAt';
  get('activity-direction').value = 'desc';
  const reads = [], downloads = [], deletions = [], checks = [];
  const blobs = new Map();
  const storage = new Map([['jgv3d_admin_audit', '[{"action":"previous refresh"}]'], ['jgv3d_orders', '[{"id":"demo"}]'], ['jgv3d_cart', 'keep']]);
  const sessionStorage = {
    getItem: key => storage.get(key),
    setItem: (key, value) => { if (blockedStorage) throw new Error('blocked'); storage.set(key, value); }
  };
  let currentUsers = users;
  let failActivity = failRead;
  let failDeletion = failDelete;
  let csvFetches = 0;
  const fs = {
    collection: (_, name) => name,
    doc: (_, name, uid) => `${name}/${uid}`,
    deleteDoc: async ref => { deletions.push(ref); },
    getDoc: async () => ({ exists: () => false }),
    setDoc: async (ref, data) => { admins.push({ uid: ref.split('/')[1], ...data }); },
    serverTimestamp: () => new Date(),
    where: (_, __, emails) => ({ emails }),
    limit: count => ({ count }),
    query: (name, ...options) => ({ name, emails: options.find(option => option.emails)?.emails }),
    getDocs: async name => {
      const emails = name.emails;
      name = name.name || name;
      reads.push(name);
      if (name === 'userActivity' && failActivity) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      const records = (name === 'userActivity' ? currentUsers : admins).filter(record => !emails || emails.includes(record.email));
      const docs = records.map(record => ({ id: record.uid, data: () => ({ ...record }), get: key => record[key] }));
      return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
    }
  };
  const document = {
    getElementById: get,
    querySelectorAll: selector => [...elements.values()].filter(el => el.className.split(' ').includes(selector.slice(1))),
    createElement: tag => {
      const el = new Element(tag);
      if (tag === 'a') el.onClick = () => {
        if (failDownload) throw new Error('download blocked');
        downloads.push({ filename: el.download, blob: blobs.get(el.href) });
      };
      return el;
    },
    createTextNode: text => ({ textContent: text }),
    body: new Element('body')
  };
  const context = vm.createContext({
    ...shopTools, ...adminTools, document, Blob, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto,
    window: { sessionStorage, addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key),
      removeItem: key => { if (blockedStorage) throw new Error('blocked'); deletions.push(key); storage.delete(key); }
    },
    URL: { createObjectURL: blob => { const key = `blob:${blobs.size}`; blobs.set(key, blob); return key; }, revokeObjectURL() {} },
    setTimeout() {}, location: { replace() {}, reload() {} }, confirm: () => true, alert() {},
    fetch: async () => {
      csvFetches++;
      const bytes = new TextEncoder().encode(shopTools.serializeShopCSV(shopTools.SHOP_COLUMNS, validProducts()));
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    },
    isAdmin: async options => { checks.push(options); return !denied; },
    clearAdminCache() {}, loadFirebase: async () => ({ fs, db: {} }),
    deleteUserActivity: async uid => {
      if (denied) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      if (failDeletion) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      deletions.push(`userActivity/${uid}`);
      currentUsers = currentUsers.filter(user => user.uid !== uid);
    },
    clearUserActivity: async ({ onProgress }) => {
      if (failClear) { currentUsers = currentUsers.slice(450); onProgress(450); throw new Error('offline'); }
      const count = currentUsers.length;
      currentUsers = [];
      onProgress(count);
      return count;
    }
  });
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(admin)[1]
    .replace(/^\s*import[\s\S]*?from '[^']+';/gm, '')
    .replace(/\bstart\(\);\s*$/, '');
  vm.runInContext(`${script}
    fb = { fs: globalThis.testFS, db: {} };
    currentUid = 'admin-current';
    globalThis.page = {
      loadDashboard, loadActivity, renderActivity, renderProducts, ensureProducts, openForm, deleteProduct, removeActivity, removeAdmin, recordAudit,
      state: () => ({ rows, selected: [...selectedProducts], dirty, audit: audit.entries(), users: activityUsers })
    };`, Object.assign(context, { testFS: fs }));
  return {
    get, page: context.page, storage, downloads, reads, deletions, checks,
    csvFetches: () => csvFetches,
    setUsers: records => { currentUsers = records; },
    allowReads: () => { failActivity = false; },
    allowDeletes: () => { failDeletion = false; }
  };
}

async function confirmTwice(f) {
  assert.equal(f.get('confirm-dialog').open, true);
  await f.get('confirm-form').emit('submit');
  await Promise.resolve();
  assert.equal(f.get('confirm-dialog').open, true);
  assert.equal(f.get('confirm-label').hidden, false);
  f.get('confirm-text').value = 'confirm-clear';
  await f.get('confirm-text').emit('input');
  await f.get('confirm-form').emit('submit');
}

test('dashboard loads CSV and every activity record, counts sign-ins rather than activity, and refreshes', async () => {
  const now = Date.now();
  const users = Array.from({ length: 60 }, (_, index) => ({ uid: `u${index}`, email: `${index}@example.com`, lastSignInAt: now - 1000 }));
  users.push({ uid: 'old', email: 'old@example.com', lastSignInAt: now - 9 * 86400000, lastActiveAt: now });
  users.push({ uid: 'recent', email: 'recent@example.com', lastSignInAt: now - 3 * 86400000 });
  const f = fixture({ users });
  await f.page.loadDashboard();
  assert.equal(f.csvFetches(), 1);
  assert.equal(f.get('stat-products').textContent, '3');
  assert.equal(f.get('stat-active').textContent, '60');
  assert.equal(f.get('stat-recent').textContent, '61');
  assert.equal(f.get('activity-rows').children.length, 62);
  assert.match(f.get('activity-count').textContent, /Total: 62 · Filtered: 62/);
  f.setUsers([{ uid: 'one', lastSignInAt: now }]);
  await f.page.loadActivity();
  assert.equal(f.get('stat-active').textContent, '1');
  assert.equal(f.get('stat-recent').textContent, '1');
  await f.page.ensureProducts();
  assert.equal(f.csvFetches(), 1);
});

test('activity retry restores unavailable counts, filters local inclusive days and exports only matching sorted records', async () => {
  const users = [
    { uid: 'a', email: 'Zulu@example.com', lastSignInAt: new Date(2026, 5, 5, 23, 59, 59, 999), lastActiveAt: new Date(2026, 5, 8) },
    { uid: 'b', email: 'alpha@example.com', lastSignInAt: new Date(2026, 5, 5), lastActiveAt: new Date(2026, 5, 7) },
    { uid: 'c', email: 'other@example.com', lastSignInAt: new Date(2026, 5, 6) },
    { uid: 'd', email: 'unknown@example.com', lastActiveAt: new Date(2026, 5, 5) }
  ];
  const f = fixture({ users, failRead: true });
  await f.page.loadDashboard();
  assert.equal(f.get('stat-active').textContent, '—');
  assert.equal(f.get('activity-retry').hidden, false);
  assert.match(f.get('dashboard-status').textContent, /could not be loaded/);
  f.allowReads();
  await f.get('activity-retry').emit('click');
  f.get('activity-start').value = '2026-06-05';
  f.get('activity-end').value = '2026-06-05';
  f.get('activity-sort').value = 'email';
  f.get('activity-direction').value = 'asc';
  await f.get('activity-end').emit('change');
  assert.match(f.get('activity-count').textContent, /Total: 4 · Filtered: 2/);
  assert.equal(f.get('activity-rows').children[0].children[0].textContent, 'alpha@example.com');
  f.get('activity-email').value = 'ZULU';
  await f.get('activity-email').emit('input');
  await f.get('activity-export').emit('click');
  const csv = await f.downloads[0].blob.text();
  assert.equal(csv.split('\r\n')[0], '"Email","Last sign-in","Last active","UID"');
  assert.match(csv, /Zulu@example.com/);
  assert.doesNotMatch(csv, /alpha@example|other@example|unknown@example/);
  assert.equal(f.page.state().audit.at(-1).count, 1);
  f.get('activity-start').value = '2026-06-07';
  await f.get('activity-start').emit('change');
  assert.equal(f.get('activity-export').disabled, true);
});

test('select-all affects visible products only; bulk validates, previews, confirms selected rows and clears selection', async () => {
  const f = fixture();
  await f.page.ensureProducts();
  assert.equal(f.get('bulk-toolbar').hidden, true);
  f.get('product-search').value = 'Alpha';
  f.page.renderProducts();
  f.get('select-visible').checked = true;
  await f.get('select-visible').emit('change');
  assert.equal(f.page.state().selected.join(','), 'alpha');
  assert.equal(f.get('bulk-toolbar').hidden, false);
  f.get('product-search').value = '';
  f.page.renderProducts();
  const beta = f.get('product-rows').children[1].children[0].children[0];
  beta.checked = true;
  await beta.emit('change');
  assert.equal(f.get('select-visible').indeterminate, true);
  await f.get('bulk-price-open').emit('click');
  assert.equal(f.get('bulk-field').value, 'price');
  f.get('bulk-number-value').value = '-1';
  await f.get('bulk-form').emit('submit');
  assert.equal(f.get('bulk-confirm').disabled, true);
  assert.match(f.get('bulk-message').textContent, /price|Price/);
  assert.equal(f.page.state().rows[0].price, '10');
  f.get('bulk-number-value').value = '25.50';
  await f.get('bulk-form').emit('submit');
  const preview = f.get('bulk-preview-rows').children;
  assert.equal(preview.length, 2);
  assert.equal(preview[0].children.map(el => el.textContent).join('|'), 'alpha|Alpha|10|25.50');
  await f.get('bulk-confirm').emit('click');
  assert.equal(f.page.state().rows.map(row => row.price).join(','), '25.50,25.50,30');
  assert.equal(f.page.state().selected.length, 0);
  assert.equal(f.get('bulk-toolbar').hidden, true);
  assert.equal(f.page.state().dirty, true);
  assert.equal(f.get('bulk-dialog').open, false);
  assert.match(f.page.state().audit.at(-1).details, /alpha, beta; price=25\.50/);
  await f.page.ensureProducts();
  assert.equal(f.csvFetches(), 1, 'in-memory bulk changes are not overwritten');
});

test('destructive product deletion requires both modal steps and exact typed confirmation, and supports cancellation', async () => {
  const f = fixture();
  await f.page.ensureProducts();
  let pending = f.page.deleteProduct(0);
  await f.get('confirm-cancel').emit('click');
  await pending;
  assert.equal(f.page.state().rows.length, 3);
  pending = f.page.deleteProduct(0);
  await f.get('confirm-form').emit('submit');
  f.get('confirm-text').value = 'CONFIRM-CLEAR';
  await f.get('confirm-form').emit('submit');
  assert.equal(f.get('confirm-dialog').open, true);
  assert.equal(f.page.state().rows.length, 3);
  await f.get('confirm-cancel').emit('click');
  await pending;
  pending = f.page.deleteProduct(0);
  await confirmTwice(f);
  await pending;
  assert.equal(f.page.state().rows.map(row => row.id).join(','), 'beta,gamma');
  assert.equal(f.get('stat-products').textContent, '2');
  assert.match(f.page.state().audit.at(-1).details, /alpha/);
});

test('individual activity deletion changes only its record and updates dashboard counts', async () => {
  const f = fixture({ users: [{ uid: 'u1', email: 'u@example.com', lastSignInAt: Date.now() }] });
  await f.page.loadDashboard();
  const pending = f.page.removeActivity(f.page.state().users[0]);
  await confirmTwice(f);
  await pending;
  assert.deepEqual(f.deletions, ['userActivity/u1']);
  assert.equal(f.get('stat-active').textContent, '0');
  assert.equal(f.get('stat-recent').textContent, '0');
  assert.match(f.get('activity-count').textContent, /Total: 0 · Filtered: 0/);
  assert.match(f.get('activity-status').textContent, /Account and admin access were not changed/);
});

test('backup uses edited memory products, all collections, safe fields, timestamp filename and byte feedback', async () => {
  const f = fixture({
    users: [{ uid: 'u1', email: 'u@example.com', lastSignInAt: Date.now(), token: 'DO_NOT_EXPORT' }],
    admins: [{ uid: 'a1', email: 'a@example.com', addedBy: 'owner', addedAt: Date.now(), credential: 'DO_NOT_EXPORT' }]
  });
  await f.page.ensureProducts();
  f.page.state().rows[0].price = '99';
  f.get('gh-token').value = 'DO_NOT_EXPORT';
  await f.get('backup-download').emit('click');
  assert.equal(f.csvFetches(), 1);
  assert.deepEqual(f.reads, ['userActivity', 'admins'], 'backup never reads shop products from Firestore');
  assert.match(f.downloads[0].filename, /^jgv3d-backup-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  const text = await f.downloads[0].blob.text();
  const data = JSON.parse(text);
  assert.equal(data.products[0].price, '99');
  assert.equal(data.users.length, 1);
  assert.equal(data.admins.length, 1);
  assert.doesNotMatch(text, /DO_NOT_EXPORT|credential|token/);
  assert.match(data.timestamp, /Z$/);
  assert.match(f.get('backup-status').textContent, /bytes/);
  assert.equal(f.page.state().audit.map(entry => entry.action).join(','), 'Backup download');
});

test('maintenance freshly checks permission, reports partial committed progress and refreshes remaining activity', async () => {
  const users = Array.from({ length: 451 }, (_, index) => ({ uid: `u${index}`, lastSignInAt: Date.now() }));
  const f = fixture({ users, failClear: true });
  await f.page.loadActivity();
  const pending = f.get('clear-activity').emit('click');
  await confirmTwice(f);
  await pending;
  assert.deepEqual(f.checks.map(options => options.force), [true]);
  assert.match(f.get('maintenance-status').textContent, /failed after 450 confirmed deletion/);
  assert.match(f.get('activity-count').textContent, /Total: 1 · Filtered: 1/);
  assert.equal(f.page.state().audit.at(-1).count, 450);
  const denied = fixture({ users, denied: true });
  const deniedPending = denied.get('clear-activity').emit('click');
  await confirmTwice(denied);
  await deniedPending;
  assert.match(denied.get('maintenance-status').textContent, /failed after 0/);
  assert.equal(denied.page.state().users.length, 451);
});

test('local order reset removes only the order key; audit resets on refresh and renders unsafe strings as text', async () => {
  const f = fixture();
  assert.equal(f.page.state().audit.length, 0);
  f.storage.set('jgv3d_orders', '[{"id":"one"},{"id":"two"},null]');
  const pending = f.get('reset-orders').emit('click');
  await confirmTwice(f);
  await pending;
  assert.deepEqual(f.deletions, ['jgv3d_orders']);
  assert.equal(f.storage.get('jgv3d_cart'), 'keep');
  assert.equal(f.page.state().audit.at(-1).count, 2);
  f.page.recordAudit('test', '<img src=x onerror=bad()>');
  assert.equal(f.get('audit-rows').children[0].children[2].textContent, '<img src=x onerror=bad()>');
  assert.equal(f.get('audit-rows').children[0].children[2].children.length, 0);
  let clearPending = f.get('audit-clear').emit('click');
  await f.get('confirm-cancel').emit('click');
  await clearPending;
  assert.equal(f.page.state().audit.length, 2);
  clearPending = f.get('audit-clear').emit('click');
  await confirmTwice(f);
  await clearPending;
  assert.equal(f.page.state().audit.length, 0);
  assert.equal(f.storage.get('jgv3d_admin_audit'), '[]');
  const blocked = fixture({ blockedStorage: true });
  blocked.page.recordAudit('memory-only', 'no credentials');
  assert.equal(blocked.page.state().audit.length, 1);
});

test('product add and edit audit records contain IDs and selection follows an edited ID', async () => {
  const f = fixture();
  await f.page.ensureProducts();
  f.page.openForm(-1);
  f.get('field-id').value = 'delta';
  f.get('field-title').value = 'Delta';
  f.get('field-price').value = '40';
  f.get('field-img').value = 'images/d.png';
  await f.get('product-form').emit('submit');
  assert.equal(f.page.state().rows.length, 4);
  assert.equal(f.get('stat-products').textContent, '4');
  assert.equal(f.page.state().audit.at(-1).action, 'Product added');
  const checkbox = f.get('product-rows').children[3].children[0].children[0];
  checkbox.checked = true;
  await checkbox.emit('change');
  f.page.openForm(3);
  f.get('field-id').value = 'delta-new';
  await f.get('product-form').emit('submit');
  assert.equal(f.page.state().rows[3].id, 'delta-new');
  assert.equal(f.page.state().selected.join(','), 'delta-new');
  assert.equal(f.page.state().audit.at(-1).details, 'ID: delta → delta-new');
});

test('admin removal requires double typed confirmation and records only the UID', async () => {
  const f = fixture({ admins: [{ uid: 'other', email: 'other@example.com' }] });
  let pending = f.page.removeAdmin('other', 'other@example.com', 2);
  await f.get('confirm-cancel').emit('click');
  await pending;
  assert.equal(f.deletions.length, 0);
  pending = f.page.removeAdmin('other', 'other@example.com', 2);
  await confirmTwice(f);
  await pending;
  assert.deepEqual(f.deletions, ['admins/other']);
  assert.equal(f.page.state().audit.at(-1).action, 'Admin removed');
  assert.equal(f.page.state().audit.at(-1).details, 'UID: other');
});

test('admin addition records the matching activity UID without logging form data', async () => {
  const f = fixture({ users: [{ uid: 'new-admin', email: 'new@example.com' }] });
  f.get('add-admin-email').value = 'new@example.com';
  await f.get('add-admin-form').emit('submit');
  assert.equal(f.page.state().audit.at(-1).action, 'Admin added');
  assert.equal(f.page.state().audit.at(-1).details, 'UID: new-admin');
  assert.equal(f.get('add-admin-email').value, '');
});

test('bulk status and discount updates are validated and previewed before application', async () => {
  const f = fixture();
  await f.page.ensureProducts();
  for (const [field, value] of [['status', 'made-to-order'], ['discount', '12.5']]) {
    const checkbox = f.get('product-rows').children[0].children[0].children[0];
    checkbox.checked = true;
    await checkbox.emit('change');
    await f.get(`bulk-${field}-open`).emit('click');
    assert.equal(f.get('bulk-field').value, field);
    f.get(field === 'status' ? 'bulk-status-value' : 'bulk-number-value').value = value;
    await f.get('bulk-form').emit('submit');
    assert.notEqual(f.page.state().rows[0][field], value);
    await f.get('bulk-confirm').emit('click');
    assert.equal(f.page.state().rows[0][field], value);
    assert.notEqual(f.page.state().rows[1][field], value);
    assert.equal(f.page.state().selected.length, 0);
  }
});

test('bulk cancellation and changed-value preview invalidation never apply rows', async () => {
  const f = fixture();
  await f.page.ensureProducts();
  f.get('select-visible').checked = true;
  await f.get('select-visible').emit('change');
  await f.get('bulk-discount-open').emit('click');
  assert.equal(f.get('bulk-field').value, 'discount');
  f.get('bulk-number-value').value = '15';
  await f.get('bulk-form').emit('submit');
  assert.equal(f.get('bulk-confirm').disabled, false);
  f.get('bulk-number-value').value = '150';
  await f.get('bulk-number-value').emit('input');
  assert.equal(f.get('bulk-confirm').disabled, true);
  await f.get('bulk-confirm').emit('click');
  assert.equal(f.page.state().rows[0].discount, '');
  await f.get('bulk-cancel').emit('click');
  assert.equal(f.page.state().selected.length, 3);
  assert.equal(f.get('bulk-toolbar').hidden, false);
  assert.equal(f.page.state().audit.length, 0);
  f.get('select-visible').checked = false;
  await f.get('select-visible').emit('change');
  assert.equal(f.page.state().selected.length, 0);
  assert.equal(f.get('bulk-toolbar').hidden, true);
});

test('backup loads products when needed and never downloads an incomplete backup on read failure', async () => {
  assert.match(admin, /id="backup-download">Download full backup<\/button>/);
  assert.match(admin, /<h2>Database backup<\/h2>[\s\S]*?id="backup-status"[^>]*><\/p>\s*<\/div>\s*<div class="admin-card">\s*<h2>Maintenance<\/h2>/);
  const f = fixture();
  await f.get('backup-download').emit('click');
  assert.equal(f.csvFetches(), 1);
  assert.equal(JSON.parse(await f.downloads[0].blob.text()).products.length, 3);
  const failing = fixture({ failRead: true });
  await failing.get('backup-download').emit('click');
  assert.equal(failing.downloads.length, 0);
  assert.match(failing.get('backup-status').textContent, /no file downloaded/);
  assert.match(failing.get('backup-status').textContent, /Use Download full backup to retry/);
  assert.equal(failing.get('backup-download').disabled, false);
});

test('failed activity deletion offers an explicit retry with fresh double typed confirmation', async () => {
  const f = fixture({ users: [{ uid: 'retry-user', email: 'retry@example.com', lastSignInAt: Date.now() }], failDelete: true });
  await f.page.loadDashboard();
  let pending = f.page.removeActivity(f.page.state().users[0]);
  await confirmTwice(f);
  await pending;
  assert.equal(f.get('activity-delete-retry').hidden, false);
  assert.match(f.get('activity-status').textContent, /Use Retry activity deletion/);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.page.state().audit.length, 0);
  pending = f.get('activity-delete-retry').emit('click');
  await f.get('confirm-form').emit('submit');
  assert.equal(f.get('confirm-label').hidden, false);
  await f.get('confirm-cancel').emit('click');
  await pending;
  assert.equal(f.deletions.length, 0);
  assert.equal(f.get('activity-delete-retry').hidden, false);
  f.allowDeletes();
  pending = f.get('activity-delete-retry').emit('click');
  await confirmTwice(f);
  await pending;
  assert.deepEqual(f.deletions, ['userActivity/retry-user']);
  assert.equal(f.get('activity-delete-retry').hidden, true);
  assert.equal(f.get('stat-active').textContent, '0');
});

test('successful maintenance refreshes zero activity and cancelled resets keep storage unchanged', async () => {
  const f = fixture({ users: [{ uid: 'u1', lastSignInAt: Date.now() }] });
  let pending = f.get('clear-activity').emit('click');
  await f.get('confirm-cancel').emit('click');
  await pending;
  assert.equal(f.checks.length, 0);
  pending = f.get('clear-activity').emit('click');
  await confirmTwice(f);
  await pending;
  assert.equal(f.get('stat-active').textContent, '0');
  assert.match(f.get('maintenance-status').textContent, /Deleted 1 captured/);
  assert.equal(f.page.state().audit.at(-1).action, 'Activity cleared');
  pending = f.get('reset-orders').emit('click');
  await f.get('confirm-form').emit('submit');
  await f.get('confirm-cancel').emit('click');
  await pending;
  assert.equal(f.storage.get('jgv3d_orders'), '[{"id":"demo"}]');
});

test('audit CSV and JSON export snapshot entries without adding logs and protect spreadsheet cells', async () => {
  const f = fixture();
  f.page.recordAudit('@formula-action', '=SUM(1,2)\nSecond "line"', 3);
  f.page.recordAudit('Product updated', 'ID: alpha', 1);
  const before = f.page.state().audit;
  await f.get('audit-export-csv').emit('click');
  assert.match(f.downloads[0].filename, /^jgv3d-audit-\d{4}-\d{2}-\d{2}-\d{6}\.csv$/);
  const csv = await f.downloads[0].blob.text();
  assert.equal(csv.split('\r\n')[0], '"Timestamp","Action","Details","Changed items count"');
  assert.ok(csv.includes('"\u0027@formula-action"'));
  assert.ok(csv.includes('"\u0027=SUM(1,2)\nSecond ""line"""'));
  assert.match(csv, /"ID: alpha","1"/);
  assert.match(f.get('audit-export-status').textContent, /Exported 2 audit entries.*bytes/);
  await f.get('audit-export-json').emit('click');
  assert.match(f.downloads[1].filename, /^jgv3d-audit-\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
  assert.deepEqual(JSON.parse(await f.downloads[1].blob.text()), before);
  assert.deepEqual(f.page.state().audit, before, 'export does not change the exported list or count');
});

test('audit export failures show an explicit error and leave the session log intact', async () => {
  const f = fixture({ failDownload: true });
  f.page.recordAudit('Product added', 'ID: example', 1);
  for (const format of ['csv', 'json']) {
    await f.get(`audit-export-${format}`).emit('click');
    assert.match(f.get('audit-export-status').textContent, /Couldn't export audit log.*try again/);
    assert.match(f.get('audit-export-status').className, /is-error/);
    assert.equal(f.page.state().audit.length, 1);
    assert.equal(f.downloads.length, 0);
  }
});

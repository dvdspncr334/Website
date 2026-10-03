// Per-scope shop/gallery UI preferences (ui-prefs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui-prefs.js', import.meta.url), 'utf8');
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); }
  };
}

function load(storage) {
  const context = vm.createContext({ localStorage: storage });
  context.window = context;
  vm.runInContext(source, context);
  const api = context.JGV3DPrefs;
  // Return plain host-realm objects so deepEqual can compare them.
  const plain = value => JSON.parse(JSON.stringify(value));
  return {
    ...api,
    createScopedPrefs(options) {
      const prefs = api.createScopedPrefs(options);
      return { ...prefs, getMap: name => plain(prefs.getMap(name)) };
    }
  };
}

const SHOP_GUEST_KEYS = {
  shop_options: 'jgv3d_shop_selected_options',
  shop_drafts: 'jgv3d_custom_note_drafts',
  shop_category: 'jgv3d_last_category',
  shop_subcategory: 'jgv3d_last_subcategory'
};

// Simulates opening the shop page: a fresh prefs instance on the same browser storage.
function openPage(storage, scopeKey) {
  const prefs = load(storage).createScopedPrefs({ guestKeys: SHOP_GUEST_KEYS });
  if (scopeKey) prefs.setScope(scopeKey);
  return prefs;
}

test('signed-in selections persist across reloads in uid-namespaced keys', () => {
  const storage = memoryStorage();
  const first = openPage(storage, 'account:alice');
  first.setMap('shop_options', { strat: { color: 'Teal', pickup: 'HSS' } });
  first.setMap('shop_drafts', { strat: 'sparkle teal' });
  first.setString('shop_category', 'bodies');
  assert.equal(storage.data.get('jgv3d_prefs_v1:alice:shop_category'), 'bodies');

  const reloaded = openPage(storage, 'account:alice');
  assert.deepEqual(reloaded.getMap('shop_options'), { strat: { color: 'Teal', pickup: 'HSS' } });
  assert.deepEqual(reloaded.getMap('shop_drafts'), { strat: 'sparkle teal' });
  assert.equal(reloaded.getString('shop_category'), 'bodies');
});

test('two accounts in one browser never see each other\'s selections and guest keys stay untouched', () => {
  const storage = memoryStorage({
    jgv3d_shop_selected_options: JSON.stringify({ strat: { color: 'Guest Red' } }),
    jgv3d_last_category: 'necks'
  });
  const before = new Map(storage.data);
  const alice = openPage(storage, 'account:alice');
  assert.deepEqual(alice.getMap('shop_options'), {}, 'guest prefs are not copied into an account');
  assert.equal(alice.getString('shop_category'), null);
  alice.setMap('shop_options', { strat: { color: 'Alice Blue' } });
  const bob = openPage(storage, 'account:bob');
  assert.deepEqual(bob.getMap('shop_options'), {});
  bob.setMap('shop_options', { strat: { color: 'Bob Green' } });
  assert.deepEqual(openPage(storage, 'account:alice').getMap('shop_options'), { strat: { color: 'Alice Blue' } });
  const guest = openPage(storage, 'guest');
  assert.deepEqual(guest.getMap('shop_options'), { strat: { color: 'Guest Red' } });
  assert.equal(guest.getString('shop_category'), 'necks');
  for (const [key, value] of before) assert.equal(storage.data.get(key), value, `${key} unchanged`);
});

test('an account switch mid-page drops in-memory state and reads only the new scope', () => {
  const storage = memoryStorage({
    'jgv3d_prefs_v1:alice:shop_category': 'bodies',
    'jgv3d_prefs_v1:bob:shop_category': 'necks'
  });
  const prefs = openPage(storage);
  // While sign-in is pending nothing is read from or written to storage.
  assert.equal(prefs.getString('shop_category'), null);
  prefs.setString('shop_category', 'pending-choice');
  assert.equal(prefs.getString('shop_category'), 'pending-choice');
  assert.equal(prefs.setScope('account:alice'), true);
  assert.equal(prefs.getString('shop_category'), 'bodies', 'pending memory is discarded, not copied');
  assert.equal(prefs.setScope('account:alice'), false, 'same scope does not trigger a re-render');
  assert.equal(prefs.setScope('account:bob'), true);
  assert.equal(prefs.getString('shop_category'), 'necks');
  assert.equal(prefs.setScope('guest'), true);
  assert.equal(prefs.getString('shop_category'), null);
  assert.ok(![...storage.data.values()].includes('pending-choice'));
  // Sign-out keeps the account's prefs for its next sign-in.
  assert.equal(storage.data.get('jgv3d_prefs_v1:alice:shop_category'), 'bodies');
});

test('storage errors are handled and account data is bounded and pruned', () => {
  const failing = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() {}
  };
  const blocked = openPage(failing, 'account:alice');
  assert.equal(blocked.setMap('shop_options', { a: { color: 'x' } }), false);
  assert.deepEqual(blocked.getMap('shop_options'), {});

  const storage = memoryStorage({ 'jgv3d_prefs_v1:alice:shop_options': '{not json' });
  const prefs = openPage(storage, 'account:alice');
  assert.deepEqual(prefs.getMap('shop_options'), {}, 'corrupt data is ignored');
  const many = {};
  for (let i = 0; i < 250; i += 1) many[`p${i}`] = { color: 'c' };
  prefs.setMap('shop_options', many);
  const stored = JSON.parse(storage.data.get('jgv3d_prefs_v1:alice:shop_options'));
  assert.equal(Object.keys(stored).length, 200);
  assert.equal('p249' in stored && !('p0' in stored), true, 'oldest entries are dropped first');
  prefs.pruneMap('shop_options', ['p249', 'p248']);
  assert.deepEqual(Object.keys(prefs.getMap('shop_options')).sort(), ['p248', 'p249']);

  // Invalid uids are never used as storage keys.
  const odd = openPage(storage, 'account:../bob');
  odd.setString('shop_category', 'x');
  assert.ok(![...storage.data.keys()].some(key => key.includes('..')));
  // Guest maps are not pruned.
  const guestStorage = memoryStorage({ jgv3d_shop_selected_options: JSON.stringify({ gone: { color: 'x' } }) });
  openPage(guestStorage, 'guest').pruneMap('shop_options', []);
  assert.equal(guestStorage.data.get('jgv3d_shop_selected_options'), JSON.stringify({ gone: { color: 'x' } }));
});

test('shop and gallery keep every remembered choice in the scoped prefs, never raw localStorage', () => {
  for (const page of ['shop.html', 'gallery.html']) {
    const html = read(page);
    assert.match(html, /<script src="ui-prefs\.js"><\/script>\s*<script>/, page);
    assert.match(html, /window\.JGV3DPrefs\.createScopedPrefs\(/, page);
    assert.match(html, /prefs\.setScope\(state\.scopeKey\)/, page);
    assert.doesNotMatch(html, /localStorage/, page);
  }
  const shop = read('shop.html');
  assert.doesNotMatch(shop, /scopedPrefs/, 'signed-in choices are no longer memory-only');
  for (const key of ['jgv3d_shop_selected_options', 'jgv3d_custom_note_drafts', 'jgv3d_last_category', 'jgv3d_last_subcategory']) {
    assert.ok(shop.includes(`'${key}'`), `guest key ${key} is unchanged`);
  }
  const gallery = read('gallery.html');
  assert.match(gallery, /import\('\.\/cart-service\.js'\)/);
  for (const key of ['jgv3d_gallery_image_selection', 'jgv3d_gallery_category', 'jgv3d_gallery_subcategory']) {
    assert.ok(gallery.includes(`'${key}'`), `guest key ${key} is unchanged`);
  }
});

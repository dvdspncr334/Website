const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'auth-navigation.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function link(attributes = {}) {
  return {
    textContent: 'Login',
    attributes: { href: 'login.html', ...attributes },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

async function fixture({ links = [link()], listeners = new Set(), failImport = false, failSubscribe = false } = {}) {
  let imports = 0;
  let subscriptions = 0;
  const context = vm.createContext({
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '.header-buttons a[href="login.html"]');
        return links;
      }
    },
    localStorage: {
      getItem() { throw new Error('Navigation must not read storage'); }
    }
  });
  const auth = new vm.SyntheticModule(['onUserChanged'], function () {
    this.setExport('onUserChanged', callback => {
      subscriptions += 1;
      if (failSubscribe) throw new Error('Auth unavailable');
      listeners.add(callback);
      return () => listeners.delete(callback);
    });
  }, { context });
  await auth.link(() => {});
  await auth.evaluate();
  const mod = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: specifier => {
      imports += 1;
      assert.equal(specifier, './auth-firebase.js');
      if (failImport) throw new Error('SDK unavailable');
      return auth;
    }
  });
  await mod.link(() => { throw new Error('Unexpected static dependency'); });
  await mod.evaluate();
  await settle();
  return {
    links, mod,
    imports: () => imports,
    subscriptions: () => subscriptions,
    emit(user) { for (const callback of listeners) callback(user); }
  };
}

test('signed-out, signed-in, account switch and signout update all auth labels only', async () => {
  const f = await fixture({ links: [link({ 'aria-label': 'Login', title: 'Login' }), link()] });
  for (const [user, label] of [[null, 'Login'], [{ id: 'a' }, 'Account'], [{ id: 'b' }, 'Account'], [null, 'Login']]) {
    f.emit(user);
    for (const anchor of f.links) {
      assert.equal(anchor.textContent, label);
      assert.equal(anchor.attributes.href, 'login.html');
    }
    assert.equal(f.links[0].attributes['aria-label'], label);
    assert.equal(f.links[0].attributes.title, label);
    assert.deepEqual(f.links[1].attributes, { href: 'login.html' });
  }
});

test('reload waits for Firebase restoration, then displays Account without a sign-in action', async () => {
  const f = await fixture();
  assert.equal(f.links[0].textContent, 'Login');
  await settle();
  f.emit({ id: 'restored-user' });
  assert.equal(f.links[0].textContent, 'Account');
});

test('Firebase auth events update separate tabs including signout', async () => {
  const listeners = new Set();
  const first = await fixture({ listeners });
  const second = await fixture({ listeners });
  first.emit({ id: 'a' });
  assert.equal(first.links[0].textContent, 'Account');
  assert.equal(second.links[0].textContent, 'Account');
  second.emit(null);
  assert.equal(first.links[0].textContent, 'Login');
  assert.equal(second.links[0].textContent, 'Login');
});

test('module evaluation subscribes once even with multiple links', async () => {
  const f = await fixture({ links: [link(), link()] });
  await f.mod.evaluate();
  await settle();
  assert.equal(f.imports(), 1);
  assert.equal(f.subscriptions(), 1);
});

test('SDK load or subscription setup failure preserves usable Login links', async () => {
  for (const failure of [{ failImport: true }, { failSubscribe: true }]) {
    const f = await fixture(failure);
    assert.equal(f.links[0].textContent, 'Login');
    assert.equal(f.links[0].attributes.href, 'login.html');
  }
});

test('no auth link means no SDK import or auth subscription', async () => {
  const f = await fixture({ links: [] });
  assert.equal(f.imports(), 0);
  assert.equal(f.subscriptions(), 0);
});

test('all existing Login headers load navigation once using document-relative paths', () => {
  const pages = readdirSync(root).filter(name => name.endsWith('.html'));
  const wired = [];
  for (const page of pages) {
    const html = readFileSync(path.join(root, page), 'utf8');
    const header = html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)[0];
    const scripts = html.match(/<script type="module" src="auth-navigation\.js"><\/script>/g) || [];
    if (header.includes('href="login.html"')) {
      assert.match(header, /<a href="login\.html">Login<\/a>/, page);
      assert.equal(scripts.length, 1, page);
      wired.push(page);
    } else {
      assert.equal(scripts.length, 0, page);
    }
  }
  assert.deepEqual(wired.sort(), [
    'about.html', 'cart.html', 'faq.html', 'gallery.html', 'index.html',
    'order-details.html', 'orders.html', 'shop.html', 'usefullinks.html'
  ]);
  const login = readFileSync(path.join(root, 'login.html'), 'utf8');
  assert.doesNotMatch(login, /href="login\.html"/);
});

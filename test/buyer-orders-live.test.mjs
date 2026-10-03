import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function page(filename) {
  const html = await readFile(new URL(`../${filename}`, import.meta.url), 'utf8');
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = () => ({
    innerHTML: '', textContent: '', hidden: false, children: [], listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; },
    appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; }
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element
  };
  const subscriptions = [];
  let authChanged;
  const subscribe = (uid, next, error) => {
    const entry = { uid, next, error, closed: false };
    subscriptions.push(entry);
    return () => { entry.closed = true; };
  };
  const api = {
    onSessionChanged(callback) { authChanged = callback; },
    subscribeOrders: subscribe,
    subscribeOrder(uid, id, next, error) {
      assert.equal(id, 'JGV-00000001');
      return subscribe(uid, next, error);
    }
  };
  const context = vm.createContext({ document, window: { location: { search: '?id=JGV-00000001' } }, URLSearchParams });
  const dependency = new vm.SyntheticModule(
    ['loadAccountData', 'ORDER_STATUSES', 'summarizeShipping', 'formatShippingLines', 'friendlyAccountError'],
    function () {
      this.setExport('loadAccountData', async () => api);
      this.setExport('ORDER_STATUSES', ['In Queue', 'In Progress', 'Shipped', 'Completed', 'Cancelled']);
      this.setExport('summarizeShipping', () => '');
      this.setExport('formatShippingLines', () => []);
      this.setExport('friendlyAccountError', () => 'Please retry.');
    }, { context }
  );
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => dependency);
  await module.evaluate();
  await new Promise(resolve => setImmediate(resolve));
  return { elements, subscriptions, changeUser: user => authChanged(user) };
}

const order = {
  id: 'JGV-00000001', docId: 'JGV-00000001', date: '2026-01-01', status: 'Cancelled',
  items: [], total: 12, shipping: {}, cancellationReason: '<private reason>'
};

test('buyer list observes cancellation and deletion and rejects callbacks from the previous account', async () => {
  const { elements, subscriptions, changeUser } = await page('orders.html');
  changeUser({ id: 'buyer-a' });
  const first = subscriptions[0];
  first.next([order]);
  const list = elements.get('orders-list');
  const card = list.children.at(-1).innerHTML;
  assert.match(card, /Cancelled/);
  assert.match(card, /&lt;private reason&gt;/);
  assert.match(card, /\$12\.00/);
  first.next([]);
  assert.match(list.innerHTML, /No orders yet/);
  changeUser(null);
  assert.equal(first.closed, true);
  first.next([order]);
  assert.match(list.innerHTML, /Sign in to see your orders/);
  changeUser({ id: 'buyer-b' });
  assert.equal(subscriptions[1].uid, 'buyer-b');
  first.error(new Error('late failure'));
  assert.match(elements.get('orders-status-text').textContent, /Loading/);
});

test('buyer details observe cancellation without completed progress, deletion and account isolation', async () => {
  const { elements, subscriptions, changeUser } = await page('order-details.html');
  changeUser({ id: 'buyer-a' });
  const first = subscriptions[0];
  first.next(order);
  const root = elements.get('order-details-root');
  assert.match(root.innerHTML, /Order Cancelled/);
  assert.match(root.innerHTML, /&lt;private reason&gt;/);
  assert.match(root.innerHTML, /does not process a refund/);
  assert.doesNotMatch(root.innerHTML, /Completed stage|Upcoming stage/);
  first.next(null);
  assert.match(root.innerHTML, /Order not found/);
  changeUser(null);
  assert.equal(first.closed, true);
  first.next(order);
  assert.match(root.innerHTML, /Sign in to see this order/);
  changeUser({ id: 'buyer-b' });
  subscriptions[1].error(new Error('offline'));
  assert.match(root.innerHTML, /Please retry/);
  elements.get('order-retry-btn').listeners.click();
  assert.equal(subscriptions[2].uid, 'buyer-b');
});

test('anonymous guest-checkout sessions see only their own guest orders with a data-loss warning', async () => {
  const { elements, subscriptions, changeUser } = await page('orders.html');
  changeUser({ id: 'anon-guest', isAnonymous: true });
  assert.equal(subscriptions[0].uid, 'anon-guest');
  assert.equal(elements.get('orders-guest-note').hidden, false);
  subscriptions[0].next([{ ...order, status: 'In Queue', guest: true, email: 'buyer@example.com' }]);
  const card = elements.get('orders-list').children.at(-1).innerHTML;
  assert.match(card, /Guest order<\/strong> — contact email: buyer@example\.com/);
  changeUser({ id: 'account-a', isAnonymous: false });
  assert.equal(subscriptions[0].closed, true);
  assert.equal(elements.get('orders-guest-note').hidden, true);
  changeUser(null);
  assert.equal(elements.get('orders-guest-note').hidden, true);
});

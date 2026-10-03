import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAdminOrderUI, captureOrders, filterAdminOrders, remainingOrderCapture, privateOrderExport,
  orderItemImagePath, formatOrderMoney, splitItemTitle, shipToSummary, ADMIN_ORDER_STATUSES } from '../admin-order-ui.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.handlers = new Map();
    this.value = '';
    this.checked = this.disabled = this.hidden = this.open = false;
    this.attributes = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = undefined; }
  addEventListener(name, handler) {
    const list = this.handlers.get(name) || [];
    this.handlers.set(name, [...list, handler]);
  }
  async emit(name) {
    const event = { preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.handlers.get(name) || []).map(handler => handler(event)));
    return event;
  }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function order(uid = 'buyer-a', id = 'same', extra = {}) {
  return { id, uid, path: `users/${uid}/orders/${id}`, status: 'In Queue', email: `${uid}@example.test`,
    date: '2026-10-01T12:00:00Z', items: [{ id: 'item', title: 'Widget', qty: 2, price: 10 }],
    total: 20, shipping: { firstName: 'Private', city: 'City', phone: '123', deliveryNotes: 'Side door' },
    notes: 'Customer note', ...extra };
}

function fixture({ list, update, remove, download, copyText, baseURI } = {}) {
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"/g)].map(match => [match[2], new Element(match[1])]));
  const get = id => elements.get(id);
  const writes = [], deletes = [], downloads = [];
  let records = [order(), order('buyer-b')];
  const service = {
    listOrders: list || (async () => records),
    setOrderStatus: async (...args) => {
      writes.push(args);
      if (update) return update(...args);
      records = records.map(order => order.path === args[0] ? { ...order, status: args[1], cancellationReason: args[2].reason } : order);
      return records.find(order => order.path === args[0]);
    },
    deleteOrders: async (...args) => {
      deletes.push(args);
      const result = remove ? await remove(...args) : { deletedPaths: args[0] };
      records = records.filter(order => !result.deletedPaths.includes(order.path));
      return result;
    }
  };
  const document = { getElementById: get, createElement: tag => {
    const element = new Element(tag);
    element.ownerDocument = document;
    return element;
  }, activeElement: new Element('button'), baseURI };
  for (const element of elements.values()) element.ownerDocument = document;
  document.activeElement.ownerDocument = document;
  const ui = createAdminOrderUI({ document, service, ...(copyText ? { copyText } : {}),
    download: (...args) => { downloads.push(args); if (download) return download(...args); } });
  ui.setAccount('admin');
  get('order-scope').value = 'all';
  return { get, ui, writes, deletes, downloads, document };
}

async function prepareDelete(f) {
  await f.get('order-danger-export').emit('click');
  f.get('order-private-export').checked = true;
  await f.get('order-private-export').emit('change');
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.get('order-delete-phrase-label').hidden, false);
  f.get('order-delete-phrase').value = 'DELETE ORDERS';
  await f.get('order-delete-phrase').emit('input');
}

test('filters retain full path identity for colliding order IDs and captures never include later documents', () => {
  const records = [order(), order('buyer-b', 'same', { status: 'Shipped' })];
  assert.equal(filterAdminOrders(records, { id: 'SAME' }).length, 2);
  assert.equal(filterAdminOrders(records, { email: 'BUYER-A', status: 'In Queue' }).length, 1);
  const captured = captureOrders(records);
  records[0].shipping.city = 'Changed';
  records.push(order('new-buyer'));
  assert.equal(captured.length, 2);
  assert.equal(captured[0].shipping.city, 'City');
  assert.equal(new Set(captured.map(item => item.path)).size, 2);
  const remaining = remainingOrderCapture(captured, [captured[0].path]);
  assert.deepEqual(remaining.map(item => item.path), [captured[1].path]);
  assert.equal(JSON.parse(privateOrderExport(captured)).orders.length, 2);
  assert.throws(() => captureOrders([{ path: 'other/thing' }]), /Invalid/);
});

test('all-account snapshot renders accessible path selection, per-order full details and fresh-service actor', async () => {
  const actors = [];
  const f = fixture({ list: async options => { actors.push(options); return [order(), order('buyer-b')]; } });
  await f.ui.refresh();
  assert.deepEqual(actors, [{ expectedUid: 'admin', scope: 'all' }]);
  const rows = f.get('account-order-rows').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].children[0].attributes['aria-label'], 'Select users/buyer-a/orders/same');
  assert.match(f.get('order-selection-count').textContent, /ALL accounts/);
  f.ui.openDetails('users/buyer-a/orders/same');
  assert.equal(f.get('order-details-dialog').open, true);
  assert.equal(f.get('order-details-close').focused, true);
  assert.match(f.get('order-details-body').textContent, /Side door|Customer note|Widget/);
  assert.match(f.get('order-details-body').textContent, /Unit price.*Subtotal.*\$10\.00.*\$20\.00/);
  assert.match(f.get('order-details-body').textContent, /Order total: \$20\.00/);
});

test('order details organize full synthetic customer data and intact amounts without interpreting markup', async () => {
  const record = order('synthetic', 'long-order-id-'.repeat(12), {
    email: `${'long-email-'.repeat(10)}@example.test`,
    notes: '<script>not executable</script>' + 'Long notes. '.repeat(60).trim(),
    status: 'Shipped',
    items: [{ id: 'long-item-id', title: '<img onerror=alert(1)> Synthetic guitar', img: 'images/Telecaster/Blank/white.PNG', qty: 3, price: 1234.56 }],
    total: 3703.68
  });
  const f = fixture({ list: async () => [record] });
  await f.ui.refresh();
  f.ui.openDetails(record.path);
  const body = f.get('order-details-body');
  const descendants = element => [element, ...element.children.flatMap(descendants)];
  const elements = descendants(body);
  const info = elements.find(element => element.className === 'admin-order-info');
  assert.equal(info.children.length, 2);
  assert.match(info.children[0].textContent, /Customer.*long-email/);
  assert.match(info.children[1].textContent, /Shipping address[\s\S]*Side door/);
  assert.ok(f.get('order-details-title').textContent.includes(record.id));
  assert.equal(f.get('order-detail-path').textContent, record.path);
  assert.ok(body.textContent.includes(record.notes));
  assert.equal(elements.filter(element => element.tagName === 'script').length, 0);
  assert.deepEqual(elements.filter(element => element.className === 'admin-money').map(element => element.textContent),
    ['$3,703.68', '$1,234.56', '$3,703.68', '$3,703.68']);
  const image = elements.find(element => element.tagName === 'img');
  assert.equal(image.src, record.items[0].img);
  assert.equal(image.alt, '');
  await image.emit('error');
  assert.equal(image.src, 'images/placeholder.png');
  assert.ok(elements.some(element => element.className === 'order-status status-shipped'));
  const row = f.get('account-order-rows').children[0];
  assert.equal(row.children[5].className, 'admin-order-total-cell');
  assert.deepEqual(row.children[5].children.map(element => element.textContent), ['$3,703.68', '3 items']);
  assert.equal(row.children[6].className, 'admin-actions');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.deletes, []);
});

test('detail thumbnails never load remote or unsafe buyer-provided image paths and missing shipping remains legible', async () => {
  for (const img of ['', 'javascript:alert(1)', 'https://example.test/tracker.png', '//example.test/a.png',
    'images/../private.png', 'images/test.png" onerror="alert(1)']) {
    const record = order('synthetic', 'empty-shipping', { shipping: {}, items: [{ id: 'test', title: 'Synthetic', qty: 1, price: 0, img }] });
    const f = fixture({ list: async () => [record] });
    await f.ui.refresh();
    f.ui.openDetails(record.path);
    const descendants = element => [element, ...element.children.flatMap(descendants)];
    const images = descendants(f.get('order-details-body')).filter(element => element.tagName === 'img');
    assert.equal(images.length, 1);
    assert.equal(images[0].src, 'images/placeholder.png');
    assert.match(f.get('order-details-body').textContent, /no shipping address saved/);
    assert.match(f.get('order-details-body').textContent, /Delivery notes: \(none\)/);
  }
});

test('account scope defaults to own, all accounts requires explicit selection and switching resets captures', async () => {
  const scopes = [];
  const f = fixture({ list: async options => { scopes.push(options.scope); return options.scope === 'own' ? [] : [order()]; } });
  f.ui.setAccount('other-admin');
  assert.equal(f.get('order-scope').value, 'own');
  await f.ui.refresh();
  assert.deepEqual(scopes, ['own']);
  f.get('order-scope').value = 'all';
  await f.get('order-scope').emit('change');
  assert.deepEqual(scopes, ['own', 'all']);
  f.ui.openDelete(f.ui.state().orders, 'Filtered');
  assert.match(f.get('order-danger-description').textContent, /Account scope: ALL accounts/);
  f.get('order-scope').value = 'own';
  await f.get('order-scope').emit('change');
  assert.equal(f.get('order-danger-dialog').open, false);
  assert.equal(f.ui.state().danger, null);
  assert.equal(f.ui.state().orders.length, 0);
});

test('cancelled cancellation and deletion confirmations produce no writes, and reason is bounded', async () => {
  const f = fixture();
  await f.ui.refresh();
  f.ui.openDetails(order().path);
  f.get('order-next-status').value = 'Cancelled';
  f.get('order-cancel-reason').value = 'x'.repeat(501);
  await f.get('order-save-status').emit('click');
  assert.match(f.get('order-details-status').textContent, /500/);
  assert.equal(f.get('order-danger-dialog').open, false);
  f.get('order-cancel-reason').value = 'Buyer request';
  await f.get('order-save-status').emit('click');
  assert.match(f.get('order-danger-description').textContent, /no refunds/i);
  await f.get('order-danger-cancel').emit('click');
  f.ui.openDelete(f.ui.state().orders, 'All filtered');
  await prepareDelete(f);
  await f.get('order-danger-cancel').emit('click');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.deletes, []);
  assert.equal(f.ui.state().danger, null);
});

test('confirmed cancellation saves only full path and optional bounded reason; session log excludes PII', async () => {
  const f = fixture();
  await f.ui.refresh();
  f.ui.openDetails(order('buyer-b').path);
  f.get('order-next-status').value = 'Cancelled';
  f.get('order-cancel-reason').value = 'Private reason';
  await f.get('order-save-status').emit('click');
  await f.get('order-danger-confirm').emit('click');
  assert.deepEqual(f.writes, [[order('buyer-b').path, 'Cancelled', { reason: 'Private reason', expectedStatus: 'In Queue', expectedUid: 'admin' }]]);
  assert.equal(f.ui.state().orders[1].status, 'Cancelled');
  assert.doesNotMatch(f.get('order-session-log').textContent, /Private reason|buyer-b|example/);
  assert.match(f.get('order-session-log').textContent, /1 \(Cancelled\)/);
});

test('delete requires private export, double confirmation and exact typed phrase for frozen full-path capture', async () => {
  const records = [order(), order('buyer-b')];
  const f = fixture({ list: async () => records });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'All filtered');
  records.push(order('new-buyer'));
  assert.match(f.get('order-danger-description').textContent, /EXACT captured documents: 2/);
  assert.match(f.get('order-danger-paths').textContent, /users\/buyer-a\/orders\/same/);
  assert.equal(f.get('order-danger-confirm').disabled, true);
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.deletes.length, 0);
  await prepareDelete(f);
  f.get('order-delete-phrase').value = 'delete orders';
  await f.get('order-delete-phrase').emit('input');
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.deletes.length, 0);
  f.get('order-delete-phrase').value = 'DELETE ORDERS';
  await f.get('order-delete-phrase').emit('input');
  await f.get('order-danger-confirm').emit('click');
  assert.deepEqual(f.deletes, [[[order().path, order('buyer-b').path], { expectedUid: 'admin' }]]);
  assert.equal(JSON.parse(f.downloads[0][0]).orders.length, 2);
  assert.match(f.get('account-orders-status').textContent, /2 of 2.*0 remaining/);
});

test('partial receipts report honest counts and retry only remaining captured documents after two confirmations', async () => {
  let call = 0;
  const f = fixture({ remove: async paths => ({ deletedPaths: call++ === 0 ? [paths[0]] : paths }) });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'Selected');
  await prepareDelete(f);
  await f.get('order-danger-confirm').emit('click');
  assert.match(f.get('order-danger-status').textContent, /1 of 2.*1 remaining/);
  assert.deepEqual(f.ui.state().danger.remaining.map(item => item.path), [order('buyer-b').path]);
  assert.equal(f.get('order-delete-phrase-label').hidden, true);
  await prepareDelete(f);
  await f.get('order-danger-confirm').emit('click');
  assert.deepEqual(f.deletes[1][0], [order('buyer-b').path]);
  assert.match(f.get('account-orders-status').textContent, /2 of 2.*0 remaining/);
});

test('explicit skip-backup choice allows deletion without download but still requires both confirmations and typed phrase', async () => {
  const f = fixture();
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'Filtered');
  assert.equal(f.get('order-danger-confirm').disabled, true);
  f.get('order-skip-backup').checked = true;
  await f.get('order-skip-backup').emit('change');
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.deletes.length, 0);
  assert.equal(f.get('order-delete-phrase-label').hidden, false);
  f.get('order-delete-phrase').value = 'DELETE ORDERS';
  await f.get('order-delete-phrase').emit('input');
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.deletes.length, 1);
  assert.deepEqual(f.downloads, []);
});

test('fully acknowledged deletion refetches latest arrivals without widening captured deletion; partial deletion keeps capture dialog', async () => {
  let records = [order(), order('buyer-b')];
  let reads = 0;
  const f = fixture({ list: async () => { reads++; return records; }, remove: async paths => {
    records = [order('new-buyer')];
    return { deletedPaths: paths };
  } });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'All captured');
  await prepareDelete(f);
  await f.get('order-danger-confirm').emit('click');
  assert.equal(reads, 2);
  assert.deepEqual(f.deletes[0][0], [order().path, order('buyer-b').path]);
  assert.deepEqual(f.ui.state().orders.map(order => order.path), [order('new-buyer').path]);
  assert.match(f.get('account-orders-status').textContent, /2 of 2.*0 remaining.*snapshot refreshed/);
  let partialReads = 0;
  const partial = fixture({ list: async () => { partialReads++; return [order(), order('buyer-b')]; },
    remove: async paths => ({ deletedPaths: [paths[0]] }) });
  await partial.ui.refresh();
  partial.ui.openDelete(partial.ui.state().orders, 'Captured');
  await prepareDelete(partial);
  await partial.get('order-danger-confirm').emit('click');
  assert.equal(partialReads, 1, 'partial deletion does not refetch or replace remaining capture');
  assert.equal(partial.get('order-danger-dialog').open, true);
  assert.deepEqual(partial.ui.state().danger.remaining.map(order => order.path), [order('buyer-b').path]);
});

test('acknowledged deletion with failed refetch reports successful counts separately from snapshot errors', async () => {
  let reads = 0;
  const f = fixture({ list: async () => {
    if (reads++ > 0) throw new Error('offline');
    return [order()];
  } });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'Individual');
  await prepareDelete(f);
  await f.get('order-danger-confirm').emit('click');
  assert.match(f.get('account-orders-status').textContent, /1 of 1.*0 remaining.*Deletion is acknowledged.*snapshot refresh failed/);
  assert.equal(f.get('order-danger-dialog').open, false);
  assert.equal(f.get('order-delete-filtered').disabled, true);
  assert.equal(f.get('order-export-filtered').disabled, true);
  assert.equal(f.get('orders-refresh').disabled, false);
});

test('status success refetches acknowledged snapshot and refresh failure never misreports a successful write', async () => {
  let reads = 0;
  const f = fixture({ list: async () => {
    reads++;
    if (reads > 1) throw new Error('offline');
    return [order()];
  } });
  await f.ui.refresh();
  f.ui.openDetails(order().path);
  f.get('order-next-status').value = 'Shipped';
  await f.get('order-save-status').emit('click');
  assert.equal(reads, 2);
  assert.equal(f.ui.state().orders[0].status, 'Shipped', 'acknowledged transaction data is retained when refetch fails');
  assert.match(f.get('order-details-status').textContent, /Saved Shipped.*Refresh failed/);
  assert.equal(f.get('order-save-status').disabled, true);
  assert.equal(f.get('order-export-filtered').disabled, true, 'unknown refreshed document metadata cannot be exported as a complete backup');
  assert.equal(f.get('order-delete-filtered').disabled, true, 'destructive actions require a successfully refreshed snapshot');
  const stale = fixture({ update: async () => { throw Object.assign(new Error('changed'), { code: 'stale-order' }); } });
  await stale.ui.refresh();
  stale.ui.openDetails(order().path);
  stale.get('order-next-status').value = 'Shipped';
  await stale.get('order-save-status').emit('click');
  assert.match(stale.get('order-details-status').textContent, /Close details and Refresh/);
});

test('an order removed during successful post-update refetch clears obsolete details and disables updates', async () => {
  let reads = 0;
  const f = fixture({ list: async () => reads++ === 0 ? [order()] : [] });
  await f.ui.refresh();
  f.ui.openDetails(order().path);
  f.get('order-next-status').value = 'Shipped';
  await f.get('order-save-status').emit('click');
  assert.match(f.get('order-details-body').textContent, /Order not found.*may have been deleted/);
  assert.doesNotMatch(f.get('order-details-body').textContent, /Private|Widget|buyer-a/);
  assert.equal(f.get('order-save-status').disabled, true);
  assert.equal(f.get('order-next-status').disabled, true);
  assert.equal(f.ui.state().orders.length, 0);
  await f.get('order-save-status').emit('click');
  assert.equal(f.writes.length, 1);
});

test('visible select-all uses paths and selected deletion retains hidden selections without widening to filtered results', async () => {
  const f = fixture();
  await f.ui.refresh();
  f.get('order-filter-email').value = 'buyer-a';
  await f.get('order-filter-email').emit('input');
  f.get('order-select-all').checked = true;
  await f.get('order-select-all').emit('change');
  assert.deepEqual(f.ui.state().selected, [order().path]);
  f.get('order-filter-email').value = 'buyer-b';
  await f.get('order-filter-email').emit('input');
  await f.get('order-delete-selected').emit('click');
  assert.deepEqual(f.ui.state().danger.captured.map(item => item.path), [order().path]);
  await f.get('order-danger-cancel').emit('click');
  await f.get('order-delete-filtered').emit('click');
  assert.deepEqual(f.ui.state().danger.captured.map(item => item.path), [order('buyer-b').path]);
});

test('blocked exports and failed writes show retry state without invented deletion counts', async () => {
  const f = fixture({ download: () => { throw new Error('blocked'); } });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'Selected');
  await f.get('order-danger-export').emit('click');
  assert.equal(f.get('order-danger-confirm').disabled, true);
  assert.match(f.get('order-danger-status').textContent, /Download failed/);
  assert.equal(f.deletes.length, 0);
  const failed = fixture({ remove: async () => { throw new Error('offline'); } });
  await failed.ui.refresh();
  failed.ui.openDelete(failed.ui.state().orders, 'All filtered');
  await prepareDelete(failed);
  await failed.get('order-danger-confirm').emit('click');
  assert.match(failed.get('order-danger-status').textContent, /0 of 2 confirmed deleted; 2 unconfirmed/);
  assert.equal(failed.ui.state().orders.length, 2);
  assert.equal(failed.get('orders-refresh').disabled, false);
});

test('account switches clear data, dialog PII, selections and pending callbacks; stale reads cannot reappear', async () => {
  let resolve;
  const f = fixture({ list: () => new Promise(done => { resolve = done; }) });
  const pending = f.ui.refresh();
  assert.equal(f.get('orders-refresh').disabled, true);
  f.ui.setAccount('another-admin');
  resolve([order()]);
  await pending;
  assert.deepEqual(f.ui.state().orders, []);
  assert.equal(f.get('account-order-rows').children.length, 0);
  const loaded = fixture();
  await loaded.ui.refresh();
  loaded.get('order-select-all').checked = true;
  await loaded.get('order-select-all').emit('change');
  loaded.ui.openDetails(order().path);
  loaded.get('order-next-status').value = 'Cancelled';
  await loaded.get('order-save-status').emit('click');
  loaded.ui.setAccount('new-admin');
  assert.equal(loaded.get('order-danger-dialog').open, false);
  assert.equal(loaded.get('order-details-dialog').open, false);
  assert.equal(loaded.get('order-details-body').textContent, '');
  assert.equal(loaded.get('order-danger-paths').textContent, '');
  assert.deepEqual(loaded.ui.state().selected, []);
  await loaded.get('order-danger-confirm').emit('click');
  assert.equal(loaded.writes.length, 0);
});

test('in-flight completion after account switch cannot mutate new account UI or logs', async () => {
  let resolve;
  const f = fixture({ remove: () => new Promise(done => { resolve = done; }) });
  await f.ui.refresh();
  f.ui.openDelete(f.ui.state().orders, 'Selected');
  await prepareDelete(f);
  const pending = f.get('order-danger-confirm').emit('click');
  assert.equal(f.get('order-danger-cancel').disabled, true);
  f.ui.setAccount('another-admin');
  resolve({ deletedPaths: [order().path, order('buyer-b').path] });
  await pending;
  assert.equal(f.get('order-session-log').textContent, '');
  assert.deepEqual(f.ui.state().orders, []);
  assert.equal(f.get('order-danger-cancel').disabled, false);
});

test('load and status errors leave honest retry state', async () => {
  const failed = fixture({ list: async () => { throw new Error('denied'); } });
  await failed.ui.refresh();
  assert.match(failed.get('account-orders-status').textContent, /Refresh to retry/);
  assert.equal(failed.get('orders-refresh').disabled, false);
  assert.equal(failed.get('order-delete-filtered').disabled, true);
  const f = fixture({ update: async () => { throw new Error('denied'); } });
  await f.ui.refresh();
  f.ui.openDetails(order().path);
  f.get('order-next-status').value = 'Shipped';
  await f.get('order-save-status').emit('click');
  assert.match(f.get('order-details-status').textContent, /not confirmed saved/);
  assert.equal(f.get('order-save-status').disabled, false);
  assert.equal(f.ui.state().orders[0].status, 'In Queue');
});

test('actual page dialog markup is accessible and dangerous pending operations trap cancellation with focused safe default', async () => {
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  assert.match(html, /<dialog id="order-details-dialog"[^>]+aria-labelledby="order-details-title"[^>]+aria-describedby="order-details-effects"/);
  assert.match(html, /<dialog id="order-danger-dialog"[^>]+aria-labelledby="order-danger-title"[^>]+aria-describedby="order-danger-description"/);
  assert.match(html, /id="order-danger-paths" class="admin-order-paths"/);
  assert.doesNotMatch(html, /admin-order-preview/);
  let resolve;
  const f = fixture({ remove: () => new Promise(done => { resolve = done; }) });
  await f.ui.refresh();
  const opener = f.document.activeElement;
  f.ui.openDelete(f.ui.state().orders, 'Filtered');
  assert.equal(f.document.activeElement, f.get('order-danger-cancel'), 'safe cancel button receives focus');
  await f.get('order-danger-cancel').emit('click');
  assert.equal(f.document.activeElement, opener, 'cancel restores triggering control focus');
  assert.deepEqual(f.deletes, []);
  f.ui.openDelete(f.ui.state().orders, 'Filtered');
  await prepareDelete(f);
  assert.equal(f.document.activeElement, f.get('order-delete-phrase'), 'final confirmation focuses typed phrase');
  const pending = f.get('order-danger-confirm').emit('click');
  assert.equal(f.ui.state().busy, true);
  assert.equal(f.get('order-danger-confirm').disabled, true);
  assert.equal(f.get('order-danger-cancel').disabled, true);
  const event = await f.get('order-danger-dialog').emit('cancel');
  assert.equal(event.defaultPrevented, true, 'Escape cannot hide an in-flight mutation');
  await f.get('order-danger-cancel').emit('click');
  assert.equal(f.get('order-danger-dialog').open, true);
  resolve({ deletedPaths: [order().path, order('buyer-b').path] });
  await pending;
  assert.equal(f.ui.state().busy, false);
  assert.equal(f.get('order-danger-dialog').open, false);
});

test('nested details and cancellation dialogs restore each opener in sequence on cancel and successful mutation', async () => {
  const f = fixture();
  await f.ui.refresh();
  const rowButton = f.get('account-order-rows').children[0].children[6].children[0];
  rowButton.focus();
  await rowButton.emit('click');
  assert.equal(f.document.activeElement, f.get('order-details-close'));
  f.get('order-next-status').value = 'Cancelled';
  f.get('order-save-status').focus();
  await f.get('order-save-status').emit('click');
  assert.equal(f.document.activeElement, f.get('order-danger-cancel'));
  await f.get('order-danger-cancel').emit('click');
  assert.equal(f.document.activeElement, f.get('order-save-status'), 'danger cancellation restores the details control');
  await f.get('order-details-close').emit('click');
  assert.equal(f.document.activeElement, rowButton, 'closing details still restores its original row opener');
  rowButton.focus();
  await rowButton.emit('click');
  f.get('order-next-status').value = 'Cancelled';
  f.get('order-save-status').focus();
  await f.get('order-save-status').emit('click');
  await f.get('order-danger-confirm').emit('click');
  assert.equal(f.document.activeElement, f.get('order-save-status'), 'successful cancellation restores focus after loading ends');
  await f.get('order-details-close').emit('click');
  const currentRowButton = f.get('account-order-rows').children[0].children[6].children[0];
  assert.equal(f.document.activeElement, currentRowButton, 'post-mutation details closes onto the visible replacement row control');
  assert.notEqual(f.document.activeElement, f.get('order-save-status'));
});

const descendantsOf = element => [element, ...element.children.flatMap(child => typeof child === 'object' ? descendantsOf(child) : [])];

test('order item images keep exact-case site paths and map this site\'s own absolute URLs back to them', () => {
  const page = 'https://www.jgv3d.com/admin.html';
  const withUser = new URL('https://www.jgv3d.com/images/a.png');
  withUser.username = 'synthetic';
  for (const [raw, expected] of [
    ['images/Stratocaster/Blank/HSS/Red.PNG', 'images/Stratocaster/Blank/HSS/Red.PNG'],
    ['./images/Telecaster/Blank/white.PNG', 'images/Telecaster/Blank/white.PNG'],
    // What the shop used to save: the card's resolved img.src.
    ['https://www.jgv3d.com/images/Stratocaster/Blank/HSS/Red.PNG', 'images/Stratocaster/Blank/HSS/Red.PNG'],
    ['https://jgv3d.com/images/Stratocaster/CTS/Blue.png', 'images/Stratocaster/CTS/Blue.png'],
    ['https://dvdspncr334.github.io/Website/images/Telecaster/Blank/white.PNG', 'images/Telecaster/Blank/white.PNG'],
    ['https://www.jgv3d.com/images/Synthetic%20Body/Red.PNG', 'images/Synthetic Body/Red.PNG'],
    ['', ''], [null, ''], ['javascript:alert(1)', ''], ['data:image/png;base64,AAAA', ''],
    ['https://tracker.example.test/images/a.png', ''], ['//www.jgv3d.com/images/a.png', ''],
    ['http://www.jgv3d.com/images/a.png', ''], [withUser.href, ''],
    ['https://dvdspncr334.github.io/images/a.png', ''], ['/images/a.png', ''], ['images/../private.png', ''],
    ['https://www.jgv3d.com/images/%2e%2e/admin.png', ''], ['https://www.jgv3d.com/images/a.svg', ''],
    ['images/a.png" onerror="alert(1)', ''], ['images\\a.png', '']
  ]) assert.equal(orderItemImagePath(raw, page), expected, String(raw));
  assert.equal(orderItemImagePath('http://localhost:8000/images/Stratocaster/CTS/Red.png', 'http://localhost:8000/admin.html'),
    'images/Stratocaster/CTS/Red.png', 'a local preview origin is the page\'s own base');
  assert.equal(orderItemImagePath('http://localhost:8000/images/a.png', 'https://www.jgv3d.com/admin.html'), '');
  assert.equal(orderItemImagePath('https://www.jgv3d.com/Website/images/Stratocaster/CTS/Red.png', 'https://www.jgv3d.com/Website/admin.html'),
    'images/Stratocaster/CTS/Red.png', 'a rejected match on one base still tries the page base');
});

test('detail thumbnails are bounded, fall back once with a visible label and never loop when the placeholder fails', async () => {
  const items = [
    { id: 'abs', title: 'Synthetic Body (Right, Red, HSS)', img: 'https://www.jgv3d.com/images/Stratocaster/Blank/HSS/Red.PNG', qty: 1, price: 199.99 },
    { id: 'gone', title: 'Synthetic missing photo', img: 'images/does-not-exist.png', qty: 2, price: 5 },
    { id: 'none', title: 'Legacy item', img: '', qty: 1, price: 1 }
  ];
  const record = order('synthetic', 'JGV-00000001', { items, total: 211.99 });
  const f = fixture({ list: async () => [record], baseURI: 'https://www.jgv3d.com/admin.html' });
  await f.ui.refresh();
  f.ui.openDetails(record.path);
  const frames = descendantsOf(f.get('order-details-body')).filter(element => /^admin-order-thumb( |$)/.test(element.className || ''));
  assert.equal(frames.length, 3);
  const [valid, broken, missing] = frames.map(frame => ({ frame, image: frame.children[0], label: frame.children[1] }));
  for (const { image } of [valid, broken, missing]) {
    assert.equal(image.width, 88);
    assert.equal(image.height, 88);
    assert.equal(image.alt, '');
  }
  assert.equal(valid.image.src, 'images/Stratocaster/Blank/HSS/Red.PNG');
  assert.equal(valid.label.hidden, true);
  assert.equal(missing.image.src, 'images/placeholder.png');
  assert.equal(missing.label.textContent, 'Image unavailable');
  assert.equal(missing.label.hidden, false);
  assert.equal(broken.image.src, 'images/does-not-exist.png');
  await broken.image.emit('error');
  assert.equal(broken.image.src, 'images/placeholder.png');
  assert.equal(broken.frame.className, 'admin-order-thumb is-unavailable');
  assert.equal(broken.label.hidden, false);
  await broken.image.emit('error');
  assert.equal(broken.image.hidden, true, 'a failed placeholder is hidden, leaving the label');
  assert.equal(broken.image.src, undefined);
  await broken.image.emit('error');
  assert.equal(broken.image.src, undefined, 'no recursive fallback');
  const text = f.get('order-details-body').textContent;
  assert.match(text, /Synthetic Body.*Right, Red, HSS.*ID: abs/);
  assert.match(text, /Total\$211\.99/);
});

test('order rows show every status as one pill, formatted totals with counts and a copyable full document path', async () => {
  const copies = [];
  const records = ADMIN_ORDER_STATUSES.map((status, index) => order(`synthetic-${index}`, `JGV-0000000${index}`, {
    status, date: `2026-10-0${index + 1}T12:00:00Z`, items: [{ id: 'a', title: 'A', qty: index + 1, price: 1234.5 }], total: 1234.5 * (index + 1)
  }));
  const f = fixture({ list: async () => records, copyText: async text => { copies.push(text); } });
  await f.ui.refresh();
  const rows = f.get('account-order-rows').children;
  assert.equal(rows.length, 5);
  const pills = rows.map(row => row.children[4].children);
  assert.deepEqual(pills.map(children => children.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(pills.map(([pill]) => pill.className), ['status-cancelled', 'status-completed', 'status-shipped', 'status-in-progress', 'status-queued'].map(name => `order-status ${name}`));
  assert.deepEqual(rows.map(row => row.children[5].children.map(element => element.textContent)).at(0), ['$6,172.50', '5 items']);
  assert.deepEqual(rows.at(-1).children[5].children[1].textContent, '1 item');
  const identity = rows[0].children[1];
  assert.equal(identity.children[0].className, 'admin-order-id');
  const path = identity.children[1];
  assert.equal(path.tagName, 'details', 'the technical path is collapsed behind a disclosure');
  assert.equal(path.children[0].textContent, 'Document path');
  assert.equal(path.children[1].textContent, records[4].path);
  rows[0].children[0].children[0].checked = true;
  await rows[0].children[0].children[0].emit('change');
  await path.children[2].emit('click');
  assert.deepEqual(copies, [records[4].path]);
  assert.equal(path.children[2].textContent, 'Copied');
  assert.match(f.get('account-orders-status').textContent, /Copied document path/, 'result is announced in the status region');
  assert.deepEqual(f.ui.state().selected, [records[4].path], 'copying never changes path-keyed selection');
  const failing = fixture({ list: async () => records, copyText: async () => { throw new Error('denied'); } });
  await failing.ui.refresh();
  const failingButton = failing.get('account-order-rows').children[0].children[1].children[1].children[2];
  await failingButton.emit('click');
  assert.match(failingButton.textContent, /Copy failed/);
  assert.match(failing.get('account-orders-status').textContent, /Couldn't copy/);
  const noClipboard = fixture({ list: async () => records });
  await noClipboard.ui.refresh();
  const noClipboardButton = noClipboard.get('account-order-rows').children[0].children[1].children[1].children[2];
  await noClipboardButton.emit('click');
  assert.match(noClipboardButton.textContent, /Copy failed/, 'a missing clipboard API is never reported as copied');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.deletes, []);
});

test('money, item titles and ship-to summaries format for compact display', () => {
  assert.equal(formatOrderMoney(1234567.891), '$1,234,567.89');
  assert.equal(formatOrderMoney(0), '$0.00');
  assert.equal(formatOrderMoney(Number.NaN), '$0.00');
  assert.deepEqual(splitItemTitle('Stratocaster Body (Right, Red, HSS)'), { base: 'Stratocaster Body', options: 'Right, Red, HSS' });
  assert.deepEqual(splitItemTitle('Plain item'), { base: 'Plain item', options: '' });
  assert.equal(shipToSummary({ firstName: 'Testy', lastName: 'Example', streetAddress1: '1 Hidden St', city: 'Sample', state: 'ST', postalCode: '00000', country: 'Nowhere' }),
    'Testy Example · Sample, ST · Nowhere');
  assert.equal(shipToSummary({}), '');
});

test('details for an order without saved items show a readable empty state', async () => {
  const record = order('synthetic', 'JGV-00000009', { items: [], total: 0 });
  const f = fixture({ list: async () => [record] });
  await f.ui.refresh();
  f.ui.openDetails(record.path);
  assert.match(f.get('order-details-body').textContent, /No items were saved with this order\./);
  assert.match(f.get('order-details-body').textContent, /Order total: \$0\.00/);
});

test('guest orders show a Guest badge and contact email; status updates keep working for them', async () => {
  const guest = order('anon-guest', 'JGV-00000009', { guest: true, email: 'guest.buyer@example.test' });
  let records = [guest, order('buyer-b')];
  const f = fixture({
    list: async () => records,
    update: async (path, status) => {
      records = records.map(o => o.path === path ? { ...o, status } : o);
      return records.find(o => o.path === path);
    }
  });
  await f.ui.refresh();
  const rows = f.get('account-order-rows').children;
  const customer = row => row.children.find(cell => cell.className === 'admin-order-customer');
  const guestRow = rows.find(row => customer(row).textContent.includes('guest.buyer@example.test'));
  const accountRow = rows.find(row => row !== guestRow);
  assert.equal(customer(guestRow).children[0].className, 'admin-guest-badge');
  assert.equal(customer(guestRow).children[0].textContent, 'Guest');
  assert.doesNotMatch(customer(accountRow).textContent, /Guest/);
  f.ui.openDetails(guest.path);
  assert.match(f.get('order-details-body').textContent, /Guest \(no account\)/);
  assert.match(f.get('order-details-body').textContent, /Guest contact email: guest\.buyer@example\.test/);
  f.get('order-next-status').value = 'Shipped';
  await f.get('order-save-status').emit('click');
  assert.equal(f.writes[0][0], guest.path);
  assert.equal(f.writes[0][1], 'Shipped');
});

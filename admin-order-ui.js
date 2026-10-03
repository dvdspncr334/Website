import { normalizeOrder, normalizeShipping, sortOrdersNewestFirst, formatShippingLines } from './account-data.js';

export const ORDER_EFFECTS_WARNING = 'This changes order records only. No refunds, payments, shipping notifications or stock adjustments are performed.';
export const DELETE_PHRASE = 'DELETE ORDERS';
export const ADMIN_ORDER_STATUSES = ['In Queue', 'In Progress', 'Shipped', 'Completed', 'Cancelled'];

export const ORDER_IMAGE_PLACEHOLDER = 'images/placeholder.png';
const SITE_IMAGE_RE = /^images\/[a-z0-9_./ -]+\.(?:png|jpe?g|webp|gif|avif)$/i;
// Deployed copies of this site. Older orders saved the shop card's resolved
// img.src (an absolute URL on one of these), not the CSV's relative path.
const SITE_BASES = Object.freeze(['https://www.jgv3d.com/', 'https://jgv3d.com/', 'https://dvdspncr334.github.io/Website/']);
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatOrderMoney(value) {
  return USD.format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

function siteImagePath(path) {
  const relative = path.replace(/^\.\//, '');
  return SITE_IMAGE_RE.test(relative) && !relative.split('/').includes('..') && !relative.includes('//') ? relative : '';
}

// Returns a site-relative images/... path (exact case preserved) for a saved
// order item image, or '' when the value is missing, unsafe or third-party.
// Absolute URLs are accepted only on this site's own deployments (or the
// page's own origin/base, e.g. a local preview) and are mapped back to the
// relative asset path so they resolve against the current page's base.
export function orderItemImagePath(raw, pageUrl = '') {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 500) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[/\\]/.test(value)) return siteImagePath(value);
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.username || url.password) return '';
  const bases = [...SITE_BASES];
  try {
    const page = new URL('.', pageUrl);
    if (page.protocol === 'https:' || page.protocol === 'http:') bases.push(page.href);
  } catch { /* no page base available */ }
  for (const base of bases) {
    const site = new URL(base);
    if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) continue;
    let path = '';
    try { path = siteImagePath(decodeURIComponent(url.pathname.slice(site.pathname.length))); } catch { continue; }
    if (path) return path;
  }
  return '';
}

export function splitItemTitle(title) {
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(String(title || ''));
  return match && match[1] ? { base: match[1], options: match[2] } : { base: String(title || 'Item'), options: '' };
}

export function shipToSummary(raw) {
  const s = normalizeShipping(raw);
  const name = [s.firstName, s.lastName].filter(Boolean).join(' ');
  const place = [s.city, s.state].filter(Boolean).join(', ');
  return [name, place, s.country].filter(Boolean).join(' · ');
}

export function filterAdminOrders(orders, { id = '', status = '', email = '' } = {}) {
  const contains = (value, query) => String(value || '').toLowerCase().includes(query.trim().toLowerCase());
  return orders.filter(order => contains(order.id, id) && (!status || order.status === status) && contains(order.email, email));
}

export function captureOrders(orders) {
  const unique = new Map();
  for (const order of orders) {
    if (!/^users\/[^/]+\/orders\/[^/]+$/.test(order.path)) throw new Error('Invalid order document path.');
    unique.set(order.path, JSON.parse(JSON.stringify(order)));
  }
  return Object.freeze([...unique.values()].map(order => Object.freeze(order)));
}

// Deletion receipts, not a refreshed query, determine what a retry may remove.
export function remainingOrderCapture(capture, deletedPaths) {
  const deleted = new Set(deletedPaths);
  return captureOrders(capture.filter(order => !deleted.has(order.path)));
}

export function privateOrderExport(capture) {
  return JSON.stringify({ scope: 'Captured Firestore account order documents only', orders: capture }, null, 2);
}

export function createAdminOrderUI({ document, service, download, formatTime = value => value || '—',
  copyText = text => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable.');
    return clipboard.writeText(text);
  } }) {
  const $ = id => document.getElementById(id);
  let uid = null, epoch = 0, request = 0;
  let orders = [], selected = new Set(), loaded = false, busy = false, failed = false, refreshRequired = false;
  let detailPath = null, danger = null;
  const openers = new Map(), detailButtons = new Map();
  const audit = [];
  const current = token => token === epoch && Boolean(uid);
  const cell = (text, className = '', label = '') => {
    const element = document.createElement('td');
    element.className = className;
    element.textContent = String(text ?? '—');
    if (label) element.setAttribute('data-label', label);
    return element;
  };
  const span = (text, className) => {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = String(text ?? '');
    return element;
  };
  const itemCount = order => order.items.reduce((sum, item) => sum + item.qty, 0);
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const button = (label, action, dangerButton = false) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `admin-btn admin-btn-small ${dangerButton ? 'admin-btn-danger' : 'admin-btn-outline'}`;
    element.textContent = label;
    element.disabled = busy || !loaded;
    element.addEventListener('click', action);
    return element;
  };
  const statusBadge = status => {
    const badge = document.createElement('span');
    const classes = ['status-queued', 'status-in-progress', 'status-shipped', 'status-completed', 'status-cancelled'];
    badge.className = `order-status ${classes[ADMIN_ORDER_STATUSES.indexOf(status)] || 'status-queued'}`;
    badge.textContent = status;
    return badge;
  };
  const guestBadge = () => span('Guest', 'admin-guest-badge');
  function message(text, error = false) {
    $('account-orders-status').textContent = text;
    $('account-orders-status').className = `admin-status ${error ? 'is-error' : ''}`;
  }
  function log(action, count, status = '') {
    audit.push({ action, count, status });
    $('order-session-log').textContent = audit.map(entry => `${entry.action}: ${entry.count}${entry.status ? ` (${entry.status})` : ''}`).join('\n');
  }
  function filters() {
    return { id: $('order-filter-id').value, status: $('order-filter-status').value, email: $('order-filter-email').value };
  }
  function scope() { return $('order-scope').value === 'all' ? 'all' : 'own'; }
  function scopeLabel() { return scope() === 'all' ? 'ALL accounts' : 'your signed-in admin account only'; }
  function visible() { return filterAdminOrders(orders, filters()); }
  function controls() {
    $('orders-refresh').disabled = busy || !uid;
    $('order-scope').disabled = busy || !uid;
    $('order-delete-selected').disabled = busy || !loaded || !selected.size;
    $('order-delete-filtered').disabled = busy || !loaded || !visible().length;
    $('order-export-filtered').disabled = busy || !loaded || !visible().length;
    $('order-select-all').disabled = busy || !loaded || !visible().length;
    for (const id of ['order-filter-id', 'order-filter-status', 'order-filter-email']) $(id).disabled = busy || !uid;
    $('order-selection-count').textContent = `${selected.size} selected by full document path; ${visible().length} matching of ${orders.length} loaded. Scope: ${scopeLabel()}.`;
    $('order-select-all').checked = visible().length > 0 && visible().every(order => selected.has(order.path));
    $('order-next-status').disabled = busy || !uid || !detailPath;
    $('order-cancel-reason').disabled = busy || !uid || !detailPath;
    $('order-details-close').disabled = busy;
  }
  function pathControl(path) {
    const details = document.createElement('details');
    details.className = 'admin-order-path-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Document path';
    const code = document.createElement('code');
    code.className = 'admin-order-path';
    code.textContent = path;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'admin-btn admin-btn-small admin-btn-outline admin-copy-path';
    copy.textContent = 'Copy path';
    copy.addEventListener('click', async () => {
      copy.textContent = 'Copy path';
      try {
        await copyText(path);
        copy.textContent = 'Copied';
        message(`Copied document path ${path}.`);
      } catch {
        copy.textContent = 'Copy failed: select the path text';
        message('Couldn\'t copy the document path. Select the path text and copy it manually.', true);
      }
    });
    details.append(summary, code, copy);
    return details;
  }
  function render() {
    $('account-order-rows').textContent = '';
    detailButtons.clear();
    for (const order of visible()) {
      const row = document.createElement('tr');
      const checkCell = cell('', 'admin-order-select', 'Select');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(order.path);
      check.disabled = busy || !loaded;
      check.setAttribute('aria-label', `Select ${order.path}`);
      check.addEventListener('change', () => {
        if (check.checked) selected.add(order.path); else selected.delete(order.path);
        controls();
      });
      checkCell.append(check);
      const identity = cell('', 'admin-order-identity', 'Order');
      identity.append(span(order.id, 'admin-order-id'), pathControl(order.path));
      const customer = cell('', 'admin-order-customer', 'Customer');
      const shipTo = shipToSummary(order.shipping);
      if (order.guest) customer.append(guestBadge());
      customer.append(span(order.email || `UID ${order.uid}`, 'admin-order-email'),
        span(shipTo ? `Ship to: ${shipTo}` : 'Ship to: (no address saved)', 'admin-order-ship'));
      const status = cell('', 'admin-order-status-cell', 'Status');
      status.append(statusBadge(order.status));
      const total = cell('', 'admin-order-total-cell', 'Total');
      total.append(span(formatOrderMoney(order.total), 'admin-money'), span(plural(itemCount(order), 'item'), 'admin-order-count'));
      const actions = cell('', 'admin-actions', 'Actions');
      const detailsButton = button('Details / status', () => openDetails(order.path));
      detailButtons.set(order.path, detailsButton);
      actions.append(detailsButton, button('Delete', () => openDelete([order], 'Individual document'), true));
      row.append(checkCell, identity, cell(formatTime(order.date), 'admin-order-date', 'Placed'), customer, status, total, actions);
      $('account-order-rows').append(row);
    }
    controls();
  }
  function close(dialog) {
    if (dialog.open) dialog.close();
  }
  function clearDialogs() {
    detailPath = null;
    danger = null;
    close($('order-details-dialog'));
    close($('order-danger-dialog'));
    $('order-details-body').textContent = '';
    $('order-details-title').textContent = 'Order details';
    $('order-detail-path').textContent = '';
    $('order-cancel-reason').value = '';
    $('order-next-status').value = 'In Queue';
    $('order-details-status').textContent = '';
    $('order-danger-paths').textContent = '';
    $('order-danger-title').textContent = 'Confirm order action';
    $('order-danger-description').textContent = '';
    $('order-danger-status').textContent = '';
    $('order-delete-phrase').value = '';
    $('order-private-export').checked = false;
    $('order-skip-backup').checked = false;
    $('order-danger-cancel').disabled = false;
    $('order-danger-export').disabled = false;
    $('order-save-status').disabled = false;
    $('order-danger-confirm').disabled = true;
    openers.clear();
  }
  function setAccount(nextUid) {
    if (uid === nextUid) return;
    ++epoch;
    ++request;
    uid = nextUid;
    orders = [];
    selected.clear();
    loaded = busy = failed = refreshRequired = false;
    audit.length = 0;
    $('order-session-log').textContent = '';
    for (const id of ['order-filter-id', 'order-filter-status', 'order-filter-email']) $(id).value = '';
    $('order-scope').value = 'own';
    clearDialogs();
    render();
    message(uid ? 'Default scope: your own signed-in account. Select ALL accounts explicitly or refresh to load your orders.' : 'Sign in with current admin access to load account orders.');
  }
  async function refresh() {
    if (!uid || busy) return;
    const token = epoch, load = ++request;
    const actor = uid;
    busy = true;
    loaded = false;
    failed = false;
    orders = [];
    selected.clear();
    clearDialogs();
    render();
    message(`Loading orders for ${scopeLabel()}; checking current admin access…`);
    try {
      const result = await service.listOrders({ expectedUid: actor, scope: scope() });
      if (!current(token) || load !== request) return;
      orders = sortOrdersNewestFirst(result.map(order => ({ ...order, ...normalizeOrder(order, order.id) })));
      loaded = true;
      refreshRequired = false;
      message(`${orders.length} account order(s). Scope: ${scopeLabel()}. Prices and totals are buyer-provided; verify before payment.`);
    } catch {
      if (!current(token) || load !== request) return;
      failed = true;
      message("Couldn't load account orders. Check current admin access and connection. Use Refresh to retry.", true);
    } finally {
      if (current(token) && load === request) { busy = false; render(); }
    }
  }
  function show(dialog, focusId) {
    openers.set(dialog, { element: document.activeElement,
      path: dialog === $('order-details-dialog') ? detailPath : null });
    dialog.showModal();
    $(focusId).focus();
  }
  function restoreFocus(dialog) {
    const opener = openers.get(dialog);
    if (!opener) return;
    openers.delete(dialog);
    let target = opener.path ? detailButtons.get(opener.path) : opener.element;
    if (!target || target.disabled || target.hidden || target.isConnected === false) {
      target = $('order-details-dialog').open ? $('order-details-close') : $('orders-refresh');
    }
    target?.focus?.();
  }
  function renderDetails(order) {
    const body = $('order-details-body');
    body.textContent = '';
    const text = value => {
      const paragraph = document.createElement('p');
      paragraph.className = 'admin-order-copy';
      paragraph.textContent = value;
      return paragraph;
    };
    const heading = value => {
      const element = document.createElement('h3');
      element.textContent = value;
      return element;
    };
    const summary = document.createElement('dl');
    summary.className = 'admin-order-summary';
    const fact = (label, ...values) => {
      const group = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      for (const value of values) detail.append(typeof value === 'string' ? span(value, 'admin-order-fact') : value);
      group.append(term, detail);
      summary.append(group);
    };
    fact('Placed', formatTime(order.date));
    fact('Status', statusBadge(order.status));
    if (order.guest) fact('Checkout', guestBadge(), 'Guest (no account)');
    fact('Items', plural(itemCount(order), 'item'));
    fact('Total', span(formatOrderMoney(order.total), 'admin-money'));
    const grid = document.createElement('div');
    grid.className = 'admin-order-info';
    const customer = document.createElement('section');
    customer.append(heading('Customer'), text(order.guest
      ? `Guest contact email: ${order.email || '(not saved)'}`
      : `Customer email: ${order.email || '(not saved)'}`),
      text(`Order notes: ${order.notes || '(none)'}`),
      text(`Cancellation reason: ${order.cancellationReason || '(none recorded)'}`));
    const shipping = document.createElement('section');
    const address = document.createElement('address');
    address.className = 'admin-order-copy';
    address.textContent = formatShippingLines(order.shipping).join('\n') || '(no shipping address saved)';
    shipping.append(heading('Shipping address'), address,
      text(`Delivery notes: ${order.shipping.deliveryNotes || '(none)'}`));
    grid.append(customer, shipping);
    body.append(summary, grid, heading('Order items'));
    const table = document.createElement('table');
    table.className = 'admin-table admin-order-items';
    const head = document.createElement('thead');
    const header = document.createElement('tr');
    for (const label of ['Item', 'Quantity', 'Unit price', 'Subtotal']) {
      const column = document.createElement('th');
      column.setAttribute('scope', 'col');
      column.textContent = label;
      header.append(column);
    }
    head.append(header);
    const rows = document.createElement('tbody');
    if (!order.items.length) {
      const row = document.createElement('tr');
      const empty = cell('No items were saved with this order.', 'admin-order-empty');
      empty.setAttribute('colspan', '4');
      row.append(empty);
      rows.append(row);
    }
    for (const item of order.items) {
      const row = document.createElement('tr');
      const identity = cell('', 'admin-order-item', 'Item');
      const name = splitItemTitle(item.title);
      const copy = document.createElement('div');
      copy.className = 'admin-order-item-text';
      copy.append(span(name.base, 'admin-order-item-title'));
      if (name.options) copy.append(span(name.options, 'admin-order-item-options'));
      if (item.id) copy.append(span(`ID: ${item.id}`, 'admin-order-item-id'));
      const layout = document.createElement('div');
      layout.className = 'admin-order-item-layout';
      layout.append(thumbnail(item), copy);
      identity.append(layout);
      row.append(identity, cell(item.qty, 'admin-order-qty', 'Quantity'),
        cell(formatOrderMoney(item.price), 'admin-money', 'Unit price'),
        cell(formatOrderMoney(item.price * item.qty), 'admin-money', 'Subtotal'));
      rows.append(row);
    }
    table.append(head, rows);
    const total = document.createElement('div');
    total.className = 'admin-order-total';
    const amount = document.createElement('strong');
    amount.className = 'admin-money';
    amount.textContent = formatOrderMoney(order.total);
    total.append(text('Order total: '), amount);
    body.append(table, total);
  }
  // Bounded thumbnail: one fallback to the placeholder with a visible label,
  // and if the placeholder also fails the image is hidden (no retry loop).
  function thumbnail(item) {
    const frame = document.createElement('div');
    frame.className = 'admin-order-thumb';
    const image = document.createElement('img');
    image.alt = '';
    image.width = 88;
    image.height = 88;
    image.loading = 'lazy';
    image.decoding = 'async';
    const label = span('Image unavailable', 'admin-order-thumb-label');
    let fallback = false;
    const unavailable = () => {
      fallback = true;
      frame.className = 'admin-order-thumb is-unavailable';
      label.hidden = false;
      image.src = ORDER_IMAGE_PLACEHOLDER;
    };
    image.addEventListener('error', () => {
      if (!fallback) { unavailable(); return; }
      image.hidden = true;
      image.removeAttribute?.('src');
    });
    const path = orderItemImagePath(item.img, document.baseURI || globalThis.location?.href || '');
    if (path && path !== ORDER_IMAGE_PLACEHOLDER) {
      label.hidden = true;
      image.src = path;
    } else unavailable();
    frame.append(image, label);
    return frame;
  }
  function openDetails(path) {
    if (busy || !loaded) return;
    const order = orders.find(item => item.path === path);
    if (!order) return;
    detailPath = path;
    $('order-details-title').textContent = `Order ${order.id}`;
    $('order-detail-path').textContent = path;
    renderDetails(order);
    $('order-next-status').value = order.status;
    $('order-cancel-reason').value = '';
    $('order-details-status').textContent = '';
    $('order-reason-label').hidden = order.status !== 'Cancelled';
    $('order-save-status').disabled = refreshRequired;
    controls();
    show($('order-details-dialog'), 'order-details-close');
  }
  function openDelete(records, scopeDescription) {
    if (busy || !loaded || !records.length) return;
    const captured = captureOrders(records);
    $('order-private-export').checked = false;
    $('order-skip-backup').checked = false;
    danger = { kind: 'delete', captured, remaining: captured, scope: scopeDescription,
      queryScope: scope(), accountScope: scopeLabel(), stage: 1, deleted: 0, exported: false };
    showDanger();
  }
  function showDanger() {
    const deletion = danger.kind === 'delete';
    $('order-danger-title').textContent = deletion ? 'Danger: permanently delete account orders' : 'Confirm order cancellation';
    $('order-danger-description').textContent = deletion
      ? `${danger.scope}. Account scope: ${danger.accountScope}. EXACT captured documents: ${danger.remaining.length}. This permanently removes customer data and cannot be undone. New arrivals are NOT included. ${ORDER_EFFECTS_WARNING}`
      : `Cancel exactly ${danger.path}. Optional reason: ${danger.reason || '(none)'}. ${ORDER_EFFECTS_WARNING}`;
    $('order-danger-paths').textContent = deletion ? danger.remaining.map(order => order.path).join('\n') : danger.path;
    $('order-delete-controls').hidden = !deletion;
    $('order-delete-phrase-label').hidden = !deletion || danger.stage !== 2;
    $('order-delete-phrase').value = '';
    $('order-danger-status').textContent = '';
    $('order-danger-confirm').textContent = deletion ? (danger.stage === 1 ? 'Review final confirmation' : 'Permanently delete captured documents') : 'Confirm cancellation';
    $('order-danger-export').disabled = !deletion;
    updateDangerButton();
    if (!$('order-danger-dialog').open) show($('order-danger-dialog'), 'order-danger-cancel');
    else $('order-delete-phrase').focus();
  }
  function updateDangerButton() {
    const backupChoice = danger && (danger.exported && $('order-private-export').checked || $('order-skip-backup').checked);
    $('order-danger-confirm').disabled = busy || !danger || (danger.kind === 'delete' &&
      (!backupChoice || (danger.stage === 2 && $('order-delete-phrase').value !== DELETE_PHRASE)));
  }
  function exportCapture(captured) {
    download(privateOrderExport(captured), 'application/json', 'jgv3d-private-account-orders.json');
    log('Private JSON download requested (delivery not verified)', captured.length);
  }
  async function saveStatus() {
    if (busy || refreshRequired || !detailPath || !uid) return;
    const status = $('order-next-status').value;
    const rawReason = $('order-cancel-reason').value;
    const reason = rawReason.trim();
    if (!ADMIN_ORDER_STATUSES.includes(status) || rawReason.length > 500) {
      $('order-details-status').textContent = 'Choose a lifecycle status; cancellation reason must be 500 characters or fewer.';
      return;
    }
    if (status === 'Cancelled') {
      danger = { kind: 'cancel', path: detailPath, reason, status };
      showDanger();
    } else await updateStatus(detailPath, status, '');
  }
  async function updateStatus(path, status, reason) {
    const token = epoch, actor = uid;
    const expectedStatus = orders.find(order => order.path === path)?.status;
    if (!expectedStatus) return;
    busy = true;
    $('order-save-status').disabled = true;
    $('order-danger-cancel').disabled = true;
    $('order-details-status').textContent = 'Checking admin access and saving…';
    render();
    updateDangerButton();
    try {
      const acknowledged = await service.setOrderStatus(path, status, { reason, expectedStatus, expectedUid: actor });
      if (!current(token)) return;
      if (acknowledged) orders = orders.map(order => order.path === path ? { ...acknowledged, ...normalizeOrder(acknowledged, acknowledged.id) } : order);
      log('Order status updated', 1, status);
      close($('order-danger-dialog'));
      danger = null;
      let refreshed = false, orderMissing = false;
      try {
        const records = await service.listOrders({ expectedUid: actor, scope: scope() });
        if (!current(token)) return;
        orders = sortOrdersNewestFirst(records.map(order => ({ ...order, ...normalizeOrder(order, order.id) })));
        refreshed = true;
        selected = new Set([...selected].filter(path => orders.some(order => order.path === path)));
        const latest = orders.find(order => order.path === path);
        if (latest) {
          $('order-next-status').value = latest.status;
          renderDetails(latest);
        } else {
          orderMissing = true;
          detailPath = null;
          $('order-details-body').textContent = 'Order not found in the refreshed snapshot. It may have been deleted. Close details and Refresh before another update.';
        }
      } catch {
        if (!current(token)) return;
      }
      refreshRequired = !refreshed || orderMissing;
      loaded = refreshed;
      $('order-details-status').textContent = `Saved ${status}. ${orderMissing ? 'Order not found after refetch; further updates are disabled.' : refreshed ? 'Refetched the current order snapshot.' : 'Refresh failed; close details and use Refresh before another update.'} ${ORDER_EFFECTS_WARNING}`;
      $('order-save-status').disabled = refreshRequired;
      message(`Updated one order to ${status}.${orderMissing ? ' Order not found in the refreshed snapshot.' : refreshed ? ' Current snapshot refreshed.' : ' Refresh failed; current list may be stale.'}`, !refreshed || orderMissing);
    } catch (error) {
      if (!current(token)) return;
      if (error.code === 'stale-order' || error.code === 'order-not-found') refreshRequired = true;
      const retry = error.code === 'stale-order' || error.code === 'order-not-found'
        ? 'This order changed or no longer exists. Close details and Refresh before trying again.'
        : 'Check current admin access and connection, then retry.';
      $('order-details-status').textContent = `Status was not confirmed saved. ${retry}`;
      $('order-danger-status').textContent = `Cancellation was not confirmed saved. ${retry}`;
    } finally {
      if (current(token)) {
        busy = false;
        $('order-save-status').disabled = refreshRequired;
        $('order-danger-cancel').disabled = false;
        updateDangerButton();
        render();
        if (!$('order-danger-dialog').open) restoreFocus($('order-danger-dialog'));
      }
    }
  }
  async function confirmDanger() {
    if (!danger || busy || $('order-danger-confirm').disabled) return;
    if (danger.kind === 'cancel') { await updateStatus(danger.path, 'Cancelled', danger.reason); return; }
    if (danger.stage === 1) { danger.stage = 2; showDanger(); return; }
    const operation = danger, token = epoch, actor = uid;
    busy = true;
    $('order-danger-cancel').disabled = true;
    $('order-danger-export').disabled = true;
    updateDangerButton();
    render();
    $('order-danger-status').textContent = 'Checking admin access and deleting only captured document paths…';
    try {
      const result = await service.deleteOrders(operation.remaining.map(order => order.path), { expectedUid: actor });
      if (!current(token) || danger !== operation) return;
      const confirmed = new Set(result.deletedPaths || []);
      const removed = operation.remaining.filter(order => confirmed.has(order.path));
      operation.deleted += removed.length;
      operation.remaining = remainingOrderCapture(operation.remaining, removed.map(order => order.path));
      orders = orders.filter(order => !removed.some(item => item.path === order.path));
      removed.forEach(order => selected.delete(order.path));
      log('Order documents confirmed deleted', removed.length);
      const summary = `${operation.deleted} of ${operation.captured.length} captured documents confirmed deleted; ${operation.remaining.length} remaining.`;
      message(summary, operation.remaining.length > 0);
      $('order-danger-status').textContent = summary;
      if (operation.remaining.length) {
        operation.stage = 1;
        $('order-danger-paths').textContent = operation.remaining.map(order => order.path).join('\n');
        $('order-danger-description').textContent = `${summary} Retry targets ONLY the remaining exact paths below, never new orders. ${ORDER_EFFECTS_WARNING}`;
        $('order-delete-phrase').value = '';
        $('order-delete-phrase-label').hidden = true;
        $('order-danger-confirm').textContent = 'Review retry of remaining documents';
      } else {
        close($('order-danger-dialog'));
        danger = null;
        try {
          const records = await service.listOrders({ expectedUid: actor, scope: operation.queryScope });
          if (!current(token)) return;
          orders = sortOrdersNewestFirst(records.map(order => ({ ...order, ...normalizeOrder(order, order.id) })));
          selected = new Set([...selected].filter(path => orders.some(order => order.path === path)));
          loaded = true;
          message(`${summary} Current snapshot refreshed.`);
        } catch {
          if (!current(token)) return;
          loaded = false;
          message(`${summary} Deletion is acknowledged, but snapshot refresh failed. Use Refresh before another export or deletion.`, true);
        }
      }
    } catch {
      if (!current(token) || danger !== operation) return;
      const summary = `${operation.deleted} of ${operation.captured.length} confirmed deleted; ${operation.remaining.length} unconfirmed. Refresh before creating a new deletion if a network result was lost. Retry only these captured paths.`;
      message(summary, true);
      $('order-danger-status').textContent = summary;
      operation.stage = 1;
      $('order-delete-phrase').value = '';
      $('order-delete-phrase-label').hidden = true;
      $('order-danger-confirm').textContent = 'Review retry of remaining documents';
    } finally {
      if (current(token)) {
        busy = false;
        $('order-danger-cancel').disabled = false;
        $('order-danger-export').disabled = false;
        render();
        updateDangerButton();
        if (!$('order-danger-dialog').open) restoreFocus($('order-danger-dialog'));
      }
    }
  }
  $('orders-refresh').addEventListener('click', refresh);
  $('order-scope').addEventListener('change', refresh);
  for (const id of ['order-filter-id', 'order-filter-status', 'order-filter-email']) $(id).addEventListener('input', render);
  $('order-select-all').addEventListener('change', () => {
    for (const order of visible()) {
      if ($('order-select-all').checked) selected.add(order.path); else selected.delete(order.path);
    }
    render();
  });
  $('order-delete-selected').addEventListener('click', () => openDelete(orders.filter(order => selected.has(order.path)), 'Selected document paths (including hidden selections)'));
  $('order-delete-filtered').addEventListener('click', () => openDelete(visible(), `Current filtered result: ${JSON.stringify(filters())}`));
  $('order-export-filtered').addEventListener('click', () => {
    if (!loaded || busy) return;
    try { exportCapture(captureOrders(visible())); message('Private customer-data download requested. Store securely; delivery is not verified.'); }
    catch { message('Download failed. No order documents changed. Retry the export.', true); }
  });
  $('order-details-close').addEventListener('click', () => { if (busy) return; close($('order-details-dialog')); detailPath = null; restoreFocus($('order-details-dialog')); });
  $('order-next-status').addEventListener('change', () => { $('order-reason-label').hidden = $('order-next-status').value !== 'Cancelled'; });
  $('order-save-status').addEventListener('click', saveStatus);
  $('order-danger-export').addEventListener('click', () => {
    if (!danger || danger.kind !== 'delete' || busy) return;
    try {
      exportCapture(danger.captured);
      danger.exported = true;
      $('order-skip-backup').checked = false;
      $('order-danger-status').textContent = 'Private JSON download requested. Verify you saved it securely; the website cannot verify delivery.';
    } catch {
      danger.exported = false;
      $('order-danger-status').textContent = 'Download failed. Retry; no documents deleted.';
    }
    updateDangerButton();
  });
  for (const id of ['order-delete-phrase', 'order-private-export']) $(id).addEventListener('input', updateDangerButton);
  $('order-private-export').addEventListener('change', updateDangerButton);
  $('order-skip-backup').addEventListener('change', updateDangerButton);
  $('order-danger-confirm').addEventListener('click', confirmDanger);
  $('order-danger-cancel').addEventListener('click', () => {
    if (busy) return;
    close($('order-danger-dialog'));
    danger = null;
    restoreFocus($('order-danger-dialog'));
  });
  for (const id of ['order-details-dialog', 'order-danger-dialog']) $(id).addEventListener('cancel', event => {
    if (busy) { event.preventDefault(); return; }
    event.preventDefault();
    close($(id));
    if (id === 'order-danger-dialog') danger = null; else detailPath = null;
    restoreFocus($(id));
  });
  render();
  return { setAccount, refresh, openDetails, openDelete,
    state: () => ({ uid, orders: [...orders], selected: [...selected], loaded, busy, failed, danger }) };
}

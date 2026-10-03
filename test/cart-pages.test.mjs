// Static checks that every page uses the shared cart service and that no
// page reads or writes cart data through a shared localStorage key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = readdirSync(root).filter(name => name.endsWith('.html'));
const read = name => readFileSync(path.join(root, name), 'utf8');

test('no page touches cart storage keys directly', () => {
  for (const page of pages) {
    assert.doesNotMatch(read(page), /jgv3d_cart/, `${page} must use cart-service.js`);
  }
});

test('every header mini-cart badge is driven by mini-cart.js', () => {
  const withBadge = pages.filter(page => read(page).includes('id="mini-cart-count"'));
  assert.ok(withBadge.length >= 9, `expected header badges, found ${withBadge}`);
  for (const page of withBadge) {
    assert.match(read(page), /<script type="module" src="mini-cart\.js"><\/script>/, page);
    assert.doesNotMatch(read(page), /function updateMiniCart/, page);
  }
});

test('shop and cart pages use the shared cart service', () => {
  assert.match(read('shop.html'), /import\('\.\/cart-service\.js'\)/);
  assert.match(read('shop.html'), /cartStore\.addItem\(/);
  const cart = read('cart.html');
  assert.match(cart, /import \{ cart \} from '\.\/cart-service\.js'/);
  assert.match(cart, /cart\.changeQty\(/);
  assert.match(cart, /cart\.setSelection\(/);
});

test('checkout saves the order to the signed-in account before removing cart items', () => {
  const cart = read('cart.html');
  const place = cart.indexOf('await api.placeOrder(session.uid, order);');
  const remove = cart.indexOf('await cart.removeItems(items.map');
  assert.ok(place > 0 && remove > place, 'order must be saved first so a failed save leaves the cart intact');
  assert.match(cart, /from '\.\/account-data\.js'/);
  assert.match(cart, /from '\.\/shipping-form\.js'/);
  assert.doesNotMatch(cart, /localStorage|jgv3d_orders|order-utils\.js/, 'orders and addresses are never stored in the browser');
});

test('guests can continue as guest or sign in; guest checkout uses an anonymous session and the guest cart only', () => {
  const cart = read('cart.html');
  assert.match(cart, /id="checkout-signin-note"[^>]*hidden>No account needed: continue as a guest, or <a href="login\.html">/);
  assert.match(cart, /const canCheckout = Boolean\(mode\) && /);
  assert.match(cart, /checkoutBtn\.textContent = mode === 'guest' \? 'Continue as Guest' : 'Proceed to Checkout'/);
  // Guest checkout: anonymous sign-in, contact email, order saved before the
  // guest cart items are removed; never an account cart or browser storage.
  const guest = cart.slice(cart.indexOf('async function submitGuestCheckout'));
  const signIn = guest.indexOf('authModule.signInAsGuest()');
  const place = guest.indexOf('await api.placeOrder(guestUid, order);');
  const remove = guest.indexOf("await cart.removeItems(items.map");
  assert.ok(signIn > 0 && place > signIn && remove > place);
  assert.match(guest, /if \(!isValidContactEmail\(contactEmail\)\)/);
  assert.match(guest, /buildOrder\(\{ items, shipping, notes, email: contactEmail, guest: true,/);
  assert.match(guest, /if \(cartState\.scopeKey !== 'guest'\) throw/);
  assert.doesNotMatch(guest, /saveShipping/, 'guest addresses are never saved');
  assert.match(guest, /Please save your order number/);
  assert.match(guest, /clearing browser data removes that access/);
  assert.match(cart, /saveAddressLabel\.hidden = guest;/);
  assert.match(cart, /id="checkout-contact-email" name="contactEmail" maxlength="254"/);
});

test('checkout dialog is a native, labelled dialog with save-address opt-in and cancel', () => {
  const cart = read('cart.html');
  assert.match(cart, /<dialog id="checkout-dialog" class="shipping-dialog" aria-labelledby="checkout-title"/);
  assert.match(cart, /<input type="checkbox" id="checkout-save-address">/);
  assert.doesNotMatch(cart, /id="checkout-save-address"[^>]*checked/, 'saving the address is opt-in');
  assert.match(cart, /if \(saveAddressEl\.checked\)/);
  assert.match(cart, /id="checkout-cancel"/);
  // Escape is blocked only while the order is being saved.
  assert.match(cart, /addEventListener\('cancel', event => \{\s*if \(checkout && checkout\.busy\) event\.preventDefault\(\);/);
  // A sign-in change closes checkout and clears the previous buyer's address.
  assert.match(cart, /state\.scopeKey !== checkout\.scopeKey/);
});

test('orders pages read only the signed-in account orders from Firestore', () => {
  for (const page of ['orders.html', 'order-details.html']) {
    const html = read(page);
    assert.match(html, /import \{ loadAccountData[^}]*\} from '\.\/account-data\.js'/, page);
    assert.match(html, /api\.onSessionChanged\(/, page);
    assert.doesNotMatch(html, /localStorage|jgv3d_orders|order-utils\.js/, page);
  }
  assert.match(read('orders.html'), /api\.subscribeOrders\(uid,/);
  assert.match(read('order-details.html'), /api\.subscribeOrder\(uid, orderId,/);
  assert.match(read('order-details.html'), /<h3>Shipping address<\/h3>/);
});

test('account settings tab manages the saved address without browser storage', () => {
  const login = read('login.html');
  assert.match(login, /role="tab" id="tab-settings" aria-controls="panel-settings"/);
  assert.match(login, /No saved address\. Add one during checkout or here\./);
  for (const call of ['api.loadShipping(uid)', 'api.saveShipping(uid, data)', 'api.deleteShipping(uid)']) assert.ok(login.includes(call), call);
  assert.match(login, /resetShippingSettings\(nextUid\)/);
  assert.doesNotMatch(login, /localStorage|sessionStorage/);
});

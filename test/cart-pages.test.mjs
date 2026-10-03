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

test('checkout saves the browser-local demo order before removing cart items', () => {
  const cart = read('cart.html');
  const save = cart.indexOf('saveOrders(orders);\n      } catch');
  const remove = cart.indexOf('await cart.removeItems(selectedItems');
  assert.ok(save > 0 && remove > save, 'order must be saved first so a failed save leaves the cart intact');
  assert.match(cart, /saved only in this browser/);
});

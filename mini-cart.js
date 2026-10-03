// Header cart badge. Shows the count for the current cart scope only, and
// hides it while the cart for a new sign-in state is still loading.
import { cart } from './cart-service.js';

const badge = document.getElementById('mini-cart-count');
const link = document.getElementById('mini-cart');

cart.subscribe(state => {
  const visible = state.hasData && (state.status === 'ready' || state.status === 'offline');
  const total = visible ? state.count : 0;
  if (badge) {
    badge.textContent = String(total);
    badge.style.display = total > 0 ? 'flex' : 'none';
  }
  if (link) {
    let label = 'Cart';
    if (state.status === 'loading') label = 'Cart (loading…)';
    else if (state.status === 'error') label = 'Cart (unavailable)';
    else if (state.status === 'offline') label = 'Cart (offline)';
    else label = state.scope === 'account' ? `Account cart: ${total} item(s)` : `Guest cart: ${total} item(s)`;
    link.title = label;
  }
});

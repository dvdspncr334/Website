// The one shared cart for every page. Import { cart } from here; never read
// cart data from localStorage directly.
import { createCartStore } from './cart-store.js';

function browserStorage(name) {
  let storage = null;
  try { storage = window[name]; } catch (e) { storage = null; }
  return {
    getItem(key) {
      try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
    },
    setItem(key, value) {
      if (!storage) throw new Error(`${name} is unavailable`);
      storage.setItem(key, value);
    },
    removeItem(key) {
      try { if (storage) storage.removeItem(key); } catch (e) { /* ignore */ }
    },
    keys() {
      try {
        const keys = [];
        for (let i = 0; storage && i < storage.length; i += 1) keys.push(storage.key(i));
        return keys;
      } catch (e) {
        return [];
      }
    }
  };
}

export const cart = createCartStore({
  localStorage: browserStorage('localStorage'),
  sessionStorage: browserStorage('sessionStorage'),
  loadBackend: () => import('./cart-firebase.js').then(m => m.createFirebaseCartBackend()),
  onStorageEvent: handler => window.addEventListener('storage', handler)
});

cart.start();

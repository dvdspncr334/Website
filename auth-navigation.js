// Keep header navigation tied to Firebase Auth, independently of cart loading.
const links = document.querySelectorAll('.header-buttons a[href="login.html"]');

if (links.length) {
  import('./auth-firebase.js').then(({ onUserChanged }) => {
    onUserChanged(user => {
      const label = user ? 'Account' : 'Login';
      links.forEach(link => {
        link.textContent = label;
        for (const attribute of ['aria-label', 'title']) {
          if (link.hasAttribute(attribute)) link.setAttribute(attribute, label);
        }
      });
    });
  }).catch(() => {
    // Leave the static Login link usable if Firebase cannot load.
  });
}

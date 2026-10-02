async function authRequest(endpoint, body) {
  let response;
  try {
    response = await fetch(`/auth/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch {
    throw new Error('Unable to reach the sign-in service. Please try again.');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 ?
      'Google sign-in could not be verified. Please try again.' :
      'Sign-in service unavailable. Please try again.');
  }
  try {
    return await response.json();
  } catch {
    throw new Error('Sign-in is not configured on this host. Please contact support.');
  }
}

export async function getSession() {
  return (await authRequest('session')).user;
}

export async function signIn(credential) {
  return (await authRequest('login', { credential })).user;
}

export async function signOut() {
  await authRequest('logout', {});
  window.google?.accounts.id.disableAutoSelect();
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.getElementById('google-identity');
    if (!script) {
      reject(new Error('Google Identity Services script is missing.'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      if (window.google?.accounts?.id) resolve();
      else reject(new Error('Google sign-in could not load. Please reload the page.'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('Google sign-in could not load. Check your connection and reload the page.'));
    };
    const timer = setTimeout(onError, 15000);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
  });
}

export async function initializeGoogleSignIn(element, onCredential) {
  const { clientId } = await authRequest('config');
  if (!clientId) throw new Error('Google sign-in is not configured. Please contact support.');
  await loadGoogleIdentity();
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: onCredential,
    auto_select: false
  });
  window.google.accounts.id.renderButton(element, {
    type: 'standard', theme: 'outline', size: 'large', width: 320
  });
}

async function setupLoginPage() {
  const button = document.getElementById('google-signin');
  if (!button) return;
  const status = document.getElementById('auth-status');
  const signedIn = document.getElementById('signed-in');
  const userLabel = document.getElementById('auth-user');
  const signOutButton = document.getElementById('sign-out');
  let buttonReady = false;
  let busy = false;

  function showUser(user) {
    button.hidden = Boolean(user);
    signedIn.hidden = !user;
    userLabel.textContent = user ? `Signed in as ${user.email}` : '';
    status.textContent = user ? 'You are signed in.' : 'Choose your Google account to sign in.';
  }

  async function prepareButton() {
    if (buttonReady) return;
    await initializeGoogleSignIn(button, async response => {
      if (busy) return;
      busy = true;
      status.textContent = 'Signing in…';
      try {
        showUser(await signIn(response.credential));
      } catch (error) {
        status.textContent = error.message;
      } finally {
        busy = false;
      }
    });
    buttonReady = true;
  }

  signOutButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    signOutButton.disabled = true;
    status.textContent = 'Signing out…';
    try {
      await signOut();
      showUser(null);
      await prepareButton();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      signOutButton.disabled = false;
    }
  });

  try {
    const user = await getSession();
    showUser(user);
    if (!user) await prepareButton();
  } catch (error) {
    status.textContent = error.message;
  }
}

setupLoginPage();

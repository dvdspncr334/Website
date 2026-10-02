# Firebase Authentication setup

The site uses Firebase Authentication for email/password and Google sign-in.
It runs as static HTML and JavaScript on GitHub Pages: no Node.js backend,
environment variables, npm install, or separate authentication server is needed.

## 1. Get your Firebase web app configuration

1. Open [Firebase Console](https://console.firebase.google.com/) and select your project.
2. Open **Project settings** (the gear icon) → **General**.
3. Under **Your apps**, select your web app. If you have not registered one,
   click the **Web (`</>`)** icon, enter an app nickname, and register it.
   You do not need Firebase Hosting.
4. In **SDK setup and configuration**, select **Config** and copy the
   `firebaseConfig` object.

## 2. Paste the configuration

Open `firebase-config.js` in the website root. Replace the placeholder values
in the exported `firebaseConfig` object with the values from the console.
Keep `export const firebaseConfig =` and the surrounding object syntax.
The provided template lists the usual fields; include any other fields from
your console configuration if needed.

These web app settings (including the Firebase API key) are public and must be
available to the browser. They are not a Google OAuth client secret.
**Never paste a service account private key, Admin SDK credentials, or an OAuth
client secret into the site.** You do not need to supply any credentials to Copilot.

## 3. Check the sign-in providers

You have already enabled both providers; verify these settings if necessary:

1. Open **Build → Authentication → Sign-in method**.
2. Enable **Email/Password** (password-based sign-in; email-link sign-in is not required).
3. Enable **Google**, choose a project support email, and save.
4. Under **Authentication → Settings → Authorized domains**, add:
   - `localhost` for local testing (newer projects may not include it by default).
   - `dvdspncr334.github.io` for GitHub Pages.
   - `www.jgv3d.com`, the custom domain currently specified in `CNAME`.
   - Any other hostname you actually use, such as `jgv3d.com`.

Enter hostnames only, not `https://`, ports, or `/Website` paths.
Keep the Firebase-provided `authDomain` in your configuration; do not replace
it with your GitHub Pages hostname. Google uses a popup through Firebase's
hosted authentication handler, so no redirect handler needs to run on Pages.

## 4. Test locally

From the website root, serve the files over HTTP using Python:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/login.html`. Do not open the HTML using `file://`;
JavaScript modules and authentication require an HTTP/HTTPS origin.

1. Add a product to the cart.
2. Enter an email and password and choose **Create account**. Firebase stores
   the account; passwords must satisfy your project's password policy.
3. Check the signed-in email and **View My Orders** link.
4. Reload the page to confirm Firebase restores the session.
5. Use **Sign out** on the login page (accessible from every page's **Login** link).
6. Sign in again with email/password; test **Forgot password?** after entering an email.
7. Sign out, then test **Sign in with Google**. Allow popups when prompted.
8. Confirm the cart still contains the same items after signing in and out.

Sessions persist in this browser until sign-out; sign out on shared devices.
Firebase synchronizes auth state across tabs on the same origin.
No passwords or tokens are stored by our code; Firebase manages its own persistence.

### Automated utility tests (optional)

With Node.js 22.9+ installed, run:

```sh
node --experimental-vm-modules --test
```

These dependency-free tests stub Firebase; Node.js is needed only to run tests,
not to host the site. Real provider sign-in must be checked using your configured
Firebase project and the manual steps above.

## 5. Deploy to GitHub Pages

1. Commit your updated `firebase-config.js` along with the HTML/JS files.
2. In GitHub **Settings → Pages**, keep the existing deployment source.
   The root-level files require no build step.
3. Visit the HTTPS Pages URL, either
   `https://dvdspncr334.github.io/Website/login.html` or your configured custom domain.
4. Make sure the final hostname (including any redirect destination) is in
   Firebase's **Authorized domains** and test both sign-in methods.

Local assets use relative paths, so they work under `/Website/` as well as on
a custom domain. Firebase SDK modules are loaded from Google's CDN; internet
access to that CDN and Firebase services is required.

## Security and data limitations

Authentication identifies the current user; it does **not** protect static pages
or turn local browser data into account-owned data. The cart (`jgv3d_cart`),
cart selection, and orders remain unchanged in localStorage, shared by users
of the same browser/origin. Signing out does not delete them, and signing in
on another device does not transfer them. Changing hostnames also changes
which browser storage is visible.

If you later store orders or other private data in Firestore or Storage, enforce
ownership using Firebase Security Rules based on `request.auth.uid`; a frontend
login check alone is not access control. Do not enable publicly writable rules.
Consider a stronger password policy and email-enumeration protection in Firebase.

## Troubleshooting

- **Add your Firebase web app configuration**: replace every `YOUR_...` placeholder,
  save, and reload.
- **Authentication unavailable**: check the copied configuration, browser console,
  network access to Google's CDN/Firebase, and any API-key restrictions that may
  block Firebase Authentication or your site's referrer.
- **Unauthorized domain**: add the actual hostname in Firebase Authentication settings.
- **Provider disabled**: enable that provider in Firebase Console.
- **Popup blocked/cancelled**: allow popups and retry the Google button.
- **Account exists with another method**: sign in with the original provider for
  that email instead; automatic account linking is not implemented.
- **Reset email missing**: check spam and the email address, then verify the
  password-reset email template in Firebase Console. Responses intentionally
  do not confirm whether an account exists.

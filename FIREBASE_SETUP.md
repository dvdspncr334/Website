# Firebase Authentication Setup Guide

## Overview

Your website now uses Firebase Authentication for secure login with both email/password and Google sign-in options. Firebase handles authentication server-side, so no backend server is needed—it works perfectly on GitHub Pages.

## What You Just Did

✅ Added `firebase-config.js` with your Firebase configuration  
✅ Added `auth-firebase.js` for authentication utilities  
✅ Updated `login.html` with Firebase sign-in UI  
✅ Added authorized domain `dvdspncr334.github.io` to Firebase

## Next Steps

### 1. Verify Firebase Configuration

Your Firebase config is already in `firebase-config.js`. The public values (API Key, Project ID, etc.) are safe to have in your code.

### 2. Test Locally (Optional)

If you want to test before pushing:

1. Open `login.html` in your browser (or serve locally with a simple HTTP server)
2. Try signing up with an email
3. Try signing in with Google
4. Click "Sign Out"

**Note:** Local testing with `file://` URLs may have CORS issues. Use a local HTTP server if needed:
```bash
python -m http.server 8000
# Then visit http://localhost:8000/login.html
```

### 3. Deploy to GitHub Pages

1. Push these changes to your main branch
2. Your site at `https://dvdspncr334.github.io` will automatically use the new login

Firebase is already aware of this domain (you added it in Firebase Console), so login should work immediately.

### 4. Test on Live Site

Visit `https://dvdspncr334.github.io/login.html` and:

- ✅ Click "Create Account" tab and create a test account
- ✅ Sign out
- ✅ Sign in with that account
- ✅ Try Google sign-in
- ✅ Verify the cart badge still works (see the cart switching checks below)

## How It Works

- `firebase-config.js`: public Firebase web configuration. It's safe to keep in Git, and no client secrets or service-account keys are needed.
- `auth-firebase.js`: loads the Firebase Auth SDK (CDN version 10.7.0). It exports `app`, `auth`, `onUserChanged()`, `getSession()`, `signInWithGoogle()`, `signInWithEmail()`, `createAccountWithEmail()`, `resetPassword()` and `signOut()`.
- `login.html`: Sign In / Create Account tabs, Google sign-in, "Forgot password?", and a signed-in account view.
- Cart files (see below): `cart-store.js`, `cart-firebase.js`, `cart-service.js`, `mini-cart.js`, plus `firestore.rules`.
- Admin files (see [Admin dashboard](#admin-dashboard)): `admin.html`, `admin-auth.js` (`isAdmin()`), `user-activity.js`, `shop-csv.js`.

## Carts: guest vs. account (strictly separate)

| Who is browsing | Cart that is shown | Where it is stored |
| --- | --- | --- |
| Signed out | The **guest cart** for this browser | `localStorage` key `jgv3d_cart_guest` |
| Signed in as A | **Only A's** cart | Firestore `users/{A's uid}/carts/current` |
| Signed in as B | **Only B's** cart | Firestore `users/{B's uid}/carts/current` |

- Nothing is ever copied, merged, or transferred between these carts. Signing in hides the guest cart and loads only that account's cart. An account with no saved cart shows an **empty** cart, even if the guest cart has items. Signing out shows the untouched guest cart again.
- The cart and badge are cleared as soon as the signed-in user changes. Cart buttons and checkout stay disabled until the new cart has loaded. Late responses that belong to a previous user are ignored.
- Account carts update live across tabs and devices through a Firestore listener. Every change runs as a Firestore transaction that only touches the affected item, so two devices editing at once don't overwrite each other.
- There is no offline queue for account carts. If the connection drops or a save fails, the cart page says so and shows a **Retry** button; it never claims the change was saved. Account carts are not stored in the browser between visits (no persistent Firestore cache), which matters on shared computers.
- Cart prices and images are only for display. They aren't trusted payment amounts.
- The Firebase SDK loads from the CDN, so if gstatic.com is unreachable the cart (guest carts included) shows an error with Retry instead of possibly showing the wrong cart.
- **Old carts:** carts saved before this change under the unowned key `jgv3d_cart` (with `jgv3d_cart_selection`) are moved **once into the guest cart only** and never into any account. Those old carts had no owner, so on a shared browser the moved guest cart may contain items added by anyone who used that browser before.

## Orders are still browser-local demo data

Checkout still creates **local demo orders** in this browser's `localStorage` (`jgv3d_orders`). Orders are **not** linked to your Firebase account, not synced between devices, and not private from other people using the same browser. This change doesn't move orders to Firestore. If saving the demo order fails, the cart is left as it was.

## Remaining Firebase Console / deployment steps (required for account carts)

This pull request **does not** create your database or publish rules. Until you finish these steps, signed-in carts will show a load error (guest carts still work).

1. **Create the Firestore database** (skip this if it already exists): Firebase Console → project `jgv3d-fc043` → **Build → Firestore Database → Create database**.
   - Pick the **Standard** edition / `(default)` database if you're asked.
   - Pick a **location close to most of your customers** (for example `us-central1`/`nam5` for the US, or `eur3`/`europe-west` for Europe). **The location can't be changed later.**
   - Start in **production mode**. Do **not** pick test mode, which leaves the database open to everyone.
2. **Publish the security rules** from `firestore.rules` in this repo:
   - **Console:** Firestore Database → **Rules**. If the editor already has rules for other collections, **keep them**, and paste only the `match /users/{uid}/carts/{cartId} { ... }` block plus the helper functions inside your existing `match /databases/{database}/documents { ... }`. Then click **Publish**.
   - **or CLI:** `npm install`, then `npx firebase login` and `npx firebase deploy --only firestore:rules --project jgv3d-fc043`. ⚠️ This **replaces** all published rules with `firestore.rules`, so merge any existing rules into that file first.
   - The rules allow reading or writing a cart only by the signed-in user whose uid matches `{uid}`. They check the cart's shape (at most 50 lines, quantity 1–99, limited text and price sizes) and deny everyone else.
3. **Indexes:** none are needed. The cart is read as a single document.
4. **Authorized domains:** make sure your live domain(s) are listed under Authentication → Settings → Authorized domains (`dvdspncr334.github.io` and any custom domain from `CNAME`).
5. **Test on the live site** (open the browser console with F12 to check for errors):
   1. Signed out: add an item. It appears in the cart and the badge.
   2. Sign in as account A. The cart should be **empty** for a new account (the guest item must **not** appear). Add a different item.
   3. Sign out. Only the original guest item is shown.
   4. Sign in as account B. B's cart is empty, and neither A's nor the guest item appears. Sign out again; the guest cart is unchanged.
   5. Sign in as A on a second device or browser. A's item appears, and changes made on one device show up on the other within a few seconds.
   6. Go offline (DevTools → Network → Offline) while signed in and change the quantity. You should see an error or offline message with Retry, not "saved".
   7. In Firestore → Data, confirm that `users/<uid>/carts/current` exists only for accounts that added items.

## Admin dashboard

`admin.html` is an admin-only dashboard. It isn't linked in the site header; admins see an **Admin Dashboard** button on the signed-in view of `login.html`, or can open `/admin.html` directly.

### How access works

- A signed-in user is an admin when the Firestore document `admins/{their uid}` exists. `admin-auth.js` exports `isAdmin()`, which reads that document and caches the answer in `sessionStorage` under `jgv3d_admin_status_<uid>` for 5 minutes (cleared when you log out from the dashboard and when an admin is removed).
- `admin.html` redirects to `login.html` if nobody is signed in or the user isn't an admin.
- `admin.html` is a public static file, so anyone can download its HTML. The page check is only for convenience. **The real protection is `firestore.rules`**: the admins list and user activity can only be read or changed by admins, and the shop CSV can only be committed with your own GitHub token.

### Firestore data used by the dashboard

| Path | Written by | Readable by |
| --- | --- | --- |
| `admins/{uid}` → `{ email, addedBy, addedAt }` | Admins (or you, in the Firebase Console) | The user themselves (to check their own status) and admins |
| `userActivity/{uid}` → `{ email, lastSignInAt, lastActiveAt }` | Each signed-in user, for themselves only (from `mini-cart.js` → `user-activity.js`, at most once every 15 minutes per browser session) | Admins only |

`userActivity` stores only the email address, last sign-in time and last activity time. It isn't a full account list: only users who have signed in since this was deployed appear. Delete any entry in the Firebase Console if you need to.

### Setup steps (one time)

1. **Publish the updated rules** from `firestore.rules` (same way as for carts above: Console → Firestore Database → Rules, or `npx firebase deploy --only firestore:rules --project jgv3d-fc043`). The cart rules are unchanged; the new parts are the `isAdmin()` function and the `admins` and `userActivity` blocks.
2. **Find your UID:** sign in on the live site, then go to Firebase Console → **Authentication → Users** and copy the *User UID* for your account.
3. **Add the first admin by hand** (bootstrap). Clients can't create the first admin, so this must be done in the console: Firestore Database → **Data** → **Start collection** → Collection ID `admins` → Document ID = **your UID** (paste it exactly, don't use Auto-ID) → add a field such as `email` (string) with your email → **Save**. Any fields are fine; only the document's existence matters.
4. Visit `/admin.html` while signed in. The dashboard should load. On the **Settings** tab, *Firestore rules status* should show three ✔ checks.
5. **Add more admins** from Settings → *Admin users*: enter their email. They must have signed in to the site at least once after step 1 (so a `userActivity` record exists); otherwise you get a "No user with that email" error. Adding someone who is already an admin shows an error. Remove admins with the **Remove** button. If you remove the last admin, repeat step 3.

### Manual test checklist

1. Signed out, open `/admin.html` → redirected to `login.html`.
2. Sign in with a non-admin account and open `/admin.html` → redirected to `login.html` with "This account doesn't have admin access."
3. Add yourself in the console (step 3), open `/admin.html` → dashboard loads; there is no cart badge; **Log out** and **Back to site** work.
4. Shop Management: edit a product, add a product, delete a product, then **Download CSV** and check the file. Invalid values (duplicate id, non-numeric price, empty `|` entries in colors, `javascript:` image paths, `<`/`>` characters) are rejected with a message.
5. User Activity lists recently signed-in emails with sign-in and last-active times.
6. Settings: add a second admin by email, then remove them. Then remove yourself → you are sent to `login.html` and `/admin.html` is denied again.

### Shop CSV editor: what it can and can't do

- It loads the currently deployed `data/shop.csv`, lets you add, edit and delete products with validation (unique lowercase id, price as a number with up to 2 decimals, pipe-delimited `colors` / `pickup_configs`, `Color:path` pairs in `color_images`, `handedness` of both/right/left, `status` of in-stock/made-to-order/preorder, discount 0–100, no line breaks or `<`/`>`), and exports a CSV that `shop.html` reads the same way.
- Edits only live in the page until you save them. There are two ways to save:
  - **Download CSV** (always available): replace `data/shop.csv` in the repository with the downloaded file (for example on GitHub: open `data/shop.csv` → ✏️ Edit → paste, or *Add file → Upload files*) and commit.
  - **Commit to GitHub** (optional): paste a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to this repository with **Contents: Read and write**. The dashboard commits `data/shop.csv` through the GitHub API. The token stays in the page's memory only. It is never saved to browser storage or Firestore, is sent only to `api.github.com`, and is cleared after a successful commit. A static site has no server environment to keep a token in, so you paste it each time.
- Rows that are completely empty (like the `,,,,` spacer line) and malformed rows are dropped when you save; the editor tells you if it skipped any.
- The shop updates after GitHub Pages redeploys (usually a minute or two). Image files aren't uploaded by the editor; add new images to `images/` in the repository first and then reference their paths.
- Before committing, the dashboard checks that `data/shop.csv` on GitHub is still the version you loaded. If it changed (another edit, or Pages hasn't redeployed your last commit yet), the commit is refused so nothing is overwritten. Download your CSV, reload, and redo the edit.

### Orders are not managed in the admin panel

Orders are still **browser-local demo data** (see above). There is no server copy, so the admin panel **can't** see or manage customers' orders. The *Orders Overview* tab only shows, read-only, any demo orders stored in the admin's own browser, with a notice explaining this.

### Not implemented (out of scope)

- No full user-account list or account management (only the minimal `userActivity` records above), no payment processing, no shipping labels, no email notifications, and no live order syncing.
- No server-side "look up any Firebase Auth user by email": that needs the Admin SDK on a server. Lookup by email only finds users with a `userActivity` record.

## Developer checks

```bash
npm install
npm test            # unit tests (cart store, page wiring, auth module, admin helpers, shop CSV editor)
npm run test:rules  # Firestore emulator rules tests (needs Java 11+; downloads the emulator)
```

## Limitations

- Email verification is optional (users can sign up without verifying their email).
- User profile data (name, photo) is only available after Google sign-in.

## Troubleshooting

### "Sign-in is currently unavailable"

- Check that `dvdspncr334.github.io` is in Firebase Console under **Authentication → Settings → Authorized domains**
- Clear browser cache
- Check browser console for errors (F12 → Console)

### Google sign-in button doesn't work

- Make sure you're accessing the site via `https://dvdspncr334.github.io` (not `file://`)
- Check that Google is enabled in Firebase Console under **Authentication → Sign-in method**

### Can't sign in with email

- Make sure you created an account first (try the "Create Account" tab)
- Check that email/password authentication is enabled in Firebase
- Check browser console for error messages

### Admin dashboard keeps sending me to the login page

- Check that `admins/<your uid>` exists in Firestore (Document ID must be your exact UID from Authentication → Users) and that the updated `firestore.rules` are published.
- A cached "not an admin" answer is always re-checked before the dashboard redirects, so a newly added admin gets in right away. The **Admin Dashboard** button on `login.html` can take up to 5 minutes (or a new tab) to appear.

### Signed-in cart shows "couldn't load" / permission error

- Check that the Firestore database exists (step 1) and that the rules from `firestore.rules` are published (step 2).
- Check the browser console for `permission-denied` (rules) or `unavailable` (network) errors.

## Support

For Firebase documentation, visit [firebase.google.com/docs](https://firebase.google.com/docs).

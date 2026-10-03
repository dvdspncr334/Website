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

## Developer checks

```bash
npm install
npm test            # unit tests (cart store, page wiring, auth module)
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

### Signed-in cart shows "couldn't load" / permission error

- Check that the Firestore database exists (step 1) and that the rules from `firestore.rules` are published (step 2).
- Check the browser console for `permission-denied` (rules) or `unavailable` (network) errors.

## Support

For Firebase documentation, visit [firebase.google.com/docs](https://firebase.google.com/docs).

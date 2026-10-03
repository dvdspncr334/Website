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
- Admin files (see [Admin dashboard](#admin-dashboard)): `admin.html`, `admin-auth.js` (`isAdmin()`), `user-activity.js`, `shop-csv.js`, `product-creator.js`, `product-photos.js`, `github-publish.js`.

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

## Orders and shipping addresses

Signed-in buyers check out from their account cart. Guests can **Continue as Guest** without creating an account (see *Guest checkout* below). Saved addresses are for signed-in accounts only.

| Data | Firestore path | Who can read | Who can write |
| --- | --- | --- | --- |
| Saved shipping address | `users/{uid}/profile/shipping` → `{ firstName, lastName, streetAddress1, streetAddress2, city, state, postalCode, country, phone, deliveryNotes, lastUpdated }` | That user, and admins | That user only (save/delete) |
| Orders | `users/{uid}/orders/{orderId}` → `{ id, date, createdAt, status, items[{id,title,img,qty,price}], total, shipping{…address}, notes, email }` (guest orders also have `guest: true`), with optional lifecycle metadata | That user, and admins (all users' orders) | That user can **create** only. Admins can update lifecycle status/cancellation reason or permanently delete exact order documents. |

- **Checkout:** clicking **Proceed to Checkout** opens a *Shipping details* dialog. It is filled in from the saved address if there is one. Required fields: first/last name, street address, city, state/region, postal code and country. Phone, apartment/suite, delivery notes and order notes are optional. All values are trimmed. **Place Order** saves the order to Firestore first (status `In Queue`, order number `JGV-########`), then removes the ordered items from the cart and goes to *My Orders*. If saving fails (permission denied, offline, …) the dialog stays open with an error, and the cart is not changed. Escape or **Cancel** closes the dialog without ordering.
- **"Save this address for next time"** is unticked by default. The address is saved to the account only when it is ticked.
- **Account → Settings** (on `login.html`; link straight to it with `login.html#settings`) shows the saved address, with **Edit/Add address**, **Save changes** and **Delete** (asks for confirmation). Past orders keep the address they were shipped to.
- **Privacy:** each buyer sees only their own orders and address. Admins can read every order and address. Addresses and orders are **never stored in browser storage** (Firestore uses its in-memory cache). On sign-out or an account switch, the checkout dialog closes and the Settings form, orders list and order details are cleared, so the next person never sees the previous account's data.
- **No payment is taken.** Item prices and totals come from the buyer's browser (the same values the cart shows), so confirm them with the buyer before charging. The rules check the order's fields, address and item count, but Firestore rules can't check each item in a list, so item details and the total aren't verified on the server.
- **Old demo orders:** orders created before this change were saved only in the buyer's browser (`localStorage` key `jgv3d_orders`). They are left untouched and are **not** imported into Firestore. *My Orders* now shows only account orders; the admin *Orders* tab still lists the old demo orders stored in the admin's own browser, in a separately labelled table.

## Guest checkout (no account needed)

Guest checkout uses **Firebase Anonymous Authentication**. When a guest clicks **Continue as Guest** and places an order, the site signs them in anonymously and saves the order at `users/{anonymousUid}/orders/{orderId}`. The same owner-only rules apply as for accounts, and admins see the order through the existing collection-group query. Orders are **not** publicly readable or writable.

- **⚠️ Required one-time setup:** Firebase Console → **Authentication → Sign-in method → Add new provider → Anonymous → Enable → Save**. Until you do this, guest checkout shows "Guest checkout isn't enabled on this site yet…" (`auth/operation-not-allowed`). The guest's cart isn't changed and nothing is ordered.
- **Form:** the same shipping fields, plus a required **contact email** so you can reach the buyer. The email is checked in the browser and in the rules: 6–254 characters and a `name@domain.tld` shape. There is no "save this address" option, and guest shipping details and email are **never stored in browser storage**.
- **Cart:** the order is built from the selected items in the browser **guest cart**. After the order is saved, only those items are removed from the guest cart. Nothing is ever merged into an account cart.
- **Anonymous sessions are not accounts.** Navigation still shows **Login**, and guests keep using the guest cart and guest shop/gallery selections. They don't see Account settings or a saved address, no `userActivity` record is written (the rules need an account email), and they can never pass admin checks.
- **Confirmation & history:** after ordering, the guest sees the order number and contact email, plus a reminder to save the order number. *My Orders* shows guest orders placed **in this browser while the anonymous session lasts**. Clearing browser data, or signing in to an account (which replaces the anonymous session), removes that access. The guest can still contact you with the order number. The login page warns guests about this.
- **No account linking:** "Create an account" links are offered, but guest orders are **not** moved into a new account (`linkWithCredential` isn't implemented).
- **Admin:** guest orders show a **Guest** badge and the guest's contact email in the Orders tab and in the details dialog. Status updates, cancellation and deletion work the same as for account orders.
- **Rules:** for anonymous users (`request.auth.token.firebase.sign_in_provider == 'anonymous'`), an order must have `guest == true` and a valid contact email. Account orders must have **no** `guest` field, and `email` must still match the account's token email (unchanged). Anonymous users can't save a `profile/shipping` address.
- **Spam / abuse:** guest checkout makes it easier to submit junk orders, because anyone can get an anonymous session. The existing limits still apply (1–50 items, quantity/price/total bounds, field lengths, initial status `In Queue`, no overwriting), but **there is no rate limiting or bot protection**. A recommended follow-up is **Firebase App Check** (reCAPTCHA Enterprise) enforced for Firestore and Authentication. You can delete junk orders from the admin Orders tab. Firebase can also auto-clean unused anonymous accounts (Authentication → Settings).

## Remembered shop and gallery selections

The shop remembers each product's selected options/color and custom-color drafts, plus the chosen category and subcategory. The gallery remembers the photo selected for each multi-photo item, plus the category and subcategory. These are non-sensitive UI preferences, handled in `ui-prefs.js`:

- **Guests** (including anonymous guest-checkout sessions) use the same browser keys as before (`jgv3d_shop_selected_options`, `jgv3d_custom_note_drafts`, `jgv3d_last_category`, `jgv3d_last_subcategory`, `jgv3d_gallery_image_selection`, `jgv3d_gallery_category`, `jgv3d_gallery_subcategory`).
- **Signed-in accounts** use separate `localStorage` keys in **this browser** namespaced by uid: `jgv3d_prefs_v1:{uid}:{name}`. Choices survive reloads and page changes. Each account reads only its own keys. Nothing is copied between guest and account, or between accounts. On an account switch the page drops the previous scope's choices and re-renders with the new account's choices.
- On sign-out the account's keys are **kept**, so the choices return on the next sign-in in this browser. They are not synced to other devices. Custom-color drafts are the user's own text, so don't type anything sensitive in them.
- Account maps are capped at 200 entries, and entries for products/gallery items that no longer exist are pruned. Storage errors (full/blocked) are ignored, and the page keeps working without remembering choices.
- While sign-in is still being checked (or if Firebase can't load), choices are kept in memory only for that page.

## Remaining Firebase Console / deployment steps (required for account carts)

This pull request **does not** create your database or publish rules. Until you finish these steps, signed-in carts will show a load error (guest carts still work).

1. **Create the Firestore database** (skip this if it already exists): Firebase Console → project `jgv3d-fc043` → **Build → Firestore Database → Create database**.
   - Pick the **Standard** edition / `(default)` database if you're asked.
   - Pick a **location close to most of your customers** (for example `us-central1`/`nam5` for the US, or `eur3`/`europe-west` for Europe). **The location can't be changed later.**
   - Start in **production mode**. Do **not** pick test mode, which leaves the database open to everyone.
2. **Publish the security rules** from `firestore.rules` in this repo:
   - **Console:** Firestore Database → **Rules**. If the editor already has rules for other collections, **keep them**, and paste the helper functions and `match` blocks from `firestore.rules` (carts, `profile/shipping`, `orders`, the `{path=**}/orders` admin block, `admins`, `userActivity`) inside your existing `match /databases/{database}/documents { ... }`. Then click **Publish**.
   - **or CLI:** `npm install`, then `npx firebase login` and `npx firebase deploy --only firestore:rules --project jgv3d-fc043`. ⚠️ This **replaces** all published rules with `firestore.rules`, so merge any existing rules into that file first.
   - The rules allow reading or writing a cart only by the signed-in user whose uid matches `{uid}`. They check the cart's shape (at most 50 lines, quantity 1–99, limited text and price sizes) and deny everyone else.
3. **Indexes:** none are needed. The cart and saved address are single documents; orders are listed without filters or sorting (sorted in the browser), so no composite or collection-group index is required.
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
| `users/{uid}/orders/{orderId}` (see [Orders and shipping addresses](#orders-and-shipping-addresses-signed-in-buyers-only)) | The buyer, create only; admins, constrained lifecycle updates and permanent deletion | The buyer and admins (the all-account scope uses a collection-group query on `orders`) |
| `users/{uid}/profile/shipping` | The buyer | The buyer and admins |

`userActivity` stores only the email address, last sign-in time and last activity time. It isn't a full account list: only users who have signed in since this was deployed appear. Admins can delete activity records in the dashboard without deleting Firebase Auth accounts. Publish the latest `firestore.rules` to enable these admin-only deletes.

### Setup steps (one time)

1. **Manually publish the full updated `firestore.rules` in Firebase Console → Firestore Database → Rules → Publish.** Review and preserve any rules for other collections before replacing the editor contents. The PR includes the entire rules file, but merging/deploying the website **does not publish Firestore rules**. The newest change allows only real admins to update lifecycle fields and delete orders at exact `users/{uid}/orders/{orderId}` paths; the recursive collection-group match remains read-only. Until the PR is merged and these rules are published, existing orders can only be removed manually in Firebase Console, and the new site's admin mutations will show permission errors. No production data deletion or Console changes are performed by this implementation.
2. **Find your UID:** sign in on the live site, then go to Firebase Console → **Authentication → Users** and copy the *User UID* for your account.
3. **Add the first admin by hand** (bootstrap). Clients can't create the first admin, so this must be done in the console: Firestore Database → **Data** → **Start collection** → Collection ID `admins` → Document ID = **your UID** (paste it exactly, don't use Auto-ID) → add a field such as `email` (string) with your email → **Save**. Any fields are fine; only the document's existence matters.
4. Visit `/admin.html` while signed in. The dashboard should load. On the **Settings** tab, *Firestore rules status* should show four ✔ checks.
5. **Add more admins** from Settings → *Admin users*: enter their email. They must have signed in to the site at least once after step 1 (so a `userActivity` record exists); otherwise you get a "No user with that email" error. Adding someone who is already an admin shows an error. Remove admins with the **Remove** button. If you remove the last admin, repeat step 3.

### Manual test checklist

1. Signed out, open `/admin.html` → redirected to `login.html`.
2. Sign in with a non-admin account and open `/admin.html` → redirected to `login.html` with "This account doesn't have admin access."
3. Add yourself in the console (step 3), open `/admin.html` → dashboard loads; there is no cart badge; **Log out** and **Back to site** work.
4. Shop Management: edit a product, add a product, delete a product, then **Download CSV** and check the file. Invalid values (duplicate id, non-numeric price, empty `|` entries in colors, `javascript:` image paths, `<`/`>` characters) are rejected with a message.
5. Dashboard shows product count and users whose last sign-in falls within 24 hours / 7 days. These count users, not individual sign-in events (only the latest sign-in is stored).
6. Shop Management: select/deselect rows and select all visible products, preview a bulk status/discount/price update, cancel, then confirm. Only selected products change; download/commit the CSV to publish them.
7. User Activity: search email, filter an inclusive date range by last sign-in, sort columns, and export the displayed rows as CSV. Delete an activity record only after both confirmations and typing `confirm-clear`; the Firebase Auth account is not deleted.
8. Settings: download a JSON backup and check the filename, timestamp, products, users, admins and byte count. Products come from the in-memory CSV (including unsaved edits), not Firestore. No auth passwords or tokens are included.
9. Settings Maintenance: clear activity only after both confirmations and typing `confirm-clear`. Publish the updated `firestore.rules` first: only current admins can delete activity. Deletes run in batches; a failed later batch does not undo earlier batches. Visitors still signed in may create new activity records afterward.
10. Reset demo orders removes only `jgv3d_orders` in the viewing browser; carts, auth accounts and Firestore (including account orders) are untouched.
11. Settings Audit log: check product edits, bulk updates, admin changes, clears and backups; export CSV/JSON, clear the log, and refresh to verify it resets. This is a **client session log, not an authoritative audit trail**, stored only in browser sessionStorage for this page session, never Firestore. Order entries include only IDs/actions/status/counts, never customer shipping details or cancellation reasons.
12. Settings: add a second admin by email, then remove them. Then remove yourself → you are sent to `login.html` and `/admin.html` is denied again.

### Guided product creation and photo publishing

1. Open **Shop → Create product with photos**, or choose **Duplicate template** beside an existing product. Duplication copies its settings and existing image references, but suggests a new unique ID. It does not change the original product.
2. Enter the title, price and description. Review the suggested editable slug/ID. Choose existing categories/subcategories or enter custom lowercase dashed values. Set handedness, status, discount, badge and custom-color fee. Use the convenient colors/pickup controls instead of typing CSV delimiters. Unknown CSV columns and other products are retained.
3. Drop photos into the photo area or use its keyboard-accessible file picker. Only decoded JPEG, PNG and WebP are accepted; SVG and executable files are rejected. Default limits are 10 MB per file, 12 photos per draft, 40 MB total and 40 megapixels per image; `PHOTO_LIMITS`/creator `photoOptions` configure bounded processing limits. Publication additionally caps the session at 20 photos and 40 MB including the CSV (CSV alone is capped at 2 MB). Review the dimensions and sizes. Resizing/compression is optional: the defaults limit the longest edge to 2000 pixels with quality 0.9, and keeping the original avoids re-encoding. PNG retains transparency; browser decoding handles orientation where supported. Check rotated/transparent images in your browser before publishing.
4. Reorder/remove photos, select the main photo and associate variant photos with colors. Every saved photo must be the main image or a color variant; this is **not** an arbitrary product gallery. The storefront uses the existing `img` and `color_images` columns, not `gallery.csv`.
5. Check the live card preview, choose **Review**, then **Save to list**. This only stages the product and files in memory. A thumbnail is **not** an uploaded image. Closing/reloading the page loses drafts; discard and reload actions ask for confirmation.
6. Choose either publication or export:
   - **Commit CSV + staged photos**: explicitly set owner, repository and branch. Enter your own [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new), restricted to that repository with **Contents: Read and write**. Enter it only in the dashboard password field, never in chat. Firebase admin access does not grant GitHub permissions. The token goes only to `api.github.com` with redirects rejected; it is never stored in Firebase, browser storage, audit logs or exports, and is cleared on successful publication, signout and account change.
   - **Export CSV + photos**: no token is needed. This prepares separate, individually clickable downloads rather than a ZIP. Download **every** listed file, including `README.txt`. Create the matching `images/products/{product-id}/` folders in the repository, upload images to the exact case-sensitive paths listed in the instructions, and replace `data/shop.csv`. Review concurrent repository edits and commit all files together. Export is **not** publication and performs no deployment verification.
   - **Download CSV** still works for CSV-only edits. With staged photos it warns that CSV alone will reference missing assets and offers cancellation so you can use the photo export instead.

GitHub publication uses the official [Git blobs](https://docs.github.com/en/rest/git/blobs), [trees](https://docs.github.com/en/rest/git/trees), [commits](https://docs.github.com/en/rest/git/commits) and [references](https://docs.github.com/en/rest/git/refs) APIs. The confirmation lists product changes and all files. Images receive generated filenames without overwriting existing repository images. One commit contains the CSV and referenced photos, based on the existing tree so unrelated files remain untouched. Before the non-forced branch update, the publisher checks the loaded CSV baseline and rechecks the branch head. Conflicts, protected branches, permissions and network failures preserve edits for retry/export. If the final update's response is lost, check the repository before retrying: publication may have succeeded despite the missing response. Cancel cannot roll back an update already accepted by GitHub.

The site changes only **after GitHub Pages deployment**, which is not automatically verified here. Product images are **public site assets**, not private uploads. There is no Firebase Storage setup, billing change or Storage rule change. Customer carts and `gallery.csv` are untouched.

The raw-field editor remains available for existing products and advanced CSV edits. Completely empty spacer rows are omitted, but malformed lines or ambiguous headers **block export/publication** to avoid silently losing unseen products. Repair the original CSV non-destructively in the repository and reload. If GitHub's CSV differs from the deployed copy (including while Pages is still deploying), export your edits before reloading and reconcile them with the latest repository copy.

#### Manual acceptance checks

- On desktop and mobile, check keyboard operation, errors, review/back navigation, discard confirmation, thumbnail reordering and main/color selection.
- Try real JPEG (including EXIF-rotated), transparent PNG and WebP images, an invalid/mislabeled image, SVG, and files exceeding configured limits; confirm dimensions, quality and final filenames.
- With a repository-scoped test token, confirm a single commit includes images and CSV while retaining unrelated files. Test permission denial, network interruption, conflict and retry. Inspect the repository after an interrupted final branch update.
- Download all export files and follow `README.txt`; verify their paths and the storefront after Pages deploys.
- Change accounts or sign out during image processing/publication. Verify transient drafts/tokens are cleared and stale callbacks do not populate the next account.

### Orders overview

The *Orders* tab keeps real account orders separate from old browser demos:

- **Account orders (Firestore):** the *Account scope* dropdown offers **All accounts** (default), **Guest accounts** and **Signed-in accounts**. Every scope loads all buyers' orders with the admin-only collection-group read, then narrows client-side: orders with `guest: true` are guest orders; every other order (including legacy orders without the marker and admins' own purchases) is a signed-in order. Changing scope clears selections and open dialogs; the scope composes with the ID/status/email filters for counts, select-all, filtered export and deletion. Search/filter by full ID, email and status; selection uses complete Firestore document paths, so the same order ID in two accounts cannot select/delete the wrong account. Scope and loaded/filtered/selected counts are shown. Refresh after mutations; buyers observe status changes and deletion on their list/detail pages.
- **View details / update status:** inspect an order, then choose `In Queue`, `In Progress`, `Shipped`, `Completed` or `Cancelled`. Cancelling asks for confirmation and an optional reason (maximum 500 characters), visible to the buyer. Items, prices, totals, shipping, email, identity and creation date stay unchanged. Updates use a transaction and reject a stale displayed status instead of overwriting another admin's change; refresh and review before retrying. New metadata (`statusUpdatedAt`, `statusUpdatedBy`, `cancellationReason`) is optional for legacy records, and updates do not re-run the creation timestamp validator.
- **Cancellation is a record status only.** It does **not** issue refunds, take or reverse payments, send shipping notifications, or adjust stock. Handle those separately. No payment processing exists in this site.
- **Permanent deletion / clearing test orders:** use individual deletion or select the exact existing test orders in the intended scope. The danger preview lists captured paths and the exact count/scope. Review both confirmations and type the required phrase before deletion. Deletion is permanent, not cancellation, and removes only those confirmed order documents—not carts, saved addresses, users, admin membership, activity or unrelated documents. Newly arriving orders are not added to the confirmed set. There is no recursive delete or automatic “test order” detection.
- **Optional private backup:** explicitly download the captured orders as JSON before deletion if needed. This contains customer personal data; keep it private, do not commit it or share it publicly. It is a user-triggered local download only, never automatically sent elsewhere. The Settings database backup does not include orders.
- **Partial failure:** deletion uses server-only transactions in chunks of at most 100 paths, with fresh server and transactional admin-membership checks. It fails offline rather than queueing a deletion for a later session. Acknowledged earlier chunks remain deleted if a later chunk fails; the result shows counts and retains only remaining confirmed paths for retry. A failed response can be ambiguous: inspect/refresh before retrying; retrying an already missing confirmed path is safe. Closing/signing out cannot undo writes already accepted by Firestore. Controls are disabled while pending, and stale callbacks are discarded on account changes. Server rules remain authoritative.
- **Local demo orders (this browser only):** `jgv3d_orders` entries are not Firestore orders and are never imported. The separately labelled reset in Orders (also accessible in Settings) uses the existing browser maintenance mechanism and affects only this browser's demos.

#### Manual order checks

1. Signed out, add an item and open the cart: checkout is disabled with "Sign in to place an order".
2. Sign in as A → Account → **Settings**: "No saved address…" is shown. Add an address, save, edit it, and check the summary.
3. Cart → **Proceed to Checkout**: the form is pre-filled. Clear a required field and submit (error on that field). Go offline (DevTools → Network → Offline), submit (error, dialog stays open, cart unchanged), go online and retry: the order is placed, items leave the cart, and you are taken to *My Orders*. Open the order details to see the shipping address.
4. Place another order with a different address and **without** ticking "Save this address": Settings still shows the old address.
5. Sign out and sign in as B: Settings, checkout and *My Orders* show none of A's data. Opening A's order-details link shows "Order not found".
6. Delete B's saved address in Settings, then check out: the form starts empty.
7. As an admin, open *Orders*: All accounts is the default and shows A, B, guest orders and the admin's own orders. Guest accounts shows only `Guest` orders; Signed-in accounts shows A, B and the admin. Use disposable emulator/test-project records, not production customer records, for destructive checks.
8. Cancel a test order, first dismissing confirmation (no write), then confirming with a reason. The buyer sees `Cancelled`, not completed progress. Test another admin changing the status before your save: it must require a refresh.
9. Select two test orders with identical IDs in different accounts. Check both full paths in the deletion preview. Cancel either confirmation (no deletion), download a private backup if desired, then confirm only disposable test records. Introduce a new order after preview: it must not be deleted. Simulate a later batch failure and retry only the remaining confirmed set.
10. Sign out/switch accounts while loading or confirming: old customer data and dialogs disappear, and old callbacks cannot populate the new account. Delete a disposable order and verify its buyer detail view shows “Order not found.”
11. Reset browser demos from Orders: Firestore orders, carts, saved addresses and accounts remain untouched.
12. Rules (`npm run test:rules`): owner/non-admin/unauthenticated order updates/deletes are denied; admins may update only valid lifecycle fields with server timestamp and their own UID, or delete exact order documents. Immutable field edits, invalid statuses/reasons, forged metadata and recursive wildcard writes are denied.

### Not implemented (out of scope)

- No full user-account list or account management (only the minimal `userActivity` records above), no payment processing/refunds, no shipping labels or notifications, no inventory adjustments, and no linking of guest orders to accounts.
- No server-side "look up any Firebase Auth user by email": that needs the Admin SDK on a server. Lookup by email only finds users with a `userActivity` record.

## Developer checks

```bash
npm install
npm test            # unit tests (cart store, page wiring, auth module, admin helpers, shop CSV editor, shipping/orders)
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

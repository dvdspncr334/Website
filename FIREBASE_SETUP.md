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

Fire base is already aware of this domain (you added it in Firebase Console), so login should work immediately.

### 4. Test on Live Site

Visit `https://dvdspncr334.github.io/login.html` and:

- ✅ Click "Create Account" tab and create a test account
- ✅ Sign out
- ✅ Sign in with that account
- ✅ Try Google sign-in
- ✅ Verify the cart badge still works

## How It Works

### Frontend

- `login.html` — UI with three tabs: Sign In, Create Account, and Google Sign-In
- `auth-firebase.js` — JavaScript module that imports Firebase SDK from Google's CDN and provides `getSession()`, `signInWithGoogle()`, `signInWithEmail()`, `createAccountWithEmail()`, and `signOut()` functions
- `firebase-config.js` — Public Firebase configuration (safe to keep in Git)

### Backend

Firebase handles everything:
- User registration and login
- Password hashing and security
- Session management
- OAuth flow for Google sign-in

No server to manage, no environment variables needed.

## Important Notes

### Security

- **Public values:** Your API Key and Project ID are public and cannot be used alone to access user data
- **User data:** Firebase stores user accounts and enforces authentication
- **Sessions:** Managed by Firebase—no tokens stored in `localStorage`
- **HTTPS:** Firebase requires HTTPS in production (GitHub Pages is HTTPS by default)

### Cart & Orders

- Logging in does **not** encrypt or protect your cart (`jgv3d_cart` in `localStorage`)
- Orders remain local browser data until you move them to a database
- To sync cart/orders across devices, store them in Firestore (Firebase's database)

### Limitations

- Email verification is optional (users can sign up without verifying their email)
- Password reset via email is not yet implemented
- User profile data (name, photo) is only available after Google sign-in

To add these features, check Firebase Console under **Authentication → Settings**.

## Customization

### Add Email Verification

In Firebase Console:
1. Go to **Authentication → Templates**
2. Customize the email verification template
3. In `auth-firebase.js`, after `createUserWithEmailAndPassword()`, add:
```javascript
await user.sendEmailVerification();
```

### Add Password Reset

In Firebase Console:
1. Go to **Authentication → Templates**
2. Customize the password reset template

In `login.html`, add a "Forgot Password" link that calls:
```javascript
const { sendPasswordResetEmail } = await import('...');
await sendPasswordResetEmail(auth, email);
```

### Store Orders in Firestore

To sync orders across devices:
1. Enable Firestore in Firebase Console
2. Add code to save/load orders from Firestore instead of `localStorage`

This requires more work but keeps order data secure and synced.

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

## Next: Protecting Order Data

The current setup lets users create accounts and sign in, but **orders remain public and local**. To make orders private and synced:

1. **Option A (Simple):** Don't change anything—orders are demo data
2. **Option B (Better):** Add code to save orders to Firestore when logged in, and load them on sign-in
3. **Option C (Advanced):** Build a backend API to validate orders and enforce ownership

For now, Option A is fine—your site is ready to let users create accounts!

## Support

For Firebase documentation, visit [firebase.google.com/docs/auth](https://firebase.google.com/docs/auth).

For issues, check [Firebase Console](https://console.firebase.google.com/) → your project → **Logs** or **Authentication**.

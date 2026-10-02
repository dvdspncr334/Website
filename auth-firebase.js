// Firebase Authentication Module
// Handles sign-in, sign-out, and session state

import { firebaseConfig } from './firebase-config.js';

// Initialize Firebase
let app, auth;
let authReady = false;

async function initializeFirebase() {
  if (authReady) return;
  
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js');
  const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
  
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  authReady = true;
}

export async function getSession() {
  await initializeFirebase();
  return new Promise((resolve) => {
    auth.onAuthStateChanged((user) => {
      if (user) {
        resolve({
          id: user.uid,
          email: user.email,
          name: user.displayName || 'User'
        });
      } else {
        resolve(null);
      }
    });
  });
}

export async function signInWithGoogle() {
  await initializeFirebase();
  const { GoogleAuthProvider, signInWithPopup } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
  
  const provider = new GoogleAuthProvider();
  try {
    const result = await signInWithPopup(auth, provider);
    return {
      id: result.user.uid,
      email: result.user.email,
      name: result.user.displayName
    };
  } catch (error) {
    console.error('Google sign-in error:', error);
    throw error;
  }
}

export async function signInWithEmail(email, password) {
  await initializeFirebase();
  const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
  
  try {
    const result = await signInWithEmailAndPassword(auth, email, password);
    return {
      id: result.user.uid,
      email: result.user.email,
      name: result.user.displayName || 'User'
    };
  } catch (error) {
    console.error('Email sign-in error:', error);
    throw error;
  }
}

export async function createAccountWithEmail(email, password) {
  await initializeFirebase();
  const { createUserWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js');
  
  try {
    const result = await createUserWithEmailAndPassword(auth, email, password);
    return {
      id: result.user.uid,
      email: result.user.email,
      name: result.user.displayName || 'User'
    };
  } catch (error) {
    console.error('Account creation error:', error);
    throw error;
  }
}

export async function signOut() {
  await initializeFirebase();
  try {
    await auth.signOut();
  } catch (error) {
    console.error('Sign-out error:', error);
    throw error;
  }
}

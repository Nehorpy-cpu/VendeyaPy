/**
 * Cliente Firebase para Next.js (browser).
 * Se inicializa una sola vez con el patrón singleton.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: process.env['NEXT_PUBLIC_FIREBASE_API_KEY'],
  authDomain: process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'],
  projectId: process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'],
  storageBucket: process.env['NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'],
  messagingSenderId: process.env['NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'],
  appId: process.env['NEXT_PUBLIC_FIREBASE_APP_ID'],
};

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

export function firebaseApp(): FirebaseApp {
  if (_app) return _app;
  _app = getApps()[0] ?? initializeApp(firebaseConfig);
  return _app;
}

export function firebaseAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(firebaseApp());
  if (process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true') {
    connectAuthEmulator(_auth, 'http://localhost:9099', { disableWarnings: true });
  }
  return _auth;
}

export function firebaseDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(firebaseApp());
  if (process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true') {
    connectFirestoreEmulator(_db, 'localhost', 8080);
  }
  return _db;
}

export function firebaseStorage(): FirebaseStorage {
  if (_storage) return _storage;
  _storage = getStorage(firebaseApp());
  if (process.env['NEXT_PUBLIC_USE_EMULATORS'] === 'true') {
    connectStorageEmulator(_storage, 'localhost', 9199);
  }
  return _storage;
}

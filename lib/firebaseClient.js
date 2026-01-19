// lib/firebaseClient.js
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;

export function initFirebaseClient() {
  if (typeof window === "undefined") return;

  if (!getApps().length) {
    firebaseApp = initializeApp({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
    });
  } else {
    // reuse existing app
    firebaseApp = getApps()[0];
  }

  if (!firebaseAuth) firebaseAuth = getAuth(firebaseApp);
  if (!firebaseDb) firebaseDb = getFirestore(firebaseApp);
}

export function getAuthInstance() {
  if (!firebaseAuth) initFirebaseClient();
  return firebaseAuth;
}

export function getDbInstance() {
  if (!firebaseDb) initFirebaseClient();
  return firebaseDb;
}

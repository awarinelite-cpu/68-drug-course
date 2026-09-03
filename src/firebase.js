import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: "AIzaSyBLEzC5MusezdNS8RnDQQA8xoI7XbXEqiM",
  authDomain: "gen-lang-client-0406053716.firebaseapp.com",
  projectId: "gen-lang-client-0406053716",
  storageBucket: "gen-lang-client-0406053716.firebasestorage.app",
  messagingSenderId: "922657172970",
  appId: "1:922657172970:web:f7a5c8f6ce8bb536d0d693"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline-first: reads/writes go through a local IndexedDB cache first. Entries
// made with no network queue locally and are marked with hasPendingWrites until
// they reach the server; the SDK flushes that queue automatically as soon as
// the connection comes back — no custom sync code needed. persistentMultipleTabManager
// lets more than one open tab/window share the same local cache safely.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// Used by the Messages page for chat image and voice-note uploads (chatUploads/{convoId}/...).
export const storage = getStorage(app);

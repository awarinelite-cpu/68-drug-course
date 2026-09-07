// Firestore's own persistence (src/firebase.js) already queues text messages,
// reactions, edits etc. made offline and syncs them automatically — no extra
// code needed there. Firebase STORAGE has no equivalent built-in offline
// queue, so image/voice-note uploads in ChatThread.jsx need one of their own.
// This module stores the raw Blob + message metadata in IndexedDB (not
// Firestore's cache, since a Blob doesn't round-trip through it) and flushes
// the queue on every 'online' event and on app start.

const DB_NAME = 'narhy-offline-uploads';
const STORE = 'pending';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// entry: { convoId, kind: 'image' | 'voice', blob, fileName, mimeType, replyTo, senderUid }
export async function enqueueUpload(entry) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const record = { id, createdAt: Date.now(), ...entry };
  await withStore('readwrite', (store) => store.put(record));
  return record;
}

export async function listQueuedUploads(convoId) {
  const all = await withStore('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
  const resolved = await all;
  return convoId ? resolved.filter((r) => r.convoId === convoId) : resolved;
}

export async function removeQueuedUpload(id) {
  return withStore('readwrite', (store) => store.delete(id));
}

let flushing = false;
let listenersBound = false;
const flushSubscribers = new Set();

// sender(record) must perform the actual upload + Firestore write and
// resolve/reject; the queue only handles storage, ordering, and retry timing.
export function bindOfflineUploadFlush(sender) {
  flushSubscribers.add(sender);
  if (listenersBound) return () => flushSubscribers.delete(sender);
  listenersBound = true;
  const tryFlush = () => flushQueuedUploads();
  window.addEventListener('online', tryFlush);
  // Also try shortly after load — 'online' doesn't fire if the tab was
  // never marked offline but the network only just became usable (e.g.
  // captive portal, weak signal that recovers).
  if (navigator.onLine) setTimeout(tryFlush, 1500);
  return () => flushSubscribers.delete(sender);
}

export async function flushQueuedUploads() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    const all = await listQueuedUploads();
    for (const record of all) {
      for (const sender of flushSubscribers) {
        try {
          await sender(record);
          await removeQueuedUpload(record.id);
          break;
        } catch (e) {
          // Leave it queued — will retry on the next 'online' event.
        }
      }
    }
  } finally {
    flushing = false;
  }
}

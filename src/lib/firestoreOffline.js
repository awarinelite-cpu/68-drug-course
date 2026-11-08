import { getDoc, getDocs, getDocFromCache, getDocsFromCache } from "firebase/firestore";

// getDoc()/getDocs() try the server first, and when there's no connection
// they can take a long time to give up and fall back to the local cache —
// sometimes appearing to just hang from the UI's point of view. Race the
// read against a short timeout and, if that fires or the
// read errors outright, read whatever's already in the persistent local
// cache instead. That keeps offline-first screens (patient banner, chart
// overview, etc.) from spinning on "Loading…" forever with no network.
const READ_TIMEOUT_MS = 8000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), READ_TIMEOUT_MS))
  ]);
}

// Drop-in replacement for getDoc(ref).
export async function getDocSafe(ref) {
  try {
    return await withTimeout(getDoc(ref));
  } catch (e) {
    try {
      return await getDocFromCache(ref);
    } catch (cacheErr) {
      throw e; // nothing cached either — surface the original (network) error
    }
  }
}

// Drop-in replacement for getDocs(collectionOrQuery).
export async function getDocsSafe(refOrQuery) {
  try {
    return await withTimeout(getDocs(refOrQuery));
  } catch (e) {
    try {
      return await getDocsFromCache(refOrQuery);
    } catch (cacheErr) {
      throw e;
    }
  }
}


// --- Cache-first reads --------------------------------------------------
// Every server read of a document costs one Firestore read. For a document
// that was fetched from the server within the last couple of minutes, the copy
// in the device's persistent cache is current enough (it also already holds this
// device's own saves), so serve that and skip the server. The stamp is kept in
// memory, so a fresh app open always starts with one real read.
const FRESH_MS = 2 * 60 * 1000;
const serverStamps = new Map();

export function wasFetchedRecently(ref, maxAgeMs = FRESH_MS) {
  const t = serverStamps.get(ref.path);
  return !!t && Date.now() - t < maxAgeMs;
}
export function markFetched(ref) { serverStamps.set(ref.path, Date.now()); }

// Drop-in replacement for getDocSafe(ref) that avoids a server read when the
// document was fetched less than maxAgeMs ago and is in the local cache.
export async function getDocCachedFirst(ref, maxAgeMs = FRESH_MS) {
  if (wasFetchedRecently(ref, maxAgeMs)) {
    try {
      const cached = await getDocFromCache(ref);
      if (cached.exists()) return cached;
    } catch (e) { /* not cached: fall through to the server */ }
  }
  const snap = await getDocSafe(ref);
  if (snap && snap.metadata && !snap.metadata.fromCache) markFetched(ref);
  return snap;
}

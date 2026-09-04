import { getDoc, getDocs, getDocFromCache, getDocsFromCache } from "firebase/firestore";

// getDoc()/getDocs() try the server first, and when there's no connection
// they can take a long time to give up and fall back to the local cache —
// sometimes appearing to just hang from the UI's point of view (see
// Messages.jsx's loadDirectory, which raced the same problem against a
// timeout). Race the read against a short timeout and, if that fires or the
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

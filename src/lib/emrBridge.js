// One-click EMR import bridge.
//
// The bookmarklet (public/emr-bookmarklet.html) runs on the hospital EMR page,
// reads the visible text, opens this app with ?emrimport=1 and posts the text
// here with window.postMessage. Nothing is sent to any server: the text goes
// straight from one browser tab to the other, into sessionStorage (cleared
// when the tab closes), and the existing parsers (patientParse.js) turn it
// into form fields for the nurse to review before anything is saved.

const PENDING_KEY = 'emrImport:pending'; // just arrived, not yet consumed by Home
const STASH_KEY = 'emrImport:stash';     // kept so the drug chart can prefill drugs
const MAX_LEN = 500000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const STASH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function readJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function installEmrBridge() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('emrimport') !== '1') return;

  // Drop the flag from the address bar so a reload doesn't re-arm the bridge.
  params.delete('emrimport');
  const qs = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);

  window.addEventListener('message', (e) => {
    // Only accept text from the window that opened us (the EMR tab).
    if (!window.opener || e.source !== window.opener) return;
    const d = e.data;
    if (!d || d.type !== 'emr-import-text' || typeof d.text !== 'string') return;
    const text = d.text.slice(0, MAX_LEN);
    if (!text.trim()) return;
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ text, at: Date.now() }));
    } catch (err) {
      return; // storage unavailable: don't ack, bookmarklet will keep retrying then give up
    }
    try { e.source.postMessage({ type: 'emr-import-ack' }, e.origin); } catch (err) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('emr-import-pending'));
  });
}

// Returns the freshly-arrived EMR text (once) or ''.
export function takePendingEmrImport() {
  const p = readJson(PENDING_KEY);
  try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
  if (!p || typeof p.text !== 'string' || Date.now() - p.at > PENDING_MAX_AGE_MS) return '';
  return p.text;
}

export function stashEmrText(text) {
  try {
    sessionStorage.setItem(STASH_KEY, JSON.stringify({ text, at: Date.now() }));
  } catch (e) { /* ignore */ }
}

export function readEmrStash() {
  const s = readJson(STASH_KEY);
  if (!s || typeof s.text !== 'string' || Date.now() - s.at > STASH_MAX_AGE_MS) return null;
  return s;
}

export function clearEmrStash() {
  try { sessionStorage.removeItem(STASH_KEY); } catch (e) { /* ignore */ }
}

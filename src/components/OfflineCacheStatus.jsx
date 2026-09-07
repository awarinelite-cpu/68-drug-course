import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "narhy-cache-status";

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveStored(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { /* private mode etc */ }
}

// Small fixed indicator so a nurse can always see, at a glance, whether the
// app has finished caching itself for offline use — not just whether *data*
// is offline-safe (OfflineBanner already covers that) but whether the app
// shell itself (the code needed to run at all) is fully cached yet.
export default function OfflineCacheStatus() {
  // phase: 'unsupported' | 'checking' | 'caching' | 'ready' | 'error'
  const [phase, setPhase] = useState(() => (
    'serviceWorker' in navigator ? (loadStored()?.phase === 'ready' ? 'ready' : 'checking') : 'unsupported'
  ));
  const [progress, setProgress] = useState({ cached: 0, total: 0 });
  const [expanded, setExpanded] = useState(true);
  const [readyAt, setReadyAt] = useState(() => loadStored()?.readyAt || null);
  const collapseTimer = useRef(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    function handleMessage(event) {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'PRECACHE_PROGRESS') {
        setPhase('caching');
        setProgress({ cached: msg.cached, total: msg.total });
      } else if (msg.type === 'PRECACHE_DONE') {
        const ok = msg.failed === 0 || msg.cached > 0;
        setPhase(ok ? 'ready' : 'error');
        setProgress({ cached: msg.cached, total: msg.total });
        if (ok) {
          const now = Date.now();
          setReadyAt(now);
          saveStored({ phase: 'ready', readyAt: now });
        }
      } else if (msg.type === 'PRECACHE_STATUS') {
        if (msg.ready) {
          const now = Date.now();
          setPhase('ready');
          setReadyAt((prev) => prev || now);
          saveStored({ phase: 'ready', readyAt: now });
        } else {
          // Worker exists but hasn't finished this version's cache yet —
          // an install is presumably already in flight; PRECACHE_PROGRESS
          // messages will arrive shortly and override this.
          setPhase((prev) => (prev === 'caching' ? prev : 'checking'));
        }
      }
    }

    navigator.serviceWorker.addEventListener('message', handleMessage);

    // Ask whatever worker is already controlling this tab for its status —
    // covers the common case of reopening the app in a later session, when
    // no fresh 'install' event (and therefore no PRECACHE_PROGRESS) fires.
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CHECK_CACHE_STATUS' });
    } else {
      navigator.serviceWorker.ready
        .then((reg) => reg.active && reg.active.postMessage({ type: 'CHECK_CACHE_STATUS' }))
        .catch(() => {});
    }

    return () => navigator.serviceWorker.removeEventListener('message', handleMessage);
  }, []);

  // Auto-collapse to a small dot a few seconds after settling into 'ready'
  // or 'error' — stays fully visible the whole time it's actively caching,
  // since that's the state a nurse most needs to see before going offline.
  useEffect(() => {
    clearTimeout(collapseTimer.current);
    if (phase === 'ready' || phase === 'error') {
      setExpanded(true);
      collapseTimer.current = setTimeout(() => setExpanded(false), 4000);
    } else if (phase === 'caching') {
      setExpanded(true);
    }
    return () => clearTimeout(collapseTimer.current);
  }, [phase]);

  if (phase === 'unsupported' || phase === 'checking') return null;

  const label =
    phase === 'caching' ? 'Caching for offline use…' + (progress.total ? ' ' + progress.cached + '/' + progress.total : '') :
    phase === 'ready' ? 'Ready for offline use' :
    "Couldn't fully cache for offline use";

  const dot = phase === 'caching' ? 'gnav-cache-dot-busy' : phase === 'ready' ? 'gnav-cache-dot-ok' : 'gnav-cache-dot-warn';

  return (
    <button
      type="button"
      className={"gnav-cache-status no-print" + (expanded ? " gnav-cache-expanded" : "")}
      onClick={() => setExpanded(true)}
      title={readyAt ? label + ' · last cached ' + new Date(readyAt).toLocaleString() : label}
    >
      <span className={"gnav-cache-dot " + dot} aria-hidden="true" />
      {expanded && <span className="gnav-cache-label">{label}</span>}
    </button>
  );
}

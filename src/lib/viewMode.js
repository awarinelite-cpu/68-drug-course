// Mobile / desktop layout switch. "Desktop mode" makes the phone lay the page
// out on a wide 1100px canvas (so all the desktop styles kick in, e.g. the
// wide report tables) and lets the user pinch-zoom; "mobile mode" is the
// normal phone layout. The choice is remembered on the device.
const KEY = 'wardcharts-view-mode';
const MOBILE_VIEWPORT = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
const DESKTOP_VIEWPORT = 'width=1100, minimum-scale=0.1, maximum-scale=5.0, user-scalable=yes';

export function getViewMode() {
  try { return localStorage.getItem(KEY) === 'desktop' ? 'desktop' : 'mobile'; } catch (e) { return 'mobile'; }
}

export function applyViewMode(mode = getViewMode()) {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', mode === 'desktop' ? DESKTOP_VIEWPORT : MOBILE_VIEWPORT);
  document.documentElement.setAttribute('data-view-mode', mode);
}

export function setViewMode(mode) {
  try { localStorage.setItem(KEY, mode); } catch (e) {}
  applyViewMode(mode);
  window.dispatchEvent(new CustomEvent('view-mode-change', { detail: mode }));
}

export function toggleViewMode() {
  const next = getViewMode() === 'desktop' ? 'mobile' : 'desktop';
  setViewMode(next);
  return next;
}

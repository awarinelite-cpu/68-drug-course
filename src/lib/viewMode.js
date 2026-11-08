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

// Readable text when a phone shows the wide desktop layout. In "desktop mode"
// (the app's own, or the browser's "Desktop site") a ~1000-1100px canvas is
// shrunk to fit a ~400px-wide phone, so text ends up at roughly 0.4x. The
// layout must stay the desktop one, so instead of changing the viewport we
// zoom the page content (CSS zoom keeps the canvas width and re-flows inside
// it). The zoom is worked out from how much the phone is shrinking the page,
// so it adapts to portrait/landscape and does nothing on a real desktop
// browser or in normal mobile mode. See html[data-phone-desktop] in styles.css.
const TARGET_APPARENT_SCALE = 0.55; // how big text should look vs. a full-size page
const MAX_ZOOM = 1.6;

export function applyTextScale() {
  const root = document.documentElement;
  const deviceW = window.screen && window.screen.width ? window.screen.width : 0;
  const pageW = window.innerWidth || 0;
  const isSmallDevice = deviceW > 0 && Math.min(window.screen.width, window.screen.height) <= 600;
  const shrink = deviceW && pageW ? deviceW / pageW : 1; // <1 means the page is being shrunk to fit
  if (isSmallDevice && pageW >= 900 && shrink < TARGET_APPARENT_SCALE) {
    const zoom = Math.min(MAX_ZOOM, TARGET_APPARENT_SCALE / shrink);
    root.style.setProperty('--phone-desktop-zoom', zoom.toFixed(2));
    root.setAttribute('data-phone-desktop', '');
  } else {
    root.style.removeProperty('--phone-desktop-zoom');
    root.removeAttribute('data-phone-desktop');
  }
}

let textScaleBound = false;
export function initTextScale() {
  applyTextScale();
  if (textScaleBound) return;
  textScaleBound = true;
  window.addEventListener('resize', applyTextScale);
  window.addEventListener('orientationchange', applyTextScale);
  window.addEventListener('view-mode-change', () => setTimeout(applyTextScale, 150));
}

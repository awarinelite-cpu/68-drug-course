// App-shell offline cache. This does NOT cache Firestore/Auth traffic — that's
// handled by Firestore's own IndexedDB persistence (see src/firebase.js), which
// queues writes made while offline and syncs them automatically on reconnect.
// This service worker's other job is background FCM push messages (drug-due
// alerts, see src/lib/push.js) — that's the compat-SDK block below. Kept in
// this same file, rather than a separate firebase-messaging-sw.js, so there's
// only one service worker registered for the whole site.

// Self-hosted rather than pulled from gstatic.com: importScripts() runs at
// service worker evaluation time, so if that fetch fails (spotty ward wifi, a
// network that blocks Google CDN domains, an ad/content blocker) the whole
// worker fails to install with a bare "ServiceWorker script evaluation
// failed" and push/offline support silently breaks. Bundling these locally
// removes that external dependency entirely.
importScripts('/vendor/firebase/firebase-app-compat.js');
importScripts('/vendor/firebase/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBLEzC5MusezdNS8RnDQQA8xoI7XbXEqiM",
  authDomain: "gen-lang-client-0406053716.firebaseapp.com",
  projectId: "gen-lang-client-0406053716",
  storageBucket: "gen-lang-client-0406053716.firebasestorage.app",
  messagingSenderId: "922657172970",
  appId: "1:922657172970:web:f7a5c8f6ce8bb536d0d693"
});

// Written without optional chaining (?.) or other very-recent syntax on
// purpose: this whole file has to be parsed successfully before ANY of it
// runs, on ANY browser that loads it, or the entire service worker fails
// evaluation with an unhelpful generic error — an ordinary try/catch can't
// protect against that since it's a parse-time failure, not a runtime one.
try {
  firebase.messaging().onBackgroundMessage(function (payload) {
    var n = payload.notification || {};
    var d = payload.data || {};
    var title = n.title || 'Drug due';
    var body = n.body || '';
    var link = d.link || '/';
    self.registration.showNotification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { link: link },
      tag: d.tag || undefined, // same tag replaces an older, now-stale alert instead of stacking
      // Browsers/OSes don't let a background service worker play a custom
      // sound — only the app's own foreground tab can (see src/lib/push.js),
      // which covers the phone-in-hand case. For phone-locked/app-closed,
      // requireInteraction keeps the notification pinned and vibrate gives a
      // distinct, longer buzz than a default notification's single blip.
      // Both are still silenced by phone-level silent/DND settings.
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400, 200, 400]
    });
  });
} catch (e) {
  console.warn('Background push messaging unavailable on this device/browser:', e);
}

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var link = data.link || '/';
  event.waitUntil(clients.openWindow(link));
});

const CACHE_NAME = 'narhy-app-shell-v5';
const PRECACHE_URLS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Firebase/Firestore/CDN traffic go straight to the network

  // Navigations (route changes in the SPA) always fall back to the cached
  // index.html shell when offline, so client-side routing keeps working.
  const isNavigation = req.mode === 'navigate';

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || (isNavigation ? caches.match('/index.html') : undefined)))
  );
});

// Minimal service worker - exists mainly to satisfy PWA installability
// requirements (Chrome/Android won't offer "Add to Home Screen" without
// one registered). Deliberately does NOT cache API responses - machine
// and log data needs to always be fresh, not served stale from a cache.
// Only the static app shell (HTML/CSS/JS/icons) gets cached, so the app
// can at least load its interface if opened briefly offline.

const CACHE_NAME = 'cmms-shell-v3';
// The HTML page itself is deliberately NOT cached: it is generated per
// organization (each org's manifest and icon are injected into it), so a
// cached copy could hand one organization's install details to another.
const SHELL_FILES = [
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/favicon-64.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept API calls - always go to the network for real data.
  if (url.pathname.startsWith('/api/')) return;
  // Pages always come from the network (see the note on SHELL_FILES).
  if (event.request.mode === 'navigate') return;
  if (event.request.method !== 'GET') return;
  // Network first, cache as the offline fallback. (Cache-first would keep
  // serving an old app.js/style.css to installed apps after every deploy.)
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});

// Minimal service worker - exists mainly to satisfy PWA installability
// requirements (Chrome/Android won't offer "Add to Home Screen" without
// one registered). Deliberately does NOT cache API responses - machine
// and log data needs to always be fresh, not served stale from a cache.
// Only the static app shell (HTML/CSS/JS/icons) gets cached, so the app
// can at least load its interface if opened briefly offline.

const CACHE_NAME = 'cmms-shell-v2';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
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
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

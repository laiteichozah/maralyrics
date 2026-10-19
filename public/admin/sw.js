// ┌───────────────────────────────────────────────┐
// │   MaraLyrics — Admin Dashboard Service Worker  │
// └───────────────────────────────────────────────┘
// Scoped to /admin/ only (registered with scope: '/admin/' — see offline-sync.js).
// Separate from the public site's public/sw.js, which explicitly skips /admin paths.
//
// This SW's only job is app-shell availability: cache the dashboard's own HTML/CSS/JS
// so it still loads after a full close/reopen with no network. All actual admin DATA
// (songs, articles, reference lists, the offline write queue) lives in IndexedDB via
// offline-db.js/offline-sync.js, not in this cache — so API requests are left alone here.
//
// Bump CACHE_VERSION whenever a precached file's content changes, so returning admins
// pick up the new version instead of a stale cached copy.
const CACHE_VERSION = 'ml-admin-v17';
const SHELL_ASSETS = [
  './',
  './index.html',
  './index.css',
  './style.css',
  './index.js',
  './loader.js',
  './offline-db.js',
  './offline-sync.js',
  './manifest.json',
  './icon.svg',
  '/toast.js',
  '/social-icons.js',
  '/rich-text.js',
];

self.addEventListener('install', (event) => {
  // No blanket .catch() here (unlike an earlier version of this file): cache.addAll() is
  // atomic — if any one of SHELL_ASSETS fails to fetch, swallowing that error would leave
  // the cache completely empty while still calling skipWaiting() as if install succeeded,
  // silently defeating offline support with no visible symptom until an admin actually
  // needs it. Letting the rejection propagate fails the install instead, so the browser
  // retries on the next registration attempt (matches public/sw.js's own precache step).
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only ever handle same-origin GETs for the dashboard's own shell files — never
  // touch cross-origin requests (the api.maralyrics.com worker) or any non-GET verb,
  // so writes/reads of live data always go straight to the network untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Navigations (the dashboard page itself): network-first so admins always get the
  // latest shell when online, falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only cache a genuinely successful response — an error page (a Worker 5xx, a
          // misconfigured route) must never become the offline fallback shell.
          if (res && res.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static shell assets: cache-first, refreshing the cache in the background on a hit
  // and populating it on a miss — keeps the dashboard usable offline after first load.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE_VERSION).then((cache) => cache.put(req, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

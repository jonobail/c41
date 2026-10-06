// C41 service worker — versioned app-shell precache, cache-first, offline navigation fallback.
// Bump CACHE_VERSION whenever any shell file changes so clients pick up the update.
const CACHE_VERSION = 'c41-v6';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/ui.js',
  'js/film-transform.js',
  'js/films.js',
  'js/films-calibrated.js',
  'js/cameras.js',
  'js/renderer.js',
  'js/maps.js',
  'js/overlays.js',
  'js/exif.js',
  'js/exporter.js',
  'js/jpeg-worker.js',
  'js/looks.js',
  'js/look-match.js',
  'js/match-worker.js',
  'js/match-stats.js',
  'assets/baseline-pool.bin',
  'icons/favicon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Add individually so one missing file doesn't abort the whole install.
    await Promise.all(SHELL.map(async (path) => {
      try {
        const res = await fetch(new Request(path, { cache: 'reload' }));
        if (res.ok) await cache.put(path, res);
      } catch { /* offline during install — will be runtime-cached later */ }
    }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('c41-') && k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req, { ignoreSearch: true }) || await cache.match('index.html') || await cache.match('./');
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#0b0a09;color:#eee;font-family:system-ui;padding:24px">C41 is offline and not cached yet.</body>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

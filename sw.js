/* Service worker: makes the app work offline and auto-update.
   Strategy: network-first (always fetch the latest when online, so your
   pushes appear immediately), falling back to cache when offline.
   User data lives in localStorage/IndexedDB and is never touched here. */
const CACHE = 'gemstone-cache-v1';
const CORE = ['./', 'index.html', 'gemstone-tracker.html', 'manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('gemstone-tracker.html')))
  );
});

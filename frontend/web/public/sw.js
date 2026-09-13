/* BitriPay service worker: caches the app shell and the last state so the app opens offline ("last synced …"),
 * never caches money-moving API responses, and syncs queued offline promises when the network is back. */
const VERSION = 'bitripay-shell-v1';
const SHELL = ['/', '/app', '/manifest.webmanifest', '/favicon.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
const READ_ONLY_API = /^\/api\/(config|auth\/me|wallets(\?.*)?|account\/notifications|v1\/offline\/settings|v1\/diaspora\/rate-cards|v1\/keys)/;
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return; // money-moving requests are never served from cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
    if (!READ_ONLY_API.test(url.pathname + url.search)) return;
    // network first, fall back to the last known state
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then(
              (hit) => hit || new Response(JSON.stringify({ error: { code: 'offline', bp: 'BP-4000', message: 'You are offline' } }), { status: 503, headers: { 'content-type': 'application/json' } }),
            ),
        ),
    );
    return;
  }
  // app shell and static assets: cache first, refresh in the background
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetching = fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    }),
  );
});
self.addEventListener('sync', (event) => {
  if (event.tag === 'offline-promises') event.waitUntil(self.clients.matchAll().then((clients) => clients.forEach((c) => c.postMessage({ type: 'sync-offline-promises' }))));
});
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

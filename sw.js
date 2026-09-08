const CACHE = 'still-camera-v5';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch('./app-assets.json', { cache: 'reload' });
    if (!response.ok) throw new Error('The current app file list could not be loaded.');
    const { assets } = await response.json();
    const cache = await caches.open(CACHE);
    await cache.addAll([...assets, './app-assets.json'].map(path => new Request(path, { cache: 'reload' })));
    // Activate fresh assets without reloading open pages or interrupting their camera work.
    await self.skipWaiting();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (/^still-camera-v\d+$/.test(key) && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (['refresh.html', 'refresh.js'].some(file => url.pathname === new URL(file, self.registration.scope).pathname)) {
    event.respondWith(fetch(event.request, { cache: 'reload' }));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    return fetch(event.request);
  })());
});

const CACHE = 'mugi-mobile-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('mugi-mobile-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
// API, identity and HTML responses are never cached. Static files are cached only after successful authenticated loads.
self.addEventListener('fetch', event => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !/^\/(assets\/|icon-|apple-touch-icon|favicon-)/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && !response.redirected && !response.headers.get('Content-Type')?.includes('text/html')) { const cache = await caches.open(CACHE); await cache.put(request, response.clone()); }
    return response;
  })());
});

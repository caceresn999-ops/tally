const CACHE = 'tally-892c2303e1';
const scoped = path => new URL(path, self.registration.scope).href;
const INDEX = scoped('./index.html');
const HOME = scoped('./');
const SHELL = new Set([
  './index.html', './shim.js', './manifest.webmanifest', './apple-touch-icon.png',
  './icons/tally-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/favicon-32.png', './icons/favicon.svg'
].map(scoped));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...SHELL].map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('tally-') && name !== CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.origin + url.pathname;
  const page = path === HOME || path === INDEX;
  if (!page && !SHELL.has(path)) return;
  if (page) {
    const network = fetch(request, { cache: 'no-store' }).then(
      response => response.ok ? response : null,
      () => null
    );
    event.waitUntil(network.then(async response => {
      if (response) {
        const copy = response.clone();
        const cache = await caches.open(CACHE);
        await cache.put(INDEX, copy);
      }
    }).catch(() => {}));

    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); });
    event.respondWith((async () => {
      const response = await Promise.race([network, timeout]);
      clearTimeout(timer);
      if (response) return response;
      const cache = await caches.open(CACHE);
      const cached = await cache.match(INDEX);
      return cached || (await network) || Response.error();
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(path);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) await cache.put(path, response.clone());
    return response;
  })());
});

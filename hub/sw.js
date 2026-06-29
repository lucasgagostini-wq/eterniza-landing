// Service worker do Delivery Hub — Eterniza (escopo /hub/).
// Network-first nos estáticos (sempre pega a versão nova), nunca toca em /api.
const CACHE = 'eterniza-hub-v3';
const ASSETS = ['/hub/', '/hub/index.html', '/hub/hub.css', '/hub/hub.js', '/hub/manifest.json', '/hub/icon-192.png', '/hub/icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;          // nunca cacheia escrita
  if (url.pathname.startsWith('/api/')) return;      // API sempre na rede
  e.respondWith(
    fetch(e.request)
      .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request))
  );
});

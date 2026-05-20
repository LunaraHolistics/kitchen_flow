// Cache de assets estáticos para offline
const CACHE_NAME = 'kitchen-flow-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/fazenda.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  // Estratégia: Network first, fallback para cache
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
/* SVB Seguridad — Service Worker: el panel abre aunque se corte internet o el servidor. */
const CACHE = 'svb-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/rave-logo.jpg', './assets/icon-192.png', './assets/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API y video siempre en vivo
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || url.pathname.includes('/go2rtc/')) return;
  // Red primero (para recibir actualizaciones), caché si no hay conexión
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && url.origin === location.origin) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
  );
});

// YT-Music Vault Service Worker (Network-First to always serve latest code)
const CACHE_NAME = 'ytmusic-vault-v4';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Always fetch fresh from network
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

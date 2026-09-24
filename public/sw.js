'use strict';

// Cache only version-tolerant static shell assets. HTML and API traffic stay
// network-first so a newly deployed GHCR image is never hidden behind stale UI.
const CACHE = 'aioplay-shell-v1';
const SHELL = [
  '/aioplay-brand.webp',
  '/aioplay-launcher.webp',
  '/assets/aioplay-movie-play-orb.webp'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('aioplay-shell-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache pages, API responses, stream/download traffic, or generated art.
  if (req.mode === 'navigate' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/img')) return;

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(req, response.clone()));
        return response;
      }))
    );
  }
});

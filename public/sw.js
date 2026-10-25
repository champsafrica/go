// Minimal service worker so Go Rides can be installed to the home screen. Pages are
// always fetched live because trip details change; only static files are cached.
const CACHE = 'go-rides-v3';
const STATIC = ['/styles.css', '/app.js', '/favicon.svg', '/brand/go-rides-logo.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !STATIC.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

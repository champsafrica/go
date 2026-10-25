// Go Rides service worker. Pages always load live because ride details change; the app
// shell (styles, script, fonts, logo, illustrations) is cached so the app opens fast, and
// an offline screen shows when there is no connection.
const CACHE = 'go-rides-v6';
const SHELL = [
  '/offline.html', '/styles.css', '/app.js', '/favicon.svg', '/brand/go-rides-logo.png', '/brand/icon-192.png',
  '/fonts/poppins-latin-400-normal.woff2', '/fonts/poppins-latin-500-normal.woff2', '/fonts/poppins-latin-600-normal.woff2',
  '/fonts/poppins-latin-700-normal.woff2', '/fonts/poppins-latin-800-normal.woff2'
];
const isStatic = path => SHELL.includes(path) || path.startsWith('/illustrations/') || path.startsWith('/brand/');

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
  } else if (isStatic(url.pathname)) {
    // Network first so updates show at once; the cache is the fallback when offline.
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
  }
});

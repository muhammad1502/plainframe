// Caches the app on install so it opens with no connection, and receives photos shared from other apps (Android).
const VERSION = 'plainframe-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'theme-init.js',
  'js/app.js',
  'js/meta.js',
  'js/clean.js',
  'js/zip.js',
  'manifest.webmanifest',
  'icons/favicon.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'plainframe-shared').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  if (e.request.method === 'POST' && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;

  // Cache first: the app never needs the network once installed.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(
      (hit) => hit || fetch(e.request).catch(() => caches.match('index.html')),
    ),
  );
});

async function receiveShare(request) {
  const scope = self.registration.scope;
  try {
    const form = await request.formData();
    const cache = await caches.open('plainframe-shared');
    let i = 0;
    for (const file of form.getAll('photos')) {
      if (!(file instanceof File)) continue;
      await cache.put(
        new Request(`${scope}__shared/${Date.now()}-${i++}`),
        new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name) } }),
      );
    }
  } catch {}
  return Response.redirect(`${scope}?shared=1`, 303);
}

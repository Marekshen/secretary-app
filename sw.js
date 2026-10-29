const CACHE = 'secretary-v10';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192-v2.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  const d = e.data ? e.data.json() : {};
  if (d.badge && self.navigator.setAppBadge) self.navigator.setAppBadge(d.badge).catch(() => {});
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || '秘書', { body: d.body || '', icon: 'icon-192-v2.png', data: { url: d.url || './' } }),
    self.clients.matchAll({ type: 'window' }).then((list) => list.forEach((c) => c.postMessage('new-message'))),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(e.notification.data.url);
  }));
});

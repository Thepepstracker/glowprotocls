// Glow Admin phone app (Jonah, 14 Nov 2026). Only shows new-order alerts and opens the order when tapped.
// It never caches pages, so the dashboard is always the live one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = {title: 'New order', body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(m.title || 'New order', {
    body: m.body || '', tag: m.tag || undefined, renotify: true, icon: '/img/admin-app-192.png', badge: '/img/admin-app-192.png',
    data: {url: m.url || '/store-next/admin'}
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/store-next/admin', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) { if (c.url.includes('/store-next/admin') && 'focus' in c) { await c.focus(); if ('navigate' in c) return c.navigate(url); return; } }
    return self.clients.openWindow(url);
  })());
});

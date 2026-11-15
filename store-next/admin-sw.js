// Glow Admin phone app (Jonah, 14 Nov 2026). New-order alerts, the red number on the app icon, a heads-up to the open app
// (it plays the Glow bell and refreshes Today), and a friendly screen when there is no signal. Pages are never cached,
// so the dashboard is always the live one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = {title: 'New order', body: e.data ? e.data.text() : ''}; }
  e.waitUntil((async () => {
    if (Number.isInteger(m.badge) && self.navigator && 'setAppBadge' in self.navigator) { try { m.badge > 0 ? await self.navigator.setAppBadge(m.badge) : await self.navigator.clearAppBadge(); } catch {} }
    const open = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of open) c.postMessage({type: 'glow-order', ...m});
    await self.registration.showNotification(m.title || 'New order', {
      body: m.body || '', tag: m.tag || undefined, renotify: true, icon: '/img/admin-app-192.png', badge: '/img/admin-app-192.png',
      data: {url: m.url || '/store-next/admin'}
    });
  })());
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
// No signal: show a simple page with a Try again button instead of the browser's error.
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Glow Admin</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf7f2;font:17px -apple-system,system-ui,sans-serif;color:#1b1b1b;text-align:center}img{width:84px;height:84px;border-radius:20px;margin-bottom:18px}h1{font-size:22px;margin:0 0 8px}p{color:#6b6457;margin:0 0 22px;padding:0 30px}button{background:#141414;color:#fff;border:0;border-radius:12px;padding:14px 26px;font:600 16px system-ui}</style><div><img src="/img/admin-app-192.png" alt=""><h1>No connection</h1><p>Glow Admin needs the internet. Check your Wi-Fi or signal.</p><button onclick="location.reload()">Try again</button></div>';
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});

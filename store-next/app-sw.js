// Glow Lab customer app (Jonah, 14 Nov 2026: "now lets make one for everyone"). Shows order and deal alerts the customer
// turned on, opens the right page when tapped, and shows a friendly screen with no signal. Nothing is cached, so the
// store, prices and stock are always live.
// Zader Health app (Jonah, 19 Nov 2026: "make the app for zader health just like glow lab"): the same worker on
// zaderhealth.com uses Zader's name, icon and colours.
const ZADER = /(^|\.)zaderhealth\.com$|^zader\.localhost$/.test(self.location.hostname);
const APP = ZADER ? {name: 'Zader Health', icon: '/img/zader/app/zader-app-192.png', bg: '#031628', fg: '#ffffff', sub: '#9fc3d6', btn: '#03b9d5', btnText: '#031628'} : {name: 'Glow Lab', icon: '/img/store-app-192.png', bg: '#faf7f2', fg: '#1b1b1b', sub: '#6b6457', btn: '#141414', btnText: '#fff'};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = {title: APP.name, body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(m.title || APP.name, {body: m.body || '', tag: m.tag || undefined, icon: APP.icon, badge: APP.icon, data: {url: m.url || '/store-next/'}}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/store-next/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) { if (!c.url.includes('/store-next/admin') && 'focus' in c) { await c.focus(); if ('navigate' in c) return c.navigate(url); return; } }
    return self.clients.openWindow(url);
  })());
});
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+APP.name+'</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:'+APP.bg+';font:17px -apple-system,system-ui,sans-serif;color:'+APP.fg+';text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:'+APP.sub+';margin:0 0 22px;padding:0 30px}button{background:'+APP.btn+';color:'+APP.btnText+';border:0;border-radius:12px;padding:14px 26px;font:600 16px system-ui}</style><div><h1>No connection</h1><p>The '+APP.name+' app needs the internet. Check your Wi-Fi or signal.</p><button onclick="location.reload()">Try again</button></div>';
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate' || new URL(e.request.url).pathname.startsWith('/store-next/admin')) return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});

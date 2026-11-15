'use strict';
// New-order alerts on the phone for the Management home-screen app (Jonah, 14 Nov 2026: "lets make an app for me and my mom
// that mimics the admin dashboard"). Standard Web Push (RFC 8030 / 8291 aes128gcm / 8292 VAPID), no outside service and
// no extra package. The VAPID key pair is made once and kept in the store database (integrations/webpush-keys).
// Staff turn alerts on in Management → Today; each phone's subscription is kept in push_subs. The watcher (start) checks
// for new orders every 20 seconds with the same rules as the Order Bell and sends one alert per order.
const crypto = require('node:crypto');
const {transaction} = require('./store-db.cjs');
const now = () => Math.floor(Date.now() / 1000);
const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(String(s || ''), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');

async function keys(s) {
  let k = await s.get('integrations', 'webpush-keys');
  if (k?.public && k?.private_jwk) return k;
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'});
  k = {id: 'webpush-keys', public: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), private_jwk: privateKey.export({format: 'jwk'}), created: now()};
  await s.put('integrations', 'webpush-keys', k);
  return k;
}

// RFC 8291: encrypt the message for one browser subscription (p256dh + auth from the subscription).
function encrypt(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error('Bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(), secret = ecdh.computeSecret(uaPublic), salt = crypto.randomBytes(16);
  const ikm = hmac(hmac(authSecret, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([65]), asPublic, body]);
}

// RFC 8292: the signed "this is us" token the push service checks.
function vapid(endpoint, k) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({typ: 'JWT', alg: 'ES256'})), claims = b64u(JSON.stringify({aud, exp: now() + 12 * 3600, sub: 'mailto:support@glowglps.com'}));
  const key = crypto.createPrivateKey({key: k.private_jwk, format: 'jwk'});
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), {key, dsaEncoding: 'ieee-p1363'});
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${k.public}`;
}

const okEndpoint = e => { try { const u = new URL(e); return u.protocol === 'https:' && e.length <= 1000; } catch { return false; } };

async function send(sub, message, k, fetchImpl = fetch) {
  const r = await fetchImpl(sub.endpoint, {method: 'POST', signal: AbortSignal.timeout(10000), headers: {TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapid(sub.endpoint, k)}, body: encrypt(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth)});
  return r.status;
}

// Sends to every saved phone. Phones the push service says are gone (404/410) are removed.
async function sendAll(message, fetchImpl = fetch) { return sendTo('push_subs', null, message, fetchImpl); }
async function sendTo(col, pick, message, fetchImpl = fetch) {
  const {subs, k} = await transaction(async s => ({subs: (await s.list(col)).filter(x => !pick || pick(x)), k: await keys(s)}));
  const gone = [], results = [];
  for (const sub of subs) {
    try { const st = await send(sub, message, k, fetchImpl); results.push(st); if (st === 404 || st === 410) gone.push(sub.id); }
    catch (e) { results.push('error'); }
  }
  if (gone.length) await transaction(async s => { for (const id of gone) await s.remove(col, id); });
  return {sent: results.filter(x => x === 201 || x === 200).length, tried: subs.length, removed: gone.length};
}

const money = c => '$' + (Math.round(c || 0) / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const word = (v, n = 30) => String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, n);
const etDay = t => new Date(t * 1000).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
// Same orders the Order Bell rings for: live, not canceled or expired, and not a Zelle/Venmo/Cash App checkout that was never submitted.
const counts = o => o.is_test === false && !['canceled', 'expired'].includes(o.status) && !(o.proof_required && !o.submitted_at && o.status === 'order_received');
function alertFor(o, dayTotal, toPack = 0) {
  const total = o.total || 0, items = (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0);
  const label = total >= 25000 ? 'BIG ORDER' : total >= 10000 ? 'NICE ORDER' : 'NEW ORDER';
  const first = word(String(o.customer?.name || '').split(/\s+/)[0]) || 'Someone';
  return {title: `${label} ${money(total)}${o.brand && o.brand !== 'glow' ? ' · ' + word(o.brand, 12) : ''}`,
    body: `${first}${o.customer?.state ? ' · ' + word(o.customer.state, 20) : ''} · ${items} item${items === 1 ? '' : 's'}\n${money(dayTotal)} so far today`,
    url: '/store-next/admin?order=' + encodeURIComponent(o.id), tag: o.id, badge: toPack, order: o.id, total};
}

// One pass: finds orders not alerted yet. The first pass only remembers what is already there (no flood of old alerts).
async function tick(fetchImpl = fetch) {
  const due = await transaction(async s => {
    const subs = await s.list('push_subs'); if (!subs.length) return [];
    const st = await s.get('integrations', 'webpush-feed') || {id: 'webpush-feed', seen: []};
    const live = (await (s.listLite ? s.listLite('orders') : s.list('orders'))).filter(counts);
    const today = etDay(now()), dayTotal = live.filter(o => etDay(o.created || 0) === today).reduce((n, o) => n + (o.total || 0), 0), toPack = live.filter(o => o.status === 'paid').length;
    const recent = live.filter(o => (o.created || 0) > now() - 2 * 86400).sort((a, b) => (a.created || 0) - (b.created || 0));
    const seen = new Set(st.seen || []);
    const fresh = st.init ? recent.filter(o => !seen.has(o.id)) : [];
    st.init = true; st.seen = [...seen, ...recent.map(o => o.id).filter(id => !seen.has(id))].slice(-400); st.checked = now();
    await s.put('integrations', 'webpush-feed', st);
    return fresh.map(o => alertFor(o, dayTotal, toPack));
  });
  for (const m of due) await sendAll(m, fetchImpl);
  return due.length;
}

// ===== Glow Lab customer app (Jonah, 14 Nov 2026: "now lets make one for everyone"). Customers who turn alerts on in the
// app's Account page get: payment received (+ points earned), shipped, out for delivery, delivered. Separately they can
// choose "Deals & live shows", which Management sends by hand. Phones live in cust_push_subs; what each order already
// announced lives in one record, integrations/cust-push-state (orders of the last 45 days). Orders from before the phone
// was set up only have their current step remembered, so nothing old is sent. Glow orders only. Checked once a minute.
const STAGES = [
  ['paid', o => ['paid', 'shipped'].includes(o.status), o => ({title: 'Payment received 💛', body: `Order ${o.id} is paid and in line to ship.${o.points_earned > 0 ? ` You earned ${o.points_earned} Glow Points.` : ''}`})],
  ['shipped', o => o.status === 'shipped', o => ({title: 'Your order is on its way 📦', body: `Order ${o.id} has shipped. Tap to see tracking in your account.`})],
  ['out', o => o.delivery?.state === 'out_for_delivery' || o.delivery?.delivered === true, o => ({title: 'Out for delivery today 🚚', body: `Order ${o.id} is on the truck and should arrive today.`})],
  ['delivered', o => o.delivery?.delivered === true, o => ({title: 'Delivered ✨', body: `Order ${o.id} was delivered. Enjoy!`})]
];
async function customerTick(fetchImpl = fetch) {
  const due = await transaction(async s => {
    const subs = (await s.list('cust_push_subs')).filter(x => x.orders !== false && x.customer_id); if (!subs.length) return [];
    // When each customer's first phone was set up: orders made after that, or in the last 30 minutes, are "new" and get
    // every step (a subscription charge or a card checkout can be paid within seconds of being made).
    const since = now() - 45 * 86400, fresh = now() - 1800, joined = new Map();
    for (const x of subs) joined.set(x.customer_id, Math.min(joined.get(x.customer_id) ?? Infinity, x.created || 0));
    const rec = await s.get('integrations', 'cust-push-state') || {id: 'cust-push-state', orders: {}}, out = [], keep = {};
    for (const o of (await (s.listLite ? s.listLite('orders') : s.list('orders')))) {
      if (o.is_test !== false || !joined.has(o.customer_id) || (o.created || 0) < since || ['canceled', 'expired'].includes(o.status) || (o.brand || 'glow') !== 'glow') continue;
      const reached = STAGES.filter(([, test]) => test(o)).map(([k]) => k);
      let sent = rec.orders[o.id];
      if (!sent) sent = (o.created || 0) >= Math.min(joined.get(o.customer_id), fresh) ? [] : reached;
      const add = reached.filter(k => !sent.includes(k));
      keep[o.id] = [...sent, ...add];
      if (!add.length) continue;
      // Several steps at once (e.g. shipped and delivered between checks): only the latest is sent.
      const [k, , msg] = STAGES.filter(([key]) => add.includes(key)).pop();
      out.push({customer: o.customer_id, m: {...msg(o), url: '/store-next/account', tag: o.id + ':' + k}});
    }
    rec.orders = keep; rec.checked = now(); await s.put('integrations', 'cust-push-state', rec);
    return out;
  });
  for (const d of due) await sendTo('cust_push_subs', x => x.customer_id === d.customer && x.orders !== false, d.m, fetchImpl);
  return due.length;
}
async function customerRoute(path, body, h) {
  const accounts = require('./customer-accounts.cjs');
  if (path === '/account/push/key') return transaction(async s => ({public: (await keys(s)).public}));
  const sub = body?.subscription || {}, e = String(sub.endpoint || body?.endpoint || '');
  if (path === '/account/push/subscribe') {
    if (!okEndpoint(e) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) throw Object.assign(new Error('This phone could not be set up for alerts.'), {status: 400});
    const id = hash(e).slice(0, 40);
    return transaction(async s => {
      const a = await accounts.session(s, h, true);
      await s.put('cust_push_subs', id, {id, endpoint: e, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}, customer_id: a.id, orders: body.orders !== false, deals: body.deals === true, created: now()});
      return {ok: true, orders: body.orders !== false, deals: body.deals === true};
    });
  }
  if (path === '/account/push/status') return transaction(async s => { const x = okEndpoint(e) && await s.get('cust_push_subs', hash(e).slice(0, 40)); return x ? {on: true, orders: x.orders !== false, deals: !!x.deals} : {on: false}; });
  if (path === '/account/push/unsubscribe') { await transaction(async s => s.remove('cust_push_subs', hash(e).slice(0, 40))); return {ok: true}; }
  return null;
}
// Management: a deal or live-show alert to every customer who chose "Deals & live shows".
async function broadcast(body) {
  const title = String(body?.title || '').trim().slice(0, 60), text = String(body?.body || '').trim().slice(0, 160);
  if (!title || !text) throw Object.assign(new Error('Write a title and a message.'), {status: 400});
  const url = /^\/store-next\/[\w\-./?=&#]*$/.test(String(body?.url || '')) ? body.url : '/store-next/';
  return sendTo('cust_push_subs', x => x.deals === true, {title, body: text, url, tag: 'deal-' + now()});
}

let timer = null, busy = false, lastCustomer = 0;
function start(ms = 20000) {
  if (timer) return timer;
  timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { console.error('web-push tick', e.message); } if (Date.now() - lastCustomer >= 55000) { lastCustomer = Date.now(); try { await customerTick(); } catch (e) { console.error('web-push customers', e.message); } } busy = false; }, ms);
  if (timer.unref) timer.unref();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

// Management routes (the caller has already checked the staff session).
async function route(path, body, who) {
  if (path === '/admin/push/key') return transaction(async s => ({public: (await keys(s)).public}));
  if (path === '/admin/push/subscribe') {
    const sub = body?.subscription || {}, e = String(sub.endpoint || '');
    if (!okEndpoint(e) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) throw Object.assign(new Error('This phone could not be set up for alerts.'), {status: 400});
    const id = hash(e).slice(0, 40);
    await transaction(async s => s.put('push_subs', id, {id, endpoint: e, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}, by: who || 'owner', device: String(body.device || '').slice(0, 60), created: now()}));
    return {ok: true, id};
  }
  if (path === '/admin/push/unsubscribe') { const id = hash(String(body?.endpoint || '')).slice(0, 40); await transaction(async s => s.remove('push_subs', id)); return {ok: true}; }
  if (path === '/admin/push/test') return sendAll({title: 'Order alerts are on', body: 'You will get one of these for every new order.', url: '/store-next/admin', tag: 'test'});
  if (path === '/admin/push/status') return transaction(async s => ({phones: (await s.list('push_subs')).map(x => ({by: x.by, device: x.device, created: x.created}))}));
  if (path === '/admin/push/customers') return transaction(async s => { const c = await s.list('cust_push_subs'); return {phones: c.length, orders: c.filter(x => x.orders !== false).length, deals: c.filter(x => x.deals).length}; });
  if (path === '/admin/push/broadcast') return broadcast(body);
  return null;
}

module.exports = {keys, encrypt, vapid, send, sendAll, sendTo, tick, customerTick, customerRoute, broadcast, start, stop, route, alertFor, counts, STAGES};

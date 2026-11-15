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
  const r = await fetchImpl(sub.endpoint, {method: 'POST', headers: {TTL: '3600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapid(sub.endpoint, k)}, body: encrypt(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth)});
  return r.status;
}

// Sends to every saved phone. Phones the push service says are gone (404/410) are removed.
async function sendAll(message, fetchImpl = fetch) {
  const {subs, k} = await transaction(async s => ({subs: await s.list('push_subs'), k: await keys(s)}));
  const gone = [], results = [];
  for (const sub of subs) {
    try { const st = await send(sub, message, k, fetchImpl); results.push(st); if (st === 404 || st === 410) gone.push(sub.id); }
    catch (e) { results.push('error'); }
  }
  if (gone.length) await transaction(async s => { for (const id of gone) await s.remove('push_subs', id); });
  return {sent: results.filter(x => x === 201 || x === 200).length, tried: subs.length, removed: gone.length};
}

const money = c => '$' + (Math.round(c || 0) / 100).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const word = (v, n = 30) => String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, n);
const etDay = t => new Date(t * 1000).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
// Same orders the Order Bell rings for: live, not canceled or expired, and not a Zelle/Venmo/Cash App checkout that was never submitted.
const counts = o => o.is_test === false && !['canceled', 'expired'].includes(o.status) && !(o.proof_required && !o.submitted_at && o.status === 'order_received');
function alertFor(o, dayTotal) {
  const total = o.total || 0, items = (o.items || []).reduce((n, i) => n + (i.quantity || 0), 0);
  const label = total >= 25000 ? 'BIG ORDER' : total >= 10000 ? 'NICE ORDER' : 'NEW ORDER';
  const first = word(String(o.customer?.name || '').split(/\s+/)[0]) || 'Someone';
  return {title: `${label} ${money(total)}${o.brand && o.brand !== 'glow' ? ' · ' + word(o.brand, 12) : ''}`,
    body: `${first}${o.customer?.state ? ' · ' + word(o.customer.state, 20) : ''} · ${items} item${items === 1 ? '' : 's'}\n${money(dayTotal)} so far today`,
    url: '/store-next/admin?order=' + encodeURIComponent(o.id), tag: o.id};
}

// One pass: finds orders not alerted yet. The first pass only remembers what is already there (no flood of old alerts).
async function tick(fetchImpl = fetch) {
  const due = await transaction(async s => {
    const subs = await s.list('push_subs'); if (!subs.length) return [];
    const st = await s.get('integrations', 'webpush-feed') || {id: 'webpush-feed', seen: []};
    const live = (await (s.listLite ? s.listLite('orders') : s.list('orders'))).filter(counts);
    const today = etDay(now()), dayTotal = live.filter(o => etDay(o.created || 0) === today).reduce((n, o) => n + (o.total || 0), 0);
    const recent = live.filter(o => (o.created || 0) > now() - 2 * 86400).sort((a, b) => (a.created || 0) - (b.created || 0));
    const seen = new Set(st.seen || []);
    const fresh = st.init ? recent.filter(o => !seen.has(o.id)) : [];
    st.init = true; st.seen = [...seen, ...recent.map(o => o.id).filter(id => !seen.has(id))].slice(-400); st.checked = now();
    await s.put('integrations', 'webpush-feed', st);
    return fresh.map(o => alertFor(o, dayTotal));
  });
  for (const m of due) await sendAll(m, fetchImpl);
  return due.length;
}

let timer = null, busy = false;
function start(ms = 20000) {
  if (timer) return timer;
  timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } catch (e) { console.error('web-push tick', e.message); } finally { busy = false; } }, ms);
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
  return null;
}

module.exports = {keys, encrypt, vapid, send, sendAll, tick, start, stop, route, alertFor, counts};

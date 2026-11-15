'use strict';
// Glow Lab customer app (Jonah, 14 Nov 2026: "now lets make one for everyone").
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-custapp-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'customer-app-owner-test-password', STORE_SESSION_SECRET: 'customer-app-tests-session-secret-32-chars+', STORE_ORIGIN: 'http://127.0.0.1:8787'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const accounts = require('../../netlify/functions/lib/customer-accounts.cjs');
const wp = require('../../netlify/functions/lib/web-push.cjs');
const srv = require('../../tools/sevalla/server.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

function phone() { const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16); return {ua, auth, sub: {endpoint: 'https://web.push.apple.com/' + crypto.randomBytes(8).toString('hex'), keys: {p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url')}}}; }
function decrypt(buf, ua, auth) {
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), body = buf.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]); return JSON.parse(out.subarray(0, -1).toString());
}
async function customer(email) {
  const id = accounts.hash(email), token = crypto.randomBytes(24).toString('base64url');
  await transaction(async s => { await s.put('customers', id, {id, email, name: 'Pat Sample', created: 1, verified: true, auth_version: 1, password: null}); await s.put('customer_sessions', accounts.hash(token), {customer_id: id, auth_version: 1, expires: Math.floor(Date.now() / 1000) + 3600}); });
  return {id, h: {cookie: 'glow_next_customer=' + token}};
}

test('a signed-in customer gets one alert per order step; nothing old, nothing for other customers', async () => {
  const pat = await customer('pat@example.com'), other = await customer('other@example.com'), p = phone(), q = phone(), got = [], gotOther = [];
  await assert.rejects(wp.customerRoute('/account/push/subscribe', {subscription: p.sub}, {}), e => e.status === 401, 'needs a signed-in customer');
  assert.deepEqual(await wp.customerRoute('/account/push/subscribe', {subscription: p.sub, orders: true, deals: false}, pat.h), {ok: true, orders: true, deals: false});
  await wp.customerRoute('/account/push/subscribe', {subscription: q.sub, orders: true, deals: true}, other.h);
  assert.deepEqual(await wp.customerRoute('/account/push/status', {endpoint: p.sub.endpoint}, {}), {on: true, orders: true, deals: false});
  const fetchImpl = async (url, o) => { if (url === p.sub.endpoint) got.push(decrypt(o.body, p.ua, p.auth)); else gotOther.push(decrypt(o.body, q.ua, q.auth)); return {status: 201}; };
  const t = Math.floor(Date.now() / 1000), order = extra => ({id: 'GLP-PAT1', created: t - 60, status: 'order_received', is_test: false, customer_id: pat.id, total: 5000, items: [], ...extra});
  await transaction(s => s.put('orders', 'GLP-OLDPAID', order({id: 'GLP-OLDPAID', status: 'shipped', created: t - 3 * 86400})));
  await transaction(s => s.put('orders', 'GLP-PAT1', order({})));
  assert.equal(await wp.customerTick(fetchImpl), 0, 'first look only remembers where each order is');
  await transaction(s => s.put('orders', 'GLP-PAT1', order({status: 'paid', points_earned: 45})));
  assert.equal(await wp.customerTick(fetchImpl), 1);
  assert.equal(got.at(-1).title, 'Payment received 💛'); assert.match(got.at(-1).body, /GLP-PAT1 is paid.*45 Glow Points/); assert.equal(got.at(-1).url, '/store-next/account');
  assert.equal(await wp.customerTick(fetchImpl), 0, 'never twice');
  await transaction(s => s.put('orders', 'GLP-PAT1', order({status: 'shipped', delivery: {state: 'delivered', delivered: true}})));
  assert.equal(await wp.customerTick(fetchImpl), 1, 'shipped + out + delivered between checks: one alert, the latest');
  assert.equal(got.at(-1).title, 'Delivered ✨');
  assert.equal(got.length, 2); assert.equal(gotOther.length, 0, 'other customers get nothing about Pat');
  // A subscription box or card checkout is made already paid: it still gets "Payment received". Other brands never alert.
  await transaction(async s => { await s.put('orders', 'GLP-SUB2', order({id: 'GLP-SUB2', created: t, status: 'paid', subscription_id: 'SUB-1'})); await s.put('orders', 'ZDR-1', order({id: 'ZDR-1', created: t, status: 'paid', brand: 'zader'})); await s.put('orders', 'GLP-T', order({id: 'GLP-T', created: t, status: 'paid', is_test: true})); });
  assert.equal(await wp.customerTick(fetchImpl), 1);
  assert.match(got.at(-1).body, /GLP-SUB2/); assert.equal(got.length, 3);
  assert.equal(await wp.customerTick(fetchImpl), 0);
});

test('deal alerts go only to phones that chose Deals & live shows', async () => {
  const sent = [];
  const r = await wp.sendTo('cust_push_subs', x => x.deals === true, {title: 't', body: 'b'}, async url => { sent.push(url); return {status: 201}; });
  assert.equal(r.tried, 1); assert.equal(sent.length, 1);
  await assert.rejects(wp.broadcast({title: '', body: 'x'}), /Write a title/);
});

test('store pages carry the customer app; affiliate stores keep their own start page; Management is untouched', () => {
  const head = '<head><meta name="viewport" content="width=device-width,initial-scale=1"></head>';
  assert.match(srv.storeApp(head, '/store-next/'), /app\.webmanifest"/);
  assert.match(srv.storeApp(head, '/store-next/tiffany-blount'), /app\.webmanifest\?s=tiffany-blount"/);
  assert.match(srv.storeApp(head, '/store-next/account'), /app\.webmanifest"/);
  assert.equal(srv.storeApp(head, '/store-next/admin'), head);
  assert.equal(JSON.parse(srv.storeManifest('tiffany-blount')).start_url, '/store-next/tiffany-blount?app=1');
  assert.equal(JSON.parse(srv.storeManifest('../x')).start_url, '/store-next/?app=1');
  assert.equal(JSON.parse(srv.storeManifest('admin')).start_url, '/store-next/?app=1');
  assert.equal(JSON.parse(srv.storeManifest()).short_name, 'Glow Lab');
});

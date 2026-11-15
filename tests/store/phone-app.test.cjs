'use strict';
// Glow Admin phone app (Jonah, 14 Nov 2026): home-screen app for Management + new-order alerts by Web Push.
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-phoneapp-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'phone-app-owner-test-password', STORE_SESSION_SECRET: 'phone-app-tests-session-secret-32-chars+', STORE_ORIGIN: 'http://127.0.0.1:8787'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const wp = require('../../netlify/functions/lib/web-push.cjs');
const {createServer} = require('../../tools/sevalla/server.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));

// The browser side of RFC 8291, written out here to check what web-push.cjs sends.
function decrypt(buf, ua, auth) {
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), body = buf.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(body.subarray(body.length - 16));
  const out = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  assert.equal(out[out.length - 1], 2); return JSON.parse(out.subarray(0, -1).toString());
}
function phone() { const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16); return {ua, auth, sub: {endpoint: 'https://web.push.apple.com/' + crypto.randomBytes(8).toString('hex'), keys: {p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url')}}}; }

test('alerts are encrypted for the phone and signed with the store key', async () => {
  const p = phone(), k = await transaction(s => wp.keys(s));
  assert.deepEqual(decrypt(wp.encrypt(JSON.stringify({title: 'NEW ORDER $1.00'}), p.sub.keys.p256dh, p.sub.keys.auth), p.ua, p.auth), {title: 'NEW ORDER $1.00'});
  const h = wp.vapid(p.sub.endpoint, k), [a, b, c] = h.match(/t=([^,]+)/)[1].split('.');
  assert.equal(JSON.parse(Buffer.from(b, 'base64url')).aud, 'https://web.push.apple.com');
  const pub = crypto.createPublicKey({key: {kty: 'EC', crv: 'P-256', x: Buffer.from(k.public, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(k.public, 'base64url').subarray(33).toString('base64url')}, format: 'jwk'});
  assert.ok(crypto.verify('sha256', Buffer.from(a + '.' + b), {key: pub, dsaEncoding: 'ieee-p1363'}, Buffer.from(c, 'base64url')));
  assert.equal((await transaction(s => wp.keys(s))).public, k.public, 'the key pair is made once and kept');
});

test('one alert per new order, nothing for old ones, drafts or tests; dead phones are removed', async () => {
  const p = phone(), dead = phone(), got = [];
  await wp.route('/admin/push/subscribe', {subscription: p.sub, device: 'iPhone app'}, 'owner');
  await wp.route('/admin/push/subscribe', {subscription: dead.sub}, 'owner');
  await assert.rejects(wp.route('/admin/push/subscribe', {subscription: {endpoint: 'http://x', keys: {}}}, 'owner'), /could not be set up/);
  const fetchImpl = async (url, o) => { if (url === dead.sub.endpoint) return {status: 410}; got.push(decrypt(o.body, p.ua, p.auth)); return {status: 201}; };
  const t = Math.floor(Date.now() / 1000), order = (id, extra) => ({id, created: t - 60, status: 'paid', is_test: false, total: 15220, customer: {name: 'Felecia Lowery', state: 'AL', email: 'x@example.com', address: '1 Secret St'}, items: [{quantity: 1}, {quantity: 1}], ...extra});
  await transaction(s => s.put('orders', 'GLP-OLD', order('GLP-OLD')));
  assert.equal(await wp.tick(fetchImpl), 0, 'first pass only remembers what is there');
  await transaction(async s => {
    await s.put('orders', 'GLP-NEW', order('GLP-NEW', {total: 30000}));
    await s.put('orders', 'GLP-TEST', order('GLP-TEST', {is_test: true}));
    await s.put('orders', 'GLP-DRAFT', order('GLP-DRAFT', {status: 'order_received', proof_required: true}));
  });
  assert.equal(await wp.tick(fetchImpl), 1);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, 'BIG ORDER $300.00');
  assert.match(got[0].body, /^Felecia · AL · 2 items\n\$\d/);
  assert.doesNotMatch(JSON.stringify(got[0]), /Lowery|Secret|example\.com/, 'no last name, street or email on the lock screen');
  assert.equal(got[0].url, '/store-next/admin?order=GLP-NEW');
  assert.equal((await wp.route('/admin/push/status', {}, 'owner')).phones.length, 1, 'the phone that answered 410 was removed');
  assert.equal(await wp.tick(fetchImpl), 0, 'never twice');
  await transaction(s => s.put('orders', 'GLP-DRAFT', order('GLP-DRAFT', {status: 'payment_submitted', proof_required: true, submitted_at: t})));
  assert.equal(await wp.tick(fetchImpl), 1, 'a Zelle checkout alerts once it is submitted');
});

test('Management page carries the app manifest and icon; the store page does not', async t => {
  const server = createServer({apiHandler: async () => ({statusCode: 200, headers: {}, body: '{}'})});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const admin = await (await fetch(base + '/store-next/admin')).text(), store = await (await fetch(base + '/store-next/')).text();
  assert.match(admin, /<link rel="manifest" href="\/store-next\/admin\.webmanifest">/);
  assert.match(admin, /apple-touch-icon" href="\/img\/admin-app-180\.png"/);
  assert.match(admin, /apple-mobile-web-app-title" content="Glow Admin"/);
  assert.doesNotMatch(store, /admin\.webmanifest/);
  const m = await fetch(base + '/store-next/admin.webmanifest');
  assert.equal(m.headers.get('content-type'), 'application/manifest+json');
  const man = await m.json(); assert.equal(man.short_name, 'Glow Admin'); assert.equal(man.display, 'standalone');
  for (const i of man.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
  assert.equal((await fetch(base + '/img/admin-app-180.png')).status, 200);
  const sw = await fetch(base + '/store-next/admin-sw.js'); assert.equal(sw.status, 200); assert.match(await sw.text(), /showNotification/);
});

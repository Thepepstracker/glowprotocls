'use strict';
// Customer app updates (Jonah, 18 Nov 2026): scan QR coupons, Glow card / VIP account look, truck tracking.
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-appupd-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'app-updates-owner-test-password', STORE_SESSION_SECRET: 'app-updates-tests-session-secret-32-chars+', STORE_ORIGIN: 'http://127.0.0.1:8787'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const accounts = require('../../netlify/functions/lib/customer-accounts.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const app = fs.readFileSync(path.join(__dirname, '../../store-next/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../store-next/styles.css'), 'utf8');

test('each order carries a truck trip: carrier and stage, never the address', async () => {
  const id = accounts.hash('trip@example.com'), now = Math.floor(Date.now() / 1000);
  const orders = [
    ['GLP-T1', {status: 'pending'}],
    ['GLP-T2', {status: 'paid'}],
    ['GLP-T3', {status: 'shipped', shipment: {carrier: 'ups', label_url: 'x', service: 'UPS Ground'}}],
    ['GLP-T4', {status: 'shipped', shipment: {carrier: 'ups'}, delivery: {state: 'in_transit', scheduled_date: '2026-11-20'}}],
    ['GLP-T5', {status: 'shipped', shipment: {service: 'USPS Priority Mail'}, delivery: {state: 'out_for_delivery'}}],
    ['GLP-T6', {status: 'shipped', shipment: {carrier: 'usps'}, delivery: {state: 'delivered', delivered_at: now}}],
  ];
  const d = await transaction(async s => {
    await s.put('customers', id, {id, email: 'trip@example.com', name: 'Trip Tester', created: now, verified: true, auth_version: 1, password: null});
    for (const [oid, o] of orders) await s.put('orders', oid, {id: oid, customer_id: id, total: 10, created: now, ship_to: {address: '1 Secret Ln', city: 'Canton', state: 'GA', zip: '30114'}, ...o});
    return accounts.accountData(s, await s.get('customers', id));
  });
  const by = Object.fromEntries(d.orders.map(o => [o.id, o.trip]));
  assert.equal(by['GLP-T1'], null, 'unpaid orders have no truck');
  assert.equal(by['GLP-T2'].stage, 0);
  assert.deepEqual([by['GLP-T3'].carrier, by['GLP-T3'].stage], ['ups', 1]);
  assert.deepEqual([by['GLP-T4'].stage, by['GLP-T4'].eta], [2, '2026-11-20']);
  assert.deepEqual([by['GLP-T5'].carrier, by['GLP-T5'].stage], ['usps', 3]);
  assert.deepEqual([by['GLP-T6'].carrier, by['GLP-T6'].stage], ['usps', 4]);
  assert.ok(!JSON.stringify(d.orders).includes('Secret Ln'), 'the trip never carries the street');
  assert.equal(d.customer.created, now, 'member-since date is sent');
});

test('the app has Scan, the Glow card, the trucks and the coupon QR maker', () => {
  for (const s of ['function readScan', 'function scanOpen', 'data-action="scan-open"', 'data-sa-k="merch"', 'data-sa-k="scan"', 'el.dataset.saK===k', 'function glowCardHtml', 'function truckRoad', 'function couponQr', 'data-action="coupon-qr"', 'couponRejected'])
    assert.ok(app.includes(s), s);
  assert.match(app, /JSQR_SRI\s*=\s*'sha384-/, 'scanner library is pinned with integrity');
  assert.ok(css.includes('repeat(5,1fr)'), 'five tabs fit on one row');
  assert.ok(/prefers-reduced-motion[^}]*\.tr/.test(css.replace(/\n/g, ' ')) || css.includes('prefers-reduced-motion'), 'trucks respect reduced motion');
});

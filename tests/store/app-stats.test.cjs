'use strict';
// How many people got the Glow Lab app (Jonah, 15 Nov 2026).
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-appstats-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'appstats-owner-test-password', STORE_SESSION_SECRET: 'appstats-tests-session-secret-32-chars-xx+', STORE_ORIGIN: 'http://127.0.0.1:8787'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const growth = require('../../netlify/functions/lib/growth.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const ua = {'user-agent': 'Mozilla/5.0 (iPhone)'};

test('installs and opens are counted; bots are not; alert phones are counted too', async () => {
  for (const e of ['app_install', 'app_open', 'app_install', 'app_open', 'app_open']) await transaction(s => growth.event(s, {e, src: 'app'}, ua));
  await transaction(s => growth.event(s, {e: 'app_install'}, {'user-agent': 'Googlebot'}));
  await transaction(s => s.put('cust_push_subs', 'x1', {id: 'x1', customer_id: 'c1'}));
  const a = await transaction(s => growth.appStats(s));
  assert.deepEqual(a, {installs: 2, installs_today: 2, installs_week: 2, opens_today: 3, opens_week: 3, alerts_on: 1});
  // ordinary funnel events still work
  await transaction(s => growth.event(s, {e: 'visit', src: 'app'}, ua));
  const day = await transaction(s => s.list('analytics'));
  assert.equal(day[0].s.app.visit, 1);
});

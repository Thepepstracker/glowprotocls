'use strict';
// "On the site now" outside a live (Jonah, 15 Nov 2026: "add how many people are on the site to the live area").
const {test, after} = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glow-presence-'));
Object.assign(process.env, {STORE_LOCAL: '1', STORE_SQLITE_PATH: path.join(tmp, 'db.sqlite'), STORE_ADMIN_PASSWORD: 'presence-owner-test-password', STORE_SESSION_SECRET: 'presence-tests-session-secret-32-chars-x+', STORE_ORIGIN: 'http://127.0.0.1:8787'});
const {transaction} = require('../../netlify/functions/lib/store-db.cjs');
const live = require('../../netlify/functions/lib/live.cjs');
after(() => fs.rmSync(tmp, {recursive: true, force: true}));
const ua = {'user-agent': 'Mozilla/5.0 (iPhone)'};

test('counts open store tabs when no live is on; bots, bad ids and tabs gone quiet are not counted', async () => {
  for (const sid of ['aaaaaaaa1', 'bbbbbbbb2', 'cccccccc3']) assert.deepEqual(await live.ping({sid}, ua), {live: false});
  await live.ping({sid: 'aaaaaaaa1'}, ua); // the same tab again is still one person
  await live.ping({sid: 'dddddddd4'}, {'user-agent': 'Googlebot/2.1'});
  await live.ping({sid: 'BAD!'}, ua);
  assert.equal(await transaction(s => live.siteNow(s)), 3);
  // A tab that went quiet 3 minutes ago drops off; one older than 10 minutes is cleared out on the next hello.
  await transaction(async s => { const r = await s.get('integrations', 'site-presence'); r.seen.bbbbbbbb2 -= 180; r.seen.cccccccc3 -= 700; await s.put('integrations', 'site-presence', r); });
  assert.equal(await transaction(s => live.siteNow(s)), 1);
  await live.ping({sid: 'eeeeeeee5'}, ua);
  const r = await transaction(s => s.get('integrations', 'site-presence'));
  assert.deepEqual(Object.keys(r.seen).sort(), ['aaaaaaaa1', 'bbbbbbbb2', 'eeeeeeee5']);
  assert.equal(await transaction(s => live.siteNow(s)), 2);
});

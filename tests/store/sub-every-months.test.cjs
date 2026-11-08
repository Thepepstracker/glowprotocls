'use strict';
// Every 2 / 3 months for Subscribe & save (Jonah, 8 Nov 2026): kits of 10 last most people 2–3 months.
const test=require('node:test'),assert=require('node:assert/strict');
const subs=require('../../netlify/functions/lib/subscriptions.cjs');
test('customers can pick every 2 months and every 3 months',()=>{for(const k of ['2m','3m'])assert.ok(subs.CUSTOMER_EVERY.includes(k),k);assert.equal(subs.EVERY['2m'].label,'Every 2 months');assert.equal(subs.EVERY['3m'].label,'Every 3 months');assert.ok(!subs.CUSTOMER_EVERY.includes('4w'))});
test('the next date moves by whole months and never runs past the end of a short month',()=>{
 assert.equal(subs.addInterval('2026-11-08','2m'),'2027-01-08');assert.equal(subs.addInterval('2026-11-08','3m'),'2027-02-08');
 assert.equal(subs.addInterval('2026-12-31','2m'),'2027-02-28');assert.equal(subs.addInterval('2026-11-30','3m'),'2027-02-28');assert.equal(subs.addInterval('2027-08-31','3m'),'2027-11-30');
 assert.equal(subs.addInterval('2026-11-08','1m'),'2026-12-08')});

'use strict';
// Zader Health "Ironman" (Jonah, 8 Nov 2026): everything Glow has, Zader gets. One test file that grows phase by phase.
const test=require('node:test'),assert=require('node:assert/strict');
const brands=require('../../netlify/functions/lib/brands.cjs'),{zaderRoute}=require('../../tools/sevalla/server.cjs');
test('payments: Zader orders say "Zader Health" on Stripe; Glow is unchanged',()=>{
 assert.equal(brands.paymentLabel(brands.get('glow')),'Glow Lab');assert.equal(brands.paymentLabel(brands.get('zader')),'Zader Health');
 assert.equal(brands.statementSuffix(brands.get('glow')),null,'Glow charges keep exactly what they send today');assert.equal(brands.statementSuffix(brands.get('zader')),'ZADER HEALTH');
 assert.ok(brands.statementSuffix(brands.get('zader')).length<=22);
});
test('zaderhealth.com routes: app for pages, own policy pages, Glow-only pages bounce, files pass through',()=>{
 assert.deepEqual(zaderRoute('/'),{file:'store-next/zader.html'});assert.deepEqual(zaderRoute('/store-next/admin'),{file:'store-next/zader.html'});
 assert.deepEqual(zaderRoute('/terms.html'),{file:'store-next/zader-terms.html'});assert.deepEqual(zaderRoute('/privacy/'),{file:'store-next/zader-privacy.html'});
 assert.deepEqual(zaderRoute('/coa.html'),{redirect:'/'});assert.deepEqual(zaderRoute('/store-next/live.html'),{redirect:'/'});
 assert.equal(zaderRoute('/store-next/app.js'),null);assert.equal(zaderRoute('/img/zader/zader-vial.jpg'),null);
});

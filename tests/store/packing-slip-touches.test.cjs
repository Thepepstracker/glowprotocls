'use strict';
// Packing slip personal touches + mystery gift ticket (Jonah, 19 Nov 2026).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../..'),pack=fs.readFileSync(path.join(root,'store-next/packing.html'),'utf8');
test('the slip keeps its original format; the personal hello lives in the app opener',()=>{
 for(const s of ["'Thank you, ')+esc(first)+'!</h1>",'Packed by <b>','window.__fit','(window.__fit||Promise.resolve())'])assert.ok(pack.includes(s),s);
 for(const s of ['Welcome back','GlowScript','function boxNumber'])assert.ok(!pack.includes(s),'not on the slip any more: '+s);
 const app=fs.readFileSync(path.join(root,'store-next/app.js'),'utf8');
 for(const s of ['function opShow(c)','function opLines(c','function opHello(','WELCOME BACK','Your box is out for delivery today.'])assert.ok(app.includes(s),s);
 assert.ok(!/your first order/i.test(app.slice(app.indexOf('// ===== App opener'))),'the opener never claims a first order');
});
test('one QR for the phone camera and the app’s Scan button, with the steps printed',()=>{
 for(const s of ["qrSvg('https://'+(z?'zaderhealth.com':'glowglps.com')+'/store-next/unbox/'+o.unbox_key)",'OPEN YOUR MYSTERY GIFT','Open your phone camera','Tap <b>Scan</b> in the app'])assert.ok(pack.includes(s),s);
 const app=fs.readFileSync(path.join(root,'store-next/app.js'),'utf8');assert.ok(app.includes("/^\\/store-next\\/unbox\\//.test(r.go)"),'in-app scan opens the gift');
});
test('the opener font ships with the store and is served as font/woff2',()=>{
 assert.ok(fs.statSync(path.join(root,'store-next/vendor/fonts/pacifico-latin-400.woff2')).size>10000);
 assert.equal(require(path.join(root,'tools/sevalla/server.cjs')).publicFile('/store-next/vendor/fonts/pacifico-latin-400.woff2'),'store-next/vendor/fonts/pacifico-latin-400.woff2');
 assert.match(fs.readFileSync(path.join(root,'tools/sevalla/server.cjs'),'utf8'),/'\.woff2':'font\/woff2'/);
});

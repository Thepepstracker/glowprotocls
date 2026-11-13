'use strict';
// Label kinds (Jonah, 13 Nov 2026): pick vial, nasal spray (10 per sheet) or big bottle (30 per sheet); each has its own
// sticker count, start sticker and preview, and labels of different kinds never share a sheet.
const test=require('node:test'),assert=require('node:assert/strict');
const lab=require('../../netlify/functions/lib/labels.cjs');
test('every kind has its stickers placed exactly once per sticker, and every label belongs to a kind with an image and thumbnail',()=>{
 const L=lab.lib();assert.deepEqual(Object.keys(L.kinds).sort(),['big','nasal','vial']);
 assert.equal(L.kinds.nasal.cm.length,10);assert.equal(L.kinds.big.cm.length,30);for(const m of [...L.kinds.nasal.cm,...L.kinds.big.cm])assert.equal(m.length,6);
 const n=L.labels.filter(l=>l.kind==='nasal');assert.equal(n.length,15);assert.equal(L.labels.filter(l=>l.kind==='big').length,1);
 for(const l of L.labels)assert.ok(Array.isArray(l.img)&&l.thumb&&l.thumb[1]>0,l.id);
});
test('nasal: 10 per sheet, 2 across, start sticker and new row; mixing kinds is refused',()=>{
 let p=lab.plan([{id:'nasal-kpv-10-mg',count:3},{id:'nasal-aicar-50-mg',count:2}],{kind:'nasal',start:4});
 assert.equal(p.length,1);assert.equal(p[0].length,10);assert.deepEqual(p[0].map(x=>x&&x.slice(6,10)),[null,null,null,'kpv-','kpv-','kpv-','aica','aica',null,null]);
 p=lab.plan([{id:'nasal-kpv-10-mg',count:25}],{kind:'nasal'});assert.equal(p.length,3);
 assert.throws(()=>lab.plan([{id:'nasal-kpv-10-mg',count:1}],{kind:'nasal',start:11}),/1 to 10/);
 assert.throws(()=>lab.plan([{id:'bac-water-30-ml',count:1}],{kind:'nasal'}),/different sheets/);
 assert.throws(()=>lab.plan([{id:'nasal-kpv-10-mg',count:1}]),/different sheets/,'a nasal label is not a vial label');
});
test('the PDF for a nasal sheet places each sticker with its own matrix, one image for the label',()=>{
 const pdf=lab.pdf(lab.plan([{id:'nasal-glow-fuel-120-mg',count:10}],{kind:'nasal'}),'t','nasal').toString('latin1');
 assert.equal((pdf.match(/ cm\n\/L0 Do/g)||[]).length,10);assert.equal((pdf.match(/\/Subtype \/Image/g)||[]).length,1);
 const big=lab.pdf(lab.plan([{id:'big-bac-water-30-ml',count:30}],{kind:'big'}),'t','big').toString('latin1');assert.equal((big.match(/ cm\n\/L0 Do/g)||[]).length,30);
});

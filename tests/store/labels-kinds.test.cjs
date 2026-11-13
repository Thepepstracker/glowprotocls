'use strict';
// Label kinds (Jonah, 13 Nov 2026): pick vial, nasal spray (10 per sheet) or big bottle (30 per sheet); each has its own
// sticker count, start sticker and preview, and labels of different kinds never share a sheet.
const test=require('node:test'),assert=require('node:assert/strict');
const lab=require('../../netlify/functions/lib/labels.cjs');
test('every kind has its stickers placed exactly once per sticker, and every label belongs to a kind with an image and thumbnail',()=>{
 const L=lab.lib();assert.deepEqual(Object.keys(L.kinds).sort(),['big','box','nasal','vial']);
 assert.equal(L.kinds.nasal.cm.length,10);assert.equal(L.kinds.big.cm.length,30);for(const m of [...L.kinds.nasal.cm,...L.kinds.big.cm])assert.equal(m.length,6);
 const n=L.labels.filter(l=>l.kind==='nasal');assert.equal(n.length,15);assert.deepEqual(L.labels.filter(l=>l.kind==='big').map(l=>l.id),['big-bac-water-30-ml','big-glow-lab-brand'],'BAC Water 30 mL and the Glow Lab brand label (13 Nov)');
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

test('tap to place: an exact layout prints only the stickers chosen, in any spot, on any kind; bad layouts are refused',()=>{
 const per=48,lay=[Array(per).fill(null),Array(per).fill(null)];lay[0][47]='bac-water-30-ml';lay[0][0]='bac-water-30-ml';lay[0][13]='kpv-10-mg';
 const pages=lab.layoutPages(lay,'vial');assert.equal(pages.length,1,'an empty last sheet is dropped');assert.equal(pages[0][47],'bac-water-30-ml');assert.equal(pages[0].filter(Boolean).length,3);
 const pdf=lab.pdf(pages,'t','vial').toString('latin1');assert.equal((pdf.match(/ cm\n\/L\d+ Do/g)||[]).length,3);
 const L=lab.lib(),pos=L.sheet.pos[47];assert.ok(pdf.includes(`${pos[2]} 0 0 ${pos[3]} ${pos[0]} ${pos[1]} cm`),'sticker 48 is drawn at sticker 48');
 const n=Array(10).fill(null);n[9]='nasal-kpv-10-mg';assert.equal(lab.layoutPages([n],'nasal')[0][9],'nasal-kpv-10-mg');
 assert.throws(()=>lab.layoutPages([Array(per).fill(null)],'vial'),/at least one/);
 assert.throws(()=>lab.layoutPages([Array(10).fill(null)],'vial'),/48 stickers/);
 assert.throws(()=>lab.layoutPages([n],'vial'),/48 stickers/);
 const mixed=Array(10).fill(null);mixed[0]='kpv-10-mg';assert.throws(()=>lab.layoutPages([mixed],'nasal'),/different sheets/);
 assert.throws(()=>lab.layoutPages(Array(21).fill(lay[0]),'vial'),/20 sheets/);
});

test('box labels: the Glow Lab brand label prints on the proven vial-sheet positions, 48 per sheet',()=>{
 const L=lab.lib();assert.equal(L.kinds.box.cols*L.kinds.box.rows,48);assert.ok(!L.kinds.box.cm,'uses the proven vial positions');
 const pdf=lab.pdf(lab.plan([{id:'box-glow-lab-brand',count:48}],{kind:'box'}),'t','box').toString('latin1');const pos=L.sheet.pos[0];
 assert.ok(pdf.includes(`${pos[2]} 0 0 ${pos[3]} ${pos[0]} ${pos[1]} cm`));assert.equal((pdf.match(/ cm\n\/L0 Do/g)||[]).length,48);
 assert.throws(()=>lab.plan([{id:'box-glow-lab-brand',count:1}]),/different sheets/,'not mixed onto a vial sheet');
});

'use strict';
// Label hub: every approved vial label, printed at the proven printer-adjusted positions.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const L=require('../../netlify/functions/lib/labels.cjs');
const ids=L.lib().labels.map(l=>l.id);
test('library: every label has its image and thumbnail, 48 sticker positions, no duplicates',()=>{
 const lib=L.lib(),dir=path.resolve(__dirname,'../../label-library');
 assert.ok(lib.labels.length>=100);assert.equal(new Set(ids).size,ids.length);assert.equal(lib.sheet.pos.length,48);
 const zlib=require('node:zlib');for(const l of lib.labels){const [f,off,len]=l.img,b=Buffer.alloc(len),fd=fs.openSync(path.join(dir,f),'r');fs.readSync(fd,b,0,len,off);fs.closeSync(fd);assert.equal(zlib.inflateSync(b).length,l.w*l.h*3,l.id);assert.ok(l.thumb[1]>1000,l.id);assert.ok(['icc','rgb'].includes(l.cs))}
 for(const s of lib.sheets)assert.ok(fs.existsSync(path.join(dir,'sheet-'+s.id+'.pdf')));
 assert.equal(lib.sheet.pos[0].join(' '),'19.323075 717.12496 122.22 52.38');
});
test('plan: start sticker, new row per label, pages, and limits',()=>{
 const p=L.plan([{id:ids[0],count:12},{id:ids[1],count:5},{id:ids[2],count:12}],{start:6,newRow:true});
 assert.equal(p.length,1);assert.equal(p[0].slice(0,5).filter(Boolean).length,0);assert.equal(p[0][5],ids[0]);assert.equal(p[0][16],ids[0]);
 assert.equal(p[0][17],null);assert.equal(p[0][20],ids[1]);assert.equal(p[0][24],ids[1]);assert.equal(p[0][25],null);assert.equal(p[0][28],ids[2]);assert.equal(p[0][39],ids[2]);assert.equal(p[0][40],null);
 const q=L.plan([{id:ids[0],count:12},{id:ids[1],count:5}],{newRow:false});assert.equal(q[0][12],ids[1]);
 assert.equal(L.plan([{id:ids[0],count:49}]).length,2);
 assert.throws(()=>L.plan([{id:'not-a-label',count:1}]),/Unknown label/);
 assert.throws(()=>L.plan([{id:ids[0],count:0}]),/how many/);
 assert.throws(()=>L.plan([{id:ids[0],count:1}],{start:49}),/1 to 48/);
 assert.throws(()=>L.plan([{id:ids[0],count:961}]),/20 sheets/);
 assert.throws(()=>L.plan([]),/at least one/);
});
test('pdf: a full sheet places 48 copies at the proven positions with one image object, at 100% size',()=>{
 const id=L.lib().labels.find(l=>l.cs==='icc').id,buf=L.pdf(L.plan([{id,count:48}]),'test'),s=buf.toString('latin1');
 assert.ok(s.startsWith('%PDF-1.7'));assert.ok(s.trimEnd().endsWith('%%EOF'));
 assert.equal((s.match(/ Do\n/g)||[]).length,48);assert.equal((s.match(/\/Subtype \/Image/g)||[]).length,1);assert.equal((s.match(/\/ICCBased/g)||[]).length,1);
 assert.ok(s.includes('/PrintScaling /None'));assert.ok(s.includes('/MediaBox [0 0 612 792]'));
 for(const [x,y,w,h] of L.lib().sheet.pos)assert.ok(s.includes(`${w} 0 0 ${h} ${x} ${y} cm`));
 const off=Number(s.match(/startxref\n(\d+)/)[1]);assert.equal(s.slice(off,off+4),'xref');
 const xref=s.slice(off).split('\n').slice(3).filter(l=>/^\d{10} 00000 n $/.test(l)).map(l=>Number(l.slice(0,10)));
 xref.forEach((o,i)=>assert.equal(s.slice(o,o+String(i+1).length+6),`${i+1} 0 obj`));
});
test('routes: sign-in required; list, build and thumbnails work when signed in',async()=>{
 const deny={session:async()=>{throw Object.assign(new Error('Sign in to the management dashboard.'),{status:401})}};
 const db=require('../../netlify/functions/lib/store-db.cjs'),orig=db.transaction;db.transaction=async fn=>fn({});
 try{
  await assert.rejects(L.route('/admin/labels',{},{},'GET',deny),/Sign in/);
  await assert.rejects(L.route('/admin/labels/build',{items:[{id:ids[0],count:1}]},{},'POST',deny),/Sign in/);
  const ok={session:async()=>'sid'};
  const list=await L.route('/admin/labels',{},{},'GET',ok);assert.equal(list.body.labels.length,ids.length);
  const built=await L.route('/admin/labels/build',{items:[{id:ids[0],count:50}],start:1},{},'POST',ok);assert.equal(built.headers['X-Label-Pages'],'2');assert.equal(built.body._type,'application/pdf');
  const th=await L.route('/admin/labels/thumb/'+ids[0],{},{},'GET',ok);assert.equal(th.body._type,'image/jpeg');
  await assert.rejects(L.route('/admin/labels/thumb/nope-label',{},{},'GET',ok),/not found/);
  assert.equal(await L.route('/admin/other',{},{},'GET',ok),null);
 }finally{db.transaction=orig}
});

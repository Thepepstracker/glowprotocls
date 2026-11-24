'use strict';
// Serum Station (Jonah, 24 Nov 2026): a finished batch is logged once and its bottles go onto stock; void takes them back.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-serums-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'serum-tests-session-secret-32-chars!!',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const call=(p,b,cookie,method)=>handle({path:p,method:method||(b?'POST':'GET'),headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const oldFetch=global.fetch;global.fetch=async u=>{throw new Error('unexpected fetch '+u)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
let owner,P,M;const stock=id=>transaction(s=>s.get('products',id)).then(p=>p.stock);

test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 [P,M]=await transaction(async s=>{const ps=(await s.list('products')).filter(p=>!(p.components||[]).length&&!(Number(p.units)>1)&&!p.stock_pool).slice(0,2);ps[0].stock=5;ps[1].stock=2;for(const p of ps)await s.put('products',p.id,p);return ps})});

test('signed-out people cannot log batches',async()=>{await assert.rejects(call('/admin/serums/batch',{key:'x',recipe:'p01',name:'Protocol 01',made_by:'Jonah',yields:[{id:P.id,quantity:1}]}),e=>e.status===401)});

test('a finished batch adds its bottles to stock once and gets a lot number',async()=>{
 const b={key:'click-1',recipe:'protocol-01',code:'P01',name:'Protocol 01',made_by:'Jonah',ph:'5.4',batch_g:235,ingredients:[{name:'GHK-Cu',amount:0.94,unit:'g'}],yields:[{id:P.id,quantity:15},{id:M.id,quantity:10}]};
 const r=await call('/admin/serums/batch',b,owner);assert.equal(r.status,200);assert.equal(r.body.ok,true);
 assert.match(r.body.batch.lot,/^P01-\d{8}-01$/);assert.equal(await stock(P.id),20);assert.equal(await stock(M.id),12);
 assert.deepEqual(r.body.batch.yields.map(y=>[y.stock_before,y.stock_after]),[[5,20],[2,12]]);
 const again=await call('/admin/serums/batch',b,owner);assert.equal(again.body.already,true);assert.equal(await stock(P.id),20);
 const second=await call('/admin/serums/batch',{...b,key:'click-2',yields:[{id:P.id,quantity:1}]},owner);assert.match(second.body.batch.lot,/-02$/);
 const log=await call('/admin/serums/batches',null,owner);assert.equal(log.body.batches.length,2);assert.equal(log.body.batches[0].lot,second.body.batch.lot)});

test('log only, without touching stock',async()=>{const before=await stock(P.id);
 const r=await call('/admin/serums/batch',{key:'click-3',recipe:'ha-base',code:'HA',name:'HA base',made_by:'Jonah',add_stock:false,yields:[{id:P.id,quantity:3}]},owner);
 assert.equal(r.body.batch.added_to_stock,false);assert.equal(await stock(P.id),before)});

test('void takes the bottles back off, and refuses when they already sold',async()=>{
 const log=(await call('/admin/serums/batches',null,owner)).body.batches;const first=log.find(b=>b.lot.endsWith('-01')&&b.code==='P01');
 await transaction(async s=>{const p=await s.get('products',M.id);p.stock=3;await s.put('products',p.id,p)});
 await assert.rejects(call('/admin/serums/batch/void',{id:first.id},owner),e=>e.status===409&&/cannot be taken back/.test(e.message));
 await transaction(async s=>{const p=await s.get('products',M.id);p.stock=12;await s.put('products',p.id,p)});
 const pBefore=await stock(P.id);const v=await call('/admin/serums/batch/void',{id:first.id},owner);assert.ok(v.body.batch.voided_at);
 assert.equal(await stock(P.id),pBefore-15);assert.equal(await stock(M.id),2)});

test('bad input is refused',async()=>{
 await assert.rejects(call('/admin/serums/batch',{key:'k9',recipe:'p01',name:'P',made_by:'J',yields:[]},owner),e=>e.status===400);
 await assert.rejects(call('/admin/serums/batch',{key:'k10',recipe:'p01',name:'P',made_by:'J',yields:[{id:P.id,quantity:-1}]},owner),e=>e.status===400);
 await assert.rejects(call('/admin/serums/batch',{key:'k11',recipe:'p01',name:'P',made_by:'J',yields:[{id:9999999,quantity:1}]},owner),e=>e.status===404)});

test('a prep batch with no bottles (HA base) can be logged by weight',async()=>{
 const r=await call('/admin/serums/batch',{key:'click-ha',recipe:'ha-base',code:'HA',name:'HA base 1%',made_by:'Jonah',add_stock:false,batch_g:500,yields:[]},owner);
 assert.equal(r.body.ok,true);assert.match(r.body.batch.lot,/^HA-/);
 await assert.rejects(call('/admin/serums/batch',{key:'click-ha2',recipe:'ha-base',name:'HA',made_by:'J',add_stock:false,yields:[]},owner),e=>e.status===400)});

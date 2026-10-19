'use strict';
// Packing Check shared "packed" status: staff only, paid/shipped only, records who and how long, and can be undone.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-packed-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'packed-test-admin-password',STORE_SESSION_SECRET:'packed-test-session-secret-long-enough-x',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');let cookie;
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}}),admin=(p,b)=>call(p,b,{cookie});
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];await transaction(async s=>{const x=await s.get('settings','main');await s.put('settings','main',{...x,demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{zelle:'recipient@example.com'}})})});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('packed status is staff-only, paid/shipped only, shared through admin data, and can be undone',async()=>{
 const o=(await call('/orders',{items:[{id:1,quantity:2}],payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer:{name:'Pack Test',email:'pack@example.com',phone:'2025550101',address:'1 Test St',city:'Test',state:'GA',zip:'30301'}})).body.order;
 await assert.rejects(call('/admin/order/packed',{id:o.id,packed:true}),e=>e.status===401);
 await assert.rejects(admin('/admin/order/packed',{id:o.id,packed:true}),/Only paid or shipped/);
 await transaction(async s=>{const x=await s.get('orders',o.id);x.status='paid';x.paid=Math.floor(Date.now()/1000);await s.put('orders',o.id,x)});
 const r=(await admin('/admin/order/packed',{id:o.id,packed:true,fp:'1:2|0',seconds:95})).body;assert.equal(r.packed.fp,'1:2|0');assert.equal(r.packed.seconds,95);assert.equal(r.packed.by,'Owner');assert.ok(r.packed.at>0);
 const seen=(await admin('/admin/data')).body.orders.find(x=>x.id===o.id);assert.equal(seen.packed.seconds,95);
 assert.equal((await admin('/admin/order/packed',{id:o.id,packed:true,seconds:999999})).body.packed.seconds,null,'silly timer values are dropped');
 await admin('/admin/order/packed',{id:o.id,packed:false});assert.equal((await admin('/admin/data')).body.orders.find(x=>x.id===o.id).packed,undefined);
 await assert.rejects(admin('/admin/order/packed',{id:'GLP-NOPE',packed:true}),e=>e.status===404)});

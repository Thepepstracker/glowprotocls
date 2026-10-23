'use strict';
// Packing Check -> customer order page (Jonah, 23 Oct 2026): when a box is packed, the customer sees the time it was packed, nothing internal.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-packed-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='packed-test-admin-password';process.env.STORE_SESSION_SECRET='packed-test-session-secret-long-enough';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');let adminCookie;
const call=(p,b,headers={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1','x-nf-client-connection-ip':'fixture',...headers},body:b||{}});
const token=crypto.randomBytes(32).toString('base64url'),id='GLP-PACK000001';
before(async()=>{await transaction(seed);adminCookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await transaction(s=>s.put('orders',id,{id,is_test:false,brand:'glow',status:'paid',paid:1790000000,created:1790000000,subtotal:5000,discount:0,shipping:1500,tax:0,total:6500,token_hash:crypto.createHash('sha256').update(token).digest('hex'),customer:{name:'Pat Buyer',email:'pat@example.com'},items:[{id:1,name:'Test',quantity:1,amount:5000}],tracking:''}))});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('customer order page: no packed time before packing; only the packed time after; cleared again when unpacked',async()=>{
 const view=async()=>(await call('/orders/'+id,undefined,{'x-order-token':token})).body;
 assert.equal((await view()).packed,undefined);
 const r=await call('/admin/order/packed',{id,packed:true,fp:'internal-fingerprint',seconds:42},{cookie:adminCookie});assert.equal(r.status,200);
 const v=await view();assert.deepEqual(Object.keys(v.packed),['at']);assert.ok(v.packed.at>0);assert.ok(!JSON.stringify(v).includes('internal-fingerprint'));
 const adminView=(await call('/admin/data',undefined,{cookie:adminCookie})).body.orders.find(o=>o.id===id);assert.equal(adminView.packed.fp,'internal-fingerprint','Packing Check still gets its fingerprint');
 await call('/admin/order/packed',{id,packed:false},{cookie:adminCookie});assert.equal((await view()).packed,undefined)});

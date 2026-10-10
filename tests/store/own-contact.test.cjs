'use strict';
// Glow's own address/phone (set in Netlify env, never in the repo) can never be a customer's ship-to.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-own-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'s.sqlite'),STORE_ADMIN_PASSWORD:'own-test-admin-password',STORE_SESSION_SECRET:'own-test-session-secret-long-enough-xx',STORE_ORIGIN:'https://glowglps.com',STORE_OWN_ADDRESSES:'1 Example Lane|22 Sample Street',STORE_OWN_PHONES:'(555) 010-0199',SHIPSTATION_API_KEY:'k',SHIPSTATION_API_SECRET:'s'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),own=require('../../netlify/functions/lib/own-contact.cjs'),shipping=require('../../netlify/functions/lib/shipstation.cjs');
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});
const body=c=>({items:[{id:1,quantity:1}],payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer:{name:'Real Customer',email:'customer@example.com',phone:'2025550101',address:'9 Customer Road',city:'Canton',state:'GA',zip:'30114',...c}});
const originalFetch=global.fetch;
before(async()=>{await transaction(seed);await transaction(async s=>{const x=await s.get('settings','main');await s.put('settings','main',{...x,demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{zelle:'recipient@example.com'}})})});
after(()=>{global.fetch=originalFetch;fs.rmSync(tmp,{recursive:true,force:true})});

test('address matching ignores case, punctuation, unit numbers and Lane/Ln-style spellings',()=>{
 for(const a of ['1 Example Lane','1 example ln.','1 EXAMPLE LN APT 4','1 Example Lane, #2','22 Sample St'])assert.equal(own.match({address:a}),'address',a);
 for(const a of ['11 Example Lane','1 Example Lake Rd','221 Sample Street','9 Customer Road'])assert.equal(own.match({address:a}),'',a);
 assert.equal(own.match({address:'9 Customer Road',phone:'555-010-0199'}),'phone');
 assert.equal(own.match({address:'9 Customer Road',phone:'+1 (555) 010 0199'}),'phone');
});
test('checkout refuses our own address or phone with a plain message; a real customer address works',async()=>{
 await assert.rejects(call('/orders',body({address:'1 Example Ln'})),/Glow Lab.s own address/);
 await assert.rejects(call('/orders',body({phone:'5550100199'})),/Glow Lab.s own number/);
 const ok=(await call('/orders',body({}))).body;assert.match(ok.order.id,/^GLP-/);
});
test('an order already holding our address is never sent to ShipStation',async()=>{
 let calls=0;global.fetch=async()=>{calls++;throw Error('must not call ShipStation')};
 await transaction(s=>s.put('integrations','shipstation',{fingerprint:shipping.fingerprint(),enabled:true,store_id:88,stores:[{id:88,name:'Manual'}]}));
 const o={id:'GLP-OWNADDR001',created:1790000000,paid:1790001000,status:'paid',is_test:false,customer:{name:'X',email:'x@example.com',phone:'2025550101',address:'1 Example Lane',city:'Canton',state:'GA',zip:'30114'},items:[{id:1,sku:'A',name:'A',price:1000,quantity:1,amount:1000}],subtotal:1000,discount:0,shipping:1500,tax:0,total:2500,payment_method:'zelle'};
 await transaction(s=>s.put('orders',o.id,o));
 const r=await shipping.send(o.id);assert.equal(r.status,'needs_review');assert.equal(calls,0);
 assert.match((await transaction(s=>s.get('orders',o.id))).shipstation_message,/Glow Lab.s own/);
});
test('without the settings nothing is blocked',()=>{const a=process.env.STORE_OWN_ADDRESSES,p=process.env.STORE_OWN_PHONES;delete process.env.STORE_OWN_ADDRESSES;delete process.env.STORE_OWN_PHONES;assert.equal(own.match({address:'1 Example Lane',phone:'5550100199'}),'');process.env.STORE_OWN_ADDRESSES=a;process.env.STORE_OWN_PHONES=p});

'use strict';
// Every checkout makes an account (Jonah, 12 Nov 2026): a guest order creates the customer account for that email.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-checkout-account-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'checkout-account-fixture-password',STORE_SESSION_SECRET:'checkout-account-fixture-session-secret-longer-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const call=(p,body,headers={})=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...headers},body:body||{}});
const customer=e=>({name:'Tisha Fixture',email:e,phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30101'});
const order=e=>call('/orders',{items:[{id:9,quantity:1}],payment_method:'zelle',customer:customer(e),idempotency_key:crypto.randomUUID()});
before(async()=>{await transaction(async s=>{
 await s.put('settings','main',{demo:false,shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'pay@example.test'},tax_mode:'none',checkout_enabled:true});
 await s.put('products',9,{id:9,name:'GLP-2T · 10 mg',sku:'tirz-10-10-mg',brand:'glow',price:4199,stock:100,active:1,promo_excluded:false});
})});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('a guest order creates an unverified account for that email',async()=>{const r=await order('New.Guest@Example.test');assert.ok(r.status<300);const a=await transaction(s=>s.get('customers',accounts.hash('new.guest@example.test')));assert.ok(a);assert.equal(a.verified,false);assert.equal(a.created_at_checkout,r.body.order.id);assert.equal(a.name,'Tisha Fixture')});
test('a second guest order with the same email keeps the one account',async()=>{await order('new.guest@example.test');const all=(await transaction(s=>s.list('customers'))).filter(c=>c.email==='new.guest@example.test');assert.equal(all.length,1)});
test('a verified account is left alone',async()=>{const id=accounts.hash('done@example.test');await transaction(s=>s.put('customers',id,{id,email:'done@example.test',name:'Done',verified:true,created:1,auth_version:1,password:null}));await order('done@example.test');const a=await transaction(s=>s.get('customers',id));assert.equal(a.verified,true);assert.equal(a.created_at_checkout,undefined)});

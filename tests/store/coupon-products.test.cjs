'use strict';
// Coupons limited to certain products (FAMILY: GLP-2T 10 mg + BAC Water 10 mL for $35 with shipping).
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-coupon-products-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'coupon-products-fixture-password',STORE_SESSION_SECRET:'coupon-products-fixture-session-secret-longer-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs');
const call=(p,body,headers={})=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...headers},body:body||{}});let cookie;
const admin=(p,b)=>call(p,b,{cookie});
const customer={name:'Coupon Fixture',email:'coupon-products@example.test',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30101'};
const quote=(items,coupon='FAMILY')=>call('/quote',{items,coupon}).then(r=>r.body);
const TRZ={id:9,quantity:1},BAC={id:3,quantity:1},OTHER={id:5,quantity:1};
const family={code:'FAMILY',brand:'glow',kind:'fixed',value:3198,minimum:0,max_uses:100,expires:0,active:1,products:'tirz-10-10-mg, bac-water-10-ml'};
before(async()=>{await transaction(async s=>{
 await s.put('settings','main',{demo:true,shipping_cents:1500,free_shipping_cents:25000,payment_links:{},tax_mode:'none',checkout_enabled:true});
 await s.put('products',9,{id:9,name:'GLP-2T · 10 mg',sku:'tirz-10-10-mg',brand:'glow',price:4199,stock:100,active:1,promo_excluded:false});
 await s.put('products',3,{id:3,name:'BAC Water · 10 mL',sku:'bac-water-10-ml',brand:'glow',price:999,stock:100,active:1,promo_excluded:false});
 await s.put('products',5,{id:5,name:'BAC Water · 20 mL',sku:'bac-water-20-ml',brand:'glow',price:1799,stock:100,active:1,promo_excluded:false});
 await s.put('products',64,{id:64,name:'BAC Water · 10 mL',sku:'zdr-bac-water-10-ml',brand:'zader',price:1699,stock:100,active:1,promo_excluded:false});
 await s.put('coupons','WHOLE',{code:'WHOLE',brand:'glow',kind:'fixed',value:500,minimum:0,max_uses:100,used:0,expires:0,active:1});
});cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];await admin('/admin/coupon',family)});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('FAMILY saves as the two Glow product ids',async()=>{const c=await transaction(s=>s.get('coupons','FAMILY'));assert.deepEqual(c.products,[9,3]);assert.equal(c.value,3198)});
test('GLP-2T 10 mg + BAC Water 10 mL comes to exactly $35.00 with shipping',async()=>{const q=await quote([TRZ,BAC]);assert.equal(q.subtotal,5198);assert.equal(q.coupon_discount,3198);assert.equal(q.shipping,1500);assert.equal(q.total,3500)});
test('the code is refused unless both products are in the bag',async()=>{await assert.rejects(quote([TRZ]),/FAMILY only works with 2 items.*BAC Water · 10 mL/);await assert.rejects(quote([BAC]),/GLP-2T · 10 mg/);await assert.rejects(quote([OTHER]),/only works/)});
test('other items in the bag are not discounted',async()=>{const q=await quote([TRZ,BAC,OTHER]);assert.equal(q.coupon_discount,3198);assert.equal(q.total,3500+1799)});
test('a limited percent code only takes its percent off the listed products',async()=>{await admin('/admin/coupon',{code:'HALFBAC',brand:'glow',kind:'percent',value:50,minimum:0,max_uses:100,expires:0,active:1,products:'bac-water-10-ml'});const q=await quote([TRZ,BAC],'HALFBAC');assert.equal(q.coupon_discount,499)});
test('a limited fixed code never takes more than the listed products cost',async()=>{await admin('/admin/coupon',{code:'BIGBAC',brand:'glow',kind:'fixed',value:5000,minimum:0,max_uses:100,expires:0,active:1,products:'bac-water-10-ml'});const q=await quote([TRZ,BAC],'BIGBAC');assert.equal(q.coupon_discount,999)});
test('ordinary coupons still work on the whole bag',async()=>{const q=await quote([TRZ,BAC],'WHOLE');assert.equal(q.coupon_discount,500)});
test('saving from an older form without the field keeps the products; an empty field clears them',async()=>{const {products,...old}=family;await admin('/admin/coupon',old);assert.deepEqual((await transaction(s=>s.get('coupons','FAMILY'))).products,[9,3]);await admin('/admin/coupon',{...old,code:'CLEARME',products:'bac-water-10-ml'});await admin('/admin/coupon',{...old,code:'CLEARME',products:''});assert.deepEqual((await transaction(s=>s.get('coupons','CLEARME'))).products,[])});
test('unknown SKUs and other stores’ SKUs are refused',async()=>{await assert.rejects(admin('/admin/coupon',{...family,code:'BAD1',products:'nope-sku'}),/nope-sku/);await assert.rejects(admin('/admin/coupon',{...family,code:'BAD2',products:'zdr-bac-water-10-ml'}),/zdr-bac-water-10-ml/)});
test('an order placed with FAMILY is $35.00',async()=>{const o=(await call('/orders',{items:[TRZ,BAC],coupon:'FAMILY',payment_method:'zelle',customer,idempotency_key:crypto.randomUUID()})).body.order;assert.equal(o.total,3500);assert.equal(o.coupon,'FAMILY')});

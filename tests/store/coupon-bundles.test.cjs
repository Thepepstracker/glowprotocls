'use strict';
// FAMILY as set-price bundles (Jonah, 12 Nov 2026): any GLP-2T 10 mg and up + BAC Water 10 mL, $35 with shipping for 10 mg, +$15 a strength.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-coupon-bundles-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'coupon-bundles-fixture-password',STORE_SESSION_SECRET:'coupon-bundles-fixture-session-secret-longer-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs');
const call=(p,body,headers={})=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...headers},body:body||{}});let cookie;
const admin=(p,b)=>call(p,b,{cookie});
const customer={name:'Coupon Fixture',email:'coupon-bundles@example.test',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30101'};
const quote=(items,coupon='FAMILY')=>call('/quote',{items,coupon}).then(r=>r.body);
const TRZ={id:9,quantity:1},BAC={id:3,quantity:1},OTHER={id:5,quantity:1};
const family={code:'FAMILY',brand:'glow',kind:'fixed',value:3198,minimum:0,max_uses:100,expires:0,active:1,products:'tirz-10-10-mg, bac-water-10-ml'};
const T15={id:10,quantity:1},T20={id:11,quantity:1},T5={id:102,quantity:1};
const bundles='tirz-10-10-mg + bac-water-10-ml = 20.00; tirz-10-15-mg + bac-water-10-ml = 35.00; tirz-10-20-mg + bac-water-10-ml = 50.00';
before(async()=>{await transaction(async s=>{
 await s.put('settings','main',{demo:true,shipping_cents:1500,free_shipping_cents:25000,payment_links:{},tax_mode:'none',checkout_enabled:true});
 for(const [id,name,sku,price] of [[9,'GLP-2T · 10 mg','tirz-10-10-mg',4199],[10,'GLP-2T · 15 mg','tirz-10-15-mg',6800],[11,'GLP-2T · 20 mg','tirz-10-20-mg',7800],[102,'GLP-2T · 5 mg','glp-2t-5-mg',2899],[3,'BAC Water · 10 mL','bac-water-10-ml',999],[5,'BAC Water · 20 mL','bac-water-20-ml',1799]])
  await s.put('products',id,{id,name,sku,brand:'glow',price,stock:100,active:1,promo_excluded:false});
});cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await admin('/admin/coupon',{code:'FAMILY',brand:'glow',kind:'fixed',value:3198,minimum:0,max_uses:100,expires:0,active:1,products:'',bundles})});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('bundles save as product ids and cents',async()=>{const c=await transaction(s=>s.get('coupons','FAMILY'));assert.deepEqual(c.bundles,[{ids:[9,3],price:2000},{ids:[10,3],price:3500},{ids:[11,3],price:5000}]);assert.deepEqual(c.products,[])});
test('10 mg + BAC is still exactly $35.00 with shipping',async()=>{const q=await quote([TRZ,BAC]);assert.equal(q.coupon_discount,3198);assert.equal(q.total,3500)});
test('15 mg + BAC is $50.00 and 20 mg + BAC is $65.00',async()=>{assert.equal((await quote([T15,BAC])).total,5000);assert.equal((await quote([T20,BAC])).total,6500)});
test('5 mg is not part of FAMILY',async()=>{await assert.rejects(quote([T5,BAC]),/FAMILY only works with 2 items.*GLP-2T · 10 mg/)});
test('missing BAC Water is named',async()=>{await assert.rejects(quote([T20]),/Add: BAC Water · 10 mL/);await assert.rejects(quote([OTHER]),/only works/)});
test('one bundle per order: two strengths + one BAC takes the best one only, the rest is full price',async()=>{const q=await quote([T15,T20,BAC]);assert.equal(q.coupon_discount,6800+999-3500);assert.equal(q.total,6800+7800+999-(6800+999-3500)+1500)});
test('extra quantity is full price',async()=>{const q=await quote([{id:11,quantity:2},BAC]);assert.equal(q.coupon_discount,7800+999-5000);assert.equal(q.total,7800*2+999-(7800+999-5000)+1500)});
test('an order placed with FAMILY on 20 mg is $65.00',async()=>{const o=(await call('/orders',{items:[T20,BAC],coupon:'FAMILY',payment_method:'zelle',customer,idempotency_key:crypto.randomUUID()})).body.order;assert.equal(o.total,6500);assert.equal(o.coupon,'FAMILY')});
test('saving without the bundles field keeps them; an empty string clears them',async()=>{await admin('/admin/coupon',{code:'FAMILY',brand:'glow',kind:'fixed',value:3198,minimum:0,max_uses:100,expires:0,active:1});assert.equal((await transaction(s=>s.get('coupons','FAMILY'))).bundles.length,3);await admin('/admin/coupon',{code:'TMPB',brand:'glow',kind:'fixed',value:100,minimum:0,max_uses:100,expires:0,active:1,bundles:'bac-water-10-ml = 5'});await admin('/admin/coupon',{code:'TMPB',brand:'glow',kind:'fixed',value:100,minimum:0,max_uses:100,expires:0,active:1,bundles:''});assert.deepEqual((await transaction(s=>s.get('coupons','TMPB'))).bundles,[])});
test('bad bundle input is refused',async()=>{await assert.rejects(admin('/admin/coupon',{code:'BADB',brand:'glow',kind:'fixed',value:100,minimum:0,max_uses:100,expires:0,active:1,bundles:'nope-sku + bac-water-10-ml = 5'}),/nope-sku/);await assert.rejects(admin('/admin/coupon',{code:'BADB',brand:'glow',kind:'fixed',value:100,minimum:0,max_uses:100,expires:0,active:1,bundles:'bac-water-10-ml'}),/sku \+ sku = price/)});
test('FAMILY orders earn no Glow Points; the same bag without the code still does',async()=>{const q=await quote([T20,BAC]);assert.equal(q.points_to_earn,0);const plain=(await call('/quote',{items:[T20,BAC]})).body;assert.ok(plain.points_to_earn>0)});
test('FAMILY orders pay no affiliate commission',async()=>{await transaction(s=>s.put('affiliates','famtest',{slug:'famtest',name:'Fam Test',bio:'',goaffpro_id:'',commission_bps:1500,active:1,brand:'glow'}));const q=(await call('/quote',{items:[T20,BAC],coupon:'FAMILY',affiliate:'famtest'})).body;assert.equal(q.commission,0);const plain=(await call('/quote',{items:[T20,BAC],affiliate:'famtest'})).body;assert.ok(plain.commission>0,JSON.stringify({c:plain.commission,a:plain.affiliate}))});
test('Glow Points cannot be added on top of FAMILY',async()=>{await assert.rejects(call('/quote',{items:[T20,BAC],coupon:'FAMILY',points_redeemed:100}),/FAMILY is already our lowest price/)});

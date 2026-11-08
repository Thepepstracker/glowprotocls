'use strict';
// No doubling up on a sale (Jonah, 8 Nov 2026): an item at a sale price takes no promo code on top. Glow Points still work.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-sale-no-stack-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'sale-no-stack-fixture-password',STORE_SESSION_SECRET:'sale-no-stack-fixture-session-secret-longer-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs');
const call=(p,body)=>handle({path:p,method:'POST',headers:{'x-store-request':'1'},body:body||{}});
const quote=(items,coupon)=>call('/quote',{items,coupon}).then(r=>r.body);
const SALE={id:135,quantity:1},REG={id:9,quantity:1};
before(async()=>{await transaction(async s=>{
 await s.put('settings','main',{demo:true,shipping_cents:1500,free_shipping_cents:25000,payment_links:{},tax_mode:'none',checkout_enabled:true});
 await s.put('products',135,{id:135,name:'Melanotan 2 · 10 mg',sku:'mt2-10-mg',brand:'glow',price:2499,regular_price:3199,intro_price:2499,intro_active:true,stock:50,active:1,promo_excluded:false});
 await s.put('products',9,{id:9,name:'GLP-2T · 10 mg',sku:'tirz-10-10-mg',brand:'glow',price:4199,regular_price:4199,intro_price:null,intro_active:false,stock:50,active:1,promo_excluded:false});
 await s.put('products',8,{id:8,name:'Old intro',sku:'old-intro',brand:'glow',price:3000,regular_price:3000,intro_price:2000,intro_active:false,stock:50,active:1,promo_excluded:false});
 await s.put('coupons','TEN',{code:'TEN',brand:'glow',kind:'percent',value:10,minimum:0,max_uses:100,used:0,expires:0,active:1});
 await s.put('coupons','FIVE',{code:'FIVE',brand:'glow',kind:'fixed',value:500,minimum:0,max_uses:100,used:0,expires:0,active:1});
})});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('a sale item alone: the code takes nothing off and the bag says why',async()=>{const q=await quote([SALE],'TEN');assert.equal(q.subtotal,2499);assert.equal(q.coupon_discount,0);assert.equal(q.coupon_eligible_subtotal,0);assert.equal(q.items[0].on_sale,true);assert.equal(q.items[0].promo_excluded,true)});
test('sale + regular item: the code only applies to the regular item',async()=>{const q=await quote([SALE,REG],'TEN');assert.equal(q.coupon_eligible_subtotal,4199);assert.equal(q.coupon_discount,419);const f=await quote([SALE,REG],'FIVE');assert.equal(f.coupon_discount,500)});
test('a fixed code cannot spill its value onto the sale item',async()=>{await transaction(s=>s.put('coupons','BIG',{code:'BIG',brand:'glow',kind:'fixed',value:10000,minimum:0,max_uses:100,used:0,expires:0,active:1}));const q=await quote([SALE,REG],'BIG');assert.equal(q.coupon_discount,4199)});
test('regular-priced items keep working exactly as before, including a switched-off intro price',async()=>{const q=await quote([REG,{id:8,quantity:1}],'TEN');assert.equal(q.coupon_eligible_subtotal,7199);assert.equal(q.coupon_discount,719);assert.ok(!q.items.some(i=>i.on_sale))});

'use strict';
// Re-price (29 Oct 2026): the owner can put a different set of codes on an order that is not paid yet.
// Same items, same affiliate, code usage and stock stay exact, and the customer gets no email.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-reprice-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'reprice-tests-session-secret-more-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];let emails=0;const oldFetch=global.fetch;
global.fetch=async()=>{emails++;return{ok:true,status:200,json:async()=>({id:'x'})}};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
test('owner re-prices an unpaid order with two codes; usage and stock stay exact; no email',async()=>{
 await transaction(seed);
 const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 const ps=await transaction(async s=>(await s.list('products')).filter(x=>x.active&&!x.components&&!(x.units>1)&&x.stock>=5&&!x.promo_excluded).slice(0,2));
 const [a,b]=ps;
 await transaction(async s=>{
  await s.put('coupons','FREEB',{code:'FREEB',kind:'percent',value:100,products:[b.id],allow_stacking:true,brand:'glow',affiliate:null,minimum:0,max_uses:1,used:1,expires:0,active:1});
  await s.put('coupons','THIRTYA',{code:'THIRTYA',kind:'percent',value:30,products:[a.id],allow_stacking:true,brand:'glow',affiliate:null,minimum:0,max_uses:1,used:0,expires:0,active:1});
  await s.put('orders','GLP-AAAAAAAAAA',{id:'GLP-AAAAAAAAAA',created:1,status:'order_received',is_test:false,brand:'glow',customer:{name:'C',email:'c@example.com',address:'1 St',city:'X',state:'GA',zip:'30107'},
   items:[{id:a.id,name:a.name,sku:a.sku,quantity:1,price:a.price,amount:a.price},{id:b.id,name:b.name,sku:b.sku,quantity:1,price:b.price,amount:b.price}],
   subtotal:a.price+b.price,discount:b.price,coupon_discount:b.price,coupon:'FREEB',coupons:['FREEB'],shipping:1500,total:a.price+1500,points_redeemed:0,payment_method:'card_invoice',goaffpro_status:'not_applicable'});
 });
 const stockA=(await transaction(s=>s.get('products',a.id))).stock,stockB=(await transaction(s=>s.get('products',b.id))).stock;
 await assert.rejects(call('/admin/order/reprice',{id:'GLP-AAAAAAAAAA',confirm:'GLP-AAAAAAAAAA',coupons:['FREEB','THIRTYA']}),e=>e.status===401);
 await assert.rejects(call('/admin/order/reprice',{id:'GLP-AAAAAAAAAA',confirm:'nope',coupons:['FREEB','THIRTYA']},owner),/confirm/);
 emails=0;const r=await call('/admin/order/reprice',{id:'GLP-AAAAAAAAAA',confirm:'GLP-AAAAAAAAAA',coupons:['FREEB','THIRTYA']},owner);
 const off=Math.floor(a.price*30/100);
 assert.equal(r.body.after.total,a.price-off+1500);assert.equal(r.body.before.total,a.price+1500);assert.equal(emails,0,'no email');
 const o=await transaction(s=>s.get('orders','GLP-AAAAAAAAAA'));
 assert.equal(o.status,'order_received');assert.equal(o.total,a.price-off+1500);assert.deepEqual(o.coupons,['FREEB','THIRTYA']);assert.match(o.staff_notes.at(-1).text,/Re-priced/);
 assert.equal((await transaction(s=>s.get('coupons','FREEB'))).used,1,'FREEB not double counted');
 assert.equal((await transaction(s=>s.get('coupons','THIRTYA'))).used,1);
 assert.equal((await transaction(s=>s.get('products',a.id))).stock,stockA,'stock unchanged');
 assert.equal((await transaction(s=>s.get('products',b.id))).stock,stockB);
 await transaction(async s=>{const x=await s.get('orders','GLP-AAAAAAAAAA');x.status='paid';await s.put('orders',x.id,x)});
 await assert.rejects(call('/admin/order/reprice',{id:'GLP-AAAAAAAAAA',confirm:'GLP-AAAAAAAAAA',coupons:[]},owner),e=>e.status===409,'never a paid order');
});

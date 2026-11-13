'use strict';
// Staff price on "Order for a customer" (Jonah, 13 Nov 2026, Jen French: one Kisspeptin, 10% off, no shipping).
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-staffprice-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'staff-price-owner-password',STORE_SESSION_SECRET:'staff-price-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d}),stripe=[];const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');const p=u.slice(25),b=new URLSearchParams(opts.body||'');stripe.push({p,b});
 if(p==='/customers'&&(opts.method||'GET')==='GET')return ok({data:[]});if(p.startsWith('/customers'))return ok({id:'cus_sp'});if(p==='/invoiceitems')return ok({id:'ii_sp'});if(p==='/invoices')return ok({id:'in_sp',status:'draft'});
 if(p.startsWith('/invoices/in_sp/finalize'))return ok({id:'in_sp',status:'open',hosted_invoice_url:'https://invoice.stripe.com/i/sp',amount_due:Number(stripe.filter(c=>c.p==='/invoiceitems').at(-1)?.b.get('amount'))});
 if(p.startsWith('/invoices/in_sp/send'))return ok({id:'in_sp',status:'open',hosted_invoice_url:'https://invoice.stripe.com/i/sp'});if(p.startsWith('/invoices/'))return ok({id:'in_sp',status:'open',hosted_invoice_url:'https://invoice.stripe.com/i/sp'});
 throw new Error('unmocked '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const customer={name:'Jen Test',email:'jen.staffprice@example.test',phone:'2185550123',address:'1 Lake St',city:'Fergus Falls',state:'MN',zip:'56537'};
let owner;
async function setup(){await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{},auto_invoice:true,auto_invoice_since:1});await s.put('products',122,{id:122,brand:'glow',sku:'kisspeptin-10-mg',name:'Kisspeptin · 10 mg',price:3499,stock:10,active:1})});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]}
const order=(x,cookie)=>call('/orders',{items:[{id:122,quantity:1}],customer,payment_method:'card_invoice',order_for_customer:true,idempotency_key:crypto.randomUUID(),...x},cookie);

test('Jen\'s order: one Kisspeptin, 10% off, no shipping = $31.49, and that is what the order saves',async()=>{
 await setup();const r=(await order({staff_price:{pct:10,no_shipping:true}},owner)).body;const o=await transaction(s=>s.get('orders',r.order.id));
 assert.deepEqual([o.subtotal,o.discount,o.coupon_discount,o.shipping,o.total],[3499,350,350,0,3149]);
 assert.deepEqual(o.staff_price,{pct:10,discount_cents:350,no_shipping:true,shipping_waived_cents:1500,by:'owner'});
 assert.equal(o.order_for_customer,true);assert.equal(o.points_to_earn,31);
 const items=stripe.filter(c=>c.p==='/invoiceitems');assert.ok(items.length,'a card invoice was made');assert.equal(Number(items.at(-1).b.get('amount')),3149,'the card invoice is for the staff price');
});

test('without a staff price nothing changes; customers cannot send one; bad values are refused',async()=>{
 const r=(await order({},owner)).body;const o=await transaction(s=>s.get('orders',r.order.id));assert.deepEqual([o.discount,o.shipping,o.total],[0,1500,4999]);assert.equal(o.staff_price,undefined);
 await assert.rejects(call('/orders',{items:[{id:122,quantity:1}],customer,payment_method:'card_invoice',idempotency_key:crypto.randomUUID(),staff_price:{pct:50,no_shipping:true}}),/Only the team/);
 await assert.rejects(order({staff_price:{pct:60}},owner),/0 to 50/);await assert.rejects(order({staff_price:{pct:2.5}},owner),/whole percent/);
 await assert.rejects(order({staff_price:{pct:10}}),/sign in|Sign in|log in|Unauthorized/i,'order for a customer still needs a team sign-in');
});

test('shipping only, and a later item edit keeps the staff discount',async()=>{
 const r=(await order({staff_price:{no_shipping:true}},owner)).body;let o=await transaction(s=>s.get('orders',r.order.id));assert.deepEqual([o.discount,o.shipping,o.total],[0,0,3499]);
 const r2=(await order({staff_price:{pct:10}},owner)).body;o=await transaction(s=>s.get('orders',r2.order.id));assert.deepEqual([o.discount,o.shipping,o.total],[350,1500,4649]);
 // The team edits the first one to 2 vials with the promo discount it shows (the staff discount) kept.
 const r3=(await order({staff_price:{pct:10,no_shipping:true}},owner)).body;o=await transaction(s=>s.get('orders',r3.order.id));
 const e=(await call('/admin/order/items',{id:o.id,expected_revision:o.revision||0,reason:'two vials',items:[{id:122,quantity:2,price:3499}],coupon_discount:o.coupon_discount,shipping:o.shipping,tax:0},owner)).body;
 const x=await transaction(s=>s.get('orders',o.id));assert.deepEqual([x.subtotal,x.discount,x.shipping,x.total],[6998,350,0,6648]);assert.ok(e);
});

'use strict';
// Gift lists (Jonah, 18 Nov 2026): customers make a list and share it; friends buy from it; it ships to the owner;
// the buyer only sees first name + city/state; gift message on the slip; thank-you points to the owner.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-gifts-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'gift-list-fixture-password',STORE_SESSION_SECRET:'gift-list-fixture-session-secret-longer-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const gifts=require('../../netlify/functions/lib/gift-registry.cjs'),shippo=require('../../netlify/functions/lib/shippo.cjs');
const call=(p,body,cookie)=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:body||{}}).catch(e=>({status:e.status||500,body:{error:e.message}}));
const N=()=>Math.floor(Date.now()/1000);
async function person(email,name){const id=accounts.hash(email),token=crypto.randomBytes(24).toString('base64url');
 await transaction(async s=>{await s.put('customers',id,{id,email,name,created:N(),verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:N()+3600})});
 return{id,cookie:'glow_next_customer='+token}}
const HOME={name:'Bria Owner',address:'42 Holly Lane',city:'Canton',state:'GA',zip:'30114'};
let bria,sam,list;
before(async()=>{await transaction(async s=>{
 await s.put('settings','main',{demo:false,shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'pay@example.test'},tax_mode:'none',checkout_enabled:true});
 await s.put('products',9,{id:9,name:'GLP-2T · 10 mg',sku:'tirz-10-10-mg',brand:'glow',price:4199,stock:100,active:1,promo_excluded:false});
 await s.put('products',10,{id:10,name:'BAC Water · 10 mL',sku:'bac-water-10-ml',brand:'glow',price:999,stock:100,active:1,promo_excluded:false});
 await s.put('products',11,{id:11,name:'Retired',sku:'old',brand:'glow',price:999,stock:0,active:0});
});bria=await person('bria@example.test','Bria Owner');sam=await person('sam@example.test','Sam Buyer')});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('an owner makes a list: needs sign-in and a full address; inactive products are dropped',async()=>{
 assert.equal((await call('/account/registries/save',{title:'x'})).status,401);
 const bad=await call('/account/registries/save',{title:'Xmas',items:[{id:9}],ship_to:{...HOME,zip:'1'}},bria.cookie);assert.equal(bad.status,400);assert.match(bad.body.error,/ZIP/);
 const r=await call('/account/registries/save',{title:'Bria’s Christmas list',occasion:'christmas',note:'Thank you!',items:[{id:9,want:2},{id:10,want:1},{id:11,want:1},{id:9,want:5}],ship_to:HOME},bria.cookie);
 assert.equal(r.status,200);list=r.body;assert.match(list.id,/^[a-z0-9]{10}$/);assert.deepEqual(list.items.map(i=>[i.id,i.want,i.gifted]),[[9,2,0],[10,1,0]]);assert.equal(list.ship_to.zip,'30114');
 const mine=await call('/account/registries',undefined,bria.cookie);assert.equal(mine.body.lists.length,1);
 const notMine=await call('/account/registries/save',{id:list.id,title:'hijack',ship_to:HOME},sam.cookie);assert.equal(notMine.status,404,'someone else cannot edit it');
});

test('anyone with the link sees first name, city and state only',async()=>{
 const v=await call('/registry/'+list.id);assert.equal(v.status,200);const txt=JSON.stringify(v.body);
 assert.equal(v.body.owner_first,'Bria');assert.equal(v.body.city,'Canton');assert.equal(v.body.state,'GA');assert.equal(v.body.mine,false);
 for(const secret of ['Holly','30114','bria@example.test','Owner'])assert.ok(!txt.includes(secret),'public list leaks '+secret);
 assert.equal((await call('/registry/'+list.id,undefined,bria.cookie)).body.mine,true);
 assert.equal((await call('/registry/zzzzzzzzzz')).status,404);
});

test('a gift order ships to the owner; the buyer never gets the street; only list items allowed',async()=>{
 const base={payment_method:'zelle',registry:list.id,gift_message:'Merry Christmas, Bria! Love, Sam',customer:{name:'Sam Buyer',email:'sam@example.test',phone:'2025550199',address:'9 Sam St',city:'Elsewhere',state:'TX',zip:'75001'}};
 const off=await call('/orders',{...base,items:[{id:9,quantity:1},{id:11,quantity:1}],idempotency_key:crypto.randomUUID()},sam.cookie);assert.equal(off.status,400);
 const r=await call('/orders',{...base,items:[{id:9,quantity:1}],idempotency_key:crypto.randomUUID()},sam.cookie);assert.equal(r.status,201,JSON.stringify(r.body));
 const pub=r.body.order;assert.equal(pub.customer.address,'');assert.equal(pub.customer.zip,'');assert.equal(pub.customer.city,'Canton');assert.equal(pub.gift.to_first,'Bria');assert.equal(pub.gift.to_name,undefined);assert.equal(pub.gift.owner_id,undefined);
 assert.ok(!JSON.stringify(pub).includes('Holly')&&!JSON.stringify(pub).includes('9 Sam St'));
 const o=await transaction(s=>s.get('orders',pub.id));assert.equal(o.customer.address,'42 Holly Lane','the label address is the owner’s');assert.equal(o.customer.zip,'30114');assert.equal(o.customer.email,'sam@example.test','emails still go to the buyer');
 assert.equal(o.gift.message,'Merry Christmas, Bria! Love, Sam');assert.equal(o.gift.occasion,'christmas','the slip card knows the occasion');
 const rude=await call('/orders',{...base,gift_message:'Merry f*cking Christmas',items:[{id:9,quantity:1}],idempotency_key:crypto.randomUUID()},sam.cookie);assert.equal(rude.status,400);assert.match(rude.body.error,/keep the gift note friendly/);assert.equal(o.gift.from_name,'Sam Buyer');assert.equal(o.gift.owner_id,bria.id);
 assert.notEqual((await call('/orders/'+pub.id)).status,200,'needs the order token');
 const g=await handle({path:'/orders/'+pub.id,method:'GET',headers:{'x-store-request':'1','x-order-token':r.body.token},body:{}}).catch(e=>({status:e.status,body:{}}));assert.equal(g.status,200);assert.equal(g.body.customer.address,'');assert.equal(g.body.gift.to_first,'Bria');
 const g2=await call('/orders/'+pub.id,undefined,sam.cookie);assert.equal(g2.status,200);assert.equal(g2.body.customer.zip,'');
 const lst=await call('/registry/'+list.id);assert.equal(lst.body.items.find(i=>i.id===9).gifted,1,'counts as gifted while open');
});

test('the Shippo label is addressed to the owner by name and street',async()=>{
 const o=(await transaction(s=>s.list('orders'))).find(x=>x.gift);const to=shippo.shipmentBody(o,{parcel:{length:6,width:4,height:2,weight_lb:1}}).address_to;
 assert.equal(to.name,'Bria Owner');assert.equal(to.street1,'42 Holly Lane');assert.equal(to.zip,'30114');
});

test('thank-you points: owner earns on payment, loses them when unpaid by mistake',async()=>{
 const o=(await transaction(s=>s.list('orders'))).find(x=>x.gift);
 await transaction(async s=>{const x=await s.get('orders',o.id);x.status='paid';x.paid=N();await accounts.paid(s,x);await s.put('orders',x.id,x)});
 let w=await transaction(s=>accounts.wallet(s,bria.id));assert.equal(w.balance,gifts.thanksFor(o));assert.ok(w.balance>=41);
 const r=await transaction(s=>s.get('registries',list.id));assert.equal(r.thanks_points,w.balance);
 await transaction(async s=>{const x=await s.get('orders',o.id);await accounts.paid(s,x);await s.put('orders',x.id,x)});w=await transaction(s=>accounts.wallet(s,bria.id));assert.equal(w.balance,gifts.thanksFor(o),'not twice');
 await transaction(async s=>{const x=await s.get('orders',o.id);await accounts.unpaid(s,x);x.status='payment_submitted';await s.put('orders',x.id,x)});
 w=await transaction(s=>accounts.wallet(s,bria.id));assert.equal(w.balance,0);
});

test('a closed list takes no new gift orders',async()=>{
 await call('/account/registries/save',{id:list.id,title:list.title,items:list.items,ship_to:HOME,closed:true},bria.cookie);
 const r=await call('/orders',{payment_method:'zelle',registry:list.id,items:[{id:10,quantity:1}],customer:{name:'Sam Buyer',email:'sam@example.test',phone:'2025550199'},idempotency_key:crypto.randomUUID()},sam.cookie);
 assert.equal(r.status,404);assert.match(r.body.error,/closed/);
});

test('the app has the gift list pages, gift checkout and the slip message',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../../store-next/app.js'),'utf8'),pack=fs.readFileSync(path.join(__dirname,'../../store-next/packing.html'),'utf8');
 for(const s of ['function loadRegistry','registry:giftOrder.slug','gift_message','/api/account/registries/save'])assert.ok(app.includes(s),s);
 assert.ok(pack.includes('o.gift'),'packing slip knows about gifts');
});

test('the live server opens the app for a gift list link',()=>{
 const srv=require('../../tools/sevalla/server.cjs');
 assert.equal(srv.publicFile('/store-next/registry/abcdefghij'),'store-next/index.html');
 assert.equal(srv.publicFile('/store-next/registry'),'store-next/index.html');
});
test('saving: full state names and 9-digit ZIPs are accepted; an empty list is refused with a plain message',async()=>{
 const r=await call('/account/registries/save',{title:'Name test',items:[{id:9}],ship_to:{...HOME,state:'Georgia',zip:'301141234'}},bria.cookie);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.ship_to.state,'GA');assert.equal(r.body.ship_to.zip,'30114-1234');
 const e=await call('/account/registries/save',{title:'Empty',items:[],ship_to:HOME},bria.cookie);assert.equal(e.status,400);assert.match(e.body.error,/at least one product/);
 const gone=await call('/account/registries/save',{title:'Gone',items:[{id:11}],ship_to:HOME},bria.cookie);assert.equal(gone.status,400);assert.match(gone.body.error,/aren’t in the store right now/);
});

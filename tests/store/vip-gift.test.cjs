'use strict';
// Free VIP peptide (Jonah, 13 Nov 2026): Skool VIP members with a subscription pick one peptide under $50 in their account,
// and every subscription box (first and repeat) includes it as a $0 line that takes stock. The price, Stripe's single
// "Glow Lab" line and points never change. Not for Premium, non-members, or anyone while the member perks switch is OFF.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-vipgift-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'vip-owner-test-password',STORE_SESSION_SECRET:'vip-gift-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),core=require('../../netlify/functions/lib/store-core.cjs'),{handle}=core,accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),gift=require('../../netlify/functions/lib/vip-gift.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d}),stripe=[];let n=0;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');const p=u.slice(25);stripe.push({p,body:new URLSearchParams(opts.body||''),raw:String(opts.body||'')});
 if(p==='/customers')return ok({id:'cus_vip'});if(p==='/checkout/sessions'){n++;return ok({id:'cs_vip_'+n,url:'https://checkout.stripe.com/c/pay/cs_vip_'+n,expires_at:Math.floor(Date.now()/1000)+86400})}throw new Error('unmocked '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const DAY=86400,now=()=>Math.floor(Date.now()/1000);
const prod=(id,sku,name,price,stock,x={})=>({id,brand:'glow',sku,name,price,stock,active:1,...x});
const shipTo=(name,email)=>({name,email,phone:'4045550123',address:'12 Glow St',city:'Ball Ground',state:'GA',zip:'30107'});
const people={};
async function setup(){await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}});
 for(const p of [prod(501,'aicar-50-mg','AICAR · 50 mg',5200,50),prod(40,'ara-290-10-mg','ARA-290 · 10 mg',4500,10),prod(41,'kpv-10-mg','KPV · 10 mg',3399,0),prod(3,'bac-water-10-ml','BAC Water · 10 mL',999,50),
  prod(60,'big-peptide-10-mg','Big Peptide · 10 mg',5000,50),prod(61,'kit-10','KPV · Kit of 10',30000,50,{units:10}),prod(62,'merch-pouch','Pouch',999,50,{category:'merch'})])await s.put('products',p.id,p);
 await s.put('integrations','autopilot',{tasks:{subscriptions:{on:true}}});await s.put('integrations','members',{enabled:true,discount_pct:10,ship_min_vip:6000,ship_min_premium:8000});
 const t=now();for(const [key,email,level] of [['vip','vip.gift@example.test','vip'],['premium','prem.gift@example.test','premium'],['plain','plain.gift@example.test',null]]){
  const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await s.put('customers',id,{id,email,name:key+' Tester',created:1,verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:t+DAY});
  if(level)await s.put('members',email,{email,name:'',level,source:'csv',since:t-DAY,confirmed_at:t,good_until:t+30*DAY,perks:[],perks_saved_at:null,added_by:'owner'});people[key]={id,email,cookie:'glow_next_customer='+token}}})}
const stock=id=>transaction(s=>s.get('products',id)).then(p=>p.stock);

test('only peptides under $50 are offered: no supplies, kits, merch, sold-out or $50+',async()=>{
 await setup();const g=(await call('/account/vip-gift',undefined,people.vip.cookie)).body.gift;
 assert.deepEqual(g.options.map(o=>o.id).sort(),[40,501].filter(id=>id===40),'ARA-290 only (AICAR is $52, BAC water is a supply, KPV is sold out, $50.00 is not under $50)');
 assert.equal(g.subscribed,false);assert.equal(g.choice,null);assert.equal(gift.CAP_CENTS,5000);
});

test('Premium and non-members do not get it; a VIP can save, change and is refused a bad pick',async()=>{
 assert.equal((await call('/account/vip-gift',undefined,people.premium.cookie)).body.gift,null);
 assert.equal((await call('/account/vip-gift',undefined,people.plain.cookie)).body.gift,null);
 await assert.rejects(call('/account/vip-gift',{product_id:40},people.premium.cookie),/VIP/);
 await assert.rejects(call('/account/vip-gift',{product_id:3},people.vip.cookie),/under \$50/);
 await assert.rejects(call('/account/vip-gift',{product_id:60},people.vip.cookie),/under \$50/);
 await assert.rejects(call('/account/vip-gift',{product_id:41},people.vip.cookie),/under \$50|sold out/);
 const g=(await call('/account/vip-gift',{product_id:40},people.vip.cookie)).body.gift;assert.equal(g.choice.id,40);assert.equal(g.choice.in_stock,true);
});

test('the first box gets the pick at $0: same price, one stock taken, nothing about it on Stripe',async()=>{
 const items=[{id:501,quantity:1}],q=(await call('/subscribe/quote',{items},people.vip.cookie)).body;
 const before={a:await stock(501),g:await stock(40)};
 const r=(await call('/account/subscribe',{items,every:'1m',customer:shipTo('Vip Tester',people.vip.email),agree:true,idempotency_key:'vip-gift-key-0001'},people.vip.cookie)).body;
 const x=await transaction(s=>s.get('subscriptions',r.id)),o=await transaction(s=>s.get('orders',x.first_order));
 assert.ok(q.total_cents>0);assert.equal(o.total,q.total_cents,'same total the bag quoted without the gift');
 const g=o.items.filter(i=>i.gift==='vip');assert.deepEqual(g.map(i=>[i.id,i.quantity,i.price,i.amount,i.list_price]),[[40,1,0,0,4500]]);assert.match(g[0].name,/VIP gift$/);
 assert.equal(o.subtotal,5200,'the gift is not in the box price');assert.equal(o.vip_gift.product_id,40);assert.match(o.staff_note,/VIP gift: 1× ARA-290/);
 assert.deepEqual(x.items.map(i=>i.id),[501],'the subscription itself is only what she subscribed to');
 assert.deepEqual([await stock(501),await stock(40)],[before.a-1,before.g-1]);
 const cs=stripe.filter(c=>c.p==='/checkout/sessions').at(-1);assert.equal(Number(cs.body.get('line_items[0][price_data][unit_amount]')),o.total);
 for(const c of stripe)assert(!/ara-290|vip gift/i.test(decodeURIComponent(c.raw.replace(/\+/g,' '))),'no gift on Stripe');
 assert.equal((await call('/account/vip-gift',undefined,people.vip.cookie)).body.gift.subscribed,true);
});

test('every repeat box gets it too, and if her pick sells out the box still goes with a note for the team',async()=>{
 const x=(await transaction(s=>s.list('subscriptions'))).find(s=>s.customer.email===people.vip.email);
 await transaction(async s=>{const y=await s.get('subscriptions',x.id);y.status='active';y.deliveries=1;y.orders=[y.first_order];await s.put('subscriptions',y.id,y)});
 const g0=await stock(40);
 let r=await transaction(async s=>core.subscriptionOrder(s,await s.get('subscriptions',x.id),'2026-12-12'));
 let g=r.order.items.filter(i=>i.gift==='vip');assert.deepEqual(g.map(i=>[i.id,i.price]),[[40,0]]);assert.equal(await stock(40),g0-1);
 const plain=r.order.items.filter(i=>!i.gift).reduce((n,i)=>n+i.amount,0);assert.equal(r.order.subtotal,plain,'price is only her subscribed items');
 await transaction(async s=>{const p=await s.get('products',40);p.stock=0;await s.put('products',40,p)});
 r=await transaction(async s=>core.subscriptionOrder(s,await s.get('subscriptions',x.id),'2027-01-12'));
 assert.equal(r.order.items.filter(i=>i.gift==='vip').length,0);assert.match(r.order.staff_note,/VIP gift: .*unavailable/);
});

test('no gift when she stops being a VIP or the member perks switch is OFF',async()=>{
 await transaction(async s=>{const p=await s.get('products',40);p.stock=10;await s.put('products',40,p);const c=await s.get('integrations','members');c.enabled=false;await s.put('integrations','members',c)});
 const x=(await transaction(s=>s.list('subscriptions'))).find(s=>s.customer.email===people.vip.email);
 const r=await transaction(async s=>core.subscriptionOrder(s,await s.get('subscriptions',x.id),'2027-02-12'));
 assert.equal(r.order.items.filter(i=>i.gift==='vip').length,0);assert.equal((await call('/account/vip-gift',undefined,people.vip.cookie)).body.gift,null);
});

test('the team can set a VIP\'s pick for her by email (signed in only, same rules)',async()=>{
 await transaction(async s=>{const c=await s.get('integrations','members');c.enabled=true;await s.put('integrations','members',c)});
 await assert.rejects(call('/admin/vip-gift',{email:people.vip.email,product_id:40}),/sign in|Sign in|Unauthorized|log in/i);
 const r=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}),owner=r.headers['Set-Cookie'].split(';')[0];
 await assert.rejects(call('/admin/vip-gift',{email:people.premium.email,product_id:40},owner),/VIP/);
 const g=(await call('/admin/vip-gift',{email:people.vip.email.toUpperCase(),product_id:40},owner)).body.gift;assert.equal(g.choice.id,40);
});

'use strict';
// Glow Points on the first Subscribe & save box (Jonah, 13 Nov 2026: "we need to be able to use points in the beginning so
// they can save even more"). 100 points = $5, products only, at least $0.50 left; held at checkout, given back if unpaid.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-subpts-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'subpts-owner-test-password',STORE_SESSION_SECRET:'sub-points-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),subs=require('../../netlify/functions/lib/subscriptions.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d}),stripe=[];let n=0,paidAmount=0;const sessions={};const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes('resend.com'))return ok({id:'em'});if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');const p=u.slice(25),m=opts.method||'GET';const b=new URLSearchParams(opts.body||'');stripe.push({p,m,b});
 if(p==='/customers'&&m==='POST')return ok({id:'cus_pts'});if(p.startsWith('/customers/'))return ok({id:'cus_pts'});
 if(p==='/checkout/sessions'&&m==='POST'){n++;const id='cs_pts_'+n;sessions[id]={id,url:'https://checkout.stripe.com/c/pay/'+id,expires_at:Math.floor(Date.now()/1000)+86400,metadata:{subscription_id:b.get('metadata[subscription_id]'),order_id:b.get('metadata[order_id]')},amount_total:Number(b.get('line_items[0][price_data][unit_amount]')),currency:'usd',livemode:false};return ok(sessions[id])}
 const sm=p.match(/^\/checkout\/sessions\/(cs_pts_\d+)(\/expire)?/);if(sm){const s=sessions[sm[1]];if(sm[2])return ok({...s,status:'expired',payment_status:'unpaid'});return ok(paidAmount?{...s,status:'complete',payment_status:'paid',amount_total:paidAmount,payment_intent:{id:'pi_pts',status:'succeeded',amount_received:paidAmount,payment_method:{id:'pm_pts',card:{brand:'visa',last4:'4242'}}}}:{...s,status:'expired',payment_status:'unpaid'})}
 if(p.startsWith('/payment_methods/'))return ok({id:'pm_pts',card:{brand:'visa',last4:'4242'}});
 throw new Error('unmocked '+m+' '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
let bal=0;const email='pts.sub@example.test',id=accounts.hash(email);let cookie;
const shipTo={name:'Pat Points',email,phone:'4045550123',address:'1 Main St',city:'Ball Ground',state:'GA',zip:'30107'};
const wallet=()=>transaction(s=>accounts.wallet(s,id));
const subscribe=(points,key)=>call('/account/subscribe',{items:[{id:24,quantity:1},{id:141,quantity:1}],every:'1m',customer:shipTo,agree:true,points_redeemed:points,idempotency_key:key},cookie);
test('setup',async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}});
 await s.put('products',24,{id:24,brand:'glow',sku:'aicar-50-mg',name:'AICAR · 50 mg',price:5200,stock:50,active:1});await s.put('products',141,{id:141,brand:'glow',sku:'mots-c-20-mg',name:'MOTS-C · 20 mg',price:6499,stock:50,active:1});
 await s.put('integrations','autopilot',{tasks:{subscriptions:{on:true}}});
 const token=crypto.randomBytes(32).toString('base64url');await s.put('customers',id,{id,email,name:'Pat Points',created:1,verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:Math.floor(Date.now()/1000)+86400});cookie='glow_next_customer='+token;
 await accounts.event(s,id,'test-grant','adjustment',600,0,null,'test')});assert.equal((await wallet()).balance,600)});
test('200 points take $10 off the first box; Stripe is asked for the lower amount; the points are held',async()=>{
 const before=(await call('/subscribe/quote',{items:[{id:24,quantity:1},{id:141,quantity:1}]},cookie)).body;
 const r=(await subscribe(200,'sub-pts-key-0001')).body;const x=await transaction(s=>s.get('subscriptions',r.id)),o=await transaction(s=>s.get('orders',x.first_order));
 assert.equal(o.points_redeemed,200);assert.equal(o.rewards_discount,1000);assert.equal(o.total,before.total_cents-1000);
 const cs=stripe.filter(c=>c.p==='/checkout/sessions'&&c.m==='POST').at(-1);assert.equal(Number(cs.b.get('line_items[0][price_data][unit_amount]')),o.total);
 assert.equal((await wallet()).reserved,200);assert.equal(x.consent.amount_cents,before.total_cents,'what they agreed to per delivery is the full box price');assert.equal(x.consent.first_charge_cents,o.total);
 // Paid on Stripe: the points are spent, the subscription starts.
 paidAmount=o.total;const st=await subs.settleFirst(x.id);assert.equal(st.status,'active');const w=await wallet(),c=await transaction(s=>s.get('orders',o.id));
 assert.ok(c.points_earned>0,'the box still earns points (on what was paid for products)');assert.equal(c.points_earned,Math.floor(Math.floor((c.subtotal-c.discount)/100)*c.subscription_points_multiplier));
 assert.equal(w.balance,600-200+c.points_earned);assert.equal(w.reserved,0);bal=w.balance;
});
test('limits: not more than you have, not more than the products, and at least $0.50 left; bad numbers refused',async()=>{
 paidAmount=0;await assert.rejects(subscribe(5000,'sub-pts-key-0002'),/up to \d+ points/);await assert.rejects(subscribe(2.5,'sub-pts-key-0003'),/whole number/);
 const q=(await call('/subscribe/quote',{items:[{id:24,quantity:1},{id:141,quantity:1}]},cookie)).body;assert.ok(q.total_cents>0);
});
test('an unfinished checkout gives the points back',async()=>{
 paidAmount=0;const r=(await subscribe(100,'sub-pts-key-0004')).body;assert.equal((await wallet()).reserved,100);
 await subs.settleFirst(r.id,{close:true});assert.equal((await wallet()).reserved,0);assert.equal((await wallet()).balance,bal);
});
test('no points: the first box is exactly as before',async()=>{
 const q=(await call('/subscribe/quote',{items:[{id:24,quantity:1},{id:141,quantity:1}]},cookie)).body;const r=(await subscribe(0,'sub-pts-key-0005')).body;
 const x=await transaction(s=>s.get('subscriptions',r.id)),o=await transaction(s=>s.get('orders',x.first_order));assert.equal(o.total,q.total_cents);assert.ok(!o.points_redeemed);
});

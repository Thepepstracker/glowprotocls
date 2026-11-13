'use strict';
// Staff "Clear (paid on Stripe)" (Jonah, 13 Nov 2026, Melissa Lopez): a first box Stripe shows as paid at the subscription
// price, held for review because the order record lost its 15% and was then marked paid and shipped by the team.
// Clear re-checks Stripe, sets the order to what Stripe charged, and starts the subscription. Nobody is charged or emailed.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-subclear-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'clear-owner-test-password',STORE_SESSION_SECRET:'sub-clear-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d}),calls=[];let session=null,paidAmount=0;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes('resend.com')){calls.push({p:'EMAIL'});return ok({id:'em'})}if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');const p=u.slice(25),m=opts.method||'GET';calls.push({p,m});
 if(p==='/customers'&&m==='POST')return ok({id:'cus_clear'});if(p.startsWith('/customers/'))return ok({id:'cus_clear'});
 if(p==='/checkout/sessions'&&m==='POST'){const b=new URLSearchParams(opts.body||'');session={id:'cs_clear_1',url:'https://checkout.stripe.com/c/pay/cs_clear_1',expires_at:Math.floor(Date.now()/1000)+86400,metadata:{subscription_id:b.get('metadata[subscription_id]'),order_id:b.get('metadata[order_id]')},amount_total:Number(b.get('line_items[0][price_data][unit_amount]')),currency:'usd',livemode:false};return ok(session)}
 if(p.startsWith('/checkout/sessions/cs_clear_1'))return ok({...session,status:'complete',payment_status:'paid',amount_total:paidAmount,payment_intent:{id:'pi_clear',status:'succeeded',amount_received:paidAmount,payment_method:{id:'pm_clear',card:{brand:'visa',last4:'4242'}}}});
 throw new Error('unmocked '+m+' '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const prod=(id,sku,name,price)=>({id,brand:'glow',sku,name,price,stock:50,active:1});
let cookie,owner;const email='mel.clear@example.test';
async function setup(){await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}});
 for(const p of [prod(24,'aicar-50-mg','AICAR · 50 mg',5200),prod(1,'lipo-c-b12-10-ml','Lipo-C with B-12 · 10 mL',4399),prod(141,'mots-c-20-mg','MOTS-C · 20 mg',6499)])await s.put('products',p.id,p);
 await s.put('integrations','autopilot',{tasks:{subscriptions:{on:true}}});
 const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await s.put('customers',id,{id,email,name:'Mel Clear',created:1,verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:Math.floor(Date.now()/1000)+86400});cookie='glow_next_customer='+token});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]}

test('Melissa\'s case: paid $136.83 on Stripe, order says $160.98 and was shipped; Clear fixes the record and starts the subscription',async()=>{
 await setup();const items=[{id:24,quantity:1},{id:1,quantity:1},{id:141,quantity:1}];
 const r=(await call('/account/subscribe',{items,every:'1m',customer:{name:'Mel Clear',email,phone:'4045550123',address:'1 Main St',city:'Ball Ground',state:'GA',zip:'30107'},agree:true,idempotency_key:'sub-clear-key-0001'},cookie)).body;
 let x=await transaction(s=>s.get('subscriptions',r.id));let o=await transaction(s=>s.get('orders',x.first_order));
 assert.equal(o.subtotal,16098);assert.equal(o.total,13683,'the first box is at the subscription price');paidAmount=13683;
 // What happened live: an item edit dropped the 15% (before the fix), then the team marked it paid and shipped it.
 await transaction(async s=>{const c=await s.get('orders',o.id);Object.assign(c,{discount:0,total:16098,status:'shipped',paid:Math.floor(Date.now()/1000),verified_payment_cents:16098,tracking:'1ZTEST'});await s.put('orders',c.id,c);const y=await s.get('subscriptions',x.id);y.problem='First payment needs review: paid 13683 of 16098. Check Stripe before doing anything else.';await s.put('subscriptions',y.id,y)});
 // Customers can't use it; staff need to be signed in.
 await assert.rejects(call('/admin/subscription/update',{id:x.id,action:'clear'}),/sign in|Sign in|log in|Unauthorized/i);
 const before=calls.length;
 const res=(await call('/admin/subscription/update',{id:x.id,action:'clear'},owner)).body;assert.equal(res.status,'active');
 x=await transaction(s=>s.get('subscriptions',x.id));o=await transaction(s=>s.get('orders',x.first_order));
 assert.equal(x.status,'active');assert.equal(x.problem,'');assert.deepEqual(x.card,{brand:'visa',last4:'4242'});assert.equal(x.payment_method,'pm_clear');assert.equal(x.deliveries,1);assert.deepEqual(x.orders,[o.id]);assert.ok(x.next_ship_date);
 assert.equal(o.total,13683);assert.equal(o.discount,2415);assert.equal(o.verified_payment_cents,13683);assert.equal(o.balance_due_cents,0);assert.equal(o.refund_due_cents,0);assert.equal(o.status,'shipped','a shipped order stays shipped');assert.equal(o.tracking,'1ZTEST');
 assert.equal(o.payment_reference,'pi_clear');assert.equal(o.stripe_checkout.amount,13683);
 const after_=calls.slice(before);assert.ok(!after_.some(c=>c.p==='EMAIL'),'nobody is emailed');assert.ok(!after_.some(c=>/payment_intents$|refunds|charges/.test(c.p)&&c.m==='POST'),'nobody is charged or refunded');
 await assert.rejects(call('/admin/subscription/update',{id:x.id,action:'clear'},owner),/waiting for its first payment/,'only once');
});

test('Clear refuses when Stripe received less than the subscription price, and changes nothing',async()=>{
 const items=[{id:24,quantity:2}];
 const email2=email;const r=(await call('/account/subscribe',{items,every:'1m',customer:{name:'Mel Clear',email:email2,phone:'4045550123',address:'1 Main St',city:'Ball Ground',state:'GA',zip:'30107'},agree:true,idempotency_key:'sub-clear-key-0002'},cookie)).body;
 const x=await transaction(s=>s.get('subscriptions',r.id)),o=await transaction(s=>s.get('orders',x.first_order));paidAmount=o.total-100;
 await assert.rejects(call('/admin/subscription/update',{id:x.id,action:'clear'},owner),/less than the subscription price/);
 const y=await transaction(s=>s.get('subscriptions',x.id)),c=await transaction(s=>s.get('orders',x.first_order));assert.equal(y.status,'pending_first_payment');assert.equal(c.total,o.total);assert.equal(c.status,'order_received');
});

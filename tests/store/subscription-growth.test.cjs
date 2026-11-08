'use strict';
// Subscribe & save, growth features (8 Nov 2026): add to next package, cancel reasons, dashboard numbers.
// (Harness copied from subscription-gaps.)  Subscribe & save, tightened (Jonah, 8 Nov 2026: "make sure there are no gaps").
// Declined card → customer emailed + shop alerted, box held 5 days, new card charges it once (new key), else skipped.
// Never charge an order that was canceled/paid meanwhile. Address changes. Cancel emails + releases a waiting box.
// One staff alert per problem, not every hour.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-subgrow-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'subscription-gap-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),subs=require('../../netlify/functions/lib/subscriptions.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];
const sent=[],stripe=[];let decline=false,newCard=false;const oldFetch=global.fetch;const ok=d=>({ok:true,status:200,json:async()=>d});
global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes('resend.com')){sent.push(JSON.parse(opts.body));return ok({id:'x'+sent.length})}
 if(u.startsWith('https://api.stripe.com/v1')){const p=u.slice(25),body=new URLSearchParams(opts.body||''),idem=opts.headers?.['Idempotency-Key']||'';stripe.push({p,method:opts.method||'GET',body,idem});
  if(p==='/checkout/sessions'&&opts.method==='POST')return ok({id:'cs_up',url:'https://checkout.stripe.com/c/pay/cs_up',expires_at:Math.floor(Date.now()/1000)+86400});
  if(p.startsWith('/checkout/sessions/cs_up'))return ok(newCard?{id:'cs_up',status:'complete',customer:'cus_9',metadata:{subscription_id:globalThis.__sid},setup_intent:{status:'succeeded',payment_method:{id:'pm_new',card:{brand:'mastercard',last4:'5555'}}}}:{id:'cs_up',status:'open',setup_intent:{status:'requires_payment_method'}});
  if(p.startsWith('/customers/'))return ok({id:'cus_9'});
  if(p==='/payment_intents'){if(decline)return{ok:false,status:402,json:async()=>({error:{message:'Your card was declined.'}})};return ok({id:'pi_'+idem.slice(-12),status:'succeeded',currency:'usd',amount_received:Number(body.get('amount')),livemode:false})}}
 throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const noonOn=d=>new Date(d+'T17:00:00Z').getTime();
const charges=()=>stripe.filter(c=>c.p==='/payment_intents');
async function makeSub(p,extra={}){const id='SUB-'+Math.random().toString(16).slice(2,10).toUpperCase();globalThis.__sid=id;
 await transaction(async s=>s.put('subscriptions',id,{id,brand:'glow',status:'active',pay:'autopay',source:'customer',every:'1m',customer:{name:'Gina Gap',email:'gina@example.test',phone:'+14045550199',address:'1 Main St',address2:'',city:'Atlanta',state:'GA',zip:'30301'},items:[{id:p.id,quantity:1,name:p.name}],orders:[],deliveries:1,created:1,stripe_customer:'cus_9',payment_method:'pm_old',card:{brand:'visa',last4:'4242'},next_ship_date:subs.addDays(subs.todayET(),2),next_date:subs.addDays(subs.todayET(),2),...extra}));return id}
const stockOf=id=>transaction(async s=>(await s.get('products',id)).stock);

let P,Q;
test('setup',async()=>{await transaction(seed);[P,Q]=await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);
 const ps=(await s.list('products')).filter(x=>x.active&&x.price>=2000&&x.price<=6500&&!(x.components||[]).length&&!x.stock_pool&&!x.max_order_quantity).slice(0,2);for(const p of ps){p.stock=20;delete p.regular_price;await s.put('products',p.id,p)}return ps})});

test('add to next package: charged with it at subscriber price, no tier/shipping change, cleared after; a sold-out add-on is left off and the package still goes',async()=>{
 const id=await makeSub(P);await transaction(async s=>{const x=await s.get('subscriptions',id);x.addons=[{id:Q.id,quantity:2,name:Q.name}];await s.put('subscriptions',id,x)});
 const pBefore=await stockOf(P.id),qBefore=await stockOf(Q.id);
 const r=await subs.run(10,noonOn(subs.todayET()));assert.equal(r.made,1);assert.equal(r.paid,1);
 const x=await transaction(s=>s.get('subscriptions',id)),o=await transaction(s=>s.get('orders',x.orders.at(-1)));
 const main=subs.priceFor([{id:P.id,quantity:1}],[P],null,2,{settings:await transaction(s=>s.get('settings','main'))});
 assert.equal(o.subtotal,P.price+2*Q.price);assert.equal(o.total,main.price_cents+Math.floor(Q.price*2*0.85)+main.shipping_cents,'add-on at 15% off, shipping unchanged');
 assert.equal(o.subscription_tier,main.tier.id,'tier from the main items only');assert.deepEqual(o.subscription_addons.map(a=>[a.id,a.quantity]),[[Q.id,2]]);
 assert.equal(await stockOf(Q.id),qBefore-2);assert.equal(await stockOf(P.id),pBefore-1);assert.deepEqual(x.addons,[],'cleared after the package is made');assert.equal(x.addons_last.order,o.id);
 assert.equal(charges().at(-1).body.get('amount'),String(o.total),'one charge for the whole package');
 // Sold out add-on: package still made without it, shop sees why.
 const id2=await makeSub(P);await transaction(async s=>{const x=await s.get('subscriptions',id2);x.addons=[{id:Q.id,quantity:1,name:Q.name}];await s.put('subscriptions',id2,x);const q=await s.get('products',Q.id);q.stock=0;await s.put('products',q.id,q)});
 const r2=await subs.run(10,noonOn(subs.todayET()));assert.equal(r2.made,1);
 const y=await transaction(s=>s.get('subscriptions',id2)),o2=await transaction(s=>s.get('orders',y.orders.at(-1)));assert.equal(o2.subtotal,P.price);assert(o2.addons_dropped);assert.match(y.problem,/Add-ons were left off/);
 await transaction(async s=>{const q=await s.get('products',Q.id);q.stock=20;await s.put('products',q.id,q);for(const k of [id,id2]){const z=await s.get('subscriptions',k);z.status='canceled';await s.put('subscriptions',k,z)}});
});

test('reminder amount includes add-ons and the subscriber saving',async()=>{
 const id=await makeSub(P,{next_ship_date:subs.addDays(subs.todayET(),4),next_date:subs.addDays(subs.todayET(),4),addons:[{id:Q.id,quantity:1,name:Q.name}]});sent.length=0;
 await transaction(async s=>{const ap=await s.get('integrations','autopilot')||{id:'autopilot',tasks:{}};ap.tasks=ap.tasks||{};ap.tasks.subscriptions={...(ap.tasks.subscriptions||{}),on:true};await s.put('integrations','autopilot',ap)});
 await subs.remind(20,noonOn(subs.todayET()));const m=sent.find(x=>/Your next Glow Lab package/.test(x.subject));assert(m,'reminder sent');
 const st=await transaction(s=>s.get('settings','main')),main=subs.priceFor([{id:P.id,quantity:1}],[P],null,2,{settings:st});
 assert.match(m.text,new RegExp('\\$'+((main.total_cents+Math.floor(Q.price*0.85))/100).toFixed(2).replace('.','\\.')));assert.match(m.text,/Package: 2 items/);assert.match(m.text,/As a subscriber you save/);
 await transaction(async s=>{const z=await s.get('subscriptions',id);z.status='canceled';await s.put('subscriptions',id,z)});
});

test('cancel reason and note are kept and sent to the shop; a bad reason is ignored; dashboard counts them',async()=>{
 const id=await makeSub(P);sent.length=0;
 await subs.update({id,action:'cancel',reason:'price',note:'  too   pricey right now '},{customer:true});
 const x=await transaction(s=>s.get('subscriptions',id));assert.equal(x.cancel_reason,'price');assert.equal(x.cancel_note,'too pricey right now');
 const staff=sent.find(m=>m.to[0]==='jonah@glowglps.com'&&/canceled by the customer/.test(m.subject));assert.match(staff.text,/It costs too much/);assert.match(staff.text,/too pricey right now/);
 const id2=await makeSub(P);await subs.update({id:id2,action:'cancel',reason:'<script>'},{customer:true});assert.equal((await transaction(s=>s.get('subscriptions',id2))).cancel_reason,undefined);
 const st=await subs.stats();assert(st.cancels_30d.count>=2);assert(st.cancels_30d.reasons.some(r=>r.reason==='price'&&r.label==='It costs too much'));
});

test('dashboard: monthly recurring revenue, charges this week, attention list',async()=>{
 const id=await makeSub(P,{every:'2w'});decline=true;await subs.run(10,noonOn(subs.todayET()));decline=false;
 const id3=await makeSub(P,{every:'1m',next_ship_date:subs.addDays(subs.todayET(),5),next_date:subs.addDays(subs.todayET(),5)});
 const st=await subs.stats(),settings=await transaction(s=>s.get('settings','main'));
 const p1=subs.priceFor([{id:P.id,quantity:1}],[P],null,2,{settings}).total_cents;
 assert(st.active>=2);assert(st.mrr_cents>=Math.round(p1*26/12+p1)-2);
 assert(st.upcoming.some(u=>u.id===id3&&u.amount_cents===p1));assert(st.attention.some(a=>a.kind==='declined'&&a.id===id));
 assert(!JSON.stringify(st).includes('gina@example.test'),'no customer emails in the dashboard numbers');
});

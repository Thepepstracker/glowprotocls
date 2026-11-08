'use strict';
// Subscribe & save, tightened (Jonah, 8 Nov 2026: "make sure there are no gaps").
// Declined card → customer emailed + shop alerted, box held 5 days, new card charges it once (new key), else skipped.
// Never charge an order that was canceled/paid meanwhile. Address changes. Cancel emails + releases a waiting box.
// One staff alert per problem, not every hour.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-subgaps-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'subscription-gap-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
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
let P;
test('setup',async()=>{await transaction(seed);P=await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);
 const p=(await s.list('products')).find(x=>x.active&&x.price>=2000&&x.price<=6500&&!(x.components||[]).length&&!x.stock_pool);p.stock=20;await s.put('products',p.id,p);return p})});

test('declined card: customer emailed once with an update-card link, shop alerted, box held, no second box, no reminder',async()=>{
 const id=await makeSub(P);decline=true;sent.length=0;const before=await stockOf(P.id);
 const r=await subs.run(10,noonOn(subs.todayET()));assert.equal(r.made,1);assert.equal(r.failed,1);
 const x=await transaction(s=>s.get('subscriptions',id)),o=await transaction(s=>s.get('orders',x.orders.at(-1)));
 assert.equal(o.autopay.status,'failed');assert.equal(x.payment_issue,o.id);assert.equal(await stockOf(P.id),before-1,'items held for the box');
 const cust=sent.filter(m=>m.to[0]==='gina@example.test'&&/update your card/i.test(m.subject));assert.equal(cust.length,1);assert.match(cust[0].text,/Visa ending in 4242/);assert.match(cust[0].text,/Nothing was charged/);assert.match(cust[0].text,/account#subscriptions/);
 const staff=sent.filter(m=>m.to[0]==='jonah@glowglps.com'&&/card declined/.test(m.subject));assert.equal(staff.length,1);assert(!/gina@example|4045550199|1 Main St/.test(staff[0].text),'no customer email/phone/street in staff alerts');
 // Same day again and the next cycle: no new charge, no second unpaid box.
 assert.equal((await subs.run(10,noonOn(subs.todayET()))).made,0);
 await transaction(async s=>{const y=await s.get('subscriptions',id);y.next_ship_date=y.next_date=subs.addDays(subs.todayET(),2);await s.put('subscriptions',y.id,y)});
 const r2=await subs.run(10,noonOn(subs.todayET()));assert.equal(r2.made,0,'never two unpaid boxes');
 assert.match((await transaction(s=>s.get('subscriptions',id))).problem,/Waiting for a new card/);
 assert.equal(sent.filter(m=>/card declined|not made/.test(m.subject)).length,1,'no hourly alert spam');
 assert.equal(charges().filter(c=>c.idem.includes(o.id)).length,1,'declined charge never resent with the same key');
 decline=false;
});

test('new card from the account: setup page (no charge, no product names), saved, declined box charged once with a new key',async()=>{
 const x0=(await transaction(s=>s.list('subscriptions'))).find(x=>x.payment_issue);globalThis.__sid=x0.id;const oid=x0.payment_issue;
 const link=await subs.cardUpdateLink(x0.id);assert.equal(link.url,'https://checkout.stripe.com/c/pay/cs_up');
 const setup=stripe.filter(c=>c.p==='/checkout/sessions'&&c.method==='POST').at(-1);assert.equal(setup.body.get('mode'),'setup');assert.equal(setup.body.get('customer'),'cus_9');assert(!new RegExp(P.name.split(' ')[0],'i').test(setup.body.toString()),'no product names to Stripe');
 newCard=false;assert.equal((await subs.checkCardUpdate(x0.id)).status,'pending');
 newCard=true;const r=await subs.checkCardUpdate(x0.id);assert.equal(r.status,'saved');assert.equal(r.retry.charged,1);
 const x=await transaction(s=>s.get('subscriptions',x0.id)),o=await transaction(s=>s.get('orders',oid));
 assert.equal(x.card.last4,'5555');assert.equal(x.payment_method,'pm_new');assert.equal(x.payment_issue,undefined);assert.equal(x.problem,'');
 assert.equal(o.status,'paid');assert.equal(o.autopay.attempt,2);assert.equal(charges().at(-1).idem,'glow-sub-charge-'+oid+'-2');assert.equal(charges().at(-1).body.get('payment_method'),'pm_new');
 assert.equal((await subs.checkCardUpdate(x0.id)).status,'none','done once');assert.equal((await subs.retryFailed(x0.id)).tried,0,'a paid box is never charged again');
 newCard=false;
});

test('never charges an order that was canceled or marked paid while its charge was waiting',async()=>{
 const id=await makeSub(P);const n=charges().length;
 const oid=await transaction(async s=>{const x=await s.get('subscriptions',id);const r=await require('../../netlify/functions/lib/store-core.cjs').subscriptionOrder(s,x,subs.shipDate(x));r.order.autopay={status:'unknown',started:Math.floor(Date.now()/1000)};r.order.status='canceled';await s.put('orders',r.order.id,r.order);return r.order.id});
 assert.equal((await subs.charge(oid)).status,'needs_review');assert.equal(charges().length,n,'Stripe never called');
 assert.equal((await transaction(s=>s.get('orders',oid))).autopay.status,'needs_review');
 assert(sent.some(m=>m.to[0]==='jonah@glowglps.com'&&/Check Stripe/.test(m.subject)));
 await transaction(async s=>{const x=await s.get('subscriptions',id);x.status='canceled';await s.put('subscriptions',id,x)});
});

test('no new card in 5 days: box skipped, items back in stock, never charged',async()=>{
 const id=await makeSub(P);decline=true;await subs.run(10,noonOn(subs.todayET()));decline=false;
 const x=await transaction(s=>s.get('subscriptions',id)),oid=x.payment_issue,held=await stockOf(P.id),n=charges().length;
 assert.equal(await subs.skipStale(Math.floor(Date.now()/1000)+4*86400),0,'still waiting on day 4');
 assert.equal(await subs.skipStale(Math.floor(Date.now()/1000)+6*86400),1);
 const o=await transaction(s=>s.get('orders',oid)),y=await transaction(s=>s.get('subscriptions',id));
 assert.equal(o.status,'canceled');assert.equal(o.autopay.status,'skipped');assert.equal(await stockOf(P.id),held+1);assert.equal(y.status,'active','subscription stays on');assert.equal(y.payment_issue,undefined);assert.equal(y.deliveries,1);assert.match(y.problem,/skipped/);
 assert.equal(charges().length,n);assert.equal((await subs.retryFailed(id)).tried,0);
 await transaction(async s=>{const z=await s.get('subscriptions',id);z.status='canceled';await s.put('subscriptions',id,z)});
});

test('address change for future boxes is checked like checkout; cancel emails the customer and the shop and frees a waiting box',async()=>{
 const id=await makeSub(P);
 await assert.rejects(subs.update({id,action:'address',address:{address:'9 Elm St',city:'Macon',state:'GA',zip:'123'}},{customer:true}),/ZIP/);
 await assert.rejects(subs.update({id,action:'address',address:{address:'9 Elm St',city:'Macon',state:'ZZ',zip:'31201'}},{customer:true}),/state/);
 const r=await subs.update({id,action:'address',address:{address:'9 Elm St',address2:'Apt 2',city:'Macon',state:'ga',zip:'31201'}},{customer:true});
 const x=await transaction(s=>s.get('subscriptions',id));assert.deepEqual([x.customer.address,x.customer.address2,x.customer.city,x.customer.state,x.customer.zip],['9 Elm St','Apt 2','Macon','GA','31201']);assert.equal(x.customer.email,'gina@example.test','email unchanged');assert.equal(x.customer.phone,'+14045550199');assert.equal(r.status,'active');
 // The next box ships to the new address.
 const o=await transaction(async s=>(await require('../../netlify/functions/lib/store-core.cjs').subscriptionOrder(s,await s.get('subscriptions',id),'2030-01-01')).order);assert.equal(o.customer.city,'Macon');
 await transaction(async s=>{const c=await s.get('orders',o.id);c.autopay={status:'failed',failed_at:Math.floor(Date.now()/1000)};await s.put('orders',c.id,c);const y=await s.get('subscriptions',id);y.payment_issue=c.id;await s.put('subscriptions',id,y)});
 const held=await stockOf(P.id);sent.length=0;
 const c=await subs.update({id,action:'cancel'},{customer:true});assert.equal(c.status,'canceled');
 assert.equal((await transaction(s=>s.get('orders',o.id))).status,'canceled');assert.equal(await stockOf(P.id),held+1,'waiting box released');
 assert.equal(sent.filter(m=>m.to[0]==='gina@example.test'&&/canceled/.test(m.subject)).length,1);assert.equal(sent.filter(m=>m.to[0]==='jonah@glowglps.com'&&/canceled by the customer/.test(m.subject)).length,1);
 await assert.rejects(subs.update({id,action:'cancel'},{customer:true}),e=>e.status===409);assert.equal(sent.length,2,'canceling twice sends nothing more');
});

test('a box that cannot be made (product off) alerts the shop once, not every hour',async()=>{
 const id=await makeSub(P);sent.length=0;
 await transaction(async s=>{const p=await s.get('products',P.id);p.active=false;await s.put('products',p.id,p)});
 await subs.run(10,noonOn(subs.todayET()));await subs.run(10,noonOn(subs.todayET())+3600e3);
 assert.equal(sent.filter(m=>/not made/.test(m.subject)).length,1);assert.match((await transaction(s=>s.get('subscriptions',id))).problem,/unavailable/);
 await transaction(async s=>{const p=await s.get('products',P.id);p.active=true;await s.put('products',p.id,p)});
});

test('customer view shows the declined box, the skip day and where boxes ship',async()=>{
 const id=await makeSub(P);decline=true;await subs.run(10,noonOn(subs.todayET()));decline=false;
 const v=await transaction(async s=>subs.customerView(await s.get('subscriptions',id),new Map((await s.list('products')).map(p=>[p.id,p])),await s.get('settings','main'),await s.list('orders')));
 assert(v.payment_issue);assert.equal(v.payment_issue.skip_date,subs.addDays(subs.todayET(),subs.AUTO_SKIP_DAYS));assert.equal(v.ship_to.city,'Atlanta');assert(v.payment_issue.amount_cents>0);
});

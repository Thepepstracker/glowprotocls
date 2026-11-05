'use strict';
// Subscribe & save (4 Nov 2026): every 1/2/3/4 weeks or monthly, AUTO-PAY through Stripe.
// 5 Nov 2026: priced by tier (see subscribe-tiers.test.cjs); the order is made 2 days before next_ship_date.
// One repeat order per date, ever; one charge per order, ever; a declined card is flagged, never retried blindly.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-subs-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'subscription-tests-session-secret-more-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),subs=require('../../netlify/functions/lib/subscriptions.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];const sent=[],stripe=[];let decline=false,cardSaved=false;const oldFetch=global.fetch;
const ok=d=>({ok:true,status:200,json:async()=>d});
global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes('resend.com')){sent.push(JSON.parse(opts.body));return ok({id:'x'+sent.length})}
 if(u.startsWith('https://api.stripe.com/v1')){const p=u.slice(25),body=new URLSearchParams(opts.body||''),idem=opts.headers?.['Idempotency-Key']||'';stripe.push({p,method:opts.method||'GET',body,idem});
  if(p==='/customers'&&opts.method==='POST')return ok({id:'cus_1'});
  if(p==='/checkout/sessions'&&opts.method==='POST')return ok({id:'cs_1',url:'https://checkout.stripe.com/c/pay/cs_1',expires_at:Math.floor(Date.now()/1000)+86400});
  if(p.startsWith('/checkout/sessions/cs_1'))return ok(cardSaved?{status:'complete',setup_intent:{status:'succeeded',payment_method:{id:'pm_1',card:{brand:'visa',last4:'4242'}}}}:{status:'open',setup_intent:{status:'requires_payment_method'}});
  if(p==='/customers/cus_1')return ok({id:'cus_1'});
  if(p==='/payment_intents'){if(decline)return{ok:false,status:402,json:async()=>({error:{message:'Your card was declined.'}})};const prior=stripe.filter(x=>x.p==='/payment_intents'&&x.idem===idem).length;return ok({id:'pi_'+idem.slice(-10),status:'succeeded',currency:'usd',amount_received:Number(body.get('amount')),livemode:false,replay:prior>1})}}
 throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});

test('intervals: weeks add days; monthly keeps the day and clamps to month end',()=>{
 assert.equal(subs.addInterval('2026-11-04','1w'),'2026-11-11');assert.equal(subs.addInterval('2026-11-04','2w'),'2026-11-18');assert.equal(subs.addInterval('2026-11-04','3w'),'2026-11-25');assert.equal(subs.addInterval('2026-11-04','4w'),'2026-12-02');
 assert.equal(subs.addInterval('2026-11-04','1m'),'2026-12-04');assert.equal(subs.addInterval('2027-01-31','1m'),'2027-02-28');assert.equal(subs.addInterval('2026-12-15','1m'),'2027-01-15');
 assert.throws(()=>subs.addInterval('2026-11-04','5w'));
});

test('card link → card saved → repeat order made at the tier price and charged once → paid; decline is flagged; skip/pause/cancel',async()=>{
 await transaction(seed);
 const p=await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);const p=(await s.list('products')).find(x=>x.active&&x.price>=2000&&!(x.components||[]).length&&!x.stock_pool);p.stock=20;await s.put('products',p.id,p);
  await s.put('orders','GLP-SRC1',{id:'GLP-SRC1',status:'paid',is_test:false,created:1,paid:2,total:p.price*2,items:[{id:p.id,name:p.name,quantity:2,price:p.price,amount:p.price*2}],customer:{name:'Sue Sub',email:'sue@example.test',phone:'4045550101',address:'1 Main St',city:'Atlanta',state:'GA',zip:'30301'}});
  await s.put('orders','GLP-UNPAID',{id:'GLP-UNPAID',status:'awaiting_payment',is_test:false,created:1,total:100,items:[{id:p.id,quantity:1}],customer:{name:'X',email:'x@example.test'}});return p});
 const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 await assert.rejects(call('/admin/subscription/create',{order_id:'GLP-UNPAID',every:'2w'},owner),e=>e.status===409,'only paid orders');
 await assert.rejects(call('/admin/subscription/create',{order_id:'GLP-SRC1',every:'9w'},owner),e=>e.status===400);
 const created=(await call('/admin/subscription/create',{order_id:'GLP-SRC1',every:'2w'},owner)).body;
 assert.equal(created.status,'needs_card');assert.equal(created.pay,'autopay');assert.equal(created.discount_pct,15);assert.equal(created.card_link,'https://checkout.stripe.com/c/pay/cs_1');
 const setup=stripe.find(x=>x.p==='/checkout/sessions');assert.equal(setup.body.get('mode'),'setup','saves a card, charges nothing');assert(!/lipo|bpc|glp|peptide/i.test(setup.body.toString()),'no product names sent to Stripe');
 await assert.rejects(call('/admin/subscription/create',{order_id:'GLP-SRC1',every:'2w'},owner),e=>e.status===409,'one per order');
 // Waiting for card: due date passes, nothing is made.
 const noon=new Date(subs.todayET()+'T17:00:00Z').getTime();
 await transaction(async s=>{const x=await s.get('subscriptions',created.id);x.next_ship_date=x.next_date=subs.addDays(subs.todayET(),2);await s.put('subscriptions',x.id,x)});
 cardSaved=false;assert.equal((await subs.run(10,noon)).made,0,'no card yet: nothing made');
 cardSaved=true;let r=await subs.run(10,noon);assert.equal(r.cards,1);
 let x=await transaction(s=>s.get('subscriptions',created.id));assert.equal(x.status,'active');assert.equal(x.card.last4,'4242');assert(stripe.some(c=>c.p==='/customers/cus_1'&&c.body.get('invoice_settings[default_payment_method]')==='pm_1'));
 assert.equal(r.made,1,'card saved and due today: the repeat is made in the same run');assert.equal(r.paid,1);
 x=await transaction(s=>s.get('subscriptions',created.id));const o=await transaction(s=>s.get('orders',x.orders[0]));
 const pr=subs.priceFor([{id:p.id,quantity:2}],[p],null,2,{settings:{shipping_cents:1500,free_shipping_cents:25000}});assert(pr.ok);assert.equal(o.subscription_tier,pr.tier.id,'a staff-started subscription maps to a tier from its items');assert.equal(o.subscription_discount,p.price*2-pr.price_cents);assert.equal(o.total,pr.total_cents,'tier price + tier shipping');assert(o.total-o.shipping<=Math.floor(p.price*2*0.85),'never above 85% of list');
 assert.equal(o.status,'paid');assert.equal(o.payment_method,'card_autopay');assert.equal(o.payment_verification_source,'stripe_autopay');assert.equal(o.autopay.status,'paid');
 const charges=stripe.filter(c=>c.p==='/payment_intents');assert.equal(charges.length,1);assert.equal(Number(charges[0].body.get('amount')),o.total);assert.equal(charges[0].body.get('description'),'Glow Lab');assert.equal(charges[0].idem,'glow-sub-charge-'+o.id);
 assert(!stripe.some(c=>c.p.startsWith('/invoices')),'auto-pay never also sends an invoice');
 assert.equal((await subs.run(10,noon)).made,0,'same day again: nothing');assert.equal(stripe.filter(c=>c.p==='/payment_intents').length,1,'never charged twice');
 await assert.rejects(call('/admin/order/unpaid',{id:o.id},owner),e=>e.status===409||e.status===404,'a Stripe auto-pay cannot be undone here');
 // Decline on the next cycle: order stays unpaid, subscription shows the problem.
 await transaction(async s=>{const y=await s.get('subscriptions',created.id);y.next_ship_date=y.next_date=subs.todayET();await s.put('subscriptions',y.id,y)});
 const tomorrowNoon=noon; // same day, but new cycle key forced below
 await transaction(async s=>{const y=await s.get('subscriptions',created.id);y.next_ship_date=y.next_date=subs.addInterval(subs.todayET(),'1w');await s.put('subscriptions',y.id,y)});
 decline=true;const later=new Date(subs.addInterval(subs.todayET(),'1w')+'T17:00:00Z').getTime();r=await subs.run(10,later);assert.equal(r.made,1);assert.equal(r.failed,1);
 x=await transaction(s=>s.get('subscriptions',created.id));assert.match(x.problem,/declined/);const o2=await transaction(s=>s.get('orders',x.orders.at(-1)));assert.equal(o2.status,'order_received');assert.equal(o2.autopay.status,'failed');
 assert.equal((await subs.run(10,later)).made,0);assert.equal(stripe.filter(c=>c.p==='/payment_intents'&&c.idem==='glow-sub-charge-'+o2.id).length,1,'a declined charge is not retried automatically');
 decline=false;void tomorrowNoon;
 // Skip, change, pause, resume, cancel.
 const sk=(await call('/admin/subscription/update',{id:created.id,action:'skip'},owner)).body;assert(sk.next_date>subs.todayET());
 assert.equal((await call('/admin/subscription/update',{id:created.id,action:'every',every:'1m'},owner)).body.every,'1m');
 assert.equal((await call('/admin/subscription/update',{id:created.id,action:'pause'},owner)).body.status,'paused');
 assert.equal((await call('/admin/subscription/update',{id:created.id,action:'resume'},owner)).body.status,'active');
 assert.equal((await call('/admin/subscription/update',{id:created.id,action:'cancel'},owner)).body.status,'canceled');
 await assert.rejects(call('/admin/subscription/update',{id:created.id,action:'resume'},owner),e=>e.status===409);
 const listed=(await call('/admin/subscriptions',undefined,owner)).body;assert.equal(listed.subscriptions.length,1);assert.equal(listed.stripe_ready,true);
});

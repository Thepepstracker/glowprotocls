'use strict';
// Subscribe & save tiers (Jonah's spec, 5 Nov 2026): slots, tiers, the 85%-of-list fairness cap, points max-not-multiply,
// free shipping from Tier 3, the Tier 5 bonus slot, customer checkout on Stripe (one "Glow Lab" line, card saved),
// confirm-paid once, customer ownership, charge 2 days before ship, reminder 3 days before charge (switch ON only), no double charge.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-sub-tiers-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'subscribe-tier-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),subs=require('../../netlify/functions/lib/subscriptions.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d});
const sent=[],stripe=[],sessions=new Map();let piCount=0;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(u.includes('resend.com')){sent.push(JSON.parse(opts.body));return ok({id:'em'+sent.length})}
 if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');
 const p=u.slice(25),method=opts.method||'GET',body=new URLSearchParams(opts.body||''),idem=opts.headers?.['Idempotency-Key']||'';stripe.push({p,method,body,raw:String(opts.body||''),idem});
 if(p==='/customers'&&method==='POST')return ok({id:'cus_'+crypto.createHash('sha1').update(idem).digest('hex').slice(0,8)});
 if(p.startsWith('/customers/'))return ok({id:p.split('/')[2]});
 if(p==='/checkout/sessions'&&method==='POST'){const prior=stripe.find(x=>x.p===p&&x.idem===idem&&x!==stripe.at(-1));if(prior)return ok(sessions.get(prior.sid));const id='cs_sub_'+(sessions.size+1);stripe.at(-1).sid=id;
  const sess={id,url:'https://checkout.stripe.com/c/pay/'+id,status:'open',payment_status:'unpaid',amount_total:Number(body.get('line_items[0][price_data][unit_amount]')),currency:'usd',livemode:false,expires_at:Math.floor(Date.now()/1000)+86400,metadata:{subscription_id:body.get('metadata[subscription_id]'),order_id:body.get('metadata[order_id]')},payment_intent:null};sessions.set(id,sess);return ok(sess)}
 const m=p.match(/^\/checkout\/sessions\/(cs_sub_\d+)(\/expire)?/);if(m){const sess=sessions.get(m[1]);if(m[2]){if(sess.status!=='open')return{ok:false,status:400,json:async()=>({error:{message:'Only open sessions can be expired.'}})};sess.status='expired';return ok(sess)}return ok(sess)}
 if(p==='/payment_intents'&&method==='POST'){piCount++;return ok({id:'pi_rep_'+idem.slice(-10),status:'succeeded',currency:'usd',amount_received:Number(body.get('amount')),livemode:false})}
 throw new Error('unmocked Stripe call '+method+' '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const pay=(id,extra={})=>{const s=sessions.get(id);Object.assign(s,{status:'complete',payment_status:'paid',payment_intent:{id:'pi_first_'+id,status:'succeeded',amount_received:s.amount_total,payment_method:{id:'pm_1',card:{brand:'visa',last4:'4242'}}}},extra)};
const noonET=d=>new Date(d+'T17:00:00Z').getTime(); // November: 12:00 PM Eastern
async function signedIn(email,name='Sam Sub'){const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email,name,created:1,verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:Math.floor(Date.now()/1000)+86400})});return{id,email,cookie:'glow_next_customer='+token}}
const shipTo=email=>({name:'Sam Sub',email,phone:'4045550123',address:'12 Peach St',city:'Ball Ground',state:'GA',zip:'30107'});
async function switchSubs(on){await transaction(async s=>{const rec=await s.get('integrations','autopilot')||{tasks:{}};rec.tasks=rec.tasks||{};rec.tasks.subscriptions={...(rec.tasks.subscriptions||{}),on};await s.put('integrations','autopilot',rec)})}
// Products used: 1 Lipo-C $43.99 (1 slot), 31 BPC-157 $32.00 (1), 37 Rose mist $19.00 (1), 26 5-Amino $64.99 (1, under the line),
// 10 GLP-2T 15 mg $68.00 (2 slots: over $65), 56 R4 8-vial set $530.00 (2 slots).
const P=[{id:1,price:4399,name:'Lipo-C'},{id:31,price:3200,name:'BPC-157'},{id:37,price:1900,name:'Rose'},{id:26,price:6499,name:'5-Amino'},{id:10,price:6800,name:'GLP-2T'},{id:56,price:53000,name:'R4 set'},{id:99,price:6500,name:'Edge'},{id:98,price:6501,name:'Edge+'}];
const SET={shipping_cents:1500,free_shipping_cents:25000};

test('slots: one per $65.00 of list price, rounded up (kits and bundles too); tier = smallest that fits',()=>{
 assert.equal(subs.slotsFor([{id:99,quantity:1}],P),1,'$65.00 exactly is 1 slot');assert.equal(subs.slotsFor([{id:98,quantity:1}],P),2,'$65.01 is 2 slots');
 assert.equal(subs.slotsFor([{id:1,quantity:2},{id:10,quantity:1}],P),4);assert.equal(subs.slotsFor([{id:56,quantity:1}],P),9,'a $530 bundle is 9 slots, so it cannot ride a $229.99 tier');assert.equal(subs.slotsFor([{id:56,quantity:2}],P),18);assert.equal(subs.slotsFor([{id:99,quantity:1},{id:98,quantity:1}],P),3);
 assert.deepEqual([1,2,3,4,5,6,7,8].map(n=>subs.tierFor(n).id),['T1','T2','T3','T4','T4','T5','T5','T5']);assert.equal(subs.tierFor(9).id,'T5','12-slot box from 11 Nov 2026');assert.equal(subs.tierFor(12).id,'T5');assert.equal(subs.tierFor(13),null);assert.equal(subs.tierFor(0),null);
 assert.deepEqual(subs.TIERS.map(t=>[t.slots,t.price,t.points]),[[1,3399,2],[2,6499,2],[3,9499,2],[5,14999,3],[12,22999,4]]);
 const r=subs.priceFor([{id:1,quantity:4}],P,null,1,{settings:SET});assert.equal(r.tier.id,'T4');assert.equal(r.nudge,null,'no "add one more at no extra cost" nudge: every item is 15% off, so adding one always costs more');assert.equal(r.price_cents,Math.floor(4*4399*0.85));
 assert.equal(subs.priceFor([{id:10,quantity:5}],P,null,1,{settings:SET}).tier.id,'T5','10 slots fits Tier 5 now');const big=subs.priceFor([{id:10,quantity:9}],P,null,1,{settings:SET});assert.equal(big.ok,false);assert.equal(big.slots,18);assert.match(big.error,/up to 12 slots/);
});

test('exactly 15% off: every box is charged 85% of list, never less, whatever the tier (Jonah, 6 Nov 2026)',()=>{
 const rose=subs.priceFor([{id:37,quantity:1}],P,null,1,{settings:SET});assert.equal(rose.tier.id,'T1');assert.equal(rose.price_cents,Math.floor(1900*0.85),'$19 item: $16.15, not the $33.99 tier price');assert(rose.fair_cap_applied);
 const full=subs.priceFor([{id:26,quantity:3}],P,null,1,{settings:SET});assert.equal(full.price_cents,Math.floor(19497*0.85),'3 × $64.99 = $194.97 list → $165.72, not the old $94.99 tier price');assert.equal(full.discount_cents,19497-Math.floor(19497*0.85));
 const ids=[1,31,37,26,10,56];let checked=0;
 for(let seedN=1;seedN<400;seedN++){const items=[];let x=seedN;for(const id of ids){x=(x*1103515245+12345)%2147483648;const q=x%3;if(q)items.push({id,quantity:q})}if(!items.length)continue;
  const r=subs.priceFor(items,P,null,1+seedN%9,{settings:SET});if(!r.ok)continue;checked++;const list=items.reduce((n,i)=>n+P.find(p=>p.id===i.id).price*i.quantity,0);
  assert.equal(r.price_cents,Math.floor(list*0.85),'exactly 85% of list');assert.equal(r.total_cents,r.price_cents+r.shipping_cents);assert.equal(r.discount_cents,r.list_cents-r.price_cents)}
 assert(checked>50);
});

test('shipping: Tier 1 and 2 pay the store shipping; Tier 3 and up ship free',()=>{
 assert.equal(subs.priceFor([{id:1,quantity:1}],P,null,1,{settings:SET}).shipping_cents,1500);
 assert.equal(subs.priceFor([{id:1,quantity:2}],P,null,1,{settings:SET}).shipping_cents,1500);
 for(const n of [3,5,8])assert.equal(subs.priceFor([{id:1,quantity:n}],P,null,1,{settings:SET}).shipping_cents,0,n+' slots');
 assert.equal(subs.priceFor([{id:10,quantity:1}],P,null,1,{settings:SET}).tier.id,'T2','one premium item = 2 slots = Tier 2');
});

test('Tier 5 bonus slot: deliveries 4, 8, 12 get one extra 1-slot item at no extra price; other tiers and deliveries do not',()=>{
 const box=[{id:1,quantity:6},{id:10,quantity:1}];const d3=subs.priceFor(box,P,null,3,{settings:SET}),d4=subs.priceFor(box,P,null,4,{settings:SET}),d8=subs.priceFor(box,P,null,8,{settings:SET}),d5=subs.priceFor(box,P,null,5,{settings:SET});
 assert.equal(d3.tier.id,'T5');assert.equal(d3.bonus,null);assert.equal(d5.bonus,null);assert.equal(d4.bonus.id,1);assert.equal(d8.bonus.id,1);assert.equal(d4.capacity,13);
 assert.equal(d4.price_cents,d3.price_cents,'no extra price');assert.equal(d4.total_cents,d3.total_cents);assert.equal(d4.lines.find(l=>l.id===1).quantity,7,'one more of a 1-slot item');
 assert.equal(subs.priceFor(box,P,null,4,{settings:SET,bonus_id:31}).bonus.id,31,'customer pick honored');assert.equal(subs.priceFor(box,P,null,4,{settings:SET,bonus_id:10}).bonus.id,1,'a 2-slot pick does not fit the bonus slot');
 assert.equal(subs.priceFor([{id:1,quantity:5}],P,null,4,{settings:SET}).bonus,null,'Tier 4 has no bonus slot');
 const cheap=subs.priceFor([{id:37,quantity:8}],P,null,4,{settings:SET});assert.equal(cheap.price_cents,Math.floor(8*1900*0.85),'fair cap is on the regular items, so the bonus item never raises the price');
});

test('points: max(tier multiplier, normal multiplier), never multiplied together',async()=>{
 await transaction(seed);const purple=await signedIn('purple@example.test'),blue=await signedIn('blue@example.test');
 await transaction(async s=>{await accounts.event(s,purple.id,'opening','earned',1500,0,null,'test')}); // Purple level = 2×
 const paid=async(c,mult,id)=>transaction(async s=>{const o={id,is_test:false,customer_id:c.id,created:Math.floor(Date.now()/1000),subtotal:10000,discount:0,subscription_points_multiplier:mult};await accounts.paid(s,o);return o});
 assert.equal((await paid(purple,2,'GLP-PT1')).points_earned,200,'Purple 2× with Tier 1 2× → 2×, not 4×');
 assert.equal((await paid(purple,4,'GLP-PT5')).points_earned,400,'Purple 2× with Tier 5 4× → 4×, not 8×');
 assert.equal((await paid(blue,3,'GLP-BT4')).points_earned,300,'Blue 1× with Tier 4 3× → 3×');
 assert.equal((await paid(blue,0,'GLP-BNONE')).points_earned,100,'not a subscription: normal 1×');
 await transaction(async s=>{const st=await s.get('settings','main');st.double_points={windows:[{from:0,until:2e9}]};await s.put('settings','main',st)});
 assert.equal((await paid(purple,3,'GLP-PDBL')).points_earned,400,'double points: Purple 2× × double 2× = 4× normal beats Tier 4 3×; still not 12×');
 await transaction(async s=>{const st=await s.get('settings','main');delete st.double_points;await s.put('settings','main',st)});
});

let A,B,firstSub,firstOrder;
test('customer checkout: signed in only, offered only when the switch is ON; Stripe gets one "Glow Lab" line, saves the card, no product names',async()=>{
 await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);for(const id of [1,31,37,26,10]){const p=await s.get('products',id);p.stock=50;await s.put('products',id,p)}});
 A=await signedIn('alice@example.test','Alice Able');B=await signedIn('bob@example.test','Bob Baker');
 const items=[{id:1,quantity:1},{id:31,quantity:1},{id:37,quantity:1}],body={items,every:'1m',customer:shipTo(A.email),idempotency_key:'key-alice-0001',agree:true};
 await switchSubs(false);
 let q=(await call('/subscribe/quote',{items},A.cookie)).body;assert.equal(q.available,false,'switch OFF: not offered');assert.equal(q.tier.id,'T3');
 await assert.rejects(call('/account/subscribe',body,A.cookie),e=>e.status===503);
 await switchSubs(true);
 q=(await call('/subscribe/quote',{items})).body;assert.equal(q.available,true);assert.equal(q.signed_in,false);assert.equal(q.price_cents,Math.floor(9499*0.85),'list $94.99 → 85% = $80.74 (below the $94.99 tier price)');assert.equal(q.shipping_cents,0);
 assert.deepEqual(q.every.map(e=>e.id),['1w','2w','3w','1m','2m','3m'],'4 weeks is not offered to customers; every 2 and 3 months are (8 Nov 2026)');
 await assert.rejects(call('/account/subscribe',body),e=>e.status===401,'must be signed in');
 await assert.rejects(call('/account/subscribe',{...body,every:'4w'},A.cookie),e=>e.status===400);
 await assert.rejects(call('/account/subscribe',{...body,customer:shipTo('other@example.test'),idempotency_key:'key-alice-0002'},A.cookie),e=>e.status===400,'account email only');
 const before=await transaction(s=>s.get('products',1));
 await assert.rejects(call('/account/subscribe',{...body,agree:undefined,idempotency_key:'key-alice-0009'},A.cookie),e=>e.status===400&&/agree/.test(e.message),'must tick the terms box');
 const r=(await call('/account/subscribe',body,A.cookie)).body;assert.match(r.url,/^https:\/\/checkout\.stripe\.com\//);firstSub=r.id;
 {const x=await transaction(s=>s.get('subscriptions',firstSub));assert.equal(x.consent.terms_version,subs.TERMS_VERSION);assert.equal(x.consent.every,'1m');assert(x.consent.amount_cents>0&&x.consent.agreed_at>0,'what they agreed to is kept')}
 const again=(await call('/account/subscribe',body,A.cookie)).body;assert.equal(again.url,r.url,'double-click: same checkout, nothing new');
 assert.equal(stripe.filter(c=>c.p==='/checkout/sessions'&&c.method==='POST').length,1);
 const cs=stripe.find(c=>c.p==='/checkout/sessions'&&c.method==='POST'),b=cs.body;
 const x=await transaction(s=>s.get('subscriptions',firstSub));firstOrder=x.first_order;const o=await transaction(s=>s.get('orders',firstOrder));
 assert.equal(x.status,'pending_first_payment');assert.equal(x.customer_id,A.id);assert.equal(o.status,'order_received');assert.equal(o.payment_method,'card_checkout');assert.equal(o.subscription_tier,'T3');
 assert.equal(o.subscription_discount,9499-8074);assert.equal(o.discount,o.subscription_discount);assert.equal(o.total,o.subtotal-o.discount+o.shipping);assert.equal(o.total,8074);
 assert.equal((await transaction(s=>s.get('products',1))).stock,before.stock-1,'stock held for the first box');
 assert.equal(b.get('mode'),'payment');assert.equal(b.get('line_items[0][quantity]'),'1');assert.equal(b.get('line_items[0][price_data][product_data][name]'),'Glow Lab');assert.equal(Number(b.get('line_items[0][price_data][unit_amount]')),o.total);
 assert.equal([...b.keys()].filter(k=>k.startsWith('line_items[1]')).length,0,'exactly one line');assert.equal(b.get('payment_intent_data[setup_future_usage]'),'off_session');assert.equal(b.get('payment_intent_data[description]'),'Glow Lab');
 assert.equal(b.get('success_url'),'http://127.0.0.1:8787/store-next/account?subscribed='+firstSub);assert.match(b.get('cancel_url'),/^http:\/\/127\.0\.0\.1:8787\/store-next\//);
 assert(b.get('customer'),'a Stripe customer is made (and reused)');
 for(const c of stripe)assert(!/lipo-c|bpc-157|rose recovery|glp-2t|5-amino|peptide|vial/i.test(decodeURIComponent(c.raw.replace(/\+/g,' '))),'no product names in any Stripe call: '+c.p);
});

test('confirm paid: verified with Stripe, order paid once (source stripe_checkout), card saved; a second confirm changes nothing',async()=>{
 let r=(await call('/account/subscriptions/confirm',{id:firstSub},A.cookie)).body;assert.equal(r.status,'pending','not paid yet');
 assert.equal((await transaction(s=>s.get('orders',firstOrder))).status,'order_received');
 const sid=(await transaction(s=>s.get('subscriptions',firstSub))).checkout.id;
 pay(sid,{amount_total:100});r=(await call('/account/subscriptions/confirm',{id:firstSub},A.cookie)).body;assert.equal(r.status,'needs_review','paid less than the total: never marked paid');
 assert.equal((await transaction(s=>s.get('orders',firstOrder))).status,'order_received');
 sessions.get(sid).amount_total=8074;pay(sid);r=(await call('/account/subscriptions/confirm',{id:firstSub},A.cookie)).body;assert.equal(r.status,'active');
 const o=await transaction(s=>s.get('orders',firstOrder)),x=await transaction(s=>s.get('subscriptions',firstSub));
 assert.equal(o.status,'paid');assert.equal(o.payment_verification_source,'stripe_checkout');assert.equal(o.payment_reference,'pi_first_'+sid);assert.equal(o.points_earned,Math.floor(8074/100)*2,'Tier 3 = 2× (Alice is 1× normally)');
 assert.equal(x.status,'active');assert.equal(x.card.last4,'4242');assert.equal(x.payment_method,'pm_1');assert.equal(x.next_ship_date,subs.addInterval(subs.todayET(),'1m'));assert.equal(x.deliveries,1);
 const paidMails=sent.filter(m=>/payment received/.test(m.subject)).length,ledger=(await transaction(s=>s.list('rewards_ledger'))).filter(e=>e.order_id===firstOrder).length;
 assert(sent.some(m=>m.subject==='You’re subscribed: 15% off every Glow Lab package'));
 for(let i=0;i<2;i++)assert.equal((await call('/account/subscriptions/confirm',{id:firstSub},A.cookie)).body.status,'active');
 await subs.run(10,noonET(subs.todayET()));
 const o2=await transaction(s=>s.get('orders',firstOrder));assert.equal(o2.paid,o.paid,'not marked paid again');
 assert.equal(sent.filter(m=>/payment received/.test(m.subject)).length,paidMails);assert.equal((await transaction(s=>s.list('rewards_ledger'))).filter(e=>e.order_id===firstOrder).length,ledger,'points once');
 assert.equal(piCount,0,'the first box is paid on Checkout, never charged again off-session');
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];await assert.rejects(call('/admin/status',{id:firstOrder,status:'unpaid',confirm:true},owner),e=>e.status===409&&/Stripe confirmed/.test(e.message),'a Stripe Checkout payment cannot be undone by hand');
});

test('ownership: customers see and change only their own subscriptions',async()=>{
 const mine=(await call('/account/subscriptions',undefined,A.cookie)).body;assert.equal(mine.subscriptions.length,1);assert.equal(mine.subscriptions[0].pricing.tier.id,'T3');assert.equal(mine.subscriptions[0].card.last4,'4242');
 assert.equal((await call('/account/subscriptions',undefined,B.cookie)).body.subscriptions.length,0);
 await assert.rejects(call('/account/subscriptions'),e=>e.status===401);
 for(const [p,b] of [['/account/subscriptions/update',{id:firstSub,action:'cancel'}],['/account/subscriptions/update',{id:firstSub,action:'skip'}],['/account/subscriptions/preview',{id:firstSub,items:[{id:1,quantity:1}]}],['/account/subscriptions/confirm',{id:firstSub}],['/account/subscriptions/abandon',{id:firstSub}]])
  await assert.rejects(call(p,b,B.cookie),e=>e.status===404,p);
 assert.equal((await transaction(s=>s.get('subscriptions',firstSub))).status,'active','Bob changed nothing');
 // A staff-started subscription for Alice's email shows up for her (verified email match).
 await transaction(s=>s.put('subscriptions','SUB-STAFF1',{id:'SUB-STAFF1',status:'paused',pay:'autopay',every:'4w',customer:{name:'Alice',email:'ALICE@example.test'},items:[{id:31,quantity:1}],orders:[],created:1}));
 assert.equal((await call('/account/subscriptions',undefined,A.cookie)).body.subscriptions.length,2);assert.equal((await call('/account/subscriptions',undefined,B.cookie)).body.subscriptions.length,0);
 await transaction(s=>s.remove('subscriptions','SUB-STAFF1'));
});

test('customer actions: frequency, skip, pause/resume, swap items (re-tiered, price shown first), cancel',async()=>{
 const up=(b)=>call('/account/subscriptions/update',{id:firstSub,...b},A.cookie);
 await assert.rejects(up({action:'every',every:'4w'}),e=>e.status===400,'4 weeks not offered');
 assert.equal((await up({action:'every',every:'2w'})).body.every,'2w');
 const before=(await transaction(s=>s.get('subscriptions',firstSub))).next_ship_date;assert.equal((await up({action:'skip'})).body.next_ship_date,subs.addInterval(before,'2w'));
 assert.equal((await up({action:'pause'})).body.status,'paused');assert.equal((await up({action:'resume'})).body.status,'active');
 const pv=(await call('/account/subscriptions/preview',{id:firstSub,items:[{id:1,quantity:4},{id:10,quantity:1}]},A.cookie)).body;assert.equal(pv.tier.id,'T5','6 slots → Tier 5');assert.equal(pv.price_cents,Math.min(22999,Math.floor((4*4399+6800)*0.85)));
 const saved=(await up({action:'items',items:[{id:1,quantity:4},{id:10,quantity:1}]})).body;assert.equal(saved.pricing.tier.id,'T5');assert.equal(saved.items.length,2);
 await assert.rejects(up({action:'items',items:[{id:10,quantity:9}]}),e=>e.status===409,'more than 12 slots');
 await assert.rejects(up({action:'items',items:[{id:999,quantity:1}]}),e=>e.status===400);
 await up({action:'items',items:[{id:1,quantity:1},{id:31,quantity:1},{id:37,quantity:1}]});
});

test('charge timing: the repeat order is made and charged 2 days before the ship date (10 AM–6 PM ET), once per ship date',async()=>{
 const ship=subs.addDays(subs.todayET(),20);await transaction(async s=>{const x=await s.get('subscriptions',firstSub);x.next_ship_date=x.next_date=ship;x.every='1m';await s.put('subscriptions',x.id,x)});
 assert.equal((await subs.run(10,noonET(subs.addDays(ship,-3)))).made,0,'3 days before ship: nothing');
 assert.equal((await subs.run(10,new Date(subs.addDays(ship,-2)+'T12:00:00Z').getTime())).made,0,'7 AM Eastern: quiet hours');
 const r=await subs.run(10,noonET(subs.addDays(ship,-2)));assert.equal(r.made,1);assert.equal(r.paid,1);assert.equal(piCount,1);
 const x=await transaction(s=>s.get('subscriptions',firstSub)),o=await transaction(s=>s.get('orders',x.orders.at(-1)));
 assert.equal(o.ship_date,ship);assert.equal(o.subscription_cycle,ship);assert.equal(o.status,'paid');assert.equal(o.payment_method,'card_autopay');assert.equal(o.subscription_tier,'T3');assert.equal(o.total,8074);assert.equal(o.subscription_delivery,2);
 const charge=stripe.filter(c=>c.p==='/payment_intents');assert.equal(charge.length,1);assert.equal(Number(charge[0].body.get('amount')),o.total);assert.equal(charge[0].body.get('description'),'Glow Lab');assert.equal(charge[0].idem,'glow-sub-charge-'+o.id);
 assert.equal(x.next_ship_date,subs.addInterval(ship,'1m'));assert.equal(x.deliveries,2);
 for(const d of [-2,-1,0])assert.equal((await subs.run(10,noonET(subs.addDays(ship,d)))).made,0);
 assert.equal(piCount,1,'never charged twice');
 // Even if the date were put back by hand, the same ship date can never make a second order.
 await transaction(async s=>{const y=await s.get('subscriptions',firstSub);y.next_ship_date=y.next_date=ship;await s.put('subscriptions',y.id,y)});
 assert.equal((await subs.run(10,noonET(subs.addDays(ship,-2)))).made,0);assert.equal(piCount,1);
});

test('reminder: 3 days before each charge, once, only while the Autopilot switch is ON; no product names or health wording',async()=>{
 const ship=subs.addDays(subs.todayET(),40),charge=subs.addDays(ship,-2);await transaction(async s=>{const x=await s.get('subscriptions',firstSub);x.next_ship_date=x.next_date=ship;delete x.reminded_for;await s.put('subscriptions',x.id,x)});
 const base=sent.filter(m=>m.subject.startsWith('Your next Glow Lab package')).length,n=()=>sent.filter(m=>m.subject.startsWith('Your next Glow Lab package')).length-base;
 await switchSubs(false);assert.equal((await subs.remind(20,noonET(subs.addDays(charge,-3)))).status,'switch_off');assert.equal(n(),0);
 await switchSubs(true);
 assert.equal((await subs.remind(20,noonET(subs.addDays(charge,-4)))).sent,0,'4 days before: not yet');
 assert.equal((await subs.remind(20,noonET(subs.addDays(charge,-3)))).sent,1);assert.equal(n(),1);
 assert.equal((await subs.remind(20,noonET(subs.addDays(charge,-2)))).sent,0,'once per ship date');
 const m=sent.filter(x=>x.subject.startsWith('Your next Glow Lab package')).at(-1);assert.equal(m.to[0],A.email);
 assert.match(m.text,/Package: 3 items/);assert.match(m.text,/\$80\.74/);assert.match(m.text,/Card charged on: /);assert.match(m.text,/store-next\/account#subscriptions/);
 assert(!/lipo|bpc|rose|dose|dosing|inject|reconstitut|health/i.test(m.text+m.subject),'research-use-only safe');
});

test('an unfinished checkout gives its items back; starting again closes the old one on Stripe',async()=>{
 const before=(await transaction(s=>s.get('products',26))).stock;
 const r1=(await call('/account/subscribe',{items:[{id:26,quantity:2}],every:'2w',customer:shipTo(B.email),idempotency_key:'key-bob-000001',agree:true},B.cookie)).body;
 assert.equal((await transaction(s=>s.get('products',26))).stock,before-2);
 const r2=(await call('/account/subscribe',{items:[{id:26,quantity:1}],every:'2w',customer:shipTo(B.email),idempotency_key:'key-bob-000002',agree:true},B.cookie)).body;
 assert.notEqual(r1.id,r2.id);const old=await transaction(s=>s.get('subscriptions',r1.id));assert.equal(old.status,'canceled');assert.equal(sessions.get(old.checkout.id).status,'expired','expired on Stripe so it can no longer be paid');
 assert.equal((await transaction(s=>s.get('orders',old.first_order))).status,'expired');assert.equal((await transaction(s=>s.get('products',26))).stock,before-1);
 await call('/account/subscriptions/abandon',{id:r2.id},B.cookie);assert.equal((await transaction(s=>s.get('products',26))).stock,before);
 assert.equal((await call('/account/subscriptions',undefined,B.cookie)).body.subscriptions.length,0,'closed checkouts are not listed');
 const admin=await subs.list();assert(admin.some(x=>x.id===firstSub&&x.pricing.tier.id==='T3'&&x.pricing.slots===3&&x.next_ship_date));
});

test('items already on sale: the better of the sale price or 15% off regular, never both (Jonah, 8 Nov 2026)',()=>{
 const P2=[{id:501,name:'Sale vial',price:2499,regular_price:3199},{id:502,name:'Deep sale',price:7900,regular_price:11000},{id:503,name:'Light sale',price:3000,regular_price:3100},{id:504,name:'Regular',price:4399}];
 const S={shipping_cents:1500,free_shipping_cents:0};
 assert.equal(subs.priceFor([{id:501,quantity:1}],P2,null,1,{settings:S}).price_cents,2499,'85% of $31.99 is $27.19, the sale price $24.99 is lower');
 assert.equal(subs.priceFor([{id:502,quantity:1}],P2,null,1,{settings:S}).price_cents,7900);
 assert.equal(subs.priceFor([{id:503,quantity:2}],P2,null,1,{settings:S}).price_cents,2*Math.floor(3100*0.85),'85% of regular is lower than this small sale');
 assert.equal(subs.priceFor([{id:504,quantity:1}],P2,null,1,{settings:S}).price_cents,Math.floor(4399*0.85),'no sale: exactly 15% off as before');
 const mix=subs.priceFor([{id:501,quantity:1},{id:504,quantity:1}],P2,null,1,{settings:S});assert.equal(mix.price_cents,2499+Math.floor(4399*0.85));assert.equal(mix.list_cents,2499+4399);
});
test('Tier 5 bonus needs 4 packages in a row at Tier 5, so nobody can jump up for one package to collect it',()=>{
 const P3=Array.from({length:8},(_,i)=>({id:600+i,name:'V'+i,price:4000}));const box=P3.map(p=>({id:p.id,quantity:1}));const S={shipping_cents:1500};
 assert.equal(subs.priceFor(box,P3,null,4,{settings:S,streak:1}).bonus,null,'4th package overall but first at Tier 5: no bonus');
 assert.equal(subs.priceFor(box,P3,null,9,{settings:S,streak:4}).bonus.id,600,'4th in a row at Tier 5: bonus');
 assert.equal(subs.priceFor(box,P3,null,4,{settings:S}).bonus.id,600,'without a streak (old callers) the delivery number still decides');
});

test('ship together: two packages, same person, same door, same day → one shipping charge; a customer can line them up (Jonah, 8 Nov 2026)',async()=>{
 const base=await transaction(s=>s.get('subscriptions',firstSub)),ship=subs.addDays(subs.todayET(),40);
 const mk=(id,extra={})=>({...structuredClone(base),id,status:'active',every:'1m',items:[{id:31,quantity:1,name:'BPC-157'}],orders:[],addons:[],payment_issue:undefined,problem:'',next_ship_date:ship,next_date:ship,customer:{...base.customer,address:'7 Together Lane'},...extra});
 await transaction(async s=>{await s.put('subscriptions','SUB-TOG1',mk('SUB-TOG1'));await s.put('subscriptions','SUB-TOG2',mk('SUB-TOG2'))});
 const before=piCount,r=await subs.run(10,noonET(subs.addDays(ship,-2)));assert.ok(r.made>=2);
 const o1=await transaction(async s=>s.get('orders',(await s.get('subscriptions','SUB-TOG1')).orders.at(-1))),o2=await transaction(async s=>s.get('orders',(await s.get('subscriptions','SUB-TOG2')).orders.at(-1)));
 const [first,second]=[o1,o2].sort((a,b)=>a.created-b.created||0);const paidShip=[o1,o2].filter(o=>o.shipping>0);
 assert.equal(paidShip.length,1,'only one of the two pays shipping');const other=[o1,o2].find(o=>o.shipping===0);
 assert.equal(other.shipping_combined,1500);assert.equal(other.ships_with,paidShip[0].id);assert.equal((await transaction(s=>s.get('orders',paidShip[0].id))).ships_with,other.id);
 for(const o of [o1,o2]){const c=stripe.filter(c=>c.p==='/payment_intents'&&c.idem==='glow-sub-charge-'+o.id);assert.equal(c.length,1,'charged once');assert.equal(Number(c[0].body.get('amount')),o.total,'the card charge matches the order, the second without shipping')}assert.equal(other.total+1500,paidShip[0].total);void first;void second;void before;
 // A different address does not combine.
 const ship2=subs.addDays(ship,10);await transaction(async s=>{await s.put('subscriptions','SUB-TOG3',mk('SUB-TOG3',{next_ship_date:ship2,next_date:ship2}));await s.put('subscriptions','SUB-TOG4',mk('SUB-TOG4',{next_ship_date:ship2,next_date:ship2,customer:{...base.customer,address:'99 Other Rd'}}))});
 await subs.run(10,noonET(subs.addDays(ship2,-2)));const o3=await transaction(async s=>s.get('orders',(await s.get('subscriptions','SUB-TOG3')).orders.at(-1))),o4=await transaction(async s=>s.get('orders',(await s.get('subscriptions','SUB-TOG4')).orders.at(-1)));
 assert.equal(o3.shipping,1500);assert.equal(o4.shipping,1500);assert.ok(!o3.ships_with&&!o4.ships_with);
 // The customer lines one up with the other from their account; someone else's subscription or another address is refused.
 const later=subs.addDays(ship2,60),soon=subs.addDays(ship2,45);await transaction(async s=>{await s.put('subscriptions','SUB-TOG5',mk('SUB-TOG5',{next_ship_date:later,next_date:later}));await s.put('subscriptions','SUB-TOG6',mk('SUB-TOG6',{next_ship_date:soon,next_date:soon}))});
 const res=await call('/account/subscriptions/update',{id:'SUB-TOG5',action:'together',together_with:'SUB-TOG6'},A.cookie);assert.equal(res.status,200);assert.equal(res.body.next_ship_date,soon);
 await assert.rejects(call('/account/subscriptions/update',{id:'SUB-TOG5',action:'together',together_with:'SUB-TOG4'},A.cookie),e=>e.status===409,'another address');
 await assert.rejects(call('/account/subscriptions/update',{id:'SUB-TOG5',action:'together',together_with:'SUB-TOG6'},B.cookie),e=>e.status===404,'not theirs');
});

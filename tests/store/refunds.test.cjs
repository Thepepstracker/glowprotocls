'use strict';
// Refunds (Jonah, 17 Nov 2026: "we need a way to refund customers"). Stripe card payments are refunded on Stripe; Venmo /
// Zelle / Cash App are sent by hand and ticked. Refund everything cancels, restocks, voids the unused label, moves points back.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-refunds-'));const TOKEN='shippo_test_'+'b'.repeat(30);
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'refund-tests-session-secret-32-chars-plus',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_test_RefundTests12345',SHIPPO_API_TOKEN:TOKEN});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const sent=[],stripe=[],shippo=[];let stripeFail=false;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url),j=x=>({ok:true,status:200,json:async()=>x});
 if(u.includes('resend.com')){sent.push(JSON.parse(opts.body));return j({id:'e'+sent.length})}
 if(u.startsWith('https://api.stripe.com/v1/')){const body=Object.fromEntries(new URLSearchParams(opts.body||''));stripe.push({u,method:opts.method||'GET',body,idem:opts.headers?.['Idempotency-Key']});
  if(stripeFail)return{ok:false,status:400,json:async()=>({error:{message:'Charge already refunded'}})};
  if(u.includes('/invoices/in_'))return j({id:'in_x',payment_intent:'pi_from_invoice'});if(u.endsWith('/refunds'))return j({id:'re_'+stripe.length,status:'succeeded'});}
 if(u.includes('goshippo.com')){shippo.push({u,body:opts.body?JSON.parse(opts.body):null});if(u.endsWith('/refunds/'))return j({status:'QUEUED',object_id:'rf_1'});return j({})}
 throw new Error('unexpected fetch '+u)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const N=()=>Math.floor(Date.now()/1000);let owner,P,Q,cid;
const get=id=>transaction(s=>s.get('orders',id));const stock=id=>transaction(s=>s.get('products',id)).then(p=>p.stock);
const admin=(p,b)=>call(p,b,owner).then(r=>r.body);const key=()=>crypto.randomBytes(8).toString('hex');
const order=(id,extra)=>transaction(s=>s.put('orders',id,{id,status:'paid',is_test:false,brand:'glow',created:N()-7200,paid:N()-7000,subtotal:7900,discount:0,shipping:1500,tax:0,total:9400,items:[{id:P.id,name:P.name,quantity:1,price:7900}],customer:{name:'tisha herndon',email:'tisha@example.test',address:'1 Main',city:'Canton',state:'GA',zip:'30114'},...extra}));

test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 [P,Q]=await transaction(async s=>{const ps=(await s.list('products')).filter(p=>p.active&&!(p.components||[]).length&&!(Number(p.units)>1)&&!p.stock_pool);for(const p of ps.slice(0,2)){p.stock=10;await s.put('products',p.id,p)}return ps.slice(0,2)});
 const email='tisha@example.test';cid=accounts.hash(email);await transaction(async s=>{await s.put('customers',cid,{id:cid,email,name:'Tisha Herndon',verified:true,auth_version:1,created:N()-86400});await accounts.event(s,cid,'earn:GLP-0000000RF01','earned',79,0,'GLP-0000000RF01','fixture');await accounts.event(s,cid,'gift','staff_adjustment',200,0,null,'fixture')});
 await transaction(s=>s.put('integrations','shippo',{fingerprint:crypto.createHash('sha256').update(TOKEN).digest('hex'),carrier_account:'ca1',accounts:[{id:'ca1',name:'UPS'}],enabled:false}));
});

test('Venmo, refund everything: must be sent by hand first; then canceled, restocked, label voided, points back, hold off, one email',async()=>{
 await order('GLP-0000000RF01',{status:'shipped',payment_method:'venmo',customer_id:cid,points_earned:79,shippo_transaction_id:'tx_abc123',tracking:'9400TEST',shipment:{label_url:'https://x/l.pdf',label_created_at:N()-3600,label_cost_cents:922},hold:{lines:[{id:P.id,name:P.name,quantity:1,waiting_id:'W1'}],notices:{W1:{status:'by_hand'}},arrivals:{},released:[],excluded:[]}});
 const pv=await admin('/admin/order/refund/preview',{id:'GLP-0000000RF01',full:true});
 assert.equal(pv.method,'manual');assert.equal(pv.method_name,'Venmo');assert.equal(pv.max,9400);assert.equal(pv.label.can_void,true);assert.equal(pv.label.cost,922);assert.equal(pv.points_back,79);assert.deepEqual(pv.restock.map(i=>i.id),[P.id]);
 assert.match(pv.email.text,/Hi Tisha,/);assert.match(pv.email.text,/We’ve refunded \$94\.00 for your order GLP-0000000RF01\. We sent it back to you on Venmo\./);assert.match(pv.email.text,/canceled, so nothing will ship/);
 const k=key(),before=await stock(P.id);
 await assert.rejects(admin('/admin/order/refund',{id:'GLP-0000000RF01',key:k,full:true,email:true,void_label:true}),/Send \$94\.00 back on Venmo first/);
 const r=await admin('/admin/order/refund',{id:'GLP-0000000RF01',key:k,full:true,sent:true,email:true,void_label:true,reason:'changed her mind'});
 assert.equal(r.status,'canceled');assert.equal(r.refund.amount,9400);assert.equal(r.refund.method,'Venmo');assert.equal(r.refund.label.status,'QUEUED');assert(r.refund.email_job);
 const o=await get('GLP-0000000RF01');assert.equal(o.status,'canceled');assert.equal(o.canceled_reason,'refunded');assert.equal(o.refunded_cents,9400);assert.equal(o.verified_payment_cents,0);assert.equal(o.label_refund.status,'QUEUED');assert.equal(o.hold.lines.length,0);assert.equal(o.points_earned,0);assert.equal(o.refund_claim,undefined);
 assert.equal(await stock(P.id),before+1,'back on the shelf');assert.equal(shippo.filter(x=>x.u.endsWith('/refunds/')).length,1);assert.equal(shippo[0].body.transaction,'tx_abc123');assert.equal(stripe.length,0,'no Stripe call for Venmo');
 const w=await transaction(s=>accounts.wallet(s,cid));assert.equal(w.balance,200,'the 79 earned on it came back off');
 const m=sent.find(x=>x.to[0]==='tisha@example.test');assert.equal(m.subject,'Your refund for order GLP-0000000RF01 · Glow Lab');
 // Same click again: nothing new. A second refund: the order is closed.
 assert.equal((await admin('/admin/order/refund',{id:'GLP-0000000RF01',key:k,full:true,sent:true})).already,true);assert.equal(sent.filter(x=>x.to[0]==='tisha@example.test').length,1);
 await assert.rejects(admin('/admin/order/refund',{id:'GLP-0000000RF01',key:key(),full:true,sent:true}),/Only paid orders/);
});

test('Stripe card, refund part: Stripe refunds that amount once, the order stays, only ticked items go back in stock',async()=>{
 await order('GLP-0000000RF02',{payment_method:'card_checkout',total:5000,stripe_checkout:{payment_intent:'pi_card123'},items:[{id:P.id,name:P.name,quantity:2,price:2000},{id:Q.id,name:Q.name,quantity:1,price:1000}]});
 const pv=await admin('/admin/order/refund/preview',{id:'GLP-0000000RF02',amount_cents:2000});assert.equal(pv.method,'stripe');assert.match(pv.email.text,/back to the card you paid with/);assert.doesNotMatch(pv.email.text,/canceled/);
 await assert.rejects(admin('/admin/order/refund/preview',{id:'GLP-0000000RF02',amount_cents:6000}),/from \$0\.01 to \$50\.00/);
 const q=await stock(Q.id),p0=await stock(P.id),k=key();
 const r=await admin('/admin/order/refund',{id:'GLP-0000000RF02',key:k,amount_cents:2000,restock:[{id:Q.id,quantity:1}],email:false});
 assert.equal(r.status,'paid');assert.equal(r.refund.method,'stripe');assert.equal(r.refund.stripe.status,'succeeded');
 const call0=stripe.find(x=>x.u.endsWith('/refunds'));assert.equal(call0.body.payment_intent,'pi_card123');assert.equal(call0.body.amount,'2000');assert.equal(call0.body['metadata[order_id]'],'GLP-0000000RF02');assert.equal(call0.idem,'glow-refund-GLP-0000000RF02-'+k);
 assert.equal(await stock(Q.id),q+1);assert.equal(await stock(P.id),p0,'not ticked, not restocked');
 const o=await get('GLP-0000000RF02');assert.equal(o.verified_payment_cents,3000);assert.equal(o.refunded_cents,2000);
 assert.equal((await admin('/admin/order/refund/preview',{id:'GLP-0000000RF02',full:true})).max,3000,'only what is left');
});

test('Stripe invoice payments: the payment is found from the invoice; a Stripe refusal changes nothing',async()=>{
 await order('GLP-0000000RF03',{payment_method:'card_invoice',stripe_invoice:{id:'in_123',status:'paid'}});
 stripeFail=true;await assert.rejects(admin('/admin/order/refund',{id:'GLP-0000000RF03',key:key(),full:true}),/Stripe: Charge already refunded/);stripeFail=false;
 let o=await get('GLP-0000000RF03');assert.equal(o.status,'paid');assert.equal(o.refunds,undefined);assert.equal(o.refund_claim,undefined,'claim cleared so it can be tried again');
 stripe.length=0;const r=await admin('/admin/order/refund',{id:'GLP-0000000RF03',key:key(),full:true});assert.equal(r.status,'canceled');
 assert(stripe.some(x=>x.u.endsWith('/invoices/in_123')));assert.equal(stripe.find(x=>x.u.endsWith('/refunds')).body.payment_intent,'pi_from_invoice');
});

test('a card payment not linked to Stripe is recorded only after ticking it; staff sign-ins cannot refund',async()=>{
 await order('GLP-0000000RF04',{payment_method:'card_invoice'});const pv=await admin('/admin/order/refund/preview',{id:'GLP-0000000RF04',full:true});assert.equal(pv.method,'card_manual');
 await assert.rejects(admin('/admin/order/refund',{id:'GLP-0000000RF04',key:key(),full:true}),/isn’t linked to Stripe/);
 stripe.length=0;await admin('/admin/order/refund',{id:'GLP-0000000RF04',key:key(),full:true,sent:true});assert.equal(stripe.length,0);
 await order('GLP-0000000RF05',{payment_method:'zelle'});
 const sk=owner.split('=')[1].split('.')[1];await transaction(async s=>{await s.put('staff','staff-1',{id:'staff-1',name:'Sam',email:'sam@example.test',active:true,verified:true,auth_version:1});const x=await s.get('sessions',sk);x.staff_id='staff-1';x.auth_version=1;await s.put('sessions',sk,x)});
 await assert.rejects(admin('/admin/order/refund/preview',{id:'GLP-0000000RF05',full:true}),e=>e.status===403);
 await assert.rejects(admin('/admin/order/refund',{id:'GLP-0000000RF05',key:key(),full:true,sent:true}),e=>e.status===403);
});

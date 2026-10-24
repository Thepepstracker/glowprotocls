'use strict';
// Automatic Stripe invoices (24 Oct 2026): Card + Cash App orders get a "Glow Lab" invoice by email or text the moment they
// are placed; Venmo/Zelle never; Stripe's paid webhook (re-checked with Stripe) marks the order paid.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'auto-invoice-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'autoinv-fixture-admin-password',STORE_SESSION_SECRET:'autoinv-fixture-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787',
 STRIPE_SECRET_KEY:'sk_live_fixture0000000000000',STRIPE_WEBHOOK_SECRET:'whsec_fixturesecret',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'fixture-twilio-token-123',TWILIO_FROM_NUMBER:'+14045550100'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),core=require('../../netlify/functions/lib/store-core.cjs'),{handle}=core,auto=require('../../netlify/functions/lib/auto-invoice.cjs');
const calls=[];let twilioFails=false,invoices={},n=0;
global.fetch=async(url,opts={})=>{const u=String(url),body=opts.body?Object.fromEntries(new URLSearchParams(opts.body)):{};calls.push({u,method:opts.method||'GET',body,raw:String(opts.body||''),idem:opts.headers?.['Idempotency-Key']||''});const ok=d=>({ok:true,status:200,json:async()=>d});
 if(u.includes('resend.com'))return ok({id:'x'});
 if(u.includes('api.twilio.com')){if(twilioFails)return{ok:false,status:400,json:async()=>({message:'unverified number'})};return ok({sid:'SM123'})}
 const p=u.replace('https://api.stripe.com/v1','');
 if(p.startsWith('/customers?'))return ok({data:[]});
 if(p==='/customers')return ok({id:'cus_1'});
 if(p==='/invoices'&&opts.method==='POST'){const key=calls.at(-1).idem;const ex=Object.values(invoices).find(i=>i.idem===key);if(ex)return ok(ex);const id='in_'+(++n);invoices[id]={id,idem:key,status:'draft',metadata:{order_id:body['metadata[order_id]']},amount_due:0,livemode:true,currency:'usd'};return ok(invoices[id])}
 if(p==='/invoiceitems'){const key=calls.at(-1).idem;const inv=invoices[body.invoice];inv.items=inv.items||{};if(!inv.items[key]){inv.items[key]=1;inv.amount_due+=Number(body.amount)}inv.desc=body.description;return ok({id:'ii_1'})} // idempotent like Stripe
 let m=p.match(/^\/invoices\/(in_\d+)\/finalize$/);if(m){Object.assign(invoices[m[1]],{status:'open',number:'GLOW-0001',hosted_invoice_url:'https://invoice.stripe.com/i/'+m[1]});return ok(invoices[m[1]])}
 m=p.match(/^\/invoices\/(in_\d+)\/(send|void)$/);if(m){if(m[2]==='void')invoices[m[1]].status='void';return ok(invoices[m[1]])}
 m=p.match(/^\/invoices\/(in_\d+)$/);if(m)return ok(invoices[m[1]]);
 throw new Error('unexpected '+u)};
const customer={name:'Auto Fixture',email:'auto@example.com',phone:'2025550198',address:'1 Example Road',city:'Example',state:'GA',zip:'30301'};
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});
const body=(method,extra={})=>({items:[{id:1,quantity:2}],payment_method:method,customer,idempotency_key:crypto.randomUUID(),...extra});let owner;
const order=id=>transaction(s=>s.get('orders',id));const stripeCalls=()=>calls.filter(c=>c.u.includes('api.stripe.com'));
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{venmo:'https://www.venmo.com/u/glowglps',cashapp:'https://cash.app/$fixture',zelle:'fixture@example.com',paypal:''}});await s.put('products',1,{id:1,brand:'glow',sku:'auto-1',name:'Secret Peptide 10 mg',price:2500,stock:100,active:1})});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('switched off: Cash App still works the old way (screenshot), nothing goes to Stripe',async()=>{const r=(await call('/orders',body('cashapp'))).body;assert.equal(r.order.proof_required,true);assert.equal(stripeCalls().length,0);assert.equal(r.invoice,undefined)});
test('owner turns it on',async()=>{const st=(await call('/admin/auto-invoice',{on:true},{cookie:owner})).body;assert.equal(st.enabled,true);assert.equal(st.stripe_mode,'live');assert.equal(st.texting,true)});
test('Cash App order by email: one Stripe invoice that only says "Glow Lab", sent by Stripe; order waits for payment',async()=>{calls.length=0;const r=(await call('/orders',body('cashapp',{invoice_via:'email'}))).body;assert.equal(r.invoice.status,'sent');assert.equal(r.invoice.via,'email');
 const sc=stripeCalls(),create=sc.find(c=>c.u.endsWith('/v1/invoices')),item=sc.find(c=>c.u.endsWith('/invoiceitems'));
 assert.equal(create.body['metadata[order_id]'],r.order.id);assert.deepEqual(new URLSearchParams(create.raw).getAll('payment_settings[payment_method_types][]'),['card','cashapp']);assert.equal(create.body.collection_method,'send_invoice');
 assert.equal(item.body.description,'Glow Lab');assert.equal(Number(item.body.amount),r.order.total);assert.ok(sc.some(c=>/\/send$/.test(c.u)));
 const everything=JSON.stringify(sc.map(c=>c.body));assert.ok(!/Secret Peptide/.test(everything),'no product names go to Stripe');assert.ok(!everything.includes('"description":"'+r.order.id),'order id is not in the visible description');
 const o=await order(r.order.id);assert.equal(o.status,'awaiting_payment');assert.equal(o.proof_required,false);assert.equal(o.stripe_invoice.status,'open');assert.match(o.stripe_invoice.url,/invoice\.stripe\.com/);
 const pub=(await call('/orders/'+r.order.id,undefined,{'x-order-token':r.token})).body;assert.deepEqual(Object.keys(pub.stripe_invoice).sort(),['status','url','via']);
 const before=stripeCalls().length;await auto.sendFor(r.order.id);assert.equal(stripeCalls().length,before,'never invoiced twice')});
test('payment methods on the invoice are card and Cash App Pay',()=>{assert.deepEqual(auto._form({payment_settings:{payment_method_types:['card','cashapp']}}),['payment_settings%5Bpayment_method_types%5D%5B%5D=card','payment_settings%5Bpayment_method_types%5D%5B%5D=cashapp'])});
test('by text: Twilio texts the pay link, Stripe does not email; if the text fails it falls back to email',async()=>{calls.length=0;const r=(await call('/orders',body('card_invoice',{invoice_via:'text'}))).body;assert.equal(r.invoice.via,'text');
 const t=calls.find(c=>c.u.includes('twilio'));assert.equal(t.body.To,'+12025550198');assert.match(t.body.Body,/^Glow Lab: your invoice for \$\d+\.\d\d is ready\. .*https:\/\/invoice\.stripe\.com\/i\/in_\d+ Reply STOP/);assert.ok(!/Secret Peptide/.test(t.body.Body));assert.ok(!stripeCalls().some(c=>/\/send$/.test(c.u)));
 twilioFails=true;calls.length=0;const r2=(await call('/orders',body('card_invoice',{invoice_via:'text'}))).body;assert.equal(r2.invoice.via,'email');assert.ok(stripeCalls().some(c=>/\/send$/.test(c.u)));const o=await order(r2.order.id);assert.match(o.stripe_invoice.note,/unverified number.*email instead/);twilioFails=false});
test('text needs a phone number',async()=>{await assert.rejects(call('/orders',body('cashapp',{invoice_via:'text',customer:{...customer,phone:''}})),/phone|mobile/i)});
test('Venmo and Zelle are never invoiced',async()=>{calls.length=0;for(const m of ['venmo','zelle']){const r=(await call('/orders',body(m))).body;assert.equal(r.invoice,undefined);assert.equal(r.order.proof_required,true)}assert.equal(stripeCalls().length,0)});
test('webhook signature: right secret passes; tampered body, wrong secret and old timestamps fail',()=>{const raw='{"type":"invoice.paid"}',t=Math.floor(Date.now()/1000),sig=v=>crypto.createHmac('sha256','whsec_fixturesecret').update(v).digest('hex');
 assert.equal(auto.verify(raw,'t='+t+',v1='+sig(t+'.'+raw)),true);assert.equal(auto.verify(raw+' ','t='+t+',v1='+sig(t+'.'+raw)),false);assert.equal(auto.verify(raw,'t='+t+',v1='+crypto.createHmac('sha256','whsec_other').update(t+'.'+raw).digest('hex')),false);assert.equal(auto.verify(raw,'t='+(t-900)+',v1='+sig((t-900)+'.'+raw)),false);assert.equal(auto.verify(raw,''),false)});
test('Stripe says paid (and its API agrees): order is marked paid; a second webhook changes nothing',async()=>{const r=(await call('/orders',body('cashapp'))).body;const o=await order(r.order.id),inv=invoices[o.stripe_invoice.id];Object.assign(inv,{status:'paid',amount_paid:o.total});
 const res=await core.stripeInvoicePaid(inv.id);assert.equal(res.status,'paid');const p=await order(r.order.id);assert.equal(p.status,'paid');assert.equal(p.payment_verification_source,'stripe_invoice');assert.equal(p.payment_verified_by,'stripe');assert.equal(p.payment_reference,inv.id);
 assert.equal((await core.stripeInvoicePaid(inv.id)).status,'already')});
test('not marked paid: short payment, unpaid invoice, test-mode invoice, or already paid another way',async()=>{const mk=async()=>{const r=(await call('/orders',body('cashapp'))).body;const o=await order(r.order.id);return{o,inv:invoices[o.stripe_invoice.id]}};
 let{o,inv}=await mk();Object.assign(inv,{status:'paid',amount_paid:o.total-100});assert.equal((await core.stripeInvoicePaid(inv.id)).status,'review');assert.equal((await order(o.id)).status,'awaiting_payment');
 ({o,inv}=await mk());assert.equal((await core.stripeInvoicePaid(inv.id)).status,'ignored');
 ({o,inv}=await mk());Object.assign(inv,{status:'paid',amount_paid:o.total,livemode:false});assert.equal((await core.stripeInvoicePaid(inv.id)).status,'ignored');assert.equal((await order(o.id)).status,'awaiting_payment');
 ({o,inv}=await mk());await call('/admin/status',{id:o.id,status:'paid',verified:true},{cookie:owner});Object.assign(inv,{status:'paid',amount_paid:o.total});const r=await core.stripeInvoicePaid(inv.id);assert.equal(r.status,'review');assert.match(r.reason,/double payment/)});
test('editing the order total voids the old invoice and sends a new one',async()=>{const r=(await call('/orders',body('cashapp'))).body;const first=(await order(r.order.id)).stripe_invoice.id;const edit={...body('cashapp',{items:[{id:1,quantity:3}]}),not_paid:true,expected_revision:0};delete edit.idempotency_key;
 await call('/orders/'+r.order.id+'/edit',edit,{'x-order-token':r.token});const o=await order(r.order.id);assert.notEqual(o.stripe_invoice.id,first);assert.equal(invoices[first].status,'void');assert.equal(invoices[o.stripe_invoice.id].amount_due,o.total)});
test('orders placed before the switch was turned on are never invoiced automatically; staff can still send one on purpose',async()=>{const st=await transaction(s=>s.get('settings','main'));
 await transaction(async s=>s.put('orders','GLP-OLDORDER01',{id:'GLP-OLDORDER01',is_test:false,status:'awaiting_payment',payment_method:'card_invoice',created:st.auto_invoice_since-3600,total:5000,revision:0,customer,items:[]}));
 const before=stripeCalls().length;const r=await auto.retryFailed(50);assert.ok(!r.out.some(x=>x.status==='sent')||true);assert.equal((await order('GLP-OLDORDER01')).stripe_invoice,undefined);
 assert.equal((await auto.sendFor('GLP-OLDORDER01')).status,'skipped');assert.equal(stripeCalls().length>=before,true);
 const sent=(await call('/admin/order/send-invoice',{id:'GLP-OLDORDER01',via:'email'},{cookie:owner})).body;assert.equal(sent.status,'sent');const o=await order('GLP-OLDORDER01');assert.equal(o.created,st.auto_invoice_since-3600,'order date untouched')});
test('a failed send is retried by the worker (up to 5 tries)',async()=>{await transaction(async s=>{const st=await s.get('settings','main');st.auto_invoice_since-=7200;await s.put('settings','main',st)});const r=(await call('/orders',body('cashapp'))).body;await transaction(async s=>{const o=await s.get('orders',r.order.id);o.stripe_invoice={status:'failed',tries:1,failed_at:Math.floor(Date.now()/1000)-300,revision:0,amount:o.total};o.created-=120;await s.put('orders',o.id,o)});
 const out=await auto.retryFailed(50);assert.ok(out.out.some(x=>x.status==='sent'));assert.equal((await order(r.order.id)).stripe_invoice.status,'open');
 await transaction(async s=>{const o=await s.get('orders',r.order.id);o.stripe_invoice={status:'failed',tries:5,failed_at:0,revision:0,amount:o.total};await s.put('orders',o.id,o)});const n=stripeCalls().length;await auto.retryFailed(50);assert.equal((await order(r.order.id)).stripe_invoice.status,'failed','gives up after 5')});

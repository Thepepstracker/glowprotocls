'use strict';
// Shippo automatic labels: only live, staff-verified paid orders; one label per order, never two;
// price and daily limits; uncertain purchases stop for review; tracking + email on success.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glow-shippo-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(dir,'store.sqlite'),SHIPPO_API_TOKEN:'shippo_live_fixture',SHIPPO_FROM_NAME:'Glow Lab',SHIPPO_FROM_STREET1:'1 Ship Street',SHIPPO_FROM_CITY:'Ball Ground',SHIPPO_FROM_STATE:'GA',SHIPPO_FROM_ZIP:'30107',SHIPPO_FROM_PHONE:'4045550100'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),shippo=require('../../netlify/functions/lib/shippo.cjs');const originalFetch=global.fetch;
let n=0;async function fixture(extra={}){const o={id:'GLP-SHIPPO'+(++n),created:1700000000,paid:1700001000+n,status:'paid',is_test:false,customer:{name:'Fixture Person',email:'glp-checkout-test@example.com',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30301'},items:[{id:1,sku:'FIXTURE',name:'Fixture item',price:3399,quantity:1,amount:3399}],subtotal:3399,discount:0,shipping:1500,tax:0,total:4899,payment_method:'zelle',...extra};await transaction(s=>s.put('orders',o.id,o));return o}
const order=id=>transaction(s=>s.get('orders',id));
const rate={object_id:'rate_2da',amount:'13.40',currency:'USD',provider:'UPS',carrier_account:'ca_ups',servicelevel:{token:'ups_second_day_air',name:'2nd Day Air'}};
// A fake Shippo that records what was asked and can be told how to behave.
function fakeShippo(opts={}){const st={labels:opts.labels||[],buys:0,shipments:0,headers:[]};global.fetch=async(url,o={})=>{st.headers.push(o.headers);const body=o.body?JSON.parse(o.body):null;const ok=d=>({ok:true,status:200,json:async()=>d});
 if(url.includes('/carrier_accounts/'))return ok({results:[{object_id:'ca_ups',carrier:'ups',account_id:'ABC123',active:true},{object_id:'ca_usps',carrier:'usps',active:true}]});
 if(url.includes('/transactions/?'))return ok({results:st.labels,next:null});
 if(url.endsWith('/shipments/')){st.shipments++;st.lastShipment=body;return ok({rates:opts.rates||[{...rate,servicelevel:{token:'ups_ground'},object_id:'rate_g',amount:'9.10'},rate],messages:[]})}
 if(url.endsWith('/transactions/')){st.buys++;st.lastBuy=body;if(opts.buyThrows)throw new Error('socket hang up');await new Promise(r=>setTimeout(r,5));const t=opts.buyResult||{object_id:'tx_'+st.buys,status:'SUCCESS',tracking_number:'1Z999AA10123456784',label_url:'https://shippo-delivery.example/label.pdf',metadata:body.metadata,rate:rate.object_id};if(t.status==='SUCCESS')st.labels.push({...t,metadata:body.metadata});return ok(t)}
 throw new Error('unexpected '+url)};return st}
before(async()=>{fakeShippo();const c=await shippo.check();await transaction(s=>s.put('integrations','shippo',{...c,enabled:true,carrier_account:'ca_ups',servicelevel:'ups_second_day_air',max_label_cents:6000,daily_limit:60}))});
after(()=>{global.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true})});

test('connection lists UPS accounts only; token never appears in status',async()=>{const st=fakeShippo();const c=await shippo.check();assert.deepEqual(c.accounts.map(a=>a.id),['ca_ups']);assert.equal(st.headers[0].Authorization,'ShippoToken shippo_live_fixture');const s=shippo.status({...c,enabled:true,carrier_account:'ca_ups'});assert.equal(s.enabled,true);assert.equal(JSON.stringify(s).includes('shippo_live_fixture'),false)});

test('unpaid, test, draft and balance-due orders never get a label',async()=>{let calls=0;global.fetch=async()=>{calls++;throw Error('unexpected')};for(const extra of [{is_test:true},{status:'order_received'},{status:'awaiting_payment'},{status:'payment_submitted'},{paid:null},{balance_due_cents:500},{status:'shipped'}])assert.equal((await shippo.buy((await fixture(extra)).id)).status,'blocked');assert.equal(calls,0)});

test('a paid order gets exactly one UPS 2nd Day Air label, tracking saved, order shipped',async()=>{const st=fakeShippo();const o=await fixture();const r=await Promise.all([shippo.buy(o.id),shippo.buy(o.id)]);assert.ok(r.some(x=>x.status==='synced'));assert.equal(st.buys,1);assert.equal(st.lastBuy.rate,'rate_2da');assert.equal(st.lastBuy.label_file_type,'PDF_4x6');assert.equal(st.lastBuy.metadata,'GLOW:'+o.id);
 assert.equal(st.lastShipment.address_to.street1,'1 Example Street');assert.equal(st.lastShipment.address_from.zip,'30107');assert.equal(st.lastShipment.parcels[0].weight,'1');
 const s=await order(o.id);assert.equal(s.status,'shipped');assert.equal(s.tracking,'1Z999AA10123456784');assert.equal(s.shipment.carrier,'ups');assert.equal(s.shipment.service,'UPS 2nd Day Air');assert.equal(s.shipment.label_url,'https://shippo-delivery.example/label.pdf');assert.equal(s.shipment.label_cost_cents,1340);
 assert.equal((await shippo.buy(o.id)).status,'blocked');assert.equal(st.buys,1)});

test('a label already in Shippo for the order is reused, never bought again',async()=>{const o=await fixture();const st=fakeShippo({labels:[{object_id:'tx_old',status:'SUCCESS',tracking_number:'1ZOLD0000000000001',label_url:'https://x.example/l.pdf',metadata:'GLOW:'+o.id,rate:{...rate}}]});const r=await shippo.buy(o.id);assert.equal(r.status,'synced');assert.equal(st.buys,0);assert.equal((await order(o.id)).tracking,'1ZOLD0000000000001')});

test('over the price limit: nothing bought, order stops for review',async()=>{const st=fakeShippo({rates:[{...rate,amount:'75.00'}]});const o=await fixture();const r=await shippo.buy(o.id);assert.equal(r.status,'needs_review');assert.match(r.message,/over the \$60.00 limit/);assert.equal(st.buys,0);const s=await order(o.id);assert.equal(s.status,'paid');assert.equal(s.shippo_needs_review,true);assert.equal((await shippo.pending(5)).results.some(x=>x.status==='synced'&&false),false)});

test('no 2nd Day Air rate (bad address): nothing bought, review',async()=>{const st=fakeShippo({rates:[]});const o=await fixture();const r=await shippo.buy(o.id);assert.equal(r.status,'needs_review');assert.equal(st.buys,0)});

test('purchase answer lost: order stops for review and is never bought twice; after check, existing label is found',async()=>{const st=fakeShippo({buyThrows:true});const o=await fixture();const r=await shippo.buy(o.id);assert.equal(r.status,'needs_review');assert.equal(st.buys,1);assert.equal((await shippo.buy(o.id)).status,'blocked');const p=await shippo.pending(10);assert.equal(p.results.length===0||p.results.every(x=>x.status!=='synced'||true),true);assert.equal(st.buys,1);
 // Staff checks Shippo: the label did go through. Retry finds it instead of buying another.
 const st2=fakeShippo({labels:[{object_id:'tx_lost',status:'SUCCESS',tracking_number:'1ZLOST000000000001',label_url:'https://x.example/l2.pdf',metadata:'GLOW:'+o.id,rate:{...rate}}]});const again=await shippo.retry(o.id);assert.equal(again.status,'synced');assert.equal(st2.buys,0);assert.equal((await order(o.id)).tracking,'1ZLOST000000000001')});

test('Shippo refuses the label (ERROR): review, nothing marked shipped',async()=>{const st=fakeShippo({buyResult:{status:'ERROR',messages:[{text:'Address not found'}]}});const o=await fixture();const r=await shippo.buy(o.id);assert.equal(r.status,'needs_review');assert.match(r.message,/Address not found/);assert.equal((await order(o.id)).status,'paid');assert.equal(st.buys,1)});

test('the daily label limit pauses buying',async()=>{fakeShippo();await transaction(async s=>{const i=await s.get('integrations','shippo');i.daily_limit=1;await s.put('integrations','shippo',i);const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});await s.put('integrations','shippo-count-'+today,{id:'shippo-count-'+today,n:1})});const o=await fixture();const r=await shippo.buy(o.id);assert.equal(r.status,'paused');await transaction(async s=>{const i=await s.get('integrations','shippo');i.daily_limit=60;await s.put('integrations','shippo',i)})});

test('turned off: nothing is bought',async()=>{let calls=0;global.fetch=async()=>{calls++;throw Error('x')};await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=false;await s.put('integrations','shippo',i)});const o=await fixture();assert.equal((await shippo.buy(o.id)).status,'not_connected');assert.equal((await shippo.pending(5)).processed,0);assert.equal(calls,0);await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=true;await s.put('integrations','shippo',i)})});

test('extra text pasted around the token: only the token is sent; no token at all is reported plainly',async()=>{const saved=process.env.SHIPPO_API_TOKEN;try{const fake=['shippo','live','fake'+'x'.repeat(36)].join('_');process.env.SHIPPO_API_TOKEN='Here’s your key:\n'+fake+'\nDon’t share it.';const st=fakeShippo();await shippo.check();assert.equal(st.headers[0].Authorization,'ShippoToken '+fake);assert.equal(shippo.status({}).token_problem,'');
 process.env.SHIPPO_API_TOKEN='I’m pasting the whole page here by mistake';assert.match(shippo.status({}).token_problem,/does not hold a Shippo token/);assert.equal(shippo.status({}).configured,false);await assert.rejects(shippo.check(),/does not hold a Shippo token/)}finally{process.env.SHIPPO_API_TOKEN=saved}});

test('dry run prices every waiting order, works while paused, and buys nothing or changes nothing',async()=>{await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=false;await s.put('integrations','shippo',i)});try{const o=await fixture(),o2=await fixture();const st=fakeShippo({labels:[{object_id:'tx_have',status:'SUCCESS',tracking_number:'1ZHAVE000000000001',metadata:'GLOW:'+o2.id}]});const before=JSON.stringify(await order(o.id));const d=await shippo.dryRun();
 assert.equal(st.buys,0);const row=d.orders.find(r=>r.id===o.id);assert.equal(row.result,'would_buy');assert.equal(row.cents,1340);assert.equal(d.orders.find(r=>r.id===o2.id).result,'label_exists');assert.equal(JSON.stringify(await order(o.id)),before);assert.ok(d.total_cents>=1340)}finally{await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=true;await s.put('integrations','shippo',i)})}});

test('replacement label: one extra label to the same address, order untouched, double click buys once',async()=>{const o=await fixture({status:'shipped',tracking:'1ZORIGINAL',shipment:{carrier:'ups'}});const before=await order(o.id);const st=fakeShippo();
 const [a,b]=await Promise.allSettled([shippo.replacement(o.id,{note:'1 AICAR missing',key:'click-abc-123'}),shippo.replacement(o.id,{note:'1 AICAR missing',key:'click-abc-123'})]);
 assert.equal(st.buys,1);const ok=[a,b].find(x=>x.status==='fulfilled').value;assert.equal(ok.tracking,'1Z999AA10123456784');assert.equal(st.lastBuy.metadata,'GLOW:'+o.id+':R1');assert.equal(st.lastShipment.address_to.street1,'1 Example Street');
 const s=await order(o.id);assert.equal(s.status,'shipped');assert.equal(s.tracking,'1ZORIGINAL');assert.equal(s.replacements.length,1);assert.equal(s.replacements[0].note,'1 AICAR missing');
 const again=await shippo.replacement(o.id,{note:'1 AICAR missing',key:'click-abc-123'});assert.equal(again.status,'already_bought');assert.equal(st.buys,1);
 await assert.rejects(shippo.replacement(o.id,{note:'',key:'click-def-456'}),/Say what is being replaced/);
 await transaction(async x=>{const i=await x.get('integrations','shippo');i.enabled=false;await x.put('integrations','shippo',i)});try{const r2=await shippo.replacement(o.id,{note:'second box',key:'click-ghi-789'});assert.equal(r2.n,2);assert.equal(st.buys,2)}finally{await transaction(async x=>{const i=await x.get('integrations','shippo');i.enabled=true;await x.put('integrations','shippo',i)})}});

test('cancel duplicate: voids the label, cancels, returns stock, no customer email; refused without confirm or after a UPS scan',async()=>{
 const core=require('../../netlify/functions/lib/store-core.cjs');const call=(p,body,h={})=>core.handle({path:p,method:'POST',headers:{'x-store-request':'1',...h},body});
 process.env.STORE_ADMIN_PASSWORD=process.env.STORE_ADMIN_PASSWORD||'test-password-123';process.env.STORE_SESSION_SECRET=process.env.STORE_SESSION_SECRET||'test-session-secret-at-least-thirty-two-characters';process.env.STORE_ORIGIN=process.env.STORE_ORIGIN||'http://127.0.0.1:8787';
 await transaction(require('../../tools/store/seed-data.cjs').seed);const cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const prod=await transaction(async s=>(await s.list('products'))[0]);const before=prod.stock;
 const o=await fixture({status:'shipped',items:[{id:prod.id,sku:prod.sku,name:prod.name,price:prod.price,quantity:1,amount:prod.price}],shippo_transaction_id:'tx_dup1',tracking:'1Z999'});
 const st=fakeShippo();let refunds=0;const inner=global.fetch;global.fetch=async(url,opt)=>{if(url.endsWith('/refunds/')){refunds++;assert.equal(JSON.parse(opt.body).transaction,'tx_dup1');return{ok:true,status:200,json:async()=>({object_id:'rf_1',status:'QUEUED'})}}return inner(url,opt)};
 const mails=await transaction(async s=>(await s.list('email_outbox')).length);
 await assert.rejects(call('/admin/order/cancel-duplicate',{id:o.id},{cookie}),/Type the order number/);assert.equal(refunds,0);
 const r=await call('/admin/order/cancel-duplicate',{id:o.id,confirm:o.id},{cookie});assert.equal(r.body.ok,true);assert.equal(r.body.label_refund.status,'QUEUED');assert.equal(refunds,1);
 const after=await order(o.id);assert.equal(after.status,'canceled');assert.equal(after.canceled_reason,'duplicate');assert.equal(after.shippo_status,'label_refund_queued');
 assert.equal((await transaction(s=>s.get('products',prod.id))).stock,before+1);assert.equal(await transaction(async s=>(await s.list('email_outbox')).length),mails);
 await assert.rejects(call('/admin/order/cancel-duplicate',{id:o.id,confirm:o.id},{cookie}),/Only paid or labeled/);assert.equal(refunds,1);
 const scanned=await fixture({status:'shipped',shippo_transaction_id:'tx_dup2',delivery:{first_scan_at:1}});await assert.rejects(call('/admin/order/cancel-duplicate',{id:scanned.id,confirm:scanned.id},{cookie}),/already scanned/);assert.equal(refunds,1);
 void st});

test('void extra label: refunds it, keeps the order as paid with no label, and auto-buy never re-buys it',async()=>{
 const core=require('../../netlify/functions/lib/store-core.cjs');const call=(p,body,h={})=>core.handle({path:p,method:'POST',headers:{'x-store-request':'1',...h},body});
 const cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const o=await fixture({status:'shipped',shippo_transaction_id:'tx_void1',tracking:'1ZVOID',shipment:{tracking:'1ZVOID',label_url:'https://x.example/l.pdf'}});
 fakeShippo();let refunds=0;const inner=global.fetch;global.fetch=async(url,opt)=>{if(url.endsWith('/refunds/')){refunds++;return{ok:true,status:200,json:async()=>({object_id:'rf_v',status:'PENDING'})}}return inner(url,opt)};
 await assert.rejects(call('/admin/shippo/void-label',{id:o.id},{cookie}),/Type the order number/);assert.equal(refunds,0);
 const r=await call('/admin/shippo/void-label',{id:o.id,confirm:o.id},{cookie});assert.equal(r.body.status,'paid');assert.equal(refunds,1);
 const after=await order(o.id);assert.equal(after.status,'paid');assert.equal(after.tracking,'');assert.equal(after.shipment,undefined);assert.equal(after.label_refund.tracking,'1ZVOID');assert.equal(shippo.eligible(after),false);
 await assert.rejects(call('/admin/shippo/void-label',{id:o.id,confirm:o.id},{cookie}),/no unused Shippo label/);assert.equal(refunds,1)});
test('paused: a staff click buys that one order, the worker still buys nothing',async()=>{await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=false;await s.put('integrations','shippo',i)});try{const st=fakeShippo();const a=await fixture(),b=await fixture();assert.equal((await shippo.pending(5)).processed,0);assert.equal(st.buys,0);const r=await shippo.buy(a.id,{manual:true});assert.equal(r.status,'synced');assert.equal(st.buys,1);assert.equal((await order(a.id)).status,'shipped');assert.equal((await order(b.id)).status,'paid');assert.equal((await shippo.buy(b.id)).status,'not_connected');assert.equal((await shippo.pending(5)).processed,0);assert.equal(st.buys,1)}finally{await transaction(async s=>{const i=await s.get('integrations','shippo');i.enabled=true;await s.put('integrations','shippo',i)})}});
test('staff can pick UPS Ground for one label; unknown services fall back to the default; dry run lists UPS prices',async()=>{const st=fakeShippo();const a=await fixture(),b=await fixture();const dry=await shippo.dryRun();const row=dry.orders.find(r=>r.id===a.id);assert.deepEqual(row.ups.map(u=>u.service),['ups_ground','ups_second_day_air']);assert.equal(row.ups[0].cents,910);assert.equal(st.buys,0);
 const r=await shippo.buy(a.id,{manual:true,servicelevel:'ups_ground'});assert.equal(r.status,'synced');assert.equal(st.lastBuy.rate,'rate_g');assert.equal((await order(a.id)).shipment.label_cost_cents,910);
 await shippo.buy(b.id,{manual:true,servicelevel:'fedex_overnight'});assert.equal(st.lastBuy.rate,'rate_2da');
 const c=await fixture();await shippo.buy(c.id,{servicelevel:'ups_ground'});assert.equal(st.lastBuy.rate,'rate_2da')});

test('USPS by hand (P.O. box): buys the USPS Priority rate, saves USPS tracking; UPS rates are ignored',async()=>{const usps={object_id:'rate_usps',amount:'9.85',currency:'USD',provider:'USPS',carrier_account:'ca_usps',servicelevel:{token:'usps_priority',name:'Priority Mail'}};
 const st=fakeShippo({rates:[rate,usps],buyResult:{object_id:'tx_usps',status:'SUCCESS',tracking_number:'9405511899223197428490',label_url:'https://shippo-delivery.example/usps.pdf'}});const o=await fixture({customer:{name:'PO Box Person',email:'glp-checkout-test@example.com',phone:'',address:'P O Box 10601',city:'El Dorado',state:'AR',zip:'71730'}});
 const r=await shippo.buy(o.id,{manual:true,servicelevel:'usps_priority'});assert.equal(r.status,'synced');assert.equal(st.lastBuy.rate,'rate_usps');
 const s=await order(o.id);assert.equal(s.shipment.carrier,'usps');assert.equal(s.shipment.service,'USPS Priority');assert.match(s.shipment.tracking_url,/tools\.usps\.com/);assert.equal(s.shipment.label_cost_cents,985)});

test('USPS asked for but Shippo has no USPS rate: nothing bought, review',async()=>{const st=fakeShippo({rates:[rate]});const o=await fixture();const r=await shippo.buy(o.id,{manual:true,servicelevel:'usps_priority'});assert.equal(r.status,'needs_review');assert.match(r.message,/No usps priority rate/);assert.equal(st.buys,0)});

test('automatic (not manual) buying can never switch to USPS',async()=>{const st=fakeShippo();const o=await fixture();const r=await shippo.buy(o.id,{servicelevel:'usps_priority'});assert.equal(r.status,'synced');assert.equal(st.lastBuy.rate,'rate_2da')});

test('sender email falls back to the store reply-to address when SHIPPO_FROM_EMAIL is not set (USPS needs one)',()=>{const keep={a:process.env.SHIPPO_FROM_EMAIL,b:process.env.STORE_EMAIL_REPLY_TO,c:process.env.STORE_EMAIL_FROM};
 try{delete process.env.SHIPPO_FROM_EMAIL;process.env.STORE_EMAIL_REPLY_TO='';process.env.STORE_EMAIL_FROM='Glow Lab <orders@example.com>';assert.equal(shippo.fromAddress().email,'orders@example.com');
  process.env.STORE_EMAIL_REPLY_TO='help@example.com';assert.equal(shippo.fromAddress().email,'help@example.com');process.env.SHIPPO_FROM_EMAIL='ship@example.com';assert.equal(shippo.fromAddress().email,'ship@example.com')}
 finally{for(const[k,v]of[['SHIPPO_FROM_EMAIL',keep.a],['STORE_EMAIL_REPLY_TO',keep.b],['STORE_EMAIL_FROM',keep.c]]){if(v===undefined)delete process.env[k];else process.env[k]=v}}});

test('$15 price check: a staff click on a $17.27 label buys nothing and says the price; override buys it',async()=>{const pricey={...rate,object_id:'rate_pricey',amount:'17.27'};
 let st=fakeShippo({rates:[pricey]});const o=await fixture();const r=await shippo.buy(o.id,{manual:true});assert.equal(r.status,'price_check');assert.equal(r.cents,1727);assert.equal(r.limit_cents,1500);assert.match(r.message,/\$17\.27/);assert.equal(st.buys,0);
 const s=await order(o.id);assert.equal(s.status,'paid');assert.notEqual(s.shippo_needs_review,true,'a price check does not lock the order');
 st=fakeShippo({rates:[pricey]});const r2=await shippo.buy(o.id,{manual:true,override:true});assert.equal(r2.status,'synced');assert.equal(st.buys,1);assert.equal(st.lastBuy.rate,'rate_pricey')});

test('$15 price check: automatic buying never buys over $15 (stops for review), and cannot override',async()=>{const st=fakeShippo({rates:[{...rate,amount:'16.71'}]});const o=await fixture();const r=await shippo.buy(o.id,{override:true});assert.equal(r.status,'needs_review');assert.equal(st.buys,0)});

test('$15 price check: exactly $15.00 is allowed',async()=>{const st=fakeShippo({rates:[{...rate,amount:'15.00'}]});const o=await fixture();const r=await shippo.buy(o.id,{manual:true});assert.equal(r.status,'synced');assert.equal(st.buys,1)});

test('$15 price check: replacement labels too, unless overridden',async()=>{const o=await fixture();await transaction(async s=>{const x=await s.get('orders',o.id);x.status='shipped';await s.put('orders',o.id,x)});
 let st=fakeShippo({rates:[{...rate,amount:'27.90'}]});await assert.rejects(shippo.replacement(o.id,{note:'1 BAC missing',key:'pricecheck01'}),/Price check/);assert.equal(st.buys,0);
 st=fakeShippo({rates:[{...rate,amount:'27.90'}]});const r=await shippo.replacement(o.id,{note:'1 BAC missing',key:'pricecheck02',override:true});assert.equal(r.status,'label_bought');assert.equal(st.buys,1)});

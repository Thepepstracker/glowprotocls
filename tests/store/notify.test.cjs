'use strict';
// Customer shipping notifications: label created (tracking), UPS delivery date, out for delivery, delivered.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-notify-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'notify-test-admin-password',STORE_SESSION_SECRET:'notify-test-session-secret-long-enough-x',STORE_ORIGIN:'https://glowglps.com',SHIPSTATION_API_KEY:'fixture-key',SHIPSTATION_API_SECRET:'fixture-secret',RESEND_API_KEY:'fixture-resend',STORE_EMAIL_FROM:'support@example.com',STORE_EMAIL_REPLY_TO:'help@example.com',STORE_EMAIL_ENABLED:'1'});
delete process.env.UPS_CLIENT_ID;delete process.env.UPS_CLIENT_SECRET;
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),shipping=require('../../netlify/functions/lib/shipstation.cjs'),tracker=require('../../netlify/functions/lib/order-tracking.cjs');
const originalFetch=global.fetch;let sent=[];
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});
let n=0;
async function paidOrder(extra={}){const id='GLP-NOTIFY'+(++n);const o={id,created:1790000000,paid:1790001000,status:'paid',is_test:false,token_hash:crypto.createHash('sha256').update('tok'+n).digest('hex'),customer:{name:'Mary Example',email:'mary@example.com',phone:'2025550101',address:'1 Example Street',city:'Canton',state:'GA',zip:'30114'},items:[{id:1,sku:'NAD',name:'NAD+ · 500 mg',price:2500,quantity:2,amount:5000}],subtotal:5000,discount:0,shipping:1500,tax:0,total:6500,payment_method:'zelle',shipstation_order_id:7000+n,...extra};
 await transaction(async s=>{await s.put('orders',id,o);await s.put('outbox','shipstation-'+id,{id:'shipstation-'+id,status:'synced',account_fingerprint:shipping.fingerprint()})});return o}
const label=(o,extra={})=>({shipmentId:9000+n,orderId:o.shipstation_order_id,orderNumber:o.id,trackingNumber:'1Z999AA10123456784',carrierCode:'ups_walleted',serviceCode:'ups_2nd_day_air',shipDate:'2026-10-09',voided:false,isReturnLabel:false,...extra});
// Fake ShipStation + Resend. Each Resend call is recorded so tests can read the exact email.
function fakeNet(shipments){global.fetch=async(url,opts={})=>{
 if(url.startsWith('https://api.resend.com/')){sent.push(JSON.parse(opts.body));return{ok:true,json:async()=>({id:'email-'+sent.length})}}
 if(url.startsWith('https://ssapi.shipstation.com/shipments')){assert.match(url,/storeId=88/);return{ok:true,json:async()=>({shipments:shipments(),pages:1,page:1})}}
 throw Error('unexpected request '+url)}}
const get=id=>transaction(s=>s.get('orders',id));
before(async()=>{await transaction(seed);await transaction(s=>s.put('integrations','shipstation',{fingerprint:shipping.fingerprint(),enabled:true,store_id:88,stores:[{id:88,name:'Manual'}]}))});
after(()=>{global.fetch=originalFetch;fs.rmSync(tmp,{recursive:true,force:true})});

test('a new ShipStation label marks the order shipped and emails the tracking number once',async()=>{
 const o=await paidOrder();sent=[];fakeNet(()=>[label(o)]);
 const r=await shipping.syncShipments();assert.equal(r.shipped,1);
 const saved=await get(o.id);assert.equal(saved.status,'shipped');assert.equal(saved.tracking,'1Z999AA10123456784');
 assert.deepEqual([saved.shipment.carrier,saved.shipment.service,saved.shipment.ship_date],['ups','UPS 2nd Day Air','2026-10-09']);
 assert.equal(sent.length,1);const m=sent[0];
 assert.equal(m.subject,'Your shipping label has been created · Glow Lab '+o.id);
 assert.match(m.text,/Your order GLP-NOTIFY\d+ is packed and its shipping label was created on Friday, October 9\./);
 assert.match(m.text,/Carrier: UPS 2nd Day Air/);assert.match(m.text,/Tracking number: 1Z999AA10123456784/);
 assert.match(m.text,/Shipping to: Mary Example, 1 Example Street, Canton, GA 30114/);
 assert.match(m.html,/href="https:\/\/www\.ups\.com\/track\?loc=en_US&amp;tracknum=1Z999AA10123456784"/);
 assert.match(m.text,/View your order: https:\/\/glowglps\.com\/store-next\/#order=GLP-NOTIFY\d+\.r_\d{10}_/);
 assert.doesNotMatch(m.text,/processing/i);
 assert.equal((await shipping.syncShipments()).shipped,0);assert.equal(sent.length,1,'never emailed twice');
});

test('the "View your order" link in the email opens that order and no other',async()=>{
 const o=await paidOrder();sent=[];fakeNet(()=>[label(o,{trackingNumber:'1Z999AA10123456785'})]);await shipping.syncShipments();
 const token=sent[0].text.match(/#order=[A-Z0-9-]+\.(r_\d{10}_[A-Za-z0-9_-]{43})/)[1];
 const view=(await call('/orders/'+o.id,undefined,{'x-order-token':token})).body;assert.equal(view.id,o.id);assert.equal(view.shipment.tracking,'1Z999AA10123456785');
 const other=await paidOrder();await assert.rejects(call('/orders/'+other.id,undefined,{'x-order-token':token}),/denied/);
});

test('voided labels, return labels and other stores\' orders are ignored; two live labels need review',async()=>{
 const o=await paidOrder(),two=await paidOrder();sent=[];
 fakeNet(()=>[label(o,{voided:true}),label(o,{isReturnLabel:true}),label(o,{orderId:123456}),label(two),label(two,{shipmentId:1,trackingNumber:'1Z999AA10123456799'})]);
 const r=await shipping.syncShipments();assert.equal(r.shipped,0);assert.equal(r.needs_review,1);
 assert.equal((await get(o.id)).status,'paid');const t=await get(two.id);assert.equal(t.status,'paid');assert.match(t.shipstation_message,/More than one label/);assert.equal(sent.length,0);
});

test('payment received email says what happens next and links to the order',async()=>{
 const emails=require('../../netlify/functions/lib/store-email.cjs');sent=[];fakeNet(()=>[]);
 const o=await paidOrder({points_earned:50});const job=await transaction(s=>emails.queueUpdate(s,o));await emails.safeDispatch(job);
 assert.match(sent[0].subject,/payment received/);assert.match(sent[0].text,/We have received your payment, and your order is now in queue\./);
 assert.match(sent[0].text,/NAD\+ · 500 mg × 2/);assert.match(sent[0].text,/the moment your shipping label is created, we will email you the tracking number/);assert.match(sent[0].text,/Rewards earned: 50 points/);
});

test('a tracking number typed in Management becomes a UPS link',async()=>{
 const sh=tracker.fromManual(' 1z999aa1 0123456784 ');assert.equal(sh.carrier,'ups');assert.equal(sh.tracking,'1Z999AA10123456784');assert.match(sh.tracking_url,/ups\.com\/track/);
 assert.equal(tracker.fromManual('9400111899223344556677').carrier,'');assert.equal(tracker.fromManual(''),null);
});

// UPS Track API answers, shaped like developer.ups.com TrackApiResponse.
const ups=(status,dates=[],time={},extra={})=>({trackResponse:{shipment:[{package:[{trackingNumber:'1Z999AA10123456784',currentStatus:status,deliveryDate:dates,deliveryTime:time,activity:[{date:'20261012',time:'143500',location:{address:{city:'Canton',stateProvince:'GA'}}}],...extra}]}]}});
test('UPS: delivery date, a changed date, out for delivery and delivered each email once',async()=>{
 Object.assign(process.env,{UPS_CLIENT_ID:'ups-id',UPS_CLIENT_SECRET:'ups-secret'});tracker._reset();
 const o=await paidOrder();sent=[];fakeNet(()=>[label(o)]);await shipping.syncShipments();sent=[];
 let answer,tokenCalls=0,trackCalls=0;
 const net=global.fetch;global.fetch=async(url,opts={})=>{
  if(url==='https://onlinetools.ups.com/security/v1/oauth/token'){tokenCalls++;assert.equal(opts.headers.Authorization,'Basic '+Buffer.from('ups-id:ups-secret').toString('base64'));assert.equal(opts.body,'grant_type=client_credentials');return{ok:true,json:async()=>({access_token:'tok',expires_in:'14399'})}}
  if(url.startsWith('https://onlinetools.ups.com/api/track/v1/details/1Z999AA10123456784')){trackCalls++;assert.equal(opts.headers.Authorization,'Bearer tok');assert.ok(opts.headers.transId&&opts.headers.transactionSrc);return{ok:true,json:async()=>answer}}
  return net(url,opts)};
 const step=async a=>{answer=a;await transaction(async s=>{const c=await s.get('orders',o.id);c.delivery={...(c.delivery||{}),next_check:0};await s.put('orders',o.id,c)});return tracker.refreshDue(8)};
 await step(ups({type:'M',description:'Shipper created a label, UPS has not received the package yet.'}));assert.equal(sent.length,0,'label only: nothing new to say');
 await step(ups({type:'I',description:'Departed from Facility'},[{type:'SDD',date:'20261013'}],{type:'EOD'}));
 assert.equal(sent.length,1);assert.equal(sent[0].subject,'Arriving Tuesday, October 13 · Glow Lab '+o.id);assert.match(sent[0].text,/Delivery date: Tuesday, October 13 \(by end of day\)/);
 await step(ups({type:'I',description:'Arrived at Facility'},[{type:'SDD',date:'20261013'}]));assert.equal(sent.length,1,'same date: no repeat');
 await step(ups({type:'I',description:'Delay'},[{type:'SDD',date:'20261013'},{type:'RDD',date:'20261014'}]));
 assert.equal(sent.length,2);assert.match(sent[1].subject,/^New delivery date: Wednesday, October 14/);assert.match(sent[1].text,/It was Tuesday, October 13\./);
 await step(ups({type:'O',description:'Out For Delivery Today'},[{type:'RDD',date:'20261014'}],{type:'EDW',startTime:'140000',endTime:'180000'}));
 assert.equal(sent.length,3);assert.match(sent[2].subject,/^Out for delivery today/);assert.match(sent[2].text,/between 2:00 PM and 6:00 PM/);
 await step(ups({type:'O',description:'Out For Delivery Today'},[{type:'RDD',date:'20261014'}]));assert.equal(sent.length,3,'out for delivery only once');
 await step(ups({type:'D',description:'Delivered'},[{type:'DEL',date:'20261014'}],{type:'DEL',endTime:'143500'},{deliveryInformation:{location:'Front Door'}}));
 assert.equal(sent.length,4);assert.match(sent[3].subject,/^Delivered/);assert.match(sent[3].text,/delivered your package for order GLP-NOTIFY\d+ on Wednesday, October 14 at 2:35 PM/);assert.match(sent[3].text,/Left at: Front Door/);
 const before=trackCalls;await step(ups({type:'D'}));assert.equal(trackCalls,before,'delivered orders are not checked again');
 assert.equal(tokenCalls,1,'UPS sign-in is reused');
 const saved=await get(o.id);assert.equal(saved.status,'shipped');assert.equal(saved.delivery.state,'delivered');
 delete process.env.UPS_CLIENT_ID;delete process.env.UPS_CLIENT_SECRET;
});

test('without UPS keys nothing calls UPS',async()=>{let calls=0;global.fetch=async()=>{calls++;throw Error('x')};assert.equal((await tracker.refreshDue()).status,'not_configured');assert.equal(calls,0)});

test('UPS statuses are read into plain states',()=>{
 assert.equal(tracker.readUps({currentStatus:{type:'X',description:'Weather delay'}}).state,'exception');
 assert.equal(tracker.readUps({currentStatus:{type:'I',description:'Out For Delivery Today'}}).state,'out_for_delivery');
 assert.equal(tracker.readUps({currentStatus:{type:'I'},deliveryDate:[{type:'DEL',date:'20261001'}]}).state,'delivered');
});

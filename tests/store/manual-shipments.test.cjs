'use strict';
// Packing page "New shipment" (6 Nov 2026): boxes that are not store orders. Stock out once, price shown before buying,
// the $15 check, one label per shipment, label PDF for the printer, cancel voids the label and returns stock, P&L counts the label.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-manual-ship-'));
const TOKEN='shippo_test_'+'a'.repeat(30);
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'manual-ship-admin-password',STORE_SESSION_SECRET:'manual-ship-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787',
 SHIPPO_API_TOKEN:TOKEN,SHIPPO_FROM_STREET1:'1 Test Way',SHIPPO_FROM_CITY:'Canton',SHIPPO_FROM_STATE:'GA',SHIPPO_FROM_ZIP:'30114',SHIPPO_FROM_NAME:'Glow Lab',SHIPPO_FROM_EMAIL:'ship@example.test',STORE_EMAIL_ENABLED:'1',RESEND_API_KEY:'re_test_key',STORE_EMAIL_FROM:'support@example.test'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const realFetch=global.fetch;let calls=[],cookie,a,b;
const call=(p,body,c='')=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie:c,'x-nf-client-connection-ip':'fixture'},body:body||{}});
const admin=(p,body)=>call(p,body,cookie).then(r=>r.body);
const stock=async sku=>(await admin('/admin/data')).products.find(p=>p.sku===sku).stock;
const rate=(id,amount,token,name)=>({object_id:id,amount,servicelevel:{token,name},provider:'UPS',carrier_account:'ca1'});
const to={name:'Amy Example',address:'12 Sample Rd',city:'Bolivia',state:'nc',zip:'28422',phone:'',email:'amy@example.test'};
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await admin('/admin/product',{name:'Ship A',sku:'ship-a',price:1000,stock:5,active:1});await admin('/admin/product',{name:'Ship B',sku:'ship-b',price:1000,stock:2,active:1});
 const d=(await admin('/admin/data')).products;a=d.find(p=>p.sku==='ship-a');b=d.find(p=>p.sku==='ship-b');
 await transaction(s=>s.put('integrations','shippo',{fingerprint:crypto.createHash('sha256').update(TOKEN).digest('hex'),carrier_account:'ca1',accounts:[{id:'ca1',name:'UPS'}],enabled:false}));
 global.fetch=async(u,o={})=>{u=String(u);calls.push({u,method:o.method||'GET',body:o.body?JSON.parse(o.body):null});const j=x=>({ok:true,status:200,json:async()=>x,arrayBuffer:async()=>Buffer.from('%PDF-1.4 label')});
  if(u.includes('/transactions/?'))return j({results:[],next:null});
  if(u.endsWith('/shipments/'))return j({rates:[rate('r1','12.34','ups_second_day_air','2nd Day Air'),rate('r2','9.10','ups_ground','Ground'),rate('r3','40.00','ups_next_day_air','Next Day Air')]});
  if(u.endsWith('/transactions/'))return j({status:'SUCCESS',tracking_number:'1ZMANUAL1',label_url:'https://deliver.goshippo.com/m.pdf',object_id:'tx0123456789abcdef'});
  if(u.endsWith('/refunds/'))return j({status:'QUEUED',object_id:'rf1'});
  if(u.endsWith('/addresses/'))return j({street1:'12 SAMPLE RD',street2:'',city:'BOLIVIA',state:'NC',zip:'28422-1234',validation_results:{is_valid:true,messages:[{text:'Address corrected'}]}});
  if(u.includes('resend.com'))return j({id:'email-1'});
  if(u.startsWith('https://deliver.goshippo.com/'))return j({});
  throw new Error('unexpected fetch '+u)}});
after(()=>{global.fetch=realFetch;fs.rmSync(tmp,{recursive:true,force:true})});
let id;
test('saving takes stock once; the same click key never makes a second shipment',async()=>{
 const r=await admin('/admin/manual-shipment',{key:'click-key-0001',to,reason:'missing',order_id:'',note:'BAC water missing',items:[{id:a.id,quantity:2}]});
 id=r.id;assert.match(id,/^SHIP-[0-9A-F]{10}$/);assert.equal(await stock('ship-a'),3);
 const again=await admin('/admin/manual-shipment',{key:'click-key-0001',to,reason:'missing',items:[{id:a.id,quantity:2}]});assert.equal(again.id,id);assert.equal(again.already,true);assert.equal(await stock('ship-a'),3);
 const m=(await admin('/admin/data')).manual_shipments.find(x=>x.id===id);assert.equal(m.to.state,'NC');assert.equal(m.items[0].name,'Ship A');assert.equal(m.stock_taken,true);assert.equal(m.status,'open');
 const orders=(await admin('/admin/data')).orders;assert.ok(!orders.some(o=>o.id===id),'never stored as an order')});
test('short stock is refused unless "take from stock" is off; bad input is refused',async()=>{
 await assert.rejects(admin('/admin/manual-shipment',{key:'click-key-0002',to,reason:'gift',items:[{id:b.id,quantity:3}]}),/Not enough stock for Ship B/);assert.equal(await stock('ship-b'),2);
 const r=await admin('/admin/manual-shipment',{key:'click-key-0003',to,reason:'gift',items:[{id:b.id,quantity:3}],take_stock:false});assert.match(r.id,/^SHIP-/);assert.equal(await stock('ship-b'),2);
 await assert.rejects(admin('/admin/manual-shipment',{key:'click-key-0004',to:{...to,zip:'123'},reason:'gift',items:[{id:a.id,quantity:1}]}),/ZIP/);
 await assert.rejects(admin('/admin/manual-shipment',{key:'click-key-0005',to,reason:'nope',items:[{id:a.id,quantity:1}]}),/why/);
 await assert.rejects(admin('/admin/manual-shipment',{key:'click-key-0006',to,reason:'other',items:[]}),/note/);
 await assert.rejects(call('/admin/manual-shipment',{key:'click-key-0007',to,reason:'gift',items:[]}),/Sign in/)});
test('rates are shown before buying, cheapest first, and buy nothing',async()=>{const n=calls.filter(c=>c.u.endsWith('/transactions/')).length;
 const r=await admin('/admin/manual-shipment/rates',{id});assert.deepEqual(r.rates.map(x=>[x.service,x.cents]),[['ups_ground',910],['ups_second_day_air',1234],['ups_next_day_air',4000]]);
 assert.equal(calls.filter(c=>c.u.endsWith('/transactions/')).length,n)});
test('over the $15 price check nothing is bought',async()=>{const n=calls.filter(c=>c.u.endsWith('/transactions/')).length;
 const r=await admin('/admin/manual-shipment/buy',{id,servicelevel:'ups_next_day_air'});assert.equal(r.status,'price_check');assert.equal(r.cents,4000);
 assert.equal(calls.filter(c=>c.u.endsWith('/transactions/')).length,n);const m=(await admin('/admin/data')).manual_shipments.find(x=>x.id===id);assert.ok(!m.tracking);assert.equal(m.label_status,'')});
test('one label per shipment, tagged with the shipment id; the PDF goes to the printer',async()=>{
 const r=await admin('/admin/manual-shipment/buy',{id,servicelevel:'ups_second_day_air'});assert.equal(r.status,'label_bought');assert.equal(r.tracking,'1ZMANUAL1');
 const tx=calls.filter(c=>c.u.endsWith('/transactions/'));assert.equal(tx.at(-1).body.metadata,'GLOW:'+id);
 const again=await admin('/admin/manual-shipment/buy',{id,servicelevel:'ups_second_day_air'});assert.equal(again.status,'already_bought');assert.equal(calls.filter(c=>c.u.endsWith('/transactions/')).length,tx.length);
 const m=(await admin('/admin/data')).manual_shipments.find(x=>x.id===id);assert.equal(m.label_cost_cents,1234);assert.equal(m.carrier,'ups');
 const pdf=await admin('/admin/order/label-pdf',{id});assert.equal(pdf.name,'glow-label-'+id+'.pdf');
 const p=await admin('/admin/manual-shipment/packed',{id,packed:true,fp:'x',seconds:30});assert.equal(p.packed.by,'Owner')});
test('cancel voids the label in Shippo and puts the items back',async()=>{
 const r=await admin('/admin/manual-shipment/cancel',{id});assert.equal(r.refund,'QUEUED');assert.equal(calls.filter(c=>c.u.endsWith('/refunds/')).at(-1).body.transaction,'tx0123456789abcdef');
 assert.equal(await stock('ship-a'),5);const m=(await admin('/admin/data')).manual_shipments.find(x=>x.id===id);assert.equal(m.status,'canceled');assert.equal(m.label_refund.status,'QUEUED');
 await assert.rejects(admin('/admin/manual-shipment/cancel',{id}),/Already canceled/)});
test('P&L counts manual label costs on the day bought, not voided ones',async()=>{const reports=require('../../netlify/functions/lib/business-reports.cjs');
 const ts=x=>Date.parse(x)/1000;const mem=data=>({get:async()=>null,put:async()=>{},list:async k=>structuredClone(data[k]||[]),remove:async()=>{}});
 const ms=[{id:'SHIP-1',brand:'glow',label_created_at:ts('2026-10-10T17:00:00Z'),label_cost_cents:1100},{id:'SHIP-2',brand:'glow',label_created_at:ts('2026-10-11T17:00:00Z'),label_cost_cents:900,label_refund:{status:'QUEUED'}},{id:'SHIP-3',brand:'glow',label_created_at:ts('2026-09-11T17:00:00Z'),label_cost_cents:700}];
 const r=await reports.build(mem({manual_shipments:ms}),{start:'2026-10-01',end:'2026-10-31',brand:'all'},ts('2026-10-20T12:00:00Z'));assert.equal(r.pnl.manual_label_costs,1100);assert.equal(r.pnl.label_costs,1100)});
test('Shippo problems come back as 409 with the reason, never a 502 that Cloudflare would hide',async()=>{
 await assert.rejects(call('/admin/manual-shipment/rates',{id:'SHIP-0000000000'},cookie),e=>e.status===409&&/Shipment not found/.test(e.message));
 await assert.rejects(call('/admin/manual-shipment/buy',{id:'SHIP-0000000000',servicelevel:'ups_ground'},cookie),e=>e.status===409&&/Shipment not found/.test(e.message))});
test('box size is saved and used for rates; out-of-range sizes refused',async()=>{
 const r=await admin('/admin/manual-shipment',{key:'click-key-0100',to,reason:'gift',items:[],note:'card',take_stock:true,parcel:{length:12,width:10,height:8,weight_lb:3.5}});
 await admin('/admin/manual-shipment/rates',{id:r.id});const sent=calls.filter(c=>c.u.endsWith('/shipments/')).at(-1).body.parcels[0];assert.deepEqual([sent.length,sent.width,sent.height,sent.weight],['12','10','8','3.5']);
 await assert.rejects(admin('/admin/manual-shipment',{key:'click-key-0101',to,reason:'gift',note:'x',parcel:{length:99,width:1,height:1,weight_lb:1}}),/Box size/)});
test('address check returns Shippo verdict and its cleaned-up address',async()=>{
 const r=await admin('/admin/manual-shipment/check-address',{to:{address:'12 sample road',city:'bolivia',state:'nc',zip:'28422'}});
 assert.equal(r.valid,true);assert.equal(r.changed,true);assert.equal(r.suggestion.zip,'28422-1234');assert.deepEqual(r.messages,['Address corrected']);
 assert.equal(calls.filter(c=>c.u.endsWith('/addresses/')).at(-1).body.validate,true)});
test('tracking email: preview first, then sent exactly once; needs a label and an email',async()=>{
 const r=await admin('/admin/manual-shipment',{key:'click-key-0200',to,reason:'missing',note:'x',items:[{id:a.id,quantity:1}]});
 await assert.rejects(admin('/admin/manual-shipment/email',{id:r.id,preview:true}),/Buy the label first/);
 await admin('/admin/manual-shipment/buy',{id:r.id,servicelevel:'ups_ground'});
 const p=await admin('/admin/manual-shipment/email',{id:r.id,preview:true});assert.equal(p.to,'amy@example.test');assert.match(p.subject,/missing item from your order is on the way/);assert.match(p.html,/1ZMANUAL1/);assert.match(p.html,/Ship A/);
 const outboxBefore=(await transaction(s=>s.list('email_outbox'))).length;
 const sent=await admin('/admin/manual-shipment/email',{id:r.id});assert.equal(sent.sent,true);
 const again=await admin('/admin/manual-shipment/email',{id:r.id});assert.equal(again.already,true);
 assert.equal((await transaction(s=>s.list('email_outbox'))).length,outboxBefore+1);
 const noMail=await admin('/admin/manual-shipment',{key:'click-key-0201',to:{...to,email:''},reason:'gift',note:'x'});await admin('/admin/manual-shipment/buy',{id:noMail.id,servicelevel:'ups_ground'});
 await assert.rejects(admin('/admin/manual-shipment/email',{id:noMail.id,preview:true}),/no email/)});

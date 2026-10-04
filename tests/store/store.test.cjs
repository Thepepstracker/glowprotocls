'use strict';
const{test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-store-test-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='test-password-123';process.env.STORE_SESSION_SECRET='test-session-secret-at-least-thirty-two-characters';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{handler}=require('../../netlify/functions/lib/store-handler.cjs');
let cookie;const call=(p,b,h={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...h},body:b||{}});const admin=(p,b)=>call(p,b,{cookie});
const customer={name:'Test Customer',email:'demo@example.com',address:'1 Test Street',city:'Example',state:'GA',zip:'00000'};
async function order(extra={}){return(await call('/orders',{items:[{id:1,quantity:1}],coupon:'',affiliate:'sarah',payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer,...extra})).body}
before(async()=>{await transaction(seed);const r=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});cookie=r.headers['Set-Cookie'].split(';')[0]});after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('imports real repository prices and product variants',async()=>{const{body}=await call('/catalog');assert.equal(body.products.length,58);assert.equal(body.products.find(p=>p.id===1).price,4399);assert.equal(body.settings.demo,true);assert.equal(body.products[0].stock,10)});
test('calculates money on server and honors free shipping threshold',async()=>{const q=(await call('/quote',{items:[{id:1,quantity:2}],coupon:'DEMO20',affiliate:'sarah',total:1})).body;assert.equal(q.subtotal,8798);assert.equal(q.discount,1759);assert.equal(q.total,8539);assert.equal(q.commission,1055);const free=(await call('/quote',{items:[{id:1,quantity:8}]})).body;assert.equal(free.shipping,0)});
test('rejects invalid, duplicate and unavailable carts',async()=>{await assert.rejects(call('/quote',{items:[{id:1,quantity:-1}]}),/whole number/);await assert.rejects(call('/quote',{items:[{id:1,quantity:1},{id:1,quantity:1}]}),/Duplicate/);await assert.rejects(call('/quote',{items:[{id:1,quantity:1}],affiliate:'bogus'}),/unavailable/)});
test('admin and order credentials protect private records',async()=>{await assert.rejects(call('/admin/data'),/Sign in/);const o=await order();await assert.rejects(call('/orders/'+o.order.id),/access denied/);assert.equal((await call('/orders/'+o.order.id,null,{'x-order-token':o.token})).body.customer.email,customer.email);await assert.rejects(call('/admin/receipt/'+o.order.id),/Sign in/)});
test('receipt submission never implies payment, integrations prepare after verification only',async()=>{const o=await order(),id=o.order.id;const receipt={reference:'DEMO-REF',mime:'image/png',file:(await require('sharp')({create:{width:16,height:32,channels:3,background:'#ffffff'}}).png().toBuffer()).toString('base64')};const r=await call('/orders/'+id+'/receipt',receipt,{'x-order-token':o.token});assert.equal(r.body.status,'payment_submitted');assert.equal(r.body.commission_status,'not_eligible');await assert.rejects(admin('/admin/status',{id,status:'paid'}),/Confirm/);await admin('/admin/status',{id,status:'paid',verified:true});const shipments=(await admin('/admin/integrations')).body.outbox;assert.equal(shipments.filter(x=>x.order_id===id).length,2);const dry=(await admin('/admin/shipment-preview',{id})).body;assert.equal(dry.dry_run,true);assert.equal(dry.payload.orderNumber,id);const confirmed=(await call('/orders/'+id,null,{'x-order-token':o.token})).body;assert.equal(confirmed.commission_status,'eligible');assert.equal(confirmed.shipstation_status,'ready_for_test');await admin('/admin/status',{id,status:'shipped',tracking:'DEMO123'});await assert.rejects(admin('/admin/status',{id,status:'paid',verified:true}),/not allowed/)});
test('cancel releases stock and coupon; duplicate submission cannot reserve twice',async()=>{const before=(await call('/catalog')).body.products.find(p=>p.id===1).stock;const key=crypto.randomUUID(),o=await order({idempotency_key:key,coupon:'DEMO20'});await assert.rejects(order({idempotency_key:key}),/already submitted/);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.equal((await call('/catalog')).body.products.find(p=>p.id===1).stock,before);await assert.rejects(admin('/admin/status',{id:o.order.id,status:'canceled'}),/not allowed/)});
test('simultaneous orders cannot oversell last unit',async()=>{await admin('/admin/product',{name:'One left',sku:'LAST-UNIT',price:1000,stock:1,active:1});const p=(await admin('/admin/data')).body.products.find(p=>p.sku==='LAST-UNIT');const results=await Promise.allSettled([order({items:[{id:p.id,quantity:1}]}),order({items:[{id:p.id,quantity:1}]})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected')[0].reason.status,409)});
test('expired unpaid orders release reservations',async()=>{const o=await order();await transaction(async s=>{const data=await s.get('orders',o.order.id);data.expires=1;await s.put('orders',data.id,data)});const r=await call('/orders/'+o.order.id,null,{'x-order-token':o.token});assert.equal(r.body.status,'expired')});
test('coupon use limits and monetary editing',async()=>{await admin('/admin/coupon',{code:'ONE',kind:'fixed',value:500,max_uses:1});const o=await order({coupon:'ONE'});assert.equal(o.order.discount,500);await assert.rejects(call('/quote',{items:[{id:1,quantity:1}],coupon:'ONE'}),/unavailable/);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.equal((await call('/quote',{items:[{id:1,quantity:1}],coupon:'ONE'})).body.discount,500);await admin('/admin/product',{name:'Price test',sku:'PRICE-TEST',price:1234,stock:2});assert.equal((await admin('/admin/data')).body.products.find(p=>p.sku==='PRICE-TEST').price,1234)});
test('payment settings accept official profile hosts and reject deceptive URLs atomically',async()=>{const links={venmo:'https://account.venmo.com/u/example-business',paypal:'https://www.paypal.com/biz/profile/example-business',cashapp:'https://cash.app/$examplebusiness',zelle:'example@example.com'};await admin('/admin/settings',{shipping_cents:1500,free_shipping_cents:25000,payment_links:links});assert.deepEqual((await call('/catalog')).body.settings.payment_links,links);for(const venmo of ['https://account.venmo.com.evil.example/u/test','http://account.venmo.com/u/test','https://evil.example@account.venmo.com/u/test'])await assert.rejects(admin('/admin/settings',{shipping_cents:1500,payment_links:{...links,venmo}}),/official HTTPS/);assert.deepEqual((await call('/catalog')).body.settings.payment_links,links)});
test('cross-site protection, upload checks and URL allowlist',async()=>{await assert.rejects(handle({path:'/admin/login',method:'POST',headers:{},body:{password:'test'}}),/protection header/);await assert.rejects(call('/admin/login',{password:'test'},{origin:'https://evil.example'}),/Cross-origin/);await assert.rejects(admin('/admin/settings',{shipping_cents:1500,payment_links:{paypal:'https://evil.example'}}),/official HTTPS/);const o=await order();await assert.rejects(call('/orders/'+o.order.id+'/receipt',{reference:'fake',mime:'image/png',file:Buffer.from('<script>x</script>').toString('base64')},{'x-order-token':o.token}),/invalid/)});
test('Netlify function adapter returns protected receipts and JSON errors',async()=>{const result=await handler({httpMethod:'GET',queryStringParameters:{route:'/admin/data'},headers:{},body:''});assert.equal(result.statusCode,401);const malformed=await handler({httpMethod:'POST',queryStringParameters:{route:'/quote'},headers:{'x-store-request':'1'},body:'{bad'});assert.equal(malformed.statusCode,400)});
test('wrong password attempts are persisted and rate limited',async()=>{const h={'x-forwarded-for':'test-login-ip'};for(let i=0;i<5;i++)assert.equal((await call('/admin/login',{password:'incorrect'},h)).status,401);assert.equal((await call('/admin/login',{password:'incorrect'},h)).status,429)});
test('GoAffPro check authenticates, protects secrets and remains read-only',async()=>{
 const originalFetch=global.fetch;const oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;let requests=0;
 try{
  delete process.env.GOAFFPRO_ACCESS_TOKEN;
  await assert.rejects(admin('/admin/goaffpro/check',{}),/GOAFFPRO_ACCESS_TOKEN/);
  process.env.GOAFFPRO_ACCESS_TOKEN='unit-test-private-token';
  global.fetch=async(url,opts)=>{requests++;assert.equal(opts.method,undefined);assert.match(url,/fields=id,name,ref_code,status/);assert.equal(opts.headers['x-goaffpro-access-token'],process.env.GOAFFPRO_ACCESS_TOKEN);return{ok:true,status:200,json:async()=>({affiliates:[{id:123,name:'Test Affiliate',ref_code:'test-ref',status:'approved',email:'private@example.com',login_token:'sensitive'}]})}};
  await assert.rejects(call('/admin/goaffpro/check',{}),/Sign in/);assert.equal(requests,0);
  await assert.rejects(call('/admin/goaffpro/check',{}, {cookie,origin:'https://evil.example'}),/Cross-origin/);assert.equal(requests,0);
  const r=await admin('/admin/goaffpro/check',{});assert.equal(requests,1);assert.equal(r.body.verified,true);assert.equal(r.body.order_reporting,true);assert.deepEqual(Object.keys(r.body.affiliates[0]),['id','name','ref_code','status']);assert.equal(JSON.stringify(r).includes('unit-test-private-token'),false);
  const d=await admin('/admin/data');assert.equal(d.body.goaffpro.verified,true);assert.equal(d.body.affiliates.some(a=>a.goaffpro_id==='123'),false);
  process.env.GOAFFPRO_ACCESS_TOKEN='changed-unit-test-token';assert.equal((await admin('/admin/data')).body.goaffpro.verified,false);
  global.fetch=async()=>({status:403,ok:false,json:async()=>({error:'private-token-secret'})});await assert.rejects(admin('/admin/goaffpro/check',{}),e=>e.status===502&&!e.message.includes('private-token-secret'));
  global.fetch=async()=>({status:200,ok:true,json:async()=>({error:'bad response'})});await assert.rejects(admin('/admin/goaffpro/check',{}),/unexpected/);
  global.fetch=async()=>{throw new Error('private-token-secret')};await assert.rejects(admin('/admin/goaffpro/check',{}),e=>e.status===502&&!e.message.includes('private-token-secret'));
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('storefront imports preserve edits, avoid slug collisions and retain attribution',async()=>{
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;
 const profiles=[{id:'201',name:'Jane Smith',ref_code:'jane201',status:'approved'},{id:'202',name:'Jane Smith',ref_code:'jane202',status:'approved'},{id:'203',name:'Admin',ref_code:'x',status:'approved'},{id:'204',name:'Rejected Person',status:'rejected'},{id:'205',name:'',status:'approved'},{id:'206',name:'Zoé López',status:'approved'}];
 try{
  process.env.GOAFFPRO_ACCESS_TOKEN='storefront-import-test';global.fetch=async(url)=>{assert.match(url,/offset=100/);return{ok:true,status:200,json:async()=>({affiliates:profiles})}};
  await assert.rejects(call('/admin/goaffpro/storefronts',{offset:100}),/Sign in/);
  const first=(await admin('/admin/goaffpro/storefronts',{offset:100})).body;assert.equal(first.imported.created,4);assert.equal(first.imported.skipped,2);
  const data=(await admin('/admin/data')).body;const jane=data.affiliates.find(a=>a.goaffpro_id==='201'),other=data.affiliates.find(a=>a.goaffpro_id==='202');assert.equal(jane.slug,'jane-smith');assert.notEqual(jane.slug,other.slug);assert.notEqual(data.affiliates.find(a=>a.goaffpro_id==='203').slug,'admin');assert.equal(data.affiliates.find(a=>a.goaffpro_id==='206').slug,'zoe-lopez');
  await admin('/admin/affiliate',{...jane,name:'Jane’s Custom Name',bio:'My introduction',commission_bps:1000,active:0});
  const second=(await admin('/admin/goaffpro/storefronts',{offset:100})).body;assert.equal(second.imported.created,0);assert.equal(second.imported.existing,4);
  const stored=(await admin('/admin/data')).body.affiliates.find(a=>a.slug===jane.slug);assert.equal(stored.name,'Jane’s Custom Name');assert.equal(stored.bio,'My introduction');assert.equal(stored.active,0);assert.equal(stored.commission_bps,1000);
  await assert.rejects(call('/storefronts/'+jane.slug),e=>e.status===404);await assert.rejects(admin('/admin/affiliate',{...jane,slug:'duplicate-jane'}),e=>e.status===409);
  const publicProfile=(await call('/storefronts/'+other.slug)).body;assert.deepEqual(Object.keys(publicProfile),['slug','name','bio','photo_url']);assert.equal((await call('/catalog')).body.affiliates,undefined);
  const placed=await order({affiliate:other.slug});assert.equal(placed.order.affiliate,other.slug);assert.equal(placed.order.goaffpro_affiliate_id,undefined);assert.equal((await transaction(st=>st.get('orders',placed.order.id))).goaffpro_affiliate_id,'202');
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('private photo links isolate affiliates, expire, rotate and decode uploads',async()=>{
 const sharp=require('sharp');await admin('/admin/affiliate',{slug:'photo-person',name:'Photo Person',goaffpro_id:'901',commission_bps:1500,active:1});
 const link=(await admin('/admin/affiliate/photo-link',{slug:'photo-person'})).body;
 const photoCall=(p,b,token=link.token)=>call(p,b,{'x-profile-token':token});
 await assert.rejects(call('/admin/affiliate/photo-link',{slug:'photo-person'}),/Sign in/);
 await assert.rejects(photoCall('/affiliate-profile/sarah',null),e=>e.status===403);
 await assert.rejects(photoCall('/affiliate-profile/photo-person',null,'wrong'),e=>e.status===403);
 const raw=await sharp({create:{width:80,height:120,channels:3,background:'#c4a46f'}}).png().toBuffer();
 await assert.rejects(photoCall('/affiliate-profile/photo-person/photo',{mime:'image/png',file:raw.subarray(0,12).toString('base64')}),/could not be read/);
 await assert.rejects(photoCall('/affiliate-profile/photo-person/photo',{mime:'image/jpeg',file:raw.toString('base64')}),/still JPEG/);
 await photoCall('/affiliate-profile/photo-person/photo',{mime:'image/png',file:raw.toString('base64')});
 const profile=(await photoCall('/affiliate-profile/photo-person',null)).body;assert.ok(profile.photo_url);assert.equal(JSON.stringify(profile).includes(link.token),false);
 const image=(await call('/storefronts/photo-person/photo')).body;assert.equal(image._type,'image/jpeg');const meta=await sharp(Buffer.from(image._binary,'base64')).metadata();assert.equal(meta.width,512);assert.equal(meta.height,512);assert.equal(meta.exif,undefined);
 const second=(await admin('/admin/affiliate/photo-link',{slug:'photo-person'})).body;await assert.rejects(photoCall('/affiliate-profile/photo-person',null),e=>e.status===403);
 await photoCall('/affiliate-profile/photo-person/photo',{remove:true},second.token);await assert.rejects(call('/storefronts/photo-person/photo'),e=>e.status===404);
 await transaction(async st=>{const a=await st.get('affiliates','photo-person');a.photo_link_expires=1;await st.put('affiliates',a.slug,a)});await assert.rejects(photoCall('/affiliate-profile/photo-person',null,second.token),e=>e.status===403);
});
test('GoAffPro reporting sends correct dollar amounts once after verified live payment',async()=>{
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;
 const fixture=await order({coupon:'DEMO20'});await transaction(async s=>{const o=await s.get('orders',fixture.order.id);o.is_test=false;o.goaffpro_affiliate_id='202';await s.put('orders',o.id,o)});
 let posts=0,remote=null,payload;
 try{process.env.GOAFFPRO_ACCESS_TOKEN='report-test-token';global.fetch=async(url,opts)=>{
  if(opts.method==='POST'){posts++;payload=JSON.parse(opts.body);remote={id:800,number:payload.order.number,affiliate_id:202,total:payload.order.total,subtotal:payload.order.subtotal,status:'approved'};return{ok:true,status:200,json:async()=>({result:{affiliate_id:202,commission:5.28}})}}
  if(url.includes('/admin/orders'))return{ok:true,status:200,json:async()=>({orders:remote?[remote]:[]})};
  return{ok:true,status:200,json:async()=>({affiliates:[{id:202,status:'approved',email:'affiliate@example.com'}]})};
 };
 const before=await admin('/admin/goaffpro/report',{id:fixture.order.id});assert.equal(before.body.status,'blocked');assert.equal(posts,0);
 const paid=await admin('/admin/status',{id:fixture.order.id,status:'paid',verified:true});assert.equal(paid.body.goaffpro.status,'synced');assert.equal(posts,1);assert.equal(payload.affiliate_id,'202');assert.equal(payload.order.total,50.20);assert.equal(payload.order.subtotal,35.20);assert.equal(payload.order.discount,8.79);assert.equal(payload.order.shipping,15);assert.equal(payload.order.forceSDK,true);assert.equal(payload.order.commission,undefined);assert.equal(payload.order.line_items[0].discount,8.79);
 const again=await admin('/admin/goaffpro/report',{id:fixture.order.id});assert.equal(again.body.status,'synced');assert.equal(posts,1);
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('GoAffPro suppresses test, legacy, unmapped and self-purchase sales',async()=>{
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;let posts=0;
 try{process.env.GOAFFPRO_ACCESS_TOKEN='suppression-test-token';global.fetch=async(url,opts)=>{if(opts.method==='POST')posts++;return{ok:true,status:200,json:async()=>url.includes('/admin/orders')?{orders:[]}:{affiliates:[{id:202,status:'approved',email:customer.email.toUpperCase()}]}}};
 for(const mode of ['test','legacy','unmapped','self']){const fixture=await order();await transaction(async s=>{const o=await s.get('orders',fixture.order.id);o.is_test=mode==='test';if(mode==='legacy')delete o.is_test;o.goaffpro_affiliate_id=mode==='unmapped'?'':'202';await s.put('orders',o.id,o)});const paid=await admin('/admin/status',{id:fixture.order.id,status:'paid',verified:true});if(mode==='self'){assert.equal(paid.body.goaffpro.status,'failed');assert.match(paid.body.goaffpro.message,/Self-purchase/)}else assert.ok(['blocked','test_only'].includes(paid.body.goaffpro.status));}
 assert.equal(posts,0);
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('an ambiguous GoAffPro send is reconciled without repeating the sale',async()=>{
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;const fixture=await order();await transaction(async s=>{const o=await s.get('orders',fixture.order.id);o.is_test=false;o.goaffpro_affiliate_id='202';await s.put('orders',o.id,o)});let posts=0,visible=false,sent;
 try{process.env.GOAFFPRO_ACCESS_TOKEN='ambiguity-test-token';global.fetch=async(url,opts)=>{if(opts.method==='POST'){posts++;sent=JSON.parse(opts.body);throw new Error('Socket timeout with private data that must not leak')};return{ok:true,status:200,json:async()=>url.includes('/admin/orders')?{orders:visible?[{id:801,number:sent.order.number,affiliate_id:202,total:sent.order.total,subtotal:sent.order.subtotal,status:'approved'}]:[]}:{affiliates:[{id:202,status:'approved',email:'other@example.com'}]}}};
 const paid=await admin('/admin/status',{id:fixture.order.id,status:'paid',verified:true});assert.equal(paid.body.goaffpro.status,'needs_review');assert.equal(JSON.stringify(paid).includes('private data'),false);
 const retry=await admin('/admin/goaffpro/report',{id:fixture.order.id});assert.equal(retry.body.status,'needs_review');assert.equal(posts,1);
 visible=true;const reconciled=await admin('/admin/goaffpro/report',{id:fixture.order.id});assert.equal(reconciled.body.status,'synced');assert.equal(posts,1);
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('concurrent GoAffPro checks and pre-existing remote sales cannot create duplicate commissions',async()=>{
 const product=(await admin('/admin/data')).body.products.find(p=>p.id===1);await admin('/admin/product',{...product,stock:10});
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;const fixture=await order();await transaction(async s=>{const o=await s.get('orders',fixture.order.id);Object.assign(o,{is_test:false,goaffpro_affiliate_id:'202',status:'paid',paid:Math.floor(Date.now()/1000)});await s.put('orders',o.id,o)});let posts=0,remote=null;
 try{process.env.GOAFFPRO_ACCESS_TOKEN='concurrency-test-token';global.fetch=async(url,opts)=>{await new Promise(r=>setTimeout(r,5));if(opts.method==='POST'){posts++;const p=JSON.parse(opts.body);remote={id:802,number:p.order.number,affiliate_id:202,total:p.order.total,subtotal:p.order.subtotal,status:'approved'};return{ok:true,status:200,json:async()=>({result:{affiliate_id:202}})}};return{ok:true,status:200,json:async()=>url.includes('/admin/orders')?{orders:remote?[remote]:[]}:{affiliates:[{id:202,status:'approved',email:'other@example.com'}]}}};
 const both=await Promise.all([admin('/admin/goaffpro/report',{id:fixture.order.id}),admin('/admin/goaffpro/report',{id:fixture.order.id})]);assert.equal(posts,1);assert.ok(both.some(r=>r.body.status==='sending'));assert.ok(both.some(r=>r.body.status==='synced'));
 const existing=await order();await transaction(async s=>{const o=await s.get('orders',existing.order.id);Object.assign(o,{is_test:false,goaffpro_affiliate_id:'202',status:'paid',paid:Math.floor(Date.now()/1000)});await s.put('orders',o.id,o);remote={id:803,number:o.id,affiliate_id:202,total:o.total/100,subtotal:o.subtotal/100,status:'approved'}});assert.equal((await admin('/admin/goaffpro/report',{id:existing.order.id})).body.status,'synced');assert.equal(posts,1);
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('GoAffPro report blocks mismatched remote sales and can retry a definite permission rejection',async()=>{
 const originalFetch=global.fetch,oldKey=process.env.GOAFFPRO_ACCESS_TOKEN;let posts=0,deny=true,remote=null;
 async function fixture(){const f=await order();await transaction(async s=>{const o=await s.get('orders',f.order.id);Object.assign(o,{is_test:false,goaffpro_affiliate_id:'202',status:'paid',paid:Math.floor(Date.now()/1000)});await s.put('orders',o.id,o)});return f}
 try{process.env.GOAFFPRO_ACCESS_TOKEN='permissions-test-token';const f=await fixture();global.fetch=async(url,opts)=>{if(opts.method==='POST'){posts++;if(deny)return{ok:false,status:403};const p=JSON.parse(opts.body);remote={id:805,number:p.order.number,affiliate_id:202,total:p.order.total,subtotal:p.order.subtotal,status:'approved'};return{ok:true,status:200,json:async()=>({result:{affiliate_id:202}})}}return{ok:true,status:200,json:async()=>url.includes('/admin/orders')?{orders:remote?[remote]:[]}:{affiliates:[{id:202,status:'approved',email:'other@example.com'}]}}};
 const first=await admin('/admin/goaffpro/report',{id:f.order.id});assert.equal(first.body.status,'failed');assert.equal((await transaction(s=>s.get('outbox','goaffpro-'+f.order.id))).post_started,false);
 deny=false;assert.equal((await admin('/admin/goaffpro/report',{id:f.order.id})).body.status,'synced');assert.equal(posts,2);
 const conflict=await fixture();remote={id:806,number:conflict.order.id,affiliate_id:999,total:conflict.order.total/100,subtotal:conflict.order.subtotal/100,status:'approved'};assert.equal((await admin('/admin/goaffpro/report',{id:conflict.order.id})).body.status,'failed');assert.equal(posts,2);
 }finally{global.fetch=originalFetch;if(oldKey===undefined)delete process.env.GOAFFPRO_ACCESS_TOKEN;else process.env.GOAFFPRO_ACCESS_TOKEN=oldKey}
});
test('affiliate coupons credit their server-assigned owner and snapshot GoAffPro identity',async()=>{
 await admin('/admin/affiliate',{slug:'coupon-owner',name:'Coupon Owner',bio:'',goaffpro_id:'coupon-id-901',commission_bps:1500,active:1});
 const coupon={code:'OWNER20',kind:'percent',value:20,max_uses:100,affiliate:'coupon-owner'};
 await assert.rejects(call('/admin/coupon',coupon),e=>e.status===401);
 await assert.rejects(admin('/admin/coupon',{...coupon,affiliate:'unknown'}),/active affiliate/);
 await admin('/admin/coupon',coupon);
 for(const incoming of ['', 'sarah','bogus']){const q=(await call('/quote',{items:[{id:1,quantity:1}],coupon:'owner20',affiliate:incoming,total:1,affiliate_name:'Fake'})).body;assert.equal(q.discount,879);assert.equal(q.affiliate,'coupon-owner');assert.equal(q.affiliate_source,'coupon');assert.equal(q.affiliate_name,'Coupon Owner');assert.equal(q.commission,528)}
 const placed=await order({affiliate:'sarah',coupon:'OWNER20'});assert.equal(placed.order.affiliate,'coupon-owner');assert.equal((await transaction(s=>s.get('orders',placed.order.id))).goaffpro_affiliate_id,'coupon-id-901');
 await admin('/admin/coupon',{code:'OWNER20',kind:'percent',value:15});assert.equal((await admin('/admin/data')).body.coupons.find(c=>c.code==='OWNER20').affiliate,'coupon-owner');
 await admin('/admin/coupon',{...coupon,affiliate:''});assert.equal((await call('/quote',{items:[{id:1,quantity:1}],coupon:'OWNER20',affiliate:'sarah'})).body.affiliate,'sarah');assert.equal((await transaction(s=>s.get('orders',placed.order.id))).goaffpro_affiliate_id,'coupon-id-901');
 await admin('/admin/status',{id:placed.order.id,status:'canceled'});
 await admin('/admin/coupon',coupon);await admin('/admin/affiliate',{slug:'coupon-owner',name:'Coupon Owner',bio:'',goaffpro_id:'coupon-id-901',commission_bps:1500,active:0});
 await assert.rejects(call('/quote',{items:[{id:1,quantity:1}],coupon:'OWNER20'}),/affiliate coupon is unavailable/);
 await assert.rejects(admin('/admin/coupon',coupon),/active affiliate/);
 await admin('/admin/coupon',{...coupon,active:0});await assert.rejects(call('/quote',{items:[{id:1,quantity:1}],coupon:'OWNER20'}),/unavailable/);
});
test('logout revokes the saved admin session',async()=>{await admin('/admin/logout',{});await assert.rejects(admin('/admin/data'),/Sign in/)});

test('legacy referral codes resolve unique active storefronts without exposing IDs',async()=>{
 await transaction(async s=>{await s.put('affiliates','referral-test',{slug:'referral-test',name:'Referral Test',bio:'Welcome',goaffpro_id:'999',goaffpro_ref_code:'MixedCaseRef',commission_bps:1500,active:1})});
 const profile=(await call('/referrals/MixedCaseRef')).body;
 assert.deepEqual(Object.keys(profile),['slug','name','bio','photo_url']);assert.equal(profile.slug,'referral-test');
 assert.equal((await call('/quote',{items:[{id:1,quantity:1}],affiliate:profile.slug})).body.affiliate,'referral-test');
 for(const code of ['mixedcaseref','unknown','%20','%E0%A4%A'])await assert.rejects(call('/referrals/'+code),e=>e.status===404);
 await transaction(async s=>{const a=await s.get('affiliates','referral-test');await s.put('affiliates',a.slug,{...a,active:0})});
 await assert.rejects(call('/referrals/MixedCaseRef'),e=>e.status===404);
 await transaction(async s=>{const a=await s.get('affiliates','referral-test');await s.put('affiliates',a.slug,{...a,active:1});await s.put('affiliates','duplicate-referral',{...a,slug:'duplicate-referral',active:0})});
 await assert.rejects(call('/referrals/MixedCaseRef'),e=>e.status===404);
});

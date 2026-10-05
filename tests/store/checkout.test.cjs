'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-checkout-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='checkout-test-admin-password';process.env.STORE_SESSION_SECRET='checkout-test-session-secret-long-enough';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');let cookie;
const call=(path,body,headers={})=>handle({path,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...headers},body:body||{}}),admin=(p,b)=>call(p,b,{cookie});
const orderBody=extra=>({items:[{id:1,quantity:1}],payment_method:'zelle',affiliate:'',idempotency_key:crypto.randomUUID(),customer:{name:'Test',email:'test@example.com',address:'1 Example Street',city:'Example',state:'GA',zip:'30301'},...extra});
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('live mode requires admin, explicit tax choice, payment recipient and inventory; mode never changes existing orders',async()=>{
 const mode={mode:'live',tax_mode:'none'};await assert.rejects(call('/admin/checkout-settings',mode),e=>e.status===401);
 await assert.rejects(admin('/admin/checkout-settings',{mode:'live'}),/confirm no sales tax/);
 await assert.rejects(admin('/admin/checkout-settings',mode),/payment recipient/);
 await admin('/admin/settings',{shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'recipient@example.com'}});
 const stock=await transaction(async s=>{const all=await s.list('products');for(const p of all)await s.put('products',p.id,{...p,stock:0});return all});
 await assert.rejects(admin('/admin/checkout-settings',mode),/Add stock/);
 await transaction(async s=>{for(const p of stock)await s.put('products',p.id,p)});
 const preview=(await call('/orders',orderBody())).body;
 await admin('/admin/checkout-settings',mode);const settings=(await call('/catalog')).body.settings;assert.equal(settings.demo,false);assert.equal(settings.checkout_enabled,true);assert.equal(settings.tax_mode,'none');
 const live=(await call('/orders',orderBody())).body;assert.equal(live.order.is_test,false);assert.equal(live.order.tax,0);
 assert.equal((await call('/orders/'+preview.order.id,undefined,{'x-order-token':preview.token})).body.is_test,true);
 await assert.rejects(call('/orders',orderBody({payment_method:'venmo'})),/not available/);
 await assert.rejects(admin('/admin/settings',{shipping_cents:1500,payment_links:{}}),/Keep at least one/);
 await admin('/admin/checkout-settings',{mode:'preview',tax_mode:'none'});assert.equal((await call('/orders',orderBody())).body.order.is_test,true);
 assert.equal((await call('/orders/'+live.order.id,undefined,{'x-order-token':live.token})).body.is_test,false);
});
test('invalid state and ZIP are rejected without reserving inventory; valid addresses are normalized',async()=>{
 const before=(await call('/catalog')).body.products[0].stock;
 for(const changes of [{state:'Georgia'},{state:'XX'},{zip:'ABC'},{zip:'303010'}])await assert.rejects(call('/orders',orderBody({customer:{...orderBody().customer,...changes}})),/state|ZIP/);
 assert.equal((await call('/catalog')).body.products[0].stock,before);
 const o=(await call('/orders',orderBody({customer:{...orderBody().customer,state:'ga',zip:'30301-1234'}}))).body.order;assert.equal(o.customer.state,'GA');assert.equal(o.customer.zip,'30301-1234');
});
test('receipt decoding rejects forged/truncated images, keeps full dimensions and exposes sanitized image only to staff',async()=>{
 const o=(await call('/orders',orderBody())).body,route='/orders/'+o.order.id+'/receipt',headers={'x-order-token':o.token},bad=Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
 await assert.rejects(call(route,{reference:'TEST',mime:'image/png',file:bad}),e=>e.status===404);
 await assert.rejects(call(route,{reference:'TEST',mime:'image/png',file:bad},headers),/invalid|incomplete/);
 const raw=await sharp({create:{width:500,height:1200,channels:3,background:'#ffffff'}}).withMetadata().png().toBuffer();
 await assert.rejects(call(route,{reference:'TEST',mime:'image/jpeg',file:raw.toString('base64')},headers),/invalid/);
 const r=await call(route,{reference:'TEST',mime:'image/png',file:raw.toString('base64')},headers);assert.equal(r.body.status,'payment_submitted');assert.equal(r.body.receipt,undefined);
 await assert.rejects(call('/admin/receipt/'+o.order.id),e=>e.status===401);
 const stored=(await admin('/admin/receipt/'+o.order.id)).body;assert.equal(stored._type,'image/jpeg');const meta=await sharp(Buffer.from(stored._binary,'base64')).metadata();assert.equal(meta.width,500);assert.equal(meta.height,1200);assert.equal(meta.exif,undefined);
 await admin('/admin/status',{id:o.order.id,status:'canceled'});await assert.rejects(call(route,{reference:'TEST',mime:'image/png',file:raw.toString('base64')},headers),e=>e.status===409);
});

test('checkout stays a recoverable draft until a valid screenshot is submitted; replacement is idempotent',async()=>{
 const r=(await call('/orders',orderBody())).body,h={'x-order-token':r.token},route='/orders/'+r.order.id;
 assert.equal(r.order.checkout_stage,'draft');assert.equal(r.order.submitted_at,null);assert.equal(r.order.has_receipt,false);
 await assert.rejects(call(route+'/receipt',{file:'',mime:'image/png'},h));
 const recovered=(await call(route,undefined,h)).body;assert.equal(recovered.checkout_stage,'draft');assert.equal(recovered.status,'awaiting_payment');
 const image=await sharp({create:{width:20,height:20,channels:3,background:'#fff'}}).png().toBuffer(),body={file:image.toString('base64'),mime:'image/png'};
 const submitted=(await call(route+'/receipt',body,h)).body;assert.equal(submitted.checkout_stage,'submitted');assert.equal(submitted.status,'payment_submitted');assert.ok(submitted.submitted_at);assert.equal(submitted.has_receipt,true);assert.equal(submitted.commission_status,'not_eligible');
 const repeat=(await call(route+'/receipt',body,h)).body;assert.equal(repeat.submitted_at,submitted.submitted_at);assert.equal(repeat.status,'payment_submitted');
});

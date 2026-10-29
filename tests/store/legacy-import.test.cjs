'use strict';
// Old-site orders (29 Oct 2026): paid-but-unshipped orders from the locked Netlify store come in once, as paid, with their own
// number, lines, totals and address. They take stock, send no email, and can never be imported twice.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-legacy-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'legacy-tests-session-secret-more-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];let emails=0;const oldFetch=global.fetch;
global.fetch=async()=>{emails++;return{ok:true,status:200,json:async()=>({id:'x'})}};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
test('an old paid order imports once, as paid, takes stock, and emails nobody',async()=>{
 await transaction(seed);const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 const p=await transaction(async s=>(await s.list('products')).find(x=>x.active&&!x.components&&!(x.units>1)&&x.stock>=5));
 const order={id:'GLP-ABCDEF0123',customer:{name:'Old Customer',email:'old@example.com',phone:'(555) 201-3344',address:'1 Main St',city:'Ball Ground',state:'ga',zip:'30107'},
  items:[{sku:p.sku,quantity:2,price:5000}],shipping:1500,total:9000,payment_method:'card_invoice',note:'paid by card on Stripe'};
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[order],confirm:'IMPORT 1'}),e=>e.status===401,'owner only');
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[order],confirm:'yes'},owner),/IMPORT/);
 emails=0;const r=await call('/admin/orders/import-legacy',{orders:[order],confirm:'IMPORT 1'},owner);
 assert.equal(r.body.imported.length,1);assert.equal(emails,0,'no customer or staff email');
 const o=await transaction(s=>s.get('orders','GLP-ABCDEF0123'));
 assert.equal(o.status,'paid');assert.equal(o.is_test,false);assert.equal(o.total,9000);assert.equal(o.subtotal,10000);assert.equal(o.discount,2500);assert.equal(o.shipping,1500);
 assert.equal(o.customer.state,'GA');assert.equal(o.customer.phone,'+15552013344');assert.equal(o.goaffpro_status,'not_applicable');assert.equal(o.points_earned,0);
 assert.equal((await transaction(s=>s.get('products',p.id))).stock,p.stock-2,'stock taken');
 assert.ok(Array.isArray(o.staff_notes)&&/old site/.test(o.staff_notes[0].text),'note is a normal staff note');
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[order],confirm:'IMPORT 1'},owner),e=>e.status===409,'never twice');
 assert.equal((await transaction(s=>s.get('products',p.id))).stock,p.stock-2,'stock not taken twice');
});
test('a bad row stops the whole import and nothing is saved',async()=>{
 const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 const p=await transaction(async s=>(await s.list('products')).find(x=>x.active&&!x.components&&!(x.units>1)&&x.stock>=5));
 const good={id:'GLP-1111111111',customer:{name:'A',email:'a@example.com',address:'1 St',city:'X',state:'TX',zip:'75001'},items:[{sku:p.sku,quantity:1}],total:p.price};
 const bad={...good,id:'GLP-2222222222',items:[{sku:'no-such-sku',quantity:1}]};
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[good,bad],confirm:'IMPORT 2'},owner),/no-such-sku/);
 assert.equal(await transaction(s=>s.get('orders','GLP-1111111111')),null);
 assert.equal((await transaction(s=>s.get('products',p.id))).stock,p.stock);
});
test('an old label UPS never scanned comes in as shipped with that label, takes no stock, never a second label',async()=>{
 const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 const p=await transaction(async s=>(await s.list('products')).find(x=>x.active&&!x.components&&!(x.units>1)&&x.stock>=5));
 const base={id:'GLP-3333333333',customer:{name:'B',email:'b@example.com',address:'2 St',city:'Y',state:'GA',zip:'30107'},items:[{sku:p.sku,quantity:1}],total:p.price};
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[{...base,label:{tracking:'nope'}}],confirm:'IMPORT 1'},owner),/1Z/);
 await assert.rejects(call('/admin/orders/import-legacy',{orders:[{...base,label:{tracking:'1Z3G52C30207246991',label_url:'https://evil.example.com/x.pdf'}}],confirm:'IMPORT 1'},owner),/Shippo/);
 await call('/admin/orders/import-legacy',{orders:[{...base,label:{tracking:'1Z3G52C30207246991',label_url:'https://deliver.goshippo.com/abc.pdf',service:'UPS 2nd Day Air',date:'Oct 26'},note:'label never scanned'}],confirm:'IMPORT 1'},owner);
 const o=await transaction(s=>s.get('orders','GLP-3333333333'));
 assert.equal(o.status,'shipped');assert.equal(o.tracking,'1Z3G52C30207246991');assert.equal(o.shipment.label_url,'https://deliver.goshippo.com/abc.pdf');assert.ok(o.shipment.label_created_at>0);
 assert.equal((await transaction(s=>s.get('products',p.id))).stock,p.stock,'no stock taken for a box already made');
});
test('attach labels: finds the old label in Shippo by tracking and saves its PDF link; reads only, never buys',async()=>{
 process.env.SHIPPO_API_TOKEN='shippo_live_fixture';const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));const calls=[];
 global.fetch=async(url,opts)=>{calls.push((opts&&opts.method)||'GET');if(String(url).includes('/transactions/'))return{ok:true,status:200,json:async()=>({next:null,results:[{object_id:'t1',status:'SUCCESS',tracking_number:'1Z3G52C30207246991',label_url:'https://deliver.goshippo.com/real.pdf'},{object_id:'t2',status:'SUCCESS',tracking_number:'1ZOTHER',label_url:'https://deliver.goshippo.com/other.pdf'}]})};return{ok:true,status:200,json:async()=>({id:'x'})}};
 await assert.rejects(call('/admin/orders/attach-legacy-labels',{}),e=>e.status===401);
 const r=await call('/admin/orders/attach-legacy-labels',{},owner);
 assert.deepEqual(r.body.results,[{id:'GLP-3333333333',tracking:'1Z3G52C30207246991',found:true}]);
 assert.ok(calls.every(m=>m==='GET'),'only reads from Shippo');
 const o=await transaction(s=>s.get('orders','GLP-3333333333'));assert.equal(o.shipment.label_url,'https://deliver.goshippo.com/real.pdf');assert.equal(o.tracking,'1Z3G52C30207246991');assert.equal(o.status,'shipped');
});

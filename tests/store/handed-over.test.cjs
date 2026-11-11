'use strict';
// Handed over in person (Jonah, 11 Nov 2026): close a paid order with no label and no "label created" email.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-handed-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'handed-fixture-admin-password',STORE_SESSION_SECRET:'handed-fixture-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{check}=require('../../netlify/functions/lib/end-of-day.cjs');
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});let owner;const admin=(p,b)=>call(p,b,{cookie:owner});
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'recipient@example.com'}});await s.put('products',1,{id:1,brand:'glow',sku:'h-1',name:'GLP-2T · 15 mg',price:5000,stock:20,active:1})});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('a paid order handed over in person closes quietly: no label, no email, nothing left to fix',async()=>{
 const o=(await call('/orders',{items:[{id:1,quantity:1}],payment_method:'zelle',customer:{name:'Taylor Example',email:'taylor@example.org',phone:'2025550101',address:'1 Example Road',city:'Example',state:'GA',zip:'30301'},idempotency_key:crypto.randomUUID()})).body.order;
 await admin('/admin/status',{id:o.id,status:'paid',verified:true});
 await transaction(async s=>{const x=await s.get('orders',o.id);x.shippo_needs_review=true;x.shippo_message='Label purchase needs review.';await s.put('orders',x.id,x)});
 const before=(await transaction(s=>s.list('email_outbox'))).filter(j=>j.related_id===o.id).map(j=>j.kind);
 await assert.rejects(admin('/admin/status',{id:o.id,status:'handed_over'}),/Confirm/);
 const r=(await admin('/admin/status',{id:o.id,status:'handed_over',confirm:o.id,note:'Met in person'})).body;assert.equal(r.status,'shipped');
 const x=await transaction(s=>s.get('orders',o.id));
 assert.equal(x.shipment.carrier,'in_person');assert.equal(x.handed_over.note,'Met in person');assert.equal(x.delivery.delivered,true);assert.equal(x.shippo_needs_review,false);
 const afterKinds=(await transaction(s=>s.list('email_outbox'))).filter(j=>j.related_id===o.id).map(j=>j.kind);assert.deepEqual(afterKinds,before,'no shipped email');
 assert.ok(!afterKinds.includes('order_shipped'));
 const e=check({orders:[x],subs:[],emails:[],printLog:[],manuals:[]},'glow');assert.equal(e.all_clear,true);assert.equal(e.tomorrow.to_label,0);
 await assert.rejects(admin('/admin/status',{id:o.id,status:'handed_over',confirm:o.id}),e=>e.status===409,'only from paid');
});

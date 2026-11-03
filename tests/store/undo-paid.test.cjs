'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-undo-paid-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='customer-test-admin-password';process.env.STORE_SESSION_SECRET='customer-test-session-secret-long-enough';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');let adminCookie;
const call=(p,b,cookie='',ip='fixture')=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie,'x-nf-client-connection-ip':ip},body:b||{}}),admin=(p,b)=>call(p,b,adminCookie);
const password='a secure customer passphrase 2026';let next=0;
async function customer(points=0,email){email=email||`customer${++next}@example.com`;await call('/account/register',{name:'Test Customer',email},'',email);const id=accounts.hash(email.toLowerCase());if(points){const p=await admin('/admin/rewards/import-preview',{customers:[{email,source_name:'Customer',points,redeem_points:0}]});await admin('/admin/rewards/import',{batch_id:p.body.batch_id})}const link=(await admin('/admin/customer/setup-link',{customer_id:id})).body;const r=await call('/account/setup',{customer_id:id,token:link.token,password},'',email);return{id,email,cookie:r.headers['Set-Cookie'].split(';')[0],link}}
async function live(work){const saved=await transaction(async s=>{const settings=await s.get('settings','main');await s.put('settings','main',{...settings,demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{...settings.payment_links,zelle:'recipient@example.com'}});const p=await s.get('products',1);p.stock=100;await s.put('products',1,p);return settings});process.env.STORE_LIVE_CHECKOUT_ENABLED='1';try{return await work()}finally{delete process.env.STORE_LIVE_CHECKOUT_ENABLED;await transaction(s=>s.put('settings','main',saved))}}
function orderBody(a,points=0,extra={}){return{items:[{id:1,quantity:1}],coupon:'',affiliate:'',points_redeemed:points,customer:{name:'Test',email:a.email,phone:'2025550101',address:'1 Test Road',city:'Test',state:'GA',zip:'00000'},payment_method:'zelle',idempotency_key:crypto.randomUUID(),...extra}}
before(async()=>{await transaction(seed);const r=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});adminCookie=r.headers['Set-Cookie'].split(';')[0]});after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const png=async()=>(await require('sharp')({create:{width:16,height:32,channels:3,background:'#fff'}}).png().toBuffer()).toString('base64');
const getOrder=id=>transaction(s=>s.get('orders',id));
test('a payment marked by mistake can be undone: back to unpaid, points taken back, out of sales, then paid again earns once',async()=>{const a=await customer(100);await live(async()=>{
 const o=(await call('/orders',orderBody(a,100,{coupon:'DEMO20'}),a.cookie)).body.order;
 await call('/orders/'+o.id+'/receipt',{mime:'image/png',file:await png()},a.cookie);
 await admin('/admin/status',{id:o.id,status:'paid',verified:true});
 let w=(await call('/account',undefined,a.cookie)).body.wallet;assert.equal(w.balance,30);assert.equal(w.reserved,0);
 await assert.rejects(admin('/admin/status',{id:o.id,status:'unpaid'}),/Confirm/);
 await assert.rejects(call('/admin/status',{id:o.id,status:'unpaid',confirm:true}),e=>e.status===401);
 const r=(await admin('/admin/status',{id:o.id,status:'unpaid',confirm:true})).body;assert.equal(r.status,'payment_submitted');
 const x=await getOrder(o.id);assert.equal(x.status,'payment_submitted');assert.equal(x.paid,null);assert.equal(x.verified_payment_cents,0);assert.equal(x.points_earned,0);assert.equal(x.payment_undone.length,1);
 w=(await call('/account',undefined,a.cookie)).body.wallet;assert.equal(w.balance,100,'earned 30 removed and redeemed 100 returned');assert.equal(w.reserved,100,'redeemed points held again');assert.equal(w.available,0);
 await assert.rejects(admin('/admin/status',{id:o.id,status:'unpaid',confirm:true}),e=>e.status===409);
 await admin('/admin/status',{id:o.id,status:'paid',verified:true});
 w=(await call('/account',undefined,a.cookie)).body.wallet;assert.equal(w.balance,30,'paying again settles exactly once');assert.equal(w.reserved,0);
 assert.equal((await getOrder(o.id)).status,'paid');
})});
test('cancel after an undone payment releases the held points; card-invoice orders return to awaiting payment',async()=>{const a=await customer(100);await live(async()=>{
 const o=(await call('/orders',orderBody(a,100),a.cookie)).body.order;
 await admin('/admin/status',{id:o.id,status:'awaiting_payment'});
 await admin('/admin/status',{id:o.id,status:'paid',verified:true});
 const r=(await admin('/admin/status',{id:o.id,status:'unpaid',confirm:true})).body;assert.equal(r.status,'awaiting_payment');
 assert.ok((await getOrder(o.id)).expires>Math.floor(Date.now()/1000)+6*86400,'gets a fresh payment window instead of expiring at once');
 await admin('/admin/status',{id:o.id,status:'canceled'});
 const w=(await call('/account',undefined,a.cookie)).body.wallet;assert.equal(w.balance,100);assert.equal(w.reserved,0);
})});
test('Stripe-confirmed payments and orders with a bought label cannot be undone',async()=>{const a=await customer(0);await live(async()=>{
 const o=(await call('/orders',orderBody(a),a.cookie)).body.order;await admin('/admin/status',{id:o.id,status:'awaiting_payment'});await admin('/admin/status',{id:o.id,status:'paid',verified:true});
 await transaction(async s=>{const x=await s.get('orders',o.id);x.payment_verification_source='stripe_invoice';await s.put('orders',o.id,x)});
 await assert.rejects(admin('/admin/status',{id:o.id,status:'unpaid',confirm:true}),/Stripe/);
 await transaction(async s=>{const x=await s.get('orders',o.id);x.payment_verification_source='staff_verified';x.shippo_transaction_id='t_1';await s.put('orders',o.id,x)});
 await assert.rejects(admin('/admin/status',{id:o.id,status:'unpaid',confirm:true}),/label/);
})});

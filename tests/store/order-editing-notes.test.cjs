'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-management-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'fixture-management-password',STORE_SESSION_SECRET:'fixture-management-session-secret-at-least-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',RESEND_API_KEY:'fixture-only',STORE_EMAIL_FROM:'support@example.com'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const sent=[];global.fetch=async(url,opts)=>{assert.equal(url,'https://api.resend.com/emails');sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'fixture-'+sent.length})}};
const customer={name:'Fixture Customer',email:'customer@example.com',phone:'2025550101',address:'1 Test Street',city:'Example',state:'GA',zip:'00000'};
let ownerCookie,staffCookie;
const call=(p,b,h={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...h},body:b||{}});
const admin=(p,b,cookie=staffCookie)=>call(p,b,{cookie});
const make=async(extra={})=>(await call('/orders',{items:[{id:1,quantity:1}],coupon:'',affiliate:'',payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer,...extra})).body;
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'fixture@example.com'}});await s.put('products',1,{id:1,name:'Fixture',sku:'FIXTURE',price:2000,stock:100,active:1});const staffId=accounts.hash('staff@example.com');await s.put('staff',staffId,{id:staffId,name:'Fixture staff',email:'staff@example.com',active:true,verified:true,auth_version:1});const id='fixture-staff-session',exp=Math.floor(Date.now()/1000)+28800,core=exp+'.'+id;await s.put('sessions',id,{expires:exp,staff_id:staffId,auth_version:1});staffCookie='glow_next_admin='+core+'.'+crypto.createHmac('sha256',process.env.STORE_SESSION_SECRET).update(core).digest('base64url');});ownerCookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('staff notes are private, append safely, deduplicate retries and preserve order finances',async()=>{
 const r=await make(),id=r.order.id,key=crypto.randomUUID(),payload={id,key,note:'Customer requested a blue shirt.\nFollow up tomorrow.'},before=sent.length;
 await assert.rejects(call('/admin/order/note',payload),e=>e.status===401);
 await admin('/admin/order/note',payload);await admin('/admin/order/note',payload);
 const another={id,key:crypto.randomUUID(),note:'Second staff follow-up'};await admin('/admin/order/note',another,ownerCookie);
 const stored=await transaction(s=>s.get('orders',id));assert.equal(stored.staff_notes.length,2);assert.equal(stored.staff_notes[0].author,'Fixture staff');assert.equal(stored.staff_notes[1].author,'Store owner');assert.equal(stored.revision,2);assert.equal(stored.total,r.order.total);assert.equal(stored.status,r.order.status);assert.equal(sent.length,before);
 const publicView=(await call('/orders/'+id,null,{'x-order-token':r.token})).body;assert.equal('staff_notes' in publicView,false);
 const staffView=(await admin('/admin/data')).body.orders.find(o=>o.id===id);assert.equal(staffView.staff_notes.length,2);assert.equal('actor' in staffView.staff_notes[0],false);
 await assert.rejects(admin('/admin/order/note',{...payload,note:'Different'}),e=>e.status===409);
 await assert.rejects(admin('/admin/order/note',{...payload,key:crypto.randomUUID(),note:' '}),e=>e.status===400);
 await assert.rejects(admin('/admin/order/note',{...payload,key:crypto.randomUUID(),note:'x'.repeat(2001)}),e=>e.status===400);
 await admin('/admin/status',{id,status:'canceled'});await admin('/admin/order/note',{id,key:crypto.randomUUID(),note:'Canceled at customer request'});
 assert.equal((await transaction(s=>s.get('orders',id))).staff_notes.length,3);
});
test('add and delete items preserve stock and payment differences; stale edits after notes are rejected',async()=>{
 await transaction(async s=>{await s.put('products',1,{id:1,name:'Fixture',sku:'FIXTURE',price:2000,stock:10,active:1});await s.put('products',2,{id:2,name:'Second',sku:'SECOND',price:1000,stock:5,active:1})});
 const r=(await admin('/orders',{items:[{id:1,quantity:1}],payment_method:'zelle',customer,idempotency_key:crypto.randomUUID(),order_for_customer:true})).body;await admin('/admin/status',{id:r.order.id,status:'paid',verified:true});let o=(await admin('/admin/data')).body.orders.find(o=>o.id===r.order.id);
 const body=o=>({id:o.id,expected_revision:o.revision||0,items:o.items.map(i=>({id:i.id,quantity:i.quantity,price:i.price})),coupon_discount:0,shipping:o.shipping,tax:0,reason:'Customer requested adjustment'});
 const stale=body(o);await admin('/admin/order/note',{id:o.id,key:crypto.randomUUID(),note:'Customer called'});await assert.rejects(admin('/admin/order/items',stale),e=>e.status===409);
 o=(await admin('/admin/data')).body.orders.find(o=>o.id===r.order.id);
 o=(await admin('/admin/order/items',{...body(o),items:[...body(o).items,{id:2,quantity:2,price:1000}]})).body.order;assert.equal(o.balance_due_cents,2000);assert.equal((await transaction(s=>s.get('products',2))).stock,3);assert.equal('staff_notes' in o,false);
 o=(await admin('/admin/order/items',{...body(o),items:[{id:2,quantity:1,price:1000}]})).body.order;assert.equal(o.refund_due_cents,1000);assert.equal((await transaction(s=>s.get('products',1))).stock,10);assert.equal((await transaction(s=>s.get('products',2))).stock,4);
 await assert.rejects(admin('/admin/order/items',{...body(o),items:[]}),e=>e.status===400);
 await assert.rejects(admin('/admin/order/items',{...body(o),items:[{id:2,quantity:100,price:1000}]}),/stock/);
 assert.equal((await transaction(s=>s.get('products',2))).stock,4);
});
test('editor offers explicit removal and escapes private note content',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../store-next/app.js'),'utf8');const names=['orderItemRow','orderNotesForm'];const context=vm.createContext({esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),orderTime:()=> 'Fixture time',crypto});for(const name of names){const start=source.indexOf('function '+name+'('),end=source.indexOf('\n',start);vm.runInContext(source.slice(start,end),context)}
 const row=vm.runInContext('orderItemRow({id:1,name:"Fixture",quantity:1,price:2000})',context);assert.match(row,/data-action="remove-order-item"/);
 const notes=vm.runInContext('orderNotesForm({id:"GLP-FIXTURE",staff_notes:[{author:"Staff",created:1,text:"<script>alert(1)</script>"}]})',context);assert.match(notes,/&lt;script>/);assert.doesNotMatch(notes,/<script>/);assert.match(notes,/Save staff note/);
});

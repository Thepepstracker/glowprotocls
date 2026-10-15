'use strict';
// Kits of 10: a kit is its own product (own price, own photo) in the same stock group as the
// single vial, with units:10. Each kit sold takes 10 from the group, so kits and singles can
// never sell more vials than exist.
const{test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-kits-test-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='test-password-123';process.env.STORE_SESSION_SECRET='test-session-secret-at-least-thirty-two-characters';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
let cookie;const call=(p,b,h={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...h},body:b||{}});const admin=(p,b)=>call(p,b,{cookie});
const customer={name:'Kit Test',email:'glp-checkout-test@example.com',phone:'2025550101',address:'1 Test Street',city:'Example',state:'GA',zip:'00000'};
const order=items=>call('/orders',{items,coupon:'',payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer}).then(r=>r.body);
const group=async()=>(await admin('/admin/data')).body.products.filter(p=>p.stock_pool==='kit-test').map(p=>p.stock);
const pub=async sku=>(await call('/catalog')).body.products.find(p=>p.sku===sku);
let single,kit;
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await admin('/admin/product',{name:'Test Vial · 10 mg',sku:'kit-test-10mg',price:4000,stock:23,stock_pool:'kit-test',active:1});
 await admin('/admin/product',{name:'Test Vial · 10 mg · Kit of 10',sku:'kit-test-10mg-kit',price:37999,stock:23,stock_pool:'kit-test',active:1,units:10});
 const d=(await admin('/admin/data')).body;single=d.products.find(p=>p.sku==='kit-test-10mg');kit=d.products.find(p=>p.sku==='kit-test-10mg-kit')});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('kit saves units:10 in the same stock group; single stays plain',async()=>{assert.equal(kit.units,10);assert.equal(single.units,undefined);assert.deepEqual(await group(),[23,23])});

test('catalog offers whole kits only: 23 vials = 2 kits, singles unaffected',async()=>{assert.equal((await pub('kit-test-10mg-kit')).stock,2);assert.equal((await pub('kit-test-10mg-kit')).units,10);assert.equal((await pub('kit-test-10mg')).stock,23)});

test('quote charges the kit price and refuses more kits than the group can fill',async()=>{const q=(await call('/quote',{items:[{id:kit.id,quantity:2}]})).body;assert.equal(q.subtotal,75998);assert.equal(q.items[0].units,10);await assert.rejects(call('/quote',{items:[{id:kit.id,quantity:3}]}),/Only 2 of Test Vial · 10 mg · Kit of 10 available/)});

test('kits and singles together cannot oversell the vials',async()=>{await assert.rejects(call('/quote',{items:[{id:kit.id,quantity:2},{id:single.id,quantity:4}]}),/Only/);const q=(await call('/quote',{items:[{id:kit.id,quantity:2},{id:single.id,quantity:3}]})).body;assert.equal(q.subtotal,75998+12000)});

test('placing a kit order takes 10 per kit; cancel puts them all back',async()=>{const o=await order([{id:kit.id,quantity:1},{id:single.id,quantity:2}]);assert.equal(o.order.items.find(i=>i.id===kit.id).units,10);assert.deepEqual(await group(),[11,11]);assert.equal((await pub('kit-test-10mg-kit')).stock,1);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.deepEqual(await group(),[23,23])});

test('under 10 vials the kit is sold out and refused, singles still sell',async()=>{const o=await order([{id:single.id,quantity:14}]);assert.deepEqual(await group(),[9,9]);const k=await pub('kit-test-10mg-kit');assert.equal(k.stock,0);assert.equal(k.in_stock,false);await assert.rejects(call('/quote',{items:[{id:kit.id,quantity:1}]}),/Only 0 of/);assert.equal((await call('/quote',{items:[{id:single.id,quantity:9}]})).status,200);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.deepEqual(await group(),[23,23])});

test('live store hides real counts for kits too',async()=>{const set=async demo=>transaction(async s=>{const st=await s.get('settings','main');st.demo=demo;await s.put('settings','main',st)});await set(false);try{assert.equal((await pub('kit-test-10mg-kit')).stock,99);assert.equal((await pub('kit-test-10mg')).stock,99)}finally{await set(true)}});

test('management order edit counts kits as 10 vials each',async()=>{const o=await order([{id:single.id,quantity:1}]);assert.deepEqual(await group(),[22,22]);const d=(await admin('/admin/data')).body.orders.find(x=>x.id===o.order.id);
 const r=(await admin('/admin/order/items',{id:d.id,expected_revision:d.revision||0,items:[{id:single.id,quantity:1,price:4000},{id:kit.id,quantity:1,price:37999}],coupon_discount:0,shipping:0,tax:0,reason:'Kit test adjustment'})).body.order;
 assert.equal(r.items.find(i=>i.id===kit.id).units,10);assert.deepEqual(await group(),[12,12]);
 await assert.rejects(admin('/admin/order/items',{id:r.id,expected_revision:r.revision,items:[{id:kit.id,quantity:3,price:37999}],coupon_discount:0,shipping:0,tax:0,reason:'Kit test adjustment'}),/stock/);assert.deepEqual(await group(),[12,12]);
 await admin('/admin/status',{id:r.id,status:'canceled'});assert.deepEqual(await group(),[23,23])});

test('units cannot change while the kit has reserved orders',async()=>{const o=await order([{id:kit.id,quantity:1}]);await assert.rejects(admin('/admin/product',{id:kit.id,name:kit.name,sku:kit.sku,price:kit.price,stock:13,expected_stock:13,stock_pool:'kit-test',active:1,promo_excluded:0,units:5}),/units/);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.deepEqual(await group(),[23,23])});

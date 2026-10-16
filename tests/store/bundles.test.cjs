'use strict';
// Bundles: a bundle takes its stock from the products inside it. It can only be bought while every
// product inside can fill it, each sale takes those vials, and cancelling puts them back.
const{test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-bundles-test-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='test-password-123';process.env.STORE_SESSION_SECRET='test-session-secret-at-least-thirty-two-characters';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
let cookie;const call=(p,b,h={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...h},body:b||{}});const admin=(p,b)=>call(p,b,{cookie});
const customer={name:'Bundle Test',email:'glp-checkout-test@example.com',phone:'2025550101',address:'1 Test Street',city:'Example',state:'GA',zip:'00000'};
const order=items=>call('/orders',{items,coupon:'',payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer}).then(r=>r.body);
const data=async()=>(await admin('/admin/data')).body.products;
const stock=async sku=>(await data()).find(p=>p.sku===sku).stock;
const pub=async sku=>(await call('/catalog')).body.products.find(p=>p.sku===sku);
const quote=items=>call('/quote',{items});
let a,b,kit,bundle,b2;
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await admin('/admin/product',{name:'Vial A · 50 mg',sku:'bt-a-50',price:5000,stock:5,stock_pool:'bt-a',active:1});
 await admin('/admin/product',{name:'Vial A · 50 mg · Kit of 10',sku:'bt-a-50-kit',price:47499,stock:5,stock_pool:'bt-a',active:1,units:10});
 await admin('/admin/product',{name:'Vial B · 10 mL',sku:'bt-b-10',price:3000,stock:3,active:1});
 await admin('/admin/product',{name:'Test Duo · 2-vial set',sku:'bundle-bt-duo',price:9900,stock:99,active:1,components:'bt-a-50 x2, bt-b-10'});
 await admin('/admin/product',{name:'Test Solo · A only',sku:'bundle-bt-solo',price:4500,stock:99,active:1,components:[{sku:'bt-a-50',qty:1}]});
 const d=await data();[a,b,kit,bundle,b2]=['bt-a-50','bt-b-10','bt-a-50-kit','bundle-bt-duo','bundle-bt-solo'].map(s=>d.find(p=>p.sku===s))});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('bundle saves what is inside it, by SKU, with quantities',async()=>{assert.deepEqual(bundle.components,[{id:a.id,qty:2},{id:b.id,qty:1}]);assert.deepEqual(b2.components,[{id:a.id,qty:1}]);assert.equal(a.components,undefined)});

test('catalog stock for a bundle comes from what is inside: 5 A (2 each) and 3 B = 2 bundles',async()=>{assert.equal((await pub('bundle-bt-duo')).stock,2);assert.equal((await pub('bundle-bt-solo')).stock,5)});

test('quote refuses more bundles than the vials inside can fill, with the real number',async()=>{assert.equal((await quote([{id:bundle.id,quantity:2}])).status,200);await assert.rejects(quote([{id:bundle.id,quantity:3}]),/Only 2 of Test Duo · 2-vial set available/)});

test('bundles and single vials together cannot oversell the vials',async()=>{await assert.rejects(quote([{id:bundle.id,quantity:2},{id:a.id,quantity:2}]),/Only/);assert.equal((await quote([{id:bundle.id,quantity:2},{id:a.id,quantity:1}])).status,200);await assert.rejects(quote([{id:a.id,quantity:4},{id:bundle.id,quantity:1}]),/Only 0 of Test Duo/);await assert.rejects(quote([{id:bundle.id,quantity:2},{id:b2.id,quantity:2}]),/Only 1 of Test Solo/)});

test('a bundle order takes the vials inside it (and their kit group); cancel puts them back',async()=>{const o=await order([{id:bundle.id,quantity:1}]);assert.deepEqual(o.order.items[0].draws,[{id:a.id,qty:2},{id:b.id,qty:1}]);assert.equal(await stock('bt-a-50'),3);assert.equal(await stock('bt-a-50-kit'),3);assert.equal(await stock('bt-b-10'),2);assert.equal((await pub('bundle-bt-duo')).stock,1);
 await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.equal(await stock('bt-a-50'),5);assert.equal(await stock('bt-b-10'),3);assert.equal((await pub('bundle-bt-duo')).stock,2)});

test('when any one product inside runs out, the bundle is sold out and refused',async()=>{const o=await order([{id:b.id,quantity:3}]);assert.equal(await stock('bt-b-10'),0);const p=await pub('bundle-bt-duo');assert.equal(p.stock,0);assert.equal(p.in_stock,false);await assert.rejects(quote([{id:bundle.id,quantity:1}]),/Only 0 of Test Duo/);assert.equal((await quote([{id:b2.id,quantity:1}])).status,200);await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.equal(await stock('bt-b-10'),3)});

test('live store masks bundle counts like everything else',async()=>{const set=async demo=>transaction(async s=>{const st=await s.get('settings','main');st.demo=demo;await s.put('settings','main',st)});await set(false);try{assert.equal((await pub('bundle-bt-duo')).stock,99)}finally{await set(true)}});

test('cancel uses what the bundle held when ordered, even if its contents change later',async()=>{const o=await order([{id:bundle.id,quantity:1}]);assert.equal(await stock('bt-a-50'),3);await admin('/admin/product',{id:bundle.id,name:bundle.name,sku:bundle.sku,price:bundle.price,stock:99,active:1,components:'bt-b-10'});await admin('/admin/status',{id:o.order.id,status:'canceled'});assert.equal(await stock('bt-a-50'),5);assert.equal(await stock('bt-b-10'),3);
 await admin('/admin/product',{id:bundle.id,name:bundle.name,sku:bundle.sku,price:bundle.price,stock:99,active:1,components:'bt-a-50 x2, bt-b-10'})});

test('management order edit adds a bundle by taking its vials, and refuses when they run short',async()=>{const o=await order([{id:b.id,quantity:1}]);assert.equal(await stock('bt-b-10'),2);const d=(await admin('/admin/data')).body.orders.find(x=>x.id===o.order.id);
 const r=(await admin('/admin/order/items',{id:d.id,expected_revision:d.revision||0,items:[{id:b.id,quantity:1,price:3000},{id:bundle.id,quantity:1,price:9900}],coupon_discount:0,shipping:0,tax:0,reason:'Bundle test adjustment'})).body.order;
 assert.deepEqual(r.items.find(i=>i.id===bundle.id).draws,[{id:a.id,qty:2},{id:b.id,qty:1}]);assert.equal(await stock('bt-a-50'),3);assert.equal(await stock('bt-b-10'),1);
 await assert.rejects(admin('/admin/order/items',{id:r.id,expected_revision:r.revision,items:[{id:b.id,quantity:1,price:3000},{id:bundle.id,quantity:3,price:9900}],coupon_discount:0,shipping:0,tax:0,reason:'Bundle test adjustment'}),/stock/);assert.equal(await stock('bt-a-50'),3);
 await admin('/admin/status',{id:r.id,status:'canceled'});assert.equal(await stock('bt-a-50'),5);assert.equal(await stock('bt-b-10'),3)});

test('bad bundle contents are refused',async()=>{await assert.rejects(admin('/admin/product',{name:'X',sku:'bundle-bt-bad',price:100,stock:1,active:1,components:'no-such-sku'}),/no product with SKU no-such-sku/);await assert.rejects(admin('/admin/product',{name:'Y',sku:'bundle-bt-nest',price:100,stock:1,active:1,components:'bundle-bt-duo'}),/cannot contain another bundle/);await assert.rejects(admin('/admin/product',{id:bundle.id,name:bundle.name,sku:bundle.sku,price:bundle.price,stock:99,active:1,components:'bundle-bt-duo'}),/cannot contain itself/);await assert.rejects(admin('/admin/product',{name:'Z',sku:'bundle-bt-kit',price:100,stock:1,active:1,units:10,components:'bt-b-10'}),/units per item to 1/)});

test('saving a product without the contents field keeps its contents; an empty field clears them',async()=>{await admin('/admin/product',{id:b2.id,name:b2.name,sku:b2.sku,price:4600,stock:99,active:1});assert.deepEqual((await data()).find(p=>p.id===b2.id).components,[{id:a.id,qty:1}]);await admin('/admin/product',{id:b2.id,name:b2.name,sku:b2.sku,price:4600,stock:7,active:1,components:''});assert.equal((await data()).find(p=>p.id===b2.id).components,undefined);assert.equal((await pub('bundle-bt-solo')).stock,7)});

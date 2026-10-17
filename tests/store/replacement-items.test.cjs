'use strict';
// Replacement boxes: staff list what goes in; stock comes out once; changing the list puts the old items back.
const{test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-repl-items-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'test-password-123',STORE_SESSION_SECRET:'test-session-secret-at-least-thirty-two-characters',STORE_ORIGIN:'http://127.0.0.1:8787'});
const{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
let cookie,a,b;const call=(p,body,h={})=>handle({path:p,method:body?'POST':'GET',headers:{'x-store-request':'1',...h},body:body||{}});const admin=(p,body)=>call(p,body,{cookie});
const stock=async sku=>(await admin('/admin/data')).body.products.find(p=>p.sku===sku).stock;
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await admin('/admin/product',{name:'Rep A',sku:'rep-a',price:1000,stock:5,active:1});await admin('/admin/product',{name:'Rep B',sku:'rep-b',price:1000,stock:3,active:1});
 const d=(await admin('/admin/data')).body.products;a=d.find(p=>p.sku==='rep-a');b=d.find(p=>p.sku==='rep-b');
 await transaction(s=>s.put('orders','GLP-REPTEST1',{id:'GLP-REPTEST1',status:'shipped',is_test:false,created:1,customer:{name:'X'},items:[],replacements:[{n:1,note:'missing',tracking:'1Z',created:2}]}))});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('items saved with names, stock taken once; editing returns old items first; short stock refused',async()=>{
 const r=await admin('/admin/order/replacement-items',{id:'GLP-REPTEST1',n:1,items:[{id:a.id,quantity:2}]});assert.deepEqual(r.body.items,[{id:a.id,name:'Rep A',quantity:2}]);assert.equal(await stock('rep-a'),3);
 await admin('/admin/order/replacement-items',{id:'GLP-REPTEST1',n:1,items:[{id:b.id,quantity:1}]});assert.equal(await stock('rep-a'),5);assert.equal(await stock('rep-b'),2);
 await assert.rejects(admin('/admin/order/replacement-items',{id:'GLP-REPTEST1',n:1,items:[{id:b.id,quantity:4}]}),/Not enough stock for Rep B/);assert.equal(await stock('rep-b'),2);assert.equal(await stock('rep-a'),5);
 const o=await transaction(s=>s.get('orders','GLP-REPTEST1'));assert.equal(o.status,'shipped');assert.equal(o.replacements[0].items[0].name,'Rep B')});

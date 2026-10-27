'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{prepareRecovery}=require('../../tools/sevalla/recovery-catalog.cjs');
function store(){const records=new Map();return{get:async(k,id)=>records.get(k+':'+id),list:async k=>[...records].filter(([key])=>key.startsWith(k+':')).map(([,v])=>v),put:async(k,id,v)=>records.set(k+':'+id,structuredClone(v))}}
test('replacement catalog has zero stock, checkout off, no fabricated customers and no inherited shirt restock',async()=>{
 const s=store(),r=await prepareRecovery(s);assert(r.products>=59);assert.equal(r.checkout_enabled,false);
 const products=await s.list('products');assert.equal(products.filter(p=>p.category==='merch').length,36);assert(products.every(p=>p.stock===0));assert.equal(new Set(products.map(p=>p.id)).size,products.length);assert.equal(new Set(products.map(p=>p.sku)).size,products.length);
 assert.equal((await s.get('products',7)).sku,'nad-500-mg');const fuel=products.find(p=>p.sku==='GLOW-FUEL-120MG');assert.equal(fuel.price,7900);assert.equal(fuel.regular_price,11000);assert.equal(fuel.promo_excluded,true);
 await require('../../netlify/functions/lib/merch-catalog.cjs').ensureMerchCatalog(s);assert((await s.list('products')).every(p=>p.stock===0));
 for(const kind of ['customers','affiliates','coupons'])assert.equal((await s.list(kind)).length,0);
 assert.equal((await s.get('settings','main')).demo,false);await assert.rejects(prepareRecovery(s),/empty database/);
});
test('recovery refuses historical orders without modifying them',async()=>{const s=store();await s.put('orders','GLP-FIXTURE',{id:'GLP-FIXTURE',paid:1});await assert.rejects(prepareRecovery(s),/empty database/);assert.equal((await s.list('products')).length,0);assert.equal((await s.get('orders','GLP-FIXTURE')).paid,1)});
test('standalone replacement boots a recovered catalog and dashboard with live ordering blocked',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sevalla-recovery-'));
 Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(dir,'store.sqlite'),STORE_ADMIN_PASSWORD:'fixture-recovery-owner-password',STORE_SESSION_SECRET:'fixture-recovery-session-secret-long-enough'});
 const {transaction}=require('../../netlify/functions/lib/store-db.cjs');await transaction(prepareRecovery);
 const {createServer}=require('../../tools/sevalla/server.cjs'),{handler}=require('../../netlify/functions/lib/store-handler.cjs');const server=createServer({apiHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})});const base='http://127.0.0.1:'+server.address().port;
 const catalog=await(await fetch(base+'/api/catalog')).json();assert.equal(catalog.products.length,95);assert(catalog.products.every(p=>!p.stock));assert.equal(catalog.settings.checkout_enabled,false);
 const request=(route,data,cookie)=>fetch(base+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Store-Request':'1',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
 const login=await request('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const admin=await fetch(base+'/api/admin/data',{headers:{cookie}});assert.equal(admin.status,200);assert.equal((await admin.json()).orders.length,0);
 assert.equal((await request('/orders',{})).status,503);assert.equal((await transaction(s=>s.list('orders'))).length,0);
});

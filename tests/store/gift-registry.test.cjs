'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-registry-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'fixture-admin-password',STORE_SESSION_SECRET:'fixture-registry-secret-longer-than-32',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{handler}=require('../../netlify/functions/lib/store-handler.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),{createServer}=require('../../tools/sevalla/server.cjs');
const call=(p,b,cookie='',headers={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie,...headers},body:b||{}});
const read=async cookie=>(await call('/registry',undefined,cookie)).body;
async function edit(cookie,action,extra={}){const d=await read(cookie);return(await call('/registry',{action,expected_revision:d.revision,...extra},cookie)).body}
const shared=async token=>(await call('/registry/shared',undefined,'',{'x-registry-token':token})).body;
async function customer(email){const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email,name:'Private name',address:'Private address',verified:true,auth_version:1});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:Math.floor(Date.now()/1000)+3600})});return{id,cookie:'glow_next_customer='+token}}
let a,b;before(async()=>{await transaction(seed);a=await customer('owner@example.test');b=await customer('other@example.test')});after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('registry ownership uses session only, default is private, IDs cannot select another account',async()=>{
 await assert.rejects(call('/registry'),e=>e.status===401);const initial=await read(a.cookie);assert.equal(initial.share_token,null);assert.deepEqual(initial.items,[]);
 await edit(a.cookie,'add',{product_id:1,customer_id:b.id});assert.equal((await read(a.cookie)).items.length,1);assert.equal((await read(b.cookie)).items.length,0);
 await assert.rejects(call('/registry',{action:'add',product_id:1,expected_revision:0},a.cookie),e=>e.status===409);
 const snapshot=await transaction(async s=>({customers:await s.list('customers'),orders:await s.list('orders'),settings:await s.get('settings','main')}));
 await edit(a.cookie,'rename',{title:'Christmas favorites'});const link=await edit(a.cookie,'share');await shared(link.share_token);
 assert.deepEqual(await transaction(async s=>({customers:await s.list('customers'),orders:await s.list('orders'),settings:await s.get('settings','main')})),snapshot);
});
test('public link is unguessable, read only and returns a strict DTO with no account or buyer data',async()=>{
 const r=await edit(a.cookie,'share');assert.match(r.share_token,/^[A-Za-z0-9_-]{43}$/);const d=await shared(r.share_token);
 assert.deepEqual(Object.keys(d).sort(),['items','title']);assert.deepEqual(Object.keys(d.items[0]).sort(),['available','id','image','name','price']);assert.doesNotMatch(JSON.stringify(d),/owner@example|Private|customer_id|share_token|revision|purchas|orders|address/);
 for(const token of ['',a.id,'a'.repeat(43),'bad/token'])await assert.rejects(shared(token),e=>e.status===404);
 await assert.rejects(call('/registry/shared',{action:'remove',product_id:1},'',{'x-registry-token':r.share_token}),e=>e.status===404);
 await assert.rejects(call('/registry',{action:'remove',product_id:1,expected_revision:r.revision},'',{'x-registry-token':r.share_token}),e=>e.status===401);
});
test('editing is idempotent for adding a favorite and isolates owners; tokens rotate and revoke',async()=>{
 const before=await read(a.cookie);await edit(a.cookie,'add',{product_id:1});assert.equal((await read(a.cookie)).items.length,before.items.length);
 const first=(await edit(a.cookie,'share')).share_token;assert.equal((await edit(a.cookie,'share')).share_token,first);
 const second=(await edit(a.cookie,'rotate')).share_token;assert.notEqual(first,second);await assert.rejects(shared(first),e=>e.status===404);await shared(second);
 await edit(b.cookie,'add',{product_id:1});await edit(b.cookie,'remove',{product_id:1});assert.equal((await read(a.cookie)).items.length,1);
 await edit(a.cookie,'unshare');await assert.rejects(shared(second),e=>e.status===404);assert.equal((await read(a.cookie)).share_token,null);
});
test('catalog price, stock, removed items, kits, bundles and brand isolation use authoritative data',async()=>{
 const original=await transaction(s=>s.get('products',1));await transaction(async s=>{await s.put('products',1,{...original,price:1234,stock:0});await s.put('products',9001,{id:9001,name:'Fixture kit',price:10000,stock:9,units:10,active:1});await s.put('products',9002,{id:9002,name:'Fixture bundle',price:2000,stock:99,active:1,components:[{id:1,qty:2}]});await s.put('products',9003,{id:9003,name:'Other brand',price:100,stock:1,active:1,brand:'zader'})});
 await edit(a.cookie,'add',{product_id:9001});await edit(a.cookie,'add',{product_id:9002});let d=await read(a.cookie);assert.equal(d.items[0].price,1234);assert(d.items.every(p=>p.available===false));
 await transaction(s=>s.put('products',1,{...original,active:0}));d=await read(a.cookie);assert.deepEqual(d.items[0],{id:1,available:false,name:'Product currently unavailable'});
 await assert.rejects(edit(a.cookie,'add',{product_id:1}),e=>e.status===404);await assert.rejects(edit(a.cookie,'add',{product_id:9003}),e=>e.status===404);await assert.rejects(call('/registry',undefined,a.cookie,{host:'zaderhealth.com'}),e=>e.status===404);
 await transaction(s=>s.remove('products',1));assert.equal((await read(a.cookie)).items.length,3);await transaction(s=>s.put('products',1,original));await edit(a.cookie,'remove',{product_id:9001});await edit(a.cookie,'remove',{product_id:9002});
});
test('CSRF, invalid input, bounded lists and conflicting concurrent edits are rejected',async()=>{
 const d=await read(a.cookie),body={action:'rename',title:'New',expected_revision:d.revision};
 for(const headers of [{'x-store-request':''},{origin:'https://evil.test'},{'sec-fetch-site':'cross-site'}])await assert.rejects(call('/registry',body,a.cookie,headers),e=>e.status===403);
 for(const extra of [{action:'rename',title:''},{action:'rename',title:'x'.repeat(81)},{action:'rename',title:'a\nb'},{action:'add',product_id:'1'},{action:'add',product_id:1.5},{action:'unknown'}])await assert.rejects(call('/registry',{expected_revision:d.revision,...extra},a.cookie),e=>e.status===400);
 const results=await Promise.allSettled([call('/registry',body,a.cookie),call('/registry',body,a.cookie)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 await transaction(async s=>{const r=await s.get('gift_registries',b.id);r.items=Array.from({length:100},(_,i)=>i+10000);await s.put('gift_registries',b.id,r)});await assert.rejects(edit(b.cookie,'add',{product_id:1}),/100 products/);
});
test('repeated guest purchases preserve the registry, affiliate priority, totals and payment workflow',async()=>{
 const link=await edit(a.cookie,'share'),before=await read(a.cookie);
 for(let n=0;n<6;n++){
  const d=await shared(link.share_token);const cart={items:[{id:d.items[0].id,quantity:1}],affiliate:'sarah',coupon:'DEMO20'};
  const q=(await call('/quote',cart)).body;assert.equal(q.affiliate,'sarah');assert(q.coupon_discount>0);
  const o=(await call('/orders',{...cart,customer:{name:'Gift Buyer',email:`gift${n}@example.test`,phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30301'},payment_method:'zelle',idempotency_key:crypto.randomUUID()})).body;
  assert.equal(o.order.affiliate,'sarah');assert.equal(o.order.payment_method,'zelle');assert.equal(o.order.total,q.total);assert.equal(o.order.customer_id,undefined);
  assert.deepEqual(await read(a.cookie),before);
 }
});
test('Sevalla HTTP registry path preserves cache protection, anonymous sharing and errors',async t=>{
 const server=createServer({apiHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const d=await read(a.cookie);const r=await fetch(base+'/api/registry/shared',{headers:{'X-Registry-Token':d.share_token}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('x-robots-tag'),/noindex/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal((await r.json()).items.length,1);
 assert.equal((await fetch(base+'/api/registry')).status,401);assert.equal((await fetch(base+'/api/registry/shared')).status,404);
 const shell=await fetch(base+'/store-next/?wishlist=mine');assert.match(await shell.text(),/registry.js/);
});
test('edit rate limiting is account scoped',async()=>{
 await transaction(s=>s.put('registry_limits',a.id,{count:60,until:Math.floor(Date.now()/1000)+60}));await assert.rejects(edit(a.cookie,'rename',{title:'Limited'}),e=>e.status===429);
});

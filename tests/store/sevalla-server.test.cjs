'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createServer}=require('../../tools/sevalla/server.cjs');
test('Sevalla routes storefront, management and uploads without exposing source files',async t=>{
 let event;
 const server=createServer({apiHandler:async e=>{event=e;return{statusCode:200,headers:{'Content-Type':'application/json'},body:JSON.stringify({route:e.queryStringParameters.route})}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 for(const route of ['/','/store-next/admin','/store-next/account','/store-next/profile/sample','/store-next/sample']){const r=await fetch(base+route);assert.equal(r.status,200);assert.match(await r.text(),/id="app"/)}
 assert.match(await (await fetch(base+'/store-next/merch')).text(),/Glow Merch/);
 for(const p of ['/package.json','/package-lock.json','/tools/store/seed-data.cjs','/netlify/functions/lib/store-core.cjs','/.env','/.git/config','/tools/sevalla/server.cjs','/img/%2e%2e/%2e%2e/package.json'])assert.equal((await fetch(base+p)).status,404,p);
 const r=await fetch(base+'/.netlify/functions/store-next?route=%2Fadmin%2Flogin',{method:'POST',headers:{'Content-Type':'application/json','X-Store-Request':'1'},body:'{}'});assert.equal(r.status,200);assert.equal(event.queryStringParameters.route,'/admin/login');assert.equal(event.headers['x-store-request'],'1');assert.equal(event.body,'{}');
 assert.deepEqual(await(await fetch(base+'/api/catalog')).json(),{route:'/catalog'});
 assert.equal((await fetch(base+'/health/live')).status,200);
});
test('Sevalla readiness reports database failure and private failures do not expose credentials',async t=>{
 const server=createServer({ready:async()=>{throw new Error('postgres://secret')},apiHandler:async()=>{throw new Error('secret')}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const r=await fetch(base+'/health/ready');assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret/);
 assert.equal((await fetch(base+'/.netlify/functions/stripe-webhook',{method:'POST',body:'{}'})).status,503);
 const big=await fetch(base+'/api/orders',{method:'POST',body:'x'.repeat(5*1024*1024+1)});assert.equal(big.status,413);
});
test('Sevalla lets browsers keep photos and re-check scripts, but never stores pages',async t=>{
 const server=createServer({apiHandler:async()=>({statusCode:200,headers:{},body:'{}'})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const page=await fetch(base+'/store-next/');assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('etag'),null);
 const js=await fetch(base+'/store-next/app.js');assert.equal(js.status,200);assert.equal(js.headers.get('cache-control'),'no-cache');const tag=js.headers.get('etag');assert.match(tag,/^"[A-Za-z0-9_-]+"$/);assert.equal(js.headers.get('x-content-type-options'),'nosniff');
 const again=await fetch(base+'/store-next/app.js',{headers:{'If-None-Match':tag}});assert.equal(again.status,304);assert.equal(await again.text(),'');
 assert.equal((await fetch(base+'/store-next/app.js',{headers:{'If-None-Match':'"old"'}})).status,200);
 assert.equal((await fetch(base+'/store-next/app.js',{headers:{'If-None-Match':'W/'+tag}})).status,304);
 const img=await fetch(base+'/img/glp-mark-8ae0a0b7.png');assert.equal(img.status,200);assert.match(img.headers.get('cache-control'),/^public, max-age=3600/);
 assert.equal((await fetch(base+'/api/catalog')).headers.get('cache-control'),'no-store');
});

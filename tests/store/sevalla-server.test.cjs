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

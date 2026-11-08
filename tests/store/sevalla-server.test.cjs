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
test('zaderhealth.com: storefront app, its own policy pages, www to the bare domain, Glow-only pages bounce home (8 Nov 2026)',async t=>{
 const server=createServer({apiHandler:async e=>({statusCode:200,headers:{},body:JSON.stringify({host:e.headers.host})})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const z=(p,h='zaderhealth.com')=>fetch(base+p,{headers:{'x-forwarded-host':h},redirect:'manual'});
 for(const p of ['/','/store-next/','/store-next/admin','/store-next/account','/store-next/anything','/random-page']){const r=await z(p);assert.equal(r.status,200,p);const html=await r.text();assert.match(html,/brand-zader\.css/,p);assert.doesNotMatch(html,/referral\.js/,p)}
 for(const [p,f] of [['/terms','Terms'],['/terms.html','Terms'],['/privacy/','Privacy'],['/shipping','Shipping'],['/contact','Contact']]){const r=await z(p);assert.equal(r.status,200,p);assert.match(await r.text(),new RegExp(f,'i'),p)}
 for(const p of ['/coa.html','/about.html','/glow-loyalty.html','/store-next/merch','/store-next/live.html','/store-next/index.html']){const r=await z(p);assert.equal(r.status,301,p);assert.equal(r.headers.get('location'),'/',p)}
 const w=await z('/terms?x=1','www.zaderhealth.com');assert.equal(w.status,301);assert.equal(w.headers.get('location'),'https://zaderhealth.com/terms?x=1');
 assert.equal((await z('/store-next/app.js')).status,200);assert.equal((await z('/store-next/brand-zader.css')).status,200);assert.equal((await z('/package.json')).status,404,'source files stay private on Zader too');
 assert.match(await (await z('/robots.txt')).text(),/zaderhealth/i);
 assert.match(await (await z('/store-next/packing.html')).text(),/Packing Check/);
 assert.equal((await z('/api/catalog')).status,200);
 // Glow is unchanged.
 const g=await fetch(base+'/');assert.match(await g.text(),/referral\.js/);assert.equal((await fetch(base+'/coa.html')).status,200);
});

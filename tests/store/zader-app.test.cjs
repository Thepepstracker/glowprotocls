'use strict';
// Zader Health app (Jonah, 19 Nov 2026: "make the app for zader health to be just like glow lab" → "Everything, with points",
// points shared but "named Zader Points", Glow never named on Zader pages).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
process.env.STORE_SESSION_SECRET=process.env.STORE_SESSION_SECRET||'zader-app-fixture-session-secret-longer-than-32';
const root=path.join(__dirname,'../..'),srv=require(path.join(root,'tools/sevalla/server.cjs'));
test('zaderhealth.com pages are an installable Zader app with its own icon and launch screens',()=>{
 const html=srv.zaderApp(fs.readFileSync(path.join(root,'store-next/zader.html'),'utf8'));
 assert.ok(html.includes('<link rel="manifest" href="/store-next/app.webmanifest">'));assert.ok(html.includes('apple-mobile-web-app-title" content="Zader Health"'));
 assert.ok(html.includes('/img/zader/app/zader-app-180.png'));assert.ok(!/\/img\/app\/splash-/.test(html),'Zader launch screens, not Glow’s');
 for(const m of html.match(/\/img\/zader\/app\/[a-z0-9-]+\.png/g))assert.ok(fs.existsSync(path.join(root,m)),m);
 const man=JSON.parse(srv.zaderManifest(''));assert.equal(man.name,'Zader Health');assert.equal(man.theme_color,'#031628');assert.ok(!JSON.stringify(man).includes('Glow'));
 for(const i of man.icons)assert.ok(fs.existsSync(path.join(root,i.src)),i.src);
});
test('the Zader server answers the manifest and serves the app on store pages',async()=>{
 const s=srv.createServer({apiHandler:async()=>({statusCode:200,headers:{},body:'{}'})});await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;
 const get=p=>new Promise((ok,no)=>require('node:http').get({host:'127.0.0.1',port,path:p,headers:{host:'zaderhealth.com'}},r=>{let t='';r.on('data',c=>t+=c);r.on('end',()=>ok({status:r.statusCode,text:async()=>t,json:async()=>JSON.parse(t)}))}).on('error',no));
 try{const m=await get('/store-next/app.webmanifest');assert.equal(m.status,200);assert.equal((await m.json()).name,'Zader Health');
  const h=await (await get('/store-next/account')).text();assert.ok(h.includes('apple-mobile-web-app-title" content="Zader Health"'));
  const pk=await (await get('/store-next/packing.html')).text();assert.ok(!pk.includes('apple-mobile-web-app-title" content="Zader Health"'),'packing page is not the customer app');
 }finally{s.close()}
});
test('one shared balance, but Zader accounts show only Zader orders and hide the other store’s order numbers',()=>{
 const {forBrand}=require(path.join(root,'netlify/functions/lib/customer-accounts.cjs'));
 const out={customer:{},orders:[{id:'GLP-AAAAAAAAA1'},{id:'ZDR-AAAAAAAAA1'}],ledger:[{order_id:'GLP-AAAAAAAAA1',points:79,note:'x'},{order_id:'ZDR-AAAAAAAAA1',points:50},{order_id:null,points:100,note:'Welcome bonus'}],wallet:{available:229}};
 const z=forBrand(out,'zader');assert.deepEqual(z.orders.map(o=>o.id),['ZDR-AAAAAAAAA1']);assert.equal(z.wallet.available,229);
 assert.equal(z.ledger[0].order_id,null);assert.equal(z.ledger[0].note,'From a past order');assert.equal(z.ledger[1].order_id,'ZDR-AAAAAAAAA1');
 assert.equal(forBrand(out,'glow'),out,'Glow is unchanged');
});
test('Zader orders get a mystery gift code; the slip prints it once zaderhealth.com runs on this store',()=>{
 const unbox=require(path.join(root,'netlify/functions/lib/unbox.cjs'));const k=unbox.key({id:'ZDR-AAAAAAAAA1',brand:'zader'});
 assert.match(k,/^ZDR-AAAAAAAAA1\.[A-Za-z0-9_-]{12}$/);assert.equal(unbox.parse(k),'ZDR-AAAAAAAAA1');assert.equal(unbox.key({id:'ZDR-AAAAAAAAA1',brand:'glow'}),null);assert.equal(unbox.key({id:'PEP-AAAAAAAAA1',brand:'peppuppy'}),null);
 const pack=fs.readFileSync(path.join(root,'store-next/packing.html'),'utf8');
 for(const s of ["zaderLive=d.zader_app_live===true","if(o.unbox_key&&(!z||zLive))","(z?'zaderhealth.com':'glowglps.com')+'/store-next/unbox/'"])assert.ok(pack.includes(s),s);
});
test('the app speaks Zader on zaderhealth.com',()=>{
 const app=fs.readFileSync(path.join(root,'store-next/app.js'),'utf8'),sw=fs.readFileSync(path.join(root,'store-next/app-sw.js'),'utf8');
 for(const s of ['const ZADER_SITE=','function zaderFix(root)',"[/Glow Lab/g,'Zader Health']","${ZADER_SITE?'':`<a href=\"/store-next/merch.html\""])assert.ok(app.includes(s),s);
 assert.ok(sw.includes("name: 'Zader Health'"));
});

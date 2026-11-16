'use strict';
// Website features (Jonah, 16 Nov 2026): product pages, back-in-stock alerts, smart add-ons in the bag.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-extras-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'extras-tests-session-secret-more-than-32-chars',STORE_ORIGIN:'https://glowglps.com',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),x=require('../../netlify/functions/lib/shop-extras.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),autopilot=require('../../netlify/functions/lib/autopilot.cjs');
const {createServer}=require('../../tools/sevalla/server.cjs');
const call=(p,b,cookie,ip='203.0.113.5')=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1','x-forwarded-for':ip,...(cookie?{cookie}:{})},body:b||{}});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts={})=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}if(String(url).startsWith('http://127.0.0.1'))return oldFetch(url,opts);throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const nowS=()=>Math.floor(Date.now()/1000),noon=()=>new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T17:00:00Z').getTime();
const P={};let n=0;
async function product(key,o){const id=9000+(++n);const p={id,active:true,brand:'glow',stock:20,price:3000,image:'/img/'+key+'.webp',...o};await transaction(s=>s.put('products',id,p));P[key]=p;return p}
const order=(items,extra={})=>transaction(s=>{const id='GLP-X'+crypto.randomBytes(4).toString('hex').toUpperCase();return s.put('orders',id,{id,is_test:false,status:'paid',paid:1,brand:'glow',created:nowS(),items:items.map(p=>({id:p.id,name:p.name,quantity:1})),customer:{name:'A',email:'a'+n+'@x.test'},...extra})});

test('setup',async()=>{await transaction(seed);
 await product('bpc10',{name:'BPC-157 · 10 mg',sku:'bpc-157-10-mg',slug:'tx-bpc',size:'10 mg'});await product('bpc20',{name:'BPC-157 · 20 mg',sku:'bpc-157-20-mg',slug:'tx-bpc',size:'20 mg',stock:0});
 await product('bac3',{name:'BAC Water · 3 mL',sku:'bac-water-3-ml',slug:'bac-water',size:'3 mL',price:500});await product('bac10',{name:'BAC Water · 10 mL',sku:'bac-water-10-ml',slug:'bac-water',size:'10 mL',price:999});
 await product('ghk',{name:'GHK-Cu · 100 mg',sku:'ghk-cu-100-mg',slug:'tx-ghk',size:'100 mg'});await product('mots',{name:'MOTS-C · 10 mg',sku:'mots-c-10-mg',slug:'tx-mots',size:'10 mg'});
 await product('eyes',{name:'Glow Eyes · 10 mL',sku:'glow-eyes-10-ml',slug:'tx-eyes',size:'10 mL',category:'cosmetic'});await product('mist',{name:'Rose Recovery Mist · 60 mL',sku:'rose-recovery-mist-60-ml',slug:'tx-mist',size:'60 mL',category:'cosmetic'});
 await product('reset',{name:'Metabolic Reset · 10 mg',sku:'bundle-737-10-mg',size:'10 mg'});await product('zader',{name:'GHK-Cu · 100 mg',sku:'z-ghk',slug:'tx-ghk',size:'100 mg',brand:'zader'});
 await product('sold',{name:'Selank · 10 mg',sku:'selank-10-mg',slug:'tx-selank',size:'10 mg',stock:0});
 for(let i=0;i<3;i++)await order([P.bpc10,P.ghk,P.bac10]);await order([P.bpc10,P.bac3]);await order([P.eyes,P.mist]);await order([P.eyes,P.mist]);await order([P.eyes,P.mots]);
 await order([P.bpc10,P.mots],{is_test:true});await order([P.bpc10,P.mots],{status:'awaiting_payment'});x.resetCache()});

test('product families: the store slug when there is one, else the product name',()=>{assert.equal(x.familySlug(P.bpc20),'tx-bpc');assert.equal(x.familySlug(P.reset),'metabolic-reset');assert.equal(x.familySlug({name:'Your Story Isn’t Over · Fridge magnet'}),'your-story-isnt-over');assert.equal(x.familyName(P.bac3),'BAC Water')});

test('goes well with: bought together in at least two paid orders, BAC water for peptides, never what you have, sold out, test or unpaid orders, or another store',async()=>{
 const r=(await call('/related',{ids:[P.bpc10.id]})).body.items;assert.equal(r[0].slug,'bac-water');assert.equal(r[0].why,'mix');assert.equal(r[0].id,P.bac10.id,'the size people actually buy');assert(r.some(i=>i.slug==='tx-ghk'&&i.id===P.ghk.id&&i.why==='together'));assert(!r.some(i=>i.slug==='tx-mots'),'mots-c only with test/unpaid orders');
 const e=(await call('/related',{slugs:['tx-eyes']})).body.items;assert.deepEqual(e.map(i=>i.slug),['tx-mist'],'a beauty product gets no BAC water; MOTS-C was bought with it only once');
 assert(!(await call('/related',{ids:[P.bpc10.id,P.bac10.id]})).body.items.some(i=>i.slug==='bac-water'),'already in the bag');
 await transaction(async s=>{const g=await s.get('products',P.ghk.id);g.stock=0;await s.put('products',g.id,g)});assert(!(await call('/related',{ids:[P.bpc10.id]})).body.items.some(i=>i.slug==='tx-ghk'),'sold out');
 await transaction(async s=>{const g=await s.get('products',P.ghk.id);g.stock=20;await s.put('products',g.id,g)});
 const z=(await handle({path:'/related',method:'POST',headers:{'x-store-request':'1',host:'zaderhealth.com'},body:{slugs:['tx-bpc']}})).body.items;assert(z.every(i=>i.id===P.zader.id),'Zader only gets Zader products');
});

test('back in stock: email (or the signed-in account), only for sold-out products, one email when any size returns, oldest first, once',async()=>{
 await assert.rejects(call('/stock-alert',{product_id:P.sold.id,email:'nope'}),/valid email/);
 await assert.rejects(call('/stock-alert',{product_id:P.bpc20.id,email:'amy@x.test'}),e=>e.status===409,'BPC-157 10 mg is in stock: the product is not sold out');
 assert.deepEqual((await call('/stock-alert',{product_id:P.sold.id,email:'Amy@X.test'})).body,{saved:true});assert.equal((await call('/stock-alert',{product_id:P.sold.id,email:'amy@x.test'})).body.already,true);
 const id=accounts.hash('cam@x.test'),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email:'cam@x.test',name:'Cam',verified:true,auth_version:1,created:1});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:nowS()+86400})});
 await call('/stock-alert',{product_id:P.sold.id},'glow_next_customer='+token);
 sent.length=0;assert.equal((await x.restocks(40,noon())).sent,0,'still sold out');
 await transaction(async s=>{const p=await s.get('products',P.sold.id);p.stock=5;await s.put('products',p.id,p)});
 assert.equal((await x.restocks(40,noon())).sent,2);assert.deepEqual(sent.map(m=>m.to[0]),['amy@x.test','cam@x.test'],'oldest request first');
 assert.equal(sent[0].subject,'It’s back: Selank · Glow Lab');assert.match(sent[0].text,/https:\/\/glowglps\.com\/store-next\/p\/tx-selank/);
 assert.equal((await x.restocks(40,noon())).sent,0,'once');
 const late=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T04:00:00Z').getTime()+86400000;assert.equal((await x.restocks(40,late)).status,'quiet_hours');
 assert.equal((await autopilot.status()).tasks.find(t=>t.key==='restock').on,false,'Autopilot switch starts OFF');
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];await assert.rejects(call('/admin/stock-alerts'),e=>e.status===401||e.status===403);
 const rows=(await call('/admin/stock-alerts',undefined,owner)).body.rows;assert.deepEqual(rows.find(r=>r.slug==='tx-selank'),{brand:'glow',slug:'tx-selank',name:'Selank',waiting:0,notified:2,oldest:0});
});

test('product page: a shared link shows the product name, sizes, price and photo; Google gets product data and a sitemap',async t=>{
 const products=[P.bpc10,{...P.bpc20,in_stock:false}];const html='<html><head><title>Glow Lab</title><meta name="description" content="x"><meta property="og:title" content="Old"></head><body><div id="app"></div></body></html>';
 const out=x.productHead(html,{products,slug:'tx-bpc',origin:'https://glowglps.com',brandName:'Glow Lab Protocols'});
 assert.match(out,/<title>BPC-157 · 10 mg, 20 mg · Glow Lab Protocols<\/title>/);assert.match(out,/<link rel="canonical" href="https:\/\/glowglps\.com\/store-next\/p\/tx-bpc">/);assert.doesNotMatch(out,/content="Old"/);assert.equal((out.match(/<title>/g)||[]).length,1);
 const ld=JSON.parse(out.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);assert.equal(ld['@type'],'Product');assert.equal(ld.offers.lowPrice,'30.00');assert.equal(ld.offers.availability,'https://schema.org/InStock');assert.match(ld.description,/For research use only/);
 assert.equal(x.productHead(html,{products,slug:'nope',origin:'https://glowglps.com',brandName:'Glow'}),html,'unknown product: page unchanged');
 const xml=x.sitemapWith('<urlset><url><loc>https://glowlabprotocols.com/coa.html</loc></url></urlset>',{products:[P.bpc10,P.bpc20,P.bac3],origin:'https://glowglps.com'});assert.match(xml,/glowglps\.com\/coa\.html/);assert.equal((xml.match(/store-next\/p\/tx-bpc/g)||[]).length,1);assert.match(xml,/store-next\/p\/bac-water/);
 // The real server: /store-next/p/<slug> is the store page with the product's own title; affiliates still work.
 const server=createServer({apiHandler:async e=>({statusCode:200,headers:{},body:JSON.stringify(e.queryStringParameters.route==='/catalog'?{products}:{})})});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const page=await (await fetch(base+'/store-next/p/tx-bpc')).text();assert.match(page,/id="app"/);assert.match(page,/<title>BPC-157 · 10 mg, 20 mg · Glow Lab Protocols<\/title>/);assert.match(page,/rel="manifest"/,'the app works from a product page too');
 assert.match(await (await fetch(base+'/store-next/sample')).text(),/id="app"/);assert.equal((await fetch(base+'/store-next/p/Bad_Slug')).status,404);
 const sm=await fetch(base+'/sitemap.xml');assert.equal(sm.status,200);assert.match(await sm.text(),/store-next\/p\/tx-bpc/);
});

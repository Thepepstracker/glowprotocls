'use strict';
// Black Friday 2026 (Jonah + Heather, 22 Nov 2026): one switch; catalog prices fixed, everything else 30% off, no stacking,
// subscribe 40% off the first box only, scheduled start, and OFF restores every price exactly.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-bf-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'black-friday-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),bf=require('../../netlify/functions/lib/black-friday.cjs'),subs=require('../../netlify/functions/lib/subscriptions.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
let owner;const P=id=>transaction(s=>s.get('products',id));
test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await transaction(async s=>{const put=(id,x)=>s.put('products',id,{id,brand:'glow',active:1,stock:20,...x});
  await put(9001,{sku:'tirz-10-15-mg-x',name:'GLP-2T · 15 mg',price:6800});await put(10,{sku:'tirz-10-15-mg',name:'GLP-2T · 15 mg',price:6800});
  await put(131,{sku:'glow-70-mg',name:'GLOW · 70 mg',price:10299});await put(155,{sku:'epithalon-10-mg',name:'Epithalon · 10 mg',price:3499});await put(301,{sku:'dsip-nasal-10-mg',name:'DSIP Nasal Spray · 10 mg',price:5999});
  await put(7,{sku:'nad-500-mg',name:'NAD+ · 500 mg',price:2500,promo_excluded:true});await put(4,{sku:'bac-water-3-ml',name:'BAC Water · 3 mL',price:499});
  await put(9100,{sku:'bf-the-bell-ringer-duo',name:'The Bell Ringer Duo',price:7199,active:0});await put(9101,{sku:'bf-mini-protocol-01',name:'Protocol 01 mini',price:0,active:0});
  await put(9200,{sku:'zdr-x',name:'Zader thing',price:5000,brand:'zader'})})});
test('the six catalog checks: 30% off rounded to the whole dollar',()=>{for(const [c,w] of [[10299,7200],[3499,2400],[6499,4500],[8200,5700],[5999,4200],[4399,3100]])assert.equal(bf.pct30(c),w)});
test('ON: catalog prices, 30% off the rest, catalog-only products shown, minis and other stores untouched; OFF restores all',async()=>{
 const before=await transaction(async s=>Object.fromEntries((await s.list('products')).map(p=>[p.id,JSON.stringify(p)])));
 await assert.rejects(call('/admin/black-friday',{on:true,confirm:'yes'},owner),/START BLACK FRIDAY/);
 const r=(await call('/admin/black-friday',{on:true,confirm:'START BLACK FRIDAY'},owner)).body;assert.equal(r.on,true);
 const g15=await P(10);assert.deepEqual([g15.price,g15.regular_price,g15.intro_active,g15.black_friday,g15.promo_excluded],[4400,6800,true,'fixed',true]);
 const glow=await P(131);assert.deepEqual([glow.price,glow.regular_price,glow.intro_active,glow.black_friday],[7200,10299,true,'pct']);
 const nad=await P(7);assert.deepEqual([nad.price,nad.intro_active,nad.black_friday],[2500,false,'fixed']);const bac=await P(4);assert.deepEqual([bac.price,bac.regular_price,bac.intro_active],[300,300,false]);
 const bell=await P(9100);assert.deepEqual([bell.active,bell.price,bell.regular_price],[1,4300,7199]);
 assert.equal((await P(9101)).active,0,'minis stay hidden parts');assert.equal((await P(9200)).price,5000,'Zader unchanged');
 // Catalog shows it; a code / points can't touch catalog prices.
 const cat=(await call('/catalog')).body;assert.equal(cat.settings.black_friday.on,true);assert.ok(cat.products.some(p=>p.id===9100));
 const q=(await call('/quote',{items:[{id:10,quantity:1}]})).body;assert.equal(q.subtotal,4400);assert.equal(q.items[0].promo_excluded,true);assert.equal(q.items[0].bf_fixed,true);
 // Subscribe & save: first box 40% off regular on 30% items, catalog items no discount, renewal normal.
 const m=await transaction(s=>subs.productsOf(s)),st={black_friday:{on:true}};
 assert.equal(subs.priceFor([{id:131,quantity:1}],m,null,1,{settings:st}).price_cents,Math.floor(10299*0.6));
 assert.equal(subs.priceFor([{id:131,quantity:1}],m,null,2,{settings:st}).price_cents,7200,'renewal: better of sale price or 15% off');
 assert.equal(subs.priceFor([{id:10,quantity:1}],m,null,1,{settings:st}).price_cents,4400,'catalog item: no subscribe discount');
 assert.equal(subs.priceFor([{id:7,quantity:1}],m,null,1,{settings:st}).price_cents,2500);
 const off=(await call('/admin/black-friday',{on:false,confirm:'END BLACK FRIDAY'},owner)).body;assert.equal(off.on,false);
 const now=await transaction(async s=>Object.fromEntries((await s.list('products')).map(p=>[p.id,p])));
 for(const [id,was] of Object.entries(before)){const a=JSON.parse(was),b=now[id];for(const k of ['price','regular_price','intro_price','intro_active','promo_excluded','active','black_friday'])assert.deepEqual(b[k],a[k],id+' '+k)}
 assert.equal(subs.priceFor([{id:131,quantity:1}],await transaction(s=>subs.productsOf(s)),null,1,{settings:{}}).price_cents,Math.floor(10299*0.85),'after the sale: 15% off');
});
test('scheduled start at 12 AM and end time happen by themselves on the next store visit',async()=>{
 const t=Math.floor(Date.now()/1000);await call('/admin/black-friday',{start_at:t-5,end_at:t+3600},owner);
 await transaction(async s=>{const st=await s.get('settings','main');st.black_friday.ended=undefined;await s.put('settings','main',st)});
 const cat=(await call('/catalog')).body;assert.equal(cat.settings.black_friday.on,true);assert.equal((await P(131)).price,7200);
 await transaction(async s=>{const st=await s.get('settings','main');st.black_friday.end_at=t-1;await s.put('settings','main',st)});
 assert.equal((await call('/catalog')).body.settings.black_friday.on,false);assert.equal((await P(131)).price,10299);
});

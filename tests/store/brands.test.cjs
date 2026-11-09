'use strict';
// Several brands in one store: Glow Lab (glowglps.com), Zader Health (zaderhealth.com), Pep Puppy (peppuppy.com).
const{test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-brand-test-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='test-password-123';process.env.STORE_SESSION_SECRET='test-session-secret-at-least-thirty-two-characters';process.env.STORE_ORIGIN='https://glowglps.com';
const{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),brands=require('../../netlify/functions/lib/brands.cjs');
let cookie;
const ZADER={host:'zaderhealth.com'},PUP={host:'peppuppy.com'},GLOW={host:'glowglps.com'};
const call=(p,b,h={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...h},body:b||{}});
const admin=(p,b,h={})=>call(p,b,{cookie,...h});
const customer={name:'Brand Test',email:'brand@example.com',phone:'2025550101',address:'1 Test Street',city:'Example',state:'GA',zip:'30107'};
const orderBody=(items,extra={})=>({items,payment_method:'zelle',idempotency_key:crypto.randomUUID(),customer,...extra});
before(async()=>{await transaction(seed);const r=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});cookie=r.headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('brand comes from the visited domain; unknown hosts stay Glow',()=>{
 assert.equal(brands.fromHeaders({host:'zaderhealth.com'}).id,'zader');
 assert.equal(brands.fromHeaders({host:'www.zaderhealth.com:443'}).id,'zader');
 assert.equal(brands.fromHeaders({'x-forwarded-host':'peppuppy.com',host:'x.netlify.app'}).id,'peppuppy');
 assert.equal(brands.fromHeaders({host:'singular-kitsune-cbf7f7.netlify.app'}).id,'glow');
 assert.equal(brands.fromHeaders({}).id,'glow');
 assert.equal(brands.fromHeaders({host:'zader.localhost'}).id,'zader','local preview host only with STORE_LOCAL');
});

test('Glow catalog is unchanged until Zader is visited; Zader catalog is created once and shares stock with Glow',async()=>{
 const glowBefore=(await call('/catalog',undefined,GLOW)).body;
 assert.equal(glowBefore.brand.id,'glow');assert.ok(glowBefore.products.every(p=>brands.productBrand(p)==='glow'));
 const z=(await call('/catalog',undefined,ZADER)).body;
 assert.equal(z.brand.name,'Zader Health');assert.equal(z.brand.rewards,true,'Zader has the same accounts and points as Glow');
 assert.ok(z.products.length>=30);assert.ok(z.products.every(p=>p.brand==='zader'&&p.sku.startsWith('zdr-')));
 const again=(await call('/catalog',undefined,ZADER)).body;assert.equal(again.products.length,z.products.length,'migration is idempotent');
 const glowAfter=(await call('/catalog',undefined,GLOW)).body;assert.equal(glowAfter.products.length,glowBefore.products.length,'Zader rows never show on Glow');
 const d=(await admin('/admin/data')).body;
 const twin=d.products.find(p=>p.sku==='zdr-nad-500-mg'),glow=d.products.find(p=>p.sku==='nad-500-mg');
 assert.ok(twin&&glow);assert.equal(twin.stock_pool,glow.stock_pool);assert.ok(glow.stock_pool);assert.equal(twin.stock,glow.stock);assert.equal(twin.price,6999);
});

test('carts cannot mix brands; coupons belong to one brand',async()=>{
 const d=(await admin('/admin/data')).body;const zp=d.products.find(p=>p.sku==='zdr-nad-500-mg'),gp=d.products.find(p=>p.sku==='nad-500-mg');
 await assert.rejects(call('/quote',{items:[{id:zp.id,quantity:1}]},GLOW),/unavailable/);
 await assert.rejects(call('/quote',{items:[{id:gp.id,quantity:1}]},ZADER),/unavailable/);
 await assert.rejects(call('/quote',{items:[{id:zp.id,quantity:1}],coupon:'DEMO20'},ZADER),/Coupon/);
 await admin('/admin/coupon',{code:'ZADER10',kind:'percent',value:10,brand:'zader'});
 const q=(await call('/quote',{items:[{id:zp.id,quantity:1}],coupon:'ZADER10'},ZADER)).body;assert.equal(q.coupon_discount,699);assert.equal(q.brand,'zader');assert.equal(q.points_to_earn,Math.floor((q.subtotal-q.discount)/100),'1 point per whole $1 after discounts, same as Glow');
 await assert.rejects(call('/quote',{items:[{id:gp.id,quantity:1}],coupon:'ZADER10'},GLOW),/Coupon/);
 await assert.rejects(call('/quote',{items:[{id:zp.id,quantity:1}],affiliate:'sarah'},ZADER),/Affiliate/);
 await assert.rejects(admin('/admin/coupon',{code:'BAD',kind:'percent',value:10,brand:'nope'}),/brand/);
});

test('a Zader order uses ZDR-, takes stock from the shared count, earns points like Glow',async()=>{
 const d=(await admin('/admin/data')).body;const zp=d.products.find(p=>p.sku==='zdr-nad-500-mg'),gp=d.products.find(p=>p.sku==='nad-500-mg');const before=gp.stock;
 const r=(await call('/orders',orderBody([{id:zp.id,quantity:2}]),ZADER)).body;
 assert.match(r.order.id,/^ZDR-[0-9A-F]{10}$/);assert.equal(r.order.brand,'zader');assert.ok(r.order.points_to_earn>0,'Zader orders earn points like Glow');
 const after=(await admin('/admin/data')).body;
 assert.equal(after.products.find(p=>p.id===gp.id).stock,before-2,'Glow count drops when Zader sells');
 assert.equal(after.products.find(p=>p.id===zp.id).stock,before-2);
 await admin('/admin/status',{id:r.order.id,status:'canceled'});
 assert.equal((await admin('/admin/data')).body.products.find(p=>p.id===gp.id).stock,before,'cancel returns it to both');
 const g=(await call('/orders',orderBody([{id:gp.id,quantity:1}]),GLOW)).body;assert.match(g.order.id,/^GLP-/);assert.equal(g.order.brand,'glow');
});

test('Pep Puppy is waitlist only: no orders',async()=>{
 const c=(await call('/catalog',undefined,PUP)).body;assert.equal(c.brand.waitlist,true);assert.equal(c.settings.checkout_enabled,false);assert.equal(c.products.length,0);
 await assert.rejects(call('/orders',orderBody([{id:1,quantity:1}]),PUP),/waitlist/);
});

test('every brand domain passes the same-site origin check',async()=>{
 for(const origin of ['https://glowglps.com','https://www.glowglps.com','https://zaderhealth.com','https://peppuppy.com'])
  await call('/quote',{items:[{id:1,quantity:1}]},{origin,host:new URL(origin).hostname}).catch(e=>{if(/Cross-origin/.test(e.message))throw e});
 await assert.rejects(call('/quote',{items:[{id:1,quantity:1}]},{origin:'https://evil.example'}),/Cross-origin/);
});

test('products saved in Management keep or set their brand',async()=>{
 const d=(await admin('/admin/data')).body;const zp=d.products.find(p=>p.sku==='zdr-kpv-10-mg');
 await admin('/admin/product',{...zp,price:4500});
 const saved=(await admin('/admin/data')).body.products.find(p=>p.id===zp.id);assert.equal(saved.brand,'zader');assert.equal(saved.price,4500);
 const g=(await admin('/admin/data')).body.products.find(p=>p.sku==='kpv-10-mg');await admin('/admin/product',{...g});
 assert.equal((await admin('/admin/data')).body.products.find(p=>p.id===g.id).brand,'glow');
});

test('each Zader product gets its own label photo once; a photo changed in Management is kept',async()=>{
 const V1=new Set(brands.ZADER_CATALOG.map(r=>r[4]||'zdr-'+r[1]));const d=(await admin('/admin/data')).body;const z=d.products.filter(p=>p.brand==='zader'&&V1.has(p.sku));
 assert.ok(z.length>=40);assert.ok(z.every(p=>p.image==='/img/zader/products/'+p.sku+'.jpg'),'fresh catalog uses per-product photos');
 for(const p of z)assert.ok(fs.existsSync(path.join(__dirname,'../..',p.image)),'photo file exists: '+p.image);
 // simulate a store that got the catalog before photos existed
 await transaction(async s=>{for(const p of z){p.image='/img/zader/zader-vial.jpg';await s.put('products',p.id,p)}const kpv=z.find(p=>p.sku==='zdr-kpv-10-mg');kpv.image='/img/custom.jpg';await s.put('products',kpv.id,kpv);await s.remove('migrations','zader-photos-v1')});
 await call('/catalog',undefined,ZADER);
 const after=(await admin('/admin/data')).body.products.filter(p=>p.brand==='zader'&&V1.has(p.sku));
 assert.equal(after.find(p=>p.sku==='zdr-kpv-10-mg').image,'/img/custom.jpg');
 assert.equal(after.find(p=>p.sku==='zdr-nad-500-mg').image,'/img/zader/products/zdr-nad-500-mg.jpg');
 assert.equal(after.filter(p=>p.image.startsWith('/img/zader/products/')).length,after.length-1);
});

test('everything Glow sells, Zader sells too: one Zader version of each Glow product and kit, Zader prices, same shelf (8 Nov 2026)',async()=>{
 // a Glow kit added after Zader's catalog was made (the live store has 100 kits); the copy step must pick it up once
 await transaction(async s=>{const all=await s.list('products');const v=all.find(p=>(p.brand||'glow')==='glow'&&p.sku==='bpc-157-10-mg');if(!v.stock_pool){v.stock_pool='shared-bpc-157-10-mg';await s.put('products',v.id,v)}
  await s.put('products',Math.max(...all.map(p=>p.id))+1,{id:Math.max(...all.map(p=>p.id))+1,brand:'glow',name:'BPC-157 · 10 mg · Kit of 10',sku:'bpc-157-10-mg-kit',price:29999,regular_price:29999,stock:v.stock,stock_pool:v.stock_pool,units:10,active:1});
  await s.remove('migrations','zader-catalog-v2')});
 await call('/catalog',undefined,ZADER);
 const all=(await admin('/admin/data')).body.products,glow=all.filter(p=>(p.brand||'glow')==='glow'),zader=all.filter(p=>p.brand==='zader');
 const twinOf=new Map(zader.filter(p=>p.twin_of).map(p=>[p.twin_of,p]));
 const expected=glow.filter(p=>!brands.ZADER_SKIP.test(String(p.sku).toLowerCase())&&!(Array.isArray(p.components)&&p.components.length));
 assert.ok(expected.length>0);
 for(const g of expected){const z=twinOf.get(String(g.sku).toLowerCase());assert.ok(z,'Zader version of '+g.sku);
  assert.equal(z.stock_pool,g.stock_pool,'same stock group for '+g.sku);assert.ok(z.stock_pool);assert.equal(z.stock,g.stock);
  assert.equal(brands.units(z),brands.units(g),'same kit size for '+g.sku);assert.equal(!!z.active,!!g.active)}
 const v1=new Set(brands.ZADER_CATALOG.map(r=>r[1]).filter(Boolean));
 for(const z of zader.filter(p=>p.twin_of&&!v1.has(p.twin_of))){const g=glow.find(p=>String(p.sku).toLowerCase()===z.twin_of);assert.equal(z.price,brands.zaderPrice(g.regular_price||g.price));assert.match(String(z.price),/99$/)}
 assert.ok(!zader.some(p=>/^zdr-(merch-|magnet-|protocol-0|glow-eyes|rose-recovery|cu-hair|glow-fuel)/i.test(p.sku)),'Glow-branded goods stay Glow-only');
 assert.equal(new Set(zader.map(p=>p.sku)).size,zader.length,'no duplicate SKUs');
 // runs once: a second visit adds nothing
 await call('/catalog',undefined,ZADER);assert.equal((await admin('/admin/data')).body.products.filter(p=>p.brand==='zader').length,zader.length);
 // selling a Zader kit takes from the shared shelf
 const kit=zader.find(p=>p.sku==='zdr-bpc-157-10-mg-kit');assert.ok(kit,'kit copied');assert.equal(kit.price,brands.zaderPrice(29999));assert.equal(kit.image,'/img/zader/products/zdr-bpc-157-10-mg.jpg','kit shows the Zader vial photo');
 await transaction(async s=>{const all=await s.list('products');for(const p of all.filter(p=>p.stock_pool===kit.stock_pool)){p.stock=50;await s.put('products',p.id,p)}});kit.stock=50;
 {const before=kit.stock;const r=(await call('/orders',orderBody([{id:kit.id,quantity:1}]),ZADER)).body;assert.ok(r.order);
  const g=(await admin('/admin/data')).body.products.find(p=>(p.brand||'glow')==='glow'&&p.stock_pool===kit.stock_pool);assert.equal(g.stock,before-brands.units(kit))}
});

'use strict';
// Veterans Day subscription gifts (Jonah, 10 Nov 2026): new subscriptions only, 11 Nov Eastern. First box after the 15%
// (before shipping): $125+ GLP-2T 20 mg, $250+ 2 Mito-31 + a Glow tote they pick (11 Nov: the new merch totes), $400+ AICAR 50 mg, $600+ a Kit of 10 up to $400.
// They stack, they are $0 lines that take stock, and they never change the price, Stripe's one "Glow Lab" line, or repeat boxes.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-vd-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'vd-owner-test-password',STORE_SESSION_SECRET:'veterans-day-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787',STRIPE_SECRET_KEY:'sk_test_NotARealKey123456'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),vd=require('../../netlify/functions/lib/veterans-day.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const ok=d=>({ok:true,status:200,json:async()=>d}),stripe=[];let n=0;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url);if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');const p=u.slice(25),body=new URLSearchParams(opts.body||'');stripe.push({p,body,raw:String(opts.body||'')});
 if(p==='/customers')return ok({id:'cus_vd'});if(p==='/checkout/sessions'){n++;return ok({id:'cs_vd_'+n,url:'https://checkout.stripe.com/c/pay/cs_vd_'+n,expires_at:Math.floor(Date.now()/1000)+86400})}throw new Error('unmocked '+p)};
const real={...vd.WINDOW};after(()=>{global.fetch=oldFetch;Object.assign(vd.WINDOW,real);fs.rmSync(tmp,{recursive:true,force:true})});
const prod=(id,name,price,stock,x={})=>({id,brand:'glow',sku:'vd-'+id,name,price,stock,active:1,...x});
const shipTo=email=>({name:'Val Vet',email,phone:'4045550123',address:'12 Flag St',city:'Ball Ground',state:'GA',zip:'30107'});
let cookie;const email='val@example.test';
async function setup(){await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}});
 for(const p of [prod(11,'GLP-2T · 20 mg',7800,44),prod(28,'Mito-31 · 10 mg',4299,38),prod(24,'AICAR · 50 mg',5200,35),prod(501,'Filler A',6500,200),prod(502,'Filler B',5000,200),
  prod(601,'BPC-157 Kit of 10',35000,50,{units:10}),prod(602,'Big Kit of 10',45000,50,{units:10}),prod(603,'Empty Kit of 10',30000,5,{units:10})])await s.put('products',p.id,p);
 const rec={tasks:{subscriptions:{on:true}}};await s.put('integrations','autopilot',rec);
 const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await s.put('customers',id,{id,email,name:'Val Vet',created:1,verified:true,auth_version:1,password:null});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:Math.floor(Date.now()/1000)+86400});cookie='glow_next_customer='+token})}
const stock=id=>transaction(s=>s.get('products',id)).then(p=>p.stock);
const open=()=>{vd.WINDOW.start=Math.floor(Date.now()/1000)-60;vd.WINDOW.end=Math.floor(Date.now()/1000)+3600},close=()=>Object.assign(vd.WINDOW,{start:1,end:2});

test('the window is 11 Nov 2026, midnight to midnight Eastern, Glow only',()=>{
 assert.equal(real.start,Date.parse('2026-11-11T05:00:00Z')/1000);assert.equal(real.end,Date.parse('2026-11-12T05:00:00Z')/1000);
 assert.equal(vd.isOpen('glow',real.start),true);assert.equal(vd.isOpen('glow',real.end-1),true);assert.equal(vd.isOpen('glow',real.end),false);assert.equal(vd.isOpen('glow',real.start-1),false);assert.equal(vd.isOpen('zader',real.start),false);
 assert.deepEqual(vd.TIERS.map(t=>t.min),[12500,25000,40000,60000]);assert.equal(vd.KIT_CAP_CENTS,40000);
});

test('the bag shows the ladder: unlocked tiers, how far to the next, and only in-stock kits up to $400',async()=>{
 await setup();open();
 let q=(await call('/subscribe/quote',{items:[{id:501,quantity:1},{id:502,quantity:1}]},cookie)).body; // list $115 → $97.75
 assert.equal(q.veterans.base_cents,9775);assert.equal(q.veterans.unlocked,0);assert.equal(q.veterans.next.id,'vd125');assert.equal(q.veterans.next.need_cents,12500-9775);
 assert.deepEqual(q.veterans.tiers[0].gifts.map(g=>g.name),['GLP-2T 20 mg']);assert.deepEqual(q.veterans.tiers[1].gifts.map(g=>[g.name,g.quantity]),[['Mito-31 10 mg',2]]);
 assert.deepEqual(q.veterans.kits.map(k=>k.id),[601],'over $400 and sold-out kits are not offered');
 q=(await call('/subscribe/quote',{items:[{id:501,quantity:5}]},cookie)).body; // $325 → $276.25
 assert.equal(q.veterans.unlocked,2);assert.equal(q.veterans.next.id,'vd400');
 q=(await call('/subscribe/quote',{items:[{id:501,quantity:12}]},cookie)).body; // $780 → $663, 12 slots (Tier 5 holds 12 now)
 assert.equal(q.ok,true);assert.equal(q.tier.id,'T5');assert.equal(q.veterans.unlocked,4);assert.equal(q.veterans.next,null);
 close();q=(await call('/subscribe/quote',{items:[{id:501,quantity:12}]},cookie)).body;assert.equal(q.veterans,null,'gone after the day');
});

test('$600+ box: all four gifts stack at $0, take stock, need a tote and a kit; price, Stripe and repeat boxes unchanged',async()=>{
 open();const items=[{id:501,quantity:12}],base={items,every:'1m',customer:shipTo(email),agree:true};
 await call('/catalog'); // the store adds the new merch collection on its first catalog load (as on the live site)
 const v=(await call('/subscribe/quote',{items},cookie)).body.veterans;assert.equal(v.totes.length,7,'the 7 new Glow totes');const tote=v.totes.find(t=>/Peptide Pioneer/.test(t.name));assert.ok(tote&&/collection-2026-11/.test(tote.image));
 await assert.rejects(call('/account/subscribe',{...base,idempotency_key:'vd-key-0001',gift_kit_id:601},cookie),/tote/);
 await assert.rejects(call('/account/subscribe',{...base,idempotency_key:'vd-key-0002',gift_bag:tote.id},cookie),/Kit of 10/);
 await assert.rejects(call('/account/subscribe',{...base,idempotency_key:'vd-key-0003',gift_bag:tote.id,gift_kit_id:602},cookie),/Kit of 10/,'over the $400 cap');
 await assert.rejects(call('/account/subscribe',{...base,idempotency_key:'vd-key-0004',gift_bag:'Purple',gift_kit_id:601},cookie),/tote/,'only a real in-stock tote');
 const before={g:await stock(11),m:await stock(28),a:await stock(24),k:await stock(601),f:await stock(501),t:await stock(tote.id)};
 const r=(await call('/account/subscribe',{...base,idempotency_key:'vd-key-0005',gift_bag:tote.id,gift_kit_id:601},cookie)).body;
 const x=await transaction(s=>s.get('subscriptions',r.id)),o=await transaction(s=>s.get('orders',x.first_order));
 assert.equal(o.total,66300,'$780 list at 15% off, free shipping: gifts add nothing');assert.equal(o.subtotal,78000);
 const gifts=o.items.filter(i=>i.gift==='veterans-day');
 assert.deepEqual(gifts.map(g=>[g.id,g.quantity,g.price,g.amount]),[[11,1,0,0],[28,2,0,0],[tote.id,1,0,0],[24,1,0,0],[601,1,0,0]]);
 assert.ok(gifts.every(g=>/FREE Veterans Day gift$/.test(g.name)),'packing and slips say it is free');
 assert.deepEqual(o.veterans_day.tiers,['vd125','vd250','vd400','vd600']);assert.equal(o.veterans_day.bag,tote.name);assert.equal(o.veterans_day.tote_id,tote.id);assert.equal(o.veterans_day.kit_id,601);
 assert.match(o.staff_note,/Peptide Pioneer Tote/);
 assert.deepEqual(x.items.map(i=>i.id),[501],'repeat boxes are only what they subscribed to');assert.equal(x.veterans_day.bag,tote.name);
 assert.deepEqual([await stock(11),await stock(28),await stock(24),await stock(601),await stock(501),await stock(tote.id)],[before.g-1,before.m-2,before.a-1,before.k-10,before.f-12,before.t-1]);
 const cs=stripe.filter(c=>c.p==='/checkout/sessions').at(-1);assert.equal(Number(cs.body.get('line_items[0][price_data][unit_amount]')),66300);assert.equal(cs.body.get('line_items[0][price_data][product_data][name]'),'Glow Lab');
 for(const c of stripe){const t=decodeURIComponent(c.raw.replace(/\+/g,' '));assert(!/glp-2t|mito|aicar|kit of|veteran|gift|tote/i.test(t),'no product or gift names on Stripe: '+t.match(/.{0,40}(glp-2t|mito|aicar|kit of|veteran|gift).{0,40}/i)?.[0])}
});

test('$125 box gets only the first gift and no picks are needed; after the day, no gifts at all',async()=>{
 open();const r=(await call('/account/subscribe',{items:[{id:501,quantity:3}],every:'1m',customer:shipTo(email),agree:true,idempotency_key:'vd-key-0101'},cookie)).body; // $195 → $165.75
 const o=await transaction(async s=>s.get('orders',(await s.get('subscriptions',r.id)).first_order));
 assert.deepEqual(o.items.filter(i=>i.gift).map(i=>i.id),[11]);assert.equal(o.veterans_day.bag,null);
 close();const r2=(await call('/account/subscribe',{items:[{id:502,quantity:3}],every:'1m',customer:shipTo(email),agree:true,idempotency_key:'vd-key-0102'},cookie)).body;
 const o2=await transaction(async s=>s.get('orders',(await s.get('subscriptions',r2.id)).first_order));assert.equal(o2.items.some(i=>i.gift),false);assert.equal(o2.veterans_day,undefined);
});

test('new merch collection: 18 designs, 33 products (shirts S-XL), right prices, 10 each, photos in img/merch/collection-2026-11',async()=>{
 const m=require('../../netlify/functions/lib/merch-catalog.cjs');const cat=(await call('/catalog')).body.products.filter(p=>p.merch_collection==='2026-11');
 assert.equal(new Set(cat.map(p=>p.merch_design)).size,18);assert.equal(cat.length,33);
 const price=k=>[...new Set(cat.filter(p=>p.merch_kind===k).map(p=>p.price))];
 assert.deepEqual(price('tee'),[3200]);assert.deepEqual(price('long-sleeve'),[3800]);assert.deepEqual(price('tote'),[2500]);assert.deepEqual(price('pouch'),[1800]);
 assert.deepEqual([...new Set(cat.filter(p=>p.size).map(p=>p.size))].sort(),['L','M','S','XL']);
 for(const p of m.collectionProducts())assert.ok(fs.existsSync(path.join(__dirname,'../..',p.image)),'photo file exists: '+p.image);
 const again=await transaction(s=>m.ensureCollection202611(s));assert.equal(again,false,'runs once');
});

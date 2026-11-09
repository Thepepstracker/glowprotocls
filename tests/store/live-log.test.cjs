'use strict';
// Live log + deep live analytics (Jonah, 9 Nov 2026): Start live / End live, anonymous "on the site" pings, the full report.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'live-log-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'live-fixture-admin-password',STORE_SESSION_SECRET:'live-fixture-session-secret-long-enough-x',STORE_ORIGIN:'http://127.0.0.1:8787'});
global.fetch=async()=>({ok:true,status:200,json:async()=>({id:'x'})});
// a test clock: each step below moves time forward a little, like a real live
const realNow=Date.now;let shift=0;Date.now=()=>realNow()+shift*1000;const later=(sec=61)=>{shift+=sec};
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});
const cust=(n,state='GA')=>({name:'Buyer '+n+' Test',email:'buyer'+n+'@example.com',phone:'2025550'+String(100+n),address:n+' Example Road',city:'Example',state,zip:'30301'});
// a Zelle order counts once the customer has sent it (the receipt step), like on the Live Show page
const submit=async r=>{await transaction(async s=>{const o=await s.get('orders',r.body.order.id);o.checkout_stage='submitted';o.submitted_at=o.created;await s.put('orders',o.id,o)});return r};
const order=(n,qty=1,extra={},state)=>call('/orders',{items:[{id:1,quantity:qty}],payment_method:'zelle',customer:cust(n,state),idempotency_key:crypto.randomUUID(),...extra}).then(submit);
let owner;const admin=(p,b)=>call(p,b,{cookie:owner});
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{venmo:'https://www.venmo.com/u/glowglps',cashapp:'https://cash.app/$fixture',zelle:'fixture@example.com',paypal:''}});
 await s.put('products',1,{id:1,brand:'glow',sku:'live-1',name:'Live Peptide · 10 mg',price:5000,stock:100,active:1})});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('no live on: pings write nothing; the log is empty; staff only',async()=>{
 assert.deepEqual((await call('/live/ping',{sid:'abcdefgh12'})).body,{live:false});
 assert.equal((await transaction(s=>s.list('live_visitors'))).length,0);
 await assert.rejects(call('/admin/live'),e=>e.status===401);
 const d=(await admin('/admin/live')).body;assert.equal(d.active,null);assert.deepEqual(d.lives,[]);
});

test('a returning customer from before the live',async()=>{await order(1);later(600)});

test('start → people on the site → orders → end → full report',async()=>{
 const st=(await admin('/admin/live/start',{goal_dollars:500})).body.live;later(30);assert.match(st.id,/^LIVE-\d{8}-\d{4}$/);assert.equal(st.goal_cents,50000);
 await assert.rejects(admin('/admin/live/start',{}),e=>e.status===409,'only one live at a time');
 // three shoppers, one from TikTok, one adds to the bag and reaches checkout; a bot is ignored; a bad id is ignored
 for(const [sid,src,extra] of [['aaaaaaaa01','tiktok',{}],['bbbbbbbb02','direct',{bag:true,checkout:true}],['cccccccc03','tiktok',{bag:true}]])assert.deepEqual((await call('/live/ping',{sid,src,...extra})).body,{live:true});
 await call('/live/ping',{sid:'dddddddd04'},{'user-agent':'Googlebot/2.1'});await call('/live/ping',{sid:'x'});
 await call('/live/ping',{sid:'aaaaaaaa01',src:'other'}); // same tab again: still one visitor, source kept
 const live=(await admin('/admin/live')).body;assert.equal(live.active.id,st.id);assert.equal(live.active.online_now,3);
 await order(1,2);later();await order(2,1,{},'FL');later(400);await order(3,3,{},'TX');later();await order(2,1,{},'FL');later();
 const stop=(await admin('/admin/live/stop',{})).body.live;assert.ok(stop.ended_at>=stop.started_at);assert.equal(stop.peak_online,3);
 later(300);await order(4); // after the live: counts as the after-live tail, not in the live
 const r=(await admin('/admin/live/report/'+st.id)).body.report;
 assert.equal(r.orders,4);assert.equal(r.customers.buyers,3);assert.equal(r.customers.new,2,'buyers 2 and 3 are new');assert.equal(r.customers.returning,1,'buyer 1 ordered before the live');
 assert.equal(r.customers.repeat_in_live,1);assert.deepEqual(r.customers.states.map(x=>x[0]).sort(),['FL','GA','TX']);
 assert.equal(r.products.units,7);assert.equal(r.products.top[0].units,7);assert.equal(r.products.top[0].stock_now,100-9,'shelf now: 1 before + 7 in the live + 1 after');
 assert.equal(r.site.visitors,3);assert.equal(r.site.peak_online,3);assert.equal(r.site.added_to_bag,2);assert.equal(r.site.started_checkout,1);assert.deepEqual(r.site.sources[0],['tiktok',2]);
 assert.equal(r.money.sales_cents,r.money.paid_cents+r.money.waiting_cents);assert.equal(r.money.waiting_orders,4);assert.equal(r.money.methods.zelle.orders,4);
 assert.ok(r.timing.timeline.length>=1);assert.equal(r.timing.timeline.reduce((n,x)=>n+x.orders,0),4);assert.equal(r.timing.first_order_after_min,1);
 assert.equal(r.timing.tail.orders,1);assert.equal(r.compare.lives_before,0);assert.equal(r.money.goal_pct,Math.round(r.sales_cents*100/50000));
 // pings after the live write nothing
 const before=(await transaction(s=>s.list('live_visitors'))).length;assert.deepEqual((await call('/live/ping',{sid:'eeeeeeee05'})).body,{live:false});assert.equal((await transaction(s=>s.list('live_visitors'))).length,before);
 // the log
 const log=(await admin('/admin/live')).body;assert.equal(log.active,null);assert.equal(log.lives.length,1);assert.equal(log.lives[0].orders,4);assert.equal(log.lives[0].peak_online,3);
});

test('TikTok numbers, goal, note and fixed times are saved; bad input is refused',async()=>{
 const id=(await admin('/admin/live')).body.lives[0].id;
 await admin('/admin/live/update',{id,tiktok:{viewers:'300',likes:1200,gifts:''},note:'  great   night '});
 let r=(await admin('/admin/live/report/'+id)).body.report;assert.equal(r.tiktok.viewers,300);assert.equal(r.tiktok.likes,1200);assert.equal(r.tiktok.buyers_per_100_viewers,1);
 await assert.rejects(admin('/admin/live/update',{id,tiktok:{viewers:'-4'}}),e=>e.status===400);
 const L=(await transaction(s=>s.get('live_sessions',id)));assert.equal(L.note,'great night');
 await assert.rejects(admin('/admin/live/update',{id,started_at:L.started_at,ended_at:L.started_at-60}),e=>e.status===400,'end before start');
 await assert.rejects(admin('/admin/live/update',{id,started_at:L.started_at,ended_at:L.started_at+9*3600}),e=>e.status===400,'longer than 8 hours');
 await admin('/admin/live/update',{id,started_at:L.started_at-300,goal_dollars:0});
 r=(await admin('/admin/live/report/'+id)).body.report;assert.equal(r.started_at,L.started_at-300);assert.equal(r.goal_cents,0);assert.equal(r.orders,4,'moving the start earlier picks up the same orders');
 await assert.rejects(admin('/admin/live/report/LIVE-20990101-0000'),e=>e.status===404);
});

test('a second live is compared with the first; Zader orders never count',async()=>{
 await transaction(async s=>{const p=await s.get('products',1);await s.put('products',2,{id:2,brand:'zader',sku:'zdr-live-1',name:'Zader Peptide',price:8000,stock:50,active:1})});
 later(3600);const st=(await admin('/admin/live/start',{})).body.live;later(20);
 await order(5);await call('/orders',{items:[{id:2,quantity:1}],payment_method:'zelle',customer:cust(6),idempotency_key:crypto.randomUUID()},{host:'zaderhealth.com'}).then(submit);
 const r=(await admin('/admin/live/report/'+st.id)).body.report;assert.equal(r.running,true);assert.equal(r.orders,1,'only the Glow order');assert.equal(r.compare.lives_before,1);assert.equal(r.compare.last.orders,4);
 await admin('/admin/live/stop',{});
});

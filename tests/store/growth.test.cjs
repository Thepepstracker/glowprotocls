'use strict';
// Growth tools (Jonah, 8 Nov 2026): reorder reminders + one-tap restore, saved bags + bag reminder, verified reviews
// (owner approves before anything shows), unsubscribe, and the anonymous sales funnel.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-growth-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'growth-tests-session-secret-more-than-32ch',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STORE_POSTAL_ADDRESS:'PO Box 1, Canton, GA 30114'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),growth=require('../../netlify/functions/lib/growth.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
const call=(p,b,cookie,extra={})=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{}),...extra},body:b||{}});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts={})=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const DAY=86400,nowS=()=>Math.floor(Date.now()/1000),noon=()=>new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T17:00:00Z').getTime();
const etDay=d=>new Date(Date.now()-d*DAY*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
let P,Q;
async function order(id,extra){const o={id,status:'paid',is_test:false,brand:'glow',created:nowS(),paid:nowS(),total:4999,token_hash:'x',items:[{id:P.id,name:P.name,quantity:2,price:P.price,amount:P.price*2}],customer:{name:'Rae Reorder',email:'rae@example.test',phone:'+14045550111',address:'1 Main',city:'Canton',state:'GA',zip:'30114'},...extra};await transaction(s=>s.put('orders',id,o));return o}
async function account(email,name){const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email,name,verified:true,auth_version:1,created:nowS()});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:nowS()+86400})});return{id,cookie:'glow_next_customer='+token}}

test('setup',async()=>{await transaction(seed);[P,Q]=await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);
 const ps=(await s.list('products')).filter(x=>x.active&&x.price>=2000&&!(x.components||[]).length&&!x.stock_pool&&!x.max_order_quantity).slice(0,2);for(const p of ps){p.stock=20;await s.put('products',p.id,p)}return ps})});

test('reorder reminder: one email ~30 days after the last order, a one-tap link that refills the bag, never twice, never to subscribers or the unsubscribed',async()=>{
 await order('GLP-RE0000001',{created:nowS()-35*DAY});await order('GLP-RE0000002',{created:nowS()-10*DAY,customer:{name:'Fresh',email:'fresh@example.test'}});await order('GLP-RE0000003',{created:nowS()-200*DAY,customer:{name:'Old',email:'old@example.test'}});
 await order('GLP-RE0000004',{created:nowS()-40*DAY,customer:{name:'Sub Scriber',email:'sub@example.test'}});await transaction(s=>s.put('subscriptions','SUB-AAAA0001',{id:'SUB-AAAA0001',status:'active',customer:{email:'sub@example.test'}}));
 sent.length=0;const r=await growth.reorders(25,noon());assert.equal(r.sent,1,'only Rae is due');const m=sent[0];assert.equal(m.to[0],'rae@example.test');assert.match(m.subject,/Ready to restock/);assert.match(m.text,/× 2/);assert.match(m.text,/Subscribe & save/);
 assert.match(m.text,/Unsubscribe from these emails: http:\/\/127\.0\.0\.1:8787\/api\/unsubscribe\//);assert.match(m.text,/PO Box 1, Canton, GA 30114/);assert.match(m.html,/Unsubscribe from these emails/);
 assert.equal((await growth.reorders(25,noon())).sent,0,'never twice');
 const ref=m.text.match(/\?restore=([^#\s]+)#bag/)[1];const back=(await call('/restore',{ref})).body;assert.deepEqual(back.items.map(i=>[i.id,i.quantity]),[[P.id,2]]);
 await assert.rejects(call('/restore',{ref:ref.slice(0,-2)+'xx'}),e=>e.status===404,'tampered link refused');
 // A newer order of any kind means no reminder for the older one.
 await order('GLP-RE0000005',{created:nowS()-50*DAY,customer:{name:'Busy',email:'busy@example.test'}});await order('GLP-RE0000006',{created:nowS()-1*DAY,status:'awaiting_payment',customer:{name:'Busy',email:'busy@example.test'}});
 assert.equal((await growth.reorders(25,noon())).sent,0);
});

test('unsubscribe link works without signing in and stops reminder and review emails',async()=>{
 await order('GLP-UN0000001',{created:nowS()-33*DAY,customer:{name:'Una Unsub',email:'una@example.test'}});
 const link=growth.makeRef('unsub',growth.emailKey('una@example.test'),30);const r=await handle({path:'/unsubscribe/'+link,method:'GET',headers:{},body:{}});
 assert.equal(r.status,200);assert.match(Buffer.from(r.body._binary,'base64').toString(),/unsubscribed/);sent.length=0;await growth.reorders(25,noon());assert(!sent.some(m=>m.to[0]==='una@example.test'));
 const badLink=await handle({path:'/unsubscribe/unsub.abcd.1.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',method:'GET',headers:{},body:{}});assert.match(Buffer.from(badLink.body._binary,'base64').toString(),/didn’t work/);
});

test('no postal address: the reminder emails do not send',async()=>{const keep=process.env.STORE_POSTAL_ADDRESS;delete process.env.STORE_POSTAL_ADDRESS;try{assert.equal((await growth.reorders(25,noon())).status,'needs_postal_address');assert.equal((await growth.bags(25,noon())).status,'needs_postal_address');assert.equal((await growth.reviews(25,noon())).status,'needs_postal_address')}finally{process.env.STORE_POSTAL_ADDRESS=keep}});

test('saved bag: signed-in only, comes back on the next visit, one reminder 3–48 hours later unless they ordered',async()=>{
 const A=await account('bea@example.test','Bea Bag');
 assert.equal((await call('/account/bag',{items:[{id:P.id,quantity:1}]})).body.saved,false,'guests are not saved');
 assert.equal((await call('/account/bag',{items:[{id:P.id,quantity:1},{id:Q.id,quantity:3}]},A.cookie)).body.saved,true);
 assert.deepEqual((await call('/account/bag',undefined,A.cookie)).body.items.map(i=>[i.id,i.quantity]),[[P.id,1],[Q.id,3]]);
 const N=Math.floor(noon()/1000),at=async(id,ts)=>transaction(async s=>{const b=await s.get('bags',id);b.updated=ts;await s.put('bags',b.id,b)});
 await at(A.id,N-3600);sent.length=0;assert.equal((await growth.bags(25,noon())).sent,0,'too soon');
 await at(A.id,N-4*3600);
 assert.equal((await growth.bags(25,noon())).sent,1);assert.match(sent[0].subject,/left something in your bag/);assert.match(sent[0].text,/× 3/);assert.equal((await growth.bags(25,noon())).sent,0,'once');
 const ref=sent[0].text.match(/\?restore=([^#\s]+)#bag/)[1];assert.equal((await call('/restore',{ref})).body.items.length,2);
 // Changed the bag, but placed an order since: no reminder.
 const B=await account('ora@example.test','Ora Ordered');await call('/account/bag',{items:[{id:P.id,quantity:1}]},B.cookie);await at(B.id,N-5*3600);
 await order('GLP-BG0000001',{created:N-3600,customer:{name:'Ora',email:'ora@example.test'}});assert.equal((await growth.bags(25,noon())).sent,0);
});

test('account Reorder button: only your own orders',async()=>{const A=await account('rae@example.test','Rae Reorder');
 assert.equal((await call('/account/reorder',{id:'GLP-RE0000001'},A.cookie)).body.items[0].quantity,2);
 await assert.rejects(call('/account/reorder',{id:'GLP-RE0000002'},A.cookie),e=>e.status===404,'someone else’s order');await assert.rejects(call('/account/reorder',{id:'GLP-RE0000001'}),e=>e.status===401)});

test('reviews: asked after delivery, owner approves before anything shows, health words flagged, one per order',async()=>{
 await order('GLP-RV0000001',{status:'shipped',created:nowS()-12*DAY,shipment:{ship_date:etDay(9)},customer:{name:'Vera Viewer',email:'vera@example.test',state:'TX'}});
 await order('GLP-RV0000002',{status:'shipped',created:nowS()-3*DAY,shipment:{ship_date:etDay(2)},customer:{name:'Too Soon',email:'soon@example.test'}});
 await order('GLP-RV0000003',{status:'shipped',created:nowS()-6*DAY,shipment:{ship_date:etDay(5)},delivery:{state:'delivered',delivered_date:etDay(3)},customer:{name:'Del Ivered',email:'del@example.test'}});
 sent.length=0;assert.equal((await growth.reviews(25,noon())).sent,2);assert.equal((await growth.reviews(25,noon())).sent,0,'once');
 const m=sent.find(x=>x.to[0]==='vera@example.test');assert.match(m.subject,/How did we do/);const ref=m.text.match(/\?review=([^\s]+)/)[1];
 const load=(await call('/review/load',{ref})).body;assert.equal(load.first_name,'Vera');assert.equal(load.done,false);
 await assert.rejects(call('/review/submit',{ref,rating:7}),e=>e.status===400);
 sent.length=0;await call('/review/submit',{ref,rating:5,text:'Shipped in 2 days, packed perfectly. Lost 10 lbs!',show_name:true});
 const staff=sent.find(x=>x.to[0]==='jonah@glowglps.com');assert.match(staff.subject,/★★★★★/);assert.match(staff.text,/lost, lbs/);
 await assert.rejects(call('/review/submit',{ref,rating:4}),e=>e.status===409,'one per order');
 assert.equal((await call('/reviews')).body.count,0,'nothing shows until approved');
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await assert.rejects(call('/admin/review',{id:'GLP-RV0000001',action:'approve'}),e=>e.status===401||e.status===403);
 const g=(await call('/admin/growth',{days:7},owner)).body;const rv=g.reviews.find(r=>r.id==='GLP-RV0000001');assert.deepEqual(rv.flags,['lost','lbs']);assert.equal(rv.name,'Vera V.');assert.equal(rv.state,'TX');
 await call('/admin/review',{id:'GLP-RV0000001',action:'approve'},owner);const pub=(await call('/reviews')).body;assert.equal(pub.count,1);assert.equal(pub.average,5);assert.equal(pub.reviews[0].name,'Vera V.');assert(!JSON.stringify(pub).includes('vera@example'),'no emails in public reviews');
 await call('/admin/review',{id:'GLP-RV0000001',action:'hide'},owner);assert.equal((await call('/reviews')).body.count,0);
});

test('sales funnel: anonymous counts by source, bots and junk ignored, orders and revenue by source',async()=>{
 for(const e of ['visit','visit','bag','checkout'])await call('/event',{e,src:'tiktok'});await call('/event',{e:'visit',src:'tiktok'},null,{'user-agent':'Googlebot/2.1'});await call('/event',{e:'hack',src:'tiktok'});await call('/event',{e:'visit',src:'<script>'});
 await order('GLP-FN0000001',{source:'tiktok',total:10000,customer:{name:'T',email:'t@example.test'}});
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];const f=(await call('/admin/growth',{days:7},owner)).body.funnel;
 const t=f.sources.find(x=>x.source==='tiktok');assert.deepEqual([t.visit,t.bag,t.checkout,t.orders,t.paid,t.revenue_cents],[2,1,1,1,1,10000]);assert.equal(f.sources.find(x=>x.source==='direct').visit,1,'a bad source becomes direct');
 assert(f.total.visit>=3);
});

test('Management → Today: month goal (owner only) and the numbers behind the home screen',async()=>{
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await assert.rejects(call('/admin/today'),e=>e.status===401||e.status===403,'signed in only');
 let t=(await call('/admin/today',undefined,owner)).body;assert.equal(t.goal_cents,0);assert(t.funnel.visit>=1);assert.equal(typeof t.subs.mrr_cents,'number');assert.equal(typeof t.reviews_pending,'number');
 await assert.rejects(call('/admin/goal',{cents:-5},owner),e=>e.status===400);
 assert.equal((await call('/admin/goal',{cents:10108300},owner)).body.goal_cents,10108300);t=(await call('/admin/today',undefined,owner)).body;assert.equal(t.goal_cents,10108300);assert.equal(t.month,t.day.slice(0,7));
});

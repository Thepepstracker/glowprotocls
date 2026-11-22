'use strict';
// No points from canceled or expired orders (Jonah, 21 Nov 2026: "make sure that no one can get points from canceled/expired
// orders"). A paid order canceled as a duplicate, or refunded in full, takes back everything it gave: earned points, the
// referral bonus, gift-list thank-you points and the mystery gift. Expired / canceled unpaid orders never earned anything.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-nopoints-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'no-points-tests-session-secret-32-chars',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),unbox=require('../../netlify/functions/lib/unbox.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const oldFetch=global.fetch;global.fetch=async u=>{throw new Error('unexpected fetch '+u)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const N=()=>Math.floor(Date.now()/1000);let owner,P;
const admin=(p,b)=>call(p,b,owner).then(r=>r.body);const get=id=>transaction(s=>s.get('orders',id));
const bal=id=>transaction(s=>accounts.wallet(s,id));const life=id=>transaction(s=>accounts.lifetimePoints(s,id));
const person=(email,name)=>transaction(async s=>{const id=accounts.hash(email);await s.put('customers',id,{id,email,name,verified:true,auth_version:1,created:N()-90*86400});return id});
const order=(id,extra)=>transaction(s=>s.put('orders',id,{id,status:'paid',is_test:false,brand:'glow',created:N()-7200,paid:N()-7000,subtotal:7900,discount:0,shipping:1500,tax:0,total:9400,verified_payment_cents:9400,payment_method:'venmo',items:[{id:P.id,name:P.name,quantity:1,price:7900}],customer:{name:'Ann Buyer',email:'ann@example.test',address:'1 Main',city:'Canton',state:'GA',zip:'30114'},...extra}));
let ann,ref,owner2;
test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 P=await transaction(async s=>{const p=(await s.list('products')).find(p=>p.active&&!(p.components||[]).length&&!(Number(p.units)>1)&&!p.stock_pool);p.stock=10;await s.put('products',p.id,p);return p});
 ann=await person('ann@example.test','Ann Buyer');ref=await person('ref@example.test','Rae Friend');owner2=await person('list@example.test','Lia List');
});

test('a paid order canceled as a duplicate keeps no referral bonus, gift thank-you or mystery gift points',async()=>{
 const id='GLP-00000NOPT01';
 await order(id,{customer_id:ann,referred_by:ref,referral_bonus_awarded:250,gift:{owner_id:owner2,registry_id:'R1',thanks_awarded:79,to_name:'Lia List'},unbox:{prize:40,opened_at:N(),credited_to:ann}});
 await transaction(async s=>{await accounts.event(s,ref,'referral:'+ann,'referral_bonus',250,0,id,'fixture');await accounts.event(s,owner2,'gift-thanks:'+id,'earned',79,0,id,'fixture');await accounts.event(s,ann,'unbox:'+id,'unbox_bonus',40,0,id,'fixture')});
 assert.equal((await bal(ref)).balance,250);assert.equal((await bal(owner2)).balance,79);assert.equal((await bal(ann)).balance,40);
 const r=await admin('/admin/order/cancel-duplicate',{id,confirm:id});assert.equal(r.ok,true);
 const o=await get(id);assert.equal(o.status,'canceled');assert.equal(o.referral_bonus_awarded,0);assert.equal(o.gift.thanks_awarded,0);assert(o.unbox.taken_back);
 assert.equal((await bal(ref)).balance,0,'referral bonus taken back');assert.equal((await bal(owner2)).balance,0,'gift thanks taken back');assert.equal((await bal(ann)).balance,0,'mystery gift taken back');
 assert.equal(await life(ref),0,'and it no longer counts toward a level');
});

test('a full refund takes back the referral bonus, and refunded points stop counting toward a level',async()=>{
 const id='GLP-00000NOPT02',key=crypto.randomBytes(8).toString('hex');
 await order(id,{customer_id:ann,points_earned:79,points_multiplier:1,referred_by:ref,referral_bonus_awarded:250});
 await transaction(async s=>{await accounts.event(s,ann,'earn:'+id,'earned',79,0,id,'fixture');await accounts.event(s,ref,'referral:x'+ann,'referral_bonus',250,0,id,'fixture')});
 const lifeBefore=await life(ann);
 const r=await admin('/admin/order/refund',{id,key,full:true,sent:true,reason:'test'});assert.equal(r.status,'canceled');
 assert.equal((await bal(ref)).balance,0,'referrer keeps nothing');assert.equal((await get(id)).referral_bonus_awarded,0);
 assert.equal(await life(ann),lifeBefore-79,'refunded points no longer count toward her level');
});

test('refunding everything in parts also takes back every earned point',async()=>{
 const id='GLP-00000NOPT03';
 await order(id,{customer_id:ann,points_earned:158,points_multiplier:2});
 await transaction(s=>accounts.event(s,ann,'earn:'+id,'earned',158,0,id,'fixture'));const before=(await bal(ann)).balance;
 await admin('/admin/order/refund',{id,key:crypto.randomBytes(8).toString('hex'),amount_cents:1500,sent:true,reason:'part'});
 await admin('/admin/order/refund',{id,key:crypto.randomBytes(8).toString('hex'),amount_cents:7900,sent:true,reason:'the rest'});
 assert.equal((await get(id)).points_earned,0);assert.equal((await bal(ann)).balance,before-158);
});

test('canceled and expired unpaid orders earn nothing, and their held points go back',async()=>{
 for(const [id,how] of [['GLP-00000NOPT04','cancel'],['GLP-00000NOPT05','expire']]){
  await transaction(async s=>{await accounts.event(s,ann,'gift-'+id,'staff_adjustment',100,0,null,'fixture')});
  await order(id,{status:'awaiting_payment',paid:null,verified_payment_cents:0,customer_id:ann,points_redeemed:100,invoice_sent_at:how==='cancel'?N()-3600:N()-8*86400,expires:how==='cancel'?N()+86400:N()-60,payment_window_days:7});
  await transaction(async s=>{const o=await s.get('orders',id);await accounts.event(s,ann,'reserve:'+id,'reserved',0,100,id,'fixture');await s.put('orders',id,o)});
  const before=await bal(ann);assert.equal(before.reserved,100);
  if(how==='cancel')await admin('/admin/status',{id,status:'canceled'});else await admin('/admin/data');
  const o=await get(id);assert.equal(o.status,how==='cancel'?'canceled':'expired');
  const w=await bal(ann);assert.equal(w.reserved,0,'held points released');assert.equal(w.balance,before.balance,'nothing earned');
  const led=await transaction(s=>s.list('rewards_ledger'));assert(!led.some(e=>e.order_id===id&&e.points>0),'no points credited for '+how);
 }
});

test('a mystery gift held for a guest is never credited once the order is canceled',async()=>{
 const id='GLP-00000NOPT06',guest=await person('guest@example.test','Gus Guest');
 await order(id,{status:'canceled',customer_id:guest,customer:{name:'Gus Guest',email:'guest@example.test'},unbox:{prize:60,opened_at:N(),held:true}});
 assert.equal(await transaction(s=>s.get('customers',guest).then(a=>unbox.claimHeld(s,a))),0);
 assert.equal((await bal(guest)).balance,0);
});

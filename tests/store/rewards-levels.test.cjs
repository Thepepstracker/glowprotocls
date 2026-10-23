'use strict';
// Glow Points levels, double-points windows, signup and referral bonuses (Jonah, 23 Oct 2026).
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-levels-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='levels-test-admin-password';process.env.STORE_SESSION_SECRET='levels-test-session-secret-long-enough';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');let adminCookie;
const call=(p,b,cookie='',ip='fixture')=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie,'x-nf-client-connection-ip':ip},body:b||{}}),admin=(p,b)=>call(p,b,adminCookie);
const password='a secure customer passphrase 2026';
async function customer(email){await call('/account/register',{name:'Test Customer',email},'',email);const id=accounts.hash(email.toLowerCase());const link=(await admin('/admin/customer/setup-link',{customer_id:id})).body;const r=await call('/account/setup',{customer_id:id,token:link.token,password},'',email);return{id,email,cookie:r.headers['Set-Cookie'].split(';')[0]}}
const put=o=>transaction(s=>s.put('orders',o.id,o));
const order=(id,email,cents,extra={})=>({id,is_test:false,brand:'glow',status:'shipped',paid:1790000000,created:1790000000,subtotal:cents,discount:0,total:cents+1500,customer:{name:'Buyer',email},items:[{id:1,quantity:1}],...extra});
const wallet=id=>transaction(s=>accounts.wallet(s,id));
const ledger=id=>transaction(async s=>(await s.list('rewards_ledger')).filter(e=>e.customer_id===id));
const settings=fn=>transaction(async s=>{const st=await s.get('settings','main');fn(st);await s.put('settings','main',st)});
before(async()=>{await transaction(seed);const r=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});adminCookie=r.headers['Set-Cookie'].split(';')[0]});after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('levels: Blue under 500 points earned, Gold from 500, Purple from 1,500',()=>{assert.equal(accounts.tierFor(0).id,'blue');assert.equal(accounts.tierFor(499).id,'blue');assert.equal(accounts.tierFor(500).id,'gold');assert.equal(accounts.tierFor(1499).id,'gold');assert.equal(accounts.tierFor(1500).id,'purple')});

test('a Gold customer earns 1.5x on the next order; the level counts points earned before it, oldest order first',async()=>{const email='gold@example.com';
 await put(order('GLP-LVL0000001',email,30000,{created:1790000000}));await put(order('GLP-LVL0000002',email,25000,{created:1790000100}));await put(order('GLP-LVL0000003',email,10000,{created:1790000200}));
 await put(order('GLP-LVL0000004',email,90000,{created:1790000050,status:'awaiting_payment',paid:0}));
 const a=await customer(email);const o=id=>transaction(s=>s.get('orders',id));
 assert.equal((await o('GLP-LVL0000001')).points_earned,300,'first order: Blue, nothing before it');
 assert.equal((await o('GLP-LVL0000002')).points_earned,250,'300 points before it is still Blue; the unpaid order never counts');
 assert.equal((await o('GLP-LVL0000003')).points_earned,150,'550 points before it: Gold, 100 x 1.5');
 assert.equal((await o('GLP-LVL0000003')).points_multiplier,1.5);
 assert.equal((await wallet(a.id)).balance,700);
 const acct=(await call('/account',undefined,a.cookie)).body;assert.equal(acct.rewards.tier.id,'gold');assert.equal(acct.rewards.points_lifetime,700);assert.equal(acct.rewards.next.id,'purple');assert.equal(acct.rewards.next.needed_points,800)});

test('spending points never lowers the level; bonuses count toward it',async()=>{const a=await customer('spender@example.com');
 await transaction(async s=>{await accounts.event(s,a.id,'test-earn','earned',480,0,null,'fixture');await accounts.event(s,a.id,'test-bonus','referral_bonus',40,0,null,'fixture');await accounts.event(s,a.id,'test-spend','redeemed',-500,0,null,'fixture')});
 assert.equal(await transaction(s=>accounts.lifetimePoints(s,a.id)),520);assert.equal((await wallet(a.id)).balance,20);
 assert.equal((await call('/account',undefined,a.cookie)).body.rewards.tier.id,'gold')});

test('double points: an order placed inside a window earns 2x on top of its level; outside it does not',async()=>{await settings(st=>{st.double_points={windows:[{from:1790100000,until:1790110000}]}});const email='double@example.com';
 await put(order('GLP-DBL0000001',email,10000,{created:1790105000}));await put(order('GLP-DBL0000002',email,10000,{created:1790200000}));const a=await customer(email);
 assert.equal((await transaction(s=>s.get('orders','GLP-DBL0000001'))).points_earned,200);assert.equal((await transaction(s=>s.get('orders','GLP-DBL0000002'))).points_earned,100);
 assert.ok((await ledger(a.id)).some(e=>/double points/.test(e.note)));await settings(st=>{delete st.double_points})});

test('Management switch: double points on until a time, then off; the window stays for later payments',async()=>{const until=Math.floor(Date.now()/1000)+3600;const r=await admin('/admin/double-points',{until});assert.equal(r.status,200);let st=await transaction(s=>s.get('settings','main'));assert.ok(accounts.doubleOn(st,Math.floor(Date.now()/1000)));
 const cat=(await call('/catalog')).body;assert.ok(cat.settings.double_points.windows.some(w=>w.until===until));
 await assert.rejects(admin('/admin/double-points',{until:Math.floor(Date.now()/1000)+30*86400}),/whole number/);
 await admin('/admin/double-points',{on:false});st=await transaction(s=>s.get('settings','main'));assert.ok(!accounts.doubleOn(st,Math.floor(Date.now()/1000)+5));assert.equal(st.double_points.windows.length,1);
 await assert.rejects(call('/admin/double-points',{until},''),/Sign in/);await settings(st=>{delete st.double_points})});

test('signup bonus: off by default; when switched on, 100 points once, only for accounts created from launch',async()=>{const a=await customer('nobonus@example.com');await call('/account',undefined,a.cookie);assert.equal((await wallet(a.id)).balance,0);
 assert.equal((await admin('/admin/rewards-bonuses',{on:true})).status,200);
 const b=await customer('bonus@example.com');await call('/account',undefined,b.cookie);await call('/account',undefined,b.cookie);assert.equal((await wallet(b.id)).balance,100);assert.equal((await ledger(b.id)).filter(e=>e.kind==='signup_bonus').length,1);
 const old=await customer('oldtimer@example.com');await transaction(async s=>{const c=await s.get('customers',old.id);c.created=accounts.BONUS_FROM-10;await s.put('customers',old.id,c);await s.list('rewards_ledger');});
 const w=await wallet(old.id);await call('/account',undefined,old.cookie);assert.equal((await wallet(old.id)).balance,w.balance,'no new bonus on later visits for accounts created before launch');
 await admin('/admin/rewards-bonuses',{on:false})});

test('referral: 200 points to the referrer once, when the friend pays a first order; never for yourself or repeat buyers',async()=>{await admin('/admin/rewards-bonuses',{on:true});const ref=await customer('referrer@example.com');const acct=(await call('/account',undefined,ref.cookie)).body;const code=acct.rewards.referral_code;assert.match(code,/^[0-9a-f]{10}$/);const start=(await wallet(ref.id)).balance;
 const award=o=>transaction(async s=>{const ok=await accounts.referralPaid(s,o);await s.put('orders',o.id,o);return ok});
 const friend=order('GLP-REF0000001','friend@example.com',5000,{referred_by:ref.id,created:1790300000});await put(friend);assert.equal(await award(friend),true);assert.equal(await award(friend),false,'idempotent');
 assert.equal((await wallet(ref.id)).balance,start+200);
 const again=order('GLP-REF0000002','friend@example.com',5000,{referred_by:ref.id,created:1790400000});await put(again);assert.equal(await award(again),false,'second order earns nothing');
 const self=order('GLP-REF0000003','referrer@example.com',5000,{referred_by:ref.id,created:1790500000});await put(self);assert.equal(await award(self),false,'no self-referral');
 await put(order('GLP-REF0000004','regular@example.com',5000,{created:1790000000}));const reg=order('GLP-REF0000005','regular@example.com',5000,{referred_by:ref.id,created:1790600000});await put(reg);assert.equal(await award(reg),false,'existing customers do not count');
 assert.equal((await wallet(ref.id)).balance,start+200);await admin('/admin/rewards-bonuses',{on:false})});

test('checkout stores the referrer from a friend code; unknown codes and your own code are ignored',async()=>{const ref=await customer('codeowner@example.com');const code=(await call('/account',undefined,ref.cookie)).body.rewards.referral_code;
 const saved=await transaction(async s=>{const st=await s.get('settings','main');await s.put('settings','main',{...st,demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{...st.payment_links,zelle:'recipient@example.com'}});const p=await s.get('products',1);p.stock=100;await s.put('products',1,p);return st});process.env.STORE_LIVE_CHECKOUT_ENABLED='1';
 try{const body=(email,friend)=>({items:[{id:1,quantity:1}],coupon:'',affiliate:'',points_redeemed:0,friend,customer:{name:'T',email,phone:'2025550101',address:'1 Road',city:'X',state:'GA',zip:'00000'},payment_method:'zelle',idempotency_key:crypto.randomUUID()});
  const r1=await call('/orders',body('newfriend@example.com',code.toUpperCase()));assert.equal(r1.status,201);assert.equal((await transaction(s=>s.get('orders',r1.body.order.id))).referred_by,ref.id);
  const r2=await call('/orders',body('stranger@example.com','nope000000'));assert.equal((await transaction(s=>s.get('orders',r2.body.order.id))).referred_by,undefined);
  const r3=await call('/orders',body('codeowner@example.com',code));assert.equal((await transaction(s=>s.get('orders',r3.body.order.id))).referred_by,undefined)}
 finally{delete process.env.STORE_LIVE_CHECKOUT_ENABLED;await transaction(s=>s.put('settings','main',saved))}});

test('the checkout quote shows level and double-points earnings for a signed-in customer',async()=>{const email='quote-gold@example.com';await put(order('GLP-QTE0000001',email,60000,{created:1790000000}));const a=await customer(email);
 const q=b=>call('/quote',{items:[{id:1,quantity:1}],coupon:'',affiliate:'',points_redeemed:0},a.cookie).then(r=>r.body);
 const base=await q();assert.equal(base.points_multiplier,1.5);
 await settings(st=>{st.double_points={windows:[{from:1,until:Math.floor(Date.now()/1000)+600}]}});const dbl=await q();assert.equal(dbl.points_multiplier,3);assert.equal(dbl.points_to_earn,Math.floor(Math.floor((dbl.subtotal-dbl.discount)/100)*3));
 await settings(st=>{delete st.double_points})});

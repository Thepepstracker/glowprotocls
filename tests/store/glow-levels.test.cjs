'use strict';
// Glow levels v2 (Jonah, 15 Nov 2026): harder ladder, nobody goes down, level-up moments, birthday gift, checkout hint.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-lv2-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'levels-v2-tests-session-secret-32-chars-plus',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),levels=require('../../netlify/functions/lib/glow-levels.cjs'),autopilot=require('../../netlify/functions/lib/autopilot.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts={})=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const nowS=()=>Math.floor(Date.now()/1000),noon=()=>new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T17:00:00Z').getTime();
const etMonth=()=>Number(new Date().toLocaleDateString('en-US',{timeZone:'America/New_York',month:'numeric'}));
async function account(email,name='Pat Level'){const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email,name,verified:true,auth_version:1,created:nowS()-400*86400});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:nowS()+86400})});return{id,cookie:'glow_next_customer='+token}}
const earn=(id,key,pts,kind='earned')=>transaction(s=>accounts.event(s,id,key,kind,pts,0,null,'fixture'));
const me=c=>call('/account',undefined,c).then(r=>r.body.rewards);
let owner;

test('setup',async()=>{await transaction(seed);await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st)});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});

test('nobody goes down: Gold or Purple reached on the old ladder is kept, and the next goal is the level above it',async()=>{
 const g=await account('old.gold@example.test'),p=await account('old.purple@example.test');
 await earn(g.id,'old-1',600);await earn(p.id,'old-1',1700);
 // The new ladder starts now; everything above was earned before it.
 await transaction(s=>s.put('integrations','levels-v2',{id:'levels-v2',from:nowS()+1}));
 const rg=await me(g.cookie);assert.equal(rg.tier.id,'gold','600 points: Rose on the new ladder, but they keep Gold');assert.equal(rg.kept,'gold');assert.equal(rg.next.id,'purple');assert.equal(rg.next.needed_points,1900);
 const rp=await me(p.cookie);assert.equal(rp.tier.id,'purple');assert.equal(rp.next.id,'diamond');assert.equal(rp.tier.birthday_points,400);
 // Their orders earn at the kept level.
 const e=await transaction(s=>accounts.earnFor(s,g.id,{subtotal:10000,discount:0,created:nowS()}));assert.equal(e.points,150);assert.equal(e.tier,'gold');
});

test('level-up moment: crossing a level records it once, emails them, shows once in the store, and is cleared when seen',async()=>{
 await new Promise(r=>setTimeout(r,1100));const a=await account('climber@example.test','avery climber');sent.length=0;
 await earn(a.id,'o1',250);assert.equal((await me(a.cookie)).level_up,null,'still Blue');
 await earn(a.id,'o2',80);const r=await me(a.cookie);assert.deepEqual(r.level_up,{from:'blue',to:'rose'});assert.equal(r.tier.id,'rose');
 const job=await transaction(s=>s.get('email_outbox','level-up-'+a.id.slice(0,24)+'-rose'));assert(job,'email queued');assert.equal(job.kind,'level_up');
 const {dispatchPending}=require('../../netlify/functions/lib/store-email.cjs');await dispatchPending(10);const m=sent.find(x=>x.to[0]==='climber@example.test');assert.equal(m.subject,'You reached Rose ✨ · Glow Lab');assert.match(m.text,/Hi Avery,/);assert.match(m.text,/1\.25 points per \$1/);assert.match(m.text,/Next up: Gold at 1,000/);
 await call('/account/level/seen',{},a.cookie);assert.equal((await me(a.cookie)).level_up,null,'shown once');
 // Spending points or a birthday gift never makes a level-up; a sign-up bonus counts.
 await earn(a.id,'spend',-200,'redeemed');await earn(a.id,'bday-x',900,'birthday_bonus');assert.equal((await me(a.cookie)).tier.id,'rose','birthday points are a gift, not progress');assert.equal((await me(a.cookie)).points_lifetime,330);
 await earn(a.id,'o3',700,'referral_bonus');assert.equal((await me(a.cookie)).level_up.to,'gold');
 // Skipping a level (Rose → Purple in one big order) celebrates the new one.
 await call('/account/level/seen',{},a.cookie);await earn(a.id,'o4',1600);assert.deepEqual((await me(a.cookie)).level_up,{from:'gold',to:'purple'});
});

test('kept levels do not celebrate again until they really go higher',async()=>{const g=await account('old.gold2@example.test');await transaction(async s=>{await accounts.event(s,g.id,'old',  'earned',700,0,null,'x');const r=await s.get('rewards_ledger',g.id+':old');r.created=1;await s.put('rewards_ledger',r.id,r)});
 assert.equal((await me(g.cookie)).tier.id,'gold');await transaction(async s=>{const a=await s.get('customers',g.id);delete a.level_up;await s.put('customers',g.id,a)});
 await earn(g.id,'n1',400);assert.equal((await me(g.cookie)).level_up,null,'1,100 points: Gold either way, nothing new');
 await earn(g.id,'n2',1500);assert.equal((await me(g.cookie)).level_up.to,'purple');
});

test('birthday: month and day once, the gift by level at the start of the birthday month, once a year, never for a birthday added that month',async()=>{
 const a=await account('bday@example.test','Bea Birthday');await assert.rejects(call('/account/birthday',{month:2,day:30},a.cookie),/Choose your birthday/);await assert.rejects(call('/account/birthday',{month:3,day:4}),e=>e.status===401);
 const m=etMonth();const r=(await call('/account/birthday',{month:m,day:10},a.cookie)).body;assert.equal(r.birthday.month,m);assert.equal(r.birthday.gift_this_year,false,'added during its own month: starts next year');
 await assert.rejects(call('/account/birthday',{month:1,day:1},a.cookie),e=>e.status===409,'set once');
 sent.length=0;assert.equal((await levels.birthdays(25,noon())).sent,0,'no gift for a birthday added this month');
 // Saved last year: gets the gift by level (Rose: 150) and an email, once.
 await earn(a.id,'o1',400);await transaction(async s=>{const c=await s.get('customers',a.id);c.birthday.set_at=nowS()-300*86400;await s.put('customers',a.id,c)});
 const before=(await me(a.cookie)).points_lifetime;assert.equal((await levels.birthdays(25,noon())).sent,1);assert.equal((await levels.birthdays(25,noon())).sent,0,'once a year');
 const w=await transaction(s=>accounts.wallet(s,a.id));assert.equal(w.balance,550);assert.equal((await me(a.cookie)).points_lifetime,before,'does not count toward levels');
 const m2=sent.find(x=>x.to[0]==='bday@example.test');assert.match(m2.subject,/Happy birthday month, Bea/);assert.match(m2.text,/150 Glow Points \(\$7\.50\)/);
 const late=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T03:00:00Z').getTime()+86400000;assert.equal((await levels.birthdays(25,late)).status,'quiet_hours');
 // Staff can fix a birthday; customers can't change it themselves.
 await call('/admin/birthday',{customer_id:a.id,month:5,day:6},owner);assert.equal((await me(a.cookie)).birthday.label,'May 6');
 assert(autopilot.TASKS.birthdays,'Autopilot switch');assert.equal((await autopilot.status()).tasks.find(t=>t.key==='birthdays').on,false,'starts OFF');
});

test('checkout hint: what this order earns, what one level up would earn, and when it levels them up',async()=>{
 const a=await account('hint@example.test');await earn(a.id,'o1',350);
 const p=await transaction(async s=>{const x=(await s.list('products')).find(p=>p.active&&p.price>=5000&&!(p.components||[]).length&&!p.stock_pool&&!p.max_order_quantity);x.stock=50;await s.put('products',x.id,x);return x});
 const q=n=>call('/quote',{items:[{id:p.id,quantity:n}],coupon:'',affiliate:'',points_redeemed:0},a.cookie).then(r=>r.body);
 const one=await q(1),base=Math.floor((one.subtotal-one.discount)/100);assert.equal(one.level_hint.level,'rose');assert.equal(one.level_hint.earn,Math.floor(base*1.25));assert.equal(one.level_hint.next.id,'gold');assert.equal(one.level_hint.next.earn_at_next,Math.floor(base*1.5));assert.equal(one.level_hint.next.needed,650);
 assert.equal(one.level_hint.levels_up,base*1.25>=650);
 const big=await q(10);assert.equal(big.level_hint.levels_up,true,'a big enough order shows "This order takes you to Gold"');
 const guest=(await call('/quote',{items:[{id:p.id,quantity:1}],coupon:'',affiliate:'',points_redeemed:0})).body;assert.equal(guest.level_hint,undefined);assert(guest.points_to_earn>0,'guests see what they would earn');
});

test('Management: counts by level, who is close, VIPs; staff only',async()=>{
 await assert.rejects(call('/admin/levels'),e=>e.status===401||e.status===403);
 const L=(await call('/admin/levels',undefined,owner)).body;assert.deepEqual(L.ladder.map(t=>[t.id,t.min_points,t.multiplier,t.birthday_points]),[['blue',0,1,100],['rose',300,1.25,150],['gold',1000,1.5,250],['purple',2500,2,400],['diamond',6000,2.5,600]]);
 assert(L.counts.purple>=2);assert(L.vips.some(r=>r.email==='old.gold@example.test'&&r.kept));assert(L.close.every(r=>r.next));assert(L.recent.some(r=>r.email==='climber@example.test'));
});

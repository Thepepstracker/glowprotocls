'use strict';
// Skool member perks (Jonah's brief, 5 Nov 2026): master switch OFF by default and owner-only, the member list from the
// Skool CSV export or one email, 30-day listings, VIP picks 4 / Premium picks 2 with a 30-day change rule, member % off
// (better-of with promo codes, never on subscriptions), free shipping on every 2nd qualifying order, 2× points as a max,
// members-only bundles and early access, removal, own-email-only matching, what the order records, Stripe invoice = total.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-skool-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'skool-member-tests-session-secret-32+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STRIPE_SECRET_KEY:'sk_live_fixture0000000000000',STRIPE_WEBHOOK_SECRET:'whsec_fixturesecret'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),core=require('../../netlify/functions/lib/store-core.cjs'),{handle}=core,accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),members=require('../../netlify/functions/lib/skool-members.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookieOf=r=>r.headers['Set-Cookie'].split(';')[0];
const sent=[],stripe=[],invoices={};let n=0;const oldFetch=global.fetch;
global.fetch=async(url,opts={})=>{const u=String(url),ok=d=>({ok:true,status:200,json:async()=>d});
 if(u.includes('resend.com')){sent.push(JSON.parse(opts.body));return ok({id:'em'+sent.length})}
 if(!u.startsWith('https://api.stripe.com/v1'))throw new Error('no network in tests');
 const p=u.slice(25),body=Object.fromEntries(new URLSearchParams(opts.body||'')),idem=opts.headers?.['Idempotency-Key']||'';stripe.push({p,body});
 if(p.startsWith('/customers?'))return ok({data:[]});if(p==='/customers')return ok({id:'cus_1'});
 if(p==='/invoices'&&opts.method==='POST'){const ex=Object.values(invoices).find(i=>i.idem===idem);if(ex)return ok(ex);const id='in_'+(++n);invoices[id]={id,idem,status:'draft',metadata:{order_id:body['metadata[order_id]']},amount_due:0,livemode:true,currency:'usd',items:{}};return ok(invoices[id])}
 if(p==='/invoiceitems'){const inv=invoices[body.invoice];if(!inv.items[idem]){inv.items[idem]=1;inv.amount_due+=Number(body.amount)}return ok({id:'ii_1'})}
 let m=p.match(/^\/invoices\/(in_\d+)\/finalize$/);if(m){Object.assign(invoices[m[1]],{status:'open',hosted_invoice_url:'https://invoice.stripe.com/i/'+m[1]});return ok(invoices[m[1]])}
 m=p.match(/^\/invoices\/(in_\d+)\/(send|void)$/);if(m)return ok(invoices[m[1]]);m=p.match(/^\/invoices\/(in_\d+)$/);if(m)return ok(invoices[m[1]]);
 throw new Error('unmocked Stripe call '+p)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const DAY=86400,now=()=>Math.floor(Date.now()/1000);
// Products: 1 $40 serum, 2 $25 serum, 3 $30 special price (promo codes excluded), 4 members-only bundle $100, 5 early access $50.
const PRODUCTS=[{id:1,brand:'glow',sku:'serum-a',name:'Serum A',price:4000,stock:500,active:1},{id:2,brand:'glow',sku:'serum-b',name:'Serum B',price:2500,stock:500,active:1},{id:3,brand:'glow',sku:'special',name:'Special',price:3000,stock:500,active:1,promo_excluded:true},
 {id:4,brand:'glow',sku:'vip-bundle',name:'Member Bundle',price:10000,stock:50,active:1,members_only:true},{id:5,brand:'glow',sku:'new-drop',name:'New Drop',price:5000,stock:50,active:1,members_early_until:now()+5*DAY}];
let owner,staff;
async function signedIn(email,name='Pat Member',extra={}){const id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');await transaction(async s=>{await s.put('customers',id,{id,email,name,created:1,verified:true,auth_version:1,password:null,...extra});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:now()+86400})});return{id,email,cookie:'glow_next_customer='+token}}
const shipTo=email=>({name:'Pat Member',email,phone:'4045550123',address:'12 Peach St',city:'Ball Ground',state:'GA',zip:'30107'});
const switchOn=on=>call('/admin/members/settings',{enabled:on},owner);
async function listMember(email,level,perks=[],extra={}){const t=now();await transaction(s=>s.put('members',email,{email,name:'',level,source:'manual',since:t-DAY,confirmed_at:t,good_until:t+30*DAY,perks,perks_saved_at:perks.length?t:null,added_by:'owner',...extra}))}
const quote=(items,cookie,extra={})=>call('/quote',{items,...extra},cookie).then(r=>r.body);
let orderN=0;const place=(items,u,extra={})=>call('/orders',{items,customer:shipTo(u.email),payment_method:'venmo',idempotency_key:'k'+(++orderN)+crypto.randomUUID(),...extra},u.cookie).then(r=>r.body.order);
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{venmo:'https://venmo.example/glow',paypal:'',cashapp:'',zelle:''}});for(const p of PRODUCTS)await s.put('products',p.id,p);
  await s.put('coupons','SAVE5',{code:'SAVE5',kind:'fixed',value:500,minimum:0,max_uses:100,used:0,expires:0,active:1,brand:'glow'});await s.put('coupons','BIG30',{code:'BIG30',kind:'percent',value:30,minimum:0,max_uses:100,used:0,expires:0,active:1,brand:'glow'})});
 owner=cookieOf(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 await call('/admin/staff/invite',{email:'packer@example.com',name:'Packer'},owner);const m=sent.at(-1).text.match(/#staff=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})/);
 staff=cookieOf(await call('/staff/setup',{id:m[1],token:m[2],password:'long staff passphrase for testing'}))});

test('switch starts OFF and changes nothing: quote, catalog and account are exactly as before for a listed member',async()=>{
 const st=(await call('/admin/members',undefined,owner)).body;assert.equal(st.settings.enabled,false);assert.deepEqual([st.settings.discount_pct,st.settings.ship_min_vip,st.settings.ship_min_premium],[10,6000,8000]);
 await listMember('off-vip@example.com','vip',['price','ship','points','bundles']);const vip=await signedIn('off-vip@example.com'),plain=await signedIn('off-plain@example.com');
 for(const [items,extra] of [[[{id:1,quantity:2}],{}],[[{id:1,quantity:2},{id:3,quantity:1}],{coupons:['SAVE5']}]]){
  const a=await quote(items,vip.cookie,extra),b=await quote(items,plain.cookie,extra);assert.deepEqual(a,b,'same quote as a non-member');assert.equal(a.member,undefined);assert.equal(a.member_discount,undefined)}
 const cat=(await call('/catalog',undefined,vip.cookie)).body;assert.equal(cat.members_on,undefined);assert.deepEqual(cat.products.map(p=>p.id).filter(id=>id<=5).sort(),[1,2,3,5],'while OFF: members-only bundle hidden from everyone, everything else unchanged');
 for(const c of [vip.cookie,plain.cookie])await assert.rejects(quote([{id:4,quantity:1}],c,{}),e=>e.status===400,'members-only bundle cannot be bought while OFF');
 assert.deepEqual((await call('/account/member',undefined,vip.cookie)).body,{on:false},'account shows nothing member-related');
 await assert.rejects(call('/account/member/perks',{perks:['price']},vip.cookie),e=>e.status===409);
});

test('staff can view the Skool members tab; every change is owner-only (403), like Autopilot',async()=>{
 const v=(await call('/admin/members',undefined,staff)).body;assert.equal(v.owner,false);assert(Array.isArray(v.members));
 for(const [p,b] of [['/admin/members/settings',{enabled:true}],['/admin/members/import-preview',{csv:'email\na@b.co',level:'vip'}],['/admin/members/import',{batch_id:'x'}],['/admin/members/add',{email:'x@example.com',level:'vip'}],['/admin/members/remove',{email:'off-vip@example.com'}],['/admin/members/merch',{email:'off-vip@example.com'}],['/admin/members/invite',{email:'off-vip@example.com'}]])
  await assert.rejects(call(p,b,staff),e=>e.status===403,p);
 await assert.rejects(call('/admin/members'),e=>e.status===401,'signed out');
 assert.equal((await call('/admin/members',undefined,owner)).body.settings.enabled,false,'still OFF');
 // Product flags: owner sets them; staff saving the same product cannot change them.
 const p=PRODUCTS[0],form=x=>({id:p.id,name:p.name,sku:p.sku,price:p.price,stock:500,expected_stock:500,active:1,...x});
 await call('/admin/product',form({members_only:1}),owner);assert.equal((await transaction(s=>s.get('products',1))).members_only,true);
 await assert.rejects(call('/admin/product',form({members_only:0}),staff),e=>e.status===403);
 await call('/admin/product',form({}),staff);assert.equal((await transaction(s=>s.get('products',1))).members_only,true,'staff save without the field keeps it');
 await call('/admin/product',form({members_only:0,members_early_until:0}),owner);const after1=await transaction(s=>s.get('products',1));assert.equal(after1.members_only,undefined);assert.equal(after1.members_early_until,undefined);
 const log=(await call('/admin/data',undefined,owner)).body.audit.map(x=>x.action);assert(!log.includes('members_switch_on'));
});

test('CSV import: lenient headers, level column, dedupe, bad rows skipped; preview changes nothing; commit; re-upload refreshes',async()=>{
 const csv='﻿First Name,Last Name,Email Address,Membership Level,Joined\r\n'+
  'Ann,Lee,ANN@Example.com,VIP Monthly,2026-10-01\r\n'+
  '"Bo, Jr",Park,bo@example.com,Premium,2026-10-02\r\n'+
  ',,,,\r\n'+
  'Cy,Free,cy@example.com,Free,2026-10-03\r\n'+
  'Di,Bad,not-an-email,VIP,2026-10-04\r\n'+
  'Ann,Again,ann@example.com,VIP,2026-10-05\r\n'+
  'Ed,NoMail,,VIP,2026-10-06\r\n';
 const pv=(await call('/admin/members/import-preview',{csv},owner)).body;
 assert.equal(pv.columns.email,'Email Address');assert.equal(pv.columns.level,'Membership Level');assert.equal(pv.columns.name,'First Name + Last Name');
 assert.deepEqual(pv.counts,{new:2,refreshed:0,level_changed:0,skipped:4});assert.deepEqual(pv.rows.map(r=>[r.email,r.level,r.name]),[['ann@example.com','vip','Ann Lee'],['bo@example.com','premium','Bo, Jr Park']]);
 assert.deepEqual(pv.skipped.map(x=>x.reason),['Not VIP or Premium (“Free”)','Not a valid email','Same email again in this file','No email in this row']);assert.deepEqual(pv.skipped.map(x=>x.row),[5,6,7,8],'row numbers as in a spreadsheet');
 assert.equal(await transaction(s=>s.get('members','ann@example.com')),null,'preview changes nothing');
 const done=(await call('/admin/members/import',{batch_id:pv.batch_id},owner)).body;assert.equal(done.new,2);assert.equal(done.view.counts.vip+done.view.counts.premium>=2,true);
 const ann=await transaction(s=>s.get('members','ann@example.com'));assert.equal(ann.level,'vip');assert.equal(ann.source,'csv');assert.equal(ann.good_until-ann.confirmed_at,30*DAY);
 assert.deepEqual((await call('/admin/members/import',{batch_id:pv.batch_id},owner)).body.new,2,'committing the same preview twice adds nothing more');
 // No level column: the owner picks one level for the whole file. Semicolons and an "E-mail" heading also work.
 await assert.rejects(call('/admin/members/import-preview',{csv:'Name;E-mail\nAnn;ann@example.com\n'},owner),e=>e.status===400&&/no level column/.test(e.message));
 await transaction(async s=>{const m=await s.get('members','ann@example.com');m.confirmed_at-=10*DAY;m.good_until-=10*DAY;m.perks=['price','ship','points','early'];m.perks_saved_at=now()-DAY;await s.put('members',m.email,m)});
 const pv2=(await call('/admin/members/import-preview',{csv:'Name;E-mail\nAnn;ann@example.com\nBo;bo@example.com\nNew Person;new@example.com\n',level:'premium'},owner)).body;
 assert.deepEqual(pv2.counts,{new:1,refreshed:1,level_changed:1,skipped:0});assert.equal(pv2.rows[0].old_level,'vip');
 await call('/admin/members/import',{batch_id:pv2.batch_id},owner);const ann2=await transaction(s=>s.get('members','ann@example.com'));
 assert.equal(ann2.level,'premium');assert(ann2.good_until>now()+29*DAY,'re-upload refreshes good_until');assert.deepEqual(ann2.perks,['price','ship'],'VIP → Premium keeps the first two perks');assert.equal(ann2.perks_saved_at,null,'and may choose again right away');
 // The real Skool export's columns (5 Nov 2026): Price comes before Tier and must not be read as the level. Free members have no email.
 const skool='FirstName,LastName,Email,Invited By,JoinedDate,Question1,Answer1,Question2,Answer2,Question3,Answer3,Price,Recurring Interval,Tier,LTV\n'+
  'Vi,Pat,vi.skool@example.com,,2026-10-21,Q,A,Q,A,Q,A,$49,month,vip,$49\n'+'Pre,Mia,pre.skool@example.com,,2026-10-01,Q,A,Q,A,Q,A,$100,year,premium,$100\n'+'Fre,Ed,,,2026-11-04,Q,A,Q,A,Q,A,,,standard,$0\n'+'Sta,Lee,sta.skool@example.com,,2026-11-04,Q,A,Q,A,Q,A,0,,standard,$0\n';
 const pvs=(await call('/admin/members/import-preview',{csv:skool},owner)).body;assert.equal(pvs.columns.level,'Tier');assert.equal(pvs.columns.name,'FirstName + LastName');
 assert.deepEqual(pvs.rows.map(r=>[r.email,r.level]),[['vi.skool@example.com','vip'],['pre.skool@example.com','premium']]);assert.deepEqual(pvs.skipped.map(x=>x.reason),['No email in this row','Not VIP or Premium (“standard”)']);
 await assert.rejects(call('/admin/members/import-preview',{csv:'email,level\n'+'x'.repeat(2*1024*1024)+'\n',level:'vip'},owner),e=>e.status===413);
 await assert.rejects(call('/admin/members/import-preview',{csv:'name,phone\nA,1\n',level:'vip'},owner),e=>/email column/.test(e.message));
 const log=(await call('/admin/data',undefined,owner)).body.audit.map(x=>x.action);assert(log.includes('members_csv_imported'));
});

test('switch on; add one member; a listing ends after 30 days unless a new upload includes it',async()=>{
 const on=(await switchOn(true)).body;assert.equal(on.settings.enabled,true);
 await call('/admin/members/add',{email:'Exp@Example.com',level:'premium',name:'Exp Person'},owner);const u=await signedIn('exp@example.com');
 let v=(await call('/account/member',undefined,u.cookie)).body;assert.equal(v.member.level,'premium');assert.equal(v.member.limit,2);
 await transaction(async s=>{const m=await s.get('members','exp@example.com');m.confirmed_at-=31*DAY;m.good_until-=31*DAY;await s.put('members',m.email,m)});
 v=(await call('/account/member',undefined,u.cookie)).body;assert.equal(v.member,null,'expired');assert(v.last_checked);
 await call('/admin/members/add',{email:'exp@example.com',level:'premium'},owner);assert.equal((await call('/account/member',undefined,u.cookie)).body.member.level,'premium','added again: active');
 const log=(await call('/admin/data',undefined,owner)).body.audit.map(x=>x.action);assert(log.includes('members_switch_on'));assert(log.includes('member_added_new'));
});

test('perks: VIP chooses up to 4, Premium up to 2; first save is free, then one change every 30 days (server enforced)',async()=>{
 await listMember('lim-vip@example.com','vip');await listMember('lim-pre@example.com','premium');const vip=await signedIn('lim-vip@example.com'),pre=await signedIn('lim-pre@example.com');
 await assert.rejects(call('/account/member/perks',{perks:['price','ship','points','early','packed']},vip.cookie),e=>e.status===400&&/choose 4 perks/.test(e.message));
 await assert.rejects(call('/account/member/perks',{perks:['price','nope']},vip.cookie),e=>e.status===400);
 await assert.rejects(call('/account/member/perks',{perks:['price','price']},vip.cookie),e=>e.status===400);
 const saved=(await call('/account/member/perks',{perks:['points','price','ship','early']},vip.cookie)).body;assert.equal(saved.perks_saved,true);assert.deepEqual(saved.member.perks,['price','ship','points','early']);assert.equal(saved.member.can_change,false);
 await assert.rejects(call('/account/member/perks',{perks:['price','ship','points','packed']},vip.cookie),e=>e.status===409&&/change your perks again on/.test(e.message));
 assert.equal((await call('/account/member/perks',{perks:['price','ship','points','early']},vip.cookie)).body.unchanged,true,'saving the same perks is fine');
 await transaction(async s=>{const m=await s.get('members','lim-vip@example.com');m.perks_saved_at-=31*DAY;await s.put('members',m.email,m)});
 assert.deepEqual((await call('/account/member/perks',{perks:['price','ship','points','packed']},vip.cookie)).body.member.perks,['price','ship','points','packed'],'after 30 days');
 await assert.rejects(call('/account/member/perks',{perks:['price','ship','points']},pre.cookie),e=>e.status===400&&/choose 2 perks/.test(e.message));
 assert.equal((await call('/account/member/perks',{perks:['price','ship']},pre.cookie)).body.member.perks.length,2);
 const v=(await call('/account/member',undefined,pre.cookie)).body;assert.equal(v.perks.length,10);assert.deepEqual(v.perks.map(p=>p.id),members.PERK_IDS);
 const words=JSON.stringify(v.perks);assert.match(words,/\$80/,'Premium sees its own $80 minimum');assert(!/dose|inject|treat|therap|health|cure|heal/i.test(words),'research-use-only wording');
});

test('10% off: coupon-eligible products only, its own quote line; Glow Points still work on top',async()=>{
 await listMember('ten@example.com','vip',['price']);const u=await signedIn('ten@example.com');
 const q=await quote([{id:1,quantity:2},{id:3,quantity:1}],u.cookie);
 assert.equal(q.subtotal,11000);assert.equal(q.member_discount,800,'10% of the $80 eligible, not the $30 special');assert.equal(q.discount,800);assert.equal(q.total,11000-800+1500);assert.equal(q.member.pct,10);assert.equal(q.member.discount,800);assert.equal(q.member_note,undefined);
 assert.deepEqual(Object.keys(q.member).sort(),['discount','free_shipping','level','pct','perks','ship_basis','ship_count','ship_min','shipping_waived']);
 await transaction(s=>s.put('rewards_wallets',u.id,{customer_id:u.id,balance:400,reserved:0}));const pts=await quote([{id:1,quantity:2}],u.cookie,{points_redeemed:200});
 assert.equal(pts.member_discount,800);assert.equal(pts.rewards_discount,1000);assert.equal(pts.total,8000-800-1000+1500,'points on top of the member price');
 await call('/admin/members/settings',{discount_pct:15},owner);assert.equal((await quote([{id:1,quantity:2}],u.cookie)).member_discount,1200,'owner can change the %');await call('/admin/members/settings',{discount_pct:10},owner);
});

test('promo code: the customer gets whichever is bigger (code or member %), never both, and the quote says so',async()=>{
 await listMember('promo@example.com','vip',['price']);const u=await signedIn('promo@example.com');
 const small=await quote([{id:1,quantity:2}],u.cookie,{coupons:['SAVE5']});
 assert.equal(small.member_discount,800);assert.equal(small.coupon_discount,0);assert.deepEqual(small.coupons,[]);assert.equal(small.coupon,null);assert.deepEqual(small.coupons_not_used,['SAVE5']);assert.equal(small.discount,800);assert.match(small.member_note,/saves more than SAVE5/);
 const big=await quote([{id:1,quantity:2}],u.cookie,{coupons:['BIG30']});
 assert.equal(big.member_discount,0);assert.equal(big.coupon_discount,2400);assert.deepEqual(big.coupons,['BIG30']);assert.equal(big.discount,2400);assert.match(big.member_note,/BIG30 saves more than your 10% member discount/);
 const o=await place([{id:1,quantity:2}],u,{coupons:['SAVE5']});assert.equal(o.total,8000-800+1500);assert.equal((await transaction(s=>s.get('coupons','SAVE5'))).used,0,'a code that was not used is not counted as used');
 const o2=await place([{id:1,quantity:2}],u,{coupons:['BIG30']});assert.equal(o2.total,8000-2400+1500);assert.equal((await transaction(s=>s.get('coupons','BIG30'))).used,1);
});

test('subscription orders get no member %, no member free shipping; points stay the higher multiplier',async()=>{
 await listMember('subm@example.com','vip',['price','ship','points']);const u=await signedIn('subm@example.com');
 const sq=await transaction(s=>core.subscriptionQuote(s,{items:[{id:1,quantity:2}],h:{cookie:u.cookie},brand:require('../../netlify/functions/lib/brands.cjs').get('glow'),deliveryNumber:1}));
 assert.equal(sq.ok,true);assert.equal(sq.order.member_discount,0);assert.equal(sq.order.discount,sq.order.subscription_discount,'only the subscription discount');assert.equal(sq.order.member.free_shipping,false);assert.equal(sq.order.member.ship_count,0);
 assert.equal(sq.points_multiplier,Math.max(sq.tier.points_multiplier,2),'max(tier, member 2×), never multiplied');
 const repeat=await transaction(s=>core.subscriptionQuote(s,{items:[{id:1,quantity:2}],h:{},brand:require('../../netlify/functions/lib/brands.cjs').get('glow'),deliveryNumber:2,member_email:'subm@example.com'}));assert.equal(repeat.order.member_discount,0);assert.equal(repeat.order.member.level,'vip');
});

test('free shipping: the 2nd and 4th qualifying orders only; under-minimum orders do not count; $60 VIP vs $80 Premium',async()=>{
 await listMember('ship@example.com','vip',['ship']);const u=await signedIn('ship@example.com');
 const o1=await place([{id:1,quantity:2}],u);assert.deepEqual([o1.shipping,o1.member.ship_count,o1.member.free_shipping],[1500,1,false]);
 const small=await place([{id:1,quantity:1}],u);assert.deepEqual([small.shipping,small.member.ship_count,small.member.free_shipping],[1500,0,false],'$40 is under $60: not counted');
 const q2=await quote([{id:1,quantity:2}],u.cookie);assert.equal(q2.shipping,0);assert.equal(q2.member.ship_count,2);
 const o2=await place([{id:1,quantity:2}],u);assert.deepEqual([o2.shipping,o2.member.ship_count,o2.member.free_shipping,o2.member.shipping_waived],[0,2,true,1500]);assert.equal(o2.total,8000);
 const o3=await place([{id:1,quantity:1},{id:2,quantity:1}],u);assert.deepEqual([o3.shipping,o3.member.ship_count],[1500,3],'$65 counts');
 const o4=await place([{id:1,quantity:2}],u);assert.deepEqual([o4.shipping,o4.member.ship_count,o4.member.free_shipping],[0,4,true]);
 await call('/admin/status',{id:o4.id,status:'canceled'},owner);assert.equal((await transaction(s=>s.get('orders',o4.id))).status,'canceled');assert.equal((await quote([{id:1,quantity:2}],u.cookie)).member.ship_count,4,'a canceled order no longer counts');
 // Premium: $70 does not reach $80; $80 does.
 await listMember('ship-pre@example.com','premium',['ship']);const p=await signedIn('ship-pre@example.com');
 const p1=await place([{id:1,quantity:1},{id:3,quantity:1}],p);assert.deepEqual([p1.member.ship_count,p1.member.ship_min],[0,8000]);
 const p2=await place([{id:1,quantity:2}],p);assert.equal(p2.member.ship_count,1);const p3=await place([{id:1,quantity:2}],p);assert.deepEqual([p3.member.ship_count,p3.shipping],[2,0]);
 // The store's own free shipping over $250 still applies by itself; nothing is "waived" by the perk then.
 await listMember('ship-big@example.com','vip',['ship']);const b=await signedIn('ship-big@example.com');await place([{id:1,quantity:2}],b);const big=await place([{id:1,quantity:7}],b);
 assert.deepEqual([big.shipping,big.member.free_shipping,big.member.shipping_waived],[0,true,0]);
});

test('2× Glow Points: max(level, 2) — never stacked with the level or a subscription tier; double points still applies',async()=>{
 await listMember('pts@example.com','vip',['points']);const u=await signedIn('pts@example.com');
 assert.equal((await quote([{id:1,quantity:2}],u.cookie)).points_multiplier,2,'Blue 1× → 2×');
 await transaction(s=>s.put('rewards_ledger',u.id+':seed-gold',{id:u.id+':seed-gold',customer_id:u.id,kind:'staff_adjustment',points:600,created:1}));assert.equal((await quote([{id:1,quantity:2}],u.cookie)).points_multiplier,2,'Gold 1.5× → 2×');
 await transaction(s=>s.put('rewards_ledger',u.id+':seed-purple',{id:u.id+':seed-purple',customer_id:u.id,kind:'staff_adjustment',points:1000,created:1}));const purple=await quote([{id:1,quantity:2}],u.cookie);assert.equal(purple.points_multiplier,2,'Purple 2× stays 2×, not 4×');
 await transaction(async s=>{const st=await s.get('settings','main');st.double_points={windows:[{from:now()-60,until:now()+600}]};await s.put('settings','main',st)});assert.equal((await quote([{id:1,quantity:2}],u.cookie)).points_multiplier,4,'double points switch still doubles');
 await transaction(async s=>{const st=await s.get('settings','main');delete st.double_points;await s.put('settings','main',st)});
 // At payment: earnFor uses the saved perk. A Blue member earns 2× on $80 = 160, of which 80 came from the perk.
 const blue=await signedIn('pts-blue@example.com');await listMember('pts-blue@example.com','vip',['points']);const o=await place([{id:1,quantity:2}],blue);assert.equal(o.member.points_multiplier,2);
 await call('/admin/status',{id:o.id,status:'paid',verified:true},owner);const paid=await transaction(s=>s.get('orders',o.id));
 assert.equal(paid.status,'paid');assert.equal(paid.points_earned,160);assert.equal(paid.member.extra_points,80);const led=await transaction(s=>s.get('rewards_ledger',blue.id+':earn:'+o.id));assert.match(led.note,/Skool member ×2/);
 const e=await transaction(s=>accounts.earnFor(s,blue.id,{subtotal:8000,discount:0,member:{points_multiplier:2},subscription_points_multiplier:3}));assert.equal(e.multiplier,3,'subscription tier 3× beats member 2×: max, not 6×');assert.equal(e.points,240);
 assert.equal((await call('/account/member',undefined,blue.cookie)).body.extra_points,80);
});

test('members-only bundles and early access: hidden from the catalog and refused in the quote unless the perk is picked',async()=>{
 const plain=await signedIn('nobody@example.com');await listMember('bun@example.com','vip',['bundles']);await listMember('early@example.com','premium',['early']);const bun=await signedIn('bun@example.com'),early=await signedIn('early@example.com');
 const ids=async c=>(await call('/catalog',undefined,c)).body.products.map(p=>p.id).filter(id=>id<=5).sort();
 assert.deepEqual(await ids(plain.cookie),[1,2,3]);assert.deepEqual(await ids(undefined),[1,2,3],'guests too');assert.deepEqual(await ids(bun.cookie),[1,2,3,4]);assert.deepEqual(await ids(early.cookie),[1,2,3,5]);
 assert.equal((await call('/catalog',undefined,plain.cookie)).body.members_on,true);
 for(const [c,id] of [[plain.cookie,4],[plain.cookie,5],[bun.cookie,5],[early.cookie,4],[undefined,4]])await assert.rejects(quote([{id,quantity:1}],c),e=>e.message==='A product is unavailable.',String(id));
 assert.equal((await quote([{id:4,quantity:1}],bun.cookie)).subtotal,10000);assert.equal((await quote([{id:5,quantity:1}],early.cookie)).subtotal,5000);
 await transaction(async s=>{const p=await s.get('products',5);p.members_early_until=now()-10;await s.put('products',5,p)});assert.deepEqual(await ids(plain.cookie),[1,2,3,5],'opens to everyone at the set time');
 const v=(await call('/account/member',undefined,early.cookie)).body;assert.deepEqual(v.early,[],'banner only while the early window is open');
 await transaction(async s=>{const p=await s.get('products',5);p.members_early_until=now()+DAY;await s.put('products',5,p)});assert.equal((await call('/account/member',undefined,early.cookie)).body.early[0].name,'New Drop');
});

test('a removed member loses the perks at once; their orders and points stay',async()=>{
 await listMember('gone@example.com','vip',['price','bundles']);const u=await signedIn('gone@example.com');const o=await place([{id:1,quantity:2}],u);assert.equal(o.member_discount,800);
 await transaction(s=>s.put('rewards_wallets',u.id,{customer_id:u.id,balance:321,reserved:0}));
 await call('/admin/members/remove',{email:'gone@example.com'},owner);
 const q=await quote([{id:1,quantity:2}],u.cookie);assert.equal(q.member,undefined);assert.equal(q.discount,0);await assert.rejects(quote([{id:4,quantity:1}],u.cookie));
 assert.equal((await call('/account/member',undefined,u.cookie)).body.member,null);const kept=await transaction(s=>s.get('orders',o.id));assert.equal(kept.member_discount,800);assert.equal(kept.total,o.total);
 assert.equal((await transaction(s=>s.get('rewards_wallets',u.id))).balance,321);const rec=await transaction(s=>s.get('members','gone@example.com'));assert(rec.removed_at);assert.deepEqual(rec.perks,[]);
 const row=(await call('/admin/members',undefined,owner)).body.members.find(m=>m.email==='gone@example.com');assert.equal(row.active,false);
});

test('a non-member cannot claim a known member by typing their email; Link checks the account email only',async()=>{
 await listMember('real-vip@example.com','vip',['price','ship']);const thief=await signedIn('thief@example.com');
 const link=(await call('/account/member/link',{email:'real-vip@example.com'},thief.cookie)).body;assert.equal(link.found,false);assert.match(link.message,/thief@example\.com/);assert.match(link.message,/Reply to any of our emails/);
 assert.equal((await quote([{id:1,quantity:2}],thief.cookie,{member_email:'real-vip@example.com',email:'real-vip@example.com'})).member,undefined,'request fields cannot pick the member');
 await assert.rejects(place([{id:1,quantity:2}],{...thief,email:'real-vip@example.com'}),e=>/Use your account email/.test(e.message));
 const guest=await place([{id:1,quantity:2}],{email:'real-vip@example.com',cookie:undefined});assert.equal(guest.member,undefined,'a guest checkout with a member email gets nothing');
 const real=await signedIn('real-vip@example.com');assert.equal((await call('/account/member/link',{},real.cookie)).body.found,true);
 await assert.rejects(call('/account/member/link',{}),e=>e.status===401);
});

test('the order records the member info; admin sees answer-first and pack-first; the invite uses the account setup email',async()=>{
 await listMember('rec@example.com','vip',['price','ship','packed','support']);const u=await signedIn('rec@example.com');
 const o=await place([{id:1,quantity:2}],u);const saved=await transaction(s=>s.get('orders',o.id));
 assert.deepEqual({level:saved.member.level,perks:saved.member.perks,discount:saved.member.discount,free_shipping:saved.member.free_shipping,ship_count:saved.member.ship_count},{level:'vip',perks:['price','ship','packed','support'],discount:800,free_shipping:false,ship_count:1});
 assert.equal(saved.member_priority,true);assert.equal(saved.member_discount,800);assert.equal(saved.total,saved.subtotal-saved.discount+saved.shipping);
 const d=(await call('/admin/data',undefined,staff)).body;assert.equal(d.orders.find(x=>x.id===o.id).member.level,'vip');assert.equal(d.orders.find(x=>x.id===o.id).member_priority,true);assert.equal(d.skool.support['rec@example.com'],'vip');
 const mail=sent.find(m=>m.to?.includes?.('rec@example.com')||m.to==='rec@example.com');assert(mail&&/Skool member savings: \$8\.00 \(10% member discount\)/.test(mail.text),'order email shows the savings');
 await call('/admin/status',{id:o.id,status:'paid',verified:true},owner);const rep=(await call('/admin/reports',{start:'2026-01-01',end:'2030-12-31'},owner)).body;const rrow=rep.orders.find(x=>x.id===o.id);assert(rrow,'paid member order is in the report');assert.equal(rrow.promo,800,'member discount reported with promos');assert.equal(rrow.gross-rrow.promo-rrow.rewards,rrow.net);assert.equal(rrow.total,o.total);
 // Invite: listed, no account yet → the existing "Set up your Glow Lab account" email; never automatic; owner only.
 await listMember('invite-me@example.com','premium');const before=sent.length;const inv=(await call('/admin/members/invite',{email:'invite-me@example.com'},owner)).body;assert.equal(inv.invited,true);
 assert.equal(sent.length,before+1);assert.match(sent.at(-1).subject,/Set up your Glow Lab account/);assert.equal(sent.at(-1).to?.[0]||sent.at(-1).to,'invite-me@example.com');
 await assert.rejects(call('/admin/members/invite',{email:'rec@example.com'},owner),e=>e.status===409,'already has an account');
 const row=(await call('/admin/members',undefined,owner)).body.members.find(m=>m.email==='invite-me@example.com');assert(row.invited_at);assert.equal(row.account,false);
 // Merch: due when never given; owner marks it given.
 await listMember('merch@example.com','vip',['merch']);let mrow=(await call('/admin/members',undefined,owner)).body.members.find(m=>m.email==='merch@example.com');assert.equal(mrow.merch_due,true);
 await call('/admin/members/merch',{email:'merch@example.com'},owner);mrow=(await call('/admin/members',undefined,owner)).body.members.find(m=>m.email==='merch@example.com');assert.equal(mrow.merch_due,false);
});

test('Stripe invoice amount = the order total with the member discount and free shipping',async()=>{
 assert.equal((await call('/admin/auto-invoice',{on:true},owner)).body.enabled,true);
 await listMember('inv@example.com','vip',['price','ship']);const u=await signedIn('inv@example.com');
 await place([{id:1,quantity:2}],u,{payment_method:'cashapp',invoice_via:'email'});stripe.length=0;
 const o=await place([{id:1,quantity:3}],u,{payment_method:'cashapp',invoice_via:'email'});assert.equal(o.member.free_shipping,true);assert.equal(o.total,12000-1200);
 const item=stripe.find(c=>c.p==='/invoiceitems');assert(item,'an invoice was made');assert.equal(Number(item.body.amount),o.total);
 const saved=await transaction(s=>s.get('orders',o.id));assert.equal(saved.stripe_invoice.amount,saved.total);
});

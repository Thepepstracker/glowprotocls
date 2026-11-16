'use strict';
// Auto follow-ups + Buy again (Jonah, 15 Nov 2026: "Auto follow-ups", "Buy again in 1 tap").
// Unfinished Subscribe & save boxes and saved-but-not-sent Venmo/Zelle/Cash App checkouts get one email, by the store itself.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-nudge-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'nudge-tests-session-secret-more-than-32-chars',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real',STORE_POSTAL_ADDRESS:'PO Box 1, Canton, GA 30114'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),growth=require('../../netlify/functions/lib/growth.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),autopilot=require('../../netlify/functions/lib/autopilot.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts={})=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const H=3600,noon=()=>new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T17:00:00Z').getTime(),N=()=>Math.floor(noon()/1000);
let P;
const cust=(name,email)=>({name,email,phone:'+14045550111',address:'1 Main',city:'Canton',state:'GA',zip:'30114'});
async function put(o){await transaction(s=>s.put('orders',o.id,o));return o}
const box=(id,email,ago,extra={})=>put({id,status:'order_received',is_test:false,brand:'glow',created:N()-ago,total:8499,token_hash:'h'+id,payment_method:'card_checkout',checkout_stage:'submitted',proof_required:false,subscription_first:true,subscription_id:'SUB-'+id.slice(-8),items:[{id:P.id,name:P.name,quantity:2,price:P.price}],customer:cust('judy hartman',email),...extra});
const draft=(id,email,ago,extra={})=>put({id,status:'order_received',is_test:false,brand:'glow',created:N()-ago,expires:N()-ago+7*86400,total:4999,token_hash:'h'+id,payment_method:'venmo',checkout_stage:'draft',proof_required:true,items:[{id:P.id,name:P.name,quantity:1,price:P.price}],customer:cust('Dee Draft',email),...extra});

test('setup',async()=>{await transaction(seed);P=await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true,tax_mode:'none'});await s.put('settings','main',st);
 const p=(await s.list('products')).find(x=>x.active&&x.price>=2000&&!(x.components||[]).length&&!x.stock_pool&&!x.max_order_quantity);p.stock=20;await s.put('products',p.id,p);return p})});

test('Autopilot has the switch, and it starts OFF',async()=>{const st=await autopilot.status(),t=st.tasks.find(x=>x.key==='checkouts');assert(t,'listed');assert.equal(t.on,false);assert.match(t.help,/STORE_POSTAL_ADDRESS/)});

test('unfinished Subscribe & save box: one email about an hour later, the approved wording, a link that brings back the box with Subscribe & save',async()=>{
 await transaction(s=>s.put('subscriptions','SUB-0000BX01',{id:'SUB-0000BX01',status:'pending_first_payment',every:'2m',customer:{email:'judy@example.test'}}));
 await box('GLP-0000000BX01','judy@example.test',2*H);await box('GLP-0000000BX02','soon@example.test',20*60);await box('GLP-0000000BX03','old@example.test',60*H);
 sent.length=0;const r=await growth.checkouts(10,noon());assert.equal(r.sent,1,'only the one 1–48 hours old');const m=sent[0];
 assert.equal(m.to[0],'judy@example.test');assert.equal(m.subject,'Your Glow Lab box is still saved for you');assert.match(m.text,/Hi Judy,/);assert.match(m.text,/didn’t finish checking out, so nothing was charged/);assert.match(m.text,/Finish my subscription/);assert.match(m.text,/Unsubscribe from these emails/);
 assert.equal((await growth.checkouts(10,noon())).sent,0,'never twice');
 const ref=m.text.match(/\?restore=([^#\s]+)#bag/)[1],back=(await call('/restore',{ref})).body;assert.deepEqual(back.items.map(i=>[i.id,i.quantity]),[[P.id,2]]);assert.deepEqual(back.sub,{every:'2m'},'Subscribe & save and how often come back');
 // An expired box (Stripe gave up) still gets its one email: the link makes a fresh checkout.
 await box('GLP-0000000BX04','exp@example.test',5*H,{status:'expired'});assert.equal((await growth.checkouts(10,noon())).sent,1);
});

test('nobody who came back and ordered, nobody emailed by hand this morning, only the newest attempt, quiet at night',async()=>{
 await box('GLP-0000000TW01','twice@example.test',5*H);await box('GLP-0000000TW02','twice@example.test',3*H);
 await box('GLP-0000000PD01','paid@example.test',4*H);await put({id:'GLP-0000000PD02',status:'paid',paid:N()-2*H,is_test:false,brand:'glow',created:N()-2*H,total:100,items:[],customer:cust('Pat Paid','paid@example.test')});
 await box('GLP-0000000HS01','hand@example.test',4*H);await transaction(s=>s.put('email_outbox','reachout-2026-11-15-GLP-0000000HS01',{id:'reachout-2026-11-15-GLP-0000000HS01',status:'accepted'}));
 const late=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T03:30:00Z').getTime()+86400000;assert.equal((await growth.checkouts(10,late)).status,'quiet_hours');
 sent.length=0;assert.equal((await growth.checkouts(10,noon())).sent,1);assert.equal(sent[0].to[0],'twice@example.test');
 const o=await transaction(s=>s.get('orders','GLP-0000000TW02'));assert(o.checkout_nudged_at,'the newest attempt got it');
 assert.equal((await transaction(s=>s.get('orders','GLP-0000000PD01'))).checkout_nudge_skipped,'ordered since');
 assert.equal((await transaction(s=>s.get('orders','GLP-0000000HS01'))).checkout_nudge_skipped,'emailed by hand');
});

test('saved Venmo / Zelle / Cash App checkout: one email about 20 hours later with their private order link; canceled if they send it first',async()=>{
 await draft('GLP-0000000DR01','dee@example.test',22*H);await draft('GLP-0000000DR02','early@example.test',5*H);
 sent.length=0;assert.equal((await growth.checkouts(10,noon())).sent,1);const m=sent[0];assert.equal(m.to[0],'dee@example.test');assert.equal(m.subject,'Your Glow Lab order is saved · GLP-0000000DR01');
 assert.match(m.text,/#order=GLP-0000000DR01\.r_\d{10}_[A-Za-z0-9_-]{43}/,'their private order page');assert.match(m.text,/add your payment screenshot/);
 // They uploaded their receipt before the email went out: it is canceled, not sent.
 await draft('GLP-0000000DR03','fast@example.test',21*H);const before=sent.length;const orig=require('../../netlify/functions/lib/store-email.cjs').safeDispatch;
 const emails=require('../../netlify/functions/lib/store-email.cjs');emails.safeDispatch=async()=>{};try{await growth.checkouts(10,noon())}finally{emails.safeDispatch=orig}
 await transaction(async s=>{const o=await s.get('orders','GLP-0000000DR03');o.status='payment_submitted';o.checkout_stage='submitted';o.receipt='x';await s.put('orders',o.id,o)});
 await emails.safeDispatch('checkout-nudge-GLP-0000000DR03');assert.equal(sent.length,before,'not sent');assert.equal((await transaction(s=>s.get('email_outbox','checkout-nudge-GLP-0000000DR03'))).status,'canceled');
});

test('unsubscribed people are skipped, and nothing sends without the postal address',async()=>{
 await transaction(s=>s.put('email_prefs',growth.emailKey('una@example.test'),{id:growth.emailKey('una@example.test'),unsubscribed:true}));await box('GLP-0000000UN01','una@example.test',2*H);
 sent.length=0;await growth.checkouts(10,noon());assert(!sent.some(m=>m.to[0]==='una@example.test'));
 const keep=process.env.STORE_POSTAL_ADDRESS;delete process.env.STORE_POSTAL_ADDRESS;try{assert.equal((await growth.checkouts(10,noon())).status,'needs_postal_address')}finally{process.env.STORE_POSTAL_ADDRESS=keep}
});

test('the owner sees both emails in Management → Growth before switching it on',async()=>{
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];const g=(await call('/admin/growth',{days:7},owner)).body;
 assert.equal(g.preview.box.subject,'Your Glow Lab box is still saved for you');assert.match(g.preview.draft.subject,/Your Glow Lab order is saved/);
});

test('Buy again: your newest paid order, in stock items only, never someone else’s, nothing for guests',async()=>{
 const email='bria@example.test',id=accounts.hash(email),token=crypto.randomBytes(32).toString('base64url');
 await transaction(async s=>{await s.put('customers',id,{id,email,name:'Bria Buyer',verified:true,auth_version:1,created:N()});await s.put('customer_sessions',accounts.hash(token),{customer_id:id,auth_version:1,expires:N()+86400})});const cookie='glow_next_customer='+token;
 const mk=(oid,ago,extra)=>put({id:oid,status:'shipped',is_test:false,brand:'glow',created:N()-ago,total:5000,customer_id:id,items:[{id:P.id,name:P.name,quantity:1,price:P.price}],customer:cust('Bria Buyer',email),...extra});
 assert.deepEqual((await call('/account/buy-again')).body,{order:null},'guest');
 await mk('GLP-0000000BA01',40*86400);await mk('GLP-0000000BA02',10*86400,{items:[{id:P.id,name:P.name,quantity:3,price:P.price}]});await mk('GLP-0000000BA03',86400,{status:'awaiting_payment'});
 await put({id:'GLP-0000000BA09',status:'shipped',is_test:false,brand:'glow',created:N(),total:1,items:[{id:P.id,name:P.name,quantity:9}],customer:cust('Someone Else','else@example.test')});
 const r=(await call('/account/buy-again',undefined,cookie)).body.order;assert.equal(r.id,'GLP-0000000BA02','newest paid or shipped');assert.equal(r.items[0].quantity,3);assert.match(r.date,/\w+ \d+/);
 await transaction(async s=>{const p=await s.get('products',P.id);p.stock=0;await s.put('products',p.id,p)});
 assert.equal((await call('/account/buy-again',undefined,cookie)).body.order,null,'sold out: nothing to show');
 await transaction(async s=>{const p=await s.get('products',P.id);p.stock=20;await s.put('products',p.id,p)});
});

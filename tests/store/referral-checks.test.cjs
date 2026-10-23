'use strict';
// Friend-link referrals (Jonah, 23 Oct 2026): Packing Check shows who referred an order and can add the 200 points;
// no bonus for friends who already had an account, or for a second email at the referrer's own address or phone.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-refer-'));process.env.STORE_LOCAL='1';process.env.STORE_SQLITE_PATH=path.join(tmp,'store.sqlite');process.env.STORE_ADMIN_PASSWORD='refer-test-admin-password';process.env.STORE_SESSION_SECRET='refer-test-session-secret-long-enough';process.env.STORE_ORIGIN='http://127.0.0.1:8787';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');let adminCookie;
const call=(p,b,cookie='',ip='fixture')=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie,'x-nf-client-connection-ip':ip},body:b||{}}),admin=(p,b)=>call(p,b,adminCookie);
async function customer(email,name='Sarah Smith'){await call('/account/register',{name,email},'',email);const id=accounts.hash(email.toLowerCase());const link=(await admin('/admin/customer/setup-link',{customer_id:id})).body;const r=await call('/account/setup',{customer_id:id,token:link.token,password:'a secure customer passphrase 2026'},'',email);return{id,email,cookie:r.headers['Set-Cookie'].split(';')[0]}}
const now=()=>Math.floor(Date.now()/1000);
const order=(id,email,extra={})=>({id,is_test:false,brand:'glow',status:'paid',paid:now(),created:now(),subtotal:5000,discount:0,shipping:1500,tax:0,total:6500,customer:{name:'Friend',email,address:'',zip:'',phone:''},items:[{id:1,name:'Test',quantity:1,amount:5000}],...extra});
const put=o=>transaction(s=>s.put('orders',o.id,o)),get=id=>transaction(s=>s.get('orders',id)),wallet=id=>transaction(s=>accounts.wallet(s,id));
before(async()=>{await transaction(seed);adminCookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];await admin('/admin/rewards-bonuses',{on:true})});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('Packing Check data names the referrer; the add-points button gives 200 once and says so the second time',async()=>{const ref=await customer('sharer@example.com','Sarah Smith');const start=(await wallet(ref.id)).balance;
 await put(order('GLP-RFR0000001','newfriend@example.com',{referred_by:ref.id,status:'awaiting_payment',paid:0}));
 assert.equal((await admin('/admin/order/referral',{id:'GLP-RFR0000001'}).catch(e=>e)).status,409,'unpaid orders cannot get points yet');
 await transaction(async s=>{const o=await s.get('orders','GLP-RFR0000001');o.status='paid';o.paid=now();await s.put('orders',o.id,o)});
 const row=(await admin('/admin/data')).body.orders.find(o=>o.id==='GLP-RFR0000001');assert.deepEqual(row.referrer,{name:'Sarah Smith',email:'sharer@example.com'});assert.equal(row.referral_bonus_awarded,undefined);
 const r1=(await admin('/admin/order/referral',{id:'GLP-RFR0000001'})).body;assert.equal(r1.ok,true);assert.equal(r1.awarded,200);
 assert.equal((await wallet(ref.id)).balance,start+200);assert.equal((await get('GLP-RFR0000001')).referral_bonus_awarded,200);
 const r2=(await admin('/admin/order/referral',{id:'GLP-RFR0000001'})).body;assert.equal(r2.already,true);assert.equal((await wallet(ref.id)).balance,start+200,'never twice');
 await assert.rejects(call('/admin/order/referral',{id:'GLP-RFR0000001'},''),/Sign in/)});

test('no bonus for a friend who already had an account before the order',async()=>{const ref=await customer('sharer2@example.com');const friend=await customer('hasaccount@example.com','Has Account');
 await transaction(async s=>{const c=await s.get('customers',friend.id);c.created=now()-86400;await s.put('customers',c.id,c)});
 await put(order('GLP-RFR0000002','hasaccount@example.com',{referred_by:ref.id}));const start=(await wallet(ref.id)).balance;
 const r=(await admin('/admin/order/referral',{id:'GLP-RFR0000002'})).body;assert.equal(r.ok,false);assert.match(r.reason,/already had an account/);assert.equal((await wallet(ref.id)).balance,start)});

test('a friend who makes their account at checkout still counts (account newer than an hour before the order)',async()=>{const ref=await customer('sharer3@example.com');await customer('brandnew@example.com','Brand New');
 await put(order('GLP-RFR0000003','brandnew@example.com',{referred_by:ref.id}));const r=(await admin('/admin/order/referral',{id:'GLP-RFR0000003'})).body;assert.equal(r.ok,true)});

test('no bonus for a second email at the referrer\'s own address or phone',async()=>{const ref=await customer('sharer4@example.com');
 await put(order('GLP-RFR0000004','sharer4@example.com',{customer:{name:'Sarah',email:'sharer4@example.com',address:'12 Oak St.',zip:'30107',phone:'(470) 555-0101'},created:now()-5000}));
 await put(order('GLP-RFR0000005','alt-email@example.com',{referred_by:ref.id,customer:{name:'Alt',email:'alt-email@example.com',address:'12 oak st',zip:'30107-1234',phone:''}}));
 let r=(await admin('/admin/order/referral',{id:'GLP-RFR0000005'})).body;assert.equal(r.ok,false);assert.match(r.reason,/Same shipping address/);
 await put(order('GLP-RFR0000006','alt2@example.com',{referred_by:ref.id,customer:{name:'Alt2',email:'alt2@example.com',address:'99 Elm Rd',zip:'30114',phone:'470-555-0101'}}));
 r=(await admin('/admin/order/referral',{id:'GLP-RFR0000006'})).body;assert.equal(r.ok,false);assert.match(r.reason,/Same phone number/);
 await put(order('GLP-RFR0000007','realfriend@example.com',{referred_by:ref.id,customer:{name:'Real',email:'realfriend@example.com',address:'5 Pine Ave',zip:'30115',phone:'678-555-0199'}}));
 r=(await admin('/admin/order/referral',{id:'GLP-RFR0000007'})).body;assert.equal(r.ok,true,'a real friend somewhere else still counts')});

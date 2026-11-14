'use strict';
// Home-page sign-up extras (Jonah, 14 Nov 2026: "add address and stuff like that, where you saw us from").
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-signup-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'signup-owner-test-password',STORE_SESSION_SECRET:'signup-profile-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',RESEND_API_KEY:'fixture-only',STORE_EMAIL_FROM:'support@example.com'});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts)=>{if(!String(url).includes('resend.com'))throw new Error('no network');sent.push(JSON.parse(opts.body));return{ok:true,json:async()=>({id:'em'+sent.length})}};
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs');
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
let ip=0;const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1','x-forwarded-for':'10.0.0.'+(++ip),...(cookie?{cookie}:{})},body:b||{}});
const get=e=>transaction(s=>s.get('customers',accounts.hash(e)));
test('a new sign-up saves where they found us, the shipping address and phone',async()=>{
 await transaction(s=>s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{}}));
 await call('/account/register',{name:'Ann New',email:'ann.new@example.test',heard_from:'live',address:'12 Glow St',city:'Ball Ground',state:'ga',zip:'30107',phone:'(404) 555-0123'});
 const a=await get('ann.new@example.test');assert.equal(a.signup.heard_from,'live');assert.deepEqual(a.ship_to,{address:'12 Glow St',city:'Ball Ground',state:'GA',zip:'30107'});assert.equal(a.phone,'(404) 555-0123');assert.equal(a.verified,false);
});
test('"somewhere else" keeps their words; an incomplete address is not saved; unknown answers are dropped',async()=>{
 await call('/account/register',{name:'Bo',email:'bo@example.test',heard_from:'other',heard_other:'My sister\'s salon',address:'1 Main',city:'',state:'GA',zip:'30107'});
 let a=await get('bo@example.test');assert.equal(a.signup.heard_other,'My sister\'s salon');assert.equal(a.ship_to,undefined);
 await call('/account/register',{name:'Cy',email:'cy@example.test',heard_from:'<script>'});a=await get('cy@example.test');assert.equal(a.signup,undefined);
});
test('nobody can change an existing customer\'s details by signing up with their email',async()=>{
 await transaction(async s=>{const id=accounts.hash('real@example.test');await s.put('customers',id,{id,email:'real@example.test',name:'Real',created:1,verified:true,auth_version:1,password:null,phone:'7705550000',ship_to:{address:'9 Real Rd',city:'Canton',state:'GA',zip:'30114'}})});
 await call('/account/register',{name:'Fake',email:'real@example.test',heard_from:'tiktok',address:'666 Fake St',city:'Nowhere',state:'TX',zip:'75001',phone:'2145550000'});
 const a=await get('real@example.test');assert.equal(a.ship_to.address,'9 Real Rd');
 const mail=sent.filter(m=>[m.to].flat().includes('real@example.test'));assert.equal(mail.length,1,'someone who already has an account gets a password reset link instead of nothing');assert.match(mail[0].subject+mail[0].text,/reset|password/i);assert.equal(a.phone,'7705550000');assert.equal(a.signup,undefined);
});
test('their own account shows the saved address and phone (for checkout), and the team sees where they found us',async()=>{
 const d=await transaction(async s=>accounts.accountData(s,await s.get('customers',accounts.hash('ann.new@example.test'))));assert.equal(d.customer.ship_to.city,'Ball Ground');assert.equal(d.customer.phone,'(404) 555-0123');
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const list=(await call('/admin/customers',undefined,owner)).body.customers;const c=list.find(x=>x.email==='ann.new@example.test');assert.equal(c.heard_from,'live');assert.equal(c.ship_to.zip,'30107');
});

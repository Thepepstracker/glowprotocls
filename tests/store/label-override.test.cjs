'use strict';
// $15 label price check override (24 Oct 2026): only the owner sign-in may override; staff accounts get a 403 and nothing is bought.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-override-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'override-tests-session-secret-more-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];let sent,shippoCalls=0;const oldFetch=global.fetch;
global.fetch=async(url,opts)=>{if(String(url).includes('resend.com')){sent=JSON.parse(opts.body);return{ok:true,status:200,json:async()=>({id:'x'})}}shippoCalls++;throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
test('staff cannot override the $15 price check; the owner can get past the gate',async()=>{
 await transaction(seed);const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 await call('/admin/staff/invite',{email:'packer@example.com',name:'Packer'},owner);const m=sent.text.match(/#staff=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})/);
 const staff=cookie(await call('/staff/setup',{id:m[1],token:m[2],password:'long staff passphrase for testing'}));
 const before=shippoCalls;
 await assert.rejects(call('/admin/shippo/buy',{id:'GLP-ANY',override:true},staff),e=>e.status===403&&/Only the owner/.test(e.message));
 await assert.rejects(call('/admin/shippo/retry',{id:'GLP-ANY',override:true},staff),e=>e.status===403);
 await assert.rejects(call('/admin/shippo/replacement',{id:'GLP-ANY',override:true,note:'x',key:'abcdefgh1'},staff),e=>e.status===403);
 assert.equal(shippoCalls,before,'nothing reached Shippo');
 // Owner passes the gate (then the normal buy rules apply: this order does not exist / Shippo not connected).
 const r=await call('/admin/shippo/buy',{id:'GLP-ANY',override:true},owner);assert.notEqual(r.status,403);
 // Staff without override is still allowed to buy normally (gets past the gate).
 const r2=await call('/admin/shippo/buy',{id:'GLP-ANY'},staff);assert.notEqual(r2.status,403)});

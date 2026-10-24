'use strict';
// "Keep me signed in on this computer" (24 Oct 2026): 30-day staff/owner session when ticked, 8 hours otherwise.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-remember-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'remember-test-admin-password',STORE_SESSION_SECRET:'remember-test-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const login=(b,ip)=>handle({path:'/admin/login',method:'POST',headers:{'x-store-request':'1','x-nf-client-connection-ip':ip},body:b});
before(()=>transaction(seed));after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('owner login: 8 hours by default, 30 days when "keep me signed in" is ticked; the long cookie works',async()=>{
 const short=(await login({password:process.env.STORE_ADMIN_PASSWORD},'a')).headers['Set-Cookie'];assert.match(short,/Max-Age=28800/);
 const long=(await login({password:process.env.STORE_ADMIN_PASSWORD,remember:'1'},'b')).headers['Set-Cookie'];assert.match(long,/Max-Age=2592000/);assert.match(long,/HttpOnly/);assert.match(long,/SameSite=Strict/);
 const r=await handle({path:'/admin/data',method:'GET',headers:{'x-store-request':'1',cookie:long.split(';')[0]},body:{}});assert.equal(r.status,200)});
test('a wrong password with remember ticked still fails',async()=>{const r=await login({password:'nope-nope-nope-nope',remember:'1'},'c');assert.equal(r.headers?.['Set-Cookie'],undefined)});

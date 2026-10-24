'use strict';
// Packing Check call log (24 Oct 2026): staff log each call on the order; customers never see it.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-calllog-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'calllog-test-admin-password',STORE_SESSION_SECRET:'calllog-test-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const call=(p,b,c='')=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie:c,'x-nf-client-connection-ip':'fixture'},body:b||{}});let admin;
before(async()=>{await transaction(seed);admin=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 await transaction(s=>s.put('orders','GLP-CALLLOG001',{id:'GLP-CALLLOG001',is_test:false,status:'shipped',created:1,customer:{name:'Amy',email:'amy@example.com',phone:'5555550100'},items:[],token_hash:'x'}))});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('log a call with how they liked it and problems; saved once per key; shows in Management data',async()=>{
 const r=(await call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000001',outcome:'talked',feeling:'problem',problems:['missing','bogus'],notes:'  1 BAC missing  '},admin)).body;
 assert.equal(r.ok,true);assert.deepEqual(r.entry.problems,['missing']);assert.equal(r.entry.notes,'1 BAC missing');assert.equal(r.entry.by,'Owner');
 const again=(await call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000001',outcome:'talked',feeling:'happy'},admin)).body;assert.equal(again.already,true);
 await call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000002',outcome:'voicemail',feeling:'happy',notes:'left vm'},admin);
 const row=(await call('/admin/data',undefined,admin)).body.orders.find(o=>o.id==='GLP-CALLLOG001');assert.equal(row.call_log.length,2);assert.equal(row.call_log[1].feeling,'','voicemail has no feeling')});
test('bad input is refused: no outcome, problem without a reason, signed out',async()=>{
 await assert.rejects(call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000003'},admin),/how the call went/);
 await assert.rejects(call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000004',outcome:'talked',feeling:'problem'},admin),/what the problem was/);
 await assert.rejects(call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000005',outcome:'talked'}),/Sign in/)});
test('a fresh mistake can be removed; the customer order page never includes the call log',async()=>{
 const rm=(await call('/admin/order/call-log',{id:'GLP-CALLLOG001',key:'k-000000002',remove:true},admin)).body;assert.equal(rm.removed,true);
 const o=await transaction(s=>s.get('orders','GLP-CALLLOG001'));assert.equal(o.call_log.length,1);
 const {publicOrder}=(()=>{const src=fs.readFileSync(path.join(__dirname,'../../netlify/functions/lib/store-core.cjs'),'utf8');return{publicOrder:/payment_adjustments,staff_notes,call_log,(stripe_invoice,)?\.\.\.rest/.test(src)}})();assert.equal(publicOrder,true,'publicOrder strips call_log')});

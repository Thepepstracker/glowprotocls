'use strict';
// End of day (Jonah, 11 Nov 2026): "can I stop for tonight?" — fix-before-bed vs tomorrow.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'eod-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'eod-fixture-admin-password',STORE_SESSION_SECRET:'eod-fixture-session-secret-long-enough-xx',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {check}=require('../../netlify/functions/lib/end-of-day.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs');
const t=1794400000,o=(id,x)=>({id,brand:'glow',is_test:false,status:'paid',total:5000,customer:{name:'Pat Example'},created:t-3600,...x});
const empty={orders:[],subs:[],emails:[],printLog:[],manuals:[]};

test('nothing wrong → all clear, with tomorrow’s normal work listed',()=>{
 const r=check({...empty,orders:[o('GLP-A1'),o('GLP-A2',{status:'payment_submitted'}),o('GLP-A3',{status:'awaiting_payment',total:2500}),o('GLP-A4',{status:'shipped',tracking:'1Z',shipment:{tracking:'1Z',label_created_at:t-600}})]},'glow',t);
 assert.equal(r.all_clear,true);assert.deepEqual(r.fix,[]);
 assert.equal(r.tomorrow.to_label,1);assert.equal(r.tomorrow.to_verify,1);assert.equal(r.tomorrow.unpaid,1);assert.equal(r.tomorrow.unpaid_cents,2500);assert.equal(r.tomorrow.not_printed,1);
 const p=check({...empty,orders:[o('GLP-A4',{status:'shipped',shipment:{tracking:'1Z',label_created_at:t-600}})],printLog:[{id:'GLP-A4',label:{at:t}}]},'glow',t);assert.equal(p.tomorrow.not_printed,0,'printed labels are not listed');
});
test('label, subscription and email problems must be fixed before bed; tests, Zader and old ones are ignored',()=>{
 const r=check({...empty,
  orders:[o('GLP-B1',{shippo_needs_review:true,shippo_message:'Shippo returned no rate.'}),o('GLP-B2',{shippo_needs_review:true,is_test:true}),o('ZDR-B3',{brand:'zader',shippo_needs_review:true})],
  subs:[{id:'SUB-1',brand:'glow',status:'active',payment_issue:true,problem:'Card declined.',customer:{name:'Sam Sub'}},{id:'SUB-2',brand:'glow',status:'canceled',problem:'old'}],
  emails:[{id:'e1',brand:'glow',status:'rejected',to:'real@gmail.com',created:t-100,message:'Resend rejected the message (HTTP 422).'},{id:'e2',brand:'glow',status:'rejected',to:'x@example.com',created:t-100},{id:'e3',brand:'glow',status:'rejected',to:'old@gmail.com',created:t-3*86400},{id:'e4',brand:'glow',status:'retry',attempts:4,to:'a@gmail.com',created:t-50}]},'glow',t);
 assert.equal(r.all_clear,false);
 assert.deepEqual(r.fix.map(f=>f.type+':'+f.id),['label:GLP-B1','subscription:SUB-1','email:e1','email:retry']);
 assert.equal(r.fix[0].name,'Pat E.');assert.match(r.fix[0].why,/no rate/);
 const z=check({...empty,orders:[o('ZDR-B3',{brand:'zader',shippo_needs_review:true})]},'zader',t);assert.equal(z.all_clear,false,'Zader sees its own');
});
test('staff only',async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}})});await assert.rejects(handle({path:'/admin/end-of-day',method:'GET',headers:{'x-store-request':'1'},body:{}}),e=>e.status===401);
 const cookie=(await handle({path:'/admin/login',method:'POST',headers:{'x-store-request':'1'},body:{password:process.env.STORE_ADMIN_PASSWORD}})).headers['Set-Cookie'].split(';')[0];
 const r=(await handle({path:'/admin/end-of-day',method:'GET',headers:{'x-store-request':'1',cookie},body:{}})).body;assert.equal(r.all_clear,true);assert.equal(r.brand,'glow');
 fs.rmSync(tmp,{recursive:true,force:true})});

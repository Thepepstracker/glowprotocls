'use strict';
// Print log (Jonah, 9 Nov 2026): Packing Check shows which labels and packing slips have been printed, on every computer.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'print-log-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'print-fixture-admin-password',STORE_SESSION_SECRET:'print-fixture-session-secret-long-enough-x',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const call=(p,b,h={})=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',...h},body:b||{}});
let owner;const admin=(p,b)=>call(p,b,{cookie:owner});
before(async()=>{await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',shipping_cents:1500,free_shipping_cents:25000,payment_links:{}})});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('staff only; empty at first',async()=>{await assert.rejects(call('/admin/printed'),e=>e.status===401);assert.deepEqual((await admin('/admin/printed')).body,{printed:{}})});
test('label and slip are recorded separately, counted, and shared',async()=>{
 await admin('/admin/printed',{ids:['GLP-ABC1234567'],what:'label',via:'printer'});
 let p=(await admin('/admin/printed')).body.printed['GLP-ABC1234567'];assert.equal(p.label.via,'printer');assert.equal(p.label.count,1);assert.equal(p.slip,null);
 await admin('/admin/printed',{ids:['GLP-ABC1234567','SHIP-670CE30C05','GLP-ABC1234567-R1'],what:'slip',via:'browser'});
 await admin('/admin/printed',{ids:['GLP-ABC1234567'],what:'label',via:'opened'});
 const all=(await admin('/admin/printed')).body.printed;p=all['GLP-ABC1234567'];assert.equal(p.label.count,2);assert.equal(p.label.via,'opened');assert.equal(p.slip.via,'browser');
 assert.ok(all['SHIP-670CE30C05'].slip);assert.ok(all['GLP-ABC1234567-R1'].slip);
});
test('an older record from one computer never overwrites a real one; bad input is refused',async()=>{
 const t=Math.floor(Date.now()/1000)-3600;
 await admin('/admin/printed',{ids:['GLP-ABC1234567'],what:'label',via:'earlier',at:t});
 assert.notEqual((await admin('/admin/printed')).body.printed['GLP-ABC1234567'].label.at,t);
 await admin('/admin/printed',{ids:['GLP-OLD0000001'],what:'label',via:'earlier',at:t});assert.equal((await admin('/admin/printed')).body.printed['GLP-OLD0000001'].label.at,t);
 await assert.rejects(admin('/admin/printed',{ids:['GLP-ABC1234567'],what:'box'}),e=>e.status===400);
 await assert.rejects(admin('/admin/printed',{ids:['<script>'],what:'label'}),e=>e.status===400);
 const r=(await transaction(s=>s.get('orders','GLP-ABC1234567')));assert.equal(r,null,'orders are never touched');
});

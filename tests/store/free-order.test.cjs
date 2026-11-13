'use strict';
// Free order (Jonah, 13 Nov 2026): an order given away (an employee's mom) is left out of sales: week/day colors and goals,
// the live totals and the reports. It still packs and ships. Staff only; can be undone.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-free-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'free-owner-test-password',STORE_SESSION_SECRET:'free-order-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),reports=require('../../netlify/functions/lib/business-reports.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('mark free leaves it out of sales and can be undone; staff sign-in needed',async()=>{
 const t=Math.floor(Date.now()/1000);
 await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{}});for(const [id,total] of [['GLP-FREE000001',11104],['GLP-SALE000001',5000]])await s.put('orders',id,{id,brand:'glow',is_test:false,status:'shipped',created:t-60,paid:t-30,total,subtotal:total,discount:0,shipping:0,tax:0,items:[{id:1,name:'X',quantity:1,price:total,amount:total}],customer:{name:'A B',email:'a@example.test'}})});
 await assert.rejects(call('/admin/order/free',{id:'GLP-FREE000001',free:true}),/sign in|Sign in|log in|Unauthorized/i);
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const before=await transaction(s=>reports.build(s,{},t));
 const r=(await call('/admin/order/free',{id:'GLP-FREE000001',free:true,note:'Free order'},owner)).body;assert.equal(r.comped.total_cents,11104);
 const o=await transaction(s=>s.get('orders','GLP-FREE000001'));assert.ok(o.comped);assert.equal(o.status,'shipped','still ships');assert.equal(o.total,11104,'the order itself is unchanged');
 const after_=await transaction(s=>reports.build(s,{},t));assert.notDeepEqual(JSON.stringify(after_),JSON.stringify(before),'reports change');
 assert.ok(!JSON.stringify(after_).includes('GLP-FREE000001'),'not listed as a sale');
 await call('/admin/order/free',{id:'GLP-FREE000001',free:false},owner);assert.equal((await transaction(s=>s.get('orders','GLP-FREE000001'))).comped,undefined);
});

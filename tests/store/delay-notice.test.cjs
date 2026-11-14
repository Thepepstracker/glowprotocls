'use strict';
// Flight-stop delay notice (Jonah, 13 Nov 2026). One email per order shipped that day, owner only, never twice.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-delay-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'delay-owner-test-password',STORE_SESSION_SECRET:'delay-notice-tests-session-secret-32chars+',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',RESEND_API_KEY:'fixture-only',STORE_EMAIL_FROM:'support@example.com'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),dn=require('../../netlify/functions/lib/delay-notice.cjs');
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts)=>{if(!String(url).includes('resend.com'))throw new Error('no network');sent.push(JSON.parse(opts.body));return{ok:true,json:async()=>({id:'em'+sent.length})}};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const at=(iso)=>Math.floor(Date.parse(iso)/1000);
const order=(id,name,email,labelAt,extra={})=>({id,brand:'glow',status:'shipped',is_test:false,created:labelAt-3600,customer:{name,email,address:'1 Main St',city:'Ball Ground',state:'GA',zip:'30107'},items:[],total:5000,token_hash:'x'.repeat(64),shipment:{carrier:'ups',carrier_name:'UPS',service:'UPS 2nd Day Air',tracking:'1ZTEST'+id.slice(-4),tracking_url:'https://www.ups.com/track?tracknum=1ZTEST',label_created_at:labelAt},...extra});
let owner;
test('preview lists only real orders whose label was made that day (New York time), with no customer details',async()=>{
 await transaction(async s=>{await s.put('settings','main',{demo:false,checkout_enabled:true,tax_mode:'none',payment_links:{}});
  for(const o of [order('GLP-AAAA000001','jen french','a@example.test',at('2026-11-13T14:00:00Z')),order('GLP-AAAA000002','Mary','b@example.test',at('2026-11-14T04:30:00Z')),
   order('GLP-AAAA000003','Old','c@example.test',at('2026-11-12T15:00:00Z')),order('GLP-AAAA000004','Test','d@example.test',at('2026-11-13T15:00:00Z'),{is_test:true}),
   order('GLP-AAAA000005','Paid','e@example.test',at('2026-11-13T15:00:00Z'),{status:'paid'}),order('GLP-AAAA000006','Hand','f@example.test',at('2026-11-13T15:00:00Z'),{shipment:{carrier:'in_person',label_created_at:at('2026-11-13T15:00:00Z')}})])await s.put('orders',o.id,o)});
 await assert.rejects(call('/admin/orders/delay-notice',{mode:'preview',day:'2026-11-13'}),/sign in|Sign in|log in|Unauthorized/i);
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const r=(await call('/admin/orders/delay-notice',{mode:'preview',day:'2026-11-13'},owner)).body;
 assert.deepEqual(r.orders.map(o=>o.id),['GLP-AAAA000001','GLP-AAAA000002'],'11:30 PM ET on the 13th counts as the 13th; the 12th, test, unshipped and hand-delivered orders do not');
 assert.ok(!JSON.stringify(r).includes('@'),'no emails in the preview');
});
test('the email: first name, order, the honest reason, tracking button, no claims beyond "may be late"',()=>{
 const c=dn.content(order('GLP-AAAA000001','jen french','a@example.test',1));assert.equal(c.lines[0],'Hi Jen,');assert.match(c.subject,/may be a little late · Glow Lab GLP-AAAA000001/);
 assert.ok(c.lines.some(l=>/FAA stopped all flights/.test(l)&&/may arrive a day or two later/.test(l)));assert.ok(c.lines.includes('Tracking number: 1ZTEST0001'));
});
test('test goes only to the test address; send needs the typed count, emails each customer once, and never twice',async()=>{
 const n0=sent.length;const t=(await call('/admin/orders/delay-notice',{mode:'test',day:'2026-11-13',test_to:'owner@example.test'},owner)).body;assert.equal(t.queued,1);
 assert.deepEqual(sent.slice(n0).map(m=>m.to).flat(),['owner@example.test']);assert.match(sent.at(-1).subject,/^\[TEST\] /);
 await assert.rejects(call('/admin/orders/delay-notice',{mode:'send',day:'2026-11-13',confirm:'SEND 5'},owner),/Type SEND 2/);
 const n1=sent.length;const r=(await call('/admin/orders/delay-notice',{mode:'send',day:'2026-11-13',confirm:'SEND 2'},owner)).body;assert.equal(r.queued,2);
 assert.deepEqual(sent.slice(n1).map(m=>[m.to].flat()[0]).sort(),['a@example.test','b@example.test']);assert.ok(sent.slice(n1).every(m=>/ups\.com\/track/.test(m.html)));
 const again=(await call('/admin/orders/delay-notice',{mode:'send',day:'2026-11-13',confirm:'SEND 2'},owner)).body;assert.equal(again.queued,0,'never twice');
});

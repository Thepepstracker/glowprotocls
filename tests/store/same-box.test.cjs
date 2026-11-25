'use strict';
// Same box (Jonah, 25 Nov 2026): Donna's two orders went in one box under one UPS label. The second order is marked shipped
// with the first order's tracking, and its "label created" email says both orders share that one tracking number.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-samebox-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'samebox-tests-session-secret-32chars!!',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('second order ships in the same box under the first order\'s UPS tracking',async()=>{await transaction(seed);
 const owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 const cust={name:'Donna Day',email:'donna@example.org',address:'1 A St',city:'Town',state:'GA',zip:'30107'};
 await transaction(async s=>{await s.put('orders','GLP-AAAAAAAAA1',{id:'GLP-AAAAAAAAA1',status:'shipped',is_test:false,brand:'glow',total:5000,customer:cust,items:[{id:1,name:'BPC-157',quantity:1}],tracking:'1Z3G52C30210586466',shipment:{carrier:'ups',carrier_name:'UPS',service:'UPS 2nd Day Air',tracking:'1Z3G52C30210586466',label_url:'https://x/label.pdf',label_created_at:1795600000}});
  await s.put('orders','GLP-BBBBBBBBB2',{id:'GLP-BBBBBBBBB2',status:'paid',is_test:false,brand:'glow',total:3000,customer:cust,items:[{id:2,name:'KPV',quantity:1}]});
  await s.put('orders','GLP-CCCCCCCCC3',{id:'GLP-CCCCCCCCC3',status:'paid',is_test:false,brand:'glow',total:3000,customer:{...cust,email:'other@example.org'},items:[{id:2,name:'KPV',quantity:1}]})});
 await assert.rejects(call('/admin/status',{id:'GLP-CCCCCCCCC3',status:'shipped',same_box_as:'GLP-AAAAAAAAA1'},owner),e=>e.status===409,'different customer is refused');
 await call('/admin/status',{id:'GLP-BBBBBBBBB2',status:'shipped',same_box_as:'GLP-AAAAAAAAA1'},owner);
 const [a,b]=await transaction(async s=>[await s.get('orders','GLP-AAAAAAAAA1'),await s.get('orders','GLP-BBBBBBBBB2')]);
 assert.equal(b.status,'shipped');assert.equal(b.tracking,'1Z3G52C30210586466');assert.equal(b.shipment.same_box_as,'GLP-AAAAAAAAA1');assert.equal(b.shipment.label_url,null,'no second label to print');assert.equal(b.shipment.service,'UPS 2nd Day Air');
 assert.equal(b.ships_with,'GLP-AAAAAAAAA1');assert.equal(a.ships_with,'GLP-BBBBBBBBB2');
 const src=fs.readFileSync(require.resolve('../../netlify/functions/lib/store-email.cjs'),'utf8');assert.match(src,/same box as your order '\+sh\.same_box_as\+', so both orders share this one UPS tracking number/)});

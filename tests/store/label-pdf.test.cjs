'use strict';
// Packing Check "Send to printer" (24 Oct 2026): staff-only; fetches the label PDF from Shippo's file host only.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-lblpdf-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'label-pdf-admin-password',STORE_SESSION_SECRET:'label-pdf-session-secret-long-enough',STORE_ORIGIN:'http://127.0.0.1:8787'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');
const realFetch=global.fetch;let asked=[];let cookie;
const call=(p,b,c='')=>handle({path:p,method:b===undefined?'GET':'POST',headers:{'x-store-request':'1',cookie:c,'x-nf-client-connection-ip':'fixture'},body:b||{}});
const put=o=>transaction(s=>s.put('orders',o.id,o));
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 global.fetch=async u=>{asked.push(String(u));return{ok:true,status:200,arrayBuffer:async()=>Buffer.from('%PDF-1.4 fake label')}}});
after(()=>{global.fetch=realFetch;fs.rmSync(tmp,{recursive:true,force:true})});
test('staff get the label PDF named glow-label-<order>.pdf',async()=>{await put({id:'GLP-LBLPDF0001',is_test:false,status:'shipped',customer:{name:'A'},items:[],shipment:{label_url:'https://deliver.goshippo.com/abc.pdf?Expires=1&Signature=x'}});
 const r=(await call('/admin/order/label-pdf',{id:'GLP-LBLPDF0001'},cookie)).body;assert.equal(r.name,'glow-label-GLP-LBLPDF0001.pdf');assert.equal(Buffer.from(r.pdf,'base64').toString().slice(0,5),'%PDF-');assert.match(asked.at(-1),/^https:\/\/deliver\.goshippo\.com\//)});
test('signed-out callers are refused',async()=>{await assert.rejects(call('/admin/order/label-pdf',{id:'GLP-LBLPDF0001'}),/Sign in/)});
test('a label link that is not on Shippo is never fetched',async()=>{await put({id:'GLP-LBLPDF0002',is_test:false,status:'shipped',customer:{name:'A'},items:[],shipment:{label_url:'https://evil.example/x.pdf'}});const n=asked.length;
 await assert.rejects(call('/admin/order/label-pdf',{id:'GLP-LBLPDF0002'},cookie),/not on Shippo/);assert.equal(asked.length,n)});
test('replacement labels come back as -R<n>',async()=>{await put({id:'GLP-LBLPDF0003',is_test:false,status:'shipped',customer:{name:'A'},items:[],shipment:{label_url:'https://deliver.goshippo.com/a.pdf'},replacements:[{n:1,label_url:'https://deliver.goshippo.com/r1.pdf'}]});
 const r=(await call('/admin/order/label-pdf',{id:'GLP-LBLPDF0003',r:1},cookie)).body;assert.equal(r.name,'glow-label-GLP-LBLPDF0003-R1.pdf');assert.match(asked.at(-1),/r1\.pdf$/)});

'use strict';
// Inventory (Jonah, 27 Nov 2026): shelf counts, in/out log, deliveries received once.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const inv=require('../../netlify/functions/lib/inventory.cjs'),inc=require('../../netlify/functions/lib/incoming.cjs');
function memory(data={}){const r=new Map(Object.entries(data).map(([k,rows])=>[k,new Map(rows.map((x,i)=>[String(x.id??i),structuredClone(x)]))]));return{get:async(k,id)=>structuredClone(r.get(k)?.get(String(id))||null),put:async(k,id,v)=>{if(!r.has(k))r.set(k,new Map());r.get(k).set(String(id),structuredClone(v))},list:async k=>structuredClone([...(r.get(k)?.values()||[])])}}
// Same as store-core's setStock: the pool shares one count, and the move is logged.
async function setStock(s,p,stock){const before=Number(p.stock)||0;if(before!==stock)await inv.logMove(s,p,before,stock);const all=await s.list('products');for(const x of all.filter(x=>p.stock_pool?x.stock_pool===p.stock_pool:x.id===p.id)){x.stock=stock;await s.put('products',x.id,x)}}
const t=Math.floor(Date.now()/1000);
const products=[{id:1,name:'GHK-Cu · 50 mg',stock:6,stock_pool:'ghk50',active:true},{id:2,name:'GHK-Cu · 50 mg · Kit of 10',units:10,stock:6,stock_pool:'ghk50',active:true},{id:3,name:'KLOW · 80 mg',stock:-2,active:true}];
const orders=[{id:'GLP-A',is_test:false,status:'paid',created:t,items:[{id:1,quantity:3}]},{id:'GLP-B',is_test:false,status:'shipped',created:t,shipment:{label_created_at:t-3600},items:[{id:3,quantity:2}]},
 {id:'GLP-C',is_test:false,status:'shipped',created:t,shipment:{label_created_at:t-3600},packed:{at:t},items:[{id:1,quantity:5}]},{id:'GLP-D',is_test:false,status:'canceled',created:t,items:[{id:1,quantity:9}]}];
test('overview: should-be-on-shelf = store count + what waiting boxes still need (packed and canceled orders do not count)',async()=>{const s=memory({products,orders});const o=await inv.overview(s);const g=o.pools.find(p=>p.key==='ghk50'),k=o.pools.find(p=>p.name==='KLOW · 80 mg');
 assert.deepEqual([g.store,g.waiting,g.shelf,g.product_id],[6,3,9,1]);assert.deepEqual([k.store,k.waiting,k.shelf],[-2,2,0])});
test('shelf count sets store = shelf − waiting for the whole pool and logs before/after with the note',async()=>{const s=memory({products,orders});
 const r=await inv.run({path:'/admin/inventory/count'},()=>inv.route(s,'/admin/inventory/count',{note:'Friday count',counts:[{product_id:1,shelf:12},{product_id:3,shelf:2}]},'POST','owner',setStock));
 assert.equal(r.changed,2);assert.equal((await s.get('products',1)).stock,9);assert.equal((await s.get('products',2)).stock,9);assert.equal((await s.get('products',3)).stock,0);
 const log=(await inv.route(s,'/admin/inventory/log',{},'GET','owner')).log;assert.equal(log.length,2);const g=log.find(x=>x.product_id===1);assert.deepEqual([g.from,g.to,g.delta,g.reason,g.note,g.by],[6,9,3,'Shelf count','Friday count','owner'])});
test('bad counts are refused and nothing changes',async()=>{const s=memory({products,orders});
 await assert.rejects(inv.route(s,'/admin/inventory/count',{counts:[{product_id:1,shelf:-1}]},'POST','owner',setStock),/whole numbers/);
 await assert.rejects(inv.route(s,'/admin/inventory/count',{counts:[{product_id:1,shelf:5},{product_id:2,shelf:5}]},'POST','owner',setStock),/twice/);
 assert.equal((await s.get('products',1)).stock,6)});
test('a delivery is added once, marked received, and stays received when the ERP check saves again',async()=>{const s=memory({products,orders});
 await inc.route(s,'/admin/incoming',{source:'ERP',shipments:[{ref:'SO-9',status:'delivered',lines:[{name:'GHK-CU 50mg',qty:20,product_id:1},{name:'?',qty:10}]}]},'POST','owner');
 const r=await inv.run({path:'/admin/inventory/receive'},()=>inv.route(s,'/admin/inventory/receive',{ref:'SO-9'},'POST','owner',setStock));assert.deepEqual(r.added,[{name:'GHK-Cu · 50 mg',qty:20}]);assert.deepEqual(r.unmatched,['? ×10']);
 assert.equal((await s.get('products',1)).stock,26);await assert.rejects(inv.route(s,'/admin/inventory/receive',{ref:'SO-9'},'POST','owner',setStock),/already added/);
 await inc.route(s,'/admin/incoming',{source:'ERP',shipments:[{ref:'SO-9',status:'delivered',lines:[{name:'GHK-CU 50mg',qty:20,product_id:1}]}]},'POST','owner');
 assert.equal((await s.get('integrations','incoming')).shipments[0].status,'received');const log=(await inv.route(s,'/admin/inventory/log',{},'GET','owner')).log;assert.equal(log[0].reason,'Delivery received');assert.equal(log[0].ref,'SO-9')});
test('the log names the request that moved stock',()=>{assert.equal(inv.reasonOf('/orders'),'Order placed');assert.equal(inv.reasonOf('/admin/manual-shipment'),'Free / replacement box');assert.equal(inv.reasonOf('/admin/product'),'Product edited');assert.equal(inv.reasonOf(''),'Automatic (store)')});
test('wired in: every setStock logs, routes exist, Packing Check has the tab',()=>{const core=fs.readFileSync(__dirname+'/../../netlify/functions/lib/store-core.cjs','utf8'),pk=fs.readFileSync(__dirname+'/../../store-next/packing.html','utf8');
 assert.match(core,/async function setStock\(s,p,stock\)\{int\(stock\);\{const before=Number\(p\.stock\)\|\|0;if\(before!==stock\)await inventory\.logMove/);assert.match(core,/path\.startsWith\('\/admin\/inventory'\)/);assert.match(core,/inventory\.run\(\{path:args/);
 assert.match(pk,/data-view="count"/);assert.match(pk,/\/api\/admin\/inventory\/count/);assert.match(pk,/data-receive/)});

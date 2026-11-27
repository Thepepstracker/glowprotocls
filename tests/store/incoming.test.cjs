'use strict';
// Incoming stock from the supplier ERP → Packing Check pack plan (Jonah, 27 Nov 2026).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const inc=require('../../netlify/functions/lib/incoming.cjs');
function memory(data={}){const r=new Map(Object.entries(data).map(([k,rows])=>[k,new Map(rows.map((x,i)=>[String(x.id??i),structuredClone(x)]))]));return{get:async(k,id)=>structuredClone(r.get(k)?.get(String(id))||null),put:async(k,id,v)=>{if(!r.has(k))r.set(k,new Map());r.get(k).set(String(id),structuredClone(v))},list:async k=>structuredClone([...(r.get(k)?.values()||[])])}}
const products=[{id:7,name:'GHK-Cu · 100 mg'},{id:8,name:'KLOW · 80 mg'}];
test('saves a cleaned list and reads it back; unknown products are kept as not matched',async()=>{const s=memory({products});
 const r=await inc.route(s,'/admin/incoming',{source:'JKL ERP',checked_at:1795800000,shipments:[{ref:'SO-1',status:'out_for_delivery',carrier:'UPS',eta:'2026-11-28',lines:[{name:'CU100',qty:40,product_id:7},{name:'Mystery 5mg',qty:10,product_id:999}]},{ref:'SO-2',status:'ordered',eta:'2026-12-02',lines:[{name:'Klow80',qty:20,product_id:8}]}]},'POST','owner',1795801000);
 assert.deepEqual(r,{ok:true,shipments:2,lines:3,unmatched:1});
 const g=await inc.route(s,'/admin/incoming',{},'GET','owner');assert.equal(g.source,'JKL ERP');assert.equal(g.checked_at,1795800000);assert.equal(g.saved_by,'owner');
 assert.equal(g.shipments[0].lines[1].product_id,null);assert.equal(g.shipments[1].eta,'2026-12-02')});
test('rejects bad input instead of saving half of it',async()=>{const s=memory({products});
 await assert.rejects(inc.route(s,'/admin/incoming',{shipments:[{status:'lost',lines:[{name:'x',qty:1}]}]},'POST','owner'),/status must be/);
 await assert.rejects(inc.route(s,'/admin/incoming',{shipments:[{status:'ordered',lines:[{name:'x',qty:0}]}]},'POST','owner'),/whole number/);
 await assert.rejects(inc.route(s,'/admin/incoming',{shipments:[{status:'ordered',lines:[]}]},'POST','owner'),/no items/);
 assert.equal(await s.get('integrations','incoming'),null)});
test('empty before the first check',async()=>{const g=await inc.route(memory({products}),'/admin/incoming',{},'GET','owner');assert.deepEqual(g.shipments,[])});
test('wired into the store and Packing Check',()=>{const core=fs.readFileSync(__dirname+'/../../netlify/functions/lib/store-core.cjs','utf8'),pk=fs.readFileSync(__dirname+'/../../store-next/packing.html','utf8');
 assert.match(core,/path==='\/admin\/incoming'/);assert.match(pk,/fetch\('\/api\/admin\/incoming'/);assert.match(pk,/function buildPlan\(\)/);assert.match(pk,/planTag\(o\)/)});

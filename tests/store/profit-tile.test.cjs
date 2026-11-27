'use strict';
// Profit this month on Management → Today (Jonah, 27 Nov 2026).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const reports=require('../../netlify/functions/lib/business-reports.cjs');
const ts=s=>Date.parse(s)/1000,when=ts('2026-11-20T18:00:00Z');
function memory(data={}){const records=new Map(Object.entries(data).map(([kind,rows])=>[kind,new Map(rows.map((r,i)=>[String(r.id??i),structuredClone(r)]))]));return{get:async(k,id)=>structuredClone(records.get(k)?.get(String(id))||null),put:async(k,id,v)=>{if(!records.has(k))records.set(k,new Map());records.get(k).set(String(id),structuredClone(v))},list:async k=>structuredClone([...(records.get(k)?.values()||[])]),remove:async(k,id)=>records.get(k)?.delete(String(id))}}
const order=(o={})=>({id:'GLP-0000000001',is_test:false,brand:'glow',created:ts('2026-11-10T16:00:00Z'),paid:ts('2026-11-10T16:00:00Z'),status:'shipped',subtotal:10000,discount:0,shipping:1500,tax:0,total:11500,verified_payment_cents:11500,commission:500,label_cost_cents:1200,tracking:'1Z',customer:{name:'A',email:'a@example.test'},payment_method:'zelle',items:[{id:1,name:'Serum A',sku:'a',quantity:1,price:10000,amount:10000}],...o});
const cost=(id,c)=>({id:id+':2026-01-01',product_id:id,effective_date:'2026-01-01',unit_cost_cents:c,revision:1});
const catalog=[{id:1,name:'Serum A',sku:'a',stock:5,brand:'glow'},{id:2,name:'Serum B',sku:'b',stock:5,brand:'glow'}];
test('profit = sales − product cost − labels − commission − card fees − bills, with every part shown',async()=>{
 const s=memory({products:catalog,orders:[order(),order({id:'GLP-0000000002',payment_method:'card_invoice'})],report_costs:[cost(1,3000)],report_expenses:[{id:'e1',date:'2026-11-05',vendor:'Meta',category:'marketing',brand:'glow',amount_cents:30000,revision:1}]});
 const p=await reports.profit(s,{brand:'glow'},when);
 assert.equal(p.sales,23000);assert.equal(p.product_cost,6000);assert.equal(p.labels,2400);assert.equal(p.commission,1000);
 assert.equal(p.card_fees,Math.round(11500*0.029)+30);assert.ok(p.card_fees_estimated);assert.equal(p.bills,30000);
 assert.equal(p.profit,23000-6000-2400-1000-p.card_fees-30000);assert.equal(p.product_cost_estimated,false);assert.equal(p.start,'2026-11-01');assert.equal(p.end,'2026-11-20')});
test('card fees entered in Reports replace the estimate, and are not counted twice as a bill',async()=>{
 const s=memory({products:catalog,orders:[order({payment_method:'card_checkout'})],report_costs:[cost(1,3000)],report_expenses:[{id:'f',date:'2026-11-06',vendor:'Stripe',category:'fees',brand:'glow',amount_cents:400,revision:1}]});
 const p=await reports.profit(s,{brand:'glow'},when);assert.equal(p.card_fees,400);assert.equal(p.card_fees_estimated,false);assert.equal(p.bills,0);assert.equal(p.profit,11500-3000-1200-500-400)});
test('a product with no cost saved is counted at the known cost rate and named, marked as an estimate',async()=>{
 const s=memory({products:catalog,orders:[order(),order({id:'GLP-0000000002',items:[{id:2,name:'Serum B',sku:'b',quantity:1,price:10000,amount:10000}]})],report_costs:[cost(1,3000)]});
 const p=await reports.profit(s,{brand:'glow'},when);assert.equal(p.product_cost_estimated,true);assert.equal(p.product_cost,6000);assert.equal(p.missing_count,1);assert.deepEqual(p.missing_costs,['Serum B']);assert.equal(p.known_cost_share,50)});
test('no costs saved at all: no profit number is made up',async()=>{
 const s=memory({products:catalog,orders:[order(),order({id:'GLP-0000000003',items:[]})]});const p=await reports.profit(s,{brand:'glow'},when);assert.equal(p.profit,null);assert.equal(p.kept_cents_per_dollar,null)});
test('the tile is owner-only and lives on Today',()=>{const core=fs.readFileSync(__dirname+'/../../netlify/functions/lib/store-core.cjs','utf8'),app=fs.readFileSync(__dirname+'/../../store-next/app.js','utf8');
 assert.match(core,/\/admin\/profit'&&method==='GET'\)\{if\(!owner\)fail/);assert.match(app,/function profitCard\(\)\{const d=state.admin;if\(d.owner===false/);assert.match(app,/\$\{profitCard\(\)\}/)});

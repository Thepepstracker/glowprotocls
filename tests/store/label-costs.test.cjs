'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const reports=require('../../netlify/functions/lib/business-reports.cjs');
const ts=s=>Date.parse(s)/1000;
const when=ts('2026-10-15T18:00:00Z');
function memory(data={}){const records=new Map(Object.entries(data).map(([kind,rows])=>[kind,new Map(rows.map((r,i)=>[String(r.id??i),structuredClone(r)]))]));return{get:async(k,id)=>structuredClone(records.get(k)?.get(String(id))||null),put:async(k,id,v)=>{if(!records.has(k))records.set(k,new Map());records.get(k).set(String(id),structuredClone(v))},list:async k=>structuredClone([...(records.get(k)?.values()||[])]),remove:async(k,id)=>records.get(k)?.delete(String(id))}}
const order=(overrides={})=>({id:'GLP-0000000001',is_test:false,brand:'glow',created:ts('2026-10-01T16:00:00Z'),paid:ts('2026-10-02T16:00:00Z'),status:'paid',subtotal:10000,discount:1500,coupon_discount:1000,rewards_discount:500,shipping:1500,tax:0,total:10000,verified_payment_cents:10000,commission:850,customer:{name:'Example Buyer',email:'example@example.test',state:'GA'},affiliate:'friend',coupon:'HELLO',payment_method:'zelle',items:[{id:1,name:'Example A',sku:'sku-a',quantity:1,price:6000,amount:6000},{id:2,name:'Example B',sku:'sku-b',quantity:2,price:2000,amount:4000}],...overrides});
const catalog=[{id:1,name:'Example A',sku:'sku-a',stock:7,brand:'glow'},{id:2,name:'Example B',sku:'sku-b',stock:8,brand:'glow'}];
const cost=(id,cents=100,effective_date='2026-01-01')=>({id:id+':'+effective_date,product_id:id,effective_date,unit_cost_cents:cents,revision:1});
const query={start:'2026-10-01',end:'2026-10-31',brand:'all'};
test('Shippo label costs come off operating profit, including replacement labels; unknown label costs are counted, not guessed',async()=>{
 const a=order({id:'GLP-00000000A1',status:'shipped',tracking:'1ZA',shipment:{label_cost_cents:1275},replacements:[{label_cost_cents:900}]});
 const b=order({id:'GLP-00000000B2',status:'shipped',tracking:'1ZB',label_cost_cents:1467});
 const c=order({id:'GLP-00000000C3',status:'shipped',tracking:'1ZC'});
 const base=await reports.build(memory({products:catalog,orders:[order()],report_costs:[cost(1),cost(2)]}),query,when);
 const r=await reports.build(memory({products:catalog,orders:[a,b,c],report_costs:[cost(1),cost(2)]}),query,when);
 assert.equal(r.pnl.label_costs,1275+900+1467);
 assert.equal(r.pnl.label_costs_missing,1);
 assert.equal(r.orders.find(o=>o.id==='GLP-00000000A1').label_cost,2175);
 assert.equal(r.orders.find(o=>o.id==='GLP-00000000C3').label_cost,null);
 const perOrder=base.pnl.operating_profit;assert.equal(r.pnl.operating_profit,perOrder*3-(1275+900+1467));
});

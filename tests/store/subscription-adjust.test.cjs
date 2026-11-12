'use strict';
// A subscription package edited by staff keeps its 15% off (12 Nov 2026: GLP-BE9E0EBC69 lost it on an item edit,
// so the order said $160.98 while Stripe had correctly taken $136.83).
const test=require('node:test'),assert=require('node:assert');
const adjustments=require('../../netlify/functions/lib/order-adjustments.cjs');
function store(seed){const t=new Map();for(const[k,v]of Object.entries(seed))t.set(k,new Map(Object.entries(v)));const tab=n=>{if(!t.has(n))t.set(n,new Map());return t.get(n)};
 return{get:async(n,id)=>{const v=tab(n).get(String(id));return v?JSON.parse(JSON.stringify(v)):null},put:async(n,id,v)=>{tab(n).set(String(id),JSON.parse(JSON.stringify(v)))},del:async(n,id)=>{tab(n).delete(String(id))},delete:async(n,id)=>{tab(n).delete(String(id))},list:async n=>[...tab(n).values()].map(v=>JSON.parse(JSON.stringify(v)))}}
const products={24:{id:24,name:'AICAR · 50 mg',sku:'aicar-50-mg',price:5200,stock:10,active:1},1:{id:1,name:'Lipo-C',sku:'lipo-c',price:4399,stock:10,active:1},141:{id:141,name:'MOTS-C · 20 mg',sku:'mots-c-20-mg',price:6499,stock:10,active:1}};
const line=(p,q=1)=>({id:p.id,name:p.name,sku:p.sku,quantity:q,price:p.price,amount:p.price*q});
function order(extra={}){const items=[line(products[24]),line(products[1]),line(products[141])];return{id:'GLP-SUBADJ',status:'order_received',is_test:true,items,subtotal:16098,subscription_discount:2415,discount:2415,coupon_discount:0,rewards_discount:0,shipping:0,tax:0,total:13683,commission:0,revision:0,subscription_id:'SUB-X',subscription_first:true,...extra}}
const setStock=async()=>{};
test('editing a subscription package with the same items keeps the 15% off',async()=>{
 const s=store({products});const o=order();const r=await adjustments.edit(s,o,{expected_revision:0,reason:'check',items:o.items.map(i=>({id:i.id,quantity:i.quantity,price:i.price})),coupon_discount:0,shipping:0,tax:0},'owner',setStock);
 const x=r.order||r||o;assert.equal(x.subtotal,16098);assert.equal(x.subscription_discount,2415);assert.equal(x.discount,2415);assert.equal(x.total,13683)});
test('changing a quantity re-prices the subscription discount at 15%',async()=>{
 const s=store({products});const o=order();const items=[{id:24,quantity:2,price:5200},{id:1,quantity:1,price:4399},{id:141,quantity:1,price:6499}];
 const r=await adjustments.edit(s,o,{expected_revision:0,reason:'add one',items,coupon_discount:0,shipping:0,tax:0},'owner',setStock);const x=r.order||r||o;
 assert.equal(x.subtotal,21298);assert.equal(x.total,4420*2+3739+5524);assert.equal(x.subscription_discount,21298-x.total)});
test('a normal order is unchanged by this',async()=>{
 const s=store({products});const o=order({subscription_discount:undefined,subscription_id:undefined,subscription_first:undefined,discount:0,total:16098});delete o.subscription_discount;
 const r=await adjustments.edit(s,o,{expected_revision:0,reason:'check',items:o.items.map(i=>({id:i.id,quantity:i.quantity,price:i.price})),coupon_discount:0,shipping:0,tax:0},'owner',setStock);const x=r.order||r||o;
 assert.equal(x.discount,0);assert.equal(x.total,16098);assert.equal(x.subscription_discount,undefined)});

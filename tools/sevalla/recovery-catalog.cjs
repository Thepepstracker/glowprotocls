'use strict';
const fs=require('node:fs'),path=require('node:path');
const {seedData}=require('../store/seed-data.cjs');
const {withProductPhotos}=require('../../netlify/functions/lib/product-photos.cjs');
const merch=require('../../netlify/functions/lib/merch-catalog.cjs');
const OPENING_STOCK='glow-shirts-opening-stock-10-20261014-v1';
function recoveryProducts(){
 const sql=fs.readFileSync(path.resolve(__dirname,'../../netlify/database/migrations/0001_glow_store.sql'),'utf8'),products=[];
 for(const m of sql.matchAll(/VALUES \('products','\d+','((?:[^']|'')*)'\)/g))products.push(JSON.parse(m[1].replaceAll("''","'")));
 if(products.length!==58)throw new Error('Unexpected original catalog; review recovery import before use.');
 let next=Math.max(...products.map(p=>p.id));const skus=new Set(products.map(p=>p.sku));
 for(const p of seedData().products){if(skus.has(p.sku))continue;products.push({...p,id:++next});skus.add(p.sku)}
 products.push({id:++next,name:'Glow Fuel',sku:'GLOW-FUEL-120MG',slug:'glow-fuel',image:'/img/glow-fuel.webp',price:7900,regular_price:11000,intro_price:7900,intro_active:true,spotlight:true,spotlight_headline:'Glow Fuel',spotlight_copy:'One vial · MOTS-C 10 mg · 5-Amino-1MQ 10 mg · NAD+ 100 mg.',spotlight_note:'While supplies last',promo_excluded:true,active:1});
 return products.map(p=>({...withProductPhotos(p),brand:'glow',stock:0,recovery_review_required:true,source:'Recovery from repository; price and stock require owner verification'}));
}
async function prepareRecovery(s){
 if(await s.get('settings','main')||(await s.list('products')).length||(await s.list('orders')).length||(await s.list('customers')).length)throw new Error('Recovery initialization requires an empty database. Existing data was not changed.');
 const products=recoveryProducts();for(const p of products)await s.put('products',p.id,p);
 await s.put('migrations',OPENING_STOCK,{applied:Math.floor(Date.now()/1000),skipped_for_recovery:true});
 await merch.ensureMerchCatalog(s);
 await s.put('settings','main',{shipping_cents:1500,free_shipping_cents:25000,demo:false,checkout_enabled:false,tax_mode:'unconfigured',payment_links:{venmo:'',paypal:'',cashapp:'',zelle:''},recovery_pending:true});
 await s.put('migrations','sevalla-recovery-catalog-v1',{applied:Math.floor(Date.now()/1000),source_commit:'11bce3602049d3498df9e82a8deb498c48eedb12',stock_verified:false});
 return{products:(await s.list('products')).length,checkout_enabled:false,stock:0};
}
if(require.main===module){
 if(!process.env.STORE_DATABASE_URL||process.env.STORE_LOCAL){console.error('Configure the NEW private Sevalla STORE_DATABASE_URL; local/demo mode is not allowed.');process.exitCode=1}
 else require('../../netlify/functions/lib/store-db.cjs').transaction(prepareRecovery).then(result=>{console.log(JSON.stringify(result));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)});
}
module.exports={recoveryProducts,prepareRecovery};

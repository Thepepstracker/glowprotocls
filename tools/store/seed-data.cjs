'use strict';
const fs=require('node:fs'),path=require('node:path');
const {priceCatalog}=require('../../netlify/functions/lib/pricing.js');
function seedData(){
 const root=path.resolve(__dirname,'../..'),cat=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8')),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 const match=html.match(/const PRODUCTS = (\[.*?\]);/s);const descriptions=match?JSON.parse(match[1]):[];const priced=priceCatalog(cat);let id=0;const products=[];
 for(const [slug,p] of Object.entries(cat.products||{})){
  const display=descriptions.find(d=>d.slug===slug)||{},prices=priced.price[slug];
  const sizes=prices.sizes?.length?prices.sizes:[{s:display.dose||'',now:prices.now}];
  for(const z of sizes){if(!(z.now>0))continue;products.push({id:++id,name:p.name+(z.s?' · '+z.s:''),sku:slug+(z.s?'-'+z.s.toLowerCase().replace(/[^a-z0-9]+/g,'-'):''),slug,size:z.s,price:Math.round(z.now*100),stock:10,active:1,image:display.img?'/'+display.img.replace(/^\//,''):'/product-images/product-placeholder.svg',source:'repository catalog; demonstration stock'});}
 }
 for(const [key,b]of Object.entries(cat.bundles||{}))for(const z of priced.bundles[key]||[]){if(z.now>0)products.push({id:++id,name:(b.name||'Bundle '+key)+' · '+z.s,sku:'bundle-'+key+'-'+z.s.toLowerCase().replace(/[^a-z0-9]+/g,'-'),price:Math.round(z.now*100),stock:10,active:1,image:'/product-images/product-placeholder.svg',source:'repository catalog; demonstration stock',bundle:key,size:z.s});}
 return{products,settings:{shipping_cents:Math.round((cat.shipping?.flat??15)*100),free_shipping_cents:Math.round((cat.shipping?.free_over??250)*100),demo:true,tax_note:'Tax is not configured. This is a test order.',payment_links:{venmo:'',paypal:'',cashapp:'',zelle:''}},affiliates:[{slug:'sarah',name:'Sarah — Sample Affiliate',bio:'A demonstration affiliate storefront, sharing the same product catalog.',commission_bps:1500,goaffpro_id:'',active:1}],coupons:[{code:'DEMO20',kind:'percent',value:20,minimum:0,max_uses:100,used:0,expires:0,active:1}]};
}
async function seed(store){if(await store.get('settings','main'))return false;const data=seedData();for(const p of data.products)await store.put('products',p.id,p);for(const a of data.affiliates)await store.put('affiliates',a.slug,a);for(const c of data.coupons)await store.put('coupons',c.code,c);await store.put('settings','main',data.settings);return true}
module.exports={seedData,seed};

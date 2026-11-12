'use strict';
const brands=require('./brands.cjs');
const fail=message=>{throw Object.assign(new Error(message),{status:400})};
const unavailable='Coupon is unavailable or expired.';
const limited=c=>Array.isArray(c.products)&&c.products.length>0;
// Set-price bundles (FAMILY, Jonah 12 Nov 2026): a coupon can hold bundles [{ids:[...], price:cents}]. With bundles, the
// code needs one bundle's products in the bag and brings one of each of them to that bundle's price (the best one wins).
const bundled=c=>Array.isArray(c.bundles)&&c.bundles.length>0;
async function pickBundle(s,code,c,items){
 const unit=id=>{const i=items.find(x=>x.id===id);return i&&!i.promo_excluded?i.price:null};
 let best=null;for(const b of c.bundles){const u=b.ids.map(unit);if(u.some(v=>v==null))continue;const discount=Math.max(0,u.reduce((n,v)=>n+v,0)-b.price);if(!best||discount>best.discount)best={ids:b.ids,discount}}
 if(best)return best;
 let near=c.bundles[0],have=-1;for(const b of c.bundles){const n=b.ids.filter(id=>items.some(i=>i.id===id)).length;if(n>have){have=n;near=b}}
 const missing=[];for(const id of near.ids)if(!items.some(i=>i.id===id)){const p=await s.get('products',id);missing.push(p?p.name:'a product')}
 fail(code+' only works with '+near.ids.length+' item'+(near.ids.length>1?'s':'')+' in your bag. Add: '+(missing.length?missing.join(', '):'the matching items')+'.');
}
function codes(input={}){
 let raw;if(input.coupons!==undefined){if(!Array.isArray(input.coupons))fail('Send coupon codes as a list.');raw=input.coupons}else if(input.coupon){if(typeof input.coupon!=='string')fail('Invalid coupon code.');raw=[input.coupon]}else raw=[];
 const result=[];for(const value of raw){if(typeof value!=='string'||!value.trim()||value.trim().length>40)fail('Enter coupon codes of 1–40 characters.');const code=value.trim().toUpperCase();if(result.includes(code))fail('Each coupon can only be applied once per order.');result.push(code)}return result;
}
async function apply(s,input,brand,subtotal,eligible,now,items=[]){
 const list=codes(input),coupons=[],picked=new Map();if(list.length>2)fail('Use no more than two coupon codes per order.');
 for(const code of list){const c=await s.get('coupons',code);if(!c||brands.couponBrand(c)!==brand.id||!c.active||c.used>=c.max_uses||(c.expires&&c.expires<=now))fail(unavailable);if(subtotal<c.minimum)fail('Cart does not meet the coupon minimum.');
  // A coupon limited to products needs every one of them in the bag, and only takes money off those lines.
  if(bundled(c)){picked.set(c.code,await pickBundle(s,code,c,items))}
  else if(limited(c)){const missing=[];for(const id of c.products)if(!items.some(i=>i.id===id)){const p=await s.get('products',id);missing.push(p?p.name:'a product')}if(missing.length)fail(code+' only works with '+c.products.length+' item'+(c.products.length>1?'s':'')+' in your bag. Add: '+missing.join(', ')+'.')}
  coupons.push(c)}
 if(coupons.length>1&&coupons.some(c=>c.allow_stacking!==true))fail('These coupon codes cannot be used together. Remove a code or use coupons that both allow other offers.');
 const affiliates=[...new Set(coupons.map(c=>c.affiliate).filter(Boolean))];if(affiliates.length>1)fail('Coupons from different affiliates cannot be combined.');
 // A deterministic sequence prevents entering codes in a different order changing the price.
 const ordered=coupons.slice().sort((a,b)=>(a.kind==='percent'?0:1)-(b.kind==='percent'?0:1)||a.code.localeCompare(b.code));let remaining=eligible;const breakdown=[];
 for(const c of ordered){if(picked.has(c.code)){const discount=Math.min(remaining,picked.get(c.code).discount);remaining-=discount;breakdown.push({code:c.code,kind:'bundle',value:discount,discount});continue}const base=limited(c)?Math.min(remaining,items.filter(i=>c.products.includes(i.id)&&!i.promo_excluded).reduce((n,i)=>n+i.amount,0)):remaining;const discount=Math.min(base,c.kind==='percent'?Math.floor(base*c.value/100):c.value);remaining-=discount;breakdown.push({code:c.code,kind:c.kind,value:c.value,discount})}
 return{coupon:list[0]||null,coupons:list,coupon_discounts:breakdown,coupon_discount:eligible-remaining,coupon_affiliate:affiliates[0]||''};
}
async function reserve(s,order,delta){for(const code of codes(order)){const c=await s.get('coupons',code);if(c){c.used=Math.max(0,c.used+delta);await s.put('coupons',c.code,c)}}}
function stackingValue(body,old){if(body.allow_stacking!==undefined&&typeof body.allow_stacking!=='boolean')fail('Choose Yes or No for combining this coupon with other offers.');return body.allow_stacking??(old?.allow_stacking===true)}
// Admin input: SKUs separated by commas -> product ids in this store. Leaving the field out keeps what was saved.
async function productsValue(s,body,old,brandId){if(body.products===undefined)return Array.isArray(old?.products)?old.products:[];if(typeof body.products!=='string'||body.products.length>600)fail('List the products as SKUs separated by commas.');const skus=[...new Set(body.products.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean))];if(skus.length>20)fail('Limit a coupon to 20 products or fewer.');if(!skus.length)return [];const all=await s.list('products'),ids=[];for(const sku of skus){const p=all.find(x=>String(x.sku).toLowerCase()===sku&&brands.productBrand(x)===brandId);if(!p)fail('No product in this store has the SKU '+sku+'.');ids.push(p.id)}return ids}
// Admin input for bundles: "sku + sku = 20.00; sku + sku = 35.00". Leaving the field out keeps what was saved; "" clears.
async function bundlesValue(s,body,old,brandId){if(body.bundles===undefined)return Array.isArray(old?.bundles)?old.bundles:[];if(typeof body.bundles!=='string'||body.bundles.length>2000)fail('List bundles as "sku + sku = price; ...".');const parts=body.bundles.split(';').map(x=>x.trim()).filter(Boolean);if(parts.length>20)fail('Limit a coupon to 20 bundles or fewer.');const all=await s.list('products'),out=[];
 for(const part of parts){const m=part.match(/^(.+?)=\s*\$?\s*(\d+(?:\.\d{1,2})?)$/);if(!m)fail('Write each bundle as "sku + sku = price": '+part);const skus=[...new Set(m[1].split('+').map(x=>x.trim().toLowerCase()).filter(Boolean))];if(!skus.length||skus.length>10)fail('A bundle needs 1 to 10 products: '+part);const ids=[];for(const sku of skus){const p=all.find(x=>String(x.sku).toLowerCase()===sku&&brands.productBrand(x)===brandId);if(!p)fail('No product in this store has the SKU '+sku+'.');ids.push(p.id)}out.push({ids,price:Math.round(Number(m[2])*100)})}
 return out}
module.exports={codes,apply,reserve,stackingValue,productsValue,bundlesValue,limited,bundled};

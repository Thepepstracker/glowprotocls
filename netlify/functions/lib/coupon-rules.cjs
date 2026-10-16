'use strict';
const brands=require('./brands.cjs');
const fail=message=>{throw Object.assign(new Error(message),{status:400})};
const unavailable='Coupon is unavailable or expired.';
function codes(input={}){
 let raw;if(input.coupons!==undefined){if(!Array.isArray(input.coupons))fail('Send coupon codes as a list.');raw=input.coupons}else if(input.coupon){if(typeof input.coupon!=='string')fail('Invalid coupon code.');raw=[input.coupon]}else raw=[];
 if(raw.length>5)fail('Use up to five coupon codes per order.');const result=[];for(const value of raw){if(typeof value!=='string'||!value.trim()||value.trim().length>40)fail('Enter coupon codes of 1–40 characters.');const code=value.trim().toUpperCase();if(result.includes(code))fail('Each coupon can only be applied once per order.');result.push(code)}return result;
}
async function apply(s,input,brand,subtotal,eligible,now){
 const list=codes(input),coupons=[];
 for(const code of list){const c=await s.get('coupons',code);if(!c||brands.couponBrand(c)!==brand.id||!c.active||c.used>=c.max_uses||(c.expires&&c.expires<=now))fail(unavailable);if(subtotal<c.minimum)fail('Cart does not meet the coupon minimum.');coupons.push(c)}
 if(coupons.length>1&&coupons.some(c=>c.allow_stacking!==true))fail('These coupon codes cannot be used together. Remove a code or use coupons that both allow other offers.');
 const affiliates=[...new Set(coupons.map(c=>c.affiliate).filter(Boolean))];if(affiliates.length>1)fail('Coupons from different affiliates cannot be combined.');
 // A deterministic sequence prevents entering codes in a different order changing the price.
 const ordered=coupons.slice().sort((a,b)=>(a.kind==='percent'?0:1)-(b.kind==='percent'?0:1)||a.code.localeCompare(b.code));let remaining=eligible;const breakdown=[];
 for(const c of ordered){const discount=Math.min(remaining,c.kind==='percent'?Math.floor(remaining*c.value/100):c.value);remaining-=discount;breakdown.push({code:c.code,kind:c.kind,value:c.value,discount})}
 return{coupon:list[0]||null,coupons:list,coupon_discounts:breakdown,coupon_discount:eligible-remaining,coupon_affiliate:affiliates[0]||''};
}
async function reserve(s,order,delta){for(const code of codes(order)){const c=await s.get('coupons',code);if(c){c.used=Math.max(0,c.used+delta);await s.put('coupons',c.code,c)}}}
function stackingValue(body,old){if(body.allow_stacking!==undefined&&typeof body.allow_stacking!=='boolean')fail('Choose Yes or No for combining this coupon with other offers.');return body.allow_stacking??(old?.allow_stacking===true)}
module.exports={codes,apply,reserve,stackingValue};

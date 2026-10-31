'use strict';
// Only the three single-vial Glow flash-sale variants are capped. Other strengths,
// kits and brands retain their existing quantity and inventory rules.
const FLASH_GROUP='glow-13-flash-sale';
const FLASH_MESSAGE='Limit 3 sale vials total per order. Mix and match.';
const FLASH_SKUS=new Set(['selank-5-mg','semax-5-mg','ghk-cu-100-mg']);
function maxOrderQuantity(p){
 if((p.brand||'glow')!=='glow'||(p.units||1)!==1||p.components?.length)return null;
 return FLASH_SKUS.has(String(p.sku||'').trim().toLowerCase())?3:null;
}
function publicLimits(p){const max=maxOrderQuantity(p);return max?{...p,max_order_quantity:max,purchase_limit_group:FLASH_GROUP,max_group_quantity:3}:p}
module.exports={maxOrderQuantity,publicLimits,FLASH_GROUP,FLASH_MESSAGE};

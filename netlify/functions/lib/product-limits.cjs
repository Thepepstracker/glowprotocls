'use strict';
// Flash-sale quantity cap. The Oct 31 2026 sale (Selank 5, Semax 5, GHK-Cu 100 at $13, 3 vials max)
// is over, so no SKU is capped now. To cap a future sale, list its single-vial SKUs here.
const FLASH_GROUP='glow-13-flash-sale';
const FLASH_MESSAGE='Limit 3 sale vials total per order. Mix and match.';
const FLASH_SKUS=new Set([]);
function maxOrderQuantity(p){
 if((p.brand||'glow')!=='glow'||(p.units||1)!==1||p.components?.length)return null;
 return FLASH_SKUS.has(String(p.sku||'').trim().toLowerCase())?3:null;
}
function publicLimits(p){const max=maxOrderQuantity(p);return max?{...p,max_order_quantity:max,purchase_limit_group:FLASH_GROUP,max_group_quantity:3}:p}
module.exports={maxOrderQuantity,publicLimits,FLASH_GROUP,FLASH_MESSAGE};

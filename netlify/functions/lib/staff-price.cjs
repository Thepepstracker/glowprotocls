'use strict';
// Staff price on "Order for a customer" (Jonah, 13 Nov 2026: Jen French, "add 10% off … no shipping"). A signed-in team
// member can take a percent off the products and/or drop shipping on an order they place for a customer. It is applied
// before the order is saved, so the order email and the card invoice already show the right total. It is folded into the
// promo discount, so a later item edit keeps it. Never available to customers (only the assisted, staff-session path).
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function parse(v){if(v==null||v===false)return null;if(typeof v!=='object')fail('Staff price is not valid.');
 const pct=v.pct==null||v.pct===''?0:Number(v.pct),noShip=v.no_shipping===true;
 if(!Number.isInteger(pct)||pct<0||pct>50)fail('Staff discount must be a whole percent from 0 to 50.');
 return pct||noShip?{pct,no_shipping:noShip}:null}
// q is a quote from store-core quote(): mutated in place.
function apply(q,sp){const basis=q.subtotal-q.discount;const off=Math.min(basis,Math.round(basis*sp.pct/100));
 const bps=q.commission&&basis>0?Math.round(q.commission*10000/basis):0;
 q.discount+=off;q.coupon_discount=(q.coupon_discount||0)+off;
 const waived=sp.no_shipping?q.shipping:0;if(sp.no_shipping)q.shipping=0;
 q.total=q.subtotal-q.discount+q.shipping+(q.tax||0);
 if(q.points_to_earn)q.points_to_earn=Math.floor(Math.floor((q.subtotal-q.discount)/100)*(q.points_multiplier||1));
 if(q.commission)q.commission=Math.floor((q.subtotal-q.discount)*bps/10000);
 q.staff_price={pct:sp.pct,discount_cents:off,no_shipping:sp.no_shipping,shipping_waived_cents:waived};return q}
module.exports={parse,apply};

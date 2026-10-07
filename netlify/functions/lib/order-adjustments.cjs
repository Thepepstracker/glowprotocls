'use strict';
const accounts=require('./customer-accounts.cjs');
const now=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const integer=(v,min=0,max=10000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('Enter valid whole numbers for quantities and cents.');return v};
function check(o,b){if(!o)fail('Order not found.',404);if(!['order_received','awaiting_payment','payment_submitted','paid'].includes(o.status))fail('Reinstate expired orders first. Shipped and canceled orders cannot be edited.',409);if(b.expected_revision!==(o.revision||0))fail('This order changed. Reopen it before saving.',409);if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500)fail('Enter a reason for this adjustment.');}
async function syncRewards(s,o){if(o.is_test!==false||!o.customer_id||!o.paid)return;const a=await s.get('customers',o.customer_id);if(!a?.verified)return;const earned=Math.floor((o.subtotal-o.discount)/100);if((o.balance_due_cents||0)>0&&earned>(o.points_earned||0))return;const delta=earned-(o.points_earned||0);if(delta)await accounts.event(s,o.customer_id,'order-adjustment:'+o.id+':'+o.revision,'order_adjustment',delta,0,o.id,'Rewards corrected after order adjustment');o.points_earned=earned;}
async function edit(s,o,b,actor,setStock){
 check(o,b);if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Keep at least one product on the order.');
 const seen=new Set(),items=[],changes=new Map();let subtotal=0;
 const group=(p,delta)=>{const key=p.stock_pool?'pool:'+p.stock_pool:'product:'+p.id;const c=changes.get(key)||{p,delta:0};c.delta+=delta;changes.set(key,c)};
 for(const line of o.items){const p=await s.get('products',line.id);if(!p)fail('An original product is missing. Review inventory first.',409);group(p,line.quantity)}
 for(const line of b.items){integer(line.id,1);if(seen.has(line.id))fail('Duplicate product on the order.');seen.add(line.id);const quantity=integer(line.quantity,1,100),price=integer(line.price);const p=await s.get('products',line.id),previous=o.items.find(i=>i.id===line.id);if(!p||(!p.active&&!previous))fail('A product is unavailable.',409);const amount=quantity*price;subtotal+=amount;items.push({id:p.id,name:previous?.name||p.name,sku:previous?.sku||p.sku,quantity,price,amount});group(p,-quantity)}
 integer(subtotal);const coupon_discount=integer(b.coupon_discount),shipping=integer(b.shipping),tax=integer(b.tax),rewards_discount=o.rewards_discount||0,discount=coupon_discount+rewards_discount;
 if(discount>subtotal)fail('Discounts cannot exceed the product subtotal. Reduce the promo discount or keep enough products for the reserved rewards.');
 const total=integer(subtotal-discount+shipping+tax);for(const {p,delta} of changes.values())if(p.stock+delta<0)fail('Not enough available stock for '+p.name+'.',409);
 // Do not change an order while an external transfer has an active or uncertain attempt.
 for(const provider of ['shipstation','goaffpro']){const job=await s.get('outbox',provider+'-'+o.id);if(job&&(job.lease_until>now()||job.post_started&&job.status!=='synced'||['sending','uncertain','needs_review'].includes(job.status)))fail('Check the '+provider+' transfer before changing this order.',409);}
 const before={items:o.items,subtotal:o.subtotal,discount:o.discount,shipping:o.shipping,tax:o.tax,total:o.total};
 const paid=!!o.paid;if(paid&&o.verified_payment_cents==null)o.verified_payment_cents=o.total;
 if(!paid)await accounts.release(s,o);
 const oldBasis=o.subtotal-o.discount,affiliate=o.affiliate&&await s.get('affiliates',o.affiliate);const rate=o.commission_bps??affiliate?.commission_bps??(oldBasis?Math.round(o.commission*10000/oldBasis):0);
 Object.assign(o,{items,subtotal,coupon_discount,discount,shipping,tax,total,points_to_earn:Math.floor((subtotal-discount)/100),commission:Math.floor((subtotal-discount)*rate/10000),commission_bps:rate,revision:(o.revision||0)+1,updated:now()});
 if(!paid){o.reservation_version=Math.max(o.reservation_version||0,o.revision-1)+1;await accounts.reserve(s,o)}
 else {o.balance_due_cents=Math.max(0,total-o.verified_payment_cents);o.refund_due_cents=Math.max(0,o.verified_payment_cents-total);await syncRewards(s,o)}
 for(const {p,delta} of changes.values())if(delta)await setStock(s,p,p.stock+delta);
 if(o.shipstation_order_id){o.shipstation_needs_review=true;o.shipstation_status='needs_review';o.shipstation_message='Order changed. Update the existing order in ShipStation and confirm review before shipping.';}
 if(o.goaffpro_status==='synced'||o.goaffpro_remote_id){o.goaffpro_needs_review=true;o.goaffpro_status='needs_review';o.goaffpro_message='Order changed. Review the existing sale and commission in GoAffPro.';}
 o.adjustments=[...(o.adjustments||[]),{created:now(),actor,reason:b.reason.trim(),before,after:{items,total,subtotal,discount,shipping,tax},revision:o.revision}];
 await s.put('orders',o.id,o);return o;
}
async function recordPayment(s,o,b,actor){check(o,b);if(!o.paid||b.verified!==true)fail('Confirm the actual payment or refund in the receiving account.');const payment=integer(b.payment_cents),refund=integer(b.refund_cents);if(!payment&&!refund||payment&&refund)fail('Record either a payment or a refund.');if(payment>(o.balance_due_cents||0)||refund>(o.refund_due_cents||0))fail('The amount exceeds the outstanding balance.');o.verified_payment_cents=(o.verified_payment_cents??o.total)+payment-refund;o.balance_due_cents=Math.max(0,o.total-o.verified_payment_cents);o.refund_due_cents=Math.max(0,o.verified_payment_cents-o.total);o.revision=(o.revision||0)+1;o.updated=now();o.payment_adjustments=[...(o.payment_adjustments||[]),{created:now(),actor,reason:b.reason.trim(),payment_cents:payment,refund_cents:refund,revision:o.revision}];await syncRewards(s,o);await s.put('orders',o.id,o);return o;}
module.exports={edit,recordPayment};

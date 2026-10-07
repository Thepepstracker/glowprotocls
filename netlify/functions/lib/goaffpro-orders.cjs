'use strict';
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs'),api=require('./goaffpro.cjs');
const now=()=>Math.floor(Date.now()/1000);
const fail=message=>{throw new Error(message)};
function eligible(o){return o&&['paid','shipped'].includes(o.status)&&!!o.paid&&o.is_test===false&&!!o.goaffpro_affiliate_id&&!o.balance_due_cents&&!o.refund_due_cents&&!o.goaffpro_needs_review}
function payload(o){
 const sum=o.items.reduce((n,i)=>n+i.amount,0);if(sum!==o.subtotal||o.discount<0||o.discount>sum||o.total!==sum-o.discount+o.shipping+o.tax)fail('Order totals require review before reporting.');
 const discounts=o.items.map((i,index)=>({index,cents:sum?Number(BigInt(i.amount)*BigInt(o.discount)/BigInt(sum)):0,remainder:sum?BigInt(i.amount)*BigInt(o.discount)%BigInt(sum):0n}));
 let extra=o.discount-discounts.reduce((n,d)=>n+d.cents,0);for(const d of [...discounts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1))if(extra-->0)d.cents++;
 return{affiliate_id:o.goaffpro_affiliate_id,order:{id:'glow-store-'+o.id,number:o.id,total:o.total/100,subtotal:(o.subtotal-o.discount)/100,discount:o.discount/100,shipping:o.shipping/100,tax:o.tax/100,currency:'USD',date:new Date(o.paid*1000).toISOString(),status:'approved',is_paid:true,forceSDK:true,customer:{email:o.customer.email},coupons:o.coupon?[o.coupon]:[],line_items:o.items.map((i,index)=>({product_id:'glow-store-product-'+i.id,sku:i.sku,name:i.name,quantity:i.quantity,price:i.price/100,discount:discounts[index].cents/100,tax:0}))}};
}
async function findRemote(o){
 const data=await api.request('/admin/orders?number='+encodeURIComponent(o.id)+'&fields=id,number,affiliate_id,total,subtotal,status&limit=100');
 if(!Array.isArray(data?.orders))fail('GoAffPro returned an unexpected order list.');
 if(!data.orders.length)return null;
 if(data.orders.length!==1||data.orders[0].number!==o.id)fail('GoAffPro order lookup needs manual review.');
 const r=data.orders[0];if(!r.id||String(r.affiliate_id)!==o.goaffpro_affiliate_id||Math.round(Number(r.total)*100)!==o.total||Math.round(Number(r.subtotal)*100)!==o.subtotal-o.discount||!['approved','new','pending'].includes(r.status))fail('GoAffPro has an order with different amounts, attribution or approval status. Review it before proceeding.');
 return{remote_id:String(r.id),remote_status:r.status};
}
async function report(id){
 const claim=await transaction(async s=>{
  const o=await s.get('orders',id);if(!o)return{status:'blocked',message:'Order not found.'};
  if(o.is_test!==false)return{status:'test_only',message:'Test orders are never sent to GoAffPro.'};
  if(!eligible(o))return{status:'blocked',message:'Verify payment and confirm the GoAffPro affiliate mapping before reporting.'};
  const key='goaffpro-'+id,q=await s.get('outbox',key)||{id:key,provider:'goaffpro',order_id:id,attempts:0};
  if(q.status==='synced')return{status:'synced',remote_id:q.remote_id};
  if(q.status==='sending'&&q.lease_until>now())return{status:'sending',message:'This order is already being checked.'};
  const claim_id=crypto.randomBytes(16).toString('hex');Object.assign(q,{status:'sending',claim_id,lease_until:now()+90,attempts:q.attempts+1});await s.put('outbox',key,q);o.goaffpro_status='sending';await s.put('orders',id,o);return{o,q,key,claim_id};
 });
 if(!claim.o)return claim;
 const {o,q,key,claim_id}=claim;let outcome;
 const markPosting=()=>transaction(async s=>{const current=await s.get('outbox',key);if(current?.claim_id!==claim_id)fail('This reporting attempt is no longer active.');current.post_started=true;current.account_key_hash=api.fingerprint();await s.put('outbox',key,current);q.post_started=true});
 try{
  if(q.post_started&&q.account_key_hash&&q.account_key_hash!==api.fingerprint())fail('The GoAffPro key changed after a send attempt. Verify the original account before reconciling this order.');
  const existing=await findRemote(o);
  if(existing)outcome={status:'synced',...existing};
  else if(q.post_started)outcome={status:'needs_review',message:'A prior send may have reached GoAffPro. No second sale will be sent. Check GoAffPro and reconcile this order.'};
  else{
   const affiliates=await api.request('/admin/affiliates?id='+encodeURIComponent(o.goaffpro_affiliate_id)+'&fields=id,status,email');
   const a=affiliates?.affiliates?.find(a=>String(a.id)===o.goaffpro_affiliate_id);
   if(!a||a.status!=='approved')fail('The affiliate is no longer approved in GoAffPro.');
   if(typeof a.email!=='string'||!a.email.trim())fail('Affiliate email is unavailable. Add affiliate.email.read permission to the key before reporting.');
   if(a.email.trim().toLowerCase()===o.customer.email.trim().toLowerCase())fail('Self-purchase detected. This order is not eligible for affiliate commission.');
   const data=payload(o);await markPosting();
   try{await api.request('/admin/orders',data)}catch(e){if(e.kind==='authorization'){q.post_started=false;await transaction(async s=>{const current=await s.get('outbox',key);if(current?.claim_id===claim_id){current.post_started=false;await s.put('outbox',key,current)}})}throw e}
   const remote=await findRemote(o);outcome=remote?{status:'synced',...remote}:{status:'needs_review',message:'GoAffPro has not made this sale visible yet. Check reporting status later; it will not send the sale again.'};
  }
 }catch(e){outcome={status:q.post_started?'needs_review':'failed',message:e.message||'Reporting requires review.'}}
 await transaction(async s=>{const current=await s.get('outbox',key);if(current?.claim_id!==claim_id)return;Object.assign(current,outcome,{checked_at:now(),lease_until:0});delete current.claim_id;await s.put('outbox',key,current);const stored=await s.get('orders',id);if(stored){stored.goaffpro_status=outcome.status;stored.goaffpro_message=outcome.message||'';await s.put('orders',id,stored)}});
 return outcome;
}
module.exports={report,payload,eligible};


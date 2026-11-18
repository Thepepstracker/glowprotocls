'use strict';
// Refunds (Jonah, 17 Nov 2026: "we need a way to refund customers"). Order page → Refund. Owner sign-in only.
//   - Card payments made through Stripe are refunded on Stripe right away (Jonah: "Yes, refund on Stripe").
//   - Venmo, Zelle and Cash App refunds are sent by hand first; the owner ticks "I sent it" so the books match.
//   - Refund everything: the order is canceled, its items go back in stock (unless the box already went), an unused
//     label is voided in Shippo, points earned on it are taken back and points spent on it are given back, holds come off.
//   - Refund part: only the money (and any items ticked to go back in stock); points come back in proportion.
//   - One email to the customer, shown first and optional each time (Jonah: "Yes, with a preview first").
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const money=c=>'$'+(Math.round(c)/100).toFixed(2);
const METHOD_NAME={venmo:'Venmo',zelle:'Zelle',cashapp:'Cash App',cash_app:'Cash App',bitcoin:'Bitcoin',card_invoice:'card',card_checkout:'card',card_autopay:'card'};
function firstName(o){const raw=String(o?.customer?.name||'').trim();let n=raw.split(/\s+/)[0]||'';if(!/\s/.test(raw)&&n.includes('-'))n=n.split('-')[0];if(!n)return 'there';return n===n.toUpperCase()||n===n.toLowerCase()?n.charAt(0).toUpperCase()+n.slice(1).toLowerCase():n}
// Where the money came from. A Stripe payment we can refund on Stripe: a Checkout or autopay payment intent, a pi_ reference,
// or a Stripe invoice (its payment intent is looked up at refund time).
function stripeRef(o){const pi=o.stripe_checkout?.payment_intent||o.autopay?.payment_intent||(/^pi_[A-Za-z0-9]{6,}$/.test(String(o.payment_reference||''))?o.payment_reference:'');if(pi)return{pi};if(o.stripe_invoice?.id&&/^in_/.test(o.stripe_invoice.id))return{invoice:o.stripe_invoice.id};return null}
function methodOf(o){const ref=stripeRef(o);if(ref)return{kind:'stripe',name:'card',ref};const pm=String(o.payment_method||'');return{kind:/^card/.test(pm)?'card_manual':'manual',name:METHOD_NAME[pm]||'the way they paid'}}
const paidCents=o=>Number.isSafeInteger(o.verified_payment_cents)?o.verified_payment_cents:Number(o.total)||0;
function refundable(o){return Math.max(0,paidCents(o))}
function boxGone(o){const t=o.track||{},d=o.delivery||{};return !!o.packed||!!(t.first_scan_at||d.first_scan_at)||['in_transit','out_for_delivery','delivered'].includes(t.state)||['in_transit','out_for_delivery','delivered'].includes(d.state)}
const labelVoidable=o=>!!o.shippo_transaction_id&&!o.label_refund&&!boxGone(o);
function pointsBack(o,amount,full){const earned=Number(o.points_earned)||0;if(!o.customer_id||o.is_test!==false||!earned)return 0;if(full)return earned;return Math.min(earned,Math.floor(Math.floor(amount/100)*(Number(o.points_multiplier)||1)))}
function email(o,{amount,full,method,gone}){const first=firstName(o),where=method.kind==='stripe'||method.kind==='card_manual'?'It’s going back to the card you paid with. Most banks show it within 5–10 business days.':'We sent it back to you on '+method.name+'.';
 return{subject:'Your refund for order '+o.id+' · Glow Lab',title:'Your refund is on its way.',lines:['Hi '+first+',','We’ve refunded '+money(amount)+' for your order '+o.id+'. '+where,
  ...(full&&!gone?['Your order has been canceled, so nothing will ship.']:[]),'Thank you, and just reply here if you have any questions.']}}
async function ownerCheck(s,sid){const rec=await s.get('sessions',sid);if(rec?.staff_id)bad('Only the owner sign-in can refund an order.',403)}
function plan(o,b){if(!o)bad('Order not found.',404);if(o.is_test!==false)bad('This is a test order.',409);if(!['paid','shipped'].includes(o.status)||!o.paid)bad('Only paid orders can be refunded here.',409);
 const max=refundable(o);if(max<=0)bad('Nothing left to refund on this order.',409);const full=b.full===true,amount=full?max:Number(b.amount_cents);
 if(!Number.isSafeInteger(amount)||amount<1||amount>max)bad('Enter an amount from $0.01 to '+money(max)+'.');
 const method=methodOf(o),gone=boxGone(o);return{o,max,full,amount,method,gone,voidable:labelVoidable(o),points:pointsBack(o,amount,full),redeemed:full?(Number(o.points_redeemed)||0):0}}
// What would happen, without doing anything.
async function preview(s,b){const p=plan(await s.get('orders',String(b.id||'')),b),o=p.o;const e=email(o,p);
 return{id:o.id,max:p.max,amount:p.amount,full:p.full,method:p.method.kind,method_name:p.method.name,label:p.voidable?{can_void:true,cost:o.shipment?.label_cost_cents||o.label_cost_cents||null}:{can_void:false,why:!o.shippo_transaction_id?'no label':o.label_refund?'already voided':'the box already went'},
  gone:p.gone,restock:p.full&&!p.gone?o.items.map(i=>({id:i.id,name:i.name,quantity:i.quantity})):[],points_back:p.points,points_returned:p.redeemed,has_email:!!o.customer?.email,email:{to:o.customer?.email||'',subject:e.subject,text:e.lines.join('\n\n')},
  refunded_before:(o.refunds||[]).reduce((n,r)=>n+r.amount,0)}}

async function run(b,h,{session,moveStock,audit}){const key=String(b.key||'').replace(/[^A-Za-z0-9-]/g,'').slice(0,48);if(key.length<8)bad('Missing click key. Refresh and try again.');const id=String(b.id||'');
 const reason=String(b.reason||'').replace(/\s+/g,' ').trim().slice(0,300);
 // 1. Check and claim, so a double click or a second tab cannot refund twice.
 const p=await transaction(async s=>{const sid=await session(s,h);await ownerCheck(s,sid);const o0=await s.get('orders',id);if(o0&&(o0.refunds||[]).some(r=>r.key===key))return{already:true};
  const x=plan(o0,b);const o=x.o;if(o.refund_claim&&o.refund_claim.until>now()&&o.refund_claim.key!==key)bad('A refund on this order is already in progress. Wait a minute and refresh.',409);
  if(x.method.kind!=='stripe'&&b.record_only!==true&&b.sent!==true)bad(x.method.kind==='card_manual'?'This card payment isn’t linked to Stripe here. Refund it in Stripe first, then tick “I refunded it in Stripe”.':'Send '+money(x.amount)+' back on '+x.method.name+' first, then tick “I sent it”.');
  if(x.method.kind==='stripe'&&b.record_only===true&&b.sent!==true)bad('Tick “I refunded it in Stripe” to record only.');
  if(b.void_label===true&&!x.voidable)bad('This label can’t be voided (it was already voided, or the box already went).',409);
  o.refund_claim={key,until:now()+120};await s.put('orders',o.id,o);return{...x,sid,o:undefined,id:o.id,ref:x.method.ref||null,txn:o.shippo_transaction_id||''}});
 if(p.already){const o=await transaction(s=>s.get('orders',id));return{ok:true,already:true,refund:(o.refunds||[]).find(r=>r.key===key)}}
 const unclaim=()=>transaction(async s=>{const o=await s.get('orders',id);if(o?.refund_claim?.key===key){delete o.refund_claim;await s.put('orders',id,o)}});
 // 2. Money: Stripe refunds the card now. Venmo / Zelle / Cash App were sent by hand already.
 let stripeRefund=null;
 if(p.method.kind==='stripe'&&b.record_only!==true){try{const pay=require('./auto-invoice.cjs');let pi=p.ref.pi;
   if(!pi&&p.ref.invoice){const inv=await pay.stripe('/invoices/'+encodeURIComponent(p.ref.invoice));pi=typeof inv?.payment_intent==='string'?inv.payment_intent:inv?.payment_intent?.id;if(!pi)bad('Stripe has no card payment on this invoice. If it was paid another way, use “record only”.',409)}
   const r=await pay.stripe('/refunds',{method:'POST',idem:'glow-refund-'+id+'-'+key,body:{payment_intent:pi,amount:p.amount,reason:'requested_by_customer',metadata:{order_id:id}}});
   if(!['succeeded','pending','requires_action'].includes(String(r?.status)))bad('Stripe did not accept the refund ('+String(r?.status||'no status')+'). Nothing was changed.',409);
   stripeRefund={id:String(r.id||''),status:String(r.status),payment_intent:pi}}catch(e){await unclaim();if(e.status===502)e.status=409;throw e}}
 // 3. The unused label (only if asked). A Shippo problem never undoes a refund that already went out.
 let label=null;if(b.void_label===true&&p.txn){try{const r=await require('./shippo.cjs').voidLabel(p.txn);label={...r,requested_at:now()}}catch(e){label={status:'FAILED',error:String(e?.message||e).slice(0,160),requested_at:now()}}}
 // 4. Record it, cancel if everything was refunded, stock, points, holds, email.
 const out=await transaction(async s=>{const o=await s.get('orders',id),rec=await s.get('sessions',p.sid),by=rec?.staff_id||'owner',accounts=require('./customer-accounts.cjs');
  const r={key,at:now(),by,amount:p.amount,full:p.full,method:p.method.kind==='stripe'&&b.record_only!==true?'stripe':(p.method.kind==='stripe'?'stripe_by_hand':p.method.name),reason,...(stripeRefund?{stripe:stripeRefund}:{}),...(label?{label:{status:label.status,...(label.error?{error:label.error}:{})}}:{})};
  o.refunds=[...(o.refunds||[]),r];o.refunded_cents=(o.refunded_cents||0)+p.amount;o.verified_payment_cents=paidCents(o)-p.amount;delete o.refund_claim;
  if(label&&label.status!=='FAILED'){o.label_refund={status:label.status,object_id:label.object_id,transaction:label.transaction,requested_at:label.requested_at,tracking:o.tracking||''};o.shippo_status='label_refund_'+String(label.status).toLowerCase()}
  // Points: earned on this order come back off; spent on it go back to the customer.
  if(o.customer_id&&o.is_test===false){if(p.points>0){await accounts.event(s,o.customer_id,'refund:'+o.id+':'+key,'refund',-p.points,0,o.id,'Order refunded'+(p.full?'':' in part'));o.points_earned=Math.max(0,(o.points_earned||0)-p.points)}
   if(p.redeemed>0){await accounts.event(s,o.customer_id,'refund-spent:'+o.id+':'+key,'refund',p.redeemed,0,o.id,'Points spent on a refunded order, given back');o.points_redeemed_returned=p.redeemed}}
  if(p.full&&o.gift)await require('./gift-registry.cjs').unthank(s,o,accounts.event,':'+key,'Gift order refunded'); // gift list thank-you points
  if(p.full&&o.unbox)await require('./unbox.cjs').takeBack(s,o,accounts.event,'Order refunded: mystery gift points taken back');
  // Stock: everything for a full refund whose box never went; otherwise only what was ticked.
  const back=p.full&&!p.gone?o.items.map(i=>({...i})):[];if(!p.full&&Array.isArray(b.restock))for(const x of b.restock){const line=o.items.find(i=>i.id===Number(x.id));const q=Math.min(Number(x.quantity)||0,line?.quantity||0);if(line&&q>0)back.push({...line,quantity:q})}
  for(const l of back)await moveStock(s,l,1);if(back.length)r.restocked=back.map(l=>({id:l.id,name:l.name,quantity:l.quantity}));
  if(o.hold&&p.full){o.hold.lines=[];for(const [k,n] of Object.entries(o.hold.notices||{}))if(n.status==='pending')o.hold.notices[k]={status:'skipped',why:'refunded'}}
  if(o.goaffpro_status==='synced'||o.goaffpro_remote_id){o.goaffpro_needs_review=true;o.goaffpro_status='needs_review';o.goaffpro_message='Order refunded ('+money(p.amount)+'). Review the sale and commission in GoAffPro.'}
  if(p.full){o.status='canceled';o.canceled_reason='refunded';o.canceled_at=now();o.canceled_by=by;try{await require('./coupon-rules.cjs').reserve(s,o,-1)}catch{}}
  o.revision=(o.revision||0)+1;o.updated=now();await s.put('orders',o.id,o);
  if(p.full){try{await require('./native-affiliates.cjs').reconcileOrder(s,o)}catch{}}
  let job=null;if(b.email===true&&o.customer?.email){const emails=require('./store-email.cjs'),c=email(o,p);job=await emails.enqueue(s,{id:'refund-'+o.id+'-'+key,kind:'refund_sent',brand:o.brand||'glow',to:o.customer.email,related_id:o.id,subject:c.subject,content:emails.template(c.title,c.lines,null,null,null,null,{eyebrow:'Order '+o.id})});r.email_job=job||null;await s.put('orders',o.id,o)}
  await audit(s,p.full?'order_refunded':'order_refunded_part',o.id);return{job,refund:r,status:o.status}});
 if(out.job)await require('./store-email.cjs').safeDispatch(out.job);
 return{ok:true,status:out.status,refund:out.refund}}

async function route(path,body,h,method,helpers){const ok=b=>({status:200,headers:{},body:b});
 if(path==='/admin/order/refund/preview'&&method==='POST')return ok(await transaction(async s=>{const sid=await helpers.session(s,h);await ownerCheck(s,sid);return preview(s,body)}));
 if(path==='/admin/order/refund'&&method==='POST')return ok(await run(body,h,helpers));
 return null}
module.exports={route,preview,run,methodOf,stripeRef,refundable,email,firstName};

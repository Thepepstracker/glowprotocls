'use strict';
// Subscribe & save (Jonah, 4 Nov 2026). Decisions: 15% off products; the customer picks how often
// (every 1, 2, 3 or 4 weeks, or every month); AUTO-PAY through Stripe: the customer saves a card once on
// Stripe's own page, and each repeat order is charged to it automatically and marked paid.
// Staff start a subscription from a paid order. Autopilot ("Subscribe & save orders") makes and charges the repeats.
// Never charge twice: each charge uses a Stripe idempotency key tied to the order, and an order whose charge
// result is unknown for more than 23 hours stops for staff review instead of being retried.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const EVERY={'1w':{days:7,label:'Every week'},'2w':{days:14,label:'Every 2 weeks'},'3w':{days:21,label:'Every 3 weeks'},'4w':{days:28,label:'Every 4 weeks'},'1m':{months:1,label:'Every month'}};
const DISCOUNT_PCT=15;
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const pay=()=>require('./auto-invoice.cjs');
function todayET(t=Date.now()){return new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'})}
function addInterval(date,every){const e=EVERY[every];if(!e)bad('Choose how often.');const [y,m,d]=date.split('-').map(Number);if(e.days){const x=new Date(Date.UTC(y,m-1,d+e.days));return x.toISOString().slice(0,10)}
 const last=new Date(Date.UTC(y,m+e.months,0)).getUTCDate();return new Date(Date.UTC(y,m-1+e.months,Math.min(d,last))).toISOString().slice(0,10)}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))&&!isNaN(Date.parse(v+'T12:00:00Z'))}
function origin(){return String(process.env.STORE_ORIGIN||'https://glowglps.com').replace(/\/$/,'')}
function publicSub(x){return{id:x.id,status:x.status,pay:x.pay||'invoice',every:x.every,every_label:EVERY[x.every]?.label||x.every,discount_pct:x.discount_pct,next_date:x.next_date,customer:{name:x.customer?.name||'',email:x.customer?.email||'',phone:x.customer?.phone||'',city:x.customer?.city||'',state:x.customer?.state||''},items:x.items,source_order:x.source_order,orders:x.orders||[],created:x.created,problem:x.problem||'',last_run:x.last_run||0,card:x.card?{brand:x.card.brand,last4:x.card.last4}:null,card_link:x.status==='needs_card'&&x.card_session&&(x.card_session.expires||0)>now()+600?x.card_session.url:'',card_link_expires:x.card_session?.expires||0}}
async function list(){return transaction(async s=>(await s.list('subscriptions')).map(publicSub).sort((a,b)=>(a.status==='canceled'?1:0)-(b.status==='canceled'?1:0)||String(a.next_date).localeCompare(String(b.next_date))))}
// Start one from a paid (or shipped) live order: same items, same ship-to. It waits for the card ("needs_card"),
// then the first repeat is today + the interval.
async function create({order_id,every,by='staff'}){if(!EVERY[every])bad('Choose how often.');if(!pay().stripeReady())bad('Stripe is not connected on the store yet, so auto-pay cannot start. Add the Stripe secret key in Sevalla → Environment variables.',409);
 const sub=await transaction(async s=>{
 const o=await s.get('orders',String(order_id||'').slice(0,50));if(!o)bad('Order not found.',404);if(o.is_test!==false||!['paid','shipped'].includes(o.status))bad('Start Subscribe & save from a live order that is paid.',409);
 const existing=(await s.list('subscriptions')).find(x=>x.source_order===o.id&&x.status!=='canceled');if(existing)bad('This order already has a subscription ('+existing.id+').',409);
 const items=(o.items||[]).filter(i=>Number.isInteger(i.id)&&i.quantity>0).map(i=>({id:i.id,quantity:i.quantity,name:i.name}));if(!items.length)bad('This order has no products to repeat.',409);
 const c=o.customer||{};if(!c.email)bad('This order has no customer email.',409);
 const x={id:'SUB-'+crypto.randomBytes(4).toString('hex').toUpperCase(),brand:o.brand||'glow',status:'needs_card',pay:'autopay',every,discount_pct:DISCOUNT_PCT,next_date:addInterval(todayET(),every),customer:{name:c.name,email:c.email,phone:c.phone||'',address:c.address,address2:c.address2||'',city:c.city,state:c.state,zip:c.zip},items,source_order:o.id,orders:[],created:now(),created_by:by};
 await s.put('subscriptions',x.id,x);o.subscription_id=x.id;await s.put('orders',o.id,o);return x});
 try{return await cardLink(sub.id)}catch(e){await transaction(async s=>{const x=await s.get('subscriptions',sub.id);if(x){x.problem='Card link not made yet: '+String(e.message).slice(0,160);await s.put('subscriptions',x.id,x)}});return publicSub({...sub,problem:'Card link not made yet: '+String(e.message).slice(0,160)})}}
// A Stripe page where the customer saves their card (Stripe "setup" checkout, no charge, no product names).
// Jonah sends the link himself. A fresh link is made if the old one expired (Stripe links last 24 hours).
async function cardLink(id){const x=await transaction(s=>s.get('subscriptions',String(id||'').slice(0,20)));if(!x)bad('Subscription not found.',404);if(x.status!=='needs_card')bad('This subscription already has a card.',409);
 if(x.card_session&&(x.card_session.expires||0)>now()+600)return publicSub(x);
 const st=pay().stripe;let customer=x.stripe_customer;
 if(!customer){const c=await st('/customers',{method:'POST',idem:'glow-sub-customer-'+x.id,body:{email:x.customer.email,name:x.customer.name,description:'Glow Lab',metadata:{subscription_id:x.id}}});customer=c.id}
 const sess=await st('/checkout/sessions',{method:'POST',idem:'glow-sub-card-'+x.id+'-'+Math.floor(now()/3600),body:{mode:'setup',customer,currency:'usd',payment_method_types:['card'],success_url:origin()+'/store-next/?card=saved',cancel_url:origin()+'/store-next/',metadata:{subscription_id:x.id},setup_intent_data:{metadata:{subscription_id:x.id},description:'Glow Lab'}}});
 return transaction(async s=>{const y=await s.get('subscriptions',x.id);y.stripe_customer=customer;y.card_session={id:sess.id,url:sess.url,expires:sess.expires_at||now()+86400};y.problem='';await s.put('subscriptions',y.id,y);return publicSub(y)})}
// Has the customer saved their card? Then make it the default card and switch the subscription on.
async function checkCard(id){const x=await transaction(s=>s.get('subscriptions',id));if(!x||x.status!=='needs_card'||!x.card_session?.id)return publicSub(x||{});
 const st=pay().stripe,sess=await st('/checkout/sessions/'+encodeURIComponent(x.card_session.id)+'?expand[]=setup_intent');
 if(sess.status!=='complete'||sess.setup_intent?.status!=='succeeded'||!sess.setup_intent?.payment_method)return publicSub(x);
 const pm=sess.setup_intent.payment_method,pmId=typeof pm==='string'?pm:pm.id,detail=typeof pm==='string'?await st('/payment_methods/'+encodeURIComponent(pmId)):pm;
 await st('/customers/'+encodeURIComponent(x.stripe_customer),{method:'POST',body:{invoice_settings:{default_payment_method:pmId}}});
 return transaction(async s=>{const y=await s.get('subscriptions',x.id);if(y.status!=='needs_card')return publicSub(y);y.payment_method=pmId;y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.status='active';y.card_saved_at=now();if(y.next_date<todayET())y.next_date=addInterval(todayET(),y.every);y.problem='';delete y.card_session;await s.put('subscriptions',y.id,y);return publicSub(y)})}
// Staff changes: how often, pause / resume, cancel, skip the next one, move the next date, new card link, check card.
async function update({id,action,every,next_date}){
 if(action==='link')return cardLink(id);
 if(action==='check')return checkCard(String(id||'').slice(0,20));
 return transaction(async s=>{const x=await s.get('subscriptions',String(id||'').slice(0,20));if(!x)bad('Subscription not found.',404);if(x.status==='canceled')bad('This subscription is canceled.',409);
 if(action==='every'){if(!EVERY[every])bad('Choose how often.');x.every=every}
 else if(action==='pause'){if(x.status==='needs_card')bad('Waiting for the card. Cancel it instead.',409);x.status='paused'}
 else if(action==='resume'){if(x.status!=='paused')bad('Only a paused subscription can be resumed.',409);x.status='active';if(x.next_date<todayET())x.next_date=addInterval(todayET(),x.every)}
 else if(action==='cancel'){x.status='canceled';x.canceled_at=now()}
 else if(action==='skip')x.next_date=addInterval(x.next_date,x.every);
 else if(action==='date'){if(!validDate(next_date)||next_date<todayET())bad('Choose a date from today on.');x.next_date=next_date}
 else bad('Choose what to change.');
 x.problem='';x.updated_at=now();await s.put('subscriptions',x.id,x);return publicSub(x)})}
// Charge one repeat order to the saved card. The idempotency key is the order id, so a retry can never charge twice.
async function charge(orderId){const t=now();
 const o=await transaction(s=>s.get('orders',orderId));if(!o||o.payment_method!=='card_autopay'||!['charging','unknown'].includes(o.autopay?.status))return{status:'skipped'};
 if(t-(o.autopay.started||o.created)>23*3600){await transaction(async s=>{const c=await s.get('orders',orderId);c.autopay={...c.autopay,status:'needs_review',message:'The card charge result was never confirmed. Check Stripe before doing anything else.'};await s.put('orders',orderId,c)});return{status:'needs_review'}}
 const sub=await transaction(s=>s.get('subscriptions',o.subscription_id));if(!sub?.stripe_customer||!sub.payment_method)return markFail(orderId,sub,'No saved card on this subscription.');
 let pi;try{pi=await pay().stripe('/payment_intents',{method:'POST',idem:'glow-sub-charge-'+o.id,body:{amount:o.total,currency:'usd',customer:sub.stripe_customer,payment_method:sub.payment_method,off_session:true,confirm:true,description:'Glow Lab',metadata:{order_id:o.id,subscription_id:sub.id}}})}
 catch(e){if(e.uncertain){await transaction(async s=>{const c=await s.get('orders',orderId);c.autopay={...c.autopay,status:'unknown',message:'Stripe did not answer. It will be checked again.'};await s.put('orders',orderId,c)});return{status:'unknown'}}return markFail(orderId,sub,String(e.message||'Card was declined.').replace(/^Stripe: /,''))}
 if(pi.status!=='succeeded'||pi.currency!=='usd'||pi.amount_received<o.total||pi.livemode!==pay().stripeLive())return markFail(orderId,sub,pi.status==='requires_action'?'The card needs the customer to confirm it (bank check). Send them a new card link.':'Charge not completed ('+pi.status+').');
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs');
 const job=await transaction(async s=>{const c=await s.get('orders',orderId);if(c.status!=='order_received')return null;return core.subscriptionChargePaid(s,c,pi)});
 if(job)await emails.safeDispatch(job);return{status:'paid'}}
async function markFail(orderId,sub,message){await transaction(async s=>{const c=await s.get('orders',orderId);if(c){c.autopay={...(c.autopay||{}),status:'failed',message:String(message).slice(0,200),failed_at:now()};await s.put('orders',orderId,c)}if(sub){const y=await s.get('subscriptions',sub.id);if(y){y.problem='Repeat order '+orderId+' was not paid: '+String(message).slice(0,160);await s.put('subscriptions',y.id,y)}}});return{status:'failed',message}}
// Autopilot: check waiting cards; make today's repeat orders (10 AM–6 PM Eastern) and charge them.
// A problem (sold out, checkout off) is shown in Management and retried next run; the date only moves once the order exists.
async function run(limit=10,t=Date.now()){
 const ts=Math.floor(t/1000),out={status:'ok',made:0,paid:0,failed:0,cards:0};
 if(!pay().stripeReady())return{status:'stripe_not_connected',made:0};
 const waiting=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='needs_card'&&x.card_session?.id).map(x=>x.id));
 for(const id of waiting){try{if((await checkCard(id)).status==='active')out.cards++}catch{}}
 // Retry charges whose result is not known yet (same idempotency key, so never a second charge).
 const pending=await transaction(async s=>(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>o.payment_method==='card_autopay'&&['charging','unknown'].includes(o.autopay?.status)).map(o=>o.id));
 for(const id of pending){const r=await charge(id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)));if(hour<10||hour>=18){out.status=out.cards||out.paid?'ok':'quiet_hours';return out}
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs'),autoInvoice=require('./auto-invoice.cjs'),today=todayET(t);
 const due=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='active'&&x.next_date<=today).slice(0,limit).map(x=>x.id));
 for(const id of due){let made=null;
  try{made=await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x||x.status!=='active'||x.next_date>today)return null;const cycle=x.next_date;
    const r=await core.subscriptionOrder(s,x,cycle);const orderId=r.existing||r.order.id;x.orders=[...(x.orders||[]).filter(o=>o!==orderId),orderId].slice(-50);
    let next=addInterval(cycle,x.every);while(next<=today)next=addInterval(next,x.every);x.next_date=next;x.problem='';x.last_run=ts;await s.put('subscriptions',x.id,x);return r})}
  catch(e){await transaction(async s=>{const x=await s.get('subscriptions',id);if(x){x.problem=String(e&&e.message||e).slice(0,200);x.last_run=ts;await s.put('subscriptions',x.id,x)}});continue}
  if(!made||made.existing)continue;out.made++;for(const j of made.jobs)await emails.safeDispatch(j);
  if(made.autopay){const r=await charge(made.order.id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
  else if(made.invoice){try{await autoInvoice.sendFor(made.invoice)}catch{}}}
 return out;
}
module.exports={EVERY,DISCOUNT_PCT,addInterval,todayET,list,create,update,cardLink,checkCard,charge,run,publicSub};

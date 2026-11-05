'use strict';
// Subscribe & save. 4 Nov 2026: staff-started, 15% off, AUTO-PAY through Stripe (the customer saves a card once on
// Stripe's own page, and each repeat order is charged to it automatically and marked paid).
// 5 Nov 2026 (Jonah's spec): 5 tiers with a fixed price per delivery, customers subscribe themselves from the bag
// (signed in), pay the first box on Stripe Checkout (card saved for the repeats), and manage it in their account.
// Never charge twice: each charge uses a Stripe idempotency key tied to the order, and an order whose charge
// result is unknown for more than 23 hours stops for staff review instead of being retried. Declines are not retried.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const EVERY={'1w':{days:7,label:'Every week'},'2w':{days:14,label:'Every 2 weeks'},'3w':{days:21,label:'Every 3 weeks'},'4w':{days:28,label:'Every 4 weeks'},'1m':{months:1,label:'Every month'}};
const CUSTOMER_EVERY=['1w','2w','3w','1m']; // '4w' stays valid for older subscriptions but is not offered to customers
const DISCOUNT_PCT=15; // legacy: only used for an older staff-started subscription too big for any tier (over 8 slots)
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const pay=()=>require('./auto-invoice.cjs');

// ---- Tiers (Jonah, 5 Nov 2026) ----
// A "slot" covers up to $65.00 of list price: each unit takes ceil(price / $65) slots (a $49 vial 1, a $92 vial 2, a $408 kit 7).
// The tier is picked automatically: the smallest one that holds the slots used.
const SLOT_MAX_CENTS=6500,CHARGE_DAYS_BEFORE=2,REMIND_DAYS_BEFORE_CHARGE=3,FAIR_PCT=85;
const TIERS=[
 {id:'T1',level:1,name:'Tier 1',slots:1,price:3399,free_shipping:false,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T2',level:2,name:'Tier 2',slots:2,price:6499,free_shipping:false,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T3',level:3,name:'Tier 3',slots:3,price:9499,free_shipping:true,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T4',level:4,name:'Tier 4',slots:5,price:14999,free_shipping:true,points:3,early_access:true,packed_first:false,bonus_every:0},
 {id:'T5',level:5,name:'Tier 5',slots:8,price:22999,free_shipping:true,points:4,early_access:true,packed_first:true,bonus_every:4}
];
const MAX_SLOTS=TIERS[TIERS.length-1].slots;
function productMap(products){if(products instanceof Map)return products;const m=new Map();for(const p of products||[])if(p)m.set(Number(p.id),p);return m}
// One slot per $65 of list price, rounded up (Jonah, 5 Nov 2026): a $49 vial = 1, a $92 vial = 2, a $408 kit of 10 = 7.
// Keeps the cost per slot under about $16 for every product with a cost on file, so kits and bundles cannot be sold far below cost.
function slotsOf(p){return Math.max(1,Math.ceil((Number(p?.price)||0)/SLOT_MAX_CENTS))}
function cleanItems(items){return (Array.isArray(items)?items:[]).map(i=>({id:Number(i?.id),quantity:Math.floor(Number(i?.quantity)||0)})).filter(i=>Number.isInteger(i.id)&&i.id>0&&i.quantity>0)}
function slotsFor(items,products){const m=productMap(products);let n=0;for(const i of cleanItems(items)){const p=m.get(i.id);if(!p)bad('A product is unavailable.');n+=slotsOf(p)*i.quantity}return n}
function tierFor(slots){return slots>0?TIERS.find(t=>t.slots>=slots)||null:null}
function tierById(id){return TIERS.find(t=>t.id===id)||null}
function bonusDelivery(tier,deliveryNumber){return !!tier?.bonus_every&&deliveryNumber>0&&deliveryNumber%tier.bonus_every===0}
function shippingFor(tier,priceCents,settings){if(tier?.free_shipping)return 0;const st=settings||{},ship=Number.isInteger(st.shipping_cents)?st.shipping_cents:1500;return st.free_shipping_cents>0&&priceCents>=st.free_shipping_cents?0:ship}
function publicTier(t){return t?{id:t.id,level:t.level,name:t.name,slots:t.slots,price_cents:t.price,free_shipping:t.free_shipping,points_multiplier:t.points,early_access:t.early_access,packed_first:t.packed_first,bonus_every:t.bonus_every}:null}
// The bonus slot (Tier 5, every 4th delivery): the customer's pick if it is a 1-slot product, otherwise one more of the
// first 1-slot product already in the box. No 1-slot product in the box and no pick: no bonus that time.
function pickBonus(lines,m,bonusId){const ok=p=>p&&p.active!==false&&slotsOf(p)===1;const want=m.get(Number(bonusId));if(ok(want))return want;for(const l of lines){const p=m.get(l.id);if(ok(p))return p}return null}
// Price of one delivery. items: [{id,quantity}], products: array or Map of {id,price,name}. tier: optional tier (id or object);
// it is used only if it holds the items, otherwise the smallest tier that does. deliveryNumber: 1 = the first box.
// FAIRNESS: the products are never charged more than 85% of their list price: price = min(tier price, 85% of list).
function priceFor(items,products,tier=null,deliveryNumber=1,opts={}){
 const m=productMap(products),lines=cleanItems(items);if(!lines.length)return{ok:false,error:'Add at least one product.',slots:0};
 for(const l of lines)if(!m.get(l.id))return{ok:false,error:'A product is unavailable.',slots:0};
 const slots=slotsFor(lines,m),wanted=typeof tier==='string'?tierById(tier):tier,t=wanted&&wanted.slots>=slots?wanted:tierFor(slots);
 if(!t)return{ok:false,error:'A subscription box holds up to '+MAX_SLOTS+' slots. Each slot covers up to $65 of an item’s price. Remove some items or buy the rest as a one-time order.',slots,max_slots:MAX_SLOTS};
 const list=lines.reduce((n,l)=>n+m.get(l.id).price*l.quantity,0),cap=Math.floor(list*FAIR_PCT/100),price=Math.min(t.price,cap);
 const bp=!opts.no_bonus&&bonusDelivery(t,deliveryNumber)?pickBonus(lines,m,opts.bonus_id):null;
 const all=lines.map(l=>({...l}));if(bp){const hit=all.find(l=>l.id===Number(bp.id));if(hit)hit.quantity++;else all.push({id:Number(bp.id),quantity:1})}
 const listAll=list+(bp?bp.price:0),shipping=shippingFor(t,price,opts.settings);
 const standardShipping=shippingFor(null,listAll,opts.settings);
 return{ok:true,tier:publicTier(t),slots,capacity:t.slots+(bp?1:0),open_slots:Math.max(0,t.slots-slots),list_cents:listAll,regular_list_cents:list,price_cents:price,discount_cents:listAll-price,savings_cents:listAll-price,shipping_cents:shipping,shipping_saved_cents:Math.max(0,standardShipping-shipping),total_cents:price+shipping,
  fair_cap_applied:cap<t.price,points_multiplier:t.points,delivery_number:deliveryNumber,bonus:bp?{id:Number(bp.id),name:String(bp.name||''),list_cents:bp.price}:null,lines:all,
  nudge:t.slots>slots?{open_slots:t.slots-slots,add_max_cents:Math.max(0,t.price-price)}:null}}
function count(lines){return (lines||[]).reduce((n,l)=>n+(Number(l.quantity)||0),0)}

// ---- dates ----
function todayET(t=Date.now()){return new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'})}
function addDays(date,days){const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+days)).toISOString().slice(0,10)}
function addInterval(date,every){const e=EVERY[every];if(!e)bad('Choose how often.');const [y,m,d]=date.split('-').map(Number);if(e.days){const x=new Date(Date.UTC(y,m-1,d+e.days));return x.toISOString().slice(0,10)}
 const last=new Date(Date.UTC(y,m+e.months,0)).getUTCDate();return new Date(Date.UTC(y,m-1+e.months,Math.min(d,last))).toISOString().slice(0,10)}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))&&!isNaN(Date.parse(v+'T12:00:00Z'))}
// next_ship_date is the date the box ships. The order is made and the card charged 2 days before it (Eastern time).
// Older records only have next_date; it is read as the ship date.
function shipDate(x){return x.next_ship_date||x.next_date||''}
function chargeDate(x){const d=shipDate(x);return d?addDays(d,-CHARGE_DAYS_BEFORE):''}
function setShip(x,d){x.next_ship_date=d;x.next_date=d}
// First ship date for a cycle that starts today: never so soon that the charge date is already behind us.
function nextFrom(date,every,today){let next=addInterval(date,every);while(addDays(next,-CHARGE_DAYS_BEFORE)<today)next=addInterval(next,every);return next}
function longDay(d){return d?new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'}):''}
// How many boxes this subscription has had. Staff-started ones count their source order as the first.
function deliveriesDone(x){return Number.isInteger(x.deliveries)?x.deliveries:1+(x.orders||[]).length}

function origin(){return String(process.env.STORE_ORIGIN||'https://glowglps.com').replace(/\/$/,'')}
function publicSub(x){return{id:x.id,status:x.status,pay:x.pay||'invoice',every:x.every,every_label:EVERY[x.every]?.label||x.every,discount_pct:x.discount_pct,next_date:shipDate(x),next_ship_date:shipDate(x),charge_date:chargeDate(x),customer:{name:x.customer?.name||'',email:x.customer?.email||'',phone:x.customer?.phone||'',city:x.customer?.city||'',state:x.customer?.state||''},items:x.items,source_order:x.source_order,orders:x.orders||[],created:x.created,problem:x.problem||'',last_run:x.last_run||0,card:x.card?{brand:x.card.brand,last4:x.card.last4}:null,card_link:x.status==='needs_card'&&x.card_session&&(x.card_session.expires||0)>now()+600?x.card_session.url:'',card_link_expires:x.card_session?.expires||0,source:x.source||'staff',deliveries:deliveriesDone(x)}}
async function productsOf(s){return productMap(await s.list('products'))}
// Tier and price of the NEXT delivery, for the admin and customer screens (no stock check; the order itself checks stock).
function pricingOf(x,m,settings){try{const r=priceFor(x.items,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings});if(r.ok)return{tier:r.tier,slots:r.slots,price_cents:r.price_cents,shipping_cents:r.shipping_cents,total_cents:r.total_cents,list_cents:r.list_cents,bonus:r.bonus};return{tier:null,slots:r.slots,error:r.error}}catch(e){return{tier:null,slots:0,error:String(e.message)}}}
async function list(){return transaction(async s=>{const m=await productsOf(s),settings=await s.get('settings','main');return(await s.list('subscriptions')).map(x=>({...publicSub(x),pricing:pricingOf(x,m,settings)})).sort((a,b)=>(a.status==='canceled'?1:0)-(b.status==='canceled'?1:0)||String(a.next_date).localeCompare(String(b.next_date)))})}
// Start one from a paid (or shipped) live order: same items, same ship-to. It waits for the card ("needs_card"),
// then the first repeat ships today + the interval.
async function create({order_id,every,by='staff'}){if(!EVERY[every])bad('Choose how often.');if(!pay().stripeReady())bad('Stripe is not connected on the store yet, so auto-pay cannot start. Add the Stripe secret key in Sevalla → Environment variables.',409);
 const sub=await transaction(async s=>{
 const o=await s.get('orders',String(order_id||'').slice(0,50));if(!o)bad('Order not found.',404);if(o.is_test!==false||!['paid','shipped'].includes(o.status))bad('Start Subscribe & save from a live order that is paid.',409);
 const existing=(await s.list('subscriptions')).find(x=>x.source_order===o.id&&x.status!=='canceled');if(existing)bad('This order already has a subscription ('+existing.id+').',409);
 const items=(o.items||[]).filter(i=>Number.isInteger(i.id)&&i.quantity>0).map(i=>({id:i.id,quantity:i.quantity,name:i.name}));if(!items.length)bad('This order has no products to repeat.',409);
 const c=o.customer||{};if(!c.email)bad('This order has no customer email.',409);
 const x={id:'SUB-'+crypto.randomBytes(4).toString('hex').toUpperCase(),brand:o.brand||'glow',status:'needs_card',pay:'autopay',source:'staff',every,discount_pct:DISCOUNT_PCT,customer:{name:c.name,email:c.email,phone:c.phone||'',address:c.address,address2:c.address2||'',city:c.city,state:c.state,zip:c.zip},customer_id:o.customer_id||null,items,source_order:o.id,orders:[],deliveries:1,created:now(),created_by:by};
 setShip(x,addInterval(todayET(),every));
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
 return transaction(async s=>{const y=await s.get('subscriptions',x.id);if(y.status!=='needs_card')return publicSub(y);y.payment_method=pmId;y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.status='active';y.card_saved_at=now();if(chargeDate(y)<todayET())setShip(y,nextFrom(todayET(),y.every,todayET()));y.problem='';delete y.card_session;await s.put('subscriptions',y.id,y);return publicSub(y)})}
// Changes (staff, or the customer through customerUpdate): how often, pause / resume, cancel, skip the next one,
// move the next ship date, new items, new card link, check card.
async function update({id,action,every,next_date,items},{customer=false,owner=null}={}){
 if(action==='link')return cardLink(id);
 if(action==='check')return checkCard(String(id||'').slice(0,20));
 return transaction(async s=>{const x=await s.get('subscriptions',String(id||'').slice(0,20));if(!x||(owner&&!owns(x,owner)))bad('Subscription not found.',404);if(x.status==='canceled')bad('This subscription is canceled.',409);
 if(x.status==='pending_first_payment'&&action!=='cancel')bad(customer?'Your first payment is still being confirmed. Try again in a minute.':'Waiting for the first payment on Stripe.',409);
 const today=todayET();
 if(action==='every'){if(!EVERY[every]||(customer&&!CUSTOMER_EVERY.includes(every)))bad('Choose how often.');x.every=every}
 else if(action==='pause'){if(x.status==='needs_card')bad('Waiting for the card. Cancel it instead.',409);x.status='paused'}
 else if(action==='resume'){if(x.status!=='paused')bad('Only a paused subscription can be resumed.',409);x.status='active';if(chargeDate(x)<today)setShip(x,nextFrom(today,x.every,today))}
 else if(action==='cancel'){x.status='canceled';x.canceled_at=now();x.canceled_by=customer?'customer':'staff'}
 else if(action==='skip'){let next=addInterval(shipDate(x),x.every);while(addDays(next,-CHARGE_DAYS_BEFORE)<today)next=addInterval(next,x.every);setShip(x,next)}
 else if(action==='date'){if(!validDate(next_date)||next_date<today)bad('Choose a date from today on.');if(customer&&addDays(next_date,-CHARGE_DAYS_BEFORE)<today)bad('Choose a ship date at least 2 days from today.');setShip(x,next_date)}
 else if(action==='items'){const m=await productsOf(s),lines=await validItems(s,items,x.brand||'glow',m);const r=priceFor(lines,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings:await s.get('settings','main')});if(!r.ok)bad(r.error,409);x.items=lines.map(l=>({id:l.id,quantity:l.quantity,name:m.get(l.id).name}));x.tier=r.tier.id}
 else bad('Choose what to change.');
 x.problem='';x.updated_at=now();await s.put('subscriptions',x.id,x);return publicSub(x)})}
async function validItems(s,items,brandId,m){const brands=require('./brands.cjs'),lines=cleanItems(items);if(!lines.length)bad('Add at least one product.');if(lines.length>40)bad('Too many products.');const seen=new Set();
 for(const l of lines){if(seen.has(l.id))bad('Duplicate product.');seen.add(l.id);if(l.quantity>20)bad('Up to 20 of one product.');const p=m.get(l.id);if(!p||!p.active||brands.productBrand(p)!==brandId)bad('A product is unavailable.')}return lines}
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

// ---- Customer self-serve (5 Nov 2026) ----
function owns(x,a){return !!a&&!!x&&(x.customer_id===a.id||(a.verified===true&&String(x.customer?.email||'').trim().toLowerCase()===a.email))}
async function switchOn(s){const rec=await s.get('integrations','autopilot');return rec?.tasks?.subscriptions?.on===true}
// Can a customer start one right now? Only on the Glow store, with live checkout, Stripe connected and the Autopilot
// "Subscribe & save orders" switch ON (otherwise nobody would make or charge the repeats).
async function offerOpen(s,brand){const st=await s.get('settings','main');if(brand?.id!=='glow')return 'Subscribe & save is available on the Glow Lab store.';if(!(st&&st.demo===false&&st.checkout_enabled===true&&st.tax_mode==='none'))return 'Subscribe & save is not available right now.';if(!pay().stripeReady()||!await switchOn(s))return 'Subscribe & save is not available right now.';return ''}
// Customer-facing wording lives in one place so the owner can approve it (see subscribe-copy-for-approval.md).
const COPY={
 sign_in:'Sign in to your Glow account to subscribe, so you can change, skip or cancel any time.',
 not_found:'Subscription not found.',
 checkout_failed:'We could not open the secure card page. Nothing was charged. Please try again.',
 pending:'Your first payment is still being confirmed. Refresh in a minute.',
 paid_late:'Your payment arrived after this checkout had closed. We will contact you to sort it out. Please do not pay again.'
};
async function customerQuote(s,h,brand,body){const closed=await offerOpen(s,brand),core=require('./store-core.cjs');
 const r=await core.subscriptionQuote(s,{items:body.items,h,brand,deliveryNumber:1});
 return{available:!closed,reason:closed,signed_in:!!await require('./customer-accounts.cjs').session(s,h),every:CUSTOMER_EVERY.map(k=>({id:k,label:EVERY[k].label})),tiers:TIERS.map(publicTier),...r}}
// Bag → "Subscribe & save": makes the first order (tier price) and a subscription waiting for its first payment,
// then opens Stripe Checkout for exactly the order total. The card is saved on Stripe for the repeat boxes.
async function startCheckout(h,body,brand){
 const accounts=require('./customer-accounts.cjs'),core=require('./store-core.cjs');
 const every=String(body.every||'');if(!CUSTOMER_EVERY.includes(every))bad('Choose how often.');
 const key=String(body.idempotency_key||'').slice(0,100);if(key.length<8)bad('Refresh the page and try again.');
 const prior=await transaction(async s=>{const a=await accounts.session(s,h);if(!a)bad(COPY.sign_in,401);const done=await s.get('idempotency','subscribe-'+key);if(done){const x=await s.get('subscriptions',done.id);if(x&&owns(x,a)&&x.status==='pending_first_payment'&&x.checkout?.url&&(x.checkout.expires||0)>now()+300)return{again:{id:x.id,url:x.checkout.url}};bad('This subscription was already started. Check your account.',409)}
  const closed=await offerOpen(s,brand);if(closed)bad(closed,503);return{a,old:(await s.list('subscriptions')).filter(x=>x.status==='pending_first_payment'&&owns(x,a)).map(x=>x.id)}});
 if(prior.again)return prior.again;
 for(const id of prior.old){try{await settleFirst(id,{close:true})}catch{}} // an earlier unfinished checkout gives its items back first
 const made=await transaction(async s=>{const a=await accounts.session(s,h);if(!a)bad(COPY.sign_in,401);if(await s.get('idempotency','subscribe-'+key))bad('This subscription was already started. Check your account.',409);
  const r=await core.subscriptionFirstOrder(s,{account:a,customer:body.customer,items:body.items,every,brand,h});
  await s.put('idempotency','subscribe-'+key,{id:r.sub.id});return{sub:r.sub,order:r.order,account:a}});
 const {sub,order,account}=made,st=pay().stripe;
 try{let customer=account.stripe_customer;
  if(!customer){const c=await st('/customers',{method:'POST',idem:'glow-cust-'+account.id,body:{email:account.email,name:sub.customer.name,description:'Glow Lab',metadata:{customer_account:account.id}}});customer=c.id;
   await transaction(async s=>{const a=await s.get('customers',account.id);if(a&&!a.stripe_customer){a.stripe_customer=customer;await s.put('customers',a.id,a)}})}
  const sess=await st('/checkout/sessions',{method:'POST',idem:'glow-sub-checkout-'+sub.id,body:checkoutBody({sub,order,customer})});
  if(!sess?.id||!sess.url)throw new Error('no session');
  await transaction(async s=>{const x=await s.get('subscriptions',sub.id);x.stripe_customer=customer;x.checkout={id:sess.id,url:sess.url,expires:sess.expires_at||now()+86400,amount:order.total};await s.put('subscriptions',x.id,x);const o=await s.get('orders',order.id);o.checkout_session=sess.id;await s.put('orders',o.id,o)});
  return{id:sub.id,url:sess.url}}
 catch(e){await transaction(async s=>{const x=await s.get('subscriptions',sub.id),o=await s.get('orders',order.id);if(o&&o.status==='order_received')await core.subscriptionRelease(s,o,'canceled');if(x&&x.status==='pending_first_payment'){x.status='canceled';x.canceled_at=now();x.problem='Stripe checkout could not be opened: '+String(e.message).slice(0,140);await s.put('subscriptions',x.id,x)}});bad(COPY.checkout_failed,502)}}
// The Stripe Checkout request. One line, "Glow Lab", for the order total. No product names anywhere.
function checkoutBody({sub,order,customer}){return{mode:'payment',customer,client_reference_id:sub.id,payment_method_types:['card'],submit_type:'pay',
 line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:order.total,product_data:{name:'Glow Lab'}}}],
 payment_intent_data:{setup_future_usage:'off_session',description:'Glow Lab',metadata:{order_id:order.id,subscription_id:sub.id}},
 metadata:{order_id:order.id,subscription_id:sub.id},
 success_url:origin()+'/store-next/account?subscribed='+sub.id,cancel_url:origin()+'/store-next/?sub_canceled='+sub.id+'#bag'}}
// Did the first payment go through on Stripe? Checked when the customer comes back and in every Autopilot run.
// Paid → order paid (source stripe_checkout), card saved, subscription active. Safe to call any number of times.
// close:true (or the Stripe page expired) → the unpaid checkout is closed and its items go back into stock.
async function settleFirst(id,{close=false}={}){
 const x=await transaction(s=>s.get('subscriptions',String(id||'').slice(0,20)));if(!x)bad(COPY.not_found,404);if(x.status!=='pending_first_payment')return{status:x.status,sub:publicSub(x)};
 const st=pay().stripe,core=require('./store-core.cjs'),emails=require('./store-email.cjs');
 if(!x.checkout?.id){if(close||now()-(x.created||0)>3600)await closeFirst(x.id,'checkout was never opened');return{status:'pending',sub:publicSub(x)}}
 let sess=await st('/checkout/sessions/'+encodeURIComponent(x.checkout.id)+'?expand[]=payment_intent.payment_method');
 if(close&&sess.status==='open'){try{sess=await st('/checkout/sessions/'+encodeURIComponent(x.checkout.id)+'/expire',{method:'POST'})}catch{sess=await st('/checkout/sessions/'+encodeURIComponent(x.checkout.id)+'?expand[]=payment_intent.payment_method')}}
 if(sess.status==='expired'){await closeFirst(x.id,'checkout closed without payment');return{status:'canceled'}}
 if(!(sess.status==='complete'&&sess.payment_status==='paid'))return{status:'pending',sub:publicSub(x)};
 const o=await transaction(s=>s.get('orders',x.first_order));
 const pi=sess.payment_intent&&typeof sess.payment_intent==='object'?sess.payment_intent:sess.payment_intent?await st('/payment_intents/'+encodeURIComponent(sess.payment_intent)+'?expand[]=payment_method'):null;
 const why=!o?'order missing':sess.id!==x.checkout.id?'session mismatch':sess.metadata?.subscription_id!==x.id?'session is for another subscription':sess.currency!=='usd'?'currency '+sess.currency:(sess.amount_total||0)<o.total?'paid '+sess.amount_total+' of '+o.total:sess.livemode!==pay().stripeLive()?'test/live mismatch':!pi||pi.status!=='succeeded'?'payment not succeeded':(pi.amount_received||0)<o.total?'received less than the total':'';
 if(why){await transaction(async s=>{const y=await s.get('subscriptions',x.id);if(y&&y.status==='pending_first_payment'){y.problem='First payment needs review: '+why+'. Check Stripe before doing anything else.';await s.put('subscriptions',y.id,y)}});return{status:'needs_review',sub:publicSub(x)}}
 const pm=pi.payment_method,pmId=typeof pm==='string'?pm:pm?.id,detail=pm&&typeof pm==='object'?pm:pmId?await st('/payment_methods/'+encodeURIComponent(pmId)):null;
 if(pmId&&x.stripe_customer){try{await st('/customers/'+encodeURIComponent(x.stripe_customer),{method:'POST',body:{invoice_settings:{default_payment_method:pmId}}})}catch{}}
 const jobs=await transaction(async s=>{const y=await s.get('subscriptions',x.id),c=await s.get('orders',x.first_order);if(!y||y.status!=='pending_first_payment')return[];
  if(c.status!=='order_received'){y.problem=COPY.paid_late+' (order '+c.id+' is '+c.status+'; Stripe '+pi.id+')';await s.put('subscriptions',y.id,y);return[]}
  const out=await core.subscriptionCheckoutPaid(s,c,pi,sess);
  const today=todayET();y.status='active';y.payment_method=pmId||'';y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.card_saved_at=now();y.first_paid_at=now();y.deliveries=1;y.orders=[c.id];setShip(y,nextFrom(today,y.every,today));y.problem='';delete y.checkout_url;y.checkout={id:x.checkout.id,expires:0};
  await s.put('subscriptions',y.id,y);out.push(await queueWelcome(s,y,c));return out.filter(Boolean)});
 for(const j of jobs)await emails.safeDispatch(j);
 const y=await transaction(s=>s.get('subscriptions',x.id));return{status:y.status==='active'?'active':y.status,sub:publicSub(y)}}
async function closeFirst(id,why){const core=require('./store-core.cjs');await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x||x.status!=='pending_first_payment')return;const o=x.first_order&&await s.get('orders',x.first_order);if(o&&o.status==='order_received')await core.subscriptionRelease(s,o,'expired');x.status='canceled';x.canceled_at=now();x.canceled_by='checkout';x.problem='';x.closed_reason=why;await s.put('subscriptions',x.id,x)})}
async function queueWelcome(s,x,o){const emails=require('./store-email.cjs');const c=welcomeEmail(x,o);return emails.enqueue(s,{id:'sub-welcome-'+x.id,kind:'subscription_started',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)})}
function manageLink(){return (require('./store-email.cjs').configuration().origin||origin())+'/store-next/account#subscriptions'}
function welcomeEmail(x,o){const n=count(o.items);return{subject:'Your Glow Lab subscription is set',title:'Your subscription is set.',button:'Manage your subscription',
 lines:['Hi '+(String(x.customer?.name||'').trim().split(/\s+/)[0]||'there')+',','Thank you for subscribing. Your first box is paid and in our packing queue.','How often: '+(EVERY[x.every]?.label||x.every)+'.','Next box ships on: '+longDay(shipDate(x))+'.','Box: '+n+' item'+(n===1?'':'s')+'.','We charge your saved card 2 days before each ship date, and we email you 3 days before every charge.','You can skip a box, change your items or how often it arrives, pause or cancel any time from your account.']}}
// The reminder sent 3 days before each charge. One function, so the owner can approve the wording.
function reminderEmail({name,items,amount_cents,charge_date,ship_date}){const n=count(items);return{subject:'Your next Glow Lab box · card charged '+longDay(charge_date),title:'Your next box is coming up.',button:'Skip, change or cancel',
 lines:['Hi '+(String(name||'').trim().split(/\s+/)[0]||'there')+',','Your next subscription box ships on the date you chose. Here are the details:','Box: '+n+' item'+(n===1?'':'s')+'.','Amount: $'+(amount_cents/100).toFixed(2)+' (shipping included).','Card charged on: '+longDay(charge_date)+'.','Ships on: '+longDay(ship_date)+'.','Want to skip this box, change your items or how often it arrives, or cancel? Do it any time before '+longDay(charge_date)+' on your Subscriptions page.','Nothing to do if everything looks right. It arrives on schedule.']}}
// Reminders: active subscriptions whose charge is 1–3 days away, once per ship date, only while the Autopilot
// "Subscribe & save orders" switch is ON.
async function remind(limit=20,t=Date.now()){const emails=require('./store-email.cjs');
 const jobs=await transaction(async s=>{if(!await switchOn(s))return null;if(!emails.configuration().ready)return[];const today=todayET(t),m=await productsOf(s),settings=await s.get('settings','main'),out=[];
  for(const x of (await s.list('subscriptions')).filter(x=>x.status==='active'&&x.pay==='autopay').slice(0,500)){if(out.length>=limit)break;const cd=chargeDate(x),cycle=shipDate(x);
   if(!cd||!(today>=addDays(cd,-REMIND_DAYS_BEFORE_CHARGE)&&today<cd)||x.reminded_for===cycle)continue;
   const r=priceFor(x.items,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings});if(!r.ok)continue;
   const c=reminderEmail({name:x.customer?.name,items:r.lines,amount_cents:r.total_cents,charge_date:cd,ship_date:cycle});
   const job=await emails.enqueue(s,{id:'sub-remind-'+x.id+'-'+cycle,kind:'subscription_reminder',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)});
   if(!job)continue;x.reminded_for=cycle;x.reminded_at=now();await s.put('subscriptions',x.id,x);out.push(job)}
  return out});
 if(jobs===null)return{status:'switch_off',sent:0};for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}
// Customer screen data: their subscriptions with tier, items, price per delivery, dates and card.
function customerView(x,m,settings){const p=pricingOf(x,m,settings);return{id:x.id,status:x.status,every:x.every,every_label:EVERY[x.every]?.label||x.every,next_ship_date:x.status==='active'||x.status==='paused'?shipDate(x):'',charge_date:x.status==='active'?chargeDate(x):'',
 items:(x.items||[]).map(i=>{const pr=m.get(i.id);return{id:i.id,quantity:i.quantity,name:pr?.name||i.name||'Product',price_cents:pr?.price||0,slots:pr?slotsOf(pr):1}}),pricing:p,card:x.card?{brand:x.card.brand,last4:x.card.last4}:null,
 checkout_url:x.status==='pending_first_payment'&&x.checkout?.url&&(x.checkout.expires||0)>now()+300?x.checkout.url:'',problem:x.status==='pending_first_payment'&&x.problem?COPY.pending:'',created:x.created}}
async function customerRoute(path,body,h,method){
 if(!(path==='/subscribe/quote'||path.startsWith('/account/subscri')))return null;
 const brands=require('./brands.cjs'),accounts=require('./customer-accounts.cjs'),brand=brands.fromHeaders(h),ok=b=>({status:200,headers:{},body:b});
 if(path==='/subscribe/quote'&&method==='POST')return ok(await transaction(s=>customerQuote(s,h,brand,body)));
 if(path==='/account/subscribe'&&method==='POST')return ok(await startCheckout(h,body,brand));
 const mine=async(a,id)=>{const x=await transaction(s=>s.get('subscriptions',String(id||'').slice(0,20)));if(!x||!owns(x,a))bad(COPY.not_found,404);return x};
 const me=()=>transaction(s=>accounts.session(s,h,true));
 if(path==='/account/subscriptions'&&method==='GET'){const a=await me();
  // A checkout the customer left open: ask Stripe once more so the page shows the truth.
  const pending=await transaction(async s=>(await s.list('subscriptions')).filter(x=>owns(x,a)&&x.status==='pending_first_payment').map(x=>x.id));for(const id of pending){try{await settleFirst(id)}catch{}}
  return ok(await transaction(async s=>{const m=await productsOf(s),settings=await s.get('settings','main');const list=(await s.list('subscriptions')).filter(x=>owns(x,a)&&!(x.status==='canceled'&&x.canceled_by==='checkout')).sort((p,q)=>(p.status==='canceled'?1:0)-(q.status==='canceled'?1:0)||(q.created||0)-(p.created||0));
   return{subscriptions:list.map(x=>customerView(x,m,settings)),every:CUSTOMER_EVERY.map(k=>({id:k,label:EVERY[k].label})),tiers:TIERS.map(publicTier),max_slots:MAX_SLOTS,slot_max_cents:SLOT_MAX_CENTS}}))}
 if(path==='/account/subscriptions/confirm'&&method==='POST'){const a=await me(),x=await mine(a,body.id);const r=await settleFirst(x.id);return ok({status:r.status,message:r.status==='active'?'':r.status==='pending'||r.status==='needs_review'?COPY.pending:''})}
 if(path==='/account/subscriptions/abandon'&&method==='POST'){const a=await me(),x=await mine(a,body.id);if(x.status==='pending_first_payment')await settleFirst(x.id,{close:true});return ok({ok:true})}
 if(path==='/account/subscriptions/preview'&&method==='POST'){const a=await me(),x=await mine(a,body.id);
  return ok(await transaction(async s=>{const m=await productsOf(s),lines=await validItems(s,body.items,x.brand||'glow',m);return require('./store-core.cjs').subscriptionQuote(s,{items:lines,h:{},brand:brands.get(x.brand||'glow'),deliveryNumber:deliveriesDone(x)+1,bonus_id:x.bonus_id,stockCheck:false})}))}
 if(path==='/account/subscriptions/update'&&method==='POST'){const a=await me(),x=await mine(a,body.id),action=String(body.action||'').slice(0,10);if(!['every','skip','pause','resume','cancel','items'].includes(action))bad('Choose what to change.');
  await update({id:x.id,action,every:String(body.every||'').slice(0,4),items:body.items},{customer:true,owner:a});
  return ok(await transaction(async s=>customerView(await s.get('subscriptions',x.id),await productsOf(s),await s.get('settings','main'))))}
 return null}

// Autopilot: settle first payments; check waiting cards; retry unknown charges; then (10 AM–6 PM Eastern) make each
// repeat order 2 days before its ship date and charge it, and send the 3-days-before-charge reminders.
// A problem (sold out, checkout off) is shown in Management and retried next run; the date only moves once the order exists.
async function run(limit=10,t=Date.now()){
 const ts=Math.floor(t/1000),out={status:'ok',made:0,paid:0,failed:0,cards:0,started:0,reminded:0};
 if(!pay().stripeReady())return{status:'stripe_not_connected',made:0};
 const firsts=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='pending_first_payment').map(x=>({id:x.id,old:ts-(x.created||ts)>25*3600})));
 for(const f of firsts){try{if((await settleFirst(f.id,{close:f.old})).status==='active')out.started++}catch{}}
 const waiting=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='needs_card'&&x.card_session?.id).map(x=>x.id));
 for(const id of waiting){try{if((await checkCard(id)).status==='active')out.cards++}catch{}}
 // Retry charges whose result is not known yet (same idempotency key, so never a second charge).
 const pending=await transaction(async s=>(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>o.payment_method==='card_autopay'&&['charging','unknown'].includes(o.autopay?.status)).map(o=>o.id));
 for(const id of pending){const r=await charge(id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)));if(hour<10||hour>=18){out.status=out.cards||out.paid||out.started?'ok':'quiet_hours';return out}
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs'),autoInvoice=require('./auto-invoice.cjs'),today=todayET(t);
 const due=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='active'&&shipDate(x)&&chargeDate(x)<=today).slice(0,limit).map(x=>x.id));
 for(const id of due){let made=null;
  try{made=await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x||x.status!=='active'||chargeDate(x)>today)return null;const cycle=shipDate(x);
    const r=await core.subscriptionOrder(s,x,cycle);const orderId=r.existing||r.order.id;x.orders=[...(x.orders||[]).filter(o=>o!==orderId),orderId].slice(-50);if(!r.existing)x.deliveries=deliveriesDone(x)+1;
    setShip(x,nextFrom(cycle,x.every,today));x.problem='';x.last_run=ts;await s.put('subscriptions',x.id,x);return r})}
  catch(e){await transaction(async s=>{const x=await s.get('subscriptions',id);if(x){x.problem=String(e&&e.message||e).slice(0,200);x.last_run=ts;await s.put('subscriptions',x.id,x)}});continue}
  if(!made||made.existing)continue;out.made++;for(const j of made.jobs)await emails.safeDispatch(j);
  if(made.autopay){const r=await charge(made.order.id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
  else if(made.invoice){try{await autoInvoice.sendFor(made.invoice)}catch{}}}
 try{out.reminded=(await remind(20,t)).sent||0}catch{}
 return out;
}
module.exports={EVERY,CUSTOMER_EVERY,DISCOUNT_PCT,TIERS,SLOT_MAX_CENTS,MAX_SLOTS,CHARGE_DAYS_BEFORE,REMIND_DAYS_BEFORE_CHARGE,FAIR_PCT,COPY,
 slotsOf,slotsFor,tierFor,tierById,priceFor,bonusDelivery,shippingFor,publicTier,addInterval,addDays,todayET,shipDate,chargeDate,deliveriesDone,
 list,create,update,cardLink,checkCard,charge,run,remind,publicSub,owns,offerOpen,customerRoute,startCheckout,settleFirst,checkoutBody,reminderEmail,welcomeEmail};

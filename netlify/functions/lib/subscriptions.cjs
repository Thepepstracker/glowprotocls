'use strict';
// Subscribe & save. 4 Nov 2026: staff-started, 15% off, AUTO-PAY through Stripe (the customer saves a card once on
// Stripe's own page, and each repeat order is charged to it automatically and marked paid).
// 5 Nov 2026 (Jonah's spec): 5 tiers with a fixed price per delivery, customers subscribe themselves from the bag
// (signed in), pay the first box on Stripe Checkout (card saved for the repeats), and manage it in their account.
// Never charge twice: each charge uses a Stripe idempotency key tied to the order, and an order whose charge
// result is unknown for more than 23 hours stops for staff review instead of being retried. Declines are not retried.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const EVERY={'1w':{days:7,label:'Every week'},'2w':{days:14,label:'Every 2 weeks'},'3w':{days:21,label:'Every 3 weeks'},'4w':{days:28,label:'Every 4 weeks'},'1m':{months:1,label:'Every month'},'2m':{months:2,label:'Every 2 months'},'3m':{months:3,label:'Every 3 months'}};
const CUSTOMER_EVERY=['1w','2w','3w','1m','2m','3m']; // '4w' stays valid for older subscriptions but is not offered to customers
// Every 2 / 3 months (Jonah, 8 Nov 2026): a kit of 10 lasts most people 2–3 months, so kits get a schedule that fits.
const DISCOUNT_PCT=15; // legacy: only used for an older staff-started subscription too big for any tier (over 8 slots)
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const pay=()=>require('./auto-invoice.cjs');

// ---- Tiers (Jonah, 5 Nov 2026) ----
// A "slot" covers up to $65.00 of list price: each unit takes ceil(price / $65) slots (a $49 vial 1, a $92 vial 2, a $408 kit 7).
// The tier is picked automatically: the smallest one that holds the slots used.
const SLOT_MAX_CENTS=6500,CHARGE_DAYS_BEFORE=2,REMIND_DAYS_BEFORE_CHARGE=3,FAIR_PCT=85;
// A declined box waits this long for a new card, then it is skipped and its items go back into stock (Jonah, 8 Nov 2026).
const AUTO_SKIP_DAYS=5;
// The Subscribe & save terms customers tick at checkout (terms.html#subscribe-and-save). Change the date when the terms change.
const TERMS_VERSION='2026-11-08';
const TIERS=[
 {id:'T1',level:1,name:'Tier 1',slots:1,price:3399,free_shipping:false,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T2',level:2,name:'Tier 2',slots:2,price:6499,free_shipping:false,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T3',level:3,name:'Tier 3',slots:3,price:9499,free_shipping:true,points:2,early_access:false,packed_first:false,bonus_every:0},
 {id:'T4',level:4,name:'Tier 4',slots:5,price:14999,free_shipping:true,points:3,early_access:true,packed_first:false,bonus_every:0},
 {id:'T5',level:5,name:'Tier 5',slots:12,price:22999,free_shipping:true,points:4,early_access:true,packed_first:true,bonus_every:4}
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
 if(!t)return{ok:false,error:'A subscription package holds up to '+MAX_SLOTS+' slots. Each slot covers up to $65 of an item’s price. Remove some items or buy the rest as a one-time order.',slots,max_slots:MAX_SLOTS};
 // Exactly 15% off list on every box (Jonah, 6 Nov 2026: "it's gotta be 15% nothing more"). Tiers decide slots and perks only;
 // their old fixed prices ($33.99 to $229.99) gave up to ~32% off and are no longer used for the price.
 // Items already on sale (Jonah, 8 Nov 2026: "better of the two"): the subscriber pays the sale price or 15% off the
 // regular price, whichever is lower, never both. Everything else: exactly 15% off, rounded down on the total as before.
 const list=lines.reduce((n,l)=>n+m.get(l.id).price*l.quantity,0);let full=0,sale=0;
 for(const l of lines){const p=m.get(l.id),reg=Math.max(Number(p.regular_price)||0,p.price);if(reg>p.price)sale+=Math.min(p.price,Math.floor(reg*FAIR_PCT/100))*l.quantity;else full+=p.price*l.quantity}
 const cap=Math.floor(full*FAIR_PCT/100)+sale,price=cap;
 // Tier 5 bonus: every 4th package IN A ROW at Tier 5 (opts.streak), so nobody can jump to Tier 5 for one package to collect it.
 const bp=!opts.no_bonus&&bonusDelivery(t,opts.streak!=null?opts.streak:deliveryNumber)?pickBonus(lines,m,opts.bonus_id):null;
 const all=lines.map(l=>({...l}));if(bp){const hit=all.find(l=>l.id===Number(bp.id));if(hit)hit.quantity++;else all.push({id:Number(bp.id),quantity:1})}
 const listAll=list+(bp?bp.price:0),shipping=shippingFor(t,price,opts.settings);
 const standardShipping=shippingFor(null,listAll,opts.settings);
 return{ok:true,tier:publicTier(t),slots,capacity:t.slots+(bp?1:0),open_slots:Math.max(0,t.slots-slots),list_cents:listAll,regular_list_cents:list,price_cents:price,discount_cents:listAll-price,savings_cents:listAll-price,shipping_cents:shipping,shipping_saved_cents:Math.max(0,standardShipping-shipping),total_cents:price+shipping,
  fair_cap_applied:cap<t.price,points_multiplier:t.points,delivery_number:deliveryNumber,bonus:bp?{id:Number(bp.id),name:String(bp.name||''),list_cents:bp.price}:null,lines:all,
  nudge:null}}
function count(lines){return (lines||[]).reduce((n,l)=>n+(Number(l.quantity)||0),0)}
// One line at subscriber price: 15% off, or the sale price if that is lower (never both).
function subLinePrice(p,qty){const reg=Math.max(Number(p.regular_price)||0,p.price);return reg>p.price?Math.min(p.price,Math.floor(reg*FAIR_PCT/100))*qty:Math.floor(p.price*qty*FAIR_PCT/100)}
// "Add to next package" (Jonah, 8 Nov 2026): one-time extras charged with the next package at subscriber price.
// They do not change the tier, slots or shipping, and they are cleared once that package is made.
const ADDON_MAX_LINES=10,ADDON_MAX_QTY=5;
function addonsPrice(addons,m){let list=0,price=0;const lines=[];for(const a of cleanItems(addons)){const p=productMap(m).get(a.id);if(!p)continue;list+=p.price*a.quantity;price+=subLinePrice(p,a.quantity);lines.push({id:a.id,quantity:a.quantity,name:p.name,price_cents:subLinePrice(p,a.quantity),list_cents:p.price*a.quantity})}return{list_cents:list,price_cents:price,lines}}

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
// Same person, same door: one box. Email, street, apartment and ZIP must all match (case and spacing ignored).
function sameDoor(a,b){const n=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');return !!a&&!!b&&!!n(a.email)&&n(a.email)===n(b.email)&&!!n(a.address)&&n(a.address)===n(b.address)&&n(a.address2)===n(b.address2)&&n(a.zip).slice(0,5)===n(b.zip).slice(0,5)}
// First ship date for a cycle that starts today: never so soon that the charge date is already behind us.
function nextFrom(date,every,today){let next=addInterval(date,every);while(addDays(next,-CHARGE_DAYS_BEFORE)<today)next=addInterval(next,every);return next}
function longDay(d){return d?new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'}):''}
// How many boxes this subscription has had. Staff-started ones count their source order as the first.
function deliveriesDone(x){return Number.isInteger(x.deliveries)?x.deliveries:1+(x.orders||[]).length}

function origin(){return String(process.env.STORE_ORIGIN||'https://glowglps.com').replace(/\/$/,'')}
function publicSub(x){return{id:x.id,status:x.status,pay:x.pay||'invoice',every:x.every,every_label:EVERY[x.every]?.label||x.every,discount_pct:x.discount_pct,next_date:shipDate(x),next_ship_date:shipDate(x),charge_date:chargeDate(x),customer:{name:x.customer?.name||'',email:x.customer?.email||'',phone:x.customer?.phone||'',city:x.customer?.city||'',state:x.customer?.state||''},items:x.items,source_order:x.source_order,orders:x.orders||[],created:x.created,problem:x.problem||'',last_run:x.last_run||0,card:x.card?{brand:x.card.brand,last4:x.card.last4}:null,card_link:x.status==='needs_card'&&x.card_session&&(x.card_session.expires||0)>now()+600?x.card_session.url:'',card_link_expires:x.card_session?.expires||0,source:x.source||'staff',deliveries:deliveriesDone(x),addons:(x.addons||[]).map(a=>({id:a.id,quantity:a.quantity,name:a.name||''})),cancel_reason:x.cancel_reason||'',cancel_note:x.cancel_note||'',canceled_at:x.canceled_at||0}}
async function productsOf(s){return productMap(await s.list('products'))}
// Tier and price of the NEXT delivery, for the admin and customer screens (no stock check; the order itself checks stock).
function streakOf(x){return (Number(x.t5_run)||0)+1}
function pricingOf(x,m,settings){try{const r=priceFor(x.items,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings,streak:streakOf(x)});if(r.ok)return{tier:r.tier,slots:r.slots,price_cents:r.price_cents,shipping_cents:r.shipping_cents,total_cents:r.total_cents,list_cents:r.list_cents,bonus:r.bonus};return{tier:null,slots:r.slots,error:r.error}}catch(e){return{tier:null,slots:0,error:String(e.message)}}}
async function list(){return transaction(async s=>{const m=await productsOf(s),settings=await s.get('settings','main');return(await s.list('subscriptions')).map(x=>({...publicSub(x),pricing:pricingOf(x,m,settings)})).sort((a,b)=>(a.status==='canceled'?1:0)-(b.status==='canceled'?1:0)||String(a.next_date).localeCompare(String(b.next_date)))})}
// Management dashboard numbers (Jonah, 8 Nov 2026). Everything is read from the store's own records.
// Monthly recurring revenue is an estimate: each active subscription's next package total × packages per month.
const PER_MONTH={'1w':52/12,'2w':26/12,'3w':52/36,'4w':13/12,'1m':1,'2m':1/2,'3m':1/3};
async function stats(t=Date.now()){return transaction(async s=>{const all=await s.list('subscriptions'),orders=await (s.listLite?s.listLite('orders'):s.list('orders')),m=await productsOf(s),settings=await s.get('settings','main');
 const ts=Math.floor(t/1000),today=todayET(t),week=addDays(today,7),month=today.slice(0,7),first=n=>String(n||'').trim();
 const active=all.filter(x=>x.status==='active');let mrr=0;const upcoming=[],items=new Map();
 for(const x of active){const p=pricingOf(x,m,settings);const ad=addonsPrice(x.addons||[],m);if(p.total_cents!=null)mrr+=p.total_cents*(PER_MONTH[x.every]||1);const cd=chargeDate(x);
  if(cd&&cd<=week&&p.total_cents!=null)upcoming.push({id:x.id,name:first(x.customer?.name),charge_date:cd,ship_date:shipDate(x),amount_cents:p.total_cents+ad.price_cents,addons:ad.lines.length,payment_issue:!!x.payment_issue});
  for(const i of x.items||[]){const k=m.get(i.id)?.name||i.name||'Product';items.set(k,(items.get(k)||0)+(Number(i.quantity)||0))}}
 const subOrders=orders.filter(o=>o.subscription_id&&o.is_test===false),paid=subOrders.filter(o=>['paid','shipped'].includes(o.status)&&o.paid);
 const paidMonth=paid.filter(o=>todayET(o.paid*1000).slice(0,7)===month);
 const attention=[...all.filter(x=>x.payment_issue).map(x=>{const o=orders.find(o=>o.id===x.payment_issue);return{kind:'declined',id:x.id,name:first(x.customer?.name),order_id:x.payment_issue,amount_cents:o?.total||0,since:o?.autopay?.failed_at||0}}),
  ...subOrders.filter(o=>o.autopay?.status==='needs_review').map(o=>({kind:'review',id:o.subscription_id,name:first(o.customer?.name),order_id:o.id,amount_cents:o.total||0,message:o.autopay.message||''})),
  ...all.filter(x=>x.status==='active'&&x.problem&&!x.payment_issue).map(x=>({kind:'problem',id:x.id,name:first(x.customer?.name),message:x.problem}))];
 const canceled=all.filter(x=>x.status==='canceled'&&['customer','staff'].includes(x.canceled_by)&&(x.canceled_at||0)>=ts-30*86400),reasons={};
 for(const x of canceled){const k=x.cancel_reason||'none';reasons[k]=(reasons[k]||0)+1}
 return{active:active.length,paused:all.filter(x=>x.status==='paused').length,waiting:all.filter(x=>['needs_card','pending_first_payment'].includes(x.status)).length,
  mrr_cents:Math.round(mrr),upcoming:upcoming.sort((a,b)=>a.charge_date.localeCompare(b.charge_date)),attention,
  month:{label:month,revenue_cents:paidMonth.reduce((n,o)=>n+(o.total||0),0),packages:paidMonth.length},
  lifetime:{revenue_cents:paid.reduce((n,o)=>n+(o.total||0),0),packages:paid.length,customer_saved_cents:paid.reduce((n,o)=>n+(Number(o.subscription_discount)||0),0)},
  cancels_30d:{count:canceled.length,reasons:Object.entries(reasons).map(([k,n])=>({reason:k,label:CANCEL_REASONS[k]||'No reason given',count:n})).sort((a,b)=>b.count-a.count),notes:canceled.filter(x=>x.cancel_note).slice(-5).map(x=>({name:first(x.customer?.name),note:x.cancel_note}))},
  top_products:[...items].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,qty])=>({name,qty}))}})}
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
// Why customers cancel (optional, asked once on the cancel screen). Keys are stored; labels are shown.
const CANCEL_REASONS={too_much:'I have too much right now',price:'It costs too much',not_needed:'I don’t need it anymore',switching:'I’m trying something else',delivery:'Shipping or delivery problem',other:'Something else'};
async function update({id,action,every,next_date,items,address,reason,note,together_with},{customer=false,owner=null}={}){
 if(action==='link')return cardLink(id);
 if(action==='check')return checkCard(String(id||'').slice(0,20));
 if(action==='clear'){if(customer||owner)bad('Not available.',403);return clearFirst(String(id||'').slice(0,20))}
 let jobs=[];
 const out=await transaction(async s=>{const x=await s.get('subscriptions',String(id||'').slice(0,20));if(!x||(owner&&!owns(x,owner)))bad('Subscription not found.',404);if(x.status==='canceled')bad('This subscription is canceled.',409);
 if(x.status==='pending_first_payment'&&action!=='cancel')bad(customer?'Your first payment is still being confirmed. Try again in a minute.':'Waiting for the first payment on Stripe.',409);
 const today=todayET(),was=x.status;
 if(action==='every'){if(!EVERY[every]||(customer&&!CUSTOMER_EVERY.includes(every)))bad('Choose how often.');x.every=every}
 else if(action==='pause'){if(x.status==='needs_card')bad('Waiting for the card. Cancel it instead.',409);x.status='paused'}
 else if(action==='resume'){if(x.status!=='paused')bad('Only a paused subscription can be resumed.',409);x.status='active';if(chargeDate(x)<today)setShip(x,nextFrom(today,x.every,today))}
 else if(action==='cancel'){x.status='canceled';x.canceled_at=now();x.canceled_by=customer?'customer':'staff';
  if(CANCEL_REASONS[reason])x.cancel_reason=reason;if(typeof note==='string'&&note.trim())x.cancel_note=note.trim().replace(/\s+/g,' ').slice(0,200);
  // A declined box still waiting for a card is not shipped or charged after a cancel: its items go back into stock.
  if(x.payment_issue){const o=await s.get('orders',x.payment_issue);if(o&&o.status==='order_received'&&o.autopay?.status==='failed'){o.autopay={...o.autopay,status:'skipped',skipped_at:now()};await require('./store-core.cjs').subscriptionRelease(s,o,'canceled')}delete x.payment_issue}
  // Tell the customer it is done, and tell the shop (Jonah, 8 Nov 2026). Only for a subscription that had started.
  if(['active','paused'].includes(was))jobs=[await queueCanceled(s,x),...await staffAlert(s,{id:'sub-canceled-'+x.id,brand:x.brand,subject:'Subscription canceled'+(customer?' by the customer':'')+' · '+(x.customer?.name||x.id)+' · '+x.id,lines:[(x.customer?.name||'A customer')+' canceled '+x.id+'.','Items: '+(x.items||[]).map(i=>(i.name||'Product')+' × '+i.quantity).join(', ')+'.','How often: '+(EVERY[x.every]?.label||x.every)+'.','Packages so far: '+deliveriesDone(x)+'.',...(x.cancel_reason?['Reason: '+CANCEL_REASONS[x.cancel_reason]+'.']:[]),...(x.cancel_note?['They wrote: “'+x.cancel_note+'”']:[])]})]}
 else if(action==='skip'){let next=addInterval(shipDate(x),x.every);while(addDays(next,-CHARGE_DAYS_BEFORE)<today)next=addInterval(next,x.every);setShip(x,next)}
 else if(action==='date'){if(!validDate(next_date)||next_date<today)bad('Choose a date from today on.');if(customer&&addDays(next_date,-CHARGE_DAYS_BEFORE)<today)bad('Choose a ship date at least 2 days from today.');setShip(x,next_date)}
 else if(action==='items'){const m=await productsOf(s),lines=await validItems(s,items,x.brand||'glow',m);const r=priceFor(lines,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings:await s.get('settings','main'),streak:streakOf(x)});if(!r.ok)bad(r.error,409);x.items=lines.map(l=>({id:l.id,quantity:l.quantity,name:m.get(l.id).name}));x.tier=r.tier.id}
 else if(action==='address'){x.customer=shipTo(x,address);x.address_changed_at=now()}
 // Ship with my other package: move this one's next ship date onto another active subscription's, same person, same door.
 else if(action==='together'){const y=await s.get('subscriptions',String(together_with||'').slice(0,20));if(!y||y.id===x.id||y.status!=='active'||(owner&&!owns(y,owner))||!sameDoor(x.customer,y.customer))bad('That package can’t ship with this one.',409);
  const d=shipDate(y);if(!d||addDays(d,-CHARGE_DAYS_BEFORE)<today)bad('Your other package is charged too soon to join it. Try again after it ships.',409);if(x.status!=='active')bad('Resume this subscription first.',409);setShip(x,d);x.ships_with_sub=y.id}
 else bad('Choose what to change.');
 x.problem=action!=='cancel'&&x.payment_issue?x.problem:'';
 x.updated_at=now();await s.put('subscriptions',x.id,x);return publicSub(x)});
 const emails=require('./store-email.cjs');for(const j of jobs.filter(Boolean))await emails.safeDispatch(j);return out}
// New ship-to address for future boxes (customer or staff). Same checks as checkout; the email stays the account email.
function shipTo(x,input){const a=input&&typeof input==='object'?input:{},str=v=>typeof v==='string'?v:'';
 const c=require('./store-core.cjs').checkoutCustomer({name:str(a.name)||x.customer?.name||'',email:x.customer?.email||'',phone:str(a.phone)||x.customer?.phone||'',address:str(a.address),city:str(a.city),state:str(a.state),zip:str(a.zip)});
 const address2=str(a.address2).trim();if(address2.length>100)bad('Apartment or suite is too long.');
 return{...x.customer,name:c.name,phone:c.phone,address:c.address,address2,city:c.city,state:c.state,zip:c.zip}}
async function validItems(s,items,brandId,m){const brands=require('./brands.cjs'),lines=cleanItems(items);if(!lines.length)bad('Add at least one product.');if(lines.length>40)bad('Too many products.');const seen=new Set();
 for(const l of lines){if(seen.has(l.id))bad('Duplicate product.');seen.add(l.id);if(l.quantity>20)bad('Up to 20 of one product.');const p=m.get(l.id);if(!p||!p.active||brands.productBrand(p)!==brandId)bad('A product is unavailable.')}return lines}
// Charge one repeat order to the saved card. The idempotency key is the order id, so a retry can never charge twice.
async function charge(orderId){const t=now();
 const o=await transaction(s=>s.get('orders',orderId));if(!o||o.payment_method!=='card_autopay'||!['charging','unknown'].includes(o.autopay?.status))return{status:'skipped'};
 // Never charge an order that was canceled, marked paid or changed while its charge was waiting (Jonah, 8 Nov 2026).
 if(o.status!=='order_received')return review(orderId,'This order was '+o.status+' before its card charge finished. Nothing more will be charged. Check Stripe before doing anything else.');
 if(t-(o.autopay.started||o.created)>23*3600)return review(orderId,'The card charge result was never confirmed. Check Stripe before doing anything else.');
 const sub=await transaction(s=>s.get('subscriptions',o.subscription_id));if(!sub?.stripe_customer||!sub.payment_method)return markFail(orderId,sub,'No saved card on this subscription.');
 let pi;try{pi=await pay().stripe('/payment_intents',{method:'POST',idem:chargeKey(o),body:{amount:o.total,currency:'usd',customer:sub.stripe_customer,payment_method:sub.payment_method,off_session:true,confirm:true,description:'Glow Lab',metadata:{order_id:o.id,subscription_id:sub.id}}})}
 catch(e){if(e.uncertain){await transaction(async s=>{const c=await s.get('orders',orderId);c.autopay={...c.autopay,status:'unknown',message:'Stripe did not answer. It will be checked again.'};await s.put('orders',orderId,c)});return{status:'unknown'}}return markFail(orderId,sub,String(e.message||'Card was declined.').replace(/^Stripe: /,''))}
 if(pi.status!=='succeeded'||pi.currency!=='usd'||pi.amount_received<o.total||pi.livemode!==pay().stripeLive())return markFail(orderId,sub,pi.status==='requires_action'?'The card needs the customer to confirm it (bank check). Send them a new card link.':'Charge not completed ('+pi.status+').');
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs');
 const job=await transaction(async s=>{const c=await s.get('orders',orderId);if(c.status!=='order_received')return null;return core.subscriptionChargePaid(s,c,pi)});
 if(job)await emails.safeDispatch(job);return{status:'paid'}}
// One Stripe idempotency key per attempt. Attempt 1 keeps the original key; a new attempt is only made after a definite
// decline and a new card (retryFailed), so a charge that may have gone through is never sent again.
function chargeKey(o){const n=Number(o.autopay?.attempt)||1;return 'glow-sub-charge-'+o.id+(n>1?'-'+n:'')}
// A declined box: the order waits (items held) for AUTO_SKIP_DAYS; the customer is emailed once per attempt to update
// their card; the shop gets an alert.
async function markFail(orderId,sub,message){const jobs=await transaction(async s=>{const out=[];const c=await s.get('orders',orderId);const y=sub&&await s.get('subscriptions',sub.id);
  if(c){c.autopay={...(c.autopay||{}),status:'failed',message:String(message).slice(0,200),failed_at:now()};await s.put('orders',orderId,c)}
  if(y){y.problem='Repeat order '+orderId+' was not paid: '+String(message).slice(0,160);y.payment_issue=orderId;await s.put('subscriptions',y.id,y)}
  if(c&&y&&c.is_test===false){const n=Number(c.autopay.attempt)||1,skip=longDay(addDays(todayET(),AUTO_SKIP_DAYS));
   out.push(await queueDeclined(s,y,c,skip,n));
   out.push(...await staffAlert(s,{id:'sub-declined-'+orderId+'-'+n,brand:y.brand,subject:'Subscription card declined · '+(y.customer?.name||y.id)+' · '+orderId,lines:['The saved card for '+(y.customer?.name||'this customer')+' ('+y.id+') was not charged for '+orderId+'.','Reason: '+String(message).slice(0,160),'Amount: $'+((c.total||0)/100).toFixed(2)+'.','They were emailed a link to update their card. The box is charged as soon as they do.','If nothing changes by '+skip+', the package is canceled and its items go back into stock.']}))}
  return out.filter(Boolean)});
 const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return{status:'failed',message}}
// A charge whose result is unclear, or an order that changed under it: stop and ask the shop to check Stripe.
async function review(orderId,message){const jobs=await transaction(async s=>{const c=await s.get('orders',orderId);if(!c)return[];c.autopay={...c.autopay,status:'needs_review',message};await s.put('orders',orderId,c);
  const y=c.subscription_id&&await s.get('subscriptions',c.subscription_id);if(y){y.problem='Repeat order '+orderId+' needs review: '+message.slice(0,140);await s.put('subscriptions',y.id,y)}
  return c.is_test===false?staffAlert(s,{id:'sub-review-'+orderId,brand:c.brand,subject:'Check Stripe · subscription charge needs review · '+orderId,lines:[message,'Order: '+orderId+' · $'+((c.total||0)/100).toFixed(2)+'.','Customer: '+(c.customer?.name||'')+' ('+(c.subscription_id||'')+').']}):[]});
 const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return{status:'needs_review'}}
// After a new card: charge the declined box again (a new attempt, a new idempotency key). Only a box that was
// definitely declined and is still waiting is charged; anything else is left alone.
async function retryFailed(subId){const ids=await transaction(async s=>{const out=[];for(const o of await (s.listLite?s.listLite('orders'):s.list('orders'))){if(o.subscription_id!==subId||o.payment_method!=='card_autopay'||o.status!=='order_received'||o.autopay?.status!=='failed')continue;
   const c=await s.get('orders',o.id);c.autopay={status:'charging',started:now(),attempt:(Number(c.autopay?.attempt)||1)+1,previous:c.autopay?.message||''};await s.put('orders',c.id,c);out.push(c.id)}return out});
 const results=[];for(const id of ids)results.push(await charge(id));
 if(results.length&&results.every(r=>r.status==='paid'))await transaction(async s=>{const y=await s.get('subscriptions',subId);if(y){y.problem='';delete y.payment_issue;await s.put('subscriptions',y.id,y)}});
 return{charged:results.filter(r=>r.status==='paid').length,failed:results.filter(r=>r.status==='failed').length,tried:results.length}}
// The customer replaces their saved card on Stripe's own page (setup mode: nothing is charged there, no product names).
async function cardUpdateLink(id,owner){const x=await transaction(s=>s.get('subscriptions',String(id||'').slice(0,20)));if(!x||(owner&&!owns(x,owner)))bad(COPY.not_found,404);
 if(!['active','paused'].includes(x.status))bad('Only an active or paused subscription can change its card.',409);if(!x.stripe_customer)bad('This subscription has no card on file yet.',409);
 if(x.card_update?.url&&(x.card_update.expires||0)>now()+600)return{url:x.card_update.url};
 const sess=await pay().stripe('/checkout/sessions',{method:'POST',idem:'glow-sub-cardupd-'+x.id+'-'+crypto.randomBytes(6).toString('hex'),body:{mode:'setup',customer:x.stripe_customer,currency:'usd',payment_method_types:['card'],success_url:origin()+'/store-next/account?card_saved='+x.id,cancel_url:origin()+'/store-next/account#subscriptions',metadata:{subscription_id:x.id},setup_intent_data:{metadata:{subscription_id:x.id},description:'Glow Lab'}}});
 if(!sess?.id||!sess.url)bad(COPY.checkout_failed,502);
 await transaction(async s=>{const y=await s.get('subscriptions',x.id);y.card_update={id:sess.id,url:sess.url,expires:sess.expires_at||now()+86400};await s.put('subscriptions',y.id,y)});return{url:sess.url}}
// Did the customer save a new card? Then it becomes the card for every future box, and a declined box is charged again.
async function checkCardUpdate(id){const x=await transaction(s=>s.get('subscriptions',String(id||'').slice(0,20)));if(!x?.card_update?.id)return{status:'none'};
 const st=pay().stripe,sess=await st('/checkout/sessions/'+encodeURIComponent(x.card_update.id)+'?expand[]=setup_intent');
 const clear=async()=>transaction(async s=>{const y=await s.get('subscriptions',x.id);if(y&&y.card_update?.id===x.card_update.id){delete y.card_update;await s.put('subscriptions',y.id,y)}});
 if(sess.status==='expired'||(sess.status!=='complete'&&(x.card_update.expires||0)<now())){await clear();return{status:'expired'}}
 const pm=sess.setup_intent?.payment_method,pmId=typeof pm==='string'?pm:pm?.id;
 if(sess.status!=='complete'||sess.setup_intent?.status!=='succeeded'||!pmId)return{status:'pending'};
 if((sess.metadata?.subscription_id&&sess.metadata.subscription_id!==x.id)||(sess.customer&&(typeof sess.customer==='string'?sess.customer:sess.customer.id)!==x.stripe_customer)){await clear();return{status:'mismatch'}}
 const detail=typeof pm==='object'&&pm.card?pm:await st('/payment_methods/'+encodeURIComponent(pmId));
 await st('/customers/'+encodeURIComponent(x.stripe_customer),{method:'POST',body:{invoice_settings:{default_payment_method:pmId}}});
 const saved=await transaction(async s=>{const y=await s.get('subscriptions',x.id);if(!y||y.card_update?.id!==x.card_update.id)return false;y.payment_method=pmId;y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.card_saved_at=now();y.card_updates=(y.card_updates||0)+1;delete y.card_update;if(/No saved card|not paid|declined/i.test(y.problem||'')&&!y.payment_issue)y.problem='';await s.put('subscriptions',y.id,y);return true});
 if(!saved)return{status:'none'};
 const retry=await retryFailed(x.id);return{status:'saved',retry}}
async function queueDeclined(s,x,o,skip,n){const emails=require('./store-email.cjs'),c=declinedEmail({name:x.customer?.name,card:x.card,items:o.items,amount_cents:o.total,skip_date:skip});
 return emails.enqueue(s,{id:'sub-declined-'+o.id+'-'+n,kind:'subscription_declined',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,expires:now()+3*86400,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)})}
async function queueCanceled(s,x){const emails=require('./store-email.cjs'),c=canceledEmail({name:x.customer?.name});
 return emails.enqueue(s,{id:'sub-canceled-'+x.id,kind:'subscription_canceled',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)})}
// Alerts to the shop's own inbox (the same addresses as new-order alerts). Each id is sent once. Like order alerts,
// they never include the customer's email, phone or street.
async function staffAlert(s,{id,brand,subject,lines}){const emails=require('./store-email.cjs'),out=[];
 for(const to of emails.alertRecipients())out.push(await emails.enqueue(s,{id:id+'-'+crypto.createHash('sha256').update(to).digest('hex').slice(0,10),kind:'staff_subscription_alert',brand:brand||'glow',to,related_id:id,expires:now()+86400,subject,content:emails.template(subject,lines,origin()+'/store-next/admin','Open Management')}));
 return out.filter(Boolean)}

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
 agree:'Please check the box to agree to the Subscribe & save terms.',
 pending:'Your first payment is still being confirmed. Refresh in a minute.',
 paid_late:'Your payment arrived after this checkout had closed. We will contact you to sort it out. Please do not pay again.'
};
async function customerQuote(s,h,brand,body){const closed=await offerOpen(s,brand),core=require('./store-core.cjs');
 const r=await core.subscriptionQuote(s,{items:body.items,h,brand,deliveryNumber:1});
 const veterans=r.ok&&!closed?await require('./veterans-day.cjs').view(s,brand,r.order.subtotal-r.order.discount):null;
 return{available:!closed,reason:closed,signed_in:!!await require('./customer-accounts.cjs').session(s,h),every:CUSTOMER_EVERY.map(k=>({id:k,label:EVERY[k].label})),tiers:TIERS.map(publicTier),...r,veterans}}
// Bag → "Subscribe & save": makes the first order (tier price) and a subscription waiting for its first payment,
// then opens Stripe Checkout for exactly the order total. The card is saved on Stripe for the repeat boxes.
async function startCheckout(h,body,brand){
 const accounts=require('./customer-accounts.cjs'),core=require('./store-core.cjs');
 const every=String(body.every||'');if(!CUSTOMER_EVERY.includes(every))bad('Choose how often.');
 if(body.agree!==true)bad(COPY.agree);
 const key=String(body.idempotency_key||'').slice(0,100);if(key.length<8)bad('Refresh the page and try again.');
 const prior=await transaction(async s=>{const a=await accounts.session(s,h);if(!a)bad(COPY.sign_in,401);const done=await s.get('idempotency','subscribe-'+key);if(done){const x=await s.get('subscriptions',done.id);if(x&&owns(x,a)&&x.status==='pending_first_payment'&&x.checkout?.url&&(x.checkout.expires||0)>now()+300)return{again:{id:x.id,url:x.checkout.url}};bad('This subscription was already started. Check your account.',409)}
  const closed=await offerOpen(s,brand);if(closed)bad(closed,503);return{a,old:(await s.list('subscriptions')).filter(x=>x.status==='pending_first_payment'&&owns(x,a)).map(x=>x.id)}});
 if(prior.again)return prior.again;
 for(const id of prior.old){try{await settleFirst(id,{close:true})}catch{}} // an earlier unfinished checkout gives its items back first
 const made=await transaction(async s=>{const a=await accounts.session(s,h);if(!a)bad(COPY.sign_in,401);if(await s.get('idempotency','subscribe-'+key))bad('This subscription was already started. Check your account.',409);
  const r=await core.subscriptionFirstOrder(s,{account:a,customer:body.customer,items:body.items,every,brand,h,gift:{bag:body.gift_bag,kit_id:body.gift_kit_id}});
  if(r.order.veterans_day)r.sub.veterans_day={tiers:r.order.veterans_day.tiers,bag:r.order.veterans_day.bag,kit_id:r.order.veterans_day.kit_id};
  // What they agreed to, kept with the subscription (proof for a dispute): the terms version, the price and how often.
  r.sub.consent={terms_version:TERMS_VERSION,agreed_at:now(),amount_cents:r.order.total,every,user_agent:String(h['user-agent']||'').slice(0,200)};r.sub.t5_run=0;await s.put('subscriptions',r.sub.id,r.sub);
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
  const today=todayET();y.status='active';y.payment_method=pmId||'';y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.card_saved_at=now();y.first_paid_at=now();y.deliveries=1;y.t5_run=c.subscription_tier==='T5'?1:0;y.orders=[c.id];setShip(y,nextFrom(today,y.every,today));y.problem='';delete y.checkout_url;y.checkout={id:x.checkout.id,expires:0};
  await s.put('subscriptions',y.id,y);out.push(await queueWelcome(s,y,c));return out.filter(Boolean)});
 for(const j of jobs)await emails.safeDispatch(j);
 const y=await transaction(s=>s.get('subscriptions',x.id));return{status:y.status==='active'?'active':y.status,sub:publicSub(y)}}
// Staff "Clear" (Jonah, 13 Nov 2026, Melissa Lopez SUB-C047FAFD): a first box that Stripe shows as paid but that was held
// for review (its order lost the 15% in an item edit, or the team already marked it paid and shipped it). Re-checks Stripe
// first. If Stripe received at least the box's subscription price, the order record is set to what Stripe charged and the
// subscription starts (card saved for the next box). Never charges, refunds, cancels or emails anyone.
async function clearFirst(id){
 const x=await transaction(s=>s.get('subscriptions',id));if(!x)bad(COPY.not_found,404);if(x.status!=='pending_first_payment')bad('Only a subscription waiting for its first payment can be cleared.',409);
 if(!x.checkout?.id)bad('This subscription has no Stripe checkout to check.',409);
 const st=pay().stripe,sess=await st('/checkout/sessions/'+encodeURIComponent(x.checkout.id)+'?expand[]=payment_intent.payment_method');
 if(!(sess.status==='complete'&&sess.payment_status==='paid'))bad('Stripe does not show the first payment as paid, so nothing was changed.',409);
 const pi=sess.payment_intent&&typeof sess.payment_intent==='object'?sess.payment_intent:sess.payment_intent?await st('/payment_intents/'+encodeURIComponent(sess.payment_intent)+'?expand[]=payment_method'):null;
 const o=await transaction(s=>s.get('orders',x.first_order));if(!o)bad('The first order is missing.',409);if(['canceled','expired'].includes(o.status))bad('The first order is '+o.status+'.',409);
 const price=(o.subtotal||0)-(Number(o.subscription_discount)||0)+(o.shipping||0);
 const why=sess.id!==x.checkout.id?'session mismatch':sess.metadata?.subscription_id!==x.id?'the Stripe payment is for another subscription':sess.currency!=='usd'?'currency '+sess.currency:sess.livemode!==pay().stripeLive()?'test/live mismatch':!pi||pi.status!=='succeeded'?'the payment did not succeed':(pi.amount_received||0)<price||(sess.amount_total||0)<price?'Stripe received less than the subscription price ('+(pi.amount_received||0)+' of '+price+')':'';
 if(why)bad('Not cleared: '+why+'.',409);
 const pm=pi.payment_method,pmId=typeof pm==='string'?pm:pm?.id,detail=pm&&typeof pm==='object'?pm:pmId?await st('/payment_methods/'+encodeURIComponent(pmId)):null;
 if(pmId&&x.stripe_customer){try{await st('/customers/'+encodeURIComponent(x.stripe_customer),{method:'POST',body:{invoice_settings:{default_payment_method:pmId}}})}catch{}}
 const core=require('./store-core.cjs');
 const r=await transaction(async s=>{const y=await s.get('subscriptions',x.id),c=await s.get('orders',x.first_order);if(!y||y.status!=='pending_first_payment')bad('This subscription changed. Refresh and try again.',409);
  const paid=pi.amount_received||sess.amount_total;
  // The order record: the subscription price Stripe charged (the 15% back on it), and Stripe as the payment.
  c.discount=(Number(c.subscription_discount)||0)+(c.coupon_discount||0)+(c.rewards_discount||0);c.total=price;c.points_to_earn=Math.floor(Math.floor((c.subtotal-c.discount)/100)*(c.subscription_points_multiplier||1));
  if(!c.customer_id)c.points_earned=c.paid?c.points_to_earn:0;
  c.stripe_checkout={session:sess.id,payment_intent:pi.id,amount:paid,paid_at:now(),cleared_by_staff:true};if(!c.payment_reference)c.payment_reference=pi.id;
  let jobs=[];
  if(c.status==='order_received'){jobs=await core.subscriptionCheckoutPaid(s,c,pi,sess)}
  else{if(c.verified_payment_cents!=null)c.verified_payment_cents=paid;c.balance_due_cents=Math.max(0,price-paid);c.refund_due_cents=Math.max(0,paid-price);c.revision=(c.revision||0)+1;c.updated=now();await s.put('orders',c.id,c)}
  const today=todayET();y.status='active';y.payment_method=pmId||'';y.card={brand:detail?.card?.brand||'card',last4:detail?.card?.last4||''};y.card_saved_at=now();y.first_paid_at=now();y.deliveries=1;y.t5_run=c.subscription_tier==='T5'?1:0;y.orders=[c.id];setShip(y,nextFrom(today,y.every,today));y.problem='';y.cleared_at=now();delete y.checkout_url;y.checkout={id:x.checkout.id,expires:0};
  await s.put('subscriptions',y.id,y);return{y,jobs,order:{id:c.id,status:c.status,total:c.total}}});
 return{status:'active',sub:publicSub(r.y),order:r.order,source_order:x.first_order}}
async function skipStale(ts){const core=require('./store-core.cjs');
 const ids=await transaction(async s=>(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>o.payment_method==='card_autopay'&&o.status==='order_received'&&o.autopay?.status==='failed'&&todayET(ts*1000)>addDays(todayET((o.autopay.failed_at||ts)*1000),AUTO_SKIP_DAYS)).map(o=>o.id));let n=0;
 for(const id of ids){const done=await transaction(async s=>{const o=await s.get('orders',id);if(!o||o.status!=='order_received'||o.autopay?.status!=='failed')return false;o.autopay={...o.autopay,status:'skipped',skipped_at:ts};await core.subscriptionRelease(s,o,'canceled');
   const x=o.subscription_id&&await s.get('subscriptions',o.subscription_id);if(x){if(Number.isInteger(x.deliveries)&&x.deliveries>0)x.deliveries--;if(o.subscription_tier==='T5'&&x.t5_run>0)x.t5_run--;if(x.payment_issue===o.id)delete x.payment_issue;x.problem='Package '+o.id+' was canceled: no new card within '+AUTO_SKIP_DAYS+' days.';await s.put('subscriptions',x.id,x)}return true});if(done)n++}
 return n}
async function closeFirst(id,why){const core=require('./store-core.cjs');await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x||x.status!=='pending_first_payment')return;const o=x.first_order&&await s.get('orders',x.first_order);if(o&&o.status==='order_received')await core.subscriptionRelease(s,o,'expired');x.status='canceled';x.canceled_at=now();x.canceled_by='checkout';x.problem='';x.closed_reason=why;await s.put('subscriptions',x.id,x)})}
async function queueWelcome(s,x,o){const emails=require('./store-email.cjs');const c=welcomeEmail(x,o);return emails.enqueue(s,{id:'sub-welcome-'+x.id,kind:'subscription_started',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)})}
function manageLink(){return (require('./store-email.cjs').configuration().origin||origin())+'/store-next/account#subscriptions'}
function welcomeEmail(x,o){const n=count(o.items);return{subject:'You’re subscribed: 15% off every Glow Lab package',title:'You’re in. 15% off every package from here on.',button:'Manage your subscription',
 lines:['Hi '+(String(x.customer?.name||'').trim().split(/\s+/)[0]||'there')+',','Thank you for subscribing. Your first package is paid and in our packing queue.','You saved $'+((Number(o.subscription_discount)||0)/100).toFixed(2)+' on it, and you save 15% on every package after it. You never have to reorder or worry about running out.','How often: '+(EVERY[x.every]?.label||x.every)+'.','Next package ships on: '+longDay(shipDate(x))+'.','Package: '+n+' item'+(n===1?'':'s')+'.','We charge your saved card 2 days before each ship date, and we email you 3 days before every charge.','Once a package is charged it is final and ships. If anything arrives damaged or missing, just reply to this email.','You can skip a package, change your items or how often it arrives, pause or cancel any time from your account.']}}
// Sent when the saved card is declined for a box. One function, so the owner can approve the wording.
function declinedEmail({name,card,items,amount_cents,skip_date}){const n=count(items),cd=card&&card.last4?String(card.brand||'card').replace(/^./,c=>c.toUpperCase())+' ending in '+card.last4:'your saved card';return{subject:'Action needed: update your card for your Glow Lab package',title:'We couldn’t charge your card.',button:'Update your card',
 lines:['Hi '+(String(name||'').trim().split(/\s+/)[0]||'there')+',','We tried to charge '+cd+' for your next subscription package, but it did not go through. Nothing was charged.','Package: '+n+' item'+(n===1?'':'s')+'.','Amount: $'+((amount_cents||0)/100).toFixed(2)+' (shipping included).','To keep this package on schedule, update your card on your Subscriptions page. We charge the new card right away and your package ships.','If your card isn’t updated by '+skip_date+', we’ll stop delivering this package. Your subscription stays on.','Questions? Just reply to this email.']}}
// Sent when a subscription is canceled. One function, so the owner can approve the wording.
function canceledEmail({name}){return{subject:'Your Glow Lab subscription is canceled',title:'Your subscription is canceled.',button:'Your account',
 lines:['Hi '+(String(name||'').trim().split(/\s+/)[0]||'there')+',','Your subscription is canceled. No more packages will be charged or shipped.','Any package already paid for still ships.','Changed your mind? You can start a new subscription from your bag any time.','Questions? Just reply to this email.']}}
// The reminder sent 3 days before each charge. One function, so the owner can approve the wording.
function reminderEmail({name,items,amount_cents,charge_date,ship_date,saved_cents=0}){const n=count(items);return{subject:'Your next Glow Lab package · card charged '+longDay(charge_date),title:'Your next package is coming up.',button:'Skip, change or cancel',
 lines:['Hi '+(String(name||'').trim().split(/\s+/)[0]||'there')+',','Your next subscription package ships on the date you chose. Here are the details:','Package: '+n+' item'+(n===1?'':'s')+'.','Amount: $'+(amount_cents/100).toFixed(2)+' (shipping included).',...(saved_cents>0?['As a subscriber you save $'+(saved_cents/100).toFixed(2)+' on this package.']:[]),'Card charged on: '+longDay(charge_date)+'.','Ships on: '+longDay(ship_date)+'.','Want to skip this package, change your items or how often it arrives, or cancel? Do it any time before '+longDay(charge_date)+' on your Subscriptions page.','Once your card is charged, this package is final and ships.','Nothing to do if everything looks right. It arrives on schedule.']}}
// Reminders: active subscriptions whose charge is 1–3 days away, once per ship date, only while the Autopilot
// "Subscribe & save orders" switch is ON.
async function remind(limit=20,t=Date.now()){const emails=require('./store-email.cjs');
 const jobs=await transaction(async s=>{if(!await switchOn(s))return null;if(!emails.configuration().ready)return[];const today=todayET(t),m=await productsOf(s),settings=await s.get('settings','main'),out=[];
  for(const x of (await s.list('subscriptions')).filter(x=>x.status==='active'&&x.pay==='autopay').slice(0,500)){if(out.length>=limit)break;const cd=chargeDate(x),cycle=shipDate(x);
   if(!cd||!(today>=addDays(cd,-REMIND_DAYS_BEFORE_CHARGE)&&today<cd)||x.reminded_for===cycle||x.payment_issue)continue;
   const r=priceFor(x.items,m,null,deliveriesDone(x)+1,{bonus_id:x.bonus_id,settings,streak:streakOf(x)});if(!r.ok)continue;
   const ad=addonsPrice(x.addons||[],m);const c=reminderEmail({name:x.customer?.name,items:[...r.lines,...ad.lines],amount_cents:r.total_cents+ad.price_cents,charge_date:cd,ship_date:cycle,saved_cents:(r.discount_cents||0)+(r.shipping_saved_cents||0)+(ad.list_cents-ad.price_cents)});
   const job=await emails.enqueue(s,{id:'sub-remind-'+x.id+'-'+cycle,kind:'subscription_reminder',brand:x.brand||'glow',to:x.customer.email,related_id:x.id,subject:c.subject,content:emails.template(c.title,c.lines,manageLink(),c.button)});
   if(!job)continue;x.reminded_for=cycle;x.reminded_at=now();await s.put('subscriptions',x.id,x);out.push(job)}
  return out});
 if(jobs===null)return{status:'switch_off',sent:0};for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}
// Customer screen data: their subscriptions with tier, items, price per delivery, dates and card.
// What the customer has saved on this subscription so far (Jonah, 6 Nov 2026: "so they see they're benefitting"):
// the 15% on every paid box plus the shipping they didn't pay (standard shipping for that box minus what was charged).
function savedOf(x,orders,settings){let saved=0,boxes=0;for(const o of orders||[]){if(o.subscription_id!==x.id||o.is_test!==false||!['paid','shipped'].includes(o.status))continue;boxes++;
 const off=Number.isInteger(o.subscription_discount)?o.subscription_discount:0,std=shippingFor(null,Number(o.subtotal)||0,settings),ship=Number(o.shipping)||0;saved+=off+Math.max(0,std-ship)}return{saved_cents:saved,boxes}}
// The declined box still waiting for a new card, if any (amount, and the day it is skipped).
function issueOf(x,orders){if(!x.payment_issue)return null;const o=(orders||[]).find(o=>o.id===x.payment_issue);if(!o||o.status!=='order_received'||o.autopay?.status!=='failed')return null;
 const f=o.autopay.failed_at||now();return{order_id:o.id,amount_cents:o.total||0,ship_date:o.ship_date||o.subscription_cycle||'',skip_date:addDays(todayET(f*1000),AUTO_SKIP_DAYS)}}
function customerView(x,m,settings,orders){const p=pricingOf(x,m,settings),t=p.tier?tierById(p.tier.id):null,done=deliveriesDone(x),sv=savedOf(x,orders,settings);
 const run=Number(x.t5_run)||0,bonusIn=t&&t.bonus_every?(t.bonus_every-(run%t.bonus_every))%t.bonus_every||t.bonus_every:0;void done;
 const c=x.customer||{},ad=addonsPrice(x.addons||[],m);
 return{addons:ad.lines,addons_cents:ad.price_cents,next_total_cents:p.total_cents!=null?p.total_cents+ad.price_cents:null,payment_issue:issueOf(x,orders),ship_to:{name:c.name||'',address:c.address||'',address2:c.address2||'',city:c.city||'',state:c.state||'',zip:c.zip||'',phone:c.phone||''},saved_cents:sv.saved_cents,boxes_paid:sv.boxes,bonus_in:bonusIn,id:x.id,status:x.status,every:x.every,every_label:EVERY[x.every]?.label||x.every,next_ship_date:x.status==='active'||x.status==='paused'?shipDate(x):'',charge_date:x.status==='active'?chargeDate(x):'',
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
  const cards=await transaction(async s=>(await s.list('subscriptions')).filter(x=>owns(x,a)&&x.card_update?.id).map(x=>x.id));for(const id of cards){try{await checkCardUpdate(id)}catch{}}
  return ok(await transaction(async s=>{const m=await productsOf(s),settings=await s.get('settings','main');const list=(await s.list('subscriptions')).filter(x=>owns(x,a)&&!(x.status==='canceled'&&x.canceled_by==='checkout')).sort((p,q)=>(p.status==='canceled'?1:0)-(q.status==='canceled'?1:0)||(q.created||0)-(p.created||0));
   const orders=await (s.listLite?s.listLite('orders'):s.list('orders'));
   return{discount_pct:FAIR_PCT?100-FAIR_PCT:15,subscriptions:list.map(x=>customerView(x,m,settings,orders)),every:CUSTOMER_EVERY.map(k=>({id:k,label:EVERY[k].label})),tiers:TIERS.map(publicTier),max_slots:MAX_SLOTS,slot_max_cents:SLOT_MAX_CENTS}}))}
 if(path==='/account/subscriptions/confirm'&&method==='POST'){const a=await me(),x=await mine(a,body.id);const r=await settleFirst(x.id);return ok({status:r.status,message:r.status==='active'?'':r.status==='pending'||r.status==='needs_review'?COPY.pending:''})}
 if(path==='/account/subscriptions/abandon'&&method==='POST'){const a=await me(),x=await mine(a,body.id);if(x.status==='pending_first_payment')await settleFirst(x.id,{close:true});return ok({ok:true})}
 if(path==='/account/subscriptions/preview'&&method==='POST'){const a=await me(),x=await mine(a,body.id);
  return ok(await transaction(async s=>{const m=await productsOf(s),lines=await validItems(s,body.items,x.brand||'glow',m);return require('./store-core.cjs').subscriptionQuote(s,{items:lines,h:{},brand:brands.get(x.brand||'glow'),deliveryNumber:deliveriesDone(x)+1,bonus_id:x.bonus_id,streak:streakOf(x),stockCheck:false})}))}
 if(path==='/account/subscriptions/update'&&method==='POST'){const a=await me(),x=await mine(a,body.id),action=String(body.action||'').slice(0,10);if(!['every','skip','pause','resume','cancel','items','address','together'].includes(action))bad('Choose what to change.');
  await update({id:x.id,action,every:String(body.every||'').slice(0,4),items:body.items,address:body.address,reason:String(body.reason||'').slice(0,20),note:typeof body.note==='string'?body.note.slice(0,400):'',together_with:String(body.together_with||'').slice(0,20)},{customer:true,owner:a});
  return ok(await transaction(async s=>customerView(await s.get('subscriptions',x.id),await productsOf(s),await s.get('settings','main'),await (s.listLite?s.listLite('orders'):s.list('orders')))))}
 if(path==='/account/subscriptions/addons'&&method==='POST'){const a=await me(),x=await mine(a,body.id);
  return ok(await transaction(async s=>{const y=await s.get('subscriptions',x.id);if(y.status!=='active')bad('Add-ons can be added to an active subscription.',409);
   const m=await productsOf(s),brands=require('./brands.cjs'),lines=cleanItems(body.items);if(lines.length>ADDON_MAX_LINES)bad('Up to '+ADDON_MAX_LINES+' add-ons per package.');const seen=new Set();
   for(const l of lines){if(seen.has(l.id))bad('Duplicate product.');seen.add(l.id);if(l.quantity>ADDON_MAX_QTY)bad('Up to '+ADDON_MAX_QTY+' of one add-on.');const p=m.get(l.id);if(!p||!p.active||brands.productBrand(p)!==(y.brand||'glow'))bad('A product is unavailable.');if((Number(p.stock)||0)<l.quantity)bad(p.name+' does not have enough stock right now.',409)}
   y.addons=lines.map(l=>({id:l.id,quantity:l.quantity,name:m.get(l.id).name}));y.updated_at=now();await s.put('subscriptions',y.id,y);
   return customerView(y,m,await s.get('settings','main'),await (s.listLite?s.listLite('orders'):s.list('orders')))}))}
 if(path==='/account/subscriptions/card'&&method==='POST'){const a=await me(),x=await mine(a,body.id);return ok(await cardUpdateLink(x.id,a))}
 if(path==='/account/subscriptions/card-check'&&method==='POST'){const a=await me(),x=await mine(a,body.id);const r=await checkCardUpdate(x.id);
  return ok({status:r.status,charged:r.retry?.charged||0,failed:r.retry?.failed||0,subscription:await transaction(async s=>customerView(await s.get('subscriptions',x.id),await productsOf(s),await s.get('settings','main'),await (s.listLite?s.listLite('orders'):s.list('orders'))))})}
 return null}

// Autopilot: settle first payments; check waiting cards; retry unknown charges; then (10 AM–6 PM Eastern) make each
// repeat order 2 days before its ship date and charge it, and send the 3-days-before-charge reminders.
// A problem (sold out, checkout off) is shown in Management and retried next run; the date only moves once the order exists.
async function run(limit=10,t=Date.now()){
 const ts=Math.floor(t/1000),out={status:'ok',made:0,paid:0,failed:0,cards:0,started:0,reminded:0,skipped:0};
 if(!pay().stripeReady())return{status:'stripe_not_connected',made:0};
 const firsts=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='pending_first_payment').map(x=>({id:x.id,old:ts-(x.created||ts)>25*3600})));
 for(const f of firsts){try{if((await settleFirst(f.id,{close:f.old})).status==='active')out.started++}catch{}}
 const waiting=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='needs_card'&&x.card_session?.id).map(x=>x.id));
 for(const id of waiting){try{if((await checkCard(id)).status==='active')out.cards++}catch{}}
 // A new card saved on Stripe but the customer never came back to the store: pick it up here.
 const updates=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.card_update?.id&&['active','paused'].includes(x.status)).map(x=>x.id));
 for(const id of updates){try{const r=await checkCardUpdate(id);if(r.status==='saved'){out.cards++;out.paid+=r.retry?.charged||0;out.failed+=r.retry?.failed||0}}catch{}}
 // A declined box with no new card after AUTO_SKIP_DAYS: skipped, items back into stock, never charged.
 out.skipped=await skipStale(ts);
 // Retry charges whose result is not known yet (same idempotency key, so never a second charge).
 const pending=await transaction(async s=>(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>o.payment_method==='card_autopay'&&['charging','unknown'].includes(o.autopay?.status)).map(o=>o.id));
 for(const id of pending){const r=await charge(id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
 const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)));if(hour<10||hour>=18){out.status=out.cards||out.paid||out.started||out.skipped?'ok':'quiet_hours';return out}
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs'),autoInvoice=require('./auto-invoice.cjs'),today=todayET(t);
 const due=await transaction(async s=>(await s.list('subscriptions')).filter(x=>x.status==='active'&&shipDate(x)&&chargeDate(x)<=today).slice(0,limit).map(x=>x.id));
 for(const id of due){let made=null;
  try{made=await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x||x.status!=='active'||chargeDate(x)>today)return null;const cycle=shipDate(x);
    // Never two unpaid boxes: while a declined box waits for a new card, the next one is not made yet.
    if(x.payment_issue){const w=await s.get('orders',x.payment_issue);if(w&&w.status==='order_received'&&w.autopay?.status==='failed')bad('Waiting for a new card for '+w.id+' before the next box is made.',409);delete x.payment_issue}
    const r=await core.subscriptionOrder(s,x,cycle);const orderId=r.existing||r.order.id;x.orders=[...(x.orders||[]).filter(o=>o!==orderId),orderId].slice(-50);if(!r.existing){if((x.addons||[]).length){x.addons_last={order:r.order.id,lines:x.addons,dropped:!!r.order.addons_dropped};x.addons=[]}x.deliveries=deliveriesDone(x)+1;x.t5_run=r.order.subscription_tier==='T5'?(Number(x.t5_run)||0)+1:0}
    setShip(x,nextFrom(cycle,x.every,today));x.problem=r.order?.addons_dropped&&!r.existing?'Add-ons were left off '+r.order.id+': '+r.order.addons_dropped:'';x.last_run=ts;await s.put('subscriptions',x.id,x);return r})}
  catch(e){const msg=String(e&&e.message||e).slice(0,200);const jobs=await transaction(async s=>{const x=await s.get('subscriptions',id);if(!x)return[];const first=x.problem!==msg;x.problem=msg;x.last_run=ts;await s.put('subscriptions',x.id,x);
    // Tell the shop once per problem per box (sold out, product off, checkout off), not every hour.
    if(!first||/^Waiting for a new card/.test(msg))return[];return staffAlert(s,{id:'sub-problem-'+x.id+'-'+shipDate(x)+'-'+crypto.createHash('sha256').update(msg).digest('hex').slice(0,8),brand:x.brand,subject:'Subscription box not made · '+(x.customer?.name||x.id)+' · '+x.id,lines:['The repeat box for '+(x.customer?.name||'this customer')+' ('+x.id+', ships '+longDay(shipDate(x))+') was not made yet.','Reason: '+msg,'It is tried again every hour. Nothing has been charged.']})});
   for(const j of jobs)await emails.safeDispatch(j);continue}
  if(!made||made.existing)continue;out.made++;for(const j of made.jobs)await emails.safeDispatch(j);
  if(made.autopay){const r=await charge(made.order.id);if(r.status==='paid')out.paid++;if(r.status==='failed')out.failed++}
  else if(made.invoice){try{await autoInvoice.sendFor(made.invoice)}catch{}}}
 try{out.reminded=(await remind(20,t)).sent||0}catch{}
 return out;
}
module.exports={sameDoor,CANCEL_REASONS,TERMS_VERSION,EVERY,CUSTOMER_EVERY,DISCOUNT_PCT,TIERS,SLOT_MAX_CENTS,MAX_SLOTS,CHARGE_DAYS_BEFORE,REMIND_DAYS_BEFORE_CHARGE,FAIR_PCT,COPY,
 slotsOf,slotsFor,tierFor,tierById,priceFor,bonusDelivery,shippingFor,publicTier,addInterval,addDays,todayET,shipDate,chargeDate,deliveriesDone,
 list,create,update,cardLink,checkCard,charge,run,remind,publicSub,owns,offerOpen,customerRoute,startCheckout,settleFirst,checkoutBody,reminderEmail,welcomeEmail,
 stats,pricingOf,productsOf,PER_MONTH,AUTO_SKIP_DAYS,ADDON_MAX_LINES,ADDON_MAX_QTY,addonsPrice,subLinePrice,cardUpdateLink,checkCardUpdate,retryFailed,skipStale,declinedEmail,canceledEmail,customerView};

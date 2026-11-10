'use strict';
const crypto=require('node:crypto');const {transaction}=require('./store-db.cjs');
const goaffpro=require('./goaffpro.cjs');
const {validSlug,createStorefronts,resolveReferral}=require('./storefronts.cjs');
const photos=require('./affiliate-photos.cjs');const pointsMoved=require('./points-moved-email.cjs');
const receipts=require('./payment-receipts.cjs');
const reporting=require('./goaffpro-orders.cjs');
const shipping=require('./shipstation.cjs'),shippo=require('./shippo.cjs'),autoInvoice=require('./auto-invoice.cjs');
const accounts=require('./customer-accounts.cjs');
const members=require('./skool-members.cjs');
const productLimits=require('./product-limits.cjs');
const nativeAffiliates=require('./native-affiliates.cjs');
const adjustments=require('./order-adjustments.cjs');
const emails=require('./store-email.cjs');
const staff=require('./staff-accounts.cjs');
const catalogPhotos=require('./catalog-photo-upload.cjs');
const couponRules=require('./coupon-rules.cjs');
const productOffers=require('./product-offers.cjs');
const businessReports=require('./business-reports.cjs');
const {ensureMerchCatalog}=require('./merch-catalog.cjs');
const {withProductPhotos}=require('./product-photos.cjs');const brands=require('./brands.cjs');
const photoUrl=slug=>'/api/storefronts/'+encodeURIComponent(slug)+'/photo';
const clock=()=>Math.floor(Date.now()/1000),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const text=(value,max=200,required=true)=>{if(typeof value!=='string')fail('Invalid text field.');const v=value.trim();if(v.length>max||(required&&!v))fail('Complete required fields within their length limits.');return v};
const int=(v,min=0,max=10000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('Enter a valid whole number.');return v};
// Kits: a product with units>1 (e.g. a kit of 10) takes that many units off its stock group per item sold.
const units=brands.units,lineUnits=l=>Math.max(1,Number.isSafeInteger(l&&l.units)?l.units:1),lineDraws=l=>Array.isArray(l&&l.draws)&&l.draws.length?l.draws:[{id:l.id,qty:lineUnits(l)}],isBundle=p=>Array.isArray(p&&p.components)&&p.components.length>0;
function signingKey(){if(!process.env.STORE_SESSION_SECRET||process.env.STORE_SESSION_SECRET.length<32)fail('Admin sessions are not configured.',503);return process.env.STORE_SESSION_SECRET}
function sign(value){return crypto.createHmac('sha256',signingKey()).update(value).digest('base64url')}
async function session(store,headers){const cookie=(headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('glow_next_admin='));const token=cookie?.slice('glow_next_admin='.length)||'',parts=token.split('.');if(parts.length!==3||Number(parts[0])<=clock()||!equal(sign(parts[0]+'.'+parts[1]),parts[2]))fail('Sign in to the management dashboard.',401);const record=await store.get('sessions',parts[1]);if(!record||record.expires<=clock())fail('Sign in to the management dashboard.',401);if(record.staff_id){const a=await store.get('staff',record.staff_id);if(!a?.active||!a.verified||record.auth_version!==a.auth_version)fail('Sign in to the management dashboard.',401)}return parts[1]}
const publicOrder=o=>{const {token_hash,receipt,idempotency_key,request_hash,goaffpro_affiliate_id,customer_id,created_by_staff,payment_verified_by,invoice_sent_by,restored_by,adjustments:adjustmentHistory,payment_adjustments,staff_notes,call_log,stripe_invoice,...rest}=o;return{...rest,...(stripe_invoice?.url?{stripe_invoice:{url:stripe_invoice.url,status:stripe_invoice.status,via:stripe_invoice.via}}:{}),has_receipt:!!receipt,commission_status:['paid','shipped'].includes(o.status)&&!o.balance_due_cents&&!o.refund_due_cents&&!o.goaffpro_needs_review?'eligible':'not_eligible'}};
// $15 label price override: owner (admin) sign-in only, never a staff account.
async function ownerOnly(sid){const rec=await transaction(s=>s.get('sessions',sid));if(rec?.staff_id)fail('Only the owner sign-in can approve a label over $15. Ask the owner to override it.',403)}
// One place that marks an order paid: the staff "Payment received" button and Stripe's paid webhook (24 Oct 2026).
async function markPaid(s,o,{by,source}){o.status='paid';o.paid=clock();o.verified_payment_cents=o.total;o.balance_due_cents=0;o.refund_due_cents=0;o.payment_verified_by=by;o.payment_verification_source=source;o.checkout_stage='submitted';o.submitted_at=o.submitted_at||o.created;await accounts.paid(s,o);await accounts.referralPaid(s,o);o.shipstation_status=o.is_test===false?'queued':'test_only';o.goaffpro_status=o.commission_provider==='native'?'not_applicable':o.affiliate?(o.is_test===false?'queued':'test_only'):'not_applicable';await s.put('outbox','shipstation-'+o.id,{id:'shipstation-'+o.id,provider:'shipstation',order_id:o.id,status:'not_connected',attempts:0});if(o.affiliate&&o.commission_provider!=='native')await s.put('outbox','goaffpro-'+o.id,{id:'goaffpro-'+o.id,provider:'goaffpro',order_id:o.id,status:o.goaffpro_status,attempts:0});await audit(s,'payment_verified'+(source==='stripe_invoice'?'_stripe':''),o.id)}
async function audit(s,action,id=''){const log=await s.get('audit','log')||[];log.push({created:clock(),action,order_id:id});await s.put('audit','log',log.slice(-250))}
function contactPhone(value){
 if(typeof value!=='string'||!value.trim())fail('Enter your phone number so we can contact you about your order.');
 const raw=value.trim(),digits=raw.replace(/\D/g,'');
 if(raw.length>32||!/^\+?[0-9 () .-]+$/.test(raw)||(/^[+]/.test(raw)?digits.length<7||digits.length>15:!(digits.length===10||digits.length===11&&digits.startsWith('1'))))fail('Enter a valid phone number: 10 digits for US numbers, or + and the country code for international numbers.');
 return raw.startsWith('+')?'+'+digits:'+1'+(digits.length===11?digits.slice(1):digits);
}
function checkoutCustomer(input){const body={customer:input},customer={};for(const k of ['name','email','address','city','state','zip'])customer[k]=text(body.customer?.[k]||'',k==='address'?500:150);
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))fail('Enter a valid email address.');
   customer.phone=contactPhone(body.customer?.phone);
   customer.state=customer.state.toUpperCase();
   if(!/^(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|AS|GU|MP|PR|VI|AA|AE|AP)$/.test(customer.state))fail('Enter a valid two-letter US state or territory code.');
   if(!/^\d{5}(-\d{4})?$/.test(customer.zip))fail('Enter a five-digit ZIP code, optionally followed by four digits.');{const own=require('./own-contact.cjs').match(customer);if(own)fail(require('./own-contact.cjs').message(own))}
 return customer;
}
async function setStock(s,p,stock){int(stock);const members=p.stock_pool?(await s.list('products')).filter(x=>x.stock_pool===p.stock_pool&&x.id!==p.id):[];for(const x of [...members,p]){x.stock=stock;await s.put('products',x.id,x)}}
// A line takes stock from its draws: a bundle draws from the products inside it, anything else from itself (units per item).
async function moveStock(s,line,sign){for(const d of lineDraws(line)){const p=await s.get('products',d.id);if(!p)fail('A product on this order is missing. Review inventory first.',409);await setStock(s,p,p.stock+sign*line.quantity*d.qty)}}
async function bundleStock(get,p){if(!isBundle(p))return p;let n=Infinity;for(const c of p.components){const x=await get(c.id);n=Math.min(n,x?Math.floor(Math.max(0,x.stock||0)/c.qty):0)}return{...p,stock:n===Infinity?0:n}}
// An open Stripe invoice on a canceled or expired order is marked for voiding (Jonah's test orders, 5 Nov 2026):
// Autopilot's email task voids it in Stripe within a minute, so nobody can pay for an order that no longer exists.
async function release(s,o,status){if(o.stripe_invoice&&o.stripe_invoice.id&&['open','resend','sending'].includes(o.stripe_invoice.status))o.stripe_invoice={...o.stripe_invoice,void_pending:true};await accounts.release(s,o);for(const line of o.items)await moveStock(s,line,1);await couponRules.reserve(s,o,-1);o.status=status;await s.put('orders',o.id,o);await nativeAffiliates.reconcileOrder(s,o);await audit(s,status,o.id)}
async function expire(s){for(const o of await s.list('orders')){if(o.proof_required===true&&o.checkout_stage==='draft'&&o.status==='order_received'&&!o.receipt&&o.expires&&o.expires<=clock()){await release(s,o,'expired');continue}if(o.status==='awaiting_payment'){if(o.payment_window_days!==7){o.expires=Math.max(o.expires||0,(o.invoice_sent_at||o.created)+7*86400);o.payment_window_days=7;await s.put('orders',o.id,o)}if(o.expires<=clock())await release(s,o,'expired')}}}
// opts (server-side only, never from the request body): subscription (no member % or member free shipping: the
// subscription price and shipping rules apply), member_email (price a known member's order without their session: a
// re-price, a draft edit or a subscription repeat), exclude_order (the order being edited, so it does not count itself).
async function quote(s,b,h={},brand=brands.fromHeaders(h),opts={}){
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add at least one product.');const seen=new Set(),poolQuantities=new Map(),items=[];let subtotal=0,flashQuantity=0;
 // Skool member perks (5 Nov 2026): null while the switch is OFF, so nothing below changes from before.
 const a=await accounts.session(s,h),mctx=await members.context(s,opts.member_email||a?.email,brand.id);
 for(const line of b.items){const id=int(line.id,1),quantity=int(line.quantity,1,100);if(seen.has(id))fail('Duplicate product in the cart.');seen.add(id);const p=await s.get('products',id);if(!p||!p.active||brands.productBrand(p)!==brand.id||!members.visible(mctx,p))fail('A product is unavailable.');const max=productLimits.maxOrderQuantity(p);if(max){flashQuantity+=quantity;if(flashQuantity>max)fail(productLimits.FLASH_MESSAGE,409);}const u=units(p);let draws=null;if(isBundle(p)){draws=[];const need=new Map();for(const c of p.components){const x=await s.get('products',c.id);if(!x)fail('A product is unavailable.');const key=x.stock_pool?'pool:'+x.stock_pool:'product:'+x.id;const g=need.get(key)||{stock:x.stock,per:0};g.per+=c.qty;need.set(key,g);draws.push({id:x.id,qty:c.qty})}const fits=k=>[...need].every(([key,g])=>(poolQuantities.get(key)||0)+k*g.per<=g.stock);if(!fits(quantity)){let k=quantity-1;while(k>0&&!fits(k))k--;fail(`Only ${k} of ${p.name} available.`,409)}for(const [key,g] of need)poolQuantities.set(key,(poolQuantities.get(key)||0)+quantity*g.per)}else{const stockKey=p.stock_pool?'pool:'+p.stock_pool:'product:'+id;const combined=(poolQuantities.get(stockKey)||0)+quantity*u;poolQuantities.set(stockKey,combined);if(combined>p.stock)fail(`Only ${Math.floor(p.stock/u)} of ${p.name} available.`,409)}const amount=p.price*quantity;subtotal+=amount;
  // No doubling up on a sale (Jonah, 8 Nov 2026): an item at a sale price (intro price below its regular price) takes no promo
  // code and no member % on top. Same rule as subscriptions: the better deal, never both. Glow Points still work (stored value).
  const on_sale=!!p.intro_active&&Number(p.regular_price)>p.price;
  items.push({id,name:p.name,sku:p.sku,quantity,price:p.price,amount,promo_excluded:!!p.promo_excluded||on_sale,...(on_sale?{on_sale:true}:{}),...(u>1?{units:u}:{}),...(draws?{draws}:{})})}
 const coupon_eligible_subtotal=items.reduce((n,i)=>n+(i.promo_excluded?0:i.amount),0),coupon_excluded_subtotal=subtotal-coupon_eligible_subtotal;let appliedCoupons=await couponRules.apply(s,b,brand,subtotal,coupon_eligible_subtotal,clock(),items);let code=appliedCoupons.coupon;const couponAffiliate=appliedCoupons.coupon_affiliate;let discount=appliedCoupons.coupon_discount;
 if(!brand.affiliates&&!couponAffiliate&&b.affiliate)fail('Affiliate storefront is unavailable.');if(!brand.rewards&&b.points_redeemed)fail('Rewards points are not available in this store.');const slug=couponAffiliate||text(b.affiliate||'',60,false).toLowerCase();const affiliate=slug?await s.get('affiliates',slug):null;if(slug&&(!affiliate||!affiliate.active||nativeAffiliates.brandOf(affiliate)!==brand.id||(couponAffiliate&&!affiliate.goaffpro_id&&!nativeAffiliates.isNative(affiliate))))fail(couponAffiliate?'This affiliate coupon is unavailable.':'Affiliate storefront is unavailable.');
 const settings=await s.get('settings','main');if(a&&nativeAffiliates.isNative(affiliate))nativeAffiliates.validateSelf(affiliate,a);const requested=int(b.points_redeemed??0,0,10000000);let coupon_discount=discount,rewards_discount=0;
 // Member % off: never together with promo codes. With a code the customer gets whichever is bigger, and the quote says so.
 // Not on subscription orders (their price is already discounted). Glow Points can still be used on top.
 let member=null,member_discount=0,member_note=null,coupons_not_used=null;
 if(mctx&&mctx.member){const m=mctx.member,perks=members.effectivePerks(m);member={level:m.level,perks,discount:0,free_shipping:false,ship_count:0,shipping_waived:0};
  if(perks.includes('price')&&!opts.subscription){const pct=mctx.cfg.discount_pct,md=Math.min(coupon_eligible_subtotal,Math.floor(coupon_eligible_subtotal*pct/100));member.pct=pct;
   if(coupon_discount>0){const codes=appliedCoupons.coupons.join(' + ');
    if(md>coupon_discount){coupons_not_used=appliedCoupons.coupons;member_note='Your '+pct+'% member discount saves more than '+codes+', so we used it instead. Member pricing and promo codes do not combine.';appliedCoupons={...appliedCoupons,coupon:null,coupons:[],coupon_discounts:[],coupon_discount:0};code=null;coupon_discount=0;discount=md;member_discount=md}
    else member_note=codes+' saves more than your '+pct+'% member discount, so we used the code. Member pricing and promo codes do not combine.'}
   else{discount+=md;member_discount=md}}
  member.discount=member_discount}
 if(requested){if(settings.demo!==false)fail('Test orders do not spend real rewards points.');if(!a)fail('Sign in to use rewards points.',401);const w=await accounts.wallet(s,a.id);if(requested>Math.max(0,w.balance-w.reserved))fail('You do not have enough available points.',409);if(requested>Math.floor((subtotal-discount)/5))fail('Points cannot exceed the remaining product amount.');rewards_discount=requested*5;discount+=rewards_discount}
 let shipping=settings.free_shipping_cents>0&&subtotal-discount>=settings.free_shipping_cents?0:settings.shipping_cents;
 // Member free shipping: the 2nd, 4th, 6th… qualifying order (products after promo/member discounts, before points, at
 // or over the level's minimum). The store's own free-shipping-over rule above still applies on its own.
 if(member&&!opts.subscription){const min=members.shipMin(mctx.cfg,member.level),basis=subtotal-(discount-rewards_discount);member.ship_basis=basis;member.ship_min=min;
  if(member.perks.includes('ship')&&basis>=min){const n=await members.qualifyingCount(s,mctx.member,min,opts.exclude_order)+1;member.ship_count=n;if(n%2===0){member.free_shipping=true;member.shipping_waived=shipping;shipping=0}}}
 // 2× Glow Points perk: the HIGHER of the Glow level multiplier and 2, never the two multiplied. Double points still applies.
 const levelMultiplier=a?accounts.tierFor(await accounts.lifetimePoints(s,a.id)).multiplier:1,memberMultiplier=member&&member.perks.includes('points')?2:1;if(member&&memberMultiplier>1)member.points_multiplier=memberMultiplier;
 const earnMultiplier=brand.rewards?(accounts.doubleOn(settings,clock())?2:1)*Math.max(levelMultiplier,memberMultiplier):0;
 return{items,subtotal,discount,coupon_discount,coupon_eligible_subtotal,coupon_excluded_subtotal,rewards_discount,points_redeemed:requested,points_to_earn:brand.rewards?Math.floor(Math.floor((subtotal-discount)/100)*earnMultiplier):0,points_multiplier:earnMultiplier,brand:brand.id,shipping,tax:0,total:subtotal-discount+shipping,coupon:code||null,coupons:appliedCoupons.coupons,coupon_discounts:appliedCoupons.coupon_discounts,affiliate:slug||null,affiliate_name:affiliate?.name||null,affiliate_source:couponAffiliate?'coupon':(slug?'storefront':null),commission:affiliate?Math.floor((subtotal-discount)*affiliate.commission_bps/10000):0,...(nativeAffiliates.isNative(affiliate)?{commission_provider:'native',commission_bps:affiliate.commission_bps}:{}),tax_note:settings.tax_note,...(member?{member,member_discount,...(member_note?{member_note}:{}),...(coupons_not_used?{coupons_not_used}:{}),...(member.perks.includes('packed')?{member_priority:true}:{})}:{})}

}
// Re-pricing an existing order keeps its Skool member pricing (it was placed signed in as that member) and never counts itself.
function memberOpts(o){return{exclude_order:o.id,...(o.member&&o.customer?.email?{member_email:o.customer.email}:{})}}
function reminderToken(o){const expires=clock()+7*86400;return 'r_'+expires+'_'+sign('payment-reminder:'+o.id+':'+o.token_hash+':'+expires)}
function validReminderToken(o,token){const m=String(token||'').match(/^r_(\d{10})_([A-Za-z0-9_-]{43})$/);return !!m&&Number(m[1])>clock()&&equal(m[2],sign('payment-reminder:'+o.id+':'+o.token_hash+':'+m[1]))}
async function orderAuth(s,id,headers){const o=await s.get('orders',id),a=await accounts.session(s,headers);if(!o||(!equal(o.token_hash,hash(headers['x-order-token']||''))&&!validReminderToken(o,headers['x-order-token'])&&!(a&&o.customer_id===a.id)))fail('Order access denied.',404);return o}
// Bitcoin (Jonah, 10 Nov 2026): paid like Zelle. The customer sends to the store's Cash App Bitcoin address and uploads a receipt; staff check Cash App.
const BTC_ADDRESS=/^(?:bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
function validateLinks(links){if(!links||typeof links!=='object'||Array.isArray(links))fail('Invalid payment settings.');const out={};for(const[k,domains]of Object.entries({venmo:['venmo.com','www.venmo.com','account.venmo.com'],paypal:['paypal.com','www.paypal.com','paypal.me','www.paypal.me'],cashapp:['cash.app'],zelle:[],bitcoin:[]})){const v=text(links[k]||'',300,false).trim();if(k==='bitcoin'){if(!v)continue;if(!BTC_ADDRESS.test(v))fail('Enter a Bitcoin receiving address (it starts with bc1, 1 or 3). Never a private key or recovery words.');out[k]=v;continue}if(v&&k!=='zelle'){let u;try{u=new URL(v)}catch{fail('Enter an official HTTPS '+k+' link.')}if(u.protocol!=='https:'||!domains.includes(u.hostname)||u.username||u.password)fail('Enter an official HTTPS '+k+' link.')}out[k]=v}return out}
function shipmentPayload(o){return shipping.payload(o,null)}
function editable(o){if(!['order_received','awaiting_payment'].includes(o.status)||o.has_receipt||o.receipt)fail('This order has been submitted or closed. Contact the store to change it.',409)}
function draftStore(s,o){const reserved=new Map();for(const line of o.items){reserved.set(line.id,(reserved.get(line.id)||0)+line.quantity*lineUnits(line))}return{...s,get:async(kind,key)=>{const r=await s.get(kind,key);if(!r)return r;if(kind==='products'){let qty=reserved.get(r.id)||0;if(r.stock_pool){qty=o.items.reduce((n,line)=>n+(line.stock_pool===r.stock_pool?line.quantity*lineUnits(line):0),0)}return{...r,stock:r.stock+qty}}if(kind==='coupons'&&couponRules.codes(o).includes(key))return{...r,used:Math.max(0,r.used-1)};if(kind==='rewards_wallets'&&key===o.customer_id&&o.is_test===false)return{...r,reserved:Math.max(0,r.reserved-(o.points_redeemed||0))};return r}}}
async function editStore(s,o){const copy={...o,items:[]};for(const line of o.items)for(const d of lineDraws(line)){const p=await s.get('products',d.id);copy.items.push({id:d.id,quantity:line.quantity,units:d.qty,stock_pool:p?.stock_pool})}return draftStore(s,copy)}
// Plain letters/digits/space/.'- only: these values end up in a Terminal window and a macOS notification on the shop's computer.
const safeWord=(v,max)=>String(v||'').normalize('NFKC').replace(/[^\p{L}\p{N} .'-]/gu,'').replace(/\s+/g,' ').trim().slice(0,max);
async function handle({path,method='GET',headers={},body={}}){
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));let setCookie,emailJob,invoiceJob;const staffJobs=[],bulkJobs=[]; // staff new-order alerts queued in this request; sent right after it (Sevalla has no email worker)
 if(!['GET','POST'].includes(method))fail('Method not allowed.',405);
 if(method==='POST'){
  if(h['x-store-request']!=='1')fail('Request protection header required.',403);
  if(h.origin&&process.env.STORE_ORIGIN){
   let incoming,configured;try{incoming=new URL(h.origin);configured=new URL(process.env.STORE_ORIGIN.trim())}catch{fail('Cross-origin request denied.',403)}
   const glowHosts=brands.allHosts();
   const sameGlowSite=glowHosts.has(incoming.hostname)&&glowHosts.has(configured.hostname)&&incoming.protocol==='https:'&&configured.protocol==='https:'&&incoming.port===configured.port;
   if(incoming.username||incoming.password||incoming.origin!==h.origin||(!sameGlowSite&&incoming.origin!==configured.origin))fail('Cross-origin request denied.',403);
  }
  if(h['sec-fetch-site']==='cross-site')fail('Cross-site request denied.',403);
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Invalid request.');
 }
 const catalogImage=path.match(/^\/product-images\/([a-f0-9]{32})$/);
 if(catalogImage&&method==='GET'){const image=await transaction(s=>s.get('catalog_images',catalogImage[1]));if(!image)fail('Image not found.',404);return{status:200,headers:{'Cache-Control':'public, max-age=31536000, immutable'},body:{_binary:image.data,_type:image.mime}}}
 const staffAuth=await staff.authRoute(path,body,h,method);if(staffAuth)return staffAuth;
 // Check every management route before early shipping/email/integration handlers.
 // The restricted role gets a small explicit allowlist; future endpoints default to denied.
 let affiliateManager=false;
 if(path.startsWith('/admin/')&&path!=='/admin/login'||['/orders','/quote'].includes(path)&&body.order_for_customer===true){
  affiliateManager=await transaction(async s=>{const sid=await session(s,h),rec=await s.get('sessions',sid),a=rec.staff_id?await s.get('staff',rec.staff_id):null,role=staff.roleOf(a);
   if(role==='full')return false;
   const allowed=new Set(['GET /admin/data','POST /admin/logout','POST /admin/affiliate','POST /admin/affiliate/status','POST /admin/affiliate/photo-link']);
   if(role!=='affiliate_manager'||!allowed.has(method+' '+path)||path!=='/admin/logout'&&brands.fromHeaders(h).id!=='glow')fail('Your Affiliate Manager login can only manage Glow affiliate storefronts and photo links.',403);
   return true;
  });
 }
 const accountAuth=await accounts.authRoute(path,body,h,method);if(accountAuth)return accountAuth;
 // Subscribe & save, customer side (5 Nov 2026): bag quote, start (Stripe Checkout), and the account Subscriptions page.
 const subRoute=await require('./subscriptions.cjs').customerRoute(path,body,h,method);if(subRoute)return subRoute;
 // Skool member perks (Jonah, 5 Nov 2026): the account's member section, choosing perks, and "Link" (own email only).
 // Management: staff can look; only the owner can switch it on, change settings or change the list. See skool-members.cjs.
 const memberRoute=await members.customerRoute(path,body,h,method);if(memberRoute)return memberRoute;
 // Growth tools (Jonah, 8 Nov 2026): reorder links, saved bags, reviews, the sales funnel and unsubscribe. See growth.cjs.
 const growthRoute=await require('./growth.cjs').route(path,body,h,method,{session});if(growthRoute)return growthRoute;
 // Label hub (Jonah, 8 Nov 2026): every approved vial label, one click to print. See labels.cjs.
 if(path.startsWith('/admin/labels')){const r=await require('./labels.cjs').route(path,body,h,method,{session});if(r)return r}
 // Live log + deep live analytics (Jonah, 9 Nov 2026). See live.cjs.
 if(path==='/live/ping'||path==='/admin/live'||path.startsWith('/admin/live/')){const r=await require('./live.cjs').route(path,body,h,method,{session});if(r)return r}
 // Print log (Jonah, 9 Nov 2026): which labels and packing slips have been printed. See print-log.cjs.
 if(path==='/admin/printed'){const r=await require('./print-log.cjs').route(path,body,h,method,{session});if(r)return r}
 if(path==='/admin/members'||path.startsWith('/admin/members/')){const sid=await transaction(s=>session(s,h));return members.adminRoute(path,body,method,{transaction,sid,audit})}
 // Order Bell: a private key lets a small script on the shop's own computer hear about new orders without a login.
 // It returns order number, total, first name and state only (no email, phone or street). Rotating the key kills every old copy.
 if(path==='/admin/order-bell-key'&&method==='POST'){const r=await transaction(async s=>{await session(s,h);const st=await s.get('settings','order_bell')||{id:'order_bell',v:1};if(body.rotate===true){st.v=(st.v||1)+1;await s.put('settings','order_bell',st);await audit(s,'order_bell_rotated')}return{key:'ob'+(st.v||1)+'_'+sign('order-bell:'+(st.v||1))}});return{status:200,headers:{},body:r}}
 if(path==='/order-bell'&&method==='POST'){const k=String(body.k||'').slice(0,120);const r=await transaction(async s=>{const st=await s.get('settings','order_bell')||{v:1};if(!equal(k,'ob'+(st.v||1)+'_'+sign('order-bell:'+(st.v||1))))fail('Not found.',404);
  const etDay=t=>new Date(t*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'}),today=etDay(clock());
  const live=(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>o.is_test===false&&!['canceled','expired'].includes(o.status)&&!(o.proof_required&&!o.submitted_at&&o.status==='order_received'));
  const todays=live.filter(o=>etDay(o.created||0)===today);
  const recent=live.filter(o=>(o.created||0)>clock()-2*86400).sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,25).map(o=>({id:o.id,created:o.created||0,total:o.total||0,status:o.status,brand:o.brand||'glow',items:(o.items||[]).reduce((n,i)=>n+(i.quantity||0),0),first:safeWord(String(o.customer?.name||'').trim().split(/\s+/)[0],30),state:safeWord(o.customer?.state,20)}));
  return{now:clock(),today:{count:todays.length,total:todays.reduce((n,o)=>n+(o.total||0),0)},orders:recent}});return{status:200,headers:{},body:r}}
 if(path==='/admin/email/retry'&&method==='POST'){
  const id=text(body.id||'',200);await transaction(async s=>{await session(s,h);const j=await s.get('email_outbox',id);if(!j)fail('Email not found.',404);if(j.status==='rejected')await emails.prepareRetry(s,j)});
  return{status:200,headers:{},body:await emails.dispatch(id)};
 }
 // Manual shipments (Jonah, 6 Nov 2026): Packing page "New shipment" for a box that is not a store order (a missing
 // item, a resend, a gift). Stored in 'manual_shipments', never in orders, so sales, reports and customer emails are
 // untouched; only the label cost is added to the P&L. Items come out of stock once (unless unticked) and go back on cancel.
 // The click key makes a double click save one shipment, not two.
 if(path==='/admin/manual-shipment'&&method==='POST'){const result=await transaction(async s=>{const sid=await session(s,h);
  const key=String(body.key||'').replace(/[^A-Za-z0-9-]/g,'').slice(0,64);if(key.length<8)fail('Missing click key.');const id='SHIP-'+hash('manual:'+key).slice(0,10).toUpperCase();
  const prior=await s.get('manual_shipments',id);if(prior)return{ok:true,id,already:true};
  const t=body.to||{},to={name:text(t.name||'',100),address:text(t.address||'',100),address2:text(t.address2||'',100,false),city:text(t.city||'',60),state:text(t.state||'',2).toUpperCase(),zip:text(t.zip||'',10),phone:text(t.phone||'',32,false),email:text(t.email||'',150,false).toLowerCase()};
  if(!/^(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|AS|GU|MP|PR|VI|AA|AE|AP)$/.test(to.state))fail('Enter a valid two-letter state.');
  if(!/^\d{5}(-\d{4})?$/.test(to.zip))fail('Enter a five-digit ZIP code.');if(to.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.email))fail('Enter a valid email or leave it blank.');
  {const own=require('./own-contact.cjs');const m=own.match(to);if(m)fail(own.message(m),409)}
  const REASONS=['missing','damaged','wrong','resend','gift','other'],reason=REASONS.includes(body.reason)?body.reason:fail('Choose why this box is going out.');
  const note=text(body.note||'',300,false),orderId=text(body.order_id||'',50,false);if(orderId&&!await s.get('orders',orderId))fail('Order '+orderId+' was not found.');
  const items=Array.isArray(body.items)?body.items:[];if(items.length>20)fail('Up to 20 lines per box.');if(!items.length&&!note)fail('Add what goes in the box, or write a note.');
  const lines=[];for(const it of items){const p=await s.get('products',int(it.id));const q=int(it.quantity,1,50);if(!p)fail('A product was not found. Refresh and try again.');if(lines.some(l=>l.id===p.id))fail(p.name+' is listed twice.');lines.push({id:p.id,name:p.name,quantity:q,units:Number.isInteger(p.units)?p.units:1,...(isBundle(p)?{draws:p.components.map(c=>({id:c.id,qty:c.qty}))}:{})})}
  let parcel=null;if(body.parcel){const pc=body.parcel,dim=(v,lo,hi)=>{const n=Math.round(Number(v)*10)/10;if(!(n>=lo&&n<=hi))fail('Box size must be '+lo+' to '+hi+' inches and weight 0.1 to 50 lb.');return n};parcel={length:dim(pc.length,1,36),width:dim(pc.width,1,36),height:dim(pc.height,1,36),weight_lb:dim(pc.weight_lb,0.1,50)}}
  const take=body.take_stock!==false;if(take){for(const l of lines)for(const d of lineDraws(l)){const p=await s.get('products',d.id);if(!p||p.stock<l.quantity*d.qty)fail('Not enough stock for '+(p?p.name:'a product')+' ('+(p?p.stock:0)+' left). Untick "Take from stock" to send it anyway.',409)}for(const l of lines)await moveStock(s,l,-1)}
  const rec=await s.get('sessions',sid),st=rec?.staff_id?await s.get('staff',rec.staff_id):null;
  await s.put('manual_shipments',id,{id,brand:'glow',status:'open',reason,note,order_id:orderId,to,items:lines,...(parcel?{parcel}:{}),stock_taken:take&&lines.length>0,created:clock(),created_by:String(st?.name||st?.email||'Owner').trim().split(/[\s@]+/)[0].slice(0,30)});
  await audit(s,'manual_shipment',id);return{ok:true,id}});return{status:200,headers:{},body:result}}
 // Shippo errors carry status 502, and Cloudflare replaces any 502 page with its own, hiding the reason from staff (seen live 6 Nov 2026). Send them as 409.
 const reason=e=>{if(e&&e.status===502)e.status=409;throw e};
 if(path==='/admin/manual-shipment/check-address'&&method==='POST'){await transaction(s=>session(s,h));const t=body.to||{};
  const to={name:text(t.name||'',100,false)||'Customer',address:text(t.address||'',100),address2:text(t.address2||'',100,false),city:text(t.city||'',60),state:text(t.state||'',2).toUpperCase(),zip:text(t.zip||'',10)};
  return{status:200,headers:{},body:await shippo.validateAddress(to).catch(reason)}}
 // Tracking email for a manual shipment: preview:true returns exactly what would be sent; otherwise it is sent once.
 if(path==='/admin/manual-shipment/email'&&method==='POST'){const id=text(body.id||'',30);
  const r=await transaction(async s=>{await session(s,h);const m=await s.get('manual_shipments',id);if(!m)fail('Shipment not found.',404);if(m.status==='canceled')fail('This shipment was canceled.',409);if(!m.tracking)fail('Buy the label first.',409);if(!m.to?.email)fail('There is no email on this shipment.',409);
   const c=emails.manualTrackingContent(m);if(body.preview===true)return{preview:true,to:m.to.email,subject:c.subject,html:c.content.html};
   if(!emails.configuration().ready)fail('Email sending is not set up.',503);if(m.email_sent)return{sent:true,already:true,at:m.email_sent.at};
   const job=await emails.queueManualTracking(s,m);m.email_sent={at:clock(),job};await s.put('manual_shipments',id,m);await audit(s,'manual_shipment_email',id);return{sent:true,job}});
  if(r.job)await emails.safeDispatch(r.job);return{status:200,headers:{},body:r}}
 if(path==='/admin/manual-shipment/rates'&&method==='POST'){await transaction(s=>session(s,h));return{status:200,headers:{},body:await shippo.manualRates(text(body.id||'',30)).catch(reason)}}
 if(path==='/admin/manual-shipment/buy'&&method==='POST'){const sid=await transaction(s=>session(s,h));const id=text(body.id||'',30),override=body.override===true;if(override)await ownerOnly(sid);
  const result=await shippo.manualBuy(id,{servicelevel:text(body.servicelevel||'',40),override}).catch(reason);await transaction(s=>audit(s,'manual_shipment_label'+(override&&result?.status==='label_bought'?'_price_override':''),id));return{status:200,headers:{},body:result}}
 if(path==='/admin/manual-shipment/packed'&&method==='POST'){const r=await transaction(async s=>{const sid=await session(s,h);const id=text(body.id||'',30);const m=await s.get('manual_shipments',id);if(!m)fail('Shipment not found.',404);if(m.status==='canceled')fail('This shipment was canceled.',409);
  if(body.packed===true){const rec=await s.get('sessions',sid);const st=rec?.staff_id?await s.get('staff',rec.staff_id):null;const secs=Number(body.seconds);m.packed={at:clock(),by:String(st?.name||st?.email||'Owner').trim().split(/[\s@]+/)[0].slice(0,30),fp:String(body.fp||'').slice(0,2000),seconds:Number.isFinite(secs)&&secs>0&&secs<36000?Math.round(secs):null}}else delete m.packed;
  await s.put('manual_shipments',id,m);return{ok:true,packed:m.packed||null}});return{status:200,headers:{},body:r}}
 // Cancel: a bought label is voided in Shippo first (refund), then the items go back on the shelf.
 if(path==='/admin/manual-shipment/cancel'&&method==='POST'){await transaction(s=>session(s,h));const id=text(body.id||'',30);
  const m0=await transaction(async s=>{const m=await s.get('manual_shipments',id);if(!m)fail('Shipment not found.',404);if(m.status==='canceled')fail('Already canceled.',409);if(m.label_status==='buying'||m.label_status==='needs_review')fail('A label purchase is open or needs a check in Shippo. Settle that first.',409);return m});
  let refund=null;if(m0.shippo_transaction_id){try{refund=await shippo.voidLabel(m0.shippo_transaction_id)}catch(e){fail('Shippo would not void the label ('+e.message+'). Nothing was canceled.',409)}}
  await transaction(async s=>{const m=await s.get('manual_shipments',id);if(m.stock_taken)for(const l of m.items)await moveStock(s,l,1);m.status='canceled';m.stock_taken=false;m.canceled_at=clock();if(refund)m.label_refund={status:refund.status,object_id:refund.object_id,at:clock()};await s.put('manual_shipments',id,m);await audit(s,'manual_shipment_canceled',id)});
  return{status:200,headers:{},body:{ok:true,refund:refund?refund.status:null}}}
 if(path==='/admin/order/replacement-items'&&method==='POST'){const result=await transaction(async s=>{await session(s,h);const id=text(body.id||'',50),n=int(body.n);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);const r=(o.replacements||[]).find(x=>x.n===n);if(!r)fail('Replacement not found.',404);if(!Array.isArray(body.items)||!body.items.length||body.items.length>20)fail('List what goes in the replacement box.');
  const lines=[];for(const it of body.items){const p=await s.get('products',int(it.id));const q=int(it.quantity);if(!p)fail('Product not found.');if(!(q>=1&&q<=20))fail('Quantity must be 1 to 20.');lines.push({id:p.id,name:p.name,quantity:q,units:Number.isInteger(p.units)?p.units:1,...(isBundle(p)?{draws:p.components.map(c=>({id:c.id,qty:c.qty}))}:{})})}
  for(const l of (r.items||[]))if(r.stock_taken)await moveStock(s,l,1);
  for(const l of lines){for(const d of lineDraws(l)){const p=await s.get('products',d.id);if(!p||p.stock<l.quantity*d.qty)fail('Not enough stock for '+(p?p.name:'a product')+' ('+(p?p.stock:0)+' left).',409)}await moveStock(s,l,-1)}
  r.items=lines;r.stock_taken=true;await s.put('orders',id,o);await audit(s,'replacement_items',id);return{ok:true,items:lines.map(l=>({id:l.id,name:l.name,quantity:l.quantity}))}});return{status:200,headers:{},body:result}}
 // Packing Check: mark an order packed (or un-packed) so every device and Management see the same thing.
 // fp is the packing page's item fingerprint; if the order's items change later the page treats it as not packed.
 // Packing Check "Send to printer": the label PDF, fetched here (Shippo's file host blocks browser fetches), so the page can
 // save it as glow-label-<order>.pdf in Downloads, where the Mac helper prints it. Staff only; Shippo file hosts only.
 if(path==='/admin/order/label-pdf'&&method==='POST'){const{url,name}=await transaction(async s=>{await session(s,h);const id=text(body.id||'',50);const manual=/^SHIP-/.test(id)?await s.get('manual_shipments',id):null;const o=manual?null:await s.get('orders',id);if(!o&&!manual)fail('Order not found.',404);
   const rn=Number(body.r||0);const src=manual?manual.label_url:rn?(o.replacements||[])[rn-1]?.label_url:(o.shipment?.label_url||o.shippo_label_url);if(!src)fail('This order has no label yet.',409);
   let u;try{u=new URL(src)}catch{fail('The saved label link is not valid.',409)}if(u.protocol!=='https:'||!(/(^|\.)goshippo\.com$/.test(u.hostname)||/^shippo-delivery[a-z0-9-]*\.s3[a-z0-9.-]*\.amazonaws\.com$/.test(u.hostname)))fail('The label is not on Shippo, so it was not fetched.',409);
   return{url:u.toString(),name:'glow-label-'+id.replace(/[^A-Za-z0-9-]/g,'')+(rn?'-R'+rn:'')+'.pdf'}});
  let r;try{r=await fetch(url,{signal:AbortSignal.timeout(15000)})}catch(e){fail('Could not download the label from Shippo. Try again.',502)}
  if(!r.ok)fail('Shippo answered HTTP '+r.status+' for the label file.',502);const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length>4*1024*1024)fail('The label file is unexpectedly large.',502);if(buf.subarray(0,5).toString()!=='%PDF-')fail('Shippo did not return a PDF.',502);
  return{status:200,headers:{'Cache-Control':'no-store'},body:{name,pdf:buf.toString('base64'),bytes:buf.length}}}
 // Packing Check call log (Jonah, 24 Oct 2026): one entry per phone call, saved on the order. Staff only; customers never see it.
 // Calls tab: delivery status for up to 25 shipped orders, from Shippo tracking. Cached on the order (o.track): delivered stays,
 // otherwise re-checked after 2 hours. Staff only; read-only toward customers (no emails).
 if(path==='/admin/orders/track'&&method==='POST'){await transaction(s=>session(s,h));const ids=[...new Set((Array.isArray(body.ids)?body.ids:[]).map(x=>text(String(x),50)))].slice(0,25);const force=body.force===true;
  const jobs=await transaction(async s=>{const out=[];for(const id of ids){const o=await s.get('orders',id);if(!o||o.status!=='shipped')continue;const num=String(o.tracking||o.shipment?.tracking||'').replace(/\s+/g,'');if(!num)continue;
    const carrier=o.shipment?.carrier||(/^1Z/i.test(num)?'ups':/^9\d{15,}/.test(num)?'usps':'');const t=o.track;const fresh=t&&t.tracking===num.toUpperCase()&&(t.state==='delivered'||(!force&&clock()-(t.checked_at||0)<7200));out.push({id,carrier,num,cached:fresh?t:null})}return out});
  const result={};let i=0;const worker=async()=>{while(i<jobs.length){const j=jobs[i++];if(j.cached){result[j.id]=j.cached;continue}
    try{const t=await shippo.track(j.carrier,j.num);result[j.id]=t;await transaction(async s=>{const o=await s.get('orders',j.id);if(o){o.track=t;await s.put('orders',j.id,o)}})}catch(e){result[j.id]={state:'error',details:String(e.message||'').slice(0,160),checked_at:clock()}}}};
  await Promise.all([worker(),worker(),worker(),worker()]);return{status:200,headers:{},body:{ok:true,track:result}}}
 // Automatic Stripe invoices on/off (owner only). Turning on needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Netlify.
 if(path==='/admin/auto-invoice'&&method==='POST'){const r=await transaction(async s=>{const sid=await session(s,h);if((await s.get('sessions',sid))?.staff_id)fail('Only the owner sign-in can change automatic invoices.',403);const settings=await s.get('settings','main');const st=autoInvoice.status(settings);
   if(body.on===true&&(!st.stripe||!st.webhook))fail('Save STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in Netlify first, then redeploy.',409);if(body.on===true&&settings.auto_invoice!==true)settings.auto_invoice_since=clock();settings.auto_invoice=body.on===true;await s.put('settings','main',settings);await audit(s,'auto_invoice_'+(settings.auto_invoice?'on':'off'));return{ok:true,...autoInvoice.status(settings)}});return{status:200,headers:{},body:r}}
 // Staff: send (or resend) one order's invoice now.
 if(path==='/admin/order/send-invoice'&&method==='POST'){await transaction(s=>session(s,h));const id=text(body.id||'',50);if(body.via==='text'||body.via==='email')await transaction(async s=>{const o=await s.get('orders',id);if(o){o.invoice_via=body.via;if(o.stripe_invoice&&o.stripe_invoice.status!=='paid')o.stripe_invoice.status='resend';await s.put('orders',id,o)}});const r=await autoInvoice.sendFor(id,{force:true});return{status:200,headers:{},body:r}} // staff chose to send it, even for an order placed before the switch
 if(path==='/admin/order/call-log'&&method==='POST'){const r=await transaction(async s=>{const sid=await session(s,h);const id=text(body.id||'',50);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);
   const key=String(body.key||'');if(!/^[A-Za-z0-9_-]{8,64}$/.test(key))fail('Missing save key. Try again.');const log=o.call_log||[];
   if(body.remove===true){const i=log.findIndex(e=>e.key===key);if(i<0)return{ok:true,removed:false};if(clock()-log[i].at>3600)fail('Calls older than an hour stay in the log.',409);log.splice(i,1);o.call_log=log;await s.put('orders',id,o);await audit(s,'call_log_removed',id);return{ok:true,removed:true}}
   const prior=log.find(e=>e.key===key);if(prior)return{ok:true,entry:prior,already:true};
   const outcome=String(body.outcome||'');if(!['talked','voicemail','noanswer','wrong'].includes(outcome))fail('Pick how the call went.');
   const feeling=outcome==='talked'?String(body.feeling||''):'';if(feeling&&!['happy','neutral','problem'].includes(feeling))fail('Pick how they liked it.');
   const problems=feeling==='problem'?[...new Set((Array.isArray(body.problems)?body.problems:[]).map(String).filter(x=>['missing','damaged','late','wrong_item','other'].includes(x)))]:[];
   if(feeling==='problem'&&!problems.length)fail('Pick what the problem was.');
   const notes=typeof body.notes==='string'?body.notes.trim().slice(0,1000):'';if(log.length>=100)fail('This order has reached the call-log limit.');
   const rec=await s.get('sessions',sid);const st=rec?.staff_id?await s.get('staff',rec.staff_id):null;const by=String(st?.name||st?.email||'Owner').trim().split(/[\s@]+/)[0].slice(0,30);
   const entry={key,at:clock(),by,outcome,feeling,problems,notes};o.call_log=[...log,entry];await s.put('orders',id,o);await audit(s,'call_logged',id);return{ok:true,entry}});return{status:200,headers:{},body:r}}
 if(path==='/admin/order/referral'&&method==='POST'){const r=await transaction(async s=>{await session(s,h);const id=text(body.id||'',50);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(!['paid','shipped'].includes(o.status))fail('Mark the order paid first.',409);
  if(o.referral_bonus_awarded)return{ok:true,already:true,awarded:o.referral_bonus_awarded};const why=await accounts.referralWhy(s,o);if(why)return{ok:false,reason:why};
  const ok=await accounts.referralPaid(s,o);if(ok){await s.put('orders',id,o);await audit(s,'referral_bonus',id)}return ok?{ok:true,awarded:o.referral_bonus_awarded}:{ok:false,reason:'This friend\u2019s referral points were already given on another order'}});return{status:200,headers:{},body:r}}
 if(path==='/admin/order/packed'&&method==='POST'){const r=await transaction(async s=>{const sid=await session(s,h);const id=text(body.id||'',50);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(!['paid','shipped'].includes(o.status))fail('Only paid or shipped orders can be packed.',409);
  if(body.packed===true){const rec=await s.get('sessions',sid);const st=rec?.staff_id?await s.get('staff',rec.staff_id):null;const who=String(st?.name||st?.email||'Owner').trim().split(/[\s@]+/)[0].slice(0,30);const secs=Number(body.seconds);
   o.packed={at:clock(),by:who,fp:String(body.fp||'').slice(0,2000),seconds:Number.isFinite(secs)&&secs>0&&secs<36000?Math.round(secs):null};await audit(s,'packed',id)}
  else{delete o.packed;await audit(s,'unpacked',id)}
  await s.put('orders',id,o);return{ok:true,packed:o.packed||null}});return{status:200,headers:{},body:r}}
 // Extra label on a real order: void (refund) the unused Shippo label and keep the order. It goes back to "paid" with no label;
 // its old Shippo id stays on it so automatic buying never gets it a new label. Never emails the customer.
 if(path==='/admin/shippo/void-label'&&method==='POST'){const id=text(body.id||'',50);
  const o0=await transaction(async s=>{await session(s,h);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(body.confirm!==id)fail('Type the order number to confirm.');if(o.status!=='shipped'||!o.shippo_transaction_id||o.label_refund)fail('This order has no unused Shippo label to void.',409);if(o.delivery?.first_scan_at)fail('UPS already scanned this package. It cannot be voided.',409);return o});
  const refund=await shippo.voidLabel(o0.shippo_transaction_id);if(!['QUEUED','PENDING','SUCCESS'].includes(refund.status))fail('Shippo did not accept the label refund ('+(refund.status||'no status')+'). Nothing was changed.');
  const result=await transaction(async s=>{const sid=await session(s,h);const o=await s.get('orders',id);o.label_refund={...refund,requested_at:clock(),tracking:o.tracking||''};o.voided_by=(await s.get('sessions',sid))?.staff_id||'owner';o.status='paid';o.tracking='';delete o.shipment;delete o.shippo_label_url;o.shippo_status='label_refund_'+refund.status.toLowerCase();await s.put('orders',id,o);await audit(s,'shippo_label_voided',id);return{ok:true,id,status:o.status,label_refund:o.label_refund,note:'Order kept. Customer was not emailed.'}});
  return{status:200,headers:{},body:result}}
 // Old-site orders (the locked Netlify database) that were paid but never shipped: bring each in once, as paid,
 // with its original order number, lines, totals and address, so it shows in Packing Check and gets a label like any order.
 // Takes the stock. Never emails, never reports to GoAffPro, never moves points. Refuses a number already in this store.
 if(path==='/admin/orders/import-legacy'&&method==='POST'){
  const rows=body.orders;if(!Array.isArray(rows)||!rows.length||rows.length>25)fail('Send 1–25 old orders to import.');
  if(body.confirm!=='IMPORT '+rows.length)fail('Type IMPORT and the number of orders to confirm.');
  const result=await transaction(async s=>{await session(s,h);const products=await s.list('products'),seen=new Set(),made=[];
   for(const r of rows){
    const id=text(r.id||'',20);if(!/^GLP-[A-F0-9]{10}$/.test(id))fail('Not an old Glow order number: '+id);if(seen.has(id))fail(id+' is listed twice.');seen.add(id);
    if(await s.get('orders',id))fail(id+' is already in this store. Nothing was imported.',409);
    const c=r.customer||{},customer={};for(const k of ['name','email','address','city','state','zip'])customer[k]=text(c[k]||'',k==='address'?500:150);
    if(!customer.name||!customer.address||!customer.city)fail(id+': name, street and city are required.');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))fail(id+': email is not valid.');
    customer.state=customer.state.toUpperCase();if(!/^[A-Z]{2}$/.test(customer.state))fail(id+': state must be two letters.');
    if(!/^\d{5}(-\d{4})?$/.test(customer.zip))fail(id+': ZIP is not valid.');
    if(c.phone)customer.phone=contactPhone(c.phone);
    if(!Array.isArray(r.items)||!r.items.length||r.items.length>40)fail(id+': add its items.');
    const items=[];for(const l of r.items){const p=products.find(x=>x.sku===text(l.sku||'',60));if(!p)fail(id+': no product with SKU '+l.sku+'.');
     const quantity=int(l.quantity,1,100),price=int(l.price??p.price,0,10000000);items.push({id:p.id,sku:p.sku,name:p.name,price,amount:price*quantity,quantity,promo_excluded:!!p.promo_excluded});
     if(p.units>1)items[items.length-1].units=p.units;if(p.components)items[items.length-1].components=p.components}
    const subtotal=items.reduce((n,i)=>n+i.amount,0),shipping=int(r.shipping??0,0,100000),total=int(r.total,1,10000000),discount=subtotal+shipping-total;
    if(discount<0)fail(id+': the items cost less than the total. Check the prices.');
    const paid=int(r.paid_at??clock(),1,4000000000),created=int(r.created_at??paid,1,4000000000);
    const method=['card_invoice','venmo','paypal','cashapp','zelle','bitcoin'].includes(r.payment_method)?r.payment_method:'card_invoice';
    const o={id,brand:'glow',created,expires:created+7*86400,status:'paid',paid,is_test:false,customer,items,subtotal,discount,coupon_discount:discount,coupons:[],coupon:'',shipping,tax:0,total,
     payment_method:method,checkout_stage:'submitted',proof_required:false,tracking:'',affiliate:null,affiliate_name:null,affiliate_source:null,commission:0,goaffpro_status:'not_applicable',
     points_earned:0,points_to_earn:0,points_redeemed:0,legacy_import:{at:clock(),source:'old site (Netlify, locked)',note:text(r.note||'',300,false)}};
    // A label bought on the old site that UPS never scanned: comes in as shipped with that label, so Packing Check shows it
    // under "needs drop-off" (never offers a second label). Its stock already left with the box, so none is taken here.
    if(r.label){const tracking=text(r.label.tracking||'',40);if(!/^1Z[0-9A-Z]{16}$/.test(tracking))fail(id+': label tracking must be a UPS 1Z number.');
     const url=text(r.label.label_url||'',600,false);if(url&&!/^https:\/\/[a-z0-9.-]*goshippo\.com\//i.test(url))fail(id+': label link must be a Shippo link.');
     o.status='shipped';o.tracking=tracking;o.shipment={carrier:'ups',carrier_name:'UPS',service:text(r.label.service||'UPS',60),label_url:url||null,label_created_at:clock(),legacy_label_date:text(r.label.date||'',30,false)}}
    else for(const line of items)await moveStock(s,line,-1);
    o.staff_notes=[{key:'legacy-import-'+id,text:text('Imported from the old site. '+(r.note||''),1900),actor:'owner',author:'Claude (import)',created:clock()}];
    await s.put('orders',id,o);await audit(s,'legacy_imported',id);made.push({id,name:customer.name,total,status:o.status,tracking:o.tracking||'',items:items.map(i=>i.name+' ×'+i.quantity)})}
   return{ok:true,imported:made,note:'Marked paid. No customer emails, no GoAffPro report, no points.'}});
  return{status:200,headers:{},body:result}}
 // Old-site boxes imported with only a tracking number: look the label up in Shippo by that number and save its PDF link,
 // so Print label / Send to printer work. Read only: never buys, never voids, never changes the tracking.
 if(path==='/admin/orders/attach-legacy-labels'&&method==='POST'){
  const list=await transaction(async s=>{await session(s,h);return(await s.list('orders')).filter(o=>o.legacy_import&&o.status==='shipped'&&/^1Z/.test(o.tracking||'')).map(o=>({id:o.id,tracking:o.tracking}))});
  if(!list.length)return{status:200,headers:{},body:{ok:true,results:[]}};
  const found=await shippo.labelsByTracking(list.map(x=>x.tracking));
  const results=await transaction(async s=>{await session(s,h);const out=[];for(const x of list){const t=found[x.tracking],o=await s.get('orders',x.id);if(!t||!o||o.tracking!==x.tracking){out.push({id:x.id,tracking:x.tracking,found:false});continue}
   o.shipment={...(o.shipment||{}),label_url:t.label_url};await s.put('orders',o.id,o);await audit(s,'legacy_label_attached',o.id);out.push({id:x.id,tracking:x.tracking,found:true})}return out});
  return{status:200,headers:{},body:{ok:true,results}}}
 // Re-price an unpaid order with a new set of codes (Jonah, 29 Oct 2026: add SCARECROW to an order already placed).
 // Owner only, same items, same affiliate, never emails the customer. Stock and code usage move exactly as a checkout edit does.
 if(path==='/admin/order/reprice'&&method==='POST'){
  const r=await transaction(async s=>{const sid=await session(s,h);if((await s.get('sessions',sid))?.staff_id)fail('Only the owner can re-price an order.',403);
   const id=text(body.id||'',50),o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(body.confirm!==id)fail('Type the order number to confirm.');
   if(o.is_test!==false||!['order_received','awaiting_payment'].includes(o.status)||o.paid||o.receipt||o.has_receipt)fail('Only an unpaid order can be re-priced.',409);
   if(o.points_redeemed)fail('This order uses Glow Points. Fix the points before re-pricing it.',409);
   if(!Array.isArray(body.coupons)||body.coupons.length>5)fail('Send the codes as a list.');
   const q=await quote(await editStore(s,o),{items:o.items.map(i=>({id:i.id,quantity:i.quantity})),coupons:body.coupons,affiliate:o.affiliate||''},{},brands.orderBrand(o),memberOpts(o));
   if((q.affiliate||'')!==(o.affiliate||''))fail('These codes would change who gets credit for the sale. Nothing was changed.',409);
   const before={total:o.total,discount:o.discount,coupons:couponRules.codes(o)},status=o.status,revision=(o.revision||0)+1;
   await release(s,o,status);Object.assign(o,q,{status,revision,reservation_version:revision,updated:clock()});await accounts.reserve(s,o);for(const line of o.items)await moveStock(s,line,-1);await couponRules.reserve(s,o,1);
   const actor=(await s.get('sessions',sid))?.staff_id||'owner';o.staff_notes=[...(Array.isArray(o.staff_notes)?o.staff_notes:[]),{key:'reprice-'+revision,text:'Re-priced by the owner: $'+(before.total/100).toFixed(2)+' → $'+(o.total/100).toFixed(2)+' (codes '+(before.coupons.join(', ')||'none')+' → '+(couponRules.codes(o).join(', ')||'none')+'). Customer not emailed.',actor,author:'Claude (re-price)',created:clock()}];
   await s.put('orders',o.id,o);await audit(s,'order_repriced',o.id);return{id,before,after:{total:o.total,discount:o.discount,coupons:couponRules.codes(o)}}});
  return{status:200,headers:{},body:{ok:true,...r}}}
 // Duplicate order: void its unused Shippo label first, then cancel it and put its stock back. Never emails the customer.
 if(path==='/admin/order/cancel-duplicate'&&method==='POST'){const id=text(body.id||'',50);
  const o0=await transaction(async s=>{await session(s,h);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(body.confirm!==id)fail('Type the order number to confirm.');if(o.is_test!==false)fail('Use the normal cancel for test orders.',409);if(!['paid','shipped'].includes(o.status))fail('Only paid or labeled orders can be canceled as a duplicate.',409);if(o.delivery?.first_scan_at)fail('UPS already scanned this package. It cannot be canceled here.',409);if(o.points_redeemed||o.points_earned)fail('This order moved Glow Points. Fix the points before canceling it.',409);if((o.replacements||[]).length)fail('This order has replacement labels. Handle those in Shippo first.',409);return o});
  let refund=null;if(o0.shippo_transaction_id&&!o0.label_refund){refund=await shippo.voidLabel(o0.shippo_transaction_id);if(!['QUEUED','PENDING','SUCCESS'].includes(refund.status))fail('Shippo did not accept the label refund ('+(refund.status||'no status')+'). Nothing was canceled.')}
  const result=await transaction(async s=>{const sid=await session(s,h);const o=await s.get('orders',id);if(refund)o.label_refund={...refund,requested_at:clock()};if(!['paid','shipped'].includes(o.status)){await s.put('orders',id,o);fail('This order changed while canceling. The label refund was still requested.',409)}o.canceled_reason='duplicate';o.canceled_at=clock();o.canceled_by=(await s.get('sessions',sid))?.staff_id||'owner';if(o.label_refund)o.shippo_status='label_refund_'+o.label_refund.status.toLowerCase();await release(s,o,'canceled');return{ok:true,id,label_refund:o.label_refund||null,stock_returned:o.items.map(i=>({name:i.name,quantity:i.quantity})),note:'Customer was not emailed. If this order was really paid, refund it yourself.'}});
  return{status:200,headers:{},body:result}}
 if(path==='/admin/shippo/replacement'&&method==='POST'){const sid=await transaction(s=>session(s,h));const id=text(body.id||'',50);const override=body.override===true;if(override)await ownerOnly(sid);const result=await shippo.replacement(id,{note:body.note,key:body.key,override});await transaction(s=>audit(s,'shippo_replacement',id));return{status:200,headers:{},body:result}}
 if(path==='/admin/shippo/label-costs'&&method==='POST'){await transaction(s=>session(s,h));
  const todo=await transaction(async s=>(await s.list('orders')).filter(o=>o.is_test===false&&o.status==='shipped'&&o.tracking&&!Number.isSafeInteger(o.label_cost_cents??o.shipment?.label_cost_cents)&&!o.label_cost_not_found).map(o=>({id:o.id,tracking:String(o.tracking).trim().toUpperCase()})));
  const batch=todo.slice(0,40),costs=batch.length?await shippo.labelCostsByTracking(batch.map(o=>o.tracking)):{};let updated=0;const missing=[];
  await transaction(async s=>{for(const x of batch){const o=await s.get('orders',x.id);if(!o)continue;const f=costs[x.tracking];if(f){o.label_cost_cents=f.cents;o.label_cost_source='shippo_lookup';o.label_cost_service=f.service;updated++}else{o.label_cost_not_found=true;missing.push(x.id)}await s.put('orders',o.id,o)}await audit(s,'label_costs_backfilled')});
  return{status:200,headers:{},body:{ok:true,checked:batch.length,updated,not_in_shippo:missing,remaining:Math.max(0,todo.length-batch.length)}}}
 // Subscribe & save (Jonah, 4 Nov 2026): staff start, change, pause or cancel subscriptions. Repeat orders are made by Autopilot.
 if(path==='/admin/subscriptions'&&method==='GET'){await transaction(s=>session(s,h));return{status:200,headers:{},body:{subscriptions:await require('./subscriptions.cjs').list(),stats:await require('./subscriptions.cjs').stats(),every:require('./subscriptions.cjs').EVERY,discount_pct:require('./subscriptions.cjs').DISCOUNT_PCT,stripe_ready:autoInvoice.stripeReady()}}}
 if(path==='/admin/subscription/create'&&method==='POST'){const sid=await transaction(s=>session(s,h));const rec=await transaction(s=>s.get('sessions',sid));const r=await require('./subscriptions.cjs').create({order_id:text(body.order_id||'',50),every:text(body.every||'',4),by:rec?.staff_id||'owner'});await transaction(s=>audit(s,'subscription_created',r.source_order));return{status:200,headers:{},body:r}}
 if(path==='/admin/subscription/update'&&method==='POST'){await transaction(s=>session(s,h));const r=await require('./subscriptions.cjs').update({id:text(body.id||'',20),action:text(body.action||'',10),every:text(body.every||'',4,false),next_date:text(body.next_date||'',10,false),address:body.address});await transaction(s=>audit(s,'subscription_'+r.status+'_'+text(body.action||'',10),r.source_order));return{status:200,headers:{},body:r}}
 // Autopilot (Jonah, 4 Nov 2026): background jobs the owner switches on one at a time. Staff can look; only the owner can switch.
 if(path==='/admin/autopilot'&&method==='GET'){await transaction(s=>session(s,h));return{status:200,headers:{},body:await require('./autopilot.cjs').status()}}
 if(path==='/admin/autopilot'&&method==='POST'){const sid=await transaction(s=>session(s,h));const rec=await transaction(s=>s.get('sessions',sid));if(rec?.staff_id)fail('Only the owner sign-in can switch Autopilot on or off.',403);const ap=require('./autopilot.cjs'),task=text(body.task||'',20,false);if(!ap.TASKS[task])fail('Choose an Autopilot task.');const r=await ap.set(task,body.on===true,'owner');await transaction(s=>audit(s,'autopilot_'+task+'_'+(r.on?'on':'off')));return{status:200,headers:{},body:await ap.status()}}
 if(path==='/admin/shippo/dryrun'&&method==='POST'){await transaction(s=>session(s,h));const result=await shippo.dryRun();await transaction(s=>audit(s,'shippo_dry_run'));return{status:200,headers:{},body:result}}
 if(['/admin/shippo/check','/admin/shippo/buy','/admin/shippo/retry'].includes(path)&&method==='POST'){
  const sid=await transaction(s=>session(s,h));let result;
  if(path.endsWith('/check')){const checked=await shippo.check();await transaction(async s=>{const old=await s.get('integrations','shippo');const keep=old?.fingerprint===checked.fingerprint;await s.put('integrations','shippo',{...old,...checked,enabled:keep&&old?.enabled===true,carrier_account:checked.accounts.some(a=>a.id===old?.carrier_account)?old.carrier_account:(checked.accounts[0]?.id||'')});await audit(s,'shippo_checked')});result={ok:true,accounts:checked.accounts};}
  else{const id=text(body.id||'',50);const override=body.override===true;if(override)await ownerOnly(sid);const opts={manual:true,servicelevel:text(body.servicelevel||'',40,false),override};result=path.endsWith('/retry')?await shippo.retry(id,opts):await shippo.buy(id,opts);await transaction(s=>audit(s,'shippo_'+(path.endsWith('/retry')?'retry':'buy')+(override&&result?.status==='synced'?'_price_override':''),id))}
  return{status:200,headers:{},body:result};
 }
 if(['/admin/shipstation/check','/admin/shipstation/send','/admin/shipstation/tracking'].includes(path)&&method==='POST'){
  const sid=await transaction(s=>session(s,h));let result;
  if(path.endsWith('/check')){const checked=await shipping.check();await transaction(async s=>{const old=await s.get('integrations','shipstation');await s.put('integrations','shipstation',{...old,...checked,enabled:old?.fingerprint===checked.fingerprint&&old?.enabled===true})});result={ok:true,stores:checked.stores};}
  else result=await (path.endsWith('/send')?shipping.send:shipping.tracking)(text(body.id||'',50));
  return{status:200,headers:{},body:result};
 }
 // Authenticate before the network request; keep external calls outside the database lock.
 if(['/admin/goaffpro/check','/admin/goaffpro/storefronts'].includes(path)&&method==='POST'){
  await transaction(s=>session(s,h));
  const checked=await goaffpro.checkConnection(int(body.offset??0,0,100000));
  const imported=await transaction(async s=>{await session(s,h);const previous=await s.get('integrations','goaffpro');if(previous?.fingerprint===checked.record.fingerprint)checked.record.reporting_checked_at=previous.reporting_checked_at;await s.put('integrations','goaffpro',checked.record);const imported=path.endsWith('/storefronts')?await createStorefronts(s,checked.affiliates):null;await audit(s,imported?'goaffpro_storefronts_created':'goaffpro_connection_checked');return imported});
  return{status:200,headers:{},body:{...goaffpro.status(checked.record),affiliates:checked.affiliates,limit:checked.limit,offset:checked.offset,has_more:checked.has_more,...(imported?{imported}:{})}};
 }
 if(path==='/admin/goaffpro/reporting-check'&&method==='POST'){
  await transaction(s=>session(s,h));const record=await goaffpro.reportingCheck();await transaction(async s=>{await session(s,h);await s.put('integrations','goaffpro',record);await audit(s,'goaffpro_reporting_permissions_checked')});return{status:200,headers:{},body:{...goaffpro.status(record),message:'Order lookup and self-purchase checks are available. The sales.write permission will be exercised on the first eligible live order.'}};
 }
 // Daily call list: preview who is due (GET) or send the email now (POST). Staff only.
 if(path==='/admin/call-list'&&['GET','POST'].includes(method)){
  await transaction(s=>session(s,h));const callList=require('./call-list.cjs');
  if(method==='GET')return{status:200,headers:{},body:await callList.run({preview:true})};
  const r=await callList.run({force:true});if(r.job)await emails.safeDispatch(r.job);
  await transaction(async s=>{await session(s,h);await audit(s,'call_list_sent')});
  return{status:200,headers:{},body:r};
 }
 if(path==='/admin/goaffpro/report'&&method==='POST'){
  await transaction(s=>session(s,h));const id=text(body.id||'',100);return{status:200,headers:{},body:await reporting.report(id)};
 }
 const photoUpload=path.match(/^\/affiliate-profile\/([a-z0-9-]+)\/photo$/);
 if(photoUpload&&method==='POST'){
  await transaction(s=>photos.authorize(s,photoUpload[1],h['x-profile-token']));
  const image=body.remove===true?null:await photos.encodePhoto(body);
  await transaction(async s=>{await photos.authorize(s,photoUpload[1],h['x-profile-token']);if(image)await s.put('affiliate_photos',photoUpload[1],image);else await s.remove('affiliate_photos',photoUpload[1]);await audit(s,'affiliate_photo_updated')});
  return{status:200,headers:{},body:{ok:true,photo_url:image?photoUrl(photoUpload[1]):null}};
 }
 let receiptImage;
 const receiptUpload=path.match(/^\/orders\/([A-Z0-9-]+)\/receipt$/);
 if(receiptUpload&&method==='POST'){
  await transaction(async s=>{await expire(s);const o=await orderAuth(s,receiptUpload[1],h);if(!['order_received','awaiting_payment','payment_submitted'].includes(o.status))fail('This order no longer accepts receipts.',409)});
  text(body.reference||'',100,false);receiptImage=await receipts.encodeReceipt(body);
 }
 const reqBrand=brands.fromHeaders(h);
 if(path==='/native-affiliates/photo'&&method==='POST'){
  if(reqBrand.id!=='zader')fail('Affiliate program not found.',404);
  await transaction(async s=>{const customer=await accounts.session(s,h,true);if(!await nativeAffiliates.mine(s,customer))fail('Affiliate not found.',404)});
  const image=body.remove===true?null:await photos.encodePhoto(body);
  await transaction(async s=>{const customer=await accounts.session(s,h,true),a=await nativeAffiliates.mine(s,customer);if(!a)fail('Affiliate not found.',404);if(image)await s.put('affiliate_photos',a.slug,image);else await s.remove('affiliate_photos',a.slug);await audit(s,'native_affiliate_photo_updated',a.slug)});
  return{status:200,headers:{},body:{ok:true}};
 }
 const result=await transaction(async raw=>{
  const s=nativeAffiliates.tracked(raw);
  const settings=await s.get('settings','main');if(!settings)fail('Store data has not been initialized.',503);if(settings.demo===false&&settings.payment_links?.zelle==='9742418176'&&!await s.get('migrations','zelle-recipient-20261007')){settings.payment_links.zelle='943-241-8176';settings.zelle_recipient_name='Heather Zader';await s.put('settings','main',settings);await s.put('migrations','zelle-recipient-20261007',{applied:clock()});await audit(s,'zelle_recipient_corrected');}if(settings.demo===false&&String(settings.payment_links?.zelle||'').replace(/\D/g,'')==='9432418176'&&!settings.zelle_recipient_name){settings.zelle_recipient_name='Heather Zader';await s.put('settings','main',settings);}await expire(s);
  if(!await s.get('migrations','nad-promo-excluded-20261014')){const nad=await s.get('products',7);if(nad&&nad.sku==='nad-500-mg'&&brands.productBrand(nad)==='glow'){nad.promo_excluded=true;await s.put('products',nad.id,nad);await s.put('migrations','nad-promo-excluded-20261014',{applied:clock(),product_id:nad.id});await audit(s,'nad_promo_exclusion_enabled');}}
  if(reqBrand.id==='zader')await brands.ensureZaderCatalog(s,validSlug);
  await ensureMerchCatalog(s);
  if(path==='/catalog'&&method==='GET'){const mctx=await members.context(s,(await accounts.session(s,h))?.email,reqBrand.id);return{products:await (async()=>{const all=await s.list('products'),byId=new Map(all.map(x=>[x.id,x])),out=[];for(const p of all.filter(p=>p.active&&brands.productBrand(p)===reqBrand.id&&members.visible(mctx,p)))out.push(productLimits.publicLimits(brands.publicProduct(withProductPhotos(await bundleStock(async id=>byId.get(id),p)),settings.demo===false)));return out})(),brand:brands.publicBrand(reqBrand),settings:{...settings,...autoInvoice.publicFlags(settings),email_enabled:emails.configuration().ready,subscribe_open:!(await require('./subscriptions.cjs').offerOpen(s,reqBrand)),...(reqBrand.waitlist?{checkout_enabled:false,waitlist:true}:{})},...(mctx?{members_on:true}:{})}}
  if(path.startsWith('/native-affiliates')){
   if(reqBrand.id!=='zader')fail('Affiliate program not found.',404);
   const customer=await accounts.session(s,h,true);
   if(path==='/native-affiliates/photo'&&method==='GET'){const a=await nativeAffiliates.mine(s,customer),image=a&&await s.get('affiliate_photos',a.slug);if(!image)fail('Photo not found.',404);return{_binary:image.data,_type:'image/jpeg'}}
   if(path==='/native-affiliates'&&method==='GET')return nativeAffiliates.portal(s,customer);
   if(path==='/native-affiliates/apply'&&method==='POST'){const a=await nativeAffiliates.apply(s,customer,body);await audit(s,'native_affiliate_applied',a.slug);return{ok:true}}
   if(path==='/native-affiliates/profile'&&method==='POST')return nativeAffiliates.updateProfile(s,customer,body);
   fail('Endpoint not found.',404);
  }
  const referral=path.match(/^\/referrals\/([^/]+)$/);
  if(referral&&method==='GET'){let code;try{code=decodeURIComponent(referral[1])}catch{fail('Affiliate referral is unavailable.',404)}const direct=await s.get('affiliates',code.toLowerCase());const a=direct?.active?direct:await resolveReferral(s,code);if(!a||nativeAffiliates.brandOf(a)!==reqBrand.id)fail('Affiliate referral is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const storefront=path.match(/^\/storefronts\/([a-z0-9-]+)$/);
  if(storefront&&method==='GET'){const a=validSlug(storefront[1])?await s.get('affiliates',storefront[1]):null;if(!a?.active||nativeAffiliates.brandOf(a)!==reqBrand.id)fail('Affiliate storefront is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const publicPhoto=path.match(/^\/storefronts\/([a-z0-9-]+)\/photo$/);
  if(publicPhoto&&method==='GET'){const a=await s.get('affiliates',publicPhoto[1]),image=await s.get('affiliate_photos',publicPhoto[1]);if(!a?.active||!image||nativeAffiliates.brandOf(a)!==reqBrand.id)fail('Photo not found.',404);return{_binary:image.data,_type:'image/jpeg'}}
  const profile=path.match(/^\/affiliate-profile\/([a-z0-9-]+)$/);
  if(profile&&method==='GET'){const a=await photos.authorize(s,profile[1],h['x-profile-token']);return{slug:a.slug,name:a.name,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  if(path==='/quote'&&method==='POST'){if(body.order_for_customer===true){await session(s,h);if(body.points_redeemed)fail('Customer rewards cannot be redeemed from a staff login.');return quote(s,body,{},reqBrand)}return quote(s,body,h)}
  if(path==='/account'&&method==='GET')return accounts.accountData(s,await accounts.session(s,h,true));
  if(path==='/account/logout'&&method==='POST'){const token=(h.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('glow_next_customer='))?.slice(19);if(token)await s.remove('customer_sessions',accounts.hash(token));setCookie=accounts.cookie('',0);return{ok:true}}
  if(path==='/orders'&&method==='POST'){if(reqBrand.waitlist)fail(reqBrand.name+' is taking waitlist sign-ups only right now.',503);
   if(settings.demo!==true&&!(settings.demo===false&&settings.checkout_enabled===true&&settings.tax_mode==='none'))fail('Live checkout is disabled. Enable it in dashboard Settings after saving inventory and payment recipients.',503);
   const key=text(body.idempotency_key||'',100);if(await s.get('idempotency',key))fail('This order was already submitted. Use your saved confirmation.',409);
   const assisted=body.order_for_customer===true,staffSession=assisted?await session(s,h):null;if(assisted&&body.points_redeemed)fail('Customer rewards cannot be redeemed from a staff login.');
   const a=assisted?null:await accounts.session(s,h),q=await quote(s,body,assisted?{}:h,reqBrand),customer=checkoutCustomer(body.customer);
   if(a&&accounts.email(customer.email)!==a.email)fail('Use your account email for this order.');if(q.commission_provider==='native')nativeAffiliates.validateSelf(await s.get('affiliates',q.affiliate),{...customer,id:a?.id});
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle','bitcoin','card_invoice'].includes(payment))fail('Choose a payment method.');const inv=autoInvoice.invoiced(payment,settings);if(!inv&&settings.demo===false&&!settings.payment_links[payment])fail('This payment method is not available.');const via=body.invoice_via==='text'?'text':'email';if(inv&&via==='text'&&String(customer.phone||'').replace(/\D/g,'').length<10)fail('Enter a mobile number to get your invoice by text.');
   const id=reqBrand.order_prefix+'-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url');const o={id,created:clock(),expires:null,status:'order_received',customer,...q,payment_method:payment,token_hash:hash(token),idempotency_key:key,request_hash:hash(JSON.stringify(body)),checkout_stage:inv?'submitted':'draft',proof_required:!assisted&&!inv,submitted_at:inv?clock():null,...(inv?{invoice_via:via}:{}),receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:q.commission_provider==='native'?'not_applicable':q.affiliate?'awaiting_payment':'not_applicable'};
   o.source=/^[a-z0-9_-]{1,24}$/.test(String(body.source||''))?String(body.source):''; // where the shopper came from (sales funnel)
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;
   const beneficiary=assisted?await s.get('customers',accounts.hash(accounts.email(customer.email))):a;
   o.is_test=settings.demo!==false;o.customer_id=beneficiary?.verified&&reqBrand.rewards?beneficiary.id:null;if(assisted){const actor=await s.get('sessions',staffSession);o.created_by_staff=actor.staff_id||'owner';o.order_for_customer=true}o.points_earned=0;delete o.points_multiplier;if(reqBrand.rewards&&!assisted&&typeof body.friend==='string'&&body.friend){const r=await s.get('referral_codes',body.friend.trim().toLowerCase().slice(0,20));if(r&&r.customer_id!==accounts.hash(accounts.email(customer.email)))o.referred_by=r.customer_id}if(o.proof_required){o.expires=clock()+7*86400;o.payment_window_days=7}await accounts.reserve(s,o);
   for(const item of q.items)await moveStock(s,item,-1);await couponRules.reserve(s,q,1);
   await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created',id);emailJob=await emails.queueOrder(s,o,token);if(!o.proof_required)staffJobs.push(...await emails.queueStaffAlert(s,o));if(autoInvoice.eligible(o,settings))invoiceJob=o.id;return{order:publicOrder(o),token};
  }
  const edit=path.match(/^\/orders\/([A-Z0-9-]+)\/(edit-context|edit-quote|edit)$/);
  if(edit){const o=await orderAuth(s,edit[1],h);editable(o);const available=await editStore(s,o);
   if(edit[2]==='edit-context'&&method==='GET'){const products=[];for(const p of await s.list('products'))if(p.active&&brands.productBrand(p)===brands.orderBrand(o).id)products.push(brands.publicProduct(withProductPhotos(await bundleStock(id=>available.get('products',id),await available.get('products',p.id))),settings.demo===false));return{products,settings:{...settings,...autoInvoice.publicFlags(settings),email_enabled:emails.configuration().ready},order:publicOrder(o)}}
   if(method!=='POST')fail('Method not allowed.',405);
   if(body.points_redeemed&&o.order_for_customer)fail('Customer rewards cannot be redeemed from a staff login.');
   const q=await quote(available,body,o.order_for_customer?{}:h,brands.orderBrand(o),memberOpts(o));
   if(edit[2]==='edit-quote')return q;
   if(body.not_paid!==true)fail('Confirm you have not paid before changing this draft.');
   if(body.expected_revision!==(o.revision||0))fail('This checkout changed in another tab. Reopen your order before editing.',409);
   const customer=checkoutCustomer(body.customer);if(accounts.email(customer.email)!==accounts.email(o.customer.email))fail('Keep the same order email while editing. Contact the store to change it.');if(q.commission_provider==='native')nativeAffiliates.validateSelf(await s.get('affiliates',q.affiliate),{...customer,id:o.customer_id});
   const payment=text(body.payment_method||'',20);const inv=autoInvoice.invoiced(payment,settings);if(!['venmo','paypal','cashapp','zelle','bitcoin','card_invoice'].includes(payment)||!inv&&settings.demo===false&&!settings.payment_links[payment])fail('Choose an available payment method.');const via=body.invoice_via==='text'?'text':'email';if(inv&&via==='text'&&String(customer.phone||'').replace(/\D/g,'').length<10)fail('Enter a mobile number to get your invoice by text.');
   if(q.points_redeemed){const a=await accounts.session(s,h);if(!a||a.id!==o.customer_id)fail('Sign in to the original customer account to use its rewards.',401)}
   const previousPayment=o.payment_method,wasInvoiced=previousPayment==='card_invoice'||!!o.invoice_via;const revision=(o.revision||0)+1;await release(s,o,o.status);Object.assign(o,q,{customer,payment_method:payment,revision,reservation_version:revision,updated:clock()});if(inv){o.proof_required=false;o.checkout_stage='submitted';o.submitted_at=o.submitted_at||clock();o.status='order_received';o.expires=null;o.invoice_via=via;delete o.invoice_sent_at;delete o.invoice_sent_by;}else if(wasInvoiced){delete o.invoice_via;o.proof_required=!o.order_for_customer;o.checkout_stage='draft';o.submitted_at=null;o.status='order_received';o.expires=o.proof_required?clock()+7*86400:null;delete o.invoice_sent_at;delete o.invoice_sent_by;}if(o.brand==='zader'&&q.commission_provider!=='native'){delete o.commission_provider;delete o.commission_bps;}
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;await accounts.reserve(s,o);
   for(const line of o.items)await moveStock(s,line,-1);await couponRules.reserve(s,o,1);await s.put('orders',o.id,o);await audit(s,'checkout_edited',o.id);if(inv)staffJobs.push(...await emails.queueStaffAlert(s,o));if(autoInvoice.eligible(o,settings))invoiceJob=o.id;
   if(o.is_test===false)emailJob=await emails.enqueue(s,{id:'draft-edit-'+o.id+'-'+revision,kind:'checkout_updated',brand:o.brand,to:o.customer.email,related_id:o.id,subject:'Updated '+brands.orderBrand(o).name+' checkout '+o.id,content:emails.template('Your checkout has been updated.',['Order: '+o.id,'Your latest total is $'+(o.total/100).toFixed(2)+'. Use this amount instead of earlier checkout emails.',inv?(autoInvoice.eligible(o,settings)?'Your order is submitted. Your Glow Lab invoice is on its way by '+(via==='text'?'text message':'email')+'. Pay it by card or Cash App and your order joins the packing queue automatically.':'Your order is submitted. We will email a credit card invoice to '+o.customer.email+'. No payment has been received. Your order enters the fulfillment queue after staff verify payment.'):'Your existing private order link shows the latest items, status and shipping address. After paying, upload your screenshot for staff verification.'],null,null)});return{order:publicOrder(o)};
  }
  const m=path.match(/^\/orders\/([A-Z0-9-]+)(\/receipt)?$/);if(m){const o=await orderAuth(s,m[1],h);if(method==='GET'&&!m[2]){const v=publicOrder(o);if(v.packed)v.packed={at:v.packed.at};return v}if(method==='POST'&&m[2]){
   if(!['order_received','awaiting_payment','payment_submitted'].includes(o.status))fail('This order no longer accepts receipts.',409);
   if((o.revision||0)>0&&body.expected_revision!==o.revision)fail('This checkout changed. Refresh your order and check the latest total before submitting payment proof.',409);
   if(!o.customer.phone)o.customer.phone=contactPhone(body.phone);
   const method=text(body.payment_method??o.payment_method,20);if(!['venmo','paypal','cashapp','zelle','bitcoin'].includes(method)||o.is_test===false&&!settings.payment_links?.[method])fail('Choose an available payment method.');const reference=text(body.reference||'',100,false);o.payment_method=method;o.receipt=receiptImage.data;o.receipt_type=receiptImage.mime;o.payment_reference=reference;o.status='payment_submitted';o.checkout_stage='submitted';o.submitted_at=o.submitted_at||clock();emailJob=await emails.queueSubmitted(s,o);staffJobs.push(...await emails.queueStaffAlert(s,o));await s.put('orders',o.id,o);await audit(s,'receipt_submitted',o.id);return publicOrder(o);
  }fail('Endpoint not found.',404)}
  if(path==='/admin/login'&&method==='POST'){
   if(!process.env.STORE_ADMIN_PASSWORD||process.env.STORE_ADMIN_PASSWORD.length<12)fail('Admin password is not configured.',503);
   const ip=hash(h['x-nf-client-connection-ip']||h['x-forwarded-for']||'local'),attempt=await s.get('login_attempts',ip)||{count:0,until:0};
   if(attempt.until>clock()&&attempt.count>=5)return{_error:'Too many login attempts. Wait 15 minutes.',_status:429};
   if(!equal(hash(String(body.password||'')),hash(process.env.STORE_ADMIN_PASSWORD))){const next=attempt.until>clock()?{count:attempt.count+1,until:attempt.until}:{count:1,until:clock()+900};await s.put('login_attempts',ip,next);return{_error:'Incorrect password.',_status:401}}
   await s.remove('login_attempts',ip);const life=[true,'1','on'].includes(body.remember)?2592000:28800;const core=(clock()+life)+'.'+crypto.randomBytes(16).toString('hex');const token=core+'.'+sign(core);
   await s.put('sessions',core.split('.')[1],{expires:clock()+life});setCookie=`glow_next_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${life}${process.env.STORE_LOCAL?'':'; Secure'}`;return{ok:true};
  }
  if(path.startsWith('/admin/')){
   const sessionId=await session(s,h);
   const owner=!(await s.get('sessions',sessionId)).staff_id;
   if(path.startsWith('/admin/native-affiliates')){
    if(reqBrand.id!=='zader')fail('Use the Zader Health dashboard for its affiliate program.',404);
    const actor=(await s.get('sessions',sessionId)).staff_id||'owner';
    if(path==='/admin/native-affiliates'&&method==='GET')return nativeAffiliates.adminData(s);
    if(path==='/admin/native-affiliates/save'&&method==='POST'){const a=await nativeAffiliates.save(s,body,actor);await audit(s,'native_affiliate_saved',a.slug);return{ok:true}}
    if(path==='/admin/native-affiliates/payout'&&method==='POST'){const p=await nativeAffiliates.recordPayout(s,body,actor);await audit(s,'native_affiliate_payout_recorded',p.affiliate);return{ok:true}}
    if(path==='/admin/native-affiliates/invite'&&method==='POST'){const a=await s.get('affiliates',body.slug);if(!nativeAffiliates.isNative(a))fail('Zader affiliate not found.',404);if(!emails.configuration().ready)fail('Email is not configured.',503);const customer=await s.get('customers',a.customer_id);if((customer.last_setup_email||0)>clock()-300)fail('Wait five minutes before sending another setup email.',429);const link=await accounts.issueSetup(s,a.customer_id);const fresh=await s.get('customers',a.customer_id);fresh.last_setup_email=clock();await s.put('customers',fresh.id,fresh);emailJob=await emails.queueSetup(s,link,customer.verified,'zader');await audit(s,'native_affiliate_invite_requested',a.slug);return{ok:true}}
    fail('Endpoint not found.',404);
   }
   if(path==='/admin/reports'&&method==='POST')return businessReports.build(s,body);
   if(path==='/admin/reports/cost'&&method==='POST'){const actor=(await s.get('sessions',sessionId)).staff_id||'owner';const result=await businessReports.saveCost(s,body,actor);await audit(s,'report_product_cost_saved',result.id);return result}
   if(path==='/admin/reports/expense'&&method==='POST'){const actor=(await s.get('sessions',sessionId)).staff_id||'owner';const result=await businessReports.saveExpense(s,body,actor);await audit(s,body.voided?'report_expense_voided':'report_expense_recorded',result.id);return result}
   if(path==='/admin/checkout-context'&&method==='GET')return{can_order_for_customer:true};
   if(path==='/admin/staff/invite'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const r=await staff.invite(s,body);emailJob=r.job;await audit(s,'staff_invited',r.staff.email);return{ok:true,staff:r.staff}}
   if(path==='/admin/staff/revoke'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const a=await s.get('staff',text(body.id||'',64));if(!a)fail('Staff member not found.',404);a.active=false;a.auth_version++;delete a.setup;await s.put('staff',a.id,a);await audit(s,'staff_access_revoked',a.email);return{ok:true}}
   if(path==='/admin/affiliate/photo-link'&&method==='POST'){if(affiliateManager){const a=await s.get('affiliates',body.slug);if(!a||nativeAffiliates.brandOf(a)!=='glow'||nativeAffiliates.isNative(a))fail('Glow affiliate not found.',404);}const result=await photos.issueLink(s,text(body.slug||'',60));await audit(s,'affiliate_photo_link_created');return result}
   if(path==='/admin/logout'&&method==='POST'){await s.remove('sessions',sessionId);setCookie='glow_next_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.STORE_LOCAL?'':'; Secure');return{ok:true}}
   if(path==='/admin/shippo/settings'&&method==='POST'){const r=await s.get('integrations','shippo');const st=shippo.status(r);if(!st.connected)fail('Check the Shippo connection first.',409);const account=text(body.carrier_account||'',80);if(!st.accounts.some(a=>a.id===account))fail('Choose a UPS account from the Shippo check.');const num=(v,min,max,dflt)=>{const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?Math.round(n*100)/100:dflt};const d=shippo.DEFAULTS;await s.put('integrations','shippo',{...r,carrier_account:account,servicelevel:['ups_second_day_air','ups_ground','ups_3_day_select','ups_next_day_air_saver','ups_next_day_air'].includes(body.servicelevel)?body.servicelevel:d.servicelevel,parcel:{length:num(body.length,1,48,d.parcel.length),width:num(body.width,1,48,d.parcel.width),height:num(body.height,1,48,d.parcel.height),weight_lb:num(body.weight_lb,0.1,50,d.parcel.weight_lb)},max_label_cents:int(Math.round(num(body.max_label_dollars,1,500,d.max_label_cents/100)*100),100,50000),daily_limit:int(Math.round(num(body.daily_limit,1,500,d.daily_limit)),1,500),enabled:body.enabled===true});await audit(s,body.enabled===true?'shippo_enabled':'shippo_paused');return{ok:true}}
   if(path==='/admin/shipstation/settings'&&method==='POST'){const r=await s.get('integrations','shipstation');if(!shipping.status(r).connected)fail('Check ShipStation connection first.',409);const target=r.stores.find(x=>x.id===body.store_id);if(!target)fail('Choose a verified ShipStation manual store.');await s.put('integrations','shipstation',{...r,store_id:target.id,store_name:target.name,enabled:body.enabled===true});await audit(s,'shipstation_settings_saved');return{ok:true}}
   if(path==='/admin/order/restore'&&method==='POST'){
    const o=await s.get('orders',text(body.id||'',50));if(!o)fail('Order not found.',404);if(o.status!=='expired')fail('Only expired orders can be reinstated.',409);
    if(body.expected_revision!==(o.revision||0))fail('This order changed. Reopen it before reinstating.',409);
    const pools=new Map();for(const line of o.items)for(const d of lineDraws(line)){const p=await s.get('products',d.id);if(!p)fail('A product on this order is missing. Review inventory before reinstating.',409);const key=p.stock_pool?'pool:'+p.stock_pool:'product:'+p.id;const group=pools.get(key)||{p,quantity:0};group.quantity+=line.quantity*d.qty;pools.set(key,group)}
    for(const {p,quantity} of pools.values())if(p.stock<quantity)fail('Not enough stock to reinstate '+p.name+'. Update inventory before reinstating this paid order.',409);
    o.reservation_version=Math.max(o.reservation_version||0,o.revision||0)+1;await accounts.reserve(s,o);
    for(const {p,quantity} of pools.values())await setStock(s,p,p.stock-quantity);
    await couponRules.reserve(s,o,1);
    o.status='awaiting_payment';o.expires=clock()+7*86400;o.payment_window_days=7;o.restored_at=clock();o.restored_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.restore_count=(o.restore_count||0)+1;o.revision=(o.revision||0)+1;await s.put('orders',o.id,o);await audit(s,'order_reinstated',o.id);return{ok:true,order:publicOrder(o)};
   }
   if(path==='/admin/order/remind'&&method==='POST'){
    if(!emails.configuration().ready)fail('Connect automatic email in Settings first.',503);
    const o=await s.get('orders',text(body.id||'',50));if(!o)fail('Order not found.',404);
    if(o.is_test!==false)fail('Payment reminders are only available for live orders.',409);
    if(!['order_received','awaiting_payment'].includes(o.status)||o.receipt||o.paid)fail('This order is paid, closed, or already awaiting payment verification. Do not request another payment.',409);
    const requestKey=text(body.idempotency_key||'',100),jobId='payment-reminder-'+o.id+'-'+hash(requestKey),existing=await s.get('email_outbox',jobId);
    if(existing){emailJob=jobId;return{ok:true,job_id:jobId}}
    if((o.last_payment_reminder_at||0)>clock()-300)fail('A reminder was requested recently. Wait five minutes before sending another.',429);
    emailJob=await emails.queueReminder(s,o,reminderToken(o),jobId);o.last_payment_reminder_at=clock();o.last_payment_reminder_job=jobId;await s.put('orders',o.id,o);await audit(s,'payment_reminder_requested',o.id);return{ok:true,job_id:jobId};
   }
   if(path==='/admin/customers'&&method==='GET')return accounts.adminData(s);
   if(['/admin/order/items','/admin/order/payment-adjustment'].includes(path)&&method==='POST'){
    const o=await s.get('orders',text(body.id||'',50)),actor=(await s.get('sessions',sessionId)).staff_id||'owner';
    const updated=path.endsWith('/items')?await adjustments.edit(s,o,body,actor,setStock):await adjustments.recordPayment(s,o,body,actor);
    await audit(s,path.endsWith('/items')?'order_items_adjusted':'order_payment_adjusted',o.id);return{ok:true,order:publicOrder(updated)};
   }
   if(path==='/admin/order/export-review'&&method==='POST'){
    const o=await s.get('orders',text(body.id||'',50));if(!o)fail('Order not found.',404);if(body.expected_revision!==(o.revision||0))fail('This order changed. Reopen before confirming review.',409);
    if(body.shipping_review!==true&&body.affiliate_review!==true)fail('Confirm which external order you updated.');
    if(body.shipping_review===true&&o.shipstation_needs_review){o.shipstation_needs_review=false;o.shipstation_status='synced';o.shipstation_message='Updated shipment reviewed by staff.';}
    if(body.affiliate_review===true&&o.goaffpro_needs_review){o.goaffpro_needs_review=false;o.goaffpro_status='synced';o.goaffpro_message='Updated affiliate sale reviewed by staff.';}
    o.revision=(o.revision||0)+1;o.updated=clock();await s.put('orders',o.id,o);await audit(s,'order_exports_reviewed',o.id);return{ok:true,order:publicOrder(o)};
   }
   if(path==='/admin/order/note'&&method==='POST'){
    const o=await s.get('orders',text(body.id||'',50));if(!o)fail('Order not found.',404);
    if(typeof body.note!=='string'||!body.note.trim()||body.note.length>2000)fail('Enter a staff note of up to 2,000 characters.');
    if(typeof body.key!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(body.key))fail('Reopen the order and try saving the note again.');
    const actor=(await s.get('sessions',sessionId)).staff_id||'owner',notes=o.staff_notes||[],previous=notes.find(n=>n.key===body.key);
    if(previous){if(previous.actor!==actor||previous.text!==body.note.trim())fail('This note request was already used. Reopen the order.',409);return{ok:true}}
    if(notes.length>=500)fail('This order has reached the staff-note limit.');
    const author=actor==='owner'?'Store owner':(await s.get('staff',actor))?.name||'Staff';
    o.staff_notes=[...notes,{key:body.key,text:body.note.trim(),actor,author,created:clock()}];o.revision=(o.revision||0)+1;o.updated=clock();
    await s.put('orders',o.id,o);await audit(s,'order_note_added',o.id);return{ok:true};
   }
   if(path==='/admin/order/customer'&&method==='POST'){
    const o=await s.get('orders',text(body.id||'',50));if(!o)fail('Order not found.',404);
    if(body.expected_revision!==(o.revision||0))fail('This order changed. Reopen it before saving.',409);
    const customer=checkoutCustomer(body.customer);
    const addressChanged=['name','address','city','state','zip'].some(k=>customer[k]!==o.customer[k]);
    if(o.shipstation_order_id&&addressChanged&&body.shipping_review!==true)fail('Confirm you will update the exported shipping address in ShipStation.',409);
    o.customer=customer;o.revision=(o.revision||0)+1;o.updated=clock();
    if(o.shipstation_order_id&&addressChanged)o.shipstation_needs_review=true;
    await s.put('orders',o.id,o);await audit(s,'order_customer_edited',o.id);return{ok:true,order:publicOrder(o)};
   }
   if(path==='/admin/customer/edit'&&method==='POST'){
    const a=await s.get('customers',text(body.customer_id||'',64));if(!a)fail('Customer not found.',404);
    if(body.expected_revision!==(a.profile_revision||0))fail('This customer changed. Reopen before saving.',409);
    a.name=text(body.name||'',150);a.phone=body.phone?contactPhone(body.phone):'';a.updated=clock();a.profile_revision=(a.profile_revision||0)+1;
    await s.put('customers',a.id,a);await audit(s,'customer_profile_edited',a.id);return{ok:true};
   }

   if(path==='/admin/email'&&method==='GET')return emails.adminData(s);
   if(path==='/admin/email/test'&&method==='POST'){if(!emails.configuration().ready)fail('Configure the Resend key, sender and email enable flag in Netlify first.',503);const to=accounts.email(body.email),id='email-test-'+hash(text(body.idempotency_key||'',100));const log=await s.get('integrations','email_test_limit');if(log?.until>clock()&&log.count>=5)fail('Wait 15 minutes before sending more connection tests.',429);await s.put('integrations','email_test_limit',{count:log?.until>clock()?log.count+1:1,until:log?.until>clock()?log.until:clock()+900});emailJob=await emails.enqueue(s,{id,kind:'connection_test',to,subject:'Glow Lab email connection test',content:emails.template('Your store email connection works.',['This is a connection test requested from your Glow Lab dashboard. No order or payment was created.'],null,null)});return{ok:true};}
   if(path==='/admin/customer/send-setup'&&method==='POST'){if(!emails.configuration().ready)fail('Connect automatic email in Settings first.',503);const id=text(body.customer_id||'',64),a=await s.get('customers',id);if(!a)fail('Customer not found.',404);if((await s.get('rewards_imports',id))?.held)fail('Review this customer email before sending setup.');if((a.last_setup_email||0)>clock()-300)fail('A setup email was requested recently. Wait five minutes before sending another.',429);const link=await accounts.issueSetup(s,id),fresh=await s.get('customers',id);fresh.last_setup_email=clock();await s.put('customers',id,fresh);emailJob=await emails.queueSetup(s,link,a.verified);await audit(s,'customer_setup_email_requested');return{ok:true};}
   if(path==='/admin/customer/setup-link'&&method==='POST'){const r=await accounts.issueSetup(s,text(body.customer_id||'',64));await audit(s,'customer_setup_link_created');return r}
   if(path==='/admin/rewards/import-preview'&&method==='POST')return accounts.previewImport(s,body);
   if(path==='/admin/rewards/reconcile'&&method==='POST'){const r=await accounts.reconcileBatch(s,text(body.batch_id||'',100));await audit(s,'customer_rewards_reconciled');return r}
   // "Your Glow Points moved with you" (Jonah, 1 Nov 2026). Owner only. mode test: one email to test_to. mode send: one personal
   // email to every old-site customer whose carried balance is still unclaimed (never twice: one outbox id per customer).
   // mode dispatch: send whatever is still waiting. Sending happens after this request, within a time budget.
   if(path==='/admin/rewards/points-moved-email'&&method==='POST'){if(!owner||affiliateManager)fail('Owner only.',403);const mode=body.mode,expires=clock()+3*86400;
    if(mode==='test'){const to=text(body.test_to||'',150).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))fail('Enter a test email address.');const pts=int(body.test_points??150,1,10000000);
     const c=pointsMoved.content({first_name:body.test_first_name||'',points:pts,email:body.test_email_shown||to});const id='points-moved-test-'+crypto.randomBytes(6).toString('hex');
     await emails.enqueue(s,{id,kind:'points_moved_test',to,related_id:'test',subject:'[TEST] '+c.subject,content:c,expires,brand:'glow'});bulkJobs.push(id);return{ok:true,mode,queued:1}}
    if(mode==='send'){const names=body.names&&typeof body.names==='object'?body.names:{};const rows=(await s.list('rewards_imports')).filter(r=>!r.claimed&&!r.held&&r.points>0);
     if(body.confirm!=='SEND '+rows.length)fail('Type SEND '+rows.length+' to confirm.');let queued=0;
     for(const r of rows){const a=await s.get('customers',r.id);if(a?.verified)continue;const c=pointsMoved.content({first_name:names[r.email]||'',points:r.points,email:r.email});
      const id='points-moved-'+r.id;if(await s.get('email_outbox',id))continue;await emails.enqueue(s,{id,kind:'points_moved',to:r.email,related_id:r.id,subject:c.subject,content:c,expires,brand:'glow'});bulkJobs.push(id);queued++}
     await audit(s,'points_moved_email_queued',String(queued));return{ok:true,mode,queued}}
    if(mode==='dispatch'){for(const j of await s.list('email_outbox'))if(j.kind==='points_moved'&&['pending','retry'].includes(j.status))bulkJobs.push(j.id);return{ok:true,mode,waiting:bulkJobs.length}}
    if(mode==='status'){const j=(await s.list('email_outbox')).filter(x=>x.kind==='points_moved');const by={};for(const x of j)by[x.status]=(by[x.status]||0)+1;return{ok:true,mode,total:j.length,by_status:by,waiting_to_send:(await s.list('rewards_imports')).filter(r=>!r.claimed&&!r.held&&r.points>0).length}}
    fail('Choose test, send, dispatch or status.')}
   if(path==='/admin/rewards/import'&&method==='POST'){const r=await accounts.importBatch(s,text(body.batch_id||'',100));await audit(s,'customer_rewards_imported');return r}
   if(path==='/admin/rewards/adjust'&&method==='POST'){const id=text(body.customer_id||'',64),a=await s.get('customers',id);if(!a?.verified)fail('Choose a verified customer.');if(!Number.isSafeInteger(body.points)||!body.points||Math.abs(body.points)>1000000)fail('Enter a nonzero whole-point adjustment.');const key=text(body.idempotency_key||'',100),note=text(body.note||'',500);await accounts.event(s,id,'adjust:'+key,'staff_adjustment',body.points,0,null,note);await audit(s,'rewards_adjusted');return{ok:true}}
   if(path==='/admin/data'&&method==='GET'&&affiliateManager)return{brand:brands.publicBrand(reqBrand),role:'affiliate_manager',owner:false,affiliates:(await s.list('affiliates')).filter(a=>nativeAffiliates.brandOf(a)==='glow'&&!nativeAffiliates.isNative(a)).map(a=>({slug:a.slug,name:a.name,bio:a.bio||'',goaffpro_id:a.goaffpro_id||'',active:a.active,management_revision:a.management_revision||0}))};
   if(path==='/admin/data'&&method==='GET'){const all=await (s.listLite?s.listLite('orders'):s.list('orders')),refs={};for(const id of new Set(all.filter(o=>o.referred_by).map(o=>o.referred_by))){const c=await s.get('customers',id);refs[id]=c?{name:c.name||'',email:c.email||''}:null}return{brand:brands.publicBrand(reqBrand),...(reqBrand.id==='zader'?{native_affiliates:await nativeAffiliates.adminData(s)}:{}),owner,staff:(await s.list('staff')).map(staff.publicStaff),products:await s.list('products'),coupons:await s.list('coupons'),affiliates:await s.list('affiliates'),orders:all.sort((a,b)=>b.created-a.created).map(o=>({...publicOrder(o),...(o.referred_by?{referrer:refs[o.referred_by]}:{}),staff_notes:(o.staff_notes||[]).map(({text,author,created})=>({text,author,created})),...(o.stripe_invoice?{stripe_invoice:o.stripe_invoice}:{}),has_account:!!o.customer_id,...(o.call_log?.length?{call_log:o.call_log.map(({key,at,by,outcome,feeling,problems,notes})=>({key,at,by,outcome,feeling,problems,notes}))}:{})})),manual_shipments:(await s.list('manual_shipments')).filter(m=>m.created>clock()-120*86400).sort((a,b)=>b.created-a.created),settings,auto_invoice:autoInvoice.status(settings),email:await emails.adminData(s),goaffpro:goaffpro.status(await s.get('integrations','goaffpro')),shipstation:shipping.status(await s.get('integrations','shipstation')),shippo:shippo.status(await s.get('integrations','shippo')),audit:(await s.get('audit','log')||[]).slice().reverse(),...await(async()=>{const f=await members.adminFlags(s);return f?{skool:f}:{}})()};}
   const r=path.match(/^\/admin\/receipt\/([A-Z0-9-]+)$/);if(r&&method==='GET'){const o=await s.get('orders',r[1]);if(!o?.receipt)fail('Receipt not found.',404);return{_binary:o.receipt,_type:o.receipt_type}}
   if(path==='/admin/product'&&method==='POST'){
    const all=await s.list('products'),id=body.id?int(body.id,1):Math.max(0,...all.map(p=>p.id))+1;const old=body.id?await s.get('products',id):{};if(!old)fail('Product not found.',404);
    const stockPool=text(body.stock_pool??old.stock_pool??'',60,false);if(stockPool&&!validSlug(stockPool))fail('Use a lowercase stock group name with letters, numbers and hyphens.');
    const affectedIds=new Set([id,...all.filter(x=>x.stock_pool&&[old.stock_pool,stockPool].includes(x.stock_pool)).map(x=>x.id)]);if(body.id&&(old.stock_pool||'')!==stockPool&&(await s.list('orders')).some(o=>['order_received','awaiting_payment','payment_submitted'].includes(o.status)&&o.items.some(i=>affectedIds.has(i.id))))fail('Finish or cancel the affected products’ reserved orders before changing the stock group.',409);
    if(body.expected_stock!==undefined&&body.id&&body.stock!==body.expected_stock&&old.stock!==body.expected_stock)fail('Inventory changed while you were editing. Refresh before changing the quantity.',409);
    const p={...old,id,name:text(body.name||'',150),sku:text(body.sku||'',60),price:int(body.price),stock:body.id&&body.expected_stock!==undefined&&body.stock===body.expected_stock?old.stock:int(body.stock),stock_pool:stockPool,active:int(body.active??1,0,1),promo_excluded:int(body.promo_excluded??Number(!!old.promo_excluded),0,1)===1,brand:brands.validId(body.brand??old.brand??'glow')};{/* Skool member perks: members-only bundle flag and early-access time. Owner sign-in only; left out = kept as saved. */const mo=body.members_only===undefined?old.members_only===true:int(body.members_only,0,1)===1,eu=body.members_early_until===undefined?(Number(old.members_early_until)||0):int(body.members_early_until,0,4102444800);if((mo!==(old.members_only===true)||eu!==(Number(old.members_early_until)||0))&&!owner)fail('Only the owner sign-in can change Skool member settings on a product.',403);if(mo)p.members_only=true;else delete p.members_only;if(eu)p.members_early_until=eu;else delete p.members_early_until}{const u=int(body.units??old.units??1,1,100);if(u>1)p.units=u;else delete p.units;if(u!==(old.units||1)&&body.id&&(await s.list('orders')).some(o=>['order_received','awaiting_payment','payment_submitted'].includes(o.status)&&o.items.some(i=>i.id===id)))fail('Finish or cancel this product’s reserved orders before changing how many units it takes.',409)}if(body.components!==undefined){const raw=Array.isArray(body.components)?body.components:String(body.components||'').split(',').map(x=>x.trim()).filter(Boolean);if(raw.length>20)fail('A bundle can hold at most 20 different products.');const comps=[];for(const r of raw){let sku,qty=1,x;if(typeof r==='string'){const m=r.match(/^(.+?)(?:\s+x\s*(\d+)|\s*[×*]\s*(\d+))?$/i);sku=m[1].trim();qty=Number(m[2]||m[3]||1)}else{sku=String(r&&r.sku||'');qty=r&&r.qty;if(r&&r.id)x=all.find(y=>y.id===r.id)}x=x||all.find(y=>y.sku.toLowerCase()===sku.toLowerCase()&&brands.productBrand(y)===p.brand)||all.find(y=>y.sku.toLowerCase()===sku.toLowerCase());if(!x)fail('Bundle contents: no product with SKU '+sku+'.');if(x.id===id)fail('A bundle cannot contain itself.');if(isBundle(x))fail('A bundle cannot contain another bundle.');const n=int(qty,1,20),same=comps.find(c=>c.id===x.id);if(same)same.qty+=n;else comps.push({id:x.id,qty:n})}if(comps.length&&p.units)fail('A bundle takes its stock from the products inside it. Set units per item to 1.');if(comps.length)p.components=comps;else delete p.components}if(all.some(x=>x.id!==id&&x.sku.toLowerCase()===p.sku.toLowerCase()))fail('That SKU already exists.',409);
    if(!body.id&&stockPool){const member=all.find(x=>x.stock_pool===stockPool);if(member)p.stock=member.stock}
    if(/^merch-/i.test(p.sku))p.category='merch';else if(/^cosmetic-/i.test(p.sku))p.category='cosmetic';
    if(body.expected_offer_revision!==undefined&&body.id&&body.expected_offer_revision!==(old.offer_revision||0))fail('Product pricing or spotlight changed while you were editing. Reopen this product before saving.',409);
    Object.assign(p,productOffers.apply(old,body),{offer_revision:(old.offer_revision||0)+1});
    if(body.image_url){const image=text(body.image_url,250);if(!/^\/img\/[a-zA-Z0-9][a-zA-Z0-9_\/-]*\.(?:webp|png|jpe?g)$/.test(image)||image.includes('..'))fail('Use an existing product image path under /img/.');p.image=image;}
    const saved=await catalogPhotos.applyPhotoUpdate(s,p,body.photo_update);
    const group=body.photo_update?.apply_design===true&&p.merch_design?all.filter(x=>x.merch_design===p.merch_design&&x.brand===p.brand&&x.id!==p.id):[];
    if(body.photo_update?.apply_design===true&&!p.merch_design)fail('Choose an existing shirt design before applying photos to all variants.');
    await setStock(s,saved,saved.stock);
    for(const member of group){const current=await s.get('products',member.id);if(!catalogPhotos.eligible(current))continue;await s.put('products',member.id,{...current,image:saved.image,additional_images:saved.additional_images,...(saved.model_color===''?{model_color:''}:{}),photo_revision:(member.photo_revision||0)+1})}
    await audit(s,body.photo_update?'product_photos_saved':'product_saved');return{ok:true,id};
   }
   if(path==='/admin/coupon'&&method==='POST'){
    const code=text(body.code||'',40).toUpperCase(),kind=body.kind;if(!['fixed','percent'].includes(kind))fail('Invalid discount type.');const old=await s.get('coupons',code);if(old&&brands.couponBrand(old)!==brands.validId(body.brand??old.brand??'glow'))fail('This coupon code belongs to another store. Choose a unique code.',409);const owner=text(body.affiliate??old?.affiliate??'',60,false).toLowerCase(),active=int(body.active??1,0,1);if(owner){const a=validSlug(owner)?await s.get('affiliates',owner):null;if(!a||nativeAffiliates.brandOf(a)!==brands.validId(body.brand??old?.brand??'glow')||(!a.goaffpro_id&&!nativeAffiliates.isNative(a))||(active&&!a.active))fail('Choose an active affiliate in this store.');}const products=await couponRules.productsValue(s,body,old,brands.validId(body.brand??old?.brand??'glow'));const c={code,kind,allow_stacking:couponRules.stackingValue(body,old),products,brand:brands.validId(body.brand??old?.brand??'glow'),affiliate:owner||null,value:int(body.value,1,kind==='percent'?100:1000000),minimum:int(body.minimum??0),max_uses:int(body.max_uses??100,1),used:old?.used||0,expires:int(body.expires??0,0,9999999999),active:int(body.active??1,0,1)};await s.put('coupons',code,c);await audit(s,'coupon_saved');return{ok:true};
   }
   if(path==='/admin/affiliate/status'&&method==='POST'){
    const slug=text(body.slug||'',60),a=await s.get('affiliates',slug);if(!a||nativeAffiliates.brandOf(a)!=='glow'||nativeAffiliates.isNative(a))fail('Glow affiliate not found.',404);
    if(body.expected_revision!==(a.management_revision||0))fail('This affiliate changed. Reopen it before saving.',409);
    a.active=int(body.active,0,1);a.management_revision=(a.management_revision||0)+1;
    if(!a.active){delete a.photo_link_hash;delete a.photo_link_expires;}
    await s.put('affiliates',slug,a);await audit(s,a.active?'affiliate_restored':'affiliate_disabled',slug);return{ok:true};
   }
   if(path==='/admin/affiliate'&&method==='POST'){
    const slug=text(body.slug||'',60).toLowerCase();if(!validSlug(slug))fail('Choose a unique lowercase store link.');const old=await s.get('affiliates',slug);if(nativeAffiliates.isNative(old)||reqBrand.id==='zader')fail('Use the Zader affiliate program controls.');if(affiliateManager){if(Object.hasOwn(body,'commission_bps')||body.brand&&body.brand!=='glow')fail('Affiliate Managers cannot change commissions or another store.',403);if(old&&(body.expected_revision!==(old.management_revision||0)))fail('This affiliate changed, or that store link already exists. Reopen it before saving.',409);if(old&&String(body.goaffpro_id||'')!==String(old.goaffpro_id||''))fail('Only full management can change an existing GoAffPro identity.',403);if(!old&&!/^\d{1,20}$/.test(String(body.goaffpro_id||'')))fail('Enter the affiliate’s numeric GoAffPro ID.');}
    const goaffproId=text(body.goaffpro_id||'',100,false);if(goaffproId&&(await s.list('affiliates')).some(a=>a.slug!==slug&&a.goaffpro_id===goaffproId))fail('This GoAffPro affiliate already has a storefront. Edit that storefront instead.',409);const a={...old,slug,name:text(body.name||'',150),bio:text(body.bio||'',500,false),goaffpro_id:goaffproId,commission_bps:affiliateManager?(old?.commission_bps??1500):int(body.commission_bps??1500,0,10000),active:int(body.active??1,0,1),management_revision:(old?.management_revision||0)+1};if(!a.active){delete a.photo_link_hash;delete a.photo_link_expires;}await s.put('affiliates',slug,a);await audit(s,'affiliate_saved');return{ok:true};
   }
   if(path==='/admin/checkout-settings'&&method==='POST'){
    if(!['preview','live'].includes(body.mode)||body.tax_mode!=='none')fail('Choose preview or live checkout and confirm no sales tax.');
    if(body.mode==='live'){
     if(!Object.values(settings.payment_links||{}).some(Boolean))fail('Save at least one payment recipient before enabling live checkout.',409);
     if(!(await s.list('products')).some(p=>p.active&&p.stock>0))fail('Add stock to at least one active product before enabling live checkout.',409);
    }
    settings.demo=body.mode==='preview';settings.checkout_enabled=body.mode==='live';settings.tax_mode='none';settings.tax_note='Sales tax is not charged.';
    await s.put('settings','main',settings);await audit(s,body.mode==='live'?'live_checkout_enabled':'preview_checkout_enabled');return{ok:true};
   }
   if(path==='/admin/rewards-bonuses'&&method==='POST'){if(typeof body.on!=='boolean')fail('Choose on or off.');settings.rewards_bonuses={on:body.on,from:(settings.rewards_bonuses||{}).from||accounts.BONUS_FROM};await s.put('settings','main',settings);await audit(s,body.on?'rewards_bonuses_on':'rewards_bonuses_off');return{ok:true,rewards_bonuses:settings.rewards_bonuses};
   }
   if(path==='/admin/double-points'&&method==='POST'){const t=clock(),dp={windows:((settings.double_points||{}).windows||[]).filter(w=>w.until>t-90*86400)};dp.windows.forEach(w=>{if(w.from<=t&&w.until>t)w.until=t});
    if(body.on!==false){const until=int(body.until,t+600,t+7*86400);dp.windows.push({from:t,until})}settings.double_points=dp;await s.put('settings','main',settings);await audit(s,body.on===false?'double_points_off':'double_points_on');return{ok:true,double_points:dp};
   }
   if(path==='/admin/settings'&&method==='POST'){
    settings.shipping_cents=int(body.shipping_cents);settings.free_shipping_cents=int(body.free_shipping_cents??settings.free_shipping_cents);settings.payment_links=validateLinks(body.payment_links);if(settings.checkout_enabled&&!Object.values(settings.payment_links).some(Boolean))fail('Keep at least one payment recipient while live checkout is enabled.');await s.put('settings','main',settings);await audit(s,'settings_saved');return{ok:true};
   }
 if(path==='/admin/status'&&method==='POST'){
    const o=await s.get('orders',body.id);if(!o)fail('Order not found.',404);const target=body.status;
    if(target==='awaiting_payment'&&o.status==='order_received'){o.status=target;o.invoice_sent_at=clock();o.invoice_sent_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.expires=clock()+7*86400;o.payment_window_days=7;await s.put('orders',o.id,o);await audit(s,'invoice_sent',o.id);return{ok:true}}
    if(target==='canceled'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){await release(s,o,target);emailJob=await emails.queueUpdate(s,o);return{ok:true}}
    if(target==='unpaid'){
     if(o.status!=='paid')fail('Only an order marked Paid · in queue can be set back to not paid.',409);
     if(['stripe_invoice','stripe_autopay','stripe_checkout'].includes(o.payment_verification_source))fail('Stripe confirmed this payment, so it really was paid. If the customer needs money back, refund it in Stripe.',409);
     if(o.shippo_transaction_id||o.shippo_status==='label_bought')fail('A shipping label was already bought for this order. Void the label first, then undo the payment.',409);
     if(body.confirm!==true)fail('Confirm that this order was marked paid by mistake.');
     const by=(await s.get('sessions',sessionId)).staff_id||'owner',was={paid:o.paid,verified_payment_cents:o.verified_payment_cents,source:o.payment_verification_source,by:o.payment_verified_by,packed:o.packed||null};o.packed=null;
     await accounts.unpaid(s,o);
     o.status=o.receipt||o.has_receipt?'payment_submitted':(o.invoice_sent_at||o.stripe_invoice)?'awaiting_payment':'order_received';
     if(o.status==='awaiting_payment'){o.expires=Math.max(o.expires||0,clock()+7*86400);o.payment_window_days=7}
     o.paid=null;o.verified_payment_cents=0;o.balance_due_cents=0;o.refund_due_cents=0;o.payment_verified_by=null;o.payment_verification_source=null;
     if(o.shipstation_order_id){o.shipstation_needs_review=true;o.shipstation_status='needs_review';o.shipstation_message='Payment was undone. Put this order on hold or delete it in ShipStation.'}else o.shipstation_status='not_ready';
     if(o.goaffpro_status==='synced'||o.goaffpro_remote_id){o.goaffpro_needs_review=true;o.goaffpro_status='needs_review';o.goaffpro_message='Payment was undone. Reject or remove this sale in GoAffPro.'}else if(o.goaffpro_status!=='not_applicable')o.goaffpro_status='not_applicable';
     o.payment_undone=[...(o.payment_undone||[]),{at:clock(),by,was}].slice(-10);
     await s.put('orders',o.id,o);await nativeAffiliates.reconcileOrder(s,o);await audit(s,'payment_undone',o.id);
     return{ok:true,status:o.status};
    }
    if(target==='paid'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){if(body.verified!==true)fail('Confirm that the payment was received.');await markPaid(s,o,{by:(await s.get('sessions',sessionId)).staff_id||'owner',source:o.receipt?'screenshot_and_staff':'staff_verified'})}
    else if(target==='shipped'&&o.status==='paid'){if(o.balance_due_cents||o.refund_due_cents)fail('Settle the additional payment or refund before shipping.',409);if(o.shipstation_needs_review&&body.shipping_review!==true)fail('Confirm the updated order was reviewed in ShipStation before shipping.',409);o.shipstation_needs_review=false;o.status='shipped';o.tracking=text(body.tracking||'',150,false);o.shipment=require('./order-tracking.cjs').fromManual(o.tracking);await audit(s,'shipped',o.id)}
    else fail('This status change is not allowed.',409);await s.put('orders',o.id,o);emailJob=await emails.queueUpdate(s,o);return{ok:true,...(o.commission_provider==='native'?{affiliate_program:'native'}:{})};
   }
   if(path==='/admin/integrations'&&method==='GET')return{outbox:await s.list('outbox'),shipstation:shipping.status(await s.get('integrations','shipstation')),shippo:shippo.status(await s.get('integrations','shippo')),goaffpro:goaffpro.status(await s.get('integrations','goaffpro'))};
   if(path==='/admin/goaffpro/preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing affiliate reporting.',409);return{dry_run:true,eligible:reporting.eligible(o),payload:reporting.payload(o),note:o.is_test!==false?'Test order: not sent to GoAffPro.':'Preview only; commission rates are determined by GoAffPro.'}}
   if(path==='/admin/shipment-preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing a shipment.',409);return{dry_run:true,provider:'shipstation',payload:shipping.payload(o,(await s.get('integrations','shipstation'))?.store_id||null),note:'Preview only. No order or postage sent. Review weights and carrier service in ShipStation.'}}
   fail('Endpoint not found.',404);
  }
  fail('Endpoint not found.',404);
 });
 if(emailJob){const delivery=await emails.safeDispatch(emailJob);if(result&&typeof result==='object')result.email=delivery}
 for(const id of new Set(staffJobs))await emails.safeDispatch(id);
 if(bulkJobs.length){const started=Date.now();let sent=0,left=0;for(const id of bulkJobs){if(Date.now()-started>20000){left++;continue}const r=await emails.safeDispatch(id);if(r?.status==='accepted')sent++}if(result&&typeof result==='object'){result.sent=sent;result.left_for_next_dispatch=left}}
 if(invoiceJob){let r;try{r=await autoInvoice.sendFor(invoiceJob)}catch(e){r={status:'failed'}}if(result&&typeof result==='object')result.invoice={status:r.status,via:r.via||null}}
 if(path==='/admin/status'&&method==='POST'&&body.status==='paid'&&result?.ok&&result.affiliate_program!=='native'){try{result.goaffpro=await reporting.report(body.id)}catch{result.goaffpro={status:'failed',message:'Payment is saved. Affiliate reporting needs a later status check.'}}}
 if(path==='/admin/status'&&method==='POST'&&body.status==='paid'&&result?.ok){try{result.shipstation=await shipping.send(body.id)}catch{result.shipstation={status:'failed',message:'Payment saved. Check Shipping for transfer status.'}}}
 return{status:result?._status||(method==='POST'&&path==='/orders'?201:200),headers:setCookie?{'Set-Cookie':setCookie}:{},body:result?._error?{error:result._error}:result};
}
// Stripe webhook: Stripe says an invoice is paid. Re-checked with Stripe's API inside autoInvoice.paidFromStripe, then
// marked paid exactly like the staff button (points, referral, shipping queue, affiliate report, customer email).
async function stripeInvoicePaid(invoiceId){const r=await autoInvoice.paidFromStripe(invoiceId,async(s,o,opts)=>{await markPaid(s,o,opts);await s.put('orders',o.id,o);return emails.queueUpdate(s,o)});
 if(r.status==='paid'){if(r.job){try{await emails.safeDispatch(r.job)}catch{}}const o=await transaction(s=>s.get('orders',r.order_id));
  if(o?.affiliate&&o.commission_provider!=='native'){try{await reporting.report(o.id)}catch{}}try{await shipping.send(o.id)}catch{}delete r.job}
 if(r.status==='review'&&r.order_id){try{await transaction(async s=>{const o=await s.get('orders',r.order_id);if(o)return emails.queueStaffAlert(s,o)}).then(ids=>Promise.all((ids||[]).map(emails.safeDispatch)))}catch{}} // send staff alerts now: Sevalla has no email worker
 return r}
// Subscribe & save tier pricing (Jonah, 5 Nov 2026). Prices one delivery with the tier engine in subscriptions.cjs.
// stockCheck (default): runs the normal quote too, so stock, active products and the brand are checked like any order,
// and returns `order`: the quote with the subscription price applied (discount, shipping, total, points kept consistent).
// Never more than 85% of list for the products; points use max(tier multiplier, the customer's normal multiplier).
async function subscriptionQuote(s,{items,h={},brand,deliveryNumber=1,bonus_id,streak,stockCheck=true,member_email,extras=[]}){
 const subs=require('./subscriptions.cjs'),settings=await s.get('settings','main');
 if(!Array.isArray(items)||!items.length||items.length>100)fail('Add at least one product.');
 const lines=items.map(i=>({id:int(i.id,1),quantity:int(i.quantity,1,100)})),m=new Map();
 for(const l of lines){if(m.has(l.id))fail('Duplicate product in the cart.');const p=await s.get('products',l.id);if(!p||!p.active||brands.productBrand(p)!==brand.id)fail('A product is unavailable.');m.set(p.id,p)}
 if(bonus_id&&!m.has(Number(bonus_id))){const bp=await s.get('products',Number(bonus_id));if(bp&&bp.active&&brands.productBrand(bp)===brand.id)m.set(bp.id,bp)}
 let r=subs.priceFor(lines,m,null,deliveryNumber,{bonus_id,settings,streak});if(!r.ok)return r;
 if(!stockCheck)return{...r,points_to_earn:brand.rewards?Math.floor(Math.floor(r.price_cents/100)*r.points_multiplier):0};
 // Add-ons for this package (one-time extras at subscriber price; they never change the tier or shipping).
 const ex=[];for(const e of (Array.isArray(extras)?extras:[]).slice(0,10)){const id=Number(e?.id),qty=Math.floor(Number(e?.quantity)||0);if(!Number.isInteger(id)||qty<1)continue;const p=m.get(id)||await s.get('products',id);if(!p||!p.active||brands.productBrand(p)!==brand.id)fail('An add-on is unavailable.',409);m.set(p.id,p);ex.push({id,quantity:Math.min(qty,5)})}
 const xa=subs.addonsPrice(ex,m),merge=ls=>{const out=new Map();for(const l of [...ls,...ex])out.set(l.id,(out.get(l.id)||0)+l.quantity);return [...out].map(([id,quantity])=>({id,quantity}))};
 const mo={subscription:true,...(member_email?{member_email}:{})};let q;try{q=await quote(s,{items:merge(r.lines)},h,brand,mo)}catch(e){if(!r.bonus)throw e;r=subs.priceFor(lines,m,null,deliveryNumber,{settings,no_bonus:true});q=await quote(s,{items:merge(r.lines)},h,brand,mo)}
 if(q.subtotal!==r.list_cents+xa.list_cents)fail('Prices changed. Refresh and try again.',409);
 const normal=q.points_multiplier||(brand.rewards?1:0),mult=brand.rewards?Math.max(r.points_multiplier,normal):0;
 q.subscription_discount=q.subtotal-(r.price_cents+xa.price_cents);q.discount=q.subscription_discount;q.coupon_discount=0;q.rewards_discount=0;q.points_redeemed=0;q.shipping=r.shipping_cents;q.total=q.subtotal-q.discount+q.shipping;
 q.points_multiplier=mult;q.points_to_earn=brand.rewards?Math.floor(Math.floor((q.subtotal-q.discount)/100)*mult):0;q.commission=0;
 return{...r,addons:xa.lines,addons_cents:xa.price_cents,normal_points_multiplier:normal,points_multiplier:mult,points_to_earn:q.points_to_earn,items:q.items,order:q}}
function subscriptionFields(r,n){return{subscription_tier:r.tier.id,subscription_points_multiplier:r.tier.points_multiplier,subscription_delivery:n,subscription_bonus:r.bonus||null,subscription_perks:{early_access:r.tier.early_access,packed_first:r.tier.packed_first}}}
// Builds one repeat order for a subscription (stock reserved, staff alert; auto-pay: charged by subscriptions.charge).
// Price: the tier price for its items (see subscriptionQuote). An older staff-started subscription too big for any tier
// (over 8 slots) keeps the old rule: 15% off products. One order per subscription per ship date, ever (idempotency key).
async function subscriptionOrder(s,sub,cycle){
 const key='sub-'+sub.id+'-'+cycle,done=await s.get('idempotency',key);if(done)return{existing:done.id};
 const settings=await s.get('settings','main');if(!(settings&&settings.demo===false&&settings.checkout_enabled===true&&settings.tax_mode==='none'))fail('Live checkout is off, so no repeat order was made.',503);
 const subs=require('./subscriptions.cjs'),brand=brands.get(sub.brand||'glow'),customer=checkoutCustomer(sub.customer),n=subs.deliveriesDone(sub)+1,lines=sub.items.map(i=>({id:i.id,quantity:i.quantity}));
 // Add-ons ride along; if one cannot be filled (sold out, turned off) the package still goes out without it.
 const base={items:lines,h:{},brand,deliveryNumber:n,bonus_id:sub.bonus_id,streak:(Number(sub.t5_run)||0)+1,member_email:sub.customer?.email};let sq,dropped='';
 if((sub.addons||[]).length){try{sq=await subscriptionQuote(s,{...base,extras:sub.addons})}catch(e){dropped=String(e&&e.message||e).slice(0,160);sq=null}}
 if(!sq)sq=await subscriptionQuote(s,base);let q,extra;
 if(sq.ok){q=sq.order;extra=subscriptionFields(sq,n)}
 else if(sq.slots>subs.MAX_SLOTS){q=await quote(s,{items:lines},{},brand,{subscription:true,...(sub.customer?.email?{member_email:sub.customer.email}:{})});const pct=Math.min(50,Math.max(0,Number(sub.discount_pct)||15)),off=Math.round((q.subtotal-q.discount)*pct/100);q.discount+=off;q.subscription_discount=off;q.total=q.subtotal-q.discount+q.shipping;if(q.points_to_earn)q.points_to_earn=Math.floor(Math.floor((q.subtotal-q.discount)/100)*(q.points_multiplier||1));extra={subscription_tier:null,subscription_delivery:n}}
 else fail(sq.error||'This subscription could not be priced.',409);
 const autopay=sub.pay==='autopay',inv=!autopay&&autoInvoice.invoiced('card_invoice',settings),id=brand.order_prefix+'-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url');
 const o={id,created:clock(),expires:null,status:'order_received',customer,...q,payment_method:autopay?'card_autopay':'card_invoice',token_hash:hash(token),idempotency_key:key,request_hash:hash(key),checkout_stage:'submitted',proof_required:false,submitted_at:clock(),...(autopay?{autopay:{status:'charging',started:clock()}}:{invoice_via:'email'}),receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:'not_applicable',subscription_id:sub.id,subscription_discount:q.subscription_discount,subscription_cycle:cycle,ship_date:cycle,order_for_customer:true,created_by_staff:'subscription',...extra};
 // Ship together (Jonah, 8 Nov 2026): another subscription package for the same person at the same door on the same ship
 // date goes in the same box, so only the first one pays shipping. The customer can only ever pay less this way.
 {const subs=require('./subscriptions.cjs'),sib=(await s.list('orders')).find(x=>x.subscription_id&&x.subscription_id!==sub.id&&x.ship_date===cycle&&x.is_test===false&&!['canceled','expired'].includes(x.status)&&subs.sameDoor(x.customer,customer));
  if(sib){o.ships_with=sib.id;if(o.shipping>0){o.shipping_combined=o.shipping;o.total-=o.shipping;o.shipping=0}if(!sib.ships_with){sib.ships_with=o.id;await s.put('orders',sib.id,sib)}}}
 delete o.points_multiplier;o.goaffpro_affiliate_id=null;o.is_test=false;if((sub.addons||[]).length){o.subscription_addons=dropped?[]:sub.addons.map(a=>({id:a.id,quantity:a.quantity,name:a.name||''}));if(dropped)o.addons_dropped=dropped}const beneficiary=await s.get('customers',accounts.hash(accounts.email(customer.email)));o.customer_id=beneficiary?.verified&&brand.rewards?beneficiary.id:null;o.points_earned=0;
 for(const item of q.items)await moveStock(s,item,-1);
 await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created_subscription_order',id);
 // Auto-pay: no order email yet; the customer gets the payment-received email once the card is charged.
 const jobs=[...(autopay?[]:[await emails.queueOrder(s,o,token)]),...await emails.queueStaffAlert(s,o)].filter(Boolean);
 return{order:o,jobs,invoice:!autopay&&autoInvoice.eligible(o,settings)?o.id:null,invoiced:inv,autopay};
}
// The customer's first box (bag → Subscribe & save). Made with the subscription in one transaction; it waits for the
// Stripe Checkout payment. Coupons, points and affiliate credit do not apply to subscription pricing.
async function subscriptionFirstOrder(s,{account,customer:input,items,every,brand,h}){
 const settings=await s.get('settings','main'),customer=checkoutCustomer(input);if(accounts.email(customer.email)!==account.email)fail('Use your account email for this order.');
 const sq=await subscriptionQuote(s,{items,h,brand,deliveryNumber:1});if(!sq.ok)fail(sq.error,409);
 const q=sq.order,subId='SUB-'+crypto.randomBytes(4).toString('hex').toUpperCase(),id=brand.order_prefix+'-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url'),key='subscribe-first-'+subId;
 const o={id,created:clock(),expires:null,status:'order_received',customer,...q,payment_method:'card_checkout',token_hash:hash(token),idempotency_key:key,request_hash:hash(key),checkout_stage:'submitted',proof_required:false,submitted_at:clock(),receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:'not_applicable',subscription_id:subId,subscription_discount:q.subscription_discount,subscription_first:true,...subscriptionFields(sq,1)};
 delete o.points_multiplier;o.goaffpro_affiliate_id=null;o.affiliate=null;o.is_test=settings.demo!==false;o.customer_id=account.verified&&brand.rewards?account.id:null;o.points_earned=0;
 for(const item of q.items)await moveStock(s,item,-1);
 await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created_subscription_first_order',id);
 const sub={id:subId,brand:brand.id,status:'pending_first_payment',pay:'autopay',source:'customer',every,tier:sq.tier.id,customer:{name:customer.name,email:customer.email,phone:customer.phone||'',address:customer.address,address2:'',city:customer.city,state:customer.state,zip:customer.zip},customer_id:account.id,
  items:q.items.map(i=>({id:i.id,quantity:i.quantity,name:i.name})),first_order:id,source_order:id,orders:[],deliveries:0,created:clock(),created_by:'customer'};
 await s.put('subscriptions',subId,sub);return{sub,order:o,token}}
// Stripe Checkout confirmed the first box was paid (checked by subscriptions.settleFirst). Same as a paid Stripe invoice.
async function subscriptionCheckoutPaid(s,o,pi,sess){o.payment_reference=pi.id;o.stripe_checkout={session:sess.id,payment_intent:pi.id,amount:sess.amount_total,paid_at:clock()};await markPaid(s,o,{by:'stripe_checkout',source:'stripe_checkout'});await s.put('orders',o.id,o);return[await emails.queueUpdate(s,o),...await emails.queueStaffAlert(s,o)].filter(Boolean)}
// An unfinished first-box checkout: items go back into stock.
async function subscriptionRelease(s,o,status){return release(s,o,status)}
// Subscribe & save auto-pay: the saved card was charged in Stripe for exactly this order. Marks it paid the same way a paid Stripe invoice does.
async function subscriptionChargePaid(s,o,pi){o.payment_reference=pi.id;o.autopay={...(o.autopay||{}),status:'paid',payment_intent:pi.id,amount:pi.amount_received,paid_at:clock()};await markPaid(s,o,{by:'stripe_autopay',source:'stripe_autopay'});await s.put('orders',o.id,o);return emails.queueUpdate(s,o)}
module.exports={handle,quote,shipmentPayload,publicOrder,stripeInvoicePaid,reminderToken,checkoutCustomer,subscriptionOrder,subscriptionChargePaid,subscriptionQuote,subscriptionFirstOrder,subscriptionCheckoutPaid,subscriptionRelease};












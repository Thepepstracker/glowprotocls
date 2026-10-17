'use strict';
const crypto=require('node:crypto');const {transaction}=require('./store-db.cjs');
const goaffpro=require('./goaffpro.cjs');
const {validSlug,createStorefronts,resolveReferral}=require('./storefronts.cjs');
const photos=require('./affiliate-photos.cjs');
const receipts=require('./payment-receipts.cjs');
const reporting=require('./goaffpro-orders.cjs');
const shipping=require('./shipstation.cjs'),shippo=require('./shippo.cjs');
const accounts=require('./customer-accounts.cjs');
const adjustments=require('./order-adjustments.cjs');
const emails=require('./store-email.cjs');
const staff=require('./staff-accounts.cjs');
const catalogPhotos=require('./catalog-photo-upload.cjs');
const couponRules=require('./coupon-rules.cjs');
const businessReports=require('./business-reports.cjs');
const {ensureMerchCatalog}=require('./merch-catalog.cjs');
const {withProductPhotos}=require('./product-photos.cjs');const brands=require('./brands.cjs');
const photoUrl=slug=>'/.netlify/functions/store-next?route='+encodeURIComponent('/storefronts/'+slug+'/photo');
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
const publicOrder=o=>{const {token_hash,receipt,idempotency_key,request_hash,goaffpro_affiliate_id,customer_id,created_by_staff,payment_verified_by,invoice_sent_by,restored_by,adjustments:adjustmentHistory,payment_adjustments,...rest}=o;return{...rest,has_receipt:!!receipt,commission_status:['paid','shipped'].includes(o.status)&&!o.balance_due_cents&&!o.refund_due_cents&&!o.goaffpro_needs_review?'eligible':'not_eligible'}};
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
async function release(s,o,status){await accounts.release(s,o);for(const line of o.items)await moveStock(s,line,1);await couponRules.reserve(s,o,-1);o.status=status;await s.put('orders',o.id,o);await audit(s,status,o.id)}
async function expire(s){for(const o of await s.list('orders')){if(o.proof_required===true&&o.checkout_stage==='draft'&&o.status==='order_received'&&!o.receipt&&o.expires&&o.expires<=clock()){await release(s,o,'expired');continue}if(o.status==='awaiting_payment'){if(o.payment_window_days!==7){o.expires=Math.max(o.expires||0,(o.invoice_sent_at||o.created)+7*86400);o.payment_window_days=7;await s.put('orders',o.id,o)}if(o.expires<=clock())await release(s,o,'expired')}}}
async function quote(s,b,h={},brand=brands.fromHeaders(h)){
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add at least one product.');const seen=new Set(),poolQuantities=new Map(),items=[];let subtotal=0;
 for(const line of b.items){const id=int(line.id,1),quantity=int(line.quantity,1,100);if(seen.has(id))fail('Duplicate product in the cart.');seen.add(id);const p=await s.get('products',id);if(!p||!p.active||brands.productBrand(p)!==brand.id)fail('A product is unavailable.');const u=units(p);let draws=null;if(isBundle(p)){draws=[];const need=new Map();for(const c of p.components){const x=await s.get('products',c.id);if(!x)fail('A product is unavailable.');const key=x.stock_pool?'pool:'+x.stock_pool:'product:'+x.id;const g=need.get(key)||{stock:x.stock,per:0};g.per+=c.qty;need.set(key,g);draws.push({id:x.id,qty:c.qty})}const fits=k=>[...need].every(([key,g])=>(poolQuantities.get(key)||0)+k*g.per<=g.stock);if(!fits(quantity)){let k=quantity-1;while(k>0&&!fits(k))k--;fail(`Only ${k} of ${p.name} available.`,409)}for(const [key,g] of need)poolQuantities.set(key,(poolQuantities.get(key)||0)+quantity*g.per)}else{const stockKey=p.stock_pool?'pool:'+p.stock_pool:'product:'+id;const combined=(poolQuantities.get(stockKey)||0)+quantity*u;poolQuantities.set(stockKey,combined);if(combined>p.stock)fail(`Only ${Math.floor(p.stock/u)} of ${p.name} available.`,409)}const amount=p.price*quantity;subtotal+=amount;items.push({id,name:p.name,sku:p.sku,quantity,price:p.price,amount,promo_excluded:!!p.promo_excluded,...(u>1?{units:u}:{}),...(draws?{draws}:{})})}
 const coupon_eligible_subtotal=items.reduce((n,i)=>n+(i.promo_excluded?0:i.amount),0),coupon_excluded_subtotal=subtotal-coupon_eligible_subtotal;const appliedCoupons=await couponRules.apply(s,b,brand,subtotal,coupon_eligible_subtotal,clock());const code=appliedCoupons.coupon,couponAffiliate=appliedCoupons.coupon_affiliate;let discount=appliedCoupons.coupon_discount;
 if(!brand.affiliates&&!couponAffiliate&&b.affiliate)fail('Affiliate storefront is unavailable.');if(!brand.rewards&&b.points_redeemed)fail('Rewards points are not available in this store.');const slug=couponAffiliate||text(b.affiliate||'',60,false).toLowerCase();const affiliate=slug?await s.get('affiliates',slug):null;if(slug&&(!affiliate||!affiliate.active||(couponAffiliate&&!affiliate.goaffpro_id)))fail(couponAffiliate?'This affiliate coupon is unavailable.':'Affiliate storefront is unavailable.');
 const settings=await s.get('settings','main'),a=await accounts.session(s,h);const requested=int(b.points_redeemed??0,0,10000000),coupon_discount=discount;let rewards_discount=0;
 if(requested){if(settings.demo!==false)fail('Test orders do not spend real rewards points.');if(!a)fail('Sign in to use rewards points.',401);const w=await accounts.wallet(s,a.id);if(requested>Math.max(0,w.balance-w.reserved))fail('You do not have enough available points.',409);if(requested>Math.floor((subtotal-discount)/5))fail('Points cannot exceed the remaining product amount.');rewards_discount=requested*5;discount+=rewards_discount}
 const shipping=settings.free_shipping_cents>0&&subtotal-discount>=settings.free_shipping_cents?0:settings.shipping_cents;
 return{items,subtotal,discount,coupon_discount,coupon_eligible_subtotal,coupon_excluded_subtotal,rewards_discount,points_redeemed:requested,points_to_earn:brand.rewards?Math.floor((subtotal-discount)/100):0,brand:brand.id,shipping,tax:0,total:subtotal-discount+shipping,coupon:code||null,coupons:appliedCoupons.coupons,coupon_discounts:appliedCoupons.coupon_discounts,affiliate:slug||null,affiliate_name:affiliate?.name||null,affiliate_source:couponAffiliate?'coupon':(slug?'storefront':null),commission:affiliate?Math.floor((subtotal-discount)*affiliate.commission_bps/10000):0,tax_note:settings.tax_note}

}
function reminderToken(o){const expires=clock()+7*86400;return 'r_'+expires+'_'+sign('payment-reminder:'+o.id+':'+o.token_hash+':'+expires)}
function validReminderToken(o,token){const m=String(token||'').match(/^r_(\d{10})_([A-Za-z0-9_-]{43})$/);return !!m&&Number(m[1])>clock()&&equal(m[2],sign('payment-reminder:'+o.id+':'+o.token_hash+':'+m[1]))}
async function orderAuth(s,id,headers){const o=await s.get('orders',id),a=await accounts.session(s,headers);if(!o||(!equal(o.token_hash,hash(headers['x-order-token']||''))&&!validReminderToken(o,headers['x-order-token'])&&!(a&&o.customer_id===a.id)))fail('Order access denied.',404);return o}
function validateLinks(links){if(!links||typeof links!=='object'||Array.isArray(links))fail('Invalid payment settings.');const out={};for(const[k,domains]of Object.entries({venmo:['venmo.com','www.venmo.com','account.venmo.com'],paypal:['paypal.com','www.paypal.com','paypal.me','www.paypal.me'],cashapp:['cash.app'],zelle:[]})){const v=text(links[k]||'',300,false);if(v&&k!=='zelle'){let u;try{u=new URL(v)}catch{fail('Enter an official HTTPS '+k+' link.')}if(u.protocol!=='https:'||!domains.includes(u.hostname)||u.username||u.password)fail('Enter an official HTTPS '+k+' link.')}out[k]=v}return out}
function shipmentPayload(o){return shipping.payload(o,null)}
function editable(o){if(!['order_received','awaiting_payment'].includes(o.status)||o.has_receipt||o.receipt)fail('This order has been submitted or closed. Contact the store to change it.',409)}
function draftStore(s,o){const reserved=new Map();for(const line of o.items){reserved.set(line.id,(reserved.get(line.id)||0)+line.quantity*lineUnits(line))}return{...s,get:async(kind,key)=>{const r=await s.get(kind,key);if(!r)return r;if(kind==='products'){let qty=reserved.get(r.id)||0;if(r.stock_pool){qty=o.items.reduce((n,line)=>n+(line.stock_pool===r.stock_pool?line.quantity*lineUnits(line):0),0)}return{...r,stock:r.stock+qty}}if(kind==='coupons'&&couponRules.codes(o).includes(key))return{...r,used:Math.max(0,r.used-1)};if(kind==='rewards_wallets'&&key===o.customer_id&&o.is_test===false)return{...r,reserved:Math.max(0,r.reserved-(o.points_redeemed||0))};return r}}}
async function editStore(s,o){const copy={...o,items:[]};for(const line of o.items)for(const d of lineDraws(line)){const p=await s.get('products',d.id);copy.items.push({id:d.id,quantity:line.quantity,units:d.qty,stock_pool:p?.stock_pool})}return draftStore(s,copy)}
async function handle({path,method='GET',headers={},body={}}){
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));let setCookie,emailJob;
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
 const accountAuth=await accounts.authRoute(path,body,h,method);if(accountAuth)return accountAuth;
 if(path==='/admin/email/retry'&&method==='POST'){
  const id=text(body.id||'',200);await transaction(async s=>{await session(s,h);const j=await s.get('email_outbox',id);if(!j)fail('Email not found.',404);if(j.status==='rejected')await emails.prepareRetry(s,j)});
  return{status:200,headers:{},body:await emails.dispatch(id)};
 }
 if(path==='/admin/order/replacement-items'&&method==='POST'){const result=await transaction(async s=>{await session(s,h);const id=text(body.id||'',50),n=int(body.n);const o=await s.get('orders',id);if(!o)fail('Order not found.',404);const r=(o.replacements||[]).find(x=>x.n===n);if(!r)fail('Replacement not found.',404);if(!Array.isArray(body.items)||!body.items.length||body.items.length>20)fail('List what goes in the replacement box.');
  const lines=[];for(const it of body.items){const p=await s.get('products',int(it.id));const q=int(it.quantity);if(!p)fail('Product not found.');if(!(q>=1&&q<=20))fail('Quantity must be 1 to 20.');lines.push({id:p.id,name:p.name,quantity:q,units:Number.isInteger(p.units)?p.units:1,...(isBundle(p)?{draws:p.components.map(c=>({id:c.id,qty:c.qty}))}:{})})}
  for(const l of (r.items||[]))if(r.stock_taken)await moveStock(s,l,1);
  for(const l of lines){for(const d of lineDraws(l)){const p=await s.get('products',d.id);if(!p||p.stock<l.quantity*d.qty)fail('Not enough stock for '+(p?p.name:'a product')+' ('+(p?p.stock:0)+' left).',409)}await moveStock(s,l,-1)}
  r.items=lines;r.stock_taken=true;await s.put('orders',id,o);await audit(s,'replacement_items',id);return{ok:true,items:lines.map(l=>({id:l.id,name:l.name,quantity:l.quantity}))}});return{status:200,headers:{},body:result}}
 if(path==='/admin/shippo/replacement'&&method==='POST'){await transaction(s=>session(s,h));const id=text(body.id||'',50);const result=await shippo.replacement(id,{note:body.note,key:body.key});await transaction(s=>audit(s,'shippo_replacement',id));return{status:200,headers:{},body:result}}
 if(path==='/admin/shippo/dryrun'&&method==='POST'){await transaction(s=>session(s,h));const result=await shippo.dryRun();await transaction(s=>audit(s,'shippo_dry_run'));return{status:200,headers:{},body:result}}
 if(['/admin/shippo/check','/admin/shippo/buy','/admin/shippo/retry'].includes(path)&&method==='POST'){
  await transaction(s=>session(s,h));let result;
  if(path.endsWith('/check')){const checked=await shippo.check();await transaction(async s=>{const old=await s.get('integrations','shippo');const keep=old?.fingerprint===checked.fingerprint;await s.put('integrations','shippo',{...old,...checked,enabled:keep&&old?.enabled===true,carrier_account:checked.accounts.some(a=>a.id===old?.carrier_account)?old.carrier_account:(checked.accounts[0]?.id||'')});await audit(s,'shippo_checked')});result={ok:true,accounts:checked.accounts};}
  else{const id=text(body.id||'',50);result=path.endsWith('/retry')?await shippo.retry(id):await shippo.buy(id);await transaction(s=>audit(s,'shippo_'+(path.endsWith('/retry')?'retry':'buy'),id))}
  return{status:200,headers:{},body:result};
 }
 if(['/admin/shipstation/check','/admin/shipstation/send','/admin/shipstation/tracking'].includes(path)&&method==='POST'){
  await transaction(s=>session(s,h));let result;
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
 const result=await transaction(async s=>{
  const settings=await s.get('settings','main');if(!settings)fail('Store data has not been initialized.',503);if(settings.demo===false&&settings.payment_links?.zelle==='9742418176'&&!await s.get('migrations','zelle-recipient-20261007')){settings.payment_links.zelle='943-241-8176';settings.zelle_recipient_name='Heather Zader';await s.put('settings','main',settings);await s.put('migrations','zelle-recipient-20261007',{applied:clock()});await audit(s,'zelle_recipient_corrected');}if(settings.demo===false&&String(settings.payment_links?.zelle||'').replace(/\D/g,'')==='9432418176'&&!settings.zelle_recipient_name){settings.zelle_recipient_name='Heather Zader';await s.put('settings','main',settings);}await expire(s);
  if(!await s.get('migrations','nad-promo-excluded-20261014')){const nad=await s.get('products',7);if(nad&&nad.sku==='nad-500-mg'&&brands.productBrand(nad)==='glow'){nad.promo_excluded=true;await s.put('products',nad.id,nad);await s.put('migrations','nad-promo-excluded-20261014',{applied:clock(),product_id:nad.id});await audit(s,'nad_promo_exclusion_enabled');}}
  if(reqBrand.id==='zader')await brands.ensureZaderCatalog(s,validSlug);
  await ensureMerchCatalog(s);
  if(path==='/catalog'&&method==='GET')return{products:await (async()=>{const all=await s.list('products'),byId=new Map(all.map(x=>[x.id,x])),out=[];for(const p of all.filter(p=>p.active&&brands.productBrand(p)===reqBrand.id))out.push(brands.publicProduct(withProductPhotos(await bundleStock(async id=>byId.get(id),p)),settings.demo===false));return out})(),brand:brands.publicBrand(reqBrand),settings:{...settings,email_enabled:emails.configuration().ready,...(reqBrand.waitlist?{checkout_enabled:false,waitlist:true}:{})}};
  const referral=path.match(/^\/referrals\/([^/]+)$/);
  if(referral&&method==='GET'){let code;try{code=decodeURIComponent(referral[1])}catch{fail('Affiliate referral is unavailable.',404)}const a=await resolveReferral(s,code);if(!a)fail('Affiliate referral is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const storefront=path.match(/^\/storefronts\/([a-z0-9-]+)$/);
  if(storefront&&method==='GET'){const a=validSlug(storefront[1])?await s.get('affiliates',storefront[1]):null;if(!a?.active)fail('Affiliate storefront is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const publicPhoto=path.match(/^\/storefronts\/([a-z0-9-]+)\/photo$/);
  if(publicPhoto&&method==='GET'){const a=await s.get('affiliates',publicPhoto[1]),image=await s.get('affiliate_photos',publicPhoto[1]);if(!a?.active||!image)fail('Photo not found.',404);return{_binary:image.data,_type:'image/jpeg'}}
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
   if(a&&accounts.email(customer.email)!==a.email)fail('Use your account email for this order.');
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle'].includes(payment))fail('Choose a payment method.');if(settings.demo===false&&!settings.payment_links[payment])fail('This payment method is not available.');
   const id=reqBrand.order_prefix+'-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url');const o={id,created:clock(),expires:null,status:'order_received',customer,...q,payment_method:payment,token_hash:hash(token),idempotency_key:key,request_hash:hash(JSON.stringify(body)),checkout_stage:'draft',proof_required:!assisted,submitted_at:null,receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:q.affiliate?'awaiting_payment':'not_applicable'};
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;
   const beneficiary=assisted?await s.get('customers',accounts.hash(accounts.email(customer.email))):a;
   o.is_test=settings.demo!==false;o.customer_id=beneficiary?.verified&&reqBrand.rewards?beneficiary.id:null;if(assisted){const actor=await s.get('sessions',staffSession);o.created_by_staff=actor.staff_id||'owner';o.order_for_customer=true}o.points_earned=0;if(o.proof_required){o.expires=clock()+7*86400;o.payment_window_days=7}await accounts.reserve(s,o);
   for(const item of q.items)await moveStock(s,item,-1);await couponRules.reserve(s,q,1);
   await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created',id);emailJob=await emails.queueOrder(s,o,token);return{order:publicOrder(o),token};
  }
  const edit=path.match(/^\/orders\/([A-Z0-9-]+)\/(edit-context|edit-quote|edit)$/);
  if(edit){const o=await orderAuth(s,edit[1],h);editable(o);const available=await editStore(s,o);
   if(edit[2]==='edit-context'&&method==='GET'){const products=[];for(const p of await s.list('products'))if(p.active&&brands.productBrand(p)===brands.orderBrand(o).id)products.push(brands.publicProduct(withProductPhotos(await bundleStock(id=>available.get('products',id),await available.get('products',p.id))),settings.demo===false));return{products,settings:{...settings,email_enabled:emails.configuration().ready},order:publicOrder(o)}}
   if(method!=='POST')fail('Method not allowed.',405);
   if(body.points_redeemed&&o.order_for_customer)fail('Customer rewards cannot be redeemed from a staff login.');
   const q=await quote(available,body,o.order_for_customer?{}:h,brands.orderBrand(o));
   if(edit[2]==='edit-quote')return q;
   if(body.not_paid!==true)fail('Confirm you have not paid before changing this draft.');
   if(body.expected_revision!==(o.revision||0))fail('This checkout changed in another tab. Reopen your order before editing.',409);
   const customer=checkoutCustomer(body.customer);if(accounts.email(customer.email)!==accounts.email(o.customer.email))fail('Keep the same order email while editing. Contact the store to change it.');
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle'].includes(payment)||settings.demo===false&&!settings.payment_links[payment])fail('Choose an available payment method.');
   if(q.points_redeemed){const a=await accounts.session(s,h);if(!a||a.id!==o.customer_id)fail('Sign in to the original customer account to use its rewards.',401)}
   const revision=(o.revision||0)+1;await release(s,o,o.status);Object.assign(o,q,{customer,payment_method:payment,revision,reservation_version:revision,updated:clock()});
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;await accounts.reserve(s,o);
   for(const line of o.items)await moveStock(s,line,-1);await couponRules.reserve(s,o,1);await s.put('orders',o.id,o);await audit(s,'checkout_edited',o.id);
   if(o.is_test===false)emailJob=await emails.enqueue(s,{id:'draft-edit-'+o.id+'-'+revision,kind:'checkout_updated',brand:o.brand,to:o.customer.email,related_id:o.id,subject:'Updated '+brands.orderBrand(o).name+' checkout '+o.id,content:emails.template('Your checkout has been updated.',['Order: '+o.id,'Your latest total is $'+(o.total/100).toFixed(2)+'. Use this amount instead of earlier checkout emails.','Your existing private order link shows the latest items, status and shipping address. After paying, upload your screenshot for staff verification.'],null,null,brands.orderBrand(o))});return{order:publicOrder(o)};
  }
  const m=path.match(/^\/orders\/([A-Z0-9-]+)(\/receipt)?$/);if(m){const o=await orderAuth(s,m[1],h);if(method==='GET'&&!m[2])return publicOrder(o);if(method==='POST'&&m[2]){
   if(!['order_received','awaiting_payment','payment_submitted'].includes(o.status))fail('This order no longer accepts receipts.',409);
   if((o.revision||0)>0&&body.expected_revision!==o.revision)fail('This checkout changed. Refresh your order and check the latest total before submitting payment proof.',409);
   if(!o.customer.phone)o.customer.phone=contactPhone(body.phone);
   const method=text(body.payment_method??o.payment_method,20);if(!['venmo','paypal','cashapp','zelle'].includes(method)||o.is_test===false&&!settings.payment_links?.[method])fail('Choose an available payment method.');const reference=text(body.reference||'',100,false);o.payment_method=method;o.receipt=receiptImage.data;o.receipt_type=receiptImage.mime;o.payment_reference=reference;o.status='payment_submitted';o.checkout_stage='submitted';o.submitted_at=o.submitted_at||clock();emailJob=await emails.queueSubmitted(s,o);await s.put('orders',o.id,o);await audit(s,'receipt_submitted',o.id);return publicOrder(o);
  }fail('Endpoint not found.',404)}
  if(path==='/admin/login'&&method==='POST'){
   if(!process.env.STORE_ADMIN_PASSWORD||process.env.STORE_ADMIN_PASSWORD.length<12)fail('Admin password is not configured.',503);
   const ip=hash(h['x-nf-client-connection-ip']||h['x-forwarded-for']||'local'),attempt=await s.get('login_attempts',ip)||{count:0,until:0};
   if(attempt.until>clock()&&attempt.count>=5)return{_error:'Too many login attempts. Wait 15 minutes.',_status:429};
   if(!equal(hash(String(body.password||'')),hash(process.env.STORE_ADMIN_PASSWORD))){const next=attempt.until>clock()?{count:attempt.count+1,until:attempt.until}:{count:1,until:clock()+900};await s.put('login_attempts',ip,next);return{_error:'Incorrect password.',_status:401}}
   await s.remove('login_attempts',ip);const core=(clock()+28800)+'.'+crypto.randomBytes(16).toString('hex');const token=core+'.'+sign(core);
   await s.put('sessions',core.split('.')[1],{expires:clock()+28800});setCookie=`glow_next_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.STORE_LOCAL?'':'; Secure'}`;return{ok:true};
  }
  if(path.startsWith('/admin/')){
   const sessionId=await session(s,h);
   const owner=!(await s.get('sessions',sessionId)).staff_id;
   if(path==='/admin/reports'&&method==='POST')return businessReports.build(s,body);
   if(path==='/admin/reports/cost'&&method==='POST'){const actor=(await s.get('sessions',sessionId)).staff_id||'owner';const result=await businessReports.saveCost(s,body,actor);await audit(s,'report_product_cost_saved',result.id);return result}
   if(path==='/admin/reports/expense'&&method==='POST'){const actor=(await s.get('sessions',sessionId)).staff_id||'owner';const result=await businessReports.saveExpense(s,body,actor);await audit(s,body.voided?'report_expense_voided':'report_expense_recorded',result.id);return result}
   if(path==='/admin/checkout-context'&&method==='GET')return{can_order_for_customer:true};
   if(path==='/admin/staff/invite'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const r=await staff.invite(s,body);emailJob=r.job;await audit(s,'staff_invited',r.staff.email);return{ok:true,staff:r.staff}}
   if(path==='/admin/staff/revoke'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const a=await s.get('staff',text(body.id||'',64));if(!a)fail('Staff member not found.',404);a.active=false;a.auth_version++;delete a.setup;await s.put('staff',a.id,a);await audit(s,'staff_access_revoked',a.email);return{ok:true}}
   if(path==='/admin/affiliate/photo-link'&&method==='POST'){const result=await photos.issueLink(s,text(body.slug||'',60));await audit(s,'affiliate_photo_link_created');return result}
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
   if(path==='/admin/rewards/import'&&method==='POST'){const r=await accounts.importBatch(s,text(body.batch_id||'',100));await audit(s,'customer_rewards_imported');return r}
   if(path==='/admin/rewards/adjust'&&method==='POST'){const id=text(body.customer_id||'',64),a=await s.get('customers',id);if(!a?.verified)fail('Choose a verified customer.');if(!Number.isSafeInteger(body.points)||!body.points||Math.abs(body.points)>1000000)fail('Enter a nonzero whole-point adjustment.');const key=text(body.idempotency_key||'',100),note=text(body.note||'',500);await accounts.event(s,id,'adjust:'+key,'staff_adjustment',body.points,0,null,note);await audit(s,'rewards_adjusted');return{ok:true}}
   if(path==='/admin/data'&&method==='GET')return{owner,staff:(await s.list('staff')).map(staff.publicStaff),products:await s.list('products'),coupons:await s.list('coupons'),affiliates:await s.list('affiliates'),orders:(await s.list('orders')).sort((a,b)=>b.created-a.created).map(publicOrder),settings,email:await emails.adminData(s),goaffpro:goaffpro.status(await s.get('integrations','goaffpro')),shipstation:shipping.status(await s.get('integrations','shipstation')),shippo:shippo.status(await s.get('integrations','shippo')),audit:(await s.get('audit','log')||[]).slice().reverse()};
   const r=path.match(/^\/admin\/receipt\/([A-Z0-9-]+)$/);if(r&&method==='GET'){const o=await s.get('orders',r[1]);if(!o?.receipt)fail('Receipt not found.',404);return{_binary:o.receipt,_type:o.receipt_type}}
   if(path==='/admin/product'&&method==='POST'){
    const all=await s.list('products'),id=body.id?int(body.id,1):Math.max(0,...all.map(p=>p.id))+1;const old=body.id?await s.get('products',id):{};if(!old)fail('Product not found.',404);
    const stockPool=text(body.stock_pool??old.stock_pool??'',60,false);if(stockPool&&!validSlug(stockPool))fail('Use a lowercase stock group name with letters, numbers and hyphens.');
    const affectedIds=new Set([id,...all.filter(x=>x.stock_pool&&[old.stock_pool,stockPool].includes(x.stock_pool)).map(x=>x.id)]);if(body.id&&(old.stock_pool||'')!==stockPool&&(await s.list('orders')).some(o=>['order_received','awaiting_payment','payment_submitted'].includes(o.status)&&o.items.some(i=>affectedIds.has(i.id))))fail('Finish or cancel the affected products’ reserved orders before changing the stock group.',409);
    if(body.expected_stock!==undefined&&body.id&&body.stock!==body.expected_stock&&old.stock!==body.expected_stock)fail('Inventory changed while you were editing. Refresh before changing the quantity.',409);
    const p={...old,id,name:text(body.name||'',150),sku:text(body.sku||'',60),price:int(body.price),stock:body.id&&body.expected_stock!==undefined&&body.stock===body.expected_stock?old.stock:int(body.stock),stock_pool:stockPool,active:int(body.active??1,0,1),promo_excluded:int(body.promo_excluded??Number(!!old.promo_excluded),0,1)===1,brand:brands.validId(body.brand??old.brand??'glow')};{const u=int(body.units??old.units??1,1,100);if(u>1)p.units=u;else delete p.units;if(u!==(old.units||1)&&body.id&&(await s.list('orders')).some(o=>['order_received','awaiting_payment','payment_submitted'].includes(o.status)&&o.items.some(i=>i.id===id)))fail('Finish or cancel this product’s reserved orders before changing how many units it takes.',409)}if(body.components!==undefined){const raw=Array.isArray(body.components)?body.components:String(body.components||'').split(',').map(x=>x.trim()).filter(Boolean);if(raw.length>20)fail('A bundle can hold at most 20 different products.');const comps=[];for(const r of raw){let sku,qty=1,x;if(typeof r==='string'){const m=r.match(/^(.+?)(?:\s+x\s*(\d+)|\s*[×*]\s*(\d+))?$/i);sku=m[1].trim();qty=Number(m[2]||m[3]||1)}else{sku=String(r&&r.sku||'');qty=r&&r.qty;if(r&&r.id)x=all.find(y=>y.id===r.id)}x=x||all.find(y=>y.sku.toLowerCase()===sku.toLowerCase()&&brands.productBrand(y)===p.brand)||all.find(y=>y.sku.toLowerCase()===sku.toLowerCase());if(!x)fail('Bundle contents: no product with SKU '+sku+'.');if(x.id===id)fail('A bundle cannot contain itself.');if(isBundle(x))fail('A bundle cannot contain another bundle.');const n=int(qty,1,20),same=comps.find(c=>c.id===x.id);if(same)same.qty+=n;else comps.push({id:x.id,qty:n})}if(comps.length&&p.units)fail('A bundle takes its stock from the products inside it. Set units per item to 1.');if(comps.length)p.components=comps;else delete p.components}if(all.some(x=>x.id!==id&&x.sku.toLowerCase()===p.sku.toLowerCase()))fail('That SKU already exists.',409);
    if(!body.id&&stockPool){const member=all.find(x=>x.stock_pool===stockPool);if(member)p.stock=member.stock}
    if(/^merch-/i.test(p.sku))p.category='merch';else if(/^cosmetic-/i.test(p.sku))p.category='cosmetic';
    const saved=await catalogPhotos.applyPhotoUpdate(s,p,body.photo_update);
    const group=body.photo_update?.apply_design===true&&p.merch_design?all.filter(x=>x.merch_design===p.merch_design&&x.brand===p.brand&&x.id!==p.id):[];
    if(body.photo_update?.apply_design===true&&!p.merch_design)fail('Choose an existing shirt design before applying photos to all variants.');
    await setStock(s,saved,saved.stock);
    for(const member of group){const current=await s.get('products',member.id);if(!catalogPhotos.eligible(current))continue;await s.put('products',member.id,{...current,image:saved.image,additional_images:saved.additional_images,...(saved.model_color===''?{model_color:''}:{}),photo_revision:(member.photo_revision||0)+1})}
    await audit(s,body.photo_update?'product_photos_saved':'product_saved');return{ok:true,id};
   }
   if(path==='/admin/coupon'&&method==='POST'){
    const code=text(body.code||'',40).toUpperCase(),kind=body.kind;if(!['fixed','percent'].includes(kind))fail('Invalid discount type.');const old=await s.get('coupons',code),owner=text(body.affiliate??old?.affiliate??'',60,false).toLowerCase(),active=int(body.active??1,0,1);if(owner){const a=validSlug(owner)?await s.get('affiliates',owner):null;if(!a||!a.goaffpro_id||(active&&!a.active))fail('Choose an active affiliate connected to GoAffPro.');}const c={code,kind,allow_stacking:couponRules.stackingValue(body,old),brand:brands.validId(body.brand??old?.brand??'glow'),affiliate:owner||null,value:int(body.value,1,kind==='percent'?100:1000000),minimum:int(body.minimum??0),max_uses:int(body.max_uses??100,1),used:old?.used||0,expires:int(body.expires??0,0,9999999999),active:int(body.active??1,0,1)};await s.put('coupons',code,c);await audit(s,'coupon_saved');return{ok:true};
   }
   if(path==='/admin/affiliate'&&method==='POST'){
    const slug=text(body.slug||'',60).toLowerCase();if(!validSlug(slug))fail('Choose a unique lowercase store link.');const old=await s.get('affiliates',slug),goaffproId=text(body.goaffpro_id||'',100,false);if(goaffproId&&(await s.list('affiliates')).some(a=>a.slug!==slug&&a.goaffpro_id===goaffproId))fail('This GoAffPro affiliate already has a storefront. Edit that storefront instead.',409);const a={...old,slug,name:text(body.name||'',150),bio:text(body.bio||'',500,false),goaffpro_id:goaffproId,commission_bps:int(body.commission_bps??1500,0,10000),active:int(body.active??1,0,1)};await s.put('affiliates',slug,a);await audit(s,'affiliate_saved');return{ok:true};
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
   if(path==='/admin/settings'&&method==='POST'){
    settings.shipping_cents=int(body.shipping_cents);settings.free_shipping_cents=int(body.free_shipping_cents??settings.free_shipping_cents);settings.payment_links=validateLinks(body.payment_links);if(settings.checkout_enabled&&!Object.values(settings.payment_links).some(Boolean))fail('Keep at least one payment recipient while live checkout is enabled.');await s.put('settings','main',settings);await audit(s,'settings_saved');return{ok:true};
   }
 if(path==='/admin/status'&&method==='POST'){
    const o=await s.get('orders',body.id);if(!o)fail('Order not found.',404);const target=body.status;
    if(target==='awaiting_payment'&&o.status==='order_received'){o.status=target;o.invoice_sent_at=clock();o.invoice_sent_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.expires=clock()+7*86400;o.payment_window_days=7;await s.put('orders',o.id,o);await audit(s,'invoice_sent',o.id);return{ok:true}}
    if(target==='canceled'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){await release(s,o,target);emailJob=await emails.queueUpdate(s,o);return{ok:true}}
    if(target==='paid'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){if(body.verified!==true)fail('Confirm that the payment was received.');o.status='paid';o.paid=clock();o.verified_payment_cents=o.total;o.balance_due_cents=0;o.refund_due_cents=0;o.payment_verified_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.payment_verification_source=o.receipt?'screenshot_and_staff':'staff_verified';o.checkout_stage='submitted';o.submitted_at=o.submitted_at||o.created;await accounts.paid(s,o);o.shipstation_status=o.is_test===false?'queued':'test_only';o.goaffpro_status=o.affiliate?(o.is_test===false?'queued':'test_only'):'not_applicable';await s.put('outbox','shipstation-'+o.id,{id:'shipstation-'+o.id,provider:'shipstation',order_id:o.id,status:'not_connected',attempts:0});if(o.affiliate)await s.put('outbox','goaffpro-'+o.id,{id:'goaffpro-'+o.id,provider:'goaffpro',order_id:o.id,status:o.goaffpro_status,attempts:0});await audit(s,'payment_verified',o.id)}
    else if(target==='shipped'&&o.status==='paid'){if(o.balance_due_cents||o.refund_due_cents)fail('Settle the additional payment or refund before shipping.',409);if(o.shipstation_needs_review&&body.shipping_review!==true)fail('Confirm the updated order was reviewed in ShipStation before shipping.',409);o.shipstation_needs_review=false;o.status='shipped';o.tracking=text(body.tracking||'',150,false);o.shipment=require('./order-tracking.cjs').fromManual(o.tracking);await audit(s,'shipped',o.id)}
    else fail('This status change is not allowed.',409);await s.put('orders',o.id,o);emailJob=await emails.queueUpdate(s,o);return{ok:true};
   }
   if(path==='/admin/integrations'&&method==='GET')return{outbox:await s.list('outbox'),shipstation:shipping.status(await s.get('integrations','shipstation')),shippo:shippo.status(await s.get('integrations','shippo')),goaffpro:goaffpro.status(await s.get('integrations','goaffpro'))};
   if(path==='/admin/goaffpro/preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing affiliate reporting.',409);return{dry_run:true,eligible:reporting.eligible(o),payload:reporting.payload(o),note:o.is_test!==false?'Test order: not sent to GoAffPro.':'Preview only; commission rates are determined by GoAffPro.'}}
   if(path==='/admin/shipment-preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing a shipment.',409);return{dry_run:true,provider:'shipstation',payload:shipping.payload(o,(await s.get('integrations','shipstation'))?.store_id||null),note:'Preview only. No order or postage sent. Review weights and carrier service in ShipStation.'}}
   fail('Endpoint not found.',404);
  }
  fail('Endpoint not found.',404);
 });
 if(emailJob){const delivery=await emails.safeDispatch(emailJob);if(result&&typeof result==='object')result.email=delivery}
 if(path==='/admin/status'&&method==='POST'&&body.status==='paid'&&result?.ok){try{result.goaffpro=await reporting.report(body.id)}catch{result.goaffpro={status:'failed',message:'Payment is saved. Affiliate reporting needs a later status check.'}}}
 if(path==='/admin/status'&&method==='POST'&&body.status==='paid'&&result?.ok){try{result.shipstation=await shipping.send(body.id)}catch{result.shipstation={status:'failed',message:'Payment saved. Check Shipping for transfer status.'}}}
 return{status:result?._status||(method==='POST'&&path==='/orders'?201:200),headers:setCookie?{'Set-Cookie':setCookie}:{},body:result?._error?{error:result._error}:result};
}
module.exports={handle,quote,shipmentPayload,publicOrder};








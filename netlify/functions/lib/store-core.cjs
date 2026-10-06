'use strict';
const crypto=require('node:crypto');const {transaction}=require('./store-db.cjs');
const goaffpro=require('./goaffpro.cjs');
const {validSlug,createStorefronts,resolveReferral}=require('./storefronts.cjs');
const photos=require('./affiliate-photos.cjs');
const receipts=require('./payment-receipts.cjs');
const reporting=require('./goaffpro-orders.cjs');
const shipping=require('./shipstation.cjs');
const accounts=require('./customer-accounts.cjs');
const emails=require('./store-email.cjs');
const staff=require('./staff-accounts.cjs');
const {withProductPhotos}=require('./product-photos.cjs');
const photoUrl=slug=>'/.netlify/functions/store-next?route='+encodeURIComponent('/storefronts/'+slug+'/photo');
const clock=()=>Math.floor(Date.now()/1000),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const text=(value,max=200,required=true)=>{if(typeof value!=='string')fail('Invalid text field.');const v=value.trim();if(v.length>max||(required&&!v))fail('Complete required fields within their length limits.');return v};
const int=(v,min=0,max=10000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('Enter a valid whole number.');return v};
function signingKey(){if(!process.env.STORE_SESSION_SECRET||process.env.STORE_SESSION_SECRET.length<32)fail('Admin sessions are not configured.',503);return process.env.STORE_SESSION_SECRET}
function sign(value){return crypto.createHmac('sha256',signingKey()).update(value).digest('base64url')}
async function session(store,headers){const cookie=(headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('glow_next_admin='));const token=cookie?.slice('glow_next_admin='.length)||'',parts=token.split('.');if(parts.length!==3||Number(parts[0])<=clock()||!equal(sign(parts[0]+'.'+parts[1]),parts[2]))fail('Sign in to the management dashboard.',401);const record=await store.get('sessions',parts[1]);if(!record||record.expires<=clock())fail('Sign in to the management dashboard.',401);if(record.staff_id){const a=await store.get('staff',record.staff_id);if(!a?.active||!a.verified||record.auth_version!==a.auth_version)fail('Sign in to the management dashboard.',401)}return parts[1]}
const publicOrder=o=>{const {token_hash,receipt,idempotency_key,request_hash,goaffpro_affiliate_id,customer_id,created_by_staff,payment_verified_by,invoice_sent_by,...rest}=o;return{...rest,has_receipt:!!receipt,commission_status:['paid','shipped'].includes(o.status)?'eligible':'not_eligible'}};
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
   if(!/^\d{5}(-\d{4})?$/.test(customer.zip))fail('Enter a five-digit ZIP code, optionally followed by four digits.');
 return customer;
}
async function setStock(s,p,stock){int(stock);const members=p.stock_pool?(await s.list('products')).filter(x=>x.stock_pool===p.stock_pool&&x.id!==p.id):[];for(const x of [...members,p]){x.stock=stock;await s.put('products',x.id,x)}}
async function release(s,o,status){await accounts.release(s,o);for(const line of o.items){const p=await s.get('products',line.id);await setStock(s,p,p.stock+line.quantity)}if(o.coupon){const c=await s.get('coupons',o.coupon);if(c){c.used=Math.max(0,c.used-1);await s.put('coupons',c.code,c)}}o.status=status;await s.put('orders',o.id,o);await audit(s,status,o.id)}
async function expire(s){for(const o of await s.list('orders'))if(o.status==='awaiting_payment'&&o.expires<=clock())await release(s,o,'expired')}
async function quote(s,b,h={}){
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add at least one product.');const seen=new Set(),poolQuantities=new Map(),items=[];let subtotal=0;
 for(const line of b.items){const id=int(line.id,1),quantity=int(line.quantity,1,100);if(seen.has(id))fail('Duplicate product in the cart.');seen.add(id);const p=await s.get('products',id);if(!p||!p.active)fail('A product is unavailable.');const stockKey=p.stock_pool?'pool:'+p.stock_pool:'product:'+id;const combined=(poolQuantities.get(stockKey)||0)+quantity;poolQuantities.set(stockKey,combined);if(combined>p.stock)fail(`Only ${p.stock} of ${p.name} available.`,409);const amount=p.price*quantity;subtotal+=amount;items.push({id,name:p.name,sku:p.sku,quantity,price:p.price,amount})}
 const code=text(b.coupon||'',40,false).toUpperCase();let discount=0,couponAffiliate='';if(code){const c=await s.get('coupons',code);if(!c||!c.active||c.used>=c.max_uses||(c.expires&&c.expires<=clock()))fail('Coupon is unavailable or expired.');if(subtotal<c.minimum)fail('Cart does not meet the coupon minimum.');discount=Math.min(subtotal,c.kind==='percent'?Math.floor(subtotal*c.value/100):c.value);couponAffiliate=c.affiliate||''}
 const slug=couponAffiliate||text(b.affiliate||'',60,false).toLowerCase();const affiliate=slug?await s.get('affiliates',slug):null;if(slug&&(!affiliate||!affiliate.active||(couponAffiliate&&!affiliate.goaffpro_id)))fail(couponAffiliate?'This affiliate coupon is unavailable.':'Affiliate storefront is unavailable.');
 const settings=await s.get('settings','main'),a=await accounts.session(s,h);const requested=int(b.points_redeemed??0,0,10000000),coupon_discount=discount;let rewards_discount=0;
 if(requested){if(settings.demo!==false)fail('Test orders do not spend real rewards points.');if(!a)fail('Sign in to use rewards points.',401);const w=await accounts.wallet(s,a.id);if(requested>Math.max(0,w.balance-w.reserved))fail('You do not have enough available points.',409);if(requested>Math.floor((subtotal-discount)/5))fail('Points cannot exceed the remaining product amount.');rewards_discount=requested*5;discount+=rewards_discount}
 const shipping=settings.free_shipping_cents>0&&subtotal-discount>=settings.free_shipping_cents?0:settings.shipping_cents;
 return{items,subtotal,discount,coupon_discount,rewards_discount,points_redeemed:requested,points_to_earn:Math.floor((subtotal-discount)/100),shipping,tax:0,total:subtotal-discount+shipping,coupon:code||null,affiliate:slug||null,affiliate_name:affiliate?.name||null,affiliate_source:couponAffiliate?'coupon':(slug?'storefront':null),commission:affiliate?Math.floor((subtotal-discount)*affiliate.commission_bps/10000):0,tax_note:settings.tax_note}

}
async function orderAuth(s,id,headers){const o=await s.get('orders',id),a=await accounts.session(s,headers);if(!o||(!equal(o.token_hash,hash(headers['x-order-token']||''))&&!(a&&o.customer_id===a.id)))fail('Order access denied.',404);return o}
function validateLinks(links){if(!links||typeof links!=='object'||Array.isArray(links))fail('Invalid payment settings.');const out={};for(const[k,domains]of Object.entries({venmo:['venmo.com','www.venmo.com','account.venmo.com'],paypal:['paypal.com','www.paypal.com','paypal.me','www.paypal.me'],cashapp:['cash.app'],zelle:[]})){const v=text(links[k]||'',300,false);if(v&&k!=='zelle'){let u;try{u=new URL(v)}catch{fail('Enter an official HTTPS '+k+' link.')}if(u.protocol!=='https:'||!domains.includes(u.hostname)||u.username||u.password)fail('Enter an official HTTPS '+k+' link.')}out[k]=v}return out}
function shipmentPayload(o){return shipping.payload(o,null)}
function editable(o){if(!['order_received','awaiting_payment'].includes(o.status)||o.has_receipt||o.receipt)fail('This order has been submitted or closed. Contact the store to change it.',409)}
function draftStore(s,o){const reserved=new Map();for(const line of o.items){reserved.set(line.id,(reserved.get(line.id)||0)+line.quantity)}return{...s,get:async(kind,key)=>{const r=await s.get(kind,key);if(!r)return r;if(kind==='products'){let qty=reserved.get(r.id)||0;if(r.stock_pool){qty=o.items.reduce((n,line)=>n+(line.stock_pool===r.stock_pool?line.quantity:0),0)}return{...r,stock:r.stock+qty}}if(kind==='coupons'&&key===o.coupon)return{...r,used:Math.max(0,r.used-1)};if(kind==='rewards_wallets'&&key===o.customer_id&&o.is_test===false)return{...r,reserved:Math.max(0,r.reserved-(o.points_redeemed||0))};return r}}}
async function editStore(s,o){const copy={...o,items:[]};for(const line of o.items){const p=await s.get('products',line.id);copy.items.push({...line,stock_pool:p?.stock_pool})}return draftStore(s,copy)}
async function handle({path,method='GET',headers={},body={}}){
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));let setCookie,emailJob;
 if(!['GET','POST'].includes(method))fail('Method not allowed.',405);
 if(method==='POST'){
  if(h['x-store-request']!=='1')fail('Request protection header required.',403);
  if(h.origin&&process.env.STORE_ORIGIN&&h.origin!==process.env.STORE_ORIGIN)fail('Cross-origin request denied.',403);
  if(h['sec-fetch-site']==='cross-site')fail('Cross-site request denied.',403);
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Invalid request.');
 }
 const staffAuth=await staff.authRoute(path,body,h,method);if(staffAuth)return staffAuth;
 const accountAuth=await accounts.authRoute(path,body,h,method);if(accountAuth)return accountAuth;
 if(path==='/admin/email/retry'&&method==='POST'){
  const id=text(body.id||'',200);await transaction(async s=>{await session(s,h);const j=await s.get('email_outbox',id);if(!j)fail('Email not found.',404);if(j.status==='rejected')await emails.prepareRetry(s,j)});
  return{status:200,headers:{},body:await emails.dispatch(id)};
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
 const result=await transaction(async s=>{
  const settings=await s.get('settings','main');if(!settings)fail('Store data has not been initialized.',503);await expire(s);
  if(path==='/catalog'&&method==='GET')return{products:(await s.list('products')).filter(p=>p.active).map(withProductPhotos),settings:{...settings,email_enabled:emails.configuration().ready}};
  const referral=path.match(/^\/referrals\/([^/]+)$/);
  if(referral&&method==='GET'){let code;try{code=decodeURIComponent(referral[1])}catch{fail('Affiliate referral is unavailable.',404)}const a=await resolveReferral(s,code);if(!a)fail('Affiliate referral is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const storefront=path.match(/^\/storefronts\/([a-z0-9-]+)$/);
  if(storefront&&method==='GET'){const a=validSlug(storefront[1])?await s.get('affiliates',storefront[1]):null;if(!a?.active)fail('Affiliate storefront is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const publicPhoto=path.match(/^\/storefronts\/([a-z0-9-]+)\/photo$/);
  if(publicPhoto&&method==='GET'){const a=await s.get('affiliates',publicPhoto[1]),image=await s.get('affiliate_photos',publicPhoto[1]);if(!a?.active||!image)fail('Photo not found.',404);return{_binary:image.data,_type:'image/jpeg'}}
  const profile=path.match(/^\/affiliate-profile\/([a-z0-9-]+)$/);
  if(profile&&method==='GET'){const a=await photos.authorize(s,profile[1],h['x-profile-token']);return{slug:a.slug,name:a.name,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  if(path==='/quote'&&method==='POST'){if(body.order_for_customer===true){await session(s,h);if(body.points_redeemed)fail('Customer rewards cannot be redeemed from a staff login.');return quote(s,body,{})}return quote(s,body,h)}
  if(path==='/account'&&method==='GET')return accounts.accountData(s,await accounts.session(s,h,true));
  if(path==='/account/logout'&&method==='POST'){const token=(h.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('glow_next_customer='))?.slice(19);if(token)await s.remove('customer_sessions',accounts.hash(token));setCookie=accounts.cookie('',0);return{ok:true}}
  if(path==='/orders'&&method==='POST'){
   if(settings.demo!==true&&!(settings.demo===false&&settings.checkout_enabled===true&&settings.tax_mode==='none'))fail('Live checkout is disabled. Enable it in dashboard Settings after saving inventory and payment recipients.',503);
   const key=text(body.idempotency_key||'',100);if(await s.get('idempotency',key))fail('This order was already submitted. Use your saved confirmation.',409);
   const assisted=body.order_for_customer===true,staffSession=assisted?await session(s,h):null;if(assisted&&body.points_redeemed)fail('Customer rewards cannot be redeemed from a staff login.');
   const a=assisted?null:await accounts.session(s,h),q=await quote(s,body,assisted?{}:h),customer=checkoutCustomer(body.customer);
   if(a&&accounts.email(customer.email)!==a.email)fail('Use your account email for this order.');
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle'].includes(payment))fail('Choose a payment method.');if(settings.demo===false&&!settings.payment_links[payment])fail('This payment method is not available.');
   const id='GLP-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url');const o={id,created:clock(),expires:null,status:'order_received',customer,...q,payment_method:payment,token_hash:hash(token),idempotency_key:key,request_hash:hash(JSON.stringify(body)),checkout_stage:'draft',submitted_at:null,receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:q.affiliate?'awaiting_payment':'not_applicable'};
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;
   const beneficiary=assisted?await s.get('customers',accounts.hash(accounts.email(customer.email))):a;
   o.is_test=settings.demo!==false;o.customer_id=beneficiary?.verified?beneficiary.id:null;if(assisted){const actor=await s.get('sessions',staffSession);o.created_by_staff=actor.staff_id||'owner';o.order_for_customer=true}o.points_earned=0;await accounts.reserve(s,o);
   for(const item of q.items){const p=await s.get('products',item.id);await setStock(s,p,p.stock-item.quantity)}if(q.coupon){const c=await s.get('coupons',q.coupon);c.used++;await s.put('coupons',c.code,c)}
   await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created',id);emailJob=await emails.queueOrder(s,o,token);return{order:publicOrder(o),token};
  }
  const edit=path.match(/^\/orders\/([A-Z0-9-]+)\/(edit-context|edit-quote|edit)$/);
  if(edit){const o=await orderAuth(s,edit[1],h);editable(o);const available=await editStore(s,o);
   if(edit[2]==='edit-context'&&method==='GET'){const products=[];for(const p of await s.list('products'))if(p.active)products.push(withProductPhotos(await available.get('products',p.id)));return{products,settings:{...settings,email_enabled:emails.configuration().ready},order:publicOrder(o)}}
   if(method!=='POST')fail('Method not allowed.',405);
   if(body.points_redeemed&&o.order_for_customer)fail('Customer rewards cannot be redeemed from a staff login.');
   const q=await quote(available,body,o.order_for_customer?{}:h);
   if(edit[2]==='edit-quote')return q;
   if(body.not_paid!==true)fail('Confirm you have not paid before changing this draft.');
   if(body.expected_revision!==(o.revision||0))fail('This checkout changed in another tab. Reopen your order before editing.',409);
   const customer=checkoutCustomer(body.customer);if(accounts.email(customer.email)!==accounts.email(o.customer.email))fail('Keep the same order email while editing. Contact the store to change it.');
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle'].includes(payment)||settings.demo===false&&!settings.payment_links[payment])fail('Choose an available payment method.');
   if(q.points_redeemed){const a=await accounts.session(s,h);if(!a||a.id!==o.customer_id)fail('Sign in to the original customer account to use its rewards.',401)}
   const revision=(o.revision||0)+1;await release(s,o,o.status);Object.assign(o,q,{customer,payment_method:payment,revision,reservation_version:revision,updated:clock()});
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;await accounts.reserve(s,o);
   for(const line of o.items){const p=await s.get('products',line.id);await setStock(s,p,p.stock-line.quantity)}if(o.coupon){const c=await s.get('coupons',o.coupon);c.used++;await s.put('coupons',c.code,c)}await s.put('orders',o.id,o);await audit(s,'checkout_edited',o.id);
   if(o.is_test===false)emailJob=await emails.enqueue(s,{id:'draft-edit-'+o.id+'-'+revision,kind:'checkout_updated',to:o.customer.email,related_id:o.id,subject:'Updated Glow Lab checkout '+o.id,content:emails.template('Your checkout has been updated.',['Order: '+o.id,'Your latest total is $'+(o.total/100).toFixed(2)+'. Use this amount instead of earlier checkout emails.','Your existing private order link shows the latest items, status and shipping address. After paying, upload your screenshot for staff verification.'],null,null)});return{order:publicOrder(o)};
  }
  const m=path.match(/^\/orders\/([A-Z0-9-]+)(\/receipt)?$/);if(m){const o=await orderAuth(s,m[1],h);if(method==='GET'&&!m[2])return publicOrder(o);if(method==='POST'&&m[2]){
   if(!['order_received','awaiting_payment','payment_submitted'].includes(o.status))fail('This order no longer accepts receipts.',409);
   if((o.revision||0)>0&&body.expected_revision!==o.revision)fail('This checkout changed. Refresh your order and check the latest total before submitting payment proof.',409);
   if(!o.customer.phone)o.customer.phone=contactPhone(body.phone);
   const reference=text(body.reference||'',100,false);o.receipt=receiptImage.data;o.receipt_type=receiptImage.mime;o.payment_reference=reference;o.status='payment_submitted';o.checkout_stage='submitted';o.submitted_at=o.submitted_at||clock();emailJob=await emails.queueSubmitted(s,o);await s.put('orders',o.id,o);await audit(s,'receipt_submitted',o.id);return publicOrder(o);
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
   if(path==='/admin/checkout-context'&&method==='GET')return{can_order_for_customer:true};
   if(path==='/admin/staff/invite'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const r=await staff.invite(s,body);emailJob=r.job;await audit(s,'staff_invited',r.staff.email);return{ok:true,staff:r.staff}}
   if(path==='/admin/staff/revoke'&&method==='POST'){if(!owner)fail('Only the owner can manage staff access.',403);const a=await s.get('staff',text(body.id||'',64));if(!a)fail('Staff member not found.',404);a.active=false;a.auth_version++;delete a.setup;await s.put('staff',a.id,a);await audit(s,'staff_access_revoked',a.email);return{ok:true}}
   if(path==='/admin/affiliate/photo-link'&&method==='POST'){const result=await photos.issueLink(s,text(body.slug||'',60));await audit(s,'affiliate_photo_link_created');return result}
   if(path==='/admin/logout'&&method==='POST'){await s.remove('sessions',sessionId);setCookie='glow_next_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.STORE_LOCAL?'':'; Secure');return{ok:true}}
   if(path==='/admin/shipstation/settings'&&method==='POST'){const r=await s.get('integrations','shipstation');if(!shipping.status(r).connected)fail('Check ShipStation connection first.',409);const target=r.stores.find(x=>x.id===body.store_id);if(!target)fail('Choose a verified ShipStation manual store.');await s.put('integrations','shipstation',{...r,store_id:target.id,store_name:target.name,enabled:body.enabled===true});await audit(s,'shipstation_settings_saved');return{ok:true}}
   if(path==='/admin/customers'&&method==='GET')return accounts.adminData(s);
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
   if(path==='/admin/data'&&method==='GET')return{owner,staff:(await s.list('staff')).map(staff.publicStaff),products:await s.list('products'),coupons:await s.list('coupons'),affiliates:await s.list('affiliates'),orders:(await s.list('orders')).sort((a,b)=>b.created-a.created).map(publicOrder),settings,email:await emails.adminData(s),goaffpro:goaffpro.status(await s.get('integrations','goaffpro')),shipstation:shipping.status(await s.get('integrations','shipstation')),audit:(await s.get('audit','log')||[]).slice().reverse()};
   const r=path.match(/^\/admin\/receipt\/([A-Z0-9-]+)$/);if(r&&method==='GET'){const o=await s.get('orders',r[1]);if(!o?.receipt)fail('Receipt not found.',404);return{_binary:o.receipt,_type:o.receipt_type}}
   if(path==='/admin/product'&&method==='POST'){
    const all=await s.list('products'),id=body.id?int(body.id,1):Math.max(0,...all.map(p=>p.id))+1;const old=body.id?await s.get('products',id):{};if(!old)fail('Product not found.',404);
    const stockPool=text(body.stock_pool??old.stock_pool??'',60,false);if(stockPool&&!validSlug(stockPool))fail('Use a lowercase stock group name with letters, numbers and hyphens.');
    const affectedIds=new Set([id,...all.filter(x=>x.stock_pool&&[old.stock_pool,stockPool].includes(x.stock_pool)).map(x=>x.id)]);if((old.stock_pool||'')!==stockPool&&(await s.list('orders')).some(o=>['order_received','awaiting_payment','payment_submitted'].includes(o.status)&&o.items.some(i=>affectedIds.has(i.id))))fail('Finish or cancel the affected products’ reserved orders before changing the stock group.',409);
    const p={...old,id,name:text(body.name||'',150),sku:text(body.sku||'',60),price:int(body.price),stock:int(body.stock),stock_pool:stockPool,active:int(body.active??1,0,1)};if(all.some(x=>x.id!==id&&x.sku.toLowerCase()===p.sku.toLowerCase()))fail('That SKU already exists.',409);await setStock(s,p,p.stock);await audit(s,'product_saved');return{ok:true};
   }
   if(path==='/admin/coupon'&&method==='POST'){
    const code=text(body.code||'',40).toUpperCase(),kind=body.kind;if(!['fixed','percent'].includes(kind))fail('Invalid discount type.');const old=await s.get('coupons',code),owner=text(body.affiliate??old?.affiliate??'',60,false).toLowerCase(),active=int(body.active??1,0,1);if(owner){const a=validSlug(owner)?await s.get('affiliates',owner):null;if(!a||!a.goaffpro_id||(active&&!a.active))fail('Choose an active affiliate connected to GoAffPro.');}const c={code,kind,affiliate:owner||null,value:int(body.value,1,kind==='percent'?100:1000000),minimum:int(body.minimum??0),max_uses:int(body.max_uses??100,1),used:old?.used||0,expires:int(body.expires??0,0,9999999999),active:int(body.active??1,0,1)};await s.put('coupons',code,c);await audit(s,'coupon_saved');return{ok:true};
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
    if(target==='awaiting_payment'&&o.status==='order_received'){o.status=target;o.invoice_sent_at=clock();o.invoice_sent_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.expires=clock()+86400;await s.put('orders',o.id,o);await audit(s,'invoice_sent',o.id);return{ok:true}}
    if(target==='canceled'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){await release(s,o,target);emailJob=await emails.queueUpdate(s,o);return{ok:true}}
    if(target==='paid'&&['order_received','awaiting_payment','payment_submitted'].includes(o.status)){if(body.verified!==true)fail('Confirm that the payment was received.');o.status='paid';o.paid=clock();o.payment_verified_by=(await s.get('sessions',sessionId)).staff_id||'owner';o.payment_verification_source=o.receipt?'screenshot_and_staff':'staff_verified';o.checkout_stage='submitted';o.submitted_at=o.submitted_at||o.created;await accounts.paid(s,o);o.shipstation_status=o.is_test===false?'queued':'test_only';o.goaffpro_status=o.affiliate?(o.is_test===false?'queued':'test_only'):'not_applicable';await s.put('outbox','shipstation-'+o.id,{id:'shipstation-'+o.id,provider:'shipstation',order_id:o.id,status:'not_connected',attempts:0});if(o.affiliate)await s.put('outbox','goaffpro-'+o.id,{id:'goaffpro-'+o.id,provider:'goaffpro',order_id:o.id,status:o.goaffpro_status,attempts:0});await audit(s,'payment_verified',o.id)}
    else if(target==='shipped'&&o.status==='paid'){o.status='shipped';o.tracking=text(body.tracking||'',150,false);await audit(s,'shipped',o.id)}
    else fail('This status change is not allowed.',409);await s.put('orders',o.id,o);emailJob=await emails.queueUpdate(s,o);return{ok:true};
   }
   if(path==='/admin/integrations'&&method==='GET')return{outbox:await s.list('outbox'),shipstation:shipping.status(await s.get('integrations','shipstation')),goaffpro:goaffpro.status(await s.get('integrations','goaffpro'))};
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


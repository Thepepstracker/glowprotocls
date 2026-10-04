'use strict';
const crypto=require('node:crypto');const {transaction}=require('./store-db.cjs');
const goaffpro=require('./goaffpro.cjs');
const {validSlug,createStorefronts}=require('./storefronts.cjs');
const photos=require('./affiliate-photos.cjs');
const reporting=require('./goaffpro-orders.cjs');
const accounts=require('./customer-accounts.cjs');
const photoUrl=slug=>'/.netlify/functions/store-next?route='+encodeURIComponent('/storefronts/'+slug+'/photo');
const clock=()=>Math.floor(Date.now()/1000),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const text=(value,max=200,required=true)=>{if(typeof value!=='string')fail('Invalid text field.');const v=value.trim();if(v.length>max||(required&&!v))fail('Complete required fields within their length limits.');return v};
const int=(v,min=0,max=10000000)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail('Enter a valid whole number.');return v};
function signingKey(){if(!process.env.STORE_SESSION_SECRET||process.env.STORE_SESSION_SECRET.length<32)fail('Admin sessions are not configured.',503);return process.env.STORE_SESSION_SECRET}
function sign(value){return crypto.createHmac('sha256',signingKey()).update(value).digest('base64url')}
async function session(store,headers){const cookie=(headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('glow_next_admin='));const token=cookie?.slice('glow_next_admin='.length)||'',parts=token.split('.');if(parts.length!==3||Number(parts[0])<=clock()||!equal(sign(parts[0]+'.'+parts[1]),parts[2]))fail('Sign in to the management dashboard.',401);const record=await store.get('sessions',parts[1]);if(!record||record.expires<=clock())fail('Sign in to the management dashboard.',401);return parts[1]}
const publicOrder=o=>{const {token_hash,receipt,idempotency_key,request_hash,goaffpro_affiliate_id,customer_id,...rest}=o;return{...rest,has_receipt:!!receipt,commission_status:['paid','shipped'].includes(o.status)?'eligible':'not_eligible'}};
async function audit(s,action,id=''){const log=await s.get('audit','log')||[];log.push({created:clock(),action,order_id:id});await s.put('audit','log',log.slice(-250))}
async function release(s,o,status){await accounts.release(s,o);for(const line of o.items){const p=await s.get('products',line.id);p.stock+=line.quantity;await s.put('products',p.id,p)}if(o.coupon){const c=await s.get('coupons',o.coupon);if(c){c.used=Math.max(0,c.used-1);await s.put('coupons',c.code,c)}}o.status=status;await s.put('orders',o.id,o);await audit(s,status,o.id)}
async function expire(s){for(const o of await s.list('orders'))if(o.status==='awaiting_payment'&&o.expires<=clock())await release(s,o,'expired')}
async function quote(s,b,h={}){
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)fail('Add at least one product.');const seen=new Set(),items=[];let subtotal=0;
 for(const line of b.items){const id=int(line.id,1),quantity=int(line.quantity,1,100);if(seen.has(id))fail('Duplicate product in the cart.');seen.add(id);const p=await s.get('products',id);if(!p||!p.active)fail('A product is unavailable.');if(quantity>p.stock)fail(`Only ${p.stock} of ${p.name} available.`,409);const amount=p.price*quantity;subtotal+=amount;items.push({id,name:p.name,sku:p.sku,quantity,price:p.price,amount})}
 const code=text(b.coupon||'',40,false).toUpperCase();let discount=0;if(code){const c=await s.get('coupons',code);if(!c||!c.active||c.used>=c.max_uses||(c.expires&&c.expires<=clock()))fail('Coupon is unavailable or expired.');if(subtotal<c.minimum)fail('Cart does not meet the coupon minimum.');discount=Math.min(subtotal,c.kind==='percent'?Math.floor(subtotal*c.value/100):c.value)}
 const slug=text(b.affiliate||'',60,false).toLowerCase();const affiliate=slug?await s.get('affiliates',slug):null;if(slug&&(!affiliate||!affiliate.active))fail('Affiliate storefront is unavailable.');
 const settings=await s.get('settings','main'),a=await accounts.session(s,h);const requested=int(b.points_redeemed??0,0,10000000),coupon_discount=discount;let rewards_discount=0;
 if(requested){if(settings.demo!==false)fail('Test orders do not spend real rewards points.');if(!a)fail('Sign in to use rewards points.',401);const w=await accounts.wallet(s,a.id);if(requested>Math.max(0,w.balance-w.reserved))fail('You do not have enough available points.',409);if(requested>Math.floor((subtotal-discount)/5))fail('Points cannot exceed the remaining product amount.');rewards_discount=requested*5;discount+=rewards_discount}
 const shipping=settings.free_shipping_cents>0&&subtotal-discount>=settings.free_shipping_cents?0:settings.shipping_cents;
 return{items,subtotal,discount,coupon_discount,rewards_discount,points_redeemed:requested,points_to_earn:Math.floor((subtotal-discount)/100),shipping,tax:0,total:subtotal-discount+shipping,coupon:code||null,affiliate:slug||null,commission:affiliate?Math.floor((subtotal-discount)*affiliate.commission_bps/10000):0,tax_note:settings.tax_note}

}
async function orderAuth(s,id,headers){const o=await s.get('orders',id),a=await accounts.session(s,headers);if(!o||(!equal(o.token_hash,hash(headers['x-order-token']||''))&&!(a&&o.customer_id===a.id)))fail('Order access denied.',404);return o}
function validateLinks(links){if(!links||typeof links!=='object'||Array.isArray(links))fail('Invalid payment settings.');const out={};for(const[k,domains]of Object.entries({venmo:['venmo.com','www.venmo.com','account.venmo.com'],paypal:['paypal.com','www.paypal.com','paypal.me','www.paypal.me'],cashapp:['cash.app'],zelle:[]})){const v=text(links[k]||'',300,false);if(v&&k!=='zelle'){let u;try{u=new URL(v)}catch{fail('Enter an official HTTPS '+k+' link.')}if(u.protocol!=='https:'||!domains.includes(u.hostname)||u.username||u.password)fail('Enter an official HTTPS '+k+' link.')}out[k]=v}return out}
function shipmentPayload(o){return{orderNumber:o.id,orderKey:o.id,orderDate:new Date(o.created*1000).toISOString(),paymentDate:o.paid?new Date(o.paid*1000).toISOString():null,orderStatus:'awaiting_shipment',customerEmail:o.customer.email,billTo:{name:o.customer.name},shipTo:{name:o.customer.name,street1:o.customer.address,city:o.customer.city,state:o.customer.state,postalCode:o.customer.zip,country:'US'},items:o.items.map(i=>({sku:i.sku,name:i.name,quantity:i.quantity,unitPrice:i.price/100})),amountPaid:o.total/100,taxAmount:o.tax/100,shippingAmount:o.shipping/100,paymentMethod:o.payment_method,internalNotes:'Store-next development mapping; discounts and carrier settings need live validation.'}}
async function handle({path,method='GET',headers={},body={}}){
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));let setCookie;
 if(!['GET','POST'].includes(method))fail('Method not allowed.',405);
 if(method==='POST'){
  if(h['x-store-request']!=='1')fail('Request protection header required.',403);
  if(h.origin&&process.env.STORE_ORIGIN&&h.origin!==process.env.STORE_ORIGIN)fail('Cross-origin request denied.',403);
  if(h['sec-fetch-site']==='cross-site')fail('Cross-site request denied.',403);
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Invalid request.');
 }
 const accountAuth=await accounts.authRoute(path,body,h,method);if(accountAuth)return accountAuth;
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
 const result=await transaction(async s=>{
  const settings=await s.get('settings','main');if(!settings)fail('Store data has not been initialized.',503);await expire(s);
  if(path==='/catalog'&&method==='GET')return{products:(await s.list('products')).filter(p=>p.active),settings};
  const storefront=path.match(/^\/storefronts\/([a-z0-9-]+)$/);
  if(storefront&&method==='GET'){const a=validSlug(storefront[1])?await s.get('affiliates',storefront[1]):null;if(!a?.active)fail('Affiliate storefront is unavailable.',404);return{slug:a.slug,name:a.name,bio:a.bio,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  const publicPhoto=path.match(/^\/storefronts\/([a-z0-9-]+)\/photo$/);
  if(publicPhoto&&method==='GET'){const a=await s.get('affiliates',publicPhoto[1]),image=await s.get('affiliate_photos',publicPhoto[1]);if(!a?.active||!image)fail('Photo not found.',404);return{_binary:image.data,_type:'image/jpeg'}}
  const profile=path.match(/^\/affiliate-profile\/([a-z0-9-]+)$/);
  if(profile&&method==='GET'){const a=await photos.authorize(s,profile[1],h['x-profile-token']);return{slug:a.slug,name:a.name,photo_url:await s.get('affiliate_photos',a.slug)?photoUrl(a.slug):null}}
  if(path==='/quote'&&method==='POST')return quote(s,body,h);
  if(path==='/account'&&method==='GET')return accounts.accountData(s,await accounts.session(s,h,true));
  if(path==='/account/logout'&&method==='POST'){const token=(h.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('glow_next_customer='))?.slice(19);if(token)await s.remove('customer_sessions',accounts.hash(token));setCookie=accounts.cookie('',0);return{ok:true}}
  if(path==='/orders'&&method==='POST'){
   if(settings.demo!==true&&!(settings.demo===false&&process.env.STORE_LIVE_CHECKOUT_ENABLED==='1'))fail('Live checkout remains disabled pending tax, payment and integration validation.',503);
   const key=text(body.idempotency_key||'',100);if(await s.get('idempotency',key))fail('This order was already submitted. Use your saved confirmation.',409);
   const a=await accounts.session(s,h),q=await quote(s,body,h),customer={};for(const k of ['name','email','address','city','state','zip'])customer[k]=text(body.customer?.[k]||'',k==='address'?500:150);
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))fail('Enter a valid email address.');
   if(a&&accounts.email(customer.email)!==a.email)fail('Use your account email for this order.');
   const payment=text(body.payment_method||'',20);if(!['venmo','paypal','cashapp','zelle'].includes(payment))fail('Choose a payment method.');if(settings.demo===false&&!settings.payment_links[payment])fail('This payment method is not available.');
   const id='GLP-'+crypto.randomBytes(5).toString('hex').toUpperCase(),token=crypto.randomBytes(32).toString('base64url');const o={id,created:clock(),expires:clock()+86400,status:'awaiting_payment',customer,...q,payment_method:payment,token_hash:hash(token),idempotency_key:key,request_hash:hash(JSON.stringify(body)),receipt:null,receipt_type:null,payment_reference:'',paid:null,tracking:'',shipstation_status:'not_ready',goaffpro_status:q.affiliate?'awaiting_payment':'not_applicable'};
   o.goaffpro_affiliate_id=q.affiliate?(await s.get('affiliates',q.affiliate)).goaffpro_id||'':null;
   o.is_test=settings.demo!==false;o.customer_id=a?.id||null;o.points_earned=0;await accounts.reserve(s,o);
   for(const item of q.items){const p=await s.get('products',item.id);p.stock-=item.quantity;await s.put('products',p.id,p)}if(q.coupon){const c=await s.get('coupons',q.coupon);c.used++;await s.put('coupons',c.code,c)}
   await s.put('orders',id,o);await s.put('idempotency',key,{id});await audit(s,'created',id);return{order:publicOrder(o),token};
  }
  const m=path.match(/^\/orders\/([A-Z0-9-]+)(\/receipt)?$/);if(m){const o=await orderAuth(s,m[1],h);if(method==='GET'&&!m[2])return publicOrder(o);if(method==='POST'&&m[2]){
   if(!['awaiting_payment','payment_submitted'].includes(o.status))fail('This order no longer accepts receipts.',409);
   const reference=text(body.reference||'',100),type=body.mime;const signatures={'image/png':Buffer.from([137,80,78,71,13,10,26,10]),'image/jpeg':Buffer.from([255,216,255]),'image/webp':Buffer.from('RIFF')};
   if(!signatures[type]||typeof body.file!=='string'||body.file.length>4200000||!/^[A-Za-z0-9+/]*={0,2}$/.test(body.file))fail('Choose a PNG, JPEG, or WebP screenshot up to 3 MB.');const raw=Buffer.from(body.file,'base64');if(!raw.length||raw.length>3*1024*1024||!raw.subarray(0,signatures[type].length).equals(signatures[type])||(type==='image/webp'&&raw.subarray(8,12).toString()!=='WEBP'))fail('Screenshot format is invalid.');
   o.receipt=raw.toString('base64');o.receipt_type=type;o.payment_reference=reference;o.status='payment_submitted';await s.put('orders',o.id,o);await audit(s,'receipt_submitted',o.id);return publicOrder(o);
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
   if(path==='/admin/affiliate/photo-link'&&method==='POST'){const result=await photos.issueLink(s,text(body.slug||'',60));await audit(s,'affiliate_photo_link_created');return result}
   if(path==='/admin/logout'&&method==='POST'){await s.remove('sessions',sessionId);setCookie='glow_next_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(process.env.STORE_LOCAL?'':'; Secure');return{ok:true}}
   if(path==='/admin/customers'&&method==='GET')return accounts.adminData(s);
   if(path==='/admin/customer/setup-link'&&method==='POST'){const r=await accounts.issueSetup(s,text(body.customer_id||'',64));await audit(s,'customer_setup_link_created');return r}
   if(path==='/admin/rewards/import-preview'&&method==='POST')return accounts.previewImport(s,body);
   if(path==='/admin/rewards/import'&&method==='POST'){const r=await accounts.importBatch(s,text(body.batch_id||'',100));await audit(s,'customer_rewards_imported');return r}
   if(path==='/admin/rewards/adjust'&&method==='POST'){const id=text(body.customer_id||'',64),a=await s.get('customers',id);if(!a?.verified)fail('Choose a verified customer.');if(!Number.isSafeInteger(body.points)||!body.points||Math.abs(body.points)>1000000)fail('Enter a nonzero whole-point adjustment.');const key=text(body.idempotency_key||'',100),note=text(body.note||'',500);await accounts.event(s,id,'adjust:'+key,'staff_adjustment',body.points,0,null,note);await audit(s,'rewards_adjusted');return{ok:true}}
   if(path==='/admin/data'&&method==='GET')return{products:await s.list('products'),coupons:await s.list('coupons'),affiliates:await s.list('affiliates'),orders:(await s.list('orders')).sort((a,b)=>b.created-a.created).map(publicOrder),settings,goaffpro:goaffpro.status(await s.get('integrations','goaffpro')),audit:(await s.get('audit','log')||[]).slice().reverse()};
   const r=path.match(/^\/admin\/receipt\/([A-Z0-9-]+)$/);if(r&&method==='GET'){const o=await s.get('orders',r[1]);if(!o?.receipt)fail('Receipt not found.',404);return{_binary:o.receipt,_type:o.receipt_type}}
   if(path==='/admin/product'&&method==='POST'){
    const all=await s.list('products'),id=body.id?int(body.id,1):Math.max(0,...all.map(p=>p.id))+1;const old=body.id?await s.get('products',id):{};if(!old)fail('Product not found.',404);
    const p={...old,id,name:text(body.name||'',150),sku:text(body.sku||'',60),price:int(body.price),stock:int(body.stock),active:int(body.active??1,0,1)};if(all.some(x=>x.id!==id&&x.sku.toLowerCase()===p.sku.toLowerCase()))fail('That SKU already exists.',409);await s.put('products',id,p);await audit(s,'product_saved');return{ok:true};
   }
   if(path==='/admin/coupon'&&method==='POST'){
    const code=text(body.code||'',40).toUpperCase(),kind=body.kind;if(!['fixed','percent'].includes(kind))fail('Invalid discount type.');const old=await s.get('coupons',code);const c={code,kind,value:int(body.value,1,kind==='percent'?100:1000000),minimum:int(body.minimum??0),max_uses:int(body.max_uses??100,1),used:old?.used||0,expires:int(body.expires??0,0,9999999999),active:int(body.active??1,0,1)};await s.put('coupons',code,c);await audit(s,'coupon_saved');return{ok:true};
   }
   if(path==='/admin/affiliate'&&method==='POST'){
    const slug=text(body.slug||'',60).toLowerCase();if(!validSlug(slug))fail('Choose a unique lowercase store link.');const old=await s.get('affiliates',slug),goaffproId=text(body.goaffpro_id||'',100,false);if(goaffproId&&(await s.list('affiliates')).some(a=>a.slug!==slug&&a.goaffpro_id===goaffproId))fail('This GoAffPro affiliate already has a storefront. Edit that storefront instead.',409);const a={...old,slug,name:text(body.name||'',150),bio:text(body.bio||'',500,false),goaffpro_id:goaffproId,commission_bps:int(body.commission_bps??1500,0,10000),active:int(body.active??1,0,1)};await s.put('affiliates',slug,a);await audit(s,'affiliate_saved');return{ok:true};
   }
   if(path==='/admin/settings'&&method==='POST'){
    settings.shipping_cents=int(body.shipping_cents);settings.free_shipping_cents=int(body.free_shipping_cents??settings.free_shipping_cents);settings.payment_links=validateLinks(body.payment_links);await s.put('settings','main',settings);await audit(s,'settings_saved');return{ok:true};
   }
   if(path==='/admin/status'&&method==='POST'){
    const o=await s.get('orders',body.id);if(!o)fail('Order not found.',404);const target=body.status;
    if(target==='canceled'&&['awaiting_payment','payment_submitted'].includes(o.status)){await release(s,o,target);return{ok:true}}
    if(target==='paid'&&['awaiting_payment','payment_submitted'].includes(o.status)){if(body.verified!==true)fail('Confirm that the payment was received.');o.status='paid';o.paid=clock();await accounts.paid(s,o);o.shipstation_status='ready_for_test';o.goaffpro_status=o.affiliate?(o.is_test===false?'queued':'test_only'):'not_applicable';await s.put('outbox','shipstation-'+o.id,{id:'shipstation-'+o.id,provider:'shipstation',order_id:o.id,status:'not_connected',attempts:0});if(o.affiliate)await s.put('outbox','goaffpro-'+o.id,{id:'goaffpro-'+o.id,provider:'goaffpro',order_id:o.id,status:o.goaffpro_status,attempts:0});await audit(s,'payment_verified',o.id)}
    else if(target==='shipped'&&o.status==='paid'){o.status='shipped';o.tracking=text(body.tracking||'',150,false);await audit(s,'shipped',o.id)}
    else fail('This status change is not allowed.',409);await s.put('orders',o.id,o);return{ok:true};
   }
   if(path==='/admin/integrations'&&method==='GET')return{outbox:await s.list('outbox'),shipstation:{connected:false},goaffpro:goaffpro.status(await s.get('integrations','goaffpro'))};
   if(path==='/admin/goaffpro/preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing affiliate reporting.',409);return{dry_run:true,eligible:reporting.eligible(o),payload:reporting.payload(o),note:o.is_test!==false?'Test order: not sent to GoAffPro.':'Preview only; commission rates are determined by GoAffPro.'}}
   if(path==='/admin/shipment-preview'&&method==='POST'){const o=await s.get('orders',body.id);if(!o||!['paid','shipped'].includes(o.status))fail('Verify payment before preparing a shipment.',409);return{dry_run:true,provider:'shipstation',payload:shipmentPayload(o),note:'Not sent. Shipping services, package weights, discounts, account configuration and tracking callbacks need validation.'}}
   fail('Endpoint not found.',404);
  }
  fail('Endpoint not found.',404);
 });
 if(path==='/admin/status'&&method==='POST'&&body.status==='paid'&&result?.ok){try{result.goaffpro=await reporting.report(body.id)}catch{result.goaffpro={status:'failed',message:'Payment is saved. Affiliate reporting needs a later status check.'}}}
 return{status:result?._status||(method==='POST'&&path==='/orders'?201:200),headers:setCookie?{'Set-Cookie':setCookie}:{},body:result?._error?{error:result._error}:result};
}
module.exports={handle,quote,shipmentPayload,publicOrder};

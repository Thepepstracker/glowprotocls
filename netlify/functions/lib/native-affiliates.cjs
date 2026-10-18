'use strict';
// Zader's first-party program. Money is integer USD cents; ledger entries are append-only.
const crypto=require('node:crypto'),accounts=require('./customer-accounts.cjs');
const now=()=>Math.floor(Date.now()/1000),fail=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const isNative=a=>a?.brand==='zader'&&a?.provider==='native';
const brandOf=a=>a?.brand||'glow';
const storefront=a=>'https://zaderhealth.com/store-next/'+a.slug;
const clean=(v,max,required=true)=>{if(typeof v!=='string'||v.trim().length>max||(required&&!v.trim()))fail('Complete the affiliate fields within their length limits.');return v.trim()};
function slugValue(v){const slug=clean(v,60).toLowerCase();if(!require('./storefronts.cjs').validSlug(slug)||['admin','account','account-setup','staff-reset','profile','affiliate','merch','index','index-html'].includes(slug))fail('Choose a unique lowercase storefront name using letters, numbers and hyphens.');return slug}
const money=v=>{if(!Number.isSafeInteger(v)||v<1||v>100000000)fail('Enter a valid amount in cents.');return v};
async function mine(s,customer){return(await s.list('affiliates')).find(a=>isNative(a)&&a.customer_id===customer.id)||null}
async function entry(s,slug,kind,cents,extra={}){const w=await s.get('native_affiliate_wallets',slug)||{sequence:0,balance:0};w.sequence++;w.balance+=cents;if(!Number.isSafeInteger(w.balance))fail('Commission balance requires review.',409);const id=crypto.randomUUID();await s.put('native_affiliate_ledger',id,{id,brand:'zader',affiliate:slug,kind,cents,created:now(),sequence:w.sequence,balance_after:w.balance,...extra});await s.put('native_affiliate_wallets',slug,w)}
function commissionTarget(o,a){return isNative(a)&&o.brand==='zader'&&o.commission_provider==='native'&&o.is_test===false&&o.paid&&['paid','shipped'].includes(o.status)&&!o.balance_due_cents&&!o.refund_due_cents&&o.customer_id!==a.customer_id&&String(o.customer?.email||'').trim().toLowerCase()!==a.email?Math.max(0,Math.floor(Math.max(0,o.subtotal-o.discount)*(o.commission_bps||0)/10000)):0}
async function reconcileOrder(s,o){
 if(o.brand!=='zader')return;
 const previous=await s.get('native_affiliate_orders',o.id),a=o.affiliate&&await s.get('affiliates',o.affiliate),target=commissionTarget(o,a),slug=isNative(a)?a.slug:null;
 if(!previous&&!slug)return;
 if(previous&&previous.affiliate!==slug&&previous.cents)await entry(s,previous.affiliate,'commission_adjustment',-previous.cents,{order_id:o.id,note:'Order attribution adjusted'});
 const old=previous?.affiliate===slug?previous.cents:0;
 if(slug&&target!==old)await entry(s,slug,old===0&&target>0?'commission_earned':'commission_adjustment',target-old,{order_id:o.id,note:target<old?'Order balance, refund or eligibility changed':'Verified product commission'});
 await s.put('native_affiliate_orders',o.id,{order_id:o.id,affiliate:slug,cents:target,updated:now()});
}
async function reconcile(s){for(const o of await s.list('orders'))if(o.brand==='zader')await reconcileOrder(s,o)}
function tracked(s){return{...s,put:async(kind,key,value)=>{await s.put(kind,key,value);if(kind==='orders')await reconcileOrder(s,value)}}}
async function totals(s,slug){const ledger=(await s.list('native_affiliate_ledger')).filter(e=>e.brand==='zader'&&e.affiliate===slug);return{balance_cents:ledger.reduce((n,e)=>n+e.cents,0),earned_cents:ledger.filter(e=>e.kind!=='payout').reduce((n,e)=>n+e.cents,0),paid_cents:-ledger.filter(e=>e.kind==='payout').reduce((n,e)=>n+e.cents,0),ledger:ledger.sort((a,b)=>(b.sequence||0)-(a.sequence||0)||b.created-a.created)}}
function publicAffiliate(a){return{slug:a.slug,name:a.name,email:a.email,bio:a.bio||'',status:a.status,active:!!a.active,commission_bps:a.commission_bps,revision:a.revision||0,created:a.created,storefront_url:storefront(a),portal_url:'https://zaderhealth.com/store-next/affiliate'}}
async function portal(s,customer){await reconcile(s);const a=await mine(s,customer);if(!a)return{affiliate:null};const orders=(await s.list('orders')).filter(o=>o.brand==='zader'&&o.affiliate===a.slug&&o.is_test===false).sort((a,b)=>b.created-a.created);return{affiliate:{...publicAffiliate(a),photo_url:await s.get('affiliate_photos',a.slug)?'/.netlify/functions/store-next?route='+encodeURIComponent('/native-affiliates/photo'):null},...await totals(s,a.slug),coupons:(await s.list('coupons')).filter(c=>c.brand==='zader'&&c.affiliate===a.slug&&a.active&&c.active&&c.used<c.max_uses&&(!c.expires||c.expires>now())).map(c=>({code:c.code,kind:c.kind,value:c.value,allow_stacking:c.allow_stacking===true,expires:c.expires||0})),orders:orders.map(o=>({id:o.id,created:o.created,status:o.status,product_net_cents:Math.max(0,o.subtotal-o.discount),commission_cents:commissionTarget(o,a),pending_commission_cents:!o.paid&&o.status!=='canceled'&&o.status!=='expired'?(o.commission||0):0})),rules:{referral_days:30,commission_basis:'Product subtotal after all discounts; shipping and tax excluded.',self_referrals:false}}}
async function adminData(s){await reconcile(s);const affiliates=[];for(const a of await s.list('affiliates'))if(isNative(a))affiliates.push({...publicAffiliate(a),...await totals(s,a.slug)});return{affiliates,portal_url:'https://zaderhealth.com/store-next/affiliate',rules:{referral_days:30,payouts:'Record externally completed payments. No funds are transferred here.'}}}
async function apply(s,customer,b){if(await mine(s,customer))fail('An affiliate application already exists for this account.',409);return save(s,{name:customer.name,email:customer.email,slug:b.slug,bio:b.bio||'',status:'pending',commission_bps:null},'application',customer)}
async function save(s,b,actor,customer=null){
 const slug=slugValue(b.slug),old=await s.get('affiliates',slug);
 if(old&&!isNative(old))fail('This storefront name is already in use.',409);
 if(old&&b.expected_revision!==old.revision)fail('This affiliate changed. Refresh before saving.',409);
 const address=accounts.email(old?.email||b.email),id=accounts.hash(address);
 if((await s.list('affiliates')).some(a=>isNative(a)&&a.customer_id===id&&a.slug!==slug))fail('This email already has a Zader affiliate account.',409);
 const status=b.status||'pending';if(!['pending','approved','disabled'].includes(status))fail('Choose pending, approved or disabled.');
 const rate=b.commission_bps===null||b.commission_bps===undefined?null:b.commission_bps;if(rate!==null&&(!Number.isSafeInteger(rate)||rate<0||rate>10000))fail('Commission must be 0–100%.');
 if(status==='approved'&&rate===null)fail('Set a commission rate before approving this affiliate.');
 let account=customer||await s.get('customers',id);if(!account){account={id,email:address,name:clean(b.name,150),created:now(),verified:false,auth_version:0,password:null};await s.put('customers',id,account)}
 const a={...old,slug,name:clean(b.name,150),email:address,bio:clean(b.bio||'',500,false),brand:'zader',provider:'native',customer_id:id,status,active:status==='approved'?1:0,commission_bps:rate,goaffpro_id:'',revision:(old?.revision||0)+1,created:old?.created||now(),updated:now(),updated_by:actor};
 await s.put('affiliates',slug,a);return publicAffiliate(a);
}
async function updateProfile(s,customer,b){const a=await mine(s,customer);if(!a)fail('Apply to the affiliate program first.',404);if(b.expected_revision!==a.revision)fail('Your profile changed. Refresh and try again.',409);a.name=clean(b.name,150);a.bio=clean(b.bio||'',500,false);a.revision++;a.updated=now();await s.put('affiliates',a.slug,a);return publicAffiliate(a)}
async function recordPayout(s,b,actor){
 const a=await s.get('affiliates',slugValue(b.slug));if(!isNative(a))fail('Zader affiliate not found.',404);
 const amount=money(b.amount_cents),key=clean(b.idempotency_key,100),reference=clean(b.reference,200),method=clean(b.method,40);if(b.confirmed!==true)fail('Confirm the payment was already completed outside this dashboard.');
 const request={affiliate:a.slug,amount_cents:amount,reference,method},hash=crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex'),prior=await s.get('native_affiliate_payouts',key);
 if(prior){if(prior.request_hash!==hash)fail('This payout key was already used with different details.',409);return prior}
 await reconcile(s);const balance=(await totals(s,a.slug)).balance_cents;if(amount>balance)fail('The payout exceeds the current available commission balance.',409);
 // Reference is unique across the program, independently of the click idempotency key.
 if((await s.list('native_affiliate_payouts')).some(p=>p.method.toLowerCase()===method.toLowerCase()&&p.reference.toLowerCase()===reference.toLowerCase()))fail('This payment reference was already recorded.',409);
 const p={id:key,brand:'zader',...request,request_hash:hash,created:now(),recorded_by:actor};await entry(s,a.slug,'payout',-amount,{payout_id:key,reference,method,note:'Externally completed payment recorded by staff'});await s.put('native_affiliate_payouts',key,p);return p;
}
function validateSelf(a,customer){if(isNative(a)&&(customer.id===a.customer_id||accounts.email(customer.email)===a.email))fail('Affiliates cannot earn commission on their own purchases.')}
module.exports={isNative,brandOf,mine,apply,save,portal,adminData,updateProfile,recordPayout,commissionTarget,reconcileOrder,reconcile,tracked,validateSelf,totals};

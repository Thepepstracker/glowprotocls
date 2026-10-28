'use strict';
const crypto=require('node:crypto'),{promisify}=require('node:util'),scrypt=promisify(crypto.scrypt),{transaction}=require('./store-db.cjs');
const emails=require('./store-email.cjs');const brands=require('./brands.cjs');
const now=()=>Math.floor(Date.now()/1000),hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function email(v){if(typeof v!=='string'||v.length>150||!/^\S+@[^\s@]+\.[^\s@]+$/.test(v.trim())||v.trim().split('@').length!==2)fail('Enter a valid email address.');return v.trim().toLowerCase()}
function password(v){if(typeof v!=='string'||v.length<15||v.length>128)fail('Use a password or passphrase with 15–128 characters.');return v}
function clean(v,max=150){if(typeof v!=='string'||!v.trim()||v.trim().length>max)fail('Complete the required fields.');return v.trim()}
async function passwordHash(v,salt=crypto.randomBytes(16).toString('hex')){const derived=await scrypt(v,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});return{algorithm:'scrypt-v1',salt,hash:derived.toString('hex')}}
async function passwordMatches(v,stored){const derived=await passwordHash(typeof v==='string'&&v.length<=128?v:'',stored?.salt||'00000000000000000000000000000000');return !!stored&&stored.algorithm==='scrypt-v1'&&crypto.timingSafeEqual(Buffer.from(derived.hash,'hex'),Buffer.from(stored.hash,'hex'))}
const cookieName='glow_next_customer';
function cookie(token='',age=604800){return`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${process.env.STORE_LOCAL?'':'; Secure'}`}
async function session(s,h,required=false){const token=(h.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);const record=token&&await s.get('customer_sessions',hash(token)),a=record&&record.expires>now()&&await s.get('customers',record.customer_id);if(!a||!a.verified||record.auth_version!==a.auth_version){if(required)fail('Sign in to your customer account.',401);return null}return a}
async function newSession(s,a){const token=crypto.randomBytes(32).toString('base64url');await s.put('customer_sessions',hash(token),{customer_id:a.id,auth_version:a.auth_version,expires:now()+604800});return cookie(token)}
async function rate(kind,key,limit,seconds){const allowed=await transaction(async s=>{const k=hash(kind+':'+key),old=await s.get('customer_limits',k),r=old?.until>now()?old:{count:0,until:now()+seconds};if(r.count>=limit)return false;r.count++;await s.put('customer_limits',k,r);return true});if(!allowed)fail('Too many requests. Please try again later.',429)}
async function wallet(s,id){return await s.get('rewards_wallets',id)||{customer_id:id,balance:0,reserved:0}}
// Glow Points levels (Jonah, 23 Oct 2026): set by lifetime points EARNED (orders, bonuses, referrals, adjustments — redeeming never lowers it),
// counted before the points being earned now. Changed from lifetime spend to points earned the same day, at Jonah's request.
const TIERS=[{id:'purple',name:'Purple',min_points:1500,multiplier:2},{id:'gold',name:'Gold',min_points:500,multiplier:1.5},{id:'blue',name:'Blue',min_points:0,multiplier:1}];
const EARN_KINDS=['earned','opening_balance','migration_reconciliation','order_adjustment','staff_adjustment','signup_bonus','referral_bonus'];
const SIGNUP_BONUS=100,REFERRAL_BONUS=200,REFERRAL_MIN_CENTS=5000,BONUS_FROM=1792728000; // when switched on (settings.rewards_bonuses.on), signup bonuses go to accounts created from 23 Oct 2026 00:00 ET
async function bonusesOn(s){const st=await s.get('settings','main');return st?.rewards_bonuses?.on===true?(st.rewards_bonuses.from||BONUS_FROM):null}
function tierFor(points){return TIERS.find(t=>points>=t.min_points)}
function nextTier(points){const up=TIERS.slice().reverse().find(t=>t.min_points>points);return up?{id:up.id,name:up.name,multiplier:up.multiplier,needed_points:up.min_points-points}:null}
async function lifetimePoints(s,id){let n=0;for(const e of await s.list('rewards_ledger'))if(e.customer_id===id&&EARN_KINDS.includes(e.kind))n+=e.points||0;return Math.max(0,n)}
function productCents(o){return Math.max(0,(o.subtotal||0)-(o.discount||0))}
function emailId(o){try{return hash(email(o.customer?.email||''))}catch{return null}}
function doubleOn(settings,ts){return (settings?.double_points?.windows||[]).some(w=>ts>=w.from&&ts<w.until)}
async function earnFor(s,id,o){const base=Math.floor(productCents(o)/100),t=tierFor(await lifetimePoints(s,id)),dbl=doubleOn(await s.get('settings','main'),o.created||now())?2:1;return{points:Math.floor(base*t.multiplier*dbl),tier:t.id,multiplier:t.multiplier*dbl,double:dbl===2}}
function earnNote(e){const lv=TIERS.find(t=>t.id===e.tier);const why=[e.tier!=='blue'?lv.name+' level ×'+lv.multiplier:'',e.double?'double points ×2':''].filter(Boolean);return '1 point per whole dollar of products after all discounts'+(why.length?' · '+why.join(' · '):'')}
function referralCode(id){return hash('friend:'+id).slice(0,10)}
async function signupBonus(s,a){if(!a?.verified)return;const from=await bonusesOn(s);if(from===null||(a.created||0)<from)return;await event(s,a.id,'signup-bonus','signup_bonus',SIGNUP_BONUS,0,null,'Welcome bonus for creating your Glow account')}
// Why a referred order does NOT earn the referrer their bonus, in plain words (null = it qualifies). Same checks, same order as before.
async function referralWhy(s,o){if(o.is_test!==false)return 'Test order';if(!o.referred_by)return 'No friend link on this order';if(!brands.orderBrand(o)?.rewards)return 'This store has no Glow Points';if(await bonusesOn(s)===null)return 'Referral bonuses are switched off in Settings';if((Number(o.subtotal)||0)-(Number(o.discount)||0)<REFERRAL_MIN_CENTS)return 'The friend\u2019s order was under $50 (products after discounts, not counting shipping)';const buyer=emailId(o);if(!buyer)return 'The order has no email';if(buyer===o.referred_by)return 'They used their own link';const ref=await s.get('customers',o.referred_by);if(!ref?.verified)return 'The person who shared the link has not finished setting up their account';
 const all=await s.list('orders');
 for(const x of all)if(x.id!==o.id&&x.is_test===false&&['paid','shipped'].includes(x.status)&&(x.customer_id===buyer||emailId(x)===buyer)&&(x.created||0)<(o.created||0))return 'This friend had already ordered before, so it is not their first order';
 // Jonah 23 Oct: no sending the link to people who already have an account, and no cheating with a second email.
 const acct=await s.get('customers',buyer);if(acct&&(acct.created||0)<(o.created||0)-3600)return 'This friend already had an account before this order';
 const addr=c=>{const a=String(c?.address||'').toLowerCase().replace(/[^a-z0-9]/g,''),z=String(c?.zip||'').replace(/[^0-9]/g,'').slice(0,5);return a&&z?a+'|'+z:''},phone=c=>String(c?.phone||'').replace(/[^0-9]/g,'').slice(-10);
 const oa=addr(o.customer),op=phone(o.customer);
 for(const x of all)if(x.id!==o.id&&x.is_test===false&&(x.customer_id===ref.id||emailId(x)===ref.id)){if(oa&&addr(x.customer)===oa)return 'Same shipping address as the person who shared the link';if(op.length===10&&phone(x.customer)===op)return 'Same phone number as the person who shared the link'}
 return null}
async function referralPaid(s,o){if(await referralWhy(s,o))return false;const buyer=emailId(o);
 const ok=await event(s,o.referred_by,'referral:'+buyer,'referral_bonus',REFERRAL_BONUS,0,o.id,'Referral bonus: a friend you referred paid for their first order');if(ok)o.referral_bonus_awarded=REFERRAL_BONUS;return ok}
async function rewardsInfo(s,a){const pts=await lifetimePoints(s,a.id),t=tierFor(pts),code=referralCode(a.id);if(a.verified&&!(await s.get('referral_codes',code)))await s.put('referral_codes',code,{customer_id:a.id,created:now()});const st=await s.get('settings','main');const live=(st?.double_points?.windows||[]).find(w=>now()>=w.from&&now()<w.until);
 return{tier:{id:t.id,name:t.name,multiplier:t.multiplier},points_lifetime:pts,next:nextTier(pts),tiers:TIERS.map(x=>({id:x.id,name:x.name,min_points:x.min_points,multiplier:x.multiplier})),bonuses_on:(await bonusesOn(s))!==null,referral_code:a.verified?code:null,signup_bonus:SIGNUP_BONUS,referral_bonus:REFERRAL_BONUS,double_points_until:live?live.until:null}}
function publicWallet(w){return{balance:w.balance,reserved:w.reserved,available:Math.max(0,w.balance-w.reserved),value_cents:Math.max(0,w.balance-w.reserved)*5}}
async function event(s,id,key,kind,points,reserved_delta=0,order_id=null,note=''){const eventId=id+':'+key;if(await s.get('rewards_ledger',eventId))return false;const w=await wallet(s,id);w.balance+=points;w.reserved+=reserved_delta;w.sequence=(w.sequence||0)+1;if(!Number.isSafeInteger(w.balance)||!Number.isSafeInteger(w.reserved)||w.reserved<0)fail('Rewards ledger requires review.',409);await s.put('rewards_wallets',id,w);await s.put('rewards_ledger',eventId,{id:eventId,customer_id:id,kind,points,reserved_delta,order_id,note,created:now(),balance_after:w.balance,reserved_after:w.reserved,sequence:w.sequence});return true}
async function claimMigration(s,a){const pending=await s.get('rewards_imports',a.id);if(!a.verified||!pending||pending.claimed||pending.held)return;await event(s,a.id,'migration-opening','opening_balance',pending.points,0,null,'Balance carried from WooCommerce');pending.claimed=true;pending.claimed_at=now();await s.put('rewards_imports',a.id,pending)}
// A guest who later creates (and verifies) an account with the same email gets the points for their
// earlier paid orders, exactly as if they had been signed in: 1 point per whole dollar after discounts.
async function claimGuestOrders(s,a){if(!a?.verified)return 0;let n=0;for(const o of (await s.list('orders')).sort((x,y)=>(x.created||0)-(y.created||0))){
 if(o.is_test!==false||o.customer_id||!o.paid||!['paid','shipped'].includes(o.status)||o.refund_due_cents)continue;
 const b=brands.orderBrand(o);if(!b?.rewards)continue;
 let addr;try{addr=email(o.customer?.email||'')}catch{continue}if(hash(addr)!==a.id)continue;
 const e=await earnFor(s,a.id,o);o.customer_id=a.id;o.points_earned=e.points;o.points_tier=e.tier;o.points_multiplier=e.multiplier;o.points_claimed_at=now();await s.put('orders',o.id,o);
 if(o.points_earned)await event(s,a.id,'earn:'+o.id,'earned',o.points_earned,0,o.id,'Claimed after creating an account: '+earnNote(e));n++}return n}
async function accountData(s,a){await claimMigration(s,a);await claimGuestOrders(s,a);await signupBonus(s,a);return{customer:{id:a.id,name:a.name,email:a.email,verified:a.verified},rewards:await rewardsInfo(s,a),wallet:publicWallet(await wallet(s,a.id)),ledger:(await s.list('rewards_ledger')).filter(e=>e.customer_id===a.id).sort((x,y)=>y.created-x.created||(y.sequence||0)-(x.sequence||0)),orders:(await s.list('orders')).filter(o=>o.customer_id===a.id).map(o=>({id:o.id,status:o.status,total:o.total,created:o.created,is_test:o.is_test,points_redeemed:o.points_redeemed||0,points_earned:o.points_earned||0,balance_due_cents:o.balance_due_cents||0,refund_due_cents:o.refund_due_cents||0})),rules:{earn_points_per_dollar:1,point_value_cents:5,expires:false,promo_stacking:true},email_delivery:emails.configuration().ready?'automatic':'manual'} }
async function issueSetup(s,id){const a=await s.get('customers',id);if(!a)fail('Customer not found.',404);const token=crypto.randomBytes(32).toString('base64url');a.setup={token_hash:hash(token),expires:now()+86400};await s.put('customers',id,a);return{customer_id:id,email:a.email,token,expires:a.setup.expires}}
async function setupAccount(s,id,token){const a=await s.get('customers',id);if(!a?.setup||a.setup.expires<=now()||typeof token!=='string'||!crypto.timingSafeEqual(Buffer.from(a.setup.token_hash,'hex'),Buffer.from(hash(token),'hex')))fail('This account setup link is unavailable or expired.',403);return a}
async function authRoute(path,body,h,method){
 const ip=h['x-nf-client-connection-ip']||h['x-forwarded-for']||'local';
 if(['/account/register','/account/forgot-password'].includes(path)&&method==='POST'){
  const address=email(body.email),register=path==='/account/register',name=register?clean(body.name):null;
  await rate(register?'register':'reset-ip',ip,10,3600);await rate('setup-email',address,5,3600);
  const job=await transaction(async s=>{
   const id=hash(address);let a=await s.get('customers',id);
   // Customers from the old site have no record here yet; "Set up or reset your password" must still email them a link.
   if(!a){a={id,email:address,name:name||'',created:now(),verified:false,auth_version:0,password:null};await s.put('customers',id,a)}
   const held=await s.get('rewards_imports',id);if(!emails.configuration().ready||!a||held?.held||address.endsWith('@gmail.coml')||(register&&a.verified)||(a.last_setup_email||0)>now()-300)return null;
   const link=await issueSetup(s,id);a=await s.get('customers',id);a.last_setup_email=now();await s.put('customers',id,a);return emails.queueSetup(s,link,a.verified,brands.fromHeaders(h).id);
  });
  await emails.safeDispatch(job);
  return{status:200,headers:{},body:{ok:true,message:emails.configuration().ready?'If this address is eligible, a private setup or reset link will arrive shortly. Check your inbox and spam folder.':'Your request has been received. Contact the store for a private setup/reset link sent to your email. Automatic email delivery is not enabled yet.'}};
 }

 if(path==='/account/login'&&method==='POST'){const address=email(body.email);await rate('login-ip',ip,30,900);await rate('login-email',address,10,900);const snapshot=await transaction(s=>s.get('customers',hash(address))),valid=await passwordMatches(body.password,snapshot?.password);if(!valid||!snapshot?.verified)fail('Email or password is incorrect.',401);return transaction(async s=>{const a=await s.get('customers',snapshot.id);if(!a.verified||a.auth_version!==snapshot.auth_version)fail('Email or password is incorrect.',401);return{status:200,headers:{'Set-Cookie':await newSession(s,a)},body:await accountData(s,a)}})}
 if(path==='/account/setup'&&method==='POST'){const id=clean(body.customer_id,64);if(!/^[a-f0-9]{64}$/.test(id))fail('Invalid account setup link.');await rate('setup',ip,15,900);await transaction(s=>setupAccount(s,id,body.token));const derived=await passwordHash(password(body.password));return transaction(async s=>{const a=await setupAccount(s,id,body.token);a.password=derived;a.verified=true;a.auth_version++;delete a.setup;await s.put('customers',id,a);await claimMigration(s,a);return{status:200,headers:{'Set-Cookie':await newSession(s,a)},body:await accountData(s,a)}})}
 return null;
}
async function reserve(s,o){if(o.is_test!==false||!o.customer_id||!o.points_redeemed)return;const w=await wallet(s,o.customer_id);if(w.balance-w.reserved<o.points_redeemed)fail('Your available points changed. Review the order again.',409);await event(s,o.customer_id,'reserve:'+o.id+(o.reservation_version?':'+o.reservation_version:''),'reserved',0,o.points_redeemed,o.id,'Points held for this unpaid order')}
async function release(s,o){if(o.is_test!==false||!o.customer_id||!o.points_redeemed)return;await event(s,o.customer_id,'release:'+o.id+(o.reservation_version?':'+o.reservation_version:''),'released',0,-o.points_redeemed,o.id,'Unpaid order canceled or expired')}
async function paid(s,o){if(o.is_test!==false||!o.customer_id)return;const a=await s.get('customers',o.customer_id);if(!a?.verified)return;if(o.points_redeemed)await event(s,a.id,'spend:'+o.id,'redeemed',-o.points_redeemed,-o.points_redeemed,o.id,'Points redeemed after verified payment');const e=await earnFor(s,a.id,o);o.points_earned=e.points;o.points_tier=e.tier;o.points_multiplier=e.multiplier;await event(s,a.id,'earn:'+o.id,'earned',o.points_earned,0,o.id,earnNote(e))}
function importRows(b){const rows=b.customers;if(!Array.isArray(rows)||!rows.length||rows.length>2000)fail('Upload a migration file with 1–2,000 customer rows.');const seen=new Set();return rows.map(r=>{const address=email(r.email);if(seen.has(address))fail('Duplicate email in migration file.');seen.add(address);if(!Number.isSafeInteger(r.points)||r.points<0||r.points>10000000)fail('Invalid points balance in migration file.');if(r.redeem_points!==null&&(!Number.isSafeInteger(r.redeem_points)||r.redeem_points<0))fail('Invalid redeemed points history.');return{id:hash(address),email:address,source_name:clean(r.source_name),points:r.points,redeem_points:r.redeem_points,held:address.endsWith('@gmail.coml'),claimed:false}})}
async function previewImport(s,b){
 const rows=importRows(b),id=crypto.randomBytes(16).toString('hex'),existing=await s.list('rewards_imports');
 const changes=rows.flatMap(r=>{const old=existing.find(x=>x.id===r.id);return old&&(old.points!==r.points||old.redeem_points!==r.redeem_points)?[{email:r.email,previous_points:old.points,points:r.points,delta:r.points-old.points}]:[]});
 const baseline=Object.fromEntries(rows.map(r=>{const old=existing.find(x=>x.id===r.id);return[r.id,old?{points:old.points,redeem_points:old.redeem_points}:null]}));
 await s.put('rewards_batches',id,{id,rows,baseline,created:now(),expires:now()+3600});
 return{batch_id:id,count:rows.length,points_total:rows.reduce((n,r)=>n+r.points,0),held:rows.filter(r=>r.held).map(r=>({email:r.email,reason:'Possible email typo: gmail.coml'})),conflicts:changes.map(r=>r.email),changes,points_delta:changes.reduce((n,r)=>n+r.delta,0),existing_count:rows.filter(r=>existing.some(e=>e.id===r.id)).length,missing_redeem_history:rows.filter(r=>r.redeem_points===null).length};
}
async function reconcileBatch(s,id){
 const b=await s.get('rewards_batches',id);if(!b||b.expires<=now())fail('Preview the migration file again before reconciling.');if(b.reconciled)return b.reconciled;if(!b.baseline)fail('Preview the migration file again before reconciling.');
 for(const r of b.rows){const old=await s.get('rewards_imports',r.id),base=b.baseline[r.id];if((!old)!==(!base)||(old&&(old.points!==base.points||old.redeem_points!==base.redeem_points)))fail('Imported source balances changed after this preview. Preview again.',409)}
 let added=0,updated=0,points_delta=0;
 for(const r of b.rows){let old=await s.get('rewards_imports',r.id),a=await s.get('customers',r.id);
  if(!old){await s.put('rewards_imports',r.id,r);if(!a&&!r.held){a={id:r.id,email:r.email,name:r.source_name,created:now(),verified:false,auth_version:0,password:null};await s.put('customers',r.id,a)}if(a?.verified)await claimMigration(s,a);added++;continue}
  const delta=r.points-old.points;if(delta||old.redeem_points!==r.redeem_points){if(old.claimed&&delta&&!old.held)await event(s,r.id,'migration-reconcile:'+id,'migration_reconciliation',delta,0,null,'WooCommerce source balance reconciliation: '+old.points+' → '+r.points+' points; new-store rewards preserved');points_delta+=delta;updated++}
  old={...old,points:r.points,redeem_points:r.redeem_points,reconciled_at:now()};await s.put('rewards_imports',r.id,old);
 }
 b.reconciled={added,updated,points_delta,held:b.rows.filter(r=>r.held).length};await s.put('rewards_batches',id,b);return b.reconciled;
}
async function importBatch(s,id){const b=await s.get('rewards_batches',id);if(!b||b.expires<=now())fail('Preview the migration file again before importing.');let added=0,existing=0;for(const r of b.rows){const old=await s.get('rewards_imports',r.id);if(old){if(old.points!==r.points||old.redeem_points!==r.redeem_points||old.email!==r.email)fail('A previous imported balance differs. Review it before importing again.',409);existing++;continue}await s.put('rewards_imports',r.id,r);let a=await s.get('customers',r.id);if(!a&&!r.held){a={id:r.id,email:r.email,name:r.source_name,created:now(),verified:false,auth_version:0,password:null};await s.put('customers',r.id,a)}if(a?.verified)await claimMigration(s,a);added++}return{added,existing,held:b.rows.filter(r=>r.held).length}}
async function adminData(s){const people=await s.list('customers'),pending=await s.list('rewards_imports'),customers=[];for(const a of people)customers.push({...((await accountData(s,a)).customer),created:a.created,phone:a.phone||'',updated:a.updated||0,profile_revision:a.profile_revision||0,setup_requested:!!a.setup,wallet:publicWallet(await wallet(s,a.id))});return{customers,imports:pending.map(r=>({email:r.email,source_name:r.source_name,points:r.points,redeem_points:r.redeem_points,held:r.held,claimed:r.claimed})),ledger:(await s.list('rewards_ledger')).sort((a,b)=>b.created-a.created),rules:{earn_points_per_dollar:1,point_value_cents:5,expires:false,promo_stacking:true}}}
module.exports={BONUS_FROM,lifetimePoints,tierFor,doubleOn,referralWhy,referralPaid,referralCode,TIERS,SIGNUP_BONUS,REFERRAL_BONUS,claimGuestOrders,passwordHash,passwordMatches,email,hash,session,authRoute,cookie,accountData,issueSetup,wallet,publicWallet,event,reserve,release,paid,previewImport,importBatch,reconcileBatch,adminData,claimMigration};


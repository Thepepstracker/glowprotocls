'use strict';
// Free VIP peptide in every Subscribe & save box (Jonah, 13 Nov 2026): a Skool VIP member who also has an active
// subscription picks one peptide under $50 in her account, and every subscription box made for her includes it at $0.
// Her pick is saved on her store account, so it rides along on her first box and on every repeat box after it.
// Nothing here changes what she pays: the gift line is $0 and never counts toward the box price, discounts or points.
// Research-use-only store: no health, dose or use wording in this file.
const now=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const CAP_CENTS=5000,TAG='VIP gift';
// Peptide vials only: no supplies (BAC water, acetic acid), topicals, magnets, merch, kits or bundles.
const NOT_PEPTIDE=/^(bac-water|acetic-acid|magnet-|merch-|cosmetic-|protocol-0|glow-eyes|rose-recovery|cu-hair|sterile|syringe)/i;
function eligible(p){return !!p&&p.active!==false&&p.active!==0&&(p.brand||'glow')==='glow'&&Number.isSafeInteger(p.price)&&p.price>0&&p.price<CAP_CENTS&&p.category!=='merch'&&p.category!=='cosmetic'&&!NOT_PEPTIDE.test(String(p.sku||''))&&!(Number(p.units)>1)&&!(Array.isArray(p.components)&&p.components.length)&&p.members_only!==true}
const short=n=>String(n||'').replace(/\s*·\s*/g,' · ').trim();
async function options(s){return (await s.list('products')).filter(p=>eligible(p)&&(p.stock||0)>0).map(p=>({id:p.id,name:p.name,price:p.price})).sort((a,b)=>a.name.localeCompare(b.name))}
// A VIP is an active Skool member on the VIP level while the member perks switch is ON.
async function isVip(s,email){const members=require('./skool-members.cjs');const cfg=await members.config(s);if(!cfg.enabled||!email)return false;const m=await s.get('members',members.norm(email));return members.isActive(m)&&m.level==='vip'}
const LIVE=['active','pending_first_payment','paused'];
async function hasSubscription(s,a){const e=String(a.email||'').toLowerCase();return (await s.list('subscriptions')).some(x=>LIVE.includes(x.status)&&(x.customer_id===a.id||String(x.customer?.email||'').toLowerCase()===e))}
// Account page view: shown to VIPs only.
async function view(s,a){if(!await isVip(s,a.email))return null;const sub=await hasSubscription(s,a),choice=Number(a.vip_gift_id)||null,p=choice?await s.get('products',choice):null;
 return{cap_cents:CAP_CENTS,subscribed:sub,choice:p&&eligible(p)?{id:p.id,name:p.name,price:p.price,in_stock:(p.stock||0)>0}:null,options:await options(s)}}
async function save(s,a,productId){if(!await isVip(s,a.email))fail('The free peptide is for Skool VIP members.',403);
 const id=Number(productId)||0;const acct=await s.get('customers',a.id);if(!acct)fail('Account not found.',404);
 if(!id){delete acct.vip_gift_id;acct.vip_gift_saved_at=now();await s.put('customers',acct.id,acct);return{ok:true}}
 const p=await s.get('products',id);if(!eligible(p))fail('Choose a peptide under $'+CAP_CENTS/100+' from the list.');if((p.stock||0)<1)fail('That one is sold out right now. Choose another.',409);
 acct.vip_gift_id=p.id;acct.vip_gift_saved_at=now();await s.put('customers',acct.id,acct);return{ok:true}}
// The $0 line for one subscription box, or a note when her pick can't go in this time. lineFor(id) returns a priced
// order line for 1 of that product (same shape as the box's other lines).
async function line(s,email,lineFor){
 if(!await isVip(s,email))return null;const accounts=require('./customer-accounts.cjs');let id;try{id=accounts.hash(accounts.email(email))}catch{return null}
 const acct=await s.get('customers',id),pick=Number(acct?.vip_gift_id)||0;if(!pick)return null;const p=await s.get('products',pick);
 if(!eligible(p)||(p.stock||0)<1)return{line:null,note:'⭐ VIP gift: '+(p?short(p.name):'her pick')+' is unavailable, so it was not added. Ask her to choose another.'};
 let l;try{l=await lineFor(p.id)}catch{return{line:null,note:'⭐ VIP gift: '+short(p.name)+' could not be added.'}}
 return{line:{...l,quantity:1,name:l.name+' · '+TAG,list_price:l.price,price:0,amount:0,promo_excluded:true,gift:'vip'},note:'⭐ VIP gift: 1× '+short(p.name)+' (free)',record:{product_id:p.id,name:p.name,value_cents:p.price}}}
async function route(path,method,h,body,{transaction,accounts,staffSession}){
 // Team: set a VIP's pick for her (e.g. from a message). Signed-in team only; the same rules as her own pick.
 if(path==='/admin/vip-gift'&&method==='POST')return{status:200,headers:{},body:await transaction(async s=>{await staffSession(s,h);let id;try{id=accounts.hash(accounts.email(String(body.email||'')))}catch{fail('Enter the customer\'s account email.')}const a=await s.get('customers',id);if(!a)fail('No store account uses that email yet.',404);await save(s,a,body.product_id);return{gift:await view(s,await s.get('customers',a.id))}})};
 if(path==='/account/vip-gift'&&method==='GET')return{status:200,headers:{},body:await transaction(async s=>({gift:await view(s,await accounts.session(s,h,true))}))};
 if(path==='/account/vip-gift'&&method==='POST')return{status:200,headers:{},body:await transaction(async s=>{const a=await accounts.session(s,h,true);await save(s,a,body.product_id);return{gift:await view(s,await s.get('customers',a.id))}})};
 return null}
module.exports={CAP_CENTS,TAG,eligible,options,isVip,hasSubscription,view,save,line,route};

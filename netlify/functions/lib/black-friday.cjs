'use strict';
// Black Friday 2026 (Jonah + Heather, 22 Nov 2026: "It's a Wonderful Life" catalog, launch Monday 23 Nov 2026).
//
// One switch in Management (owner only) turns the whole sale on or off:
//  ON  - every catalog item (FIXED below) gets its catalog price; everything else Glow sells is 30% off its regular price,
//        rounded to the whole dollar (the catalog's own examples: GLOW 70 mg $102.99 -> $72). Both are stored as the
//        product's introductory price, so the shop, product page, bag, checkout and dashboard all show the regular price
//        struck through and the sale price, and the existing "no doubling up" rule keeps codes, affiliate codes and the
//        Skool member % off them. Catalog items also take no Glow Points and no subscribe discount (black_friday:'fixed').
//        The catalog's new products (gift boxes, minis, research sets, boutique) are switched on.
//        Subscribe & save: the FIRST box of a new subscription is 40% off the regular price for 30%-off items
//        (black_friday:'pct'); renewals stay at the normal subscriber price.
//  OFF - every product goes back exactly as it was before ON (saved in integrations/black-friday), the catalog-only
//        products are hidden again, and subscriptions are back to 15% off.
const {transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const usd=d=>Math.round(d*100);
// [match, sale cents, was cents or null]. match = product id (existing products) or SKU (products made for the catalog).
const FIXED=[
 // Serum gift boxes
 ['bf-wonderful-life-collection',usd(179),usd(300.97)],['bf-the-grand-gift',usd(112),usd(186.99)],['bf-home-for-christmas',usd(80),usd(132.99)],
 ['bf-angels-wings-duo',usd(68),usd(112.99)],['bf-the-homecoming',usd(65),usd(109)],['bf-snowfall-trio',usd(61),usd(100.99)],['bf-the-bell-ringer-duo',usd(43),usd(71.99)],
 // Stocking stuffers
 ['bf-the-little-bells',usd(10),null],['bf-the-mantel-minis',usd(20),null],
 // Research bundles
 [57,usd(99),usd(169.99)],['bf-mito-31-2-vial-set',usd(49),usd(85.98)],['bf-radiance-reset-duo',usd(54),usd(79)],
 // Single items at catalog prices
 [23,usd(52),usd(86.99)],[160,usd(55),usd(92)],[106,usd(59),usd(97.99)],[13,usd(27),usd(44.99)],[103,usd(50),usd(83.99)],[11,usd(47),usd(78)],[10,usd(44),usd(68)],
 [43,usd(41),usd(69)],[6,usd(23),usd(34)],[304,usd(34),usd(79.99)],[7,usd(25),null],[4,usd(3),null],
 // The Bedford Falls Boutique
 [/^merch-bf-lasso-the-moon-/,usd(35),usd(57.99)],[/^merch-pep-ho-for-life-tee-/,usd(22),usd(32)],['merch-bf-pep-ho-tote',usd(11),usd(16)],['merch-bf-pep-ho-pouch',usd(7),usd(9.99)],
];
// Pep Ho for Life Tee: ids 78-95 (black, white, purple, S-3XL). Matched by id too in case a SKU differs.
const PEP_TEE_IDS=new Set([78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95]);
function fixedFor(p){if(PEP_TEE_IDS.has(p.id))return [null,usd(22),usd(32)];const sku=String(p.sku||'').toLowerCase();
 return FIXED.find(([m])=>typeof m==='number'?m===p.id:m instanceof RegExp?m.test(sku):m===sku)||null}
const isCatalogOnly=p=>/^(merch-)?bf-/.test(String(p.sku||'').toLowerCase());
// Minis are parts of the stocking-stuffer bundles only; never sold on their own.
const isPart=p=>/^bf-mini-/.test(String(p.sku||'').toLowerCase());
// A bigger size must never cost less than (or the same as) a smaller one during the sale (Jonah, 22 Nov 2026 price audit).
// 30% off left these two out of line with the catalog's own prices next to them: GLP-2T 30 mg would be $69 while the
// catalog's 40 mg is $50, and GLP-3R 5 mg would be $27, the same as the catalog's 10 mg. Their sale price is lowered.
// 5 days only (Jonah, 23 Nov 2026: "5 days only. $199 GHK-Cu 100mg, TIRZ 15mg, Ipamorelin 10mg, Mots-c 10mg,
// BPC-157 10mg, Melanotan 2, NAD+ 500mg" ... "Yes, each kit $199"): each of these Kits of 10 is $199 (or its 30%-off
// price if that is already lower) until Fri 27 Nov 11:59:59 PM ET, then it goes back to 30% off for the rest of the sale.
// Treated like a catalog price: no codes, no subscribe discount.
const KIT_DEAL_UNTIL=1795841999,KIT_DEAL_PRICE=usd(199);
const KIT_DEALS=new Set([230,232,257,228,253,200,229]); // GHK-Cu 100, GLP-2T 15, Ipamorelin 10, MOTS-C 10, BPC-157 10, Melanotan 2 10, NAD+ 500
const kitDeal=(p,t)=>KIT_DEALS.has(p.id)&&t<=KIT_DEAL_UNTIL;
const SIZE_FIX={12:usd(49),104:usd(24)};
const pct30=cents=>Math.round(cents*0.7/100)*100;
const glow=p=>(p.brand||'glow')==='glow';
const KEEP=['price','regular_price','intro_price','intro_active','promo_excluded','active','black_friday','bf_deal'];
// What the sale does to one product (pure, for tests and the preview).
function plan(p,t=now()){
 if(!glow(p)||isPart(p))return null;
 const reg=Math.max(Number(p.regular_price)||0,Number(p.price)||0),f=fixedFor(p);
 if(reg&&kitDeal(p,t)){const sale=Math.min(KIT_DEAL_PRICE,pct30(reg));return{black_friday:'fixed',bf_deal:'kit5',regular_price:reg,intro_price:sale,intro_active:true,price:sale,promo_excluded:true}}
 if(f){const [,sale,was]=f;const regular=was||sale;return{black_friday:'fixed',regular_price:regular,intro_price:was&&sale<regular?sale:null,intro_active:!!(was&&sale<regular),price:sale,promo_excluded:true,...(isCatalogOnly(p)?{active:1}:{})}}
 if(!reg)return null;let sale=pct30(reg);if(SIZE_FIX[p.id]&&SIZE_FIX[p.id]<sale)sale=SIZE_FIX[p.id];if(!(sale<reg)||sale<=0)return null;
 return{black_friday:'pct',regular_price:reg,intro_price:sale,intro_active:true,price:sale}}
async function state(s){return await s.get('integrations','black-friday')||{id:'black-friday',on:false,snapshot:{}}}
async function preview(s){const out=[];for(const p of await s.list('products')){const n=plan(p);if(!n)continue;out.push({id:p.id,sku:p.sku,name:p.name,active:!!p.active||n.active===1,was:p.price,now:n.price,regular:n.regular_price,kind:n.black_friday})}return out.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name))}
async function turnOn(s,by){const st=await state(s);if(st.on)return{already:true,on:true};const snapshot={};let n=0;
 for(const p of await s.list('products')){const next=plan(p);if(!next)continue;snapshot[p.id]=Object.fromEntries(KEEP.map(k=>[k,p[k]===undefined?null:p[k]]));Object.assign(p,next);if(!next.intro_active){p.intro_price=null;p.intro_active=false}p.offer_revision=(p.offer_revision||0)+1;await s.put('products',p.id,p);n++}
 Object.assign(st,{on:true,since:now(),by,snapshot,changed:n});await s.put('integrations','black-friday',st);
 const settings=await s.get('settings','main');settings.black_friday={...(settings.black_friday||{}),on:true,since:st.since};await s.put('settings','main',settings);return{on:true,changed:n}}
async function turnOff(s,by){const st=await state(s);if(!st.on)return{already:true,on:false};let n=0;
 for(const [id,was] of Object.entries(st.snapshot||{})){const p=await s.get('products',Number(id));if(!p)continue;for(const k of KEEP){if(was[k]===null)delete p[k];else p[k]=was[k]}p.offer_revision=(p.offer_revision||0)+1;await s.put('products',p.id,p);n++}
 Object.assign(st,{on:false,ended:now(),ended_by:by,restored:n,snapshot:{}});await s.put('integrations','black-friday',st);
 const settings=await s.get('settings','main');settings.black_friday={on:false,ended:st.ended};await s.put('settings','main',settings);return{on:false,restored:n}}
const on=settings=>settings?.black_friday?.on===true;
// Scheduled start / end (Jonah: "this all goes live at 12 am"). Checked on every store request, so it happens on time
// without anyone pressing anything. start_at / end_at are unix seconds.
async function tick(s,settings,t=now()){const b=settings?.black_friday||{};
 if(!b.on&&b.start_at&&b.start_at<=t&&!(b.end_at&&b.end_at<=t)){const r=await turnOn(s,'schedule');const st=await s.get('settings','main');st.black_friday={...st.black_friday,end_at:b.end_at||null};await s.put('settings','main',st);return !!r.on}
 if(b.on&&b.end_at&&b.end_at<=t){await turnOff(s,'schedule');return true}
 // After Friday the $199 kits go back to the normal 30% off (and back to their own code setting).
 let changed=false;if(b.on&&t>KIT_DEAL_UNTIL){let st=null;for(const id of KIT_DEALS){const p=await s.get('products',id);if(!p||p.bf_deal!=='kit5')continue;st=st||await state(s);const was=(st.snapshot||{})[id]||{};
  const next=plan({...p,regular_price:p.regular_price},t);if(next)Object.assign(p,next);delete p.bf_deal;p.promo_excluded=was.promo_excluded===null||was.promo_excluded===undefined?false:was.promo_excluded;if(!p.promo_excluded)delete p.promo_excluded;p.offer_revision=(p.offer_revision||0)+1;await s.put('products',p.id,p);changed=true}}
 return changed}
async function schedule(s,{start_at,end_at}){const st=await s.get('settings','main'),b=st.black_friday||{};const v=x=>x===null||x===undefined||x===''?null:(Number.isSafeInteger(x)&&x>1.7e9&&x<2.2e9?x:bad('Choose a valid date and time.'));
 const next={...b};if(start_at!==undefined)next.start_at=v(start_at);if(end_at!==undefined)next.end_at=v(end_at);if(next.start_at&&next.end_at&&next.end_at<=next.start_at)bad('The end must be after the start.');
 st.black_friday=next;await s.put('settings','main',st);return{on:!!next.on,start_at:next.start_at||null,end_at:next.end_at||null}}
async function route(path,body,h,method,{session}){
 if(!path.startsWith('/admin/black-friday'))return null;
 const ok=b=>({status:200,headers:{},body:b});
 if(path==='/admin/black-friday'&&method==='GET')return ok(await transaction(async s=>{await session(s,h);const st=await state(s),b=(await s.get('settings','main')).black_friday||{};return{on:!!st.on,since:st.since||null,ended:st.ended||null,changed:st.changed||0,start_at:b.start_at||null,end_at:b.end_at||null,preview:await preview(s)}}));
 if(path==='/admin/black-friday'&&method==='POST')return ok(await transaction(async s=>{const sid=await session(s,h),rec=await s.get('sessions',sid);if(rec?.staff_id)bad('Only the owner sign-in can start or end Black Friday.',403);
  if(body.start_at!==undefined||body.end_at!==undefined)return schedule(s,body);
  if(body.on===true){if(body.confirm!=='START BLACK FRIDAY')bad('Type START BLACK FRIDAY to confirm.');return turnOn(s,'owner')}
  if(body.on===false){if(body.confirm!=='END BLACK FRIDAY')bad('Type END BLACK FRIDAY to confirm.');return turnOff(s,'owner')}
  bad('Choose on or off.')}));
 return null}
// Before the sale starts, the catalog's own products (gift boxes, stocking stuffers, boutique) can already go on gift
// lists (Jonah, 22 Nov 2026: "add the christmas catalogue to the gift registrey"). They are shown with their catalog
// price and marked upcoming; nobody can buy them until the sale switches them on.
function upcoming(settings,t=now()){const b=settings?.black_friday||{};return !b.on&&!!b.start_at&&!(b.end_at&&b.end_at<=t)}
const giftable=(p,settings)=>!!p&&(!!p.active||(upcoming(settings)&&glow(p)&&isCatalogOnly(p)&&!isPart(p)));
async function upcomingProducts(s,settings){if(!upcoming(settings))return [];const out=[];
 for(const p of await s.list('products')){if(p.active||!glow(p)||!isCatalogOnly(p)||isPart(p))continue;const n=plan(p);if(!n)continue;out.push({...p,...n,active:0,upcoming:true})}return out}
module.exports={KIT_DEALS,KIT_DEAL_UNTIL,SIZE_FIX,upcoming,giftable,upcomingProducts,tick,schedule,FIXED,fixedFor,plan,preview,turnOn,turnOff,on,route,pct30,isCatalogOnly,isPart};

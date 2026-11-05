'use strict';
// Skool member perks (Jonah, 5 Nov 2026). Heather's paid Skool community has two paid levels: VIP (picks 4 perks) and
// Premium (picks 2). Skool has no API, so the owner keeps the member list here: upload Skool's member export (CSV) or add
// one email. A listing is good for 30 days from the last upload (or add) that included it.
// Safety, same as Autopilot: the master switch starts OFF and only the owner sign-in can change anything (staff can look).
// While it is OFF nothing changes for customers: prices, shipping, points, the catalog and the account page are as before.
// A customer is matched by the signed-in account's OWN email only. There is no way to claim a different email: anyone
// could type a known VIP's address. Not on the list? They reply to one of our emails and the owner matches it.
// Research-use-only store: no health, dose or use wording anywhere in this file.
const crypto=require('node:crypto');
const now=()=>Math.floor(Date.now()/1000);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const DAY=86400,GOOD_FOR=30*DAY,CHANGE_EVERY=30*DAY,MERCH_EVERY=90*DAY,ENDING_SOON=7*DAY,MAX_CSV=2*1024*1024,MAX_ROWS=20000;
const LIMIT={vip:4,premium:2},LEVEL_NAME={vip:'VIP',premium:'Premium'};
const DEFAULTS={enabled:false,discount_pct:10,ship_min_vip:6000,ship_min_premium:8000};
const PERK_IDS=['price','ship','points','early','packed','support','restock','live','merch','bundles'];
const SHORT={price:'% off',ship:'Free shipping',points:'2× points',early:'Early access',packed:'Packed first',support:'Support first',restock:'Restock hold',live:'Live first dibs',merch:'Free merch',bundles:'Member bundles'};
const norm=e=>String(e||'').trim().toLowerCase();
const validEmail=e=>typeof e==='string'&&e.length>3&&e.length<=150&&/^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(e)&&e.split('@').length===2;
const dollars=c=>'$'+(c%100?(c/100).toFixed(2):String(c/100));
const longDate=t=>new Date(t*1000).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'long',day:'numeric',year:'numeric'});
const hashId=v=>crypto.createHash('sha256').update(String(v)).digest('hex');

function shape(rec){const r={...DEFAULTS,...(rec||{})};r.enabled=r.enabled===true;for(const k of ['discount_pct','ship_min_vip','ship_min_premium'])if(!Number.isSafeInteger(r[k])||r[k]<0)r[k]=DEFAULTS[k];return r}
async function config(s){return shape(await s.get('integrations','members'))}
function shipMin(cfg,level){return level==='premium'?cfg.ship_min_premium:cfg.ship_min_vip}
// The 10 perks (ids fixed). Customer wording: short, plain, warm. Perks 7–9 are done by the team, so the copy says how
// to claim them and never promises anything automatic.
function perkList(cfg,level='vip'){const min=dollars(shipMin(cfg,level));return [
 {id:'price',title:cfg.discount_pct+'% off every order',desc:'Taken off your products at checkout. If you also have a promo code, you get whichever saves you more.'},
 {id:'ship',title:'Free shipping on every other order',desc:'Every second order of '+min+' or more ships free. Orders under '+min+' do not count toward it.'},
 {id:'points',title:'Double Glow Points',desc:'Earn 2 points for every $1. If your Glow level already earns 2 or more, you keep the higher rate.'},
 {id:'early',title:'Early access',desc:'See and buy new products before everyone else.'},
 {id:'packed',title:'Packed first',desc:'Your orders go to the front of our packing line.'},
 {id:'support',title:'Front of the line support',desc:'When you write to us, we answer you first.'},
 {id:'restock',title:'Restock hold',desc:'We hold one for you from the next restock for 48 hours. Reply to our restock email to claim it.'},
 {id:'live',title:'Live-show first dibs',desc:'Claim live-show items 10 minutes before anyone else.'},
 {id:'merch',title:'Free Glow Merch',desc:'A free Glow Merch item every 3 months. Our team will reach out when yours is ready.'},
 {id:'bundles',title:'Members-only bundles',desc:'Shop bundles that only members can see.'}].map((p,i)=>({...p,n:i+1}))}

function isActive(m,t=now()){return !!m&&!m.removed_at&&(m.good_until||0)>t&&!!LIMIT[m.level]}
// Never more perks than the level allows (a VIP moved to Premium keeps only their first two until they choose again).
function effectivePerks(m){return PERK_IDS.filter(id=>(m.perks||[]).includes(id)).slice(0,LIMIT[m.level]||0)}
// Quote / catalog context. null = switch OFF (or not the Glow store): callers then do exactly what they did before.
async function context(s,email,brandId='glow'){if(brandId!=='glow')return null;const cfg=await config(s);if(!cfg.enabled)return null;let member=null;if(email){const r=await s.get('members',norm(email));if(isActive(r))member=r}return{cfg,member,perks:new Set(member?effectivePerks(member):[])}}
// Switch OFF (Jonah, 5 Nov 2026): members-only bundles stay hidden from everyone, so a member price never goes public.
function visible(ctx,p,t=now()){if(!ctx)return p.members_only!==true;if(p.members_only===true&&!ctx.perks.has('bundles'))return false;if(Number(p.members_early_until)>t&&!ctx.perks.has('early'))return false;return true}

// Free shipping every other order: products after promo/member discounts (before Glow Points) must reach the level's
// minimum. Counted: this member's non-test orders since the membership started that are not canceled or expired and reach
// the minimum. Subscription orders have their own shipping rule and are not counted.
function shipBasis(o){if(o.member&&Number.isSafeInteger(o.member.ship_basis))return o.member.ship_basis;return Math.max(0,(o.subtotal||0)-((o.discount||0)-(o.rewards_discount||0)))}
async function orderList(s){return s.listLite?s.listLite('orders'):s.list('orders')}
function memberOrders(list,m){return list.filter(o=>o.is_test===false&&!['canceled','expired'].includes(o.status)&&norm(o.customer?.email)===m.email)}
async function qualifyingCount(s,m,min,exclude){return memberOrders(await orderList(s),m).filter(o=>o.id!==exclude&&!o.subscription_id&&(o.created||0)>=(m.since||0)&&shipBasis(o)>=min).length}

// --- customer account -------------------------------------------------------------------------------------------
async function accountView(s,a){
 const cfg=await config(s);if(!cfg.enabled)return{on:false};
 const m=await s.get('members',norm(a.email)),t=now();
 if(!isActive(m,t))return{on:true,member:null,email:a.email,...(m&&!m.removed_at&&m.confirmed_at?{last_checked:m.confirmed_at}:{})};
 const perks=effectivePerks(m),limit=LIMIT[m.level],orders=memberOrders(await orderList(s),m).filter(o=>o.member);
 const discount=orders.reduce((n,o)=>n+(o.member.discount||0),0),shipping=orders.reduce((n,o)=>n+(o.member.shipping_waived||0),0),extra=orders.reduce((n,o)=>n+(o.member.extra_points||0),0);
 const min=shipMin(cfg,m.level),count=await qualifyingCount(s,m,min);
 const early=perks.includes('early')?(await s.list('products')).filter(p=>p.active&&(p.brand||'glow')==='glow'&&Number(p.members_early_until)>t).map(p=>({id:p.id,name:p.name,until:p.members_early_until})):[];
 const next=m.perks_saved_at?m.perks_saved_at+CHANGE_EVERY:null;
 return{on:true,member:{email:m.email,name:m.name||'',level:m.level,level_name:LEVEL_NAME[m.level],limit,perks,perks_saved_at:m.perks_saved_at||null,next_change_at:next,can_change:!next||t>=next,confirmed_at:m.confirmed_at,good_until:m.good_until},
  perks:perkList(cfg,m.level),discount_pct:cfg.discount_pct,saved:{total:discount+shipping,discount,shipping},ship:{picked:perks.includes('ship'),min,count,next_free:(count+1)%2===0},extra_points:extra,early};
}
async function audit(s,action,id=''){const log=await s.get('audit','log')||[];log.push({created:now(),action,order_id:id});await s.put('audit','log',log.slice(-250))}
async function savePerks(s,a,list){
 const cfg=await config(s);if(!cfg.enabled)fail('Skool member perks are not available right now.',409);
 const m=await s.get('members',norm(a.email));if(!isActive(m))fail('We could not find your account email on our Skool member list.',404);
 if(!Array.isArray(list)||list.length>PERK_IDS.length||list.some(x=>typeof x!=='string'||!PERK_IDS.includes(x)))fail('Choose perks from the list.');
 if(new Set(list).size!==list.length)fail('Each perk can only be chosen once.');
 const limit=LIMIT[m.level];if(!list.length)fail('Choose at least one perk.');if(list.length>limit)fail('You can choose '+limit+' perks. Remove one to swap it for another.');
 const next=PERK_IDS.filter(id=>list.includes(id)),current=effectivePerks(m);
 if(m.perks_saved_at&&next.join()===current.join())return{perks_saved:false,unchanged:true};
 const t=now();if(m.perks_saved_at&&t<m.perks_saved_at+CHANGE_EVERY)fail('You can change your perks again on '+longDate(m.perks_saved_at+CHANGE_EVERY)+'.',409);
 m.perks=next;m.perks_saved_at=t;m.perk_history=[...(m.perk_history||[]),{at:t,perks:next}].slice(-24);m.updated=t;
 await s.put('members',m.email,m);await audit(s,'member_perks_saved',hashId(m.email).slice(0,12));return{perks_saved:true};
}
async function customerRoute(path,body,h,method){
 if(!['/account/member','/account/member/perks','/account/member/link'].includes(path))return null;
 const {transaction}=require('./store-db.cjs'),accounts=require('./customer-accounts.cjs');
 if(path==='/account/member'&&method==='GET')return{status:200,headers:{},body:await transaction(async s=>accountView(s,await accounts.session(s,h,true)))};
 if(path==='/account/member/perks'&&method==='POST')return{status:200,headers:{},body:await transaction(async s=>{const a=await accounts.session(s,h,true);const r=await savePerks(s,a,body.perks);return{...r,...await accountView(s,a)}})};
 // "Link" only ever checks the signed-in account's own email. Any email in the request is ignored on purpose.
 if(path==='/account/member/link'&&method==='POST')return{status:200,headers:{},body:await transaction(async s=>{const a=await accounts.session(s,h,true);const v=await accountView(s,a);if(!v.on)fail('Skool member perks are not available right now.',409);
  return v.member?{found:true,...v}:{found:false,...v,message:'We could not find '+a.email+' on our Skool member list yet. Reply to any of our emails with the email you use on Skool, and we will match it for you.'}})};
 fail('Method not allowed.',405);
}

// --- CSV import ---------------------------------------------------------------------------------------------------
function parseCsv(text){
 const first=(text.split(/\r?\n/).find(l=>l.trim())||''),counts=[',',';','\t'].map(d=>[d,first.split(d).length]),delim=counts.sort((a,b)=>b[1]-a[1])[0][0];
 const rows=[];let row=[],field='',q=false,start=true,line=1,rowLine=1;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(q){if(c==='"'){if(text[i+1]==='"'){field+='"';i++}else q=false}else{if(c==='\n')line++;field+=c}continue}
  if(c==='"'&&start){q=true;start=false;continue}
  if(c===delim){row.push(field);field='';start=true;continue}
  if(c==='\r')continue;
  if(c==='\n'){row.push(field);rows.push({line:rowLine,cells:row});row=[];field='';start=true;line++;rowLine=line;continue}
  field+=c;start=false}
 if(field!==''||row.length){row.push(field);rows.push({line:rowLine,cells:row})}
 return rows}
function levelOf(v){const x=String(v||'').toLowerCase();if(/\bvip\b|vip/.test(x))return 'vip';if(x.includes('premium'))return 'premium';return null}
function readFile(csv,fileLevel){
 if(typeof csv!=='string'||!csv.trim())fail('Choose the Skool member export (a .csv file) first.');
 if(Buffer.byteLength(csv)>MAX_CSV)fail('That file is over 2 MB. Export it again from Skool, or split it in two.',413);
 const all=parseCsv(csv.replace(/^﻿/,'')).filter(r=>r.cells.some(c=>String(c).trim()));if(!all.length)fail('That file is empty.');
 const head=all[0].cells.map(c=>String(c).trim().toLowerCase()),find=f=>head.findIndex(f);
 let email=find(h=>h==='email'||h==='email address'||h==='e-mail');if(email<0)email=find(h=>h.includes('email')||h.includes('e-mail'));
 if(email<0)fail('We could not find an email column. The first row of the file needs a heading with the word “email”.');
 let name=find((h,i)=>i!==email&&['name','full name','member name','member'].includes(h)),first=-1,last=-1;
 if(name<0){first=find(h=>h.includes('first'));last=find(h=>h.includes('last')&&!h.includes('active')&&!h.includes('login'));if(first<0&&last<0)name=find((h,i)=>i!==email&&h.includes('name')&&!h.includes('user'))}
 const level=find((h,i)=>i!==email&&/(level|tier|membership|plan|price|subscription)/.test(h));
 const chosen=fileLevel==='vip'||fileLevel==='premium'?fileLevel:null;
 if(level<0&&!chosen)fail('This file has no level column. Choose VIP or Premium for the whole file, then preview again.');
 const body=all.slice(1);if(body.length>MAX_ROWS)fail('That file has more than '+MAX_ROWS.toLocaleString('en-US')+' rows.',413);
 const rows=[],skipped=[],seen=new Set();
 for(const r of body){const cell=i=>i>=0?String(r.cells[i]??'').trim():'';const e=norm(cell(email));
  if(!e){skipped.push({row:r.line,reason:'No email in this row'});continue}
  if(!validEmail(e)){skipped.push({row:r.line,reason:'Not a valid email',value:e.slice(0,80)});continue}
  if(seen.has(e)){skipped.push({row:r.line,reason:'Same email again in this file',value:e});continue}
  let lv=null;if(level>=0){const raw=cell(level);lv=levelOf(raw);if(!lv&&!raw&&chosen)lv=chosen;if(!lv){skipped.push({row:r.line,reason:raw?'Not VIP or Premium (“'+raw.slice(0,40)+'”)':'No level in this row',value:e});continue}}else lv=chosen;
  seen.add(e);rows.push({row:r.line,email:e,name:(name>=0?cell(name):[cell(first),cell(last)].filter(Boolean).join(' ')).slice(0,150),level:lv})}
 return{rows,skipped,columns:{email:all[0].cells[email],name:name>=0?all[0].cells[name]:[first,last].filter(i=>i>=0).map(i=>all[0].cells[i]).join(' + ')||null,level:level>=0?all[0].cells[level]:null},file_level:chosen}}
function changeFor(old,r,t){if(!old||old.removed_at)return 'new';if(old.level!==r.level)return 'level_changed';return 'refreshed'}
async function preview(s,body,by){
 const f=readFile(body.csv,body.level),t=now(),out=[];const counts={new:0,refreshed:0,level_changed:0,skipped:f.skipped.length};
 for(const r of f.rows){const old=await s.get('members',r.email),change=changeFor(old,r,t);counts[change]++;out.push({...r,change,...(change==='level_changed'?{old_level:old.level}:{})})}
 const id=crypto.randomBytes(12).toString('hex');await s.put('member_batches',id,{id,rows:f.rows,created:t,expires:t+3600,by});
 return{batch_id:id,columns:f.columns,file_level:f.file_level,counts,total:f.rows.length,rows:out.slice(0,1000),skipped:f.skipped.slice(0,500)}}
// One listing: new (or removed and back) starts fresh; anyone already listed gets confirmed_at/good_until refreshed.
async function upsert(s,r,source,by,t=now()){
 const old=await s.get('members',r.email);let m;
 if(!old||old.removed_at)m={email:r.email,name:r.name||old?.name||'',level:r.level,source,since:t,confirmed_at:t,good_until:t+GOOD_FOR,perks:[],perks_saved_at:null,added_by:by,added_at:t,...(old?.merch_given_at?{merch_given_at:old.merch_given_at}:{})};
 else{m={...old,source,confirmed_at:t,good_until:t+GOOD_FOR,updated:t};if(r.name)m.name=r.name;
  if(old.level!==r.level){m.level=r.level;const keep=effectivePerks(m);if(keep.length<(old.perks||[]).length){m.perks=keep;m.perks_saved_at=null}m.level_history=[...(old.level_history||[]),{at:t,from:old.level,to:r.level}].slice(-12)}}
 delete m.removed_at;delete m.removed_by;await s.put('members',m.email,m);return{change:changeFor(old,r,t),member:m}}
async function commit(s,id,by){
 const b=await s.get('member_batches',typeof id==='string'?id:'');if(!b||b.expires<=now())fail('Preview the file again before adding the members.',409);if(b.done)return b.done;
 const counts={new:0,refreshed:0,level_changed:0},t=now();for(const r of b.rows){const x=await upsert(s,r,'csv',by,t);counts[x.change]++}
 b.done={ok:true,...counts,total:b.rows.length};await s.put('member_batches',id,b);await audit(s,'members_csv_imported',String(b.rows.length));return b.done}

// --- Management ---------------------------------------------------------------------------------------------------
async function adminView(s,owner){
 const cfg=await config(s),t=now(),all=await s.list('members'),orders=await orderList(s),rows=[];
 for(const m of all.sort((a,b)=>(b.confirmed_at||0)-(a.confirmed_at||0))){const active=isActive(m,t),acct=await s.get('customers',hashId(m.email)),perks=active?effectivePerks(m):[];
  const mine=memberOrders(orders,m).filter(o=>o.member),saved=mine.reduce((n,o)=>n+(o.member.discount||0)+(o.member.shipping_waived||0),0);
  rows.push({email:m.email,name:m.name||'',level:m.level,level_name:LEVEL_NAME[m.level]||m.level,source:m.source,since:m.since||null,confirmed_at:m.confirmed_at||null,good_until:m.good_until||null,active,removed_at:m.removed_at||null,perks,perks_saved_at:m.perks_saved_at||null,saved_cents:saved,
   account:!!acct?.verified,invited_at:m.invited_at||null,ending_soon:active&&m.good_until-t<ENDING_SOON,merch_given_at:m.merch_given_at||null,merch_due:active&&perks.includes('merch')&&(!m.merch_given_at||t-m.merch_given_at>=MERCH_EVERY)})}
 const live=rows.filter(r=>r.active);
 return{settings:cfg,owner:!!owner,counts:{vip:live.filter(r=>r.level==='vip').length,premium:live.filter(r=>r.level==='premium').length,no_account:live.filter(r=>!r.account).length,ending_soon:live.filter(r=>r.ending_soon).length},
  members:rows,perks:perkList(cfg,'vip').map(p=>({id:p.id,n:p.n,title:p.id==='ship'?'Free shipping every other order ('+dollars(cfg.ship_min_vip)+' VIP / '+dollars(cfg.ship_min_premium)+' Premium)':p.title,short:SHORT[p.id]})),limits:LIMIT}}
// For Find customer and order detail: who gets "answer first". Only when the switch is ON.
async function adminFlags(s){const cfg=await config(s);if(!cfg.enabled)return null;const support={};for(const m of await s.list('members'))if(isActive(m)&&effectivePerks(m).includes('support'))support[m.email]=m.level;return{on:true,support}}
function cents(v,max){if(!Number.isSafeInteger(v)||v<0||v>max)fail('Enter a dollar amount from $0 to $'+(max/100)+'.');return v}
async function adminRoute(path,body,method,{transaction,sid,audit:storeAudit}){
 const owner=await transaction(async s=>!(await s.get('sessions',sid))?.staff_id);
 if(path==='/admin/members'&&method==='GET')return{status:200,headers:{},body:await transaction(s=>adminView(s,owner))};
 if(method!=='POST')fail('Method not allowed.',405);
 if(!owner)fail('Only the owner sign-in can change Skool members.',403);
 const log=storeAudit||audit;let job=null;
 const r=await transaction(async s=>{const t=now();
  if(path==='/admin/members/settings'){const cfg=await config(s),next={...cfg};
   if(body.enabled!==undefined){if(typeof body.enabled!=='boolean')fail('Choose on or off.');next.enabled=body.enabled}
   if(body.discount_pct!==undefined){if(!Number.isSafeInteger(body.discount_pct)||body.discount_pct<1||body.discount_pct>50)fail('Member discount must be a whole number from 1 to 50.');next.discount_pct=body.discount_pct}
   if(body.ship_min_vip!==undefined)next.ship_min_vip=cents(body.ship_min_vip,100000);if(body.ship_min_premium!==undefined)next.ship_min_premium=cents(body.ship_min_premium,100000);
   next.changed_at=t;next.changed_by='owner';await s.put('integrations','members',next);
   if(next.enabled!==cfg.enabled)await log(s,'members_switch_'+(next.enabled?'on':'off'));else await log(s,'members_settings_saved');return adminView(s,owner)}
  if(path==='/admin/members/import-preview')return preview(s,body,'owner');
  if(path==='/admin/members/import'){const done=await commit(s,body.batch_id,'owner');return{...done,view:await adminView(s,owner)}}
  const e=norm(body.email);if(!validEmail(e))fail('Enter a valid email address.');
  if(path==='/admin/members/add'){if(!LIMIT[body.level])fail('Choose VIP or Premium.');const name=typeof body.name==='string'?body.name.trim().slice(0,150):'';const x=await upsert(s,{email:e,name,level:body.level},'manual','owner',t);await log(s,'member_added_'+x.change);return{change:x.change,view:await adminView(s,owner)}}
  const m=await s.get('members',e);if(!m)fail('That email is not on the member list.',404);
  if(path==='/admin/members/remove'){if(m.removed_at)return{view:await adminView(s,owner)};m.removed_at=t;m.removed_by='owner';m.perks=[];m.perks_saved_at=null;await s.put('members',e,m);await log(s,'member_removed');return{view:await adminView(s,owner)}}
  if(path==='/admin/members/merch'){if(!isActive(m,t)||!effectivePerks(m).includes('merch'))fail('This member has not picked Free Glow Merch.',409);m.merch_given_at=t;m.merch_history=[...(m.merch_history||[]),t].slice(-24);await s.put('members',e,m);await log(s,'member_merch_given');return{view:await adminView(s,owner)}}
  // Invite: the store's existing "Set up your Glow Lab account" email (same as Customers → Send setup). Never automatic.
  if(path==='/admin/members/invite'){const emails=require('./store-email.cjs'),accounts=require('./customer-accounts.cjs');
   if(!emails.configuration().ready)fail('Connect automatic email in Settings first.',503);if(!isActive(m,t))fail('This member’s listing has ended. Upload a fresh Skool export first.',409);
   const id=hashId(e);let a=await s.get('customers',id);if(a?.verified)fail('They already have a store account.',409);
   if((await s.get('rewards_imports',id))?.held)fail('Review this customer email before sending setup.',409);
   if(!a){a={id,email:e,name:m.name||'',created:t,verified:false,auth_version:0,password:null};await s.put('customers',id,a)}
   if((a.last_setup_email||0)>t-300)fail('A setup email was requested recently. Wait five minutes before sending another.',429);
   const link=await accounts.issueSetup(s,id),fresh=await s.get('customers',id);fresh.last_setup_email=t;await s.put('customers',id,fresh);
   job=await emails.queueSetup(s,link,false,'glow');m.invited_at=t;await s.put('members',e,m);await log(s,'member_invite_sent');return{invited:true,view:await adminView(s,owner)}}
  fail('Endpoint not found.',404)});
 if(job){const emails=require('./store-email.cjs');r.email=await emails.safeDispatch(job)}
 return{status:200,headers:{},body:r};
}
module.exports={DEFAULTS,LIMIT,LEVEL_NAME,PERK_IDS,GOOD_FOR,CHANGE_EVERY,MERCH_EVERY,config,perkList,isActive,effectivePerks,context,visible,shipMin,shipBasis,qualifyingCount,accountView,savePerks,customerRoute,parseCsv,readFile,preview,commit,upsert,adminView,adminFlags,adminRoute,norm};

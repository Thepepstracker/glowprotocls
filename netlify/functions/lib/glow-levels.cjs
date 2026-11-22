'use strict';
// Glow levels v2 (Jonah, 15 Nov 2026): "expand the playing field, make it a little more difficult to reach certain levels so
// they feel like it's an achievement when they do", level-up moments, a birthday gift, and a hint at checkout of what they'd
// earn one level up.
//
// Levels are set by lifetime Glow Points EARNED (orders, sign-up and referral bonuses, adjustments). Spending points never
// lowers a level. Birthday gifts do not count toward levels (a gift, not an achievement).
// Nobody goes down: anyone who reached Gold or Purple on the old ladder (Gold 500, Purple 1,500) before the new ladder
// started keeps that level ("kept"). The start is saved the first time the new code runs (integrations/levels-v2).
//
// Everything a customer gets is in LADDER below, in one place, so the owner can approve or change the numbers.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const LADDER=[ // lowest first
 {id:'blue',name:'Blue',min_points:0,multiplier:1,birthday:100},
 {id:'rose',name:'Rose',min_points:300,multiplier:1.25,birthday:150},
 {id:'gold',name:'Gold',min_points:1000,multiplier:1.5,birthday:250},
 {id:'purple',name:'Purple',min_points:2500,multiplier:2,birthday:400},
 {id:'diamond',name:'Diamond',min_points:6000,multiplier:2.5,birthday:600}];
const TIERS=LADDER.slice().reverse(); // highest first, the shape the rest of the store already uses
const OLD=[{id:'purple',min_points:1500},{id:'gold',min_points:500},{id:'blue',min_points:0}];
const EARN_KINDS=['earned','opening_balance','migration_reconciliation','order_adjustment','staff_adjustment','signup_bonus','referral_bonus'];
// What counts toward a level: earning kinds, minus points a refund took back (Jonah, 21 Nov 2026: a refunded or canceled
// order never counts). Points given back to a customer on a refund (positive 'refund') are not earned, so they don't count.
const countsToLevel=e=>EARN_KINDS.includes(e.kind)||(e.kind==='refund'&&(e.points||0)<0);
const POINT_CENTS=5;
const dollars=pts=>{const c=pts*POINT_CENTS;return '$'+(c%100?(c/100).toFixed(2):String(c/100))};
const rank=id=>LADDER.findIndex(t=>t.id===id);
const byId=id=>LADDER.find(t=>t.id===id)||LADDER[0];
function tierFor(points){return TIERS.find(t=>points>=t.min_points)}
function nextTier(points,current){const up=LADDER.find(t=>t.min_points>points&&rank(t.id)>rank(current||tierFor(points).id));return up?{id:up.id,name:up.name,multiplier:up.multiplier,min_points:up.min_points,needed_points:up.min_points-points}:null}
const pub=t=>({id:t.id,name:t.name,multiplier:t.multiplier,min_points:t.min_points,birthday_points:t.birthday});

async function ladderFrom(s){let r=await s.get('integrations','levels-v2');if(!r){r={id:'levels-v2',from:now()};await s.put('integrations','levels-v2',r)}return r.from}
// Points earned in total, and before the new ladder started (for kept levels).
async function points(s,id,from){let all=0,before=0;for(const e of await s.list('rewards_ledger'))if(e.customer_id===id&&countsToLevel(e)){all+=e.points||0;if((e.created||0)<from)before+=e.points||0}return{all:Math.max(0,all),before:Math.max(0,before)}}
function keptFrom(before){return(OLD.find(t=>before>=t.min_points)||OLD[OLD.length-1]).id}
function pick(all,kept){const t=tierFor(all);return rank(kept)>rank(t.id)?byId(kept):t}
// The customer's level now: {tier, points, kept, next}.
async function levelOf(s,id){const from=await ladderFrom(s),p=await points(s,id,from),kept=keptFrom(p.before),t=pick(p.all,kept);return{tier:t,points:p.all,kept:rank(kept)>rank(tierFor(p.all).id)?kept:null,next:nextTier(p.all,t.id)}}

// ---- level-up moments ----
const emailKey=e=>crypto.createHash('sha256').update(String(e||'').trim().toLowerCase()).digest('hex').slice(0,40);
function perkLine(t){return t.multiplier+' points per $1 on every order ('+Math.round(t.multiplier*POINT_CENTS*100)/100+'% back)'}
function levelUpEmail(name,t){const first=String(name||'').trim().split(/\s+/)[0]||'there',f=first.toLowerCase().replace(/^./,c=>c.toUpperCase()),nx=LADDER[rank(t.id)+1];
 return{subject:'You reached '+t.name+' ✨ · Glow Lab',title:'Welcome to '+t.name+'.',button:'See your level',
  lines:['Hi '+f+',','You just reached '+t.name+', one of our Glow levels. Thank you for being here.','From now on you earn '+perkLine(t)+'. Your birthday gift is '+t.birthday+' points ('+dollars(t.birthday)+') at the start of your birthday month.',nx?'Next up: '+nx.name+' at '+nx.min_points.toLocaleString('en-US')+' points earned.':'This is our top level. You are one of our very best customers.']}}
// Called by the rewards ledger after points are added. Records the level-up (shown once in the store) and emails them.
async function afterEarn(s,id,beforeAll,afterAll){if(afterAll<=beforeAll)return null;const from=await ladderFrom(s),p=await points(s,id,from),kept=keptFrom(p.before);
 const was=pick(beforeAll,kept),is=pick(afterAll,kept);if(rank(is.id)<=rank(was.id))return null;
 const a=await s.get('customers',id);if(!a)return null;a.level_up={from:was.id,to:is.id,at:now()};await s.put('customers',id,a);
 const prefs=a.email?await s.get('email_prefs',emailKey(a.email)):null;
 if(a.email&&a.verified&&!prefs?.unsubscribed){const emails=require('./store-email.cjs'),c=levelUpEmail(a.name,is),origin=String(emails.configuration().origin||process.env.STORE_ORIGIN||'').replace(/\/$/,'');
  await emails.enqueue(s,{id:'level-up-'+id.slice(0,24)+'-'+is.id,kind:'level_up',brand:'glow',to:a.email,related_id:id,subject:c.subject,content:emails.template(c.title,c.lines,origin+'/store-next/account',c.button,null,null,{eyebrow:'Glow Lab · '+is.name})})}
 const log=await s.get('audit','log')||[];log.push({created:now(),action:'level_up_'+is.id,customer_id:id});await s.put('audit','log',log.slice(-5000));return is.id}

// ---- birthday gift ----
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
function etParts(t=Date.now()){const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t));const g=k=>Number(p.find(x=>x.type===k).value);return{y:g('year'),m:g('month'),d:g('day'),h:g('hour')}}
function validDay(m,d){return Number.isInteger(m)&&m>=1&&m<=12&&Number.isInteger(d)&&d>=1&&d<=[31,29,31,30,31,30,31,31,30,31,30,31][m-1]}
// A birthday added during (or just before) its own month starts next year, so nobody adds one just to collect it.
function giftYear(b,t=Date.now()){const n=etParts(t),startOfMonth=Date.UTC(n.y,b.m-1,1)/1000+5*3600;return b.set_at<=startOfMonth-14*86400?n.y:null}
function birthdayEmail(name,t,pts){const first=String(name||'').trim().split(/\s+/)[0]||'there',f=first.toLowerCase().replace(/^./,c=>c.toUpperCase());
 return{subject:'Happy birthday month, '+f+' 🎂',title:'Happy birthday month.',button:'Use my points',
  lines:['Hi '+f+',','It’s your birthday month, so we added '+pts+' Glow Points ('+dollars(pts)+') to your account as a '+t.name+' level gift.','They work like any of your points: use them at checkout, with or without a promo code. They never expire.','Thank you for being part of Glow Lab.']}}
async function birthdays(limit=25,t=Date.now()){const n=etParts(t);if(n.h<9||n.h>=20)return{status:'quiet_hours',sent:0};
 const accounts=require('./customer-accounts.cjs'),emails=require('./store-email.cjs');
 const jobs=await transaction(async s=>{const out=[];let given=0;
  for(const a of await s.list('customers')){if(given>=limit)break;const b=a.birthday;if(!a.verified||!b||b.m!==n.m)continue;const year=giftYear(b,t);if(year!==n.y)continue;
   const lv=await levelOf(s,a.id),pts=lv.tier.birthday;if(!await accounts.event(s,a.id,'birthday-'+year,'birthday_bonus',pts,0,null,'Birthday gift · '+lv.tier.name+' level'))continue;given++;
   const prefs=await s.get('email_prefs',emailKey(a.email));
   if(a.email&&!prefs?.unsubscribed){const c=birthdayEmail(a.name,lv.tier,pts),origin=String(emails.configuration().origin||process.env.STORE_ORIGIN||'').replace(/\/$/,'');
    const job=await emails.enqueue(s,{id:'birthday-'+a.id.slice(0,24)+'-'+year,kind:'birthday_gift',brand:'glow',to:a.email,related_id:a.id,subject:c.subject,content:emails.template(c.title,c.lines,origin+'/store-next/',c.button,null,null,{eyebrow:'Glow Lab · Birthday'})});if(job)out.push(job)}}
  return out});
 for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}

// ---- checkout hint: what this order earns, and what it would earn one level up ----
async function hint(s,a,base,dbl){if(!a)return null;const lv=await levelOf(s,a.id),t=lv.tier,mult=m=>Math.floor(base*m*dbl),earn=mult(t.multiplier);
 const out={level:t.id,name:t.name,multiplier:t.multiplier,points:lv.points,earn};if(!lv.next)return out;
 const nx=byId(lv.next.id);out.next={id:nx.id,name:nx.name,multiplier:nx.multiplier,needed:lv.next.needed_points,earn_at_next:mult(nx.multiplier)};out.levels_up=earn>=lv.next.needed_points;return out}

// ---- Management: who is where, who is close, birthdays this month ----
async function overview(s){const from=await ladderFrom(s),ledger=await s.list('rewards_ledger'),per=new Map();
 for(const e of ledger)if(countsToLevel(e)){const r=per.get(e.customer_id)||{all:0,before:0};r.all+=e.points||0;if((e.created||0)<from)r.before+=e.points||0;per.set(e.customer_id,r)}
 const n=etParts(),rows=[];for(const a of await s.list('customers')){if(!a.verified)continue;const p=per.get(a.id)||{all:0,before:0},all=Math.max(0,p.all),t=pick(all,keptFrom(Math.max(0,p.before))),nx=nextTier(all,t.id);
  rows.push({id:a.id,name:a.name||'',email:a.email,level:t.id,points:all,kept:t.id!==tierFor(all).id,next:nx?{name:nx.name,needed:nx.needed_points,pct:Math.round(100*(all-t.min_points)/Math.max(1,nx.min_points-t.min_points))}:null,birthday:a.birthday?MONTHS[a.birthday.m-1].slice(0,3)+' '+a.birthday.d:'',birthday_now:a.birthday?.m===n.m,level_up_at:a.level_up?.at||0})}
 const counts=Object.fromEntries(LADDER.map(t=>[t.id,rows.filter(r=>r.level===t.id).length]));
 const close=rows.filter(r=>r.next&&(r.next.pct>=75||r.next.needed<=150)&&r.points>0).sort((x,y)=>x.next.needed-y.next.needed).slice(0,25);
 const vips=rows.filter(r=>rank(r.level)>=rank('gold')).sort((x,y)=>y.points-x.points).slice(0,60);
 const recent=rows.filter(r=>r.level_up_at>now()-30*86400).sort((x,y)=>y.level_up_at-x.level_up_at).slice(0,20);
 return{ladder:LADDER.map(pub),from,counts,vips,close,recent,birthdays:rows.filter(r=>r.birthday_now).slice(0,50),with_birthday:rows.filter(r=>r.birthday).length,accounts:rows.length}}

async function route(path,body,h,method,{session}){const ok=b=>({status:200,headers:{},body:b}),accounts=require('./customer-accounts.cjs');
 if(path==='/account/level/seen'&&method==='POST')return ok(await transaction(async s=>{const a=await accounts.session(s,h,true);if(a.level_up&&!a.level_up.seen_at){a.level_up.seen_at=now();await s.put('customers',a.id,a)}return{ok:true}}));
 if(path==='/account/birthday'&&method==='POST'){const m=Math.floor(Number(body.month)),d=Math.floor(Number(body.day));if(!validDay(m,d))bad('Choose your birthday month and day.');
  return ok(await transaction(async s=>{const a=await accounts.session(s,h,true);if(a.birthday)bad('Your birthday is already saved. To change it, reply to any Glow Lab email and we’ll help.',409);a.birthday={m,d,set_at:now()};await s.put('customers',a.id,a);return{birthday:publicBirthday(a.birthday)}}))}
 if(path==='/admin/levels'&&method==='GET'){await transaction(s=>session(s,h));return ok(await transaction(overview))}
 if(path==='/admin/birthday'&&method==='POST'){const sid=await transaction(s=>session(s,h));const m=Math.floor(Number(body.month)),d=Math.floor(Number(body.day)),clear=body.clear===true;if(!clear&&!validDay(m,d))bad('Choose a month and day.');
  return ok(await transaction(async s=>{const a=await s.get('customers',String(body.customer_id||'').slice(0,80));if(!a)bad('Customer not found.',404);if(clear)delete a.birthday;else a.birthday={m,d,set_at:a.birthday?.set_at||now(),changed_by_staff:now()};await s.put('customers',a.id,a);
   const log=await s.get('audit','log')||[];log.push({created:now(),action:'birthday_changed',customer_id:a.id,session:String(sid).slice(0,8)});await s.put('audit','log',log.slice(-5000));return{ok:true}}))}
 return null}
function publicBirthday(b){if(!b)return null;const n=etParts(),y=giftYear(b);return{month:b.m,day:b.d,label:MONTHS[b.m-1]+' '+b.d,gift_this_year:y===n.y&&b.m>=n.m}}

module.exports={LADDER,TIERS,OLD,EARN_KINDS,countsToLevel,rank,tierFor,nextTier,levelOf,ladderFrom,afterEarn,levelUpEmail,birthdays,birthdayEmail,giftYear,validDay,hint,overview,route,publicBirthday,pub,MONTHS};

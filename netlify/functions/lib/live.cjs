'use strict';
// Live log + deep live analytics (Jonah, 9 Nov 2026): "a logging area where she starts and stops the live and the analytics
// of the live, like deep analytics … time started, time ended, total time, people on the site at that time, all of the stuff".
//
// Heather presses Start live / End live on the Live Show page. Each live is saved (live_sessions) with its exact start and
// end. While a live is on, every open storefront tab sends a small anonymous "I'm here" ping every 30 seconds
// (live_visitors: one record per browser tab per live, no names, no emails, no IP), so the report can show how many
// people were on the site minute by minute. Everything else is computed from real orders placed in the live's window.
// TikTok's own numbers (viewers, likes, followers…) are not available to the store, so she can type them in after the live.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const ACTIVE='active',MAX_HOURS=8,TAIL=2*3600,ONLINE_WINDOW=75;
const TIKTOK=['viewers','peak_viewers','new_followers','likes','comments','shares','gifts'];
const int=v=>{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>=0&&n<1e9?n:null};
const epoch=v=>{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>1.6e9&&n<4e9?n:null};
const list=(s,k)=>s.listLite?s.listLite(k):s.list(k);
const isDraft=o=>o.proof_required===true&&o.checkout_stage==='draft'&&!o.has_receipt&&['order_received','expired','canceled'].includes(o.status);
const counts=o=>o.is_test===false&&(o.brand||'glow')==='glow'&&!isDraft(o)&&['order_received','awaiting_payment','payment_submitted','paid','shipped'].includes(o.status);
const isPaid=o=>o.status==='paid'||o.status==='shipped';
const placed=o=>o.submitted_at||o.created||0;
const email=o=>String(o.customer?.email||'').trim().toLowerCase()||o.id;
const firstName=o=>{const n=String(o.customer?.name||'').trim().split(/\s+/);return (n[0]||'Someone')+(n.length>1?' '+n[n.length-1][0].toUpperCase()+'.':'')};
const units=o=>(o.items||[]).reduce((n,i)=>n+(i.quantity||0),0);

async function active(s){const a=await s.get('live_sessions',ACTIVE);if(!a||!a.live)return null;const x=await s.get('live_sessions',a.live);return x&&!x.ended_at?x:null}
function newId(t){const p={};new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t*1000)).forEach(x=>p[x.type]=x.value);return 'LIVE-'+p.year+p.month+p.day+'-'+p.hour+p.minute}

// ---- the anonymous "I'm on the site" ping (public) ----
// One record per browser tab per live (the clock minutes it was open). Writes only while a live is on; otherwise one read.
const BOT=/bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i;
async function ping(body,h={}){
 const sid=String(body.sid||'');if(!/^[a-z0-9]{8,32}$/.test(sid)||BOT.test(String(h['user-agent']||'')))return{live:false};
 return transaction(async s=>{const L=await active(s);if(!L)return{live:false};const t=now();if(t-L.started_at>MAX_HOURS*3600)return{live:false};
  const id=L.id+'-'+sid,v=await s.get('live_visitors',id)||{id,live:L.id,first:t,minutes:[],src:''};
  const m=Math.floor(t/60);if(v.minutes[v.minutes.length-1]!==m){if(v.minutes.length>=MAX_HOURS*60)return{live:true};v.minutes.push(m)}
  v.last=t;if(!v.src&&/^[a-z0-9_-]{1,24}$/.test(String(body.src||'')))v.src=String(body.src);if(body.bag===true)v.bag=true;if(body.checkout===true)v.checkout=true;
  await s.put('live_visitors',id,v);return{live:true}})}

// Bounce (Jonah, 13 Nov 2026): a visitor who was on the site for one minute or less (one clock minute of pings) and never
// added anything to the bag. Time on the site = the clock minutes the tab was open (a tab left open in the background counts).
const bounced=v=>(v.minutes||[]).length<=1&&!v.bag&&!v.checkout;
function medianMinutes(V){const m=V.map(v=>(v.minutes||[]).length).sort((a,b)=>a-b);if(!m.length)return null;const k=Math.floor(m.length/2);return m.length%2?m[k]:(m[k-1]+m[k])/2}
// ---- summary numbers for one live (used by the log list and the report) ----
function windowOrders(orders,L,end){return orders.filter(o=>counts(o)&&placed(o)>=L.started_at&&placed(o)<end)}
function summary(orders,L){
 const end=L.ended_at||now()+1,list=windowOrders(orders,L,end),sales=list.reduce((n,o)=>n+(o.total||0),0);
 const minutes=Math.max(1,Math.round((end-L.started_at)/60));
 return{id:L.id,started_at:L.started_at,ended_at:L.ended_at||null,minutes,goal_cents:L.goal_cents||0,orders:list.length,sales_cents:sales,
  paid_cents:list.filter(isPaid).reduce((n,o)=>n+(o.verified_payment_cents!=null?o.verified_payment_cents:o.total||0),0),
  buyers:new Set(list.map(email)).size,avg_cents:list.length?Math.round(sales/list.length):0,per_minute_cents:Math.round(sales/minutes),
  peak_online:L.peak_online||0,tiktok:L.tiktok||{}}}

// ---- the deep report ----
// Subscriptions, new accounts and Skool members during the live (Jonah, 10 Nov 2026).
// subs: subscription records, each with value_cents = its package total (next delivery); accounts: customer records.
const EVERY_LABEL={'1w':'Every week','2w':'Every 2 weeks','3w':'Every 3 weeks','4w':'Every 4 weeks','1m':'Every month','2m':'Every 2 months','3m':'Every 3 months'};
const subName=x=>{const n=String(x.customer?.name||'').trim().split(/\s+/);return (n[0]||'Someone')+(n.length>1?' '+n[n.length-1][0].toUpperCase()+'.':'')};
function extrasFor(L,end,list,orders,subs,accounts,sales){
 const byId=new Map(orders.map(o=>[o.id,o]));
 const S=(subs||[]).filter(x=>(x.brand||'glow')==='glow'&&(x.created||0)>=L.started_at&&(x.created||0)<end).filter(x=>{const o=byId.get(x.first_order||x.source_order);return !o||o.is_test===false}).sort((a,b)=>a.created-b.created);
 const PER_MONTH=require('./subscriptions.cjs').PER_MONTH,live=S.filter(x=>x.status!=='canceled'),monthly=x=>Math.round((x.value_cents||0)*(PER_MONTH[x.every]||1));
 const plans={},prods=new Map();for(const x of S){const k=EVERY_LABEL[x.every]||x.every||'Other';plans[k]=(plans[k]||0)+1;for(const i of x.items||[])prods.set(i.name||'Product',(prods.get(i.name||'Product')||0)+(Number(i.quantity)||0))}
 const monthly_cents=live.reduce((n,x)=>n+monthly(x),0);
 const subscriptions={started:S.length,active:S.filter(x=>x.status==='active').length,waiting:S.filter(x=>['needs_card','pending_first_payment'].includes(x.status)).length,
  paused:S.filter(x=>x.status==='paused').length,canceled:S.filter(x=>x.status==='canceled').length,from_checkout:S.filter(x=>x.source==='customer').length,by_staff:S.filter(x=>x.source!=='customer').length,
  monthly_cents,yearly_cents:monthly_cents*12,plans:Object.entries(plans).sort((a,b)=>b[1]-a[1]),products:[...prods.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8),
  list:S.slice(0,25).map(x=>({name:subName(x),plan:EVERY_LABEL[x.every]||x.every,status:x.status,package_cents:x.value_cents??null,monthly_cents:x.status==='canceled'?0:monthly(x)}))};
 const liveEmails=new Set(list.map(o=>String(o.customer?.email||'').trim().toLowerCase()));
 const A=(accounts||[]).filter(a=>(a.created||0)>=L.started_at&&(a.created||0)<end);
 const accountsOut={created:A.length,finished:A.filter(a=>a.verified).length,set_up_during:(accounts||[]).filter(a=>(a.verified_at||0)>=L.started_at&&(a.verified_at||0)<end).length,
  ordered_tonight:A.filter(a=>liveEmails.has(String(a.email||'').toLowerCase())).length};
 const LN=require('./skool-members.cjs').LEVEL_NAME||{},M=list.filter(o=>o.member),mc=M.reduce((n,o)=>n+(o.total||0),0),lv={};for(const o of M){const k=LN[o.member.level]||(o.member.level?'Level '+o.member.level:'Member');lv[k]=(lv[k]||0)+1}
 const members={orders:M.length,buyers:new Set(M.map(o=>String(o.customer?.email||'').toLowerCase())).size,sales_cents:mc,share_pct:sales?Math.round(mc*100/sales):0,
  discount_cents:M.reduce((n,o)=>n+(o.member_discount||o.member.discount||0),0),shipping_waived_cents:M.reduce((n,o)=>n+(o.member.shipping_waived||0),0),
  avg_cents:M.length?Math.round(mc/M.length):0,levels:Object.entries(lv).sort((a,b)=>b[1]-a[1])};
 return{subscriptions,accounts:accountsOut,members};
}

function report(orders,visitors,products,L,all,extra={}){
 const t=now(),end=L.ended_at||t+1,base=summary(orders,L),list=windowOrders(orders,L,end).sort((a,b)=>placed(a)-placed(b));
 const mins=Math.max(1,Math.ceil((end-L.started_at)/60)),prod=new Map(products.map(p=>[p.id,p]));
 // customers: new = no counted order before this one, ever
 const firstSeen=new Map();for(const o of orders.filter(counts).sort((a,b)=>placed(a)-placed(b))){const e=email(o);if(!firstSeen.has(e))firstSeen.set(e,placed(o))}
 const buyers=new Map();for(const o of list){const e=email(o),b=buyers.get(e)||{name:firstName(o),state:String(o.customer?.state||'').toUpperCase(),orders:0,cents:0,new:firstSeen.get(e)>=L.started_at};b.orders++;b.cents+=o.total||0;buyers.set(e,b)}
 const B=[...buyers.values()],newB=B.filter(b=>b.new),retB=B.filter(b=>!b.new);
 const states={};for(const b of B)if(b.state)states[b.state]=(states[b.state]||0)+1;
 // money
 const waiting=list.filter(o=>!isPaid(o)),methods={};for(const o of list){const k=o.payment_method||'other',m=methods[k]||(methods[k]={orders:0,cents:0,paid:0});m.orders++;m.cents+=o.total||0;if(isPaid(o))m.paid++}
 const coupons={};for(const o of list)for(const c of (o.coupons&&o.coupons.length?o.coupons:o.coupon?[o.coupon]:[]))coupons[String(c).toUpperCase()]=(coupons[String(c).toUpperCase()]||0)+1;
 const discount=list.reduce((n,o)=>n+(o.discount||0)+(o.coupon_discount||0),0);
 // products
 const byP=new Map();for(const o of list)for(const i of o.items||[]){const r=byP.get(i.id)||{id:i.id,name:(prod.get(i.id)?.name||i.name||'Product')+(prod.get(i.id)?.size&&!String(prod.get(i.id).name).includes(prod.get(i.id).size)?' '+prod.get(i.id).size:''),units:0,orders:0,stock_now:prod.get(i.id)?.stock??null};r.units+=i.quantity||0;r.orders++;byP.set(i.id,r)}
 const P=[...byP.values()].sort((a,b)=>b.units-a.units||b.orders-a.orders);
 // timing: 5-minute buckets
 const bucket=5,nb=Math.max(1,Math.ceil(mins/bucket)),timeline=Array.from({length:nb},(_,k)=>({at:L.started_at+k*bucket*60,orders:0,cents:0,online:0}));
 for(const o of list){const k=Math.min(nb-1,Math.floor((placed(o)-L.started_at)/(bucket*60)));timeline[k].orders++;timeline[k].cents+=o.total||0}
 // site: people on the site per minute (from the anonymous pings)
 const V=visitors.filter(v=>v.live===L.id),perMin=new Array(mins).fill(0);const m0=Math.floor(L.started_at/60);for(const v of V)for(const a of v.minutes||[]){const m=a-m0;if(m>=0&&m<mins)perMin[m]++}
 for(let k=0;k<nb;k++)timeline[k].online=Math.max(0,...perMin.slice(k*bucket,(k+1)*bucket));
 const peak=Math.max(0,...perMin),peakAt=peak?L.started_at+perMin.indexOf(peak)*60:null,activeMins=perMin.filter(n=>n>0);
 const src={};for(const v of V){const k=v.src||'direct';src[k]=(src[k]||0)+1}
 const online_now=L.ended_at?0:V.filter(v=>t-(v.last||0)<=ONLINE_WINDOW).length;
 const peakBucket=timeline.reduce((b,x)=>x.cents>b.cents?x:b,{cents:-1});
 // after the live: orders in the 2 hours after it ended
 const tail=L.ended_at?orders.filter(o=>counts(o)&&placed(o)>=L.ended_at&&placed(o)<L.ended_at+TAIL):[];
 // compare with earlier lives
 const earlier=all.filter(x=>x.id!==L.id&&x.started_at<L.started_at&&x.ended_at).sort((a,b)=>b.started_at-a.started_at).map(x=>summary(orders,x));
 const avg=k=>earlier.length?Math.round(earlier.reduce((n,x)=>n+x[k],0)/earlier.length):null;
 const tk=L.tiktok||{},viewers=tk.viewers||0;
 return{...base,running:!L.ended_at,
  money:{sales_cents:base.sales_cents,paid_cents:base.paid_cents,waiting_cents:waiting.reduce((n,o)=>n+(o.total||0),0),waiting_orders:waiting.length,
   collected_pct:base.sales_cents?Math.round(base.paid_cents*100/base.sales_cents):0,avg_cents:base.avg_cents,per_minute_cents:base.per_minute_cents,per_hour_cents:base.per_minute_cents*60,
   biggest_cents:Math.max(0,...list.map(o=>o.total||0)),discount_cents:discount,goal_pct:L.goal_cents?Math.round(base.sales_cents*100/L.goal_cents):null,methods,coupons},
  customers:{buyers:B.length,new:newB.length,returning:retB.length,new_cents:newB.reduce((n,b)=>n+b.cents,0),returning_cents:retB.reduce((n,b)=>n+b.cents,0),
   repeat_in_live:B.filter(b=>b.orders>1).length,states:Object.entries(states).sort((a,b)=>b[1]-a[1]).slice(0,8),top:B.sort((a,b)=>b.cents-a.cents).slice(0,10)},
  products:{units:list.reduce((n,o)=>n+units(o),0),per_order:list.length?Math.round(list.reduce((n,o)=>n+units(o),0)*10/list.length)/10:0,top:P.slice(0,15),sold_out:P.filter(p=>p.stock_now===0).map(p=>p.name)},
  timing:{bucket_minutes:bucket,timeline,first_order_after_min:list.length?Math.round((placed(list[0])-L.started_at)/60):null,
   peak:peakBucket.cents>0?{at:peakBucket.at,orders:peakBucket.orders,cents:peakBucket.cents}:null,
   tail:{orders:tail.length,cents:tail.reduce((n,o)=>n+(o.total||0),0),hours:TAIL/3600}},
  site:{visitors:V.length,peak_online:peak,peak_at:peakAt,avg_online:activeMins.length?Math.round(activeMins.reduce((a,b)=>a+b,0)/activeMins.length):0,online_now,
   added_to_bag:V.filter(v=>v.bag).length,started_checkout:V.filter(v=>v.checkout).length,bounced:V.filter(bounced).length,bounce_rate_pct:V.length?Math.round(V.filter(bounced).length*1000/V.length)/10:null,median_minutes:medianMinutes(V),sources:Object.entries(src).sort((a,b)=>b[1]-a[1]),
   order_rate_pct:V.length?Math.round(list.length*1000/V.length)/10:null},
  tiktok:{...tk,buyers_per_100_viewers:viewers?Math.round(B.length*1000/viewers)/10:null,sales_per_viewer_cents:viewers?Math.round(base.sales_cents/viewers):null},
  ...extrasFor(L,end,list,orders,extra.subs,extra.accounts,base.sales_cents),
  compare:{lives_before:earlier.length,last:earlier[0]||null,avg:{sales_cents:avg('sales_cents'),orders:avg('orders'),avg_cents:avg('avg_cents'),per_minute_cents:avg('per_minute_cents'),buyers:avg('buyers')},
   best:earlier.reduce((b,x)=>!b||x.sales_cents>b.sales_cents?x:b,null)}}}

// ---- routes ----
async function route(path,body,h,method,{session}){
 if(path==='/live/ping'&&method==='POST')return{status:200,headers:{},body:await ping(body||{},h)};
 if(!path.startsWith('/admin/live'))return null;
 const who=await transaction(async s=>{const sid=await session(s,h);const x=await s.get('sessions',sid);return x?.staff_id||'owner'});
 const ok=b=>({status:200,headers:{},body:b});
 if(path==='/admin/live'&&method==='GET')return ok(await transaction(async s=>{
  const all=(await s.list('live_sessions')).filter(x=>x.id!==ACTIVE&&x.started_at),orders=await list(s,'orders'),L=await active(s);
  let online_now=0;if(L){const t=now();online_now=(await s.list('live_visitors')).filter(v=>v.live===L.id&&t-(v.last||0)<=ONLINE_WINDOW).length}
  return{active:L?{...summary(orders,L),online_now}:null,lives:all.sort((a,b)=>b.started_at-a.started_at).slice(0,100).map(x=>summary(orders,x))}}));
 if(path==='/admin/live/start'&&method==='POST')return ok(await transaction(async s=>{
  if(await active(s))bad('A live is already running. End it first.',409);const t=now();let id=newId(t);for(let k=2;await s.get('live_sessions',id);k++){if(k>9)bad('Too many lives started this minute.',409);id=newId(t)+'-'+k}
  const goal=int(body.goal_dollars);const L={id,started_at:t,ended_at:null,started_by:who,goal_cents:goal?goal*100:0,tiktok:{},note:''};
  await s.put('live_sessions',id,L);await s.put('live_sessions',ACTIVE,{id:ACTIVE,live:id});return{live:L}}));
 if(path==='/admin/live/stop'&&method==='POST')return ok(await transaction(async s=>{
  const L=await active(s);if(!L)bad('No live is running.',409);const t=now(),V=(await s.list('live_visitors')).filter(v=>v.live===L.id),mins=Math.ceil((t-L.started_at)/60),perMin=new Array(Math.max(1,mins)).fill(0);
  const m0=Math.floor(L.started_at/60);for(const v of V)for(const a of v.minutes||[]){const m=a-m0;if(m>=0&&m<perMin.length)perMin[m]++}
  L.ended_at=t;L.ended_by=who;L.peak_online=Math.max(0,...perMin);L.visitors=V.length;await s.put('live_sessions',L.id,L);await s.put('live_sessions',ACTIVE,{id:ACTIVE,live:null});return{live:L}}));
 if(path==='/admin/live/update'&&method==='POST')return ok(await transaction(async s=>{
  const L=await s.get('live_sessions',String(body.id||''));if(!L||L.id===ACTIVE)bad('Live not found.',404);
  if(body.tiktok&&typeof body.tiktok==='object'){const tk={...(L.tiktok||{})};for(const k of TIKTOK){if(!(k in body.tiktok))continue;const v=body.tiktok[k];if(v===''||v==null)delete tk[k];else{const n=int(v);if(n==null)bad('TikTok numbers must be whole numbers.');tk[k]=n}}L.tiktok=tk}
  if(body.goal_dollars!==undefined){const g=int(body.goal_dollars);L.goal_cents=g?g*100:0}
  if(typeof body.note==='string')L.note=body.note.replace(/\s+/g,' ').trim().slice(0,500);
  // fix the times if she forgot to press Start or End (whole minutes, end after start, at most 8 hours)
  if(body.started_at!==undefined||body.ended_at!==undefined){const st=body.started_at!==undefined?epoch(body.started_at):L.started_at,en=body.ended_at!==undefined?(body.ended_at===null?null:epoch(body.ended_at)):L.ended_at;
   if(!st||st>now()+60)bad('Pick a start time that has already happened.');if(body.ended_at!==undefined&&body.ended_at!==null&&en==null)bad('Pick a valid end time.');if(en!=null&&(en<=st||en-st>MAX_HOURS*3600))bad('The end must be after the start and within 8 hours.');if(L.ended_at&&en==null)bad('Use Start live to begin a new live.');
   L.started_at=st;if(L.ended_at)L.ended_at=en;L.times_edited_at=now()}
  await s.put('live_sessions',L.id,L);return{live:L}}));
 const r=path.match(/^\/admin\/live\/report\/(LIVE-\d{8}-\d{4}(?:-\d)?)$/);
 if(r&&method==='GET')return ok(await transaction(async s=>{const L=await s.get('live_sessions',r[1]);if(!L)bad('Live not found.',404);
  const all=(await s.list('live_sessions')).filter(x=>x.id!==ACTIVE&&x.started_at);const subsLib=require('./subscriptions.cjs'),pm=await subsLib.productsOf(s),settings=await s.get('settings','main');
  const subs=(await s.list('subscriptions')).map(x=>{const p=subsLib.pricingOf(x,pm,settings);return{...x,value_cents:p.total_cents??null}});
  return{report:report(await list(s,'orders'),await s.list('live_visitors'),await s.list('products'),L,all,{subs,accounts:await s.list('customers')})}}));
 bad('Not found.',404);
}
module.exports={route,ping,summary,report,newId,TIKTOK};

'use strict';
// Growth tools (Jonah, 8 Nov 2026: "I don't feel like I'm done being better").
//   Reorder engine   one email ~30 days after a customer's last order: same items back in the bag in one tap,
//                    plus a "Reorder" button on every past order in the account.
//   Bag recovery     signed-in customers' bags are saved; one reminder 3–48 hours after they leave items behind.
//   Verified reviews a rating request after delivery; reviews show on the store only after the owner approves them.
//   Sales funnel     anonymous counts of visits → bag → checkout by source, and orders/paid/revenue by source.
// The three emails run only from Autopilot switches (all start OFF), only for Glow, never to anyone who unsubscribed,
// and only once a postal address is set (STORE_POSTAL_ADDRESS), which marketing email law requires.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const DAY=86400;
const RULES={reorder_after_days:30,reorder_max_days:90,bag_after_hours:3,bag_max_hours:48,bag_gap_days:7,review_after_delivered_days:2,review_after_shipped_days:7,review_max_days:45,review_gap_days:30};
const SOURCES=/^[a-z0-9_-]{1,24}$/;
const EVENTS=['visit','bag','checkout'];
const list=(s,kind)=>s.listLite?s.listLite(kind):s.list(kind);
const lower=e=>String(e||'').trim().toLowerCase();
const first=n=>String(n||'').trim().split(/\s+/)[0]||'there';
const money=c=>'$'+((Number(c)||0)/100).toFixed(2);
function etHour(t=Date.now()){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)))}
function etDay(t=Date.now()){return new Date(t).toLocaleDateString('en-CA',{timeZone:'America/New_York'})}
function longDate(ts){return new Date(ts*1000).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'long',day:'numeric'})}
function dayDiff(a,b){return Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/864e5)}

// ---- signed links (no login needed): kind.id.expires.signature ----
function secret(){const k=process.env.STORE_SESSION_SECRET||'';if(k.length<32)bad('Links are not configured.',503);return k}
function sig(v){return crypto.createHmac('sha256',secret()).update('growth:'+v).digest('base64url').slice(0,32)}
function makeRef(kind,id,days){const exp=now()+days*DAY;return kind+'.'+id+'.'+exp+'.'+sig(kind+'.'+id+'.'+exp)}
function readRef(ref,kinds){const m=String(ref||'').match(/^([a-z]+)\.([A-Za-z0-9_-]{4,64})\.(\d{9,11})\.([A-Za-z0-9_-]{32})$/);if(!m||!kinds.includes(m[1]))bad('This link is not valid.',404);
 const want=Buffer.from(sig(m[1]+'.'+m[2]+'.'+m[3])),got=Buffer.from(m[4]);if(want.length!==got.length||!crypto.timingSafeEqual(want,got))bad('This link is not valid.',404);if(Number(m[3])<now())bad('This link has expired.',410);return{kind:m[1],id:m[2]}}

// ---- unsubscribe (reminder and review emails only; order and shipping emails always go out) ----
const emailKey=e=>crypto.createHash('sha256').update(lower(e)).digest('hex').slice(0,40);
async function prefs(s,email){return await s.get('email_prefs',emailKey(email))||{id:emailKey(email)}}
async function suppressed(s,email){return !!(await prefs(s,email)).unsubscribed}
function postal(){return String(process.env.STORE_POSTAL_ADDRESS||'').trim().slice(0,200)}
function origin(){return require('./store-email.cjs').configuration().origin||String(process.env.STORE_ORIGIN||'').replace(/\/$/,'')}
function footer(email){return{unsubscribe:origin()+'/api/unsubscribe/'+makeRef('unsub',emailKey(email),3650),address:postal(),reason:'You’re getting this because you ordered from Glow Lab.'}}
function ready(){const cfg=require('./store-email.cjs').configuration();if(!cfg.ready)return 'email_not_configured';if(!postal())return 'needs_postal_address';return ''}
function page(title,line){const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Glow Lab</title></head><body style="margin:0;background:#fbf9f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b1b1b"><main style="max-width:520px;margin:12vh auto;padding:32px 24px;text-align:center"><div style="font-size:12px;letter-spacing:5px;color:#806020;font-weight:700">GLOW LAB</div><h1 style="font-family:Georgia,serif;font-weight:600;font-size:30px;margin:18px 0 10px">${title}</h1><p style="font-size:16px;line-height:1.6;color:#3d3a35">${line}</p><p><a href="/store-next/" style="color:#806020">Back to the store</a></p></main></body></html>`;return{status:200,headers:{},body:{_binary:Buffer.from(html).toString('base64'),_type:'text/html; charset=utf-8'}}}

// ---- shared: items that can go back in a bag (active, in stock, Glow) ----
async function bagItems(s,lines){const brands=require('./brands.cjs'),out=[],missing=[];
 for(const l of (Array.isArray(lines)?lines:[]).slice(0,40)){const id=Number(l?.id),q=Math.floor(Number(l?.quantity)||0);if(!Number.isInteger(id)||q<1)continue;const p=await s.get('products',id);
  if(!p||!p.active||brands.productBrand(p)!=='glow'||!(Number(p.stock)>0)){missing.push(String(l.name||p?.name||'An item'));continue}
  const lim=Math.min(q,Number(p.stock)||0,Number(p.max_order_quantity)||99);const hit=out.find(x=>x.id===id);if(hit)hit.quantity=Math.min(hit.quantity+lim,Number(p.stock)||0);else out.push({id,quantity:lim,name:p.name})}
 return{items:out,missing}}
function ownsOrder(o,a){return !!a&&!!o&&(o.customer_id===a.id||(a.verified===true&&lower(o.customer?.email)===a.email))}

// ---- email wording (one place, so the owner can approve it) ----
function reorderEmail({name,date,weeks,items}){return{subject:'Ready to restock? Your Glow Lab order is one tap away',title:'Ready to restock?',button:'Reorder in one tap',
 lines:['Hi '+first(name)+',','It’s been about '+weeks+' weeks since your last Glow Lab order on '+date+'. Here’s what you ordered:',...items.map(i=>i.name+' × '+i.quantity),'Tap below and we’ll put the same items back in your bag. You can change anything before you pay.','Want it handled for you? Choose Subscribe & save in your bag: 15% off every package, delivered on your schedule.']}}
function bagEmail({name,items}){return{subject:'You left something in your bag',title:'Still deciding?',button:'Return to my bag',
 lines:['Hi '+first(name)+',','You left these in your Glow Lab bag:',...items.map(i=>i.name+' × '+i.quantity),'Your bag is saved. Tap below to pick up right where you left off.','Questions before you order? Just reply to this email.']}}
function reviewEmail({name,orderId}){return{subject:'How did we do?',title:'How did your order arrive?',button:'Rate your order',
 lines:['Hi '+first(name)+',','Your Glow Lab order '+orderId+' has arrived. Would you take 30 seconds to rate it?','Your honest review helps other researchers know what to expect from us: shipping speed, packaging and service.']}}
async function queue(s,{id,kind,to,related,copy,url}){const emails=require('./store-email.cjs');
 return emails.enqueue(s,{id,kind,brand:'glow',to,related_id:related,subject:copy.subject,content:emails.template(copy.title,copy.lines,url,copy.button,null,null,{footer:footer(to)})})}

// ---- 1. Reorder engine ----
async function reorders(limit=25,t=Date.now()){const why=ready();if(why)return{status:why,sent:0};const h=etHour(t);if(h<10||h>=19)return{status:'quiet_hours',sent:0};const ts=Math.floor(t/1000);
 const jobs=await transaction(async s=>{const orders=(await list(s,'orders')).filter(o=>o.is_test===false&&(o.brand||'glow')==='glow'&&o.customer?.email);
  const subs=new Set((await s.list('subscriptions')).filter(x=>['active','paused','pending_first_payment'].includes(x.status)).map(x=>lower(x.customer?.email)));
  const latest=new Map();for(const o of orders){if(['canceled','expired'].includes(o.status))continue;const k=lower(o.customer.email),p=latest.get(k);if(!p||(o.created||0)>(p.created||0))latest.set(k,o)}
  const due=[...latest.values()].filter(o=>['paid','shipped'].includes(o.status)&&!o.subscription_id&&!o.reorder_reminded_at&&(o.items||[]).length&&ts-(o.created||0)>=RULES.reorder_after_days*DAY&&ts-(o.created||0)<=RULES.reorder_max_days*DAY&&!subs.has(lower(o.customer.email))).sort((a,b)=>(a.created||0)-(b.created||0));
  const out=[];for(const lite of due){if(out.length>=limit)break;const o=await s.get('orders',lite.id);if(!o||o.reorder_reminded_at||await suppressed(s,o.customer.email))continue;
   const {items}=await bagItems(s,o.items);if(!items.length){o.reorder_reminded_at=ts;o.reorder_skipped='nothing in stock';await s.put('orders',o.id,o);continue}
   const copy=reorderEmail({name:o.customer.name,date:longDate(o.created),weeks:Math.max(4,Math.round((ts-o.created)/(7*DAY))),items});
   const job=await queue(s,{id:'reorder-'+o.id,kind:'reorder_reminder',to:o.customer.email,related:o.id,copy,url:origin()+'/store-next/?restore='+makeRef('order',o.id,21)+'#bag'});
   if(!job)continue;o.reorder_reminded_at=ts;await s.put('orders',o.id,o);out.push(job)}
  return out});
 const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}

// ---- 2. Bag recovery ----
function cleanBag(items){return (Array.isArray(items)?items:[]).slice(0,30).map(i=>({id:Number(i?.id),quantity:Math.min(20,Math.floor(Number(i?.quantity)||0))})).filter(i=>Number.isInteger(i.id)&&i.id>0&&i.quantity>0)}
async function saveBag(s,a,items){const id=a.id,prev=await s.get('bags',id),clean=cleanBag(items),same=prev&&JSON.stringify(prev.items)===JSON.stringify(clean);
 if(same)return prev;const rec={...(prev||{}),id,customer_id:a.id,email:a.email,name:a.name||prev?.name||'',items:clean,updated:now()};await s.put('bags',id,rec);return rec}
async function bags(limit=25,t=Date.now()){const why=ready();if(why)return{status:why,sent:0};const h=etHour(t);if(h<9||h>=21)return{status:'quiet_hours',sent:0};const ts=Math.floor(t/1000);
 const jobs=await transaction(async s=>{const all=(await s.list('bags')).filter(b=>b.items?.length&&b.email&&b.reminded_for!==b.updated&&ts-b.updated>=RULES.bag_after_hours*3600&&ts-b.updated<=RULES.bag_max_hours*3600&&(b.last_reminded||0)<ts-RULES.bag_gap_days*DAY);
  if(!all.length)return[];const orders=await list(s,'orders'),out=[];
  for(const b of all){if(out.length>=limit)break;if(orders.some(o=>lower(o.customer?.email)===b.email&&(o.created||0)>=b.updated))continue;if(await suppressed(s,b.email))continue;
   const {items}=await bagItems(s,b.items);if(!items.length)continue;const acct=await s.get('customers',b.customer_id);
   const job=await queue(s,{id:'bag-'+b.id+'-'+b.updated,kind:'bag_reminder',to:b.email,related:b.id,copy:bagEmail({name:acct?.name||b.name,items}),url:origin()+'/store-next/?restore='+makeRef('bag',b.id,7)+'#bag'});
   if(!job)continue;const rec=await s.get('bags',b.id);rec.reminded_for=b.updated;rec.last_reminded=ts;await s.put('bags',b.id,rec);out.push(job)}
  return out});
 const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}

// ---- 3. Verified reviews ----
// Words that usually mean a health or use claim. Reviews are only ever shown after the owner approves them; these are flagged.
const FLAG=/\b(inject\w*|dos(?:e|es|ed|ing|age)|mcg|iu|weight|lbs?|pounds?|lost|fat|muscle|pain|heal\w*|cur(?:e|ed|es)|sleep\w*|energy|skin|wrinkle\w*|acne|hair|libido|tan(?:ned|ning)?|appetite|results?|side ?effects?|felt|feel(?:s|ing)?|body|recover\w*|inflam\w*|diabet\w*|doctor|treat\w*|symptom\w*|cycle|stack(?:ed|ing)?)\b/gi;
function flagsOf(text){return [...new Set((String(text).match(FLAG)||[]).map(w=>w.toLowerCase()))].slice(0,12)}
function reviewDue(o,today){if(o.status!=='shipped'||o.review_requested_at)return false;const d=o.delivery?.delivered_date,sd=o.shipment?.ship_date;if(!d&&!sd)return false;
 if(sd&&dayDiff(sd,today)>RULES.review_max_days)return false;return d?dayDiff(d,today)>=RULES.review_after_delivered_days:dayDiff(sd,today)>=RULES.review_after_shipped_days}
async function reviews(limit=20,t=Date.now()){const why=ready();if(why)return{status:why,sent:0};const h=etHour(t);if(h<10||h>=19)return{status:'quiet_hours',sent:0};const ts=Math.floor(t/1000),today=etDay(t);
 const jobs=await transaction(async s=>{const due=(await list(s,'orders')).filter(o=>o.is_test===false&&(o.brand||'glow')==='glow'&&o.customer?.email&&reviewDue(o,today)).sort((a,b)=>(a.created||0)-(b.created||0)),out=[],asked=new Set();
  for(const lite of due){if(out.length>=limit)break;const o=await s.get('orders',lite.id),k=lower(o.customer.email);if(!o||!reviewDue(o,today)||asked.has(k))continue;const p=await prefs(s,k);
   if(p.unsubscribed||(p.last_review_ask||0)>ts-RULES.review_gap_days*DAY||await s.get('reviews',o.id)){o.review_requested_at=ts;o.review_skipped=p.unsubscribed?'unsubscribed':'asked recently';await s.put('orders',o.id,o);continue}
   const job=await queue(s,{id:'review-ask-'+o.id,kind:'review_request',to:o.customer.email,related:o.id,copy:reviewEmail({name:o.customer.name,orderId:o.id}),url:origin()+'/store-next/?review='+makeRef('review',o.id,60)});
   if(!job)continue;o.review_requested_at=ts;await s.put('orders',o.id,o);p.last_review_ask=ts;await s.put('email_prefs',p.id,p);asked.add(k);out.push(job)}
  return out});
 const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}
function publicReview(r){return{rating:r.rating,text:r.text||'',name:r.name||'Verified buyer',state:r.state||'',date:r.created?new Date(r.created*1000).toLocaleDateString('en-US',{timeZone:'America/New_York',month:'short',year:'numeric'}):''}}
async function reviewSummary(s){const ok=(await s.list('reviews')).filter(r=>r.status==='approved');if(!ok.length)return{count:0,average:0,reviews:[]};
 const avg=Math.round(ok.reduce((n,r)=>n+r.rating,0)/ok.length*10)/10;return{count:ok.length,average:avg,reviews:ok.sort((a,b)=>(b.approved_at||b.created)-(a.approved_at||a.created)).slice(0,12).map(publicReview)}}

// ---- 4. Sales funnel ----
const BOT=/bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|monitor/i;
async function event(s,body,h){const e=String(body.e||''),src=SOURCES.test(String(body.src||''))?body.src:'direct';if(!EVENTS.includes(e)||BOT.test(String(h['user-agent']||'')))return;
 const id='day-'+etDay(),d=await s.get('analytics',id)||{id,day:etDay(),s:{}};const row=d.s[src]||(d.s[src]={visit:0,bag:0,checkout:0});if(Object.keys(d.s).length>60&&!d.s[src])return;row[e]=(row[e]||0)+1;await s.put('analytics',id,d)}
async function funnel(s,days){const n=[7,30,90].includes(days)?days:7,today=etDay(),start=new Date(Date.parse(today+'T12:00:00Z')-(n-1)*864e5).toISOString().slice(0,10);
 const bySrc={},blank=()=>({visit:0,bag:0,checkout:0,orders:0,paid:0,revenue_cents:0}),daily={};
 for(const d of await s.list('analytics')){if(!d.day||d.day<start||d.day>today)continue;const dd=daily[d.day]||(daily[d.day]=blank());for(const[k,v]of Object.entries(d.s||{})){const r=bySrc[k]||(bySrc[k]=blank());for(const e of EVENTS){r[e]+=v[e]||0;dd[e]+=v[e]||0}}}
 for(const o of await list(s,'orders')){if(o.is_test!==false||(o.brand||'glow')!=='glow'||o.subscription_id&&!o.subscription_first)continue;const day=etDay((o.created||0)*1000);if(day<start||day>today)continue;if(o.checkout_stage==='draft'&&o.status==='order_received')continue;
  const k=o.source||'unknown',r=bySrc[k]||(bySrc[k]=blank()),dd=daily[day]||(daily[day]=blank());r.orders++;dd.orders++;if(['paid','shipped'].includes(o.status)){r.paid++;dd.paid++;r.revenue_cents+=o.total||0;dd.revenue_cents+=o.total||0}}
 const total=blank();for(const r of Object.values(bySrc))for(const k of Object.keys(total))total[k]+=r[k];
 return{days:n,start,end:today,total,sources:Object.entries(bySrc).map(([source,r])=>({source,...r})).sort((a,b)=>b.visit-a.visit||b.revenue_cents-a.revenue_cents),daily:Object.entries(daily).sort().map(([day,r])=>({day,...r}))}}

// ---- routes ----
async function route(path,body,h,method,{session}){
 const ok=b=>({status:200,headers:{},body:b}),accounts=require('./customer-accounts.cjs');
 const un=path.match(/^\/unsubscribe\/(.+)$/);
 if(un&&method==='GET'){try{const r=readRef(un[1],['unsub']);await transaction(async s=>{const p=await s.get('email_prefs',r.id)||{id:r.id};p.unsubscribed=true;p.unsubscribed_at=now();await s.put('email_prefs',p.id,p)});return page('You’re unsubscribed','You won’t get reminder or review emails from Glow Lab anymore. Emails about orders you place, like receipts and shipping updates, still arrive.')}
  catch(e){return page('That link didn’t work','It may have expired. Reply to any Glow Lab email and we’ll take you off the list by hand.')}}
 if(path==='/event'&&method==='POST'){await transaction(s=>event(s,body,h));return ok({ok:true})}
 if(path==='/reviews'&&method==='GET')return ok(await transaction(reviewSummary));
 if(path==='/restore'&&method==='POST'){const r=readRef(body.ref,['order','bag']);return ok(await transaction(async s=>{const src=r.kind==='order'?(await s.get('orders',r.id))?.items:(await s.get('bags',r.id))?.items;if(!src)bad('This link is not valid.',404);return bagItems(s,src)}))}
 if(path==='/account/reorder'&&method==='POST')return ok(await transaction(async s=>{const a=await accounts.session(s,h,true),o=await s.get('orders',String(body.id||'').slice(0,40));if(!o||!ownsOrder(o,a))bad('Order not found.',404);return bagItems(s,o.items)}));
 if(path==='/account/bag'&&method==='POST')return ok(await transaction(async s=>{const a=await accounts.session(s,h);if(!a)return{saved:false};await saveBag(s,a,body.items);return{saved:true}}));
 if(path==='/account/bag'&&method==='GET')return ok(await transaction(async s=>{const a=await accounts.session(s,h);if(!a)return{items:[]};const b=await s.get('bags',a.id);if(!b||!b.items?.length||now()-b.updated>7*DAY)return{items:[]};return bagItems(s,b.items)}));
 if(path==='/review/load'&&method==='POST'){const r=readRef(body.ref,['review']);return ok(await transaction(async s=>{const o=await s.get('orders',r.id);if(!o)bad('This link is not valid.',404);const done=await s.get('reviews',o.id);return{first_name:first(o.customer?.name),state:o.customer?.state||'',order_id:o.id,items:(o.items||[]).map(i=>i.name).slice(0,12),done:!!done}}))}
 if(path==='/review/submit'&&method==='POST'){const r=readRef(body.ref,['review']);const rating=Math.floor(Number(body.rating));if(!(rating>=1&&rating<=5))bad('Choose 1 to 5 stars.');
  const text=String(body.text||'').replace(/\s+/g,' ').trim().slice(0,600),show=body.show_name!==false;
  const jobs=await transaction(async s=>{const o=await s.get('orders',r.id);if(!o)bad('This link is not valid.',404);if(await s.get('reviews',o.id))bad('Thanks! We already have your review for this order.',409);
   const nm=String(o.customer?.name||'').trim().split(/\s+/),name=show?(nm[0]||'Verified buyer')+(nm.length>1?' '+nm[nm.length-1][0].toUpperCase()+'.':''):'Verified buyer';
   const rev={id:o.id,order_id:o.id,rating,text,name,state:show?String(o.customer?.state||'').slice(0,2):'',created:now(),status:'pending',flags:flagsOf(text)};await s.put('reviews',o.id,rev);
   const emails=require('./store-email.cjs'),out=[];for(const to of emails.alertRecipients())out.push(await emails.enqueue(s,{id:'review-new-'+o.id+'-'+crypto.createHash('sha256').update(to).digest('hex').slice(0,8),kind:'staff_review_alert',brand:'glow',to,related_id:o.id,subject:'New review '+'★'.repeat(rating)+' · waiting for your OK',content:emails.template('A new review is waiting.',[name+' rated order '+o.id+' '+rating+' out of 5.',...(text?['They wrote: “'+text+'”']:[]),...(rev.flags.length?['Check before approving. It mentions: '+rev.flags.join(', ')+'.']:[]),'Nothing shows on the store until you approve it in Management → Growth.'],origin()+'/store-next/admin','Open Management')}));return out.filter(Boolean)});
  const emails=require('./store-email.cjs');for(const j of jobs)await emails.safeDispatch(j);return ok({ok:true})}
 if(path==='/admin/growth'&&method==='POST'){await transaction(s=>session(s,h));const days=Number(body.days)||7;
  return ok(await transaction(async s=>({funnel:await funnel(s,days),reviews:(await s.list('reviews')).sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,200),summary:await reviewSummary(s),ready:ready(),rules:RULES,
   preview:{reorder:reorderEmail({name:'Jane Doe',date:'October 8',weeks:4,items:[{name:'KLOW · 80 mg',quantity:1},{name:'BAC Water · 3 mL',quantity:1}]}),bag:bagEmail({name:'Jane Doe',items:[{name:'GHK-Cu · 100 mg',quantity:1}]}),review:reviewEmail({name:'Jane Doe',orderId:'GLP-EXAMPLE'})},
   unsubscribed:(await s.list('email_prefs')).filter(p=>p.unsubscribed).length})))}
 if(path==='/admin/review'&&method==='POST'){await transaction(s=>session(s,h));const action=String(body.action||'');if(!['approve','hide','pending'].includes(action))bad('Choose approve or hide.');
  return ok(await transaction(async s=>{const r=await s.get('reviews',String(body.id||'').slice(0,40));if(!r)bad('Review not found.',404);r.status=action==='approve'?'approved':action==='hide'?'hidden':'pending';if(action==='approve')r.approved_at=now();await s.put('reviews',r.id,r);return r}))}
 return null}
module.exports={RULES,route,reorders,bags,reviews,saveBag,bagItems,funnel,event,reviewSummary,flagsOf,makeRef,readRef,reorderEmail,bagEmail,reviewEmail,reviewDue,emailKey};

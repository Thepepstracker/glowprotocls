'use strict';
// Shippo: buys the UPS label for every live, staff-verified paid order, saves the tracking number
// and sends the customer's "label created" email. One label per order, never two:
//  - every attempt holds a lease in the outbox and records when the purchase request started;
//  - before buying, recent Shippo labels are searched for this order's tag (metadata "GLOW:<order>");
//  - if a purchase may have reached Shippo but the answer was lost, the order stops for review.
// Secrets live only in Netlify: SHIPPO_API_TOKEN and the ship-from address SHIPPO_FROM_*.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs'),emails=require('./store-email.cjs'),tracker=require('./order-tracking.cjs');
const now=()=>Math.floor(Date.now()/1000),fail=(m,extra={})=>{throw Object.assign(new Error(m),{status:502},extra)}; // status: show the reason to staff instead of a generic error
const API='https://api.goshippo.com';
// soft_cap_cents: Jonah's $15 price check (24 Oct 2026). A label over it is never bought unless the owner signs off (override).
const DEFAULTS={servicelevel:'ups_second_day_air',parcel:{length:8,width:6,height:4,weight_lb:1},max_label_cents:6000,daily_limit:60,soft_cap_cents:1500};
// The saved value may have extra text pasted around the token; use only the token itself.
const token=()=>{const v=process.env.SHIPPO_API_TOKEN||'';const m=v.match(/shippo_(?:live|test)_[A-Za-z0-9]{20,}/);if(m)return m[0];const t=v.trim();return /^[\x21-\x7e]{8,300}$/.test(t)?t:''};
const tokenProblem=()=>{const v=process.env.SHIPPO_API_TOKEN||'';if(!v)return '';if(token())return '';return 'SHIPPO_API_TOKEN in Netlify does not hold a Shippo token (it is '+v.length+' characters and has no shippo_live_ key in it). Replace its value with only the API token from Shippo > Settings > API.'};
const configured=()=>!!token()&&!!fromAddress();
const fingerprint=()=>crypto.createHash('sha256').update(token()).digest('hex');
const testToken=()=>/^shippo_test_/.test(token());
const tag=id=>'GLOW:'+id;
const money=c=>'$'+(c/100).toFixed(2);
const svcName=r=>((r?.provider||'')+' '+(r?.servicelevel?.name||r?.servicelevel?.token||'')).trim();
function priceCheck(cents,cfg,override,rate){if(cents>cfg.soft_cap_cents&&!override)fail('Price check: this label costs '+money(cents)+' ('+svcName(rate)+'), over the '+money(cfg.soft_cap_cents)+' limit. Nothing was bought. The owner can override.',{definite:true,price_check:true,cents,service:svcName(rate)})}
function fromAddress(){const e=process.env;if(!e.SHIPPO_FROM_STREET1||!e.SHIPPO_FROM_CITY||!e.SHIPPO_FROM_STATE||!e.SHIPPO_FROM_ZIP)return null;return{name:e.SHIPPO_FROM_NAME||'Glow Lab',...(e.SHIPPO_FROM_COMPANY?{company:e.SHIPPO_FROM_COMPANY}:{}),street1:e.SHIPPO_FROM_STREET1,...(e.SHIPPO_FROM_STREET2?{street2:e.SHIPPO_FROM_STREET2}:{}),city:e.SHIPPO_FROM_CITY,state:e.SHIPPO_FROM_STATE,zip:e.SHIPPO_FROM_ZIP,country:'US',phone:e.SHIPPO_FROM_PHONE||'',email:fromEmail()}}
// USPS refuses a label without a sender email; fall back to the store's reply-to / from address (24 Oct 2026).
function fromEmail(){const e=process.env;for(const v of [e.SHIPPO_FROM_EMAIL,e.STORE_EMAIL_REPLY_TO,e.STORE_EMAIL_FROM]){const m=String(v||'').match(/[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+/);if(m)return m[0]}return ''}
function settings(r){const p=r?.parcel||{};return{servicelevel:r?.servicelevel||DEFAULTS.servicelevel,carrier_account:r?.carrier_account||'',parcel:{length:p.length||DEFAULTS.parcel.length,width:p.width||DEFAULTS.parcel.width,height:p.height||DEFAULTS.parcel.height,weight_lb:p.weight_lb||DEFAULTS.parcel.weight_lb},max_label_cents:r?.max_label_cents||DEFAULTS.max_label_cents,daily_limit:r?.daily_limit||DEFAULTS.daily_limit,soft_cap_cents:r?.soft_cap_cents||DEFAULTS.soft_cap_cents}}
function status(r){const ok=configured(),same=ok&&r?.fingerprint===fingerprint();return{configured:ok,token_saved:!!process.env.SHIPPO_API_TOKEN,token_problem:tokenProblem(),from_saved:!!fromAddress(),test_mode:testToken(),connected:same,enabled:same&&r?.enabled===true&&!!r?.carrier_account&&(r.accounts||[]).some(a=>a.id===r.carrier_account),accounts:same?r.accounts||[]:[],checked_at:r?.checked_at||null,...settings(r)}}
async function request(route,body){
 if(!process.env.SHIPPO_API_TOKEN)fail('Save SHIPPO_API_TOKEN privately in Netlify first.');if(tokenProblem())fail(tokenProblem());
 let r;try{r=await fetch(API+route,{method:body?'POST':'GET',headers:{Authorization:'ShippoToken '+token(),'Content-Type':'application/json','Shippo-API-Version':'2018-02-08'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)})}catch(e){fail('Shippo could not be reached ('+String(e?.cause?.code||e?.name||'error')+': '+String(e?.cause?.message||e?.message||'').slice(0,120)+'). Check status before retrying.',{uncertain:true})}
 let data=null;try{data=await r.json()}catch{}
 if(!r.ok){const detail=data&&(data.detail||data.message||JSON.stringify(data).slice(0,200));fail('Shippo returned HTTP '+r.status+(detail?': '+detail:''),{definite:r.status>=400&&r.status<500})}
 if(!data)fail('Shippo returned an unexpected response.',{uncertain:true});return data;
}
async function check(){
 if(!fromAddress())fail('Save the ship-from address (SHIPPO_FROM_STREET1, CITY, STATE, ZIP, NAME, PHONE) privately in Netlify first.');
 const r=await request('/carrier_accounts/?results=100');if(!Array.isArray(r.results))fail('Shippo returned an unexpected carrier list.');
 return{fingerprint:fingerprint(),checked_at:now(),accounts:r.results.filter(a=>a.active!==false&&String(a.carrier||'').toLowerCase()==='ups').map(a=>({id:String(a.object_id),name:'UPS'+(a.account_id?' · '+String(a.account_id).slice(-6):'')+(a.carrier_name&&a.carrier_name!=='UPS'?' · '+String(a.carrier_name).slice(0,40):'')}))};
}
const eligible=o=>o?.is_test===false&&o.status==='paid'&&!!o.paid&&!o.balance_due_cents&&!o.refund_due_cents&&!o.shipstation_needs_review&&!o.shippo_needs_review&&!o.shippo_transaction_id;
function toAddress(o){const c=o.customer;return{name:String(c.name||'').slice(0,100),street1:String(c.address||'').slice(0,100),...(c.address2?{street2:String(c.address2).slice(0,100)}:{}),city:String(c.city||'').slice(0,60),state:String(c.state||'').slice(0,30),zip:String(c.zip||'').slice(0,20),country:'US',...(c.phone?{phone:String(c.phone).slice(0,30)}:{}),email:String(c.email||'').slice(0,120)}}
function shipmentBody(o,cfg){const p=cfg.parcel;return{address_from:fromAddress(),address_to:toAddress(o),parcels:[{length:String(p.length),width:String(p.width),height:String(p.height),distance_unit:'in',weight:String(p.weight_lb),mass_unit:'lb'}],metadata:tag(o.id),async:false}}
// Labels already bought for this order (searched by tag in the most recent Shippo labels).
async function existingLabels(id){const found=[];for(let page=1;page<=3;page++){const r=await request('/transactions/?results=100&page='+page);if(!Array.isArray(r.results))fail('Shippo label list needs review.',{uncertain:true});for(const t of r.results)if(t.metadata===tag(id)&&t.status==='SUCCESS')found.push(t);if(!r.next)break}return found}
// USPS (manual only, e.g. P.O. boxes UPS cannot reach) uses Shippo's USPS account, not the chosen UPS account.
const isUsps=t=>/^usps_/.test(String(t||''));
const pickRate=(rates,cfg)=>rates.find(r=>r.servicelevel?.token===cfg.servicelevel&&(isUsps(cfg.servicelevel)?/usps/i.test(String(r.provider||'usps')):(!r.carrier_account||r.carrier_account===cfg.carrier_account)));
function record(o,t,rate){const amount=Math.round(Number(rate?.amount||0)*100),svc=rate?.servicelevel?.token||rate?.servicelevel_token||'ups_second_day_air';return tracker.fromShippo(isUsps(svc)?'usps':'ups',svc,t.tracking_number,{ship_date:new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),source:'shippo',shippo_transaction_id:t.object_id,label_url:t.label_url||'',label_cost_cents:amount||null})}
async function finish(id,t,rate){let job=null;await transaction(async s=>{const stored=await s.get('orders',id);if(!stored||stored.status!=='paid')return;stored.status='shipped';stored.tracking=String(t.tracking_number).trim();stored.shipment=record(stored,t,rate);stored.shippo_status='label_bought';stored.shippo_message='';stored.shippo_transaction_id=t.object_id;stored.shippo_label_url=t.label_url||'';await s.put('orders',id,stored);job=await emails.queueUpdate(s,stored)});if(job)await emails.safeDispatch(job);return{status:'label_bought',tracking:t.tracking_number,label_url:t.label_url}}
// manual:true is a staff click on one order. It works while automatic buying is paused, so staff can
// pick which orders get labels; the every-minute worker still only buys when Shippo is turned on.
const MANUAL_SERVICES=['ups_second_day_air','ups_ground','ups_ground_saver','ups_3_day_select','ups_next_day_air_saver','ups_next_day_air','usps_priority','usps_ground_advantage'];
// servicelevel (manual only): buy this one label at another UPS service, e.g. Ground for nearby states.
async function buy(id,{manual=false,servicelevel='',override=false}={}){
 const claim=await transaction(async s=>{
  const integration=await s.get('integrations','shippo'),st=status(integration);if(!st.enabled&&!(manual&&st.connected&&st.carrier_account&&st.accounts.some(a=>a.id===st.carrier_account)))return{status:'not_connected',message:manual?'Check the Shippo connection and choose the UPS account first.':'Connect and turn on Shippo in Shipping first.'};
  const o=await s.get('orders',id);if(!eligible(o))return{status:'blocked',message:'Only live, staff-verified paid orders without a label can get one.'};
  const own=require('./own-contact.cjs').match(o.customer);if(own){o.shippo_status='needs_review';o.shippo_message='Not bought: the ship-to '+own+' is Glow Lab’s own. Fix the customer’s '+own+' first.';await s.put('orders',id,o);return{status:'needs_review',message:o.shippo_message}}
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),count=await s.get('integrations','shippo-count-'+today)||{n:0};if(count.n>=st.daily_limit)return{status:'paused',message:'Daily label limit reached ('+st.daily_limit+'). Raise it in Shipping to buy more today.'};
  const key='shippo-'+id,q=await s.get('outbox',key)||{id:key,provider:'shippo',order_id:id,attempts:0};
  if(q.status==='synced')return{status:'synced'};if(q.lease_until>now())return{status:'sending'};
  if(q.purchase_started&&q.status!=='failed')return{status:'needs_review',message:'A label purchase may have reached Shippo. Nothing more is bought until it is checked.'};
  q.lease=crypto.randomBytes(16).toString('hex');q.lease_until=now()+120;q.status='sending';q.attempts++;q.account_fingerprint=fingerprint();await s.put('outbox',key,q);
  return{o,q,key,cfg:manual&&MANUAL_SERVICES.includes(servicelevel)?{...st,servicelevel}:st,today};
 });
 if(!claim.o)return claim;const{o,q,key,cfg,today}=claim;let outcome,started=false;
 const save=async patch=>transaction(async s=>{const c=await s.get('outbox',key);if(c?.lease!==q.lease)fail('Label attempt no longer active.');Object.assign(c,patch);await s.put('outbox',key,c)});
 try{
  const already=await existingLabels(id);
  if(already.length>1)outcome={status:'needs_review',message:'Shippo already has '+already.length+' labels for this order. Void the extra one in Shippo.'};
  else if(already.length===1){outcome=await finish(id,already[0],already[0].rate&&typeof already[0].rate==='object'?already[0].rate:null);outcome.status='synced'}
  else{
   const shipment=await request('/shipments/',shipmentBody(o,cfg));
   const rates=Array.isArray(shipment.rates)?shipment.rates:[];
   const rate=pickRate(rates,cfg);
   if(!rate){const why=(shipment.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300);fail('No '+cfg.servicelevel.replace(/_/g,' ')+' rate for this address.'+(why?' Shippo: '+why:''),{definite:true,review:true})}
   const cents=Math.round(Number(rate.amount)*100);if(!(cents>0)||cents>cfg.max_label_cents)fail('Label price $'+(cents/100).toFixed(2)+' is over the $'+(cfg.max_label_cents/100).toFixed(2)+' limit. Raise the limit in Shipping or buy this one by hand.',{definite:true,review:true});
   priceCheck(cents,cfg,manual&&override,rate);
   await save({purchase_started:true,rate_id:rate.object_id,rate_cents:cents});started=true;
   const t=await request('/transactions/',{rate:rate.object_id,label_file_type:'PDF_4x6',metadata:tag(id),async:false});
   if(t.status==='SUCCESS'&&t.tracking_number){outcome=await finish(id,t,rate);outcome.status='synced';await transaction(async s=>{const k='shippo-count-'+today,c=await s.get('integrations',k)||{id:k,n:0};c.n++;await s.put('integrations',k,c)})}
   else if(t.status==='ERROR'){await save({purchase_started:false});started=false;fail('Shippo could not buy the label: '+((t.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300)||'no reason given'),{definite:true,review:true})}
   else fail('Shippo has not finished the label yet ('+(t.status||'unknown')+'). It will be checked again.',{uncertain:true});
  }
 }catch(e){const pc=!!e.price_check,review=(pc&&!manual)||!!e.review||(started&&!e.definite);outcome={status:pc&&manual?'price_check':review?'needs_review':'failed',message:e.message,...(pc?{cents:e.cents,service:e.service,limit_cents:cfg.soft_cap_cents}:{})}}
 await transaction(async s=>{const c=await s.get('outbox',key);if(c?.lease!==q.lease)return;Object.assign(c,{status:outcome.status,message:outcome.message||'',lease_until:0,checked_at:now(),next_attempt:now()+Math.min(3600,60*2**Math.min(c.attempts,6))});await s.put('outbox',key,c);const stored=await s.get('orders',id);if(stored&&stored.status==='paid'){stored.shippo_status=outcome.status;stored.shippo_message=outcome.message||'';if(outcome.status==='needs_review')stored.shippo_needs_review=true;await s.put('orders',id,stored)}});
 return outcome;
}
// Dry run: everything up to the purchase, for every waiting paid order. Rates only; nothing is bought and no order changes.
async function dryRun(limit=25){
 const{cfg,orders}=await transaction(async s=>{const st=status(await s.get('integrations','shippo'));if(!st.connected)fail('Check the Shippo connection first.',409);if(!st.carrier_account)fail('Choose the UPS account first.',409);return{cfg:st,orders:(await s.list('orders')).filter(eligible).sort((a,b)=>(a.paid||0)-(b.paid||0)).slice(0,limit)}});
 let labels=[];for(let page=1;page<=3;page++){const r=await request('/transactions/?results=100&page='+page);if(!Array.isArray(r.results))break;labels=labels.concat(r.results);if(!r.next)break}
 const out=[];
 for(const o of orders){const row={id:o.id,name:o.customer?.name||'',city:o.customer?.city||'',state:o.customer?.state||'',zip:o.customer?.zip||''};
  try{const own=require('./own-contact.cjs').match(o.customer);if(own){row.result='would_stop';row.message='Ship-to '+own+' is Glow Lab’s own.';out.push(row);continue}
   const have=labels.filter(t=>t.metadata===tag(o.id)&&t.status==='SUCCESS');if(have.length){row.result='label_exists';row.message='Shippo already has '+have.length+' label(s); the store would reuse it, not buy.';row.tracking=have[0].tracking_number;out.push(row);continue}
   const shipment=await request('/shipments/',shipmentBody(o,cfg));const rates=Array.isArray(shipment.rates)?shipment.rates:[];
   const rate=rates.find(r=>r.servicelevel?.token===cfg.servicelevel&&(!r.carrier_account||r.carrier_account===cfg.carrier_account));
   const why=(shipment.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300);
   if(!rate){row.result='would_stop';row.message='No '+cfg.servicelevel.replace(/_/g,' ')+' rate.'+(why?' Shippo: '+why:'');row.services=rates.map(r=>r.servicelevel?.token).filter(Boolean);row.ups=rates.filter(r=>/^ups_/.test(r.servicelevel?.token||'')).map(r=>({service:r.servicelevel.token,cents:Math.round(Number(r.amount)*100),days:r.estimated_days??r.days??null})).sort((a,b)=>a.cents-b.cents);out.push(row);continue}
   const cents=Math.round(Number(rate.amount)*100);row.cents=cents;row.days=rate.estimated_days??rate.days??null;row.service=(rate.provider||'UPS')+' '+(rate.servicelevel?.name||'');
   row.ups=rates.filter(r=>/^ups_/.test(r.servicelevel?.token||'')).map(r=>({service:r.servicelevel.token,cents:Math.round(Number(r.amount)*100),days:r.estimated_days??r.days??null})).sort((a,b)=>a.cents-b.cents);
   row.result=cents>0&&cents<=cfg.max_label_cents?'would_buy':'would_stop';if(row.result==='would_stop')row.message='$'+(cents/100).toFixed(2)+' is over the $'+(cfg.max_label_cents/100).toFixed(2)+' limit.';
   else if(cents>cfg.soft_cap_cents){row.result='price_check';row.message=money(cents)+' is over the '+money(cfg.soft_cap_cents)+' price check. Needs the owner to override.'}if(why)row.note=why;
  }catch(e){row.result='error';row.message=e.message}
  out.push(row)}
 const buy=out.filter(r=>r.result==='would_buy');
 return{checked_at:now(),enabled:cfg.enabled,servicelevel:cfg.servicelevel,parcel:cfg.parcel,from:{city:fromAddress()?.city,state:fromAddress()?.state,zip:fromAddress()?.zip},orders:out,would_buy:buy.length,total_cents:buy.reduce((n,r)=>n+r.cents,0)};
}
// Replacement label: one extra UPS label to the order's ship-to, for a missing or damaged item.
// Staff only. It never changes the order's status or emails the customer. The click key makes a
// double click buy one label, not two. Works while automatic buying is paused (connection must be checked).
async function replacement(id,{note='',key='',override=false}={}){
 note=String(note||'').trim().slice(0,140);key=String(key||'').replace(/[^A-Za-z0-9-]/g,'').slice(0,64);
 if(!note)fail('Say what is being replaced (for example "1 AICAR missing").',400);if(key.length<8)fail('Missing click key.',400);
 const okey='shippo-repl-'+key;
 const claim=await transaction(async s=>{
  const st=status(await s.get('integrations','shippo'));if(!st.connected||!st.carrier_account)fail('Check the Shippo connection and choose the UPS account first.',409);
  const o=await s.get('orders',id);if(!o)fail('Order not found.',404);if(o.is_test!==false)fail('Test orders cannot get a replacement label.',409);
  const own=require('./own-contact.cjs').match(o.customer);if(own)fail('The ship-to '+own+' is Glow Lab’s own. Fix the customer’s '+own+' first.',409);
  const prior=await s.get('outbox',okey);if(prior){if(prior.status==='synced')return{done:prior.result};fail('This replacement is already being bought or needs a check in Shippo. Nothing more was bought.',409)}
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),count=await s.get('integrations','shippo-count-'+today)||{n:0};if(count.n>=st.daily_limit)fail('Daily label limit reached ('+st.daily_limit+').',409);
  const n=(o.replacements||[]).length+1;await s.put('outbox',okey,{id:okey,provider:'shippo',order_id:id,status:'sending',started:now(),n});
  return{o,cfg:st,n,today};
 });
 if(claim.done)return{...claim.done,status:'already_bought'};
 const{o,cfg,n,today}=claim,meta=tag(id)+':R'+n;let started=false;
 try{
  const body=shipmentBody(o,cfg);body.metadata=meta;
  const shipment=await request('/shipments/',body);const rates=Array.isArray(shipment.rates)?shipment.rates:[];
  const rate=rates.find(r=>r.servicelevel?.token===cfg.servicelevel&&(!r.carrier_account||r.carrier_account===cfg.carrier_account));
  if(!rate)fail('No '+cfg.servicelevel.replace(/_/g,' ')+' rate for this address.',{definite:true});
  const cents=Math.round(Number(rate.amount)*100);if(!(cents>0)||cents>cfg.max_label_cents)fail('Label price $'+(cents/100).toFixed(2)+' is over the $'+(cfg.max_label_cents/100).toFixed(2)+' limit.',{definite:true});
  priceCheck(cents,cfg,override,rate);
  started=true;const t=await request('/transactions/',{rate:rate.object_id,label_file_type:'PDF_4x6',metadata:meta,async:false});
  if(t.status!=='SUCCESS'||!t.tracking_number)fail('Shippo could not buy the label: '+((t.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300)||t.status||'no reason given'),{definite:t.status==='ERROR'});
  const result={order_id:id,n,note,tracking:String(t.tracking_number),label_url:t.label_url||'',label_cost_cents:cents,service:'UPS '+(rate.servicelevel?.name||''),shippo_transaction_id:t.object_id,created:now()};
  await transaction(async s=>{const stored=await s.get('orders',id);stored.replacements=[...(stored.replacements||[]),result];await s.put('orders',id,stored);const q=await s.get('outbox',okey);q.status='synced';q.result=result;await s.put('outbox',okey,q);const k='shippo-count-'+today,c=await s.get('integrations',k)||{id:k,n:0};c.n++;await s.put('integrations',k,c)});
  return{...result,status:'label_bought'};
 }catch(e){await transaction(async s=>{const q=await s.get('outbox',okey);if(!q)return;if(!started||e.definite){await s.remove('outbox',okey)}else{q.status='needs_review';q.message=e.message;await s.put('outbox',okey,q)}});throw e}
}
// Staff checked the order (address fixed, or the label confirmed in Shippo): look for a label once more, then allow a new purchase.
async function retry(id,opts={}){await transaction(async s=>{const o=await s.get('orders',id);if(!o)fail('Order not found.');o.shippo_needs_review=false;o.shippo_message='';o.shippo_status='queued';await s.put('orders',id,o);const q=await s.get('outbox','shippo-'+id);if(q){q.purchase_started=false;q.status='failed';q.next_attempt=0;q.lease_until=0;await s.put('outbox',q.id,q)}});return buy(id,opts)}
async function enabled(){return transaction(async s=>status(await s.get('integrations','shippo')).enabled)}
async function pending(limit=3){
 const batch=await transaction(async s=>{if(!status(await s.get('integrations','shippo')).enabled)return[];const outbox=await s.list('outbox');return(await s.list('orders')).filter(eligible).filter(o=>{const q=outbox.find(x=>x.id==='shippo-'+o.id);return !(q?.purchase_started&&q.status!=='failed')&&(q?.next_attempt||0)<=now()}).sort((a,b)=>(a.paid||0)-(b.paid||0)).slice(0,limit).map(o=>o.id)});
 const results=[];for(const id of batch)results.push(await buy(id));return{processed:batch.length,results};
}
// Refund (void) an unused label. Shippo answers QUEUED/PENDING and settles the refund within days.
async function voidLabel(transactionId){const t=String(transactionId||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,64);if(t.length<4)fail('No Shippo label on this order.',{definite:true});const r=await request('/refunds/',{transaction:t,async:false});return{status:String(r.status||'').toUpperCase(),object_id:String(r.object_id||''),transaction:t}}
module.exports={voidLabel,configured,status,check,dryRun,replacement,buy,retry,pending,enabled,eligible,shipmentBody,fromAddress,settings,DEFAULTS,tag};

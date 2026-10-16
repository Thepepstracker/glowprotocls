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
const DEFAULTS={servicelevel:'ups_second_day_air',parcel:{length:8,width:6,height:4,weight_lb:1},max_label_cents:6000,daily_limit:60};
const configured=()=>!!process.env.SHIPPO_API_TOKEN&&!!fromAddress();
const fingerprint=()=>crypto.createHash('sha256').update(process.env.SHIPPO_API_TOKEN||'').digest('hex');
const testToken=()=>/^shippo_test_/.test(process.env.SHIPPO_API_TOKEN||'');
const tag=id=>'GLOW:'+id;
function fromAddress(){const e=process.env;if(!e.SHIPPO_FROM_STREET1||!e.SHIPPO_FROM_CITY||!e.SHIPPO_FROM_STATE||!e.SHIPPO_FROM_ZIP)return null;return{name:e.SHIPPO_FROM_NAME||'Glow Lab',...(e.SHIPPO_FROM_COMPANY?{company:e.SHIPPO_FROM_COMPANY}:{}),street1:e.SHIPPO_FROM_STREET1,...(e.SHIPPO_FROM_STREET2?{street2:e.SHIPPO_FROM_STREET2}:{}),city:e.SHIPPO_FROM_CITY,state:e.SHIPPO_FROM_STATE,zip:e.SHIPPO_FROM_ZIP,country:'US',phone:e.SHIPPO_FROM_PHONE||'',email:e.SHIPPO_FROM_EMAIL||''}}
function settings(r){const p=r?.parcel||{};return{servicelevel:r?.servicelevel||DEFAULTS.servicelevel,carrier_account:r?.carrier_account||'',parcel:{length:p.length||DEFAULTS.parcel.length,width:p.width||DEFAULTS.parcel.width,height:p.height||DEFAULTS.parcel.height,weight_lb:p.weight_lb||DEFAULTS.parcel.weight_lb},max_label_cents:r?.max_label_cents||DEFAULTS.max_label_cents,daily_limit:r?.daily_limit||DEFAULTS.daily_limit}}
function status(r){const ok=configured(),same=ok&&r?.fingerprint===fingerprint();return{configured:ok,token_saved:!!process.env.SHIPPO_API_TOKEN,from_saved:!!fromAddress(),test_mode:testToken(),connected:same,enabled:same&&r?.enabled===true&&!!r?.carrier_account&&(r.accounts||[]).some(a=>a.id===r.carrier_account),accounts:same?r.accounts||[]:[],checked_at:r?.checked_at||null,...settings(r)}}
async function request(route,body){
 if(!process.env.SHIPPO_API_TOKEN)fail('Save SHIPPO_API_TOKEN privately in Netlify first.');
 let r;try{r=await fetch(API+route,{method:body?'POST':'GET',headers:{Authorization:'ShippoToken '+process.env.SHIPPO_API_TOKEN,'Content-Type':'application/json','Shippo-API-Version':'2018-02-08'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)})}catch{fail('Shippo did not answer in time. Check status before retrying.',{uncertain:true})}
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
function record(o,t,rate){const amount=Math.round(Number(rate?.amount||0)*100);return tracker.fromShippo('ups',rate?.servicelevel?.token||rate?.servicelevel_token||'ups_second_day_air',t.tracking_number,{ship_date:new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),source:'shippo',shippo_transaction_id:t.object_id,label_url:t.label_url||'',label_cost_cents:amount||null})}
async function finish(id,t,rate){let job=null;await transaction(async s=>{const stored=await s.get('orders',id);if(!stored||stored.status!=='paid')return;stored.status='shipped';stored.tracking=String(t.tracking_number).trim();stored.shipment=record(stored,t,rate);stored.shippo_status='label_bought';stored.shippo_message='';stored.shippo_transaction_id=t.object_id;stored.shippo_label_url=t.label_url||'';await s.put('orders',id,stored);job=await emails.queueUpdate(s,stored)});if(job)await emails.safeDispatch(job);return{status:'label_bought',tracking:t.tracking_number,label_url:t.label_url}}
async function buy(id){
 const claim=await transaction(async s=>{
  const integration=await s.get('integrations','shippo'),st=status(integration);if(!st.enabled)return{status:'not_connected',message:'Connect and turn on Shippo in Shipping first.'};
  const o=await s.get('orders',id);if(!eligible(o))return{status:'blocked',message:'Only live, staff-verified paid orders without a label can get one.'};
  const own=require('./own-contact.cjs').match(o.customer);if(own){o.shippo_status='needs_review';o.shippo_message='Not bought: the ship-to '+own+' is Glow Lab’s own. Fix the customer’s '+own+' first.';await s.put('orders',id,o);return{status:'needs_review',message:o.shippo_message}}
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),count=await s.get('integrations','shippo-count-'+today)||{n:0};if(count.n>=st.daily_limit)return{status:'paused',message:'Daily label limit reached ('+st.daily_limit+'). Raise it in Shipping to buy more today.'};
  const key='shippo-'+id,q=await s.get('outbox',key)||{id:key,provider:'shippo',order_id:id,attempts:0};
  if(q.status==='synced')return{status:'synced'};if(q.lease_until>now())return{status:'sending'};
  if(q.purchase_started&&q.status!=='failed')return{status:'needs_review',message:'A label purchase may have reached Shippo. Nothing more is bought until it is checked.'};
  q.lease=crypto.randomBytes(16).toString('hex');q.lease_until=now()+120;q.status='sending';q.attempts++;q.account_fingerprint=fingerprint();await s.put('outbox',key,q);
  return{o,q,key,cfg:st,today};
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
   const rate=rates.find(r=>r.servicelevel?.token===cfg.servicelevel&&(!r.carrier_account||r.carrier_account===cfg.carrier_account));
   if(!rate){const why=(shipment.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300);fail('No '+cfg.servicelevel.replace(/_/g,' ')+' rate for this address.'+(why?' Shippo: '+why:''),{definite:true,review:true})}
   const cents=Math.round(Number(rate.amount)*100);if(!(cents>0)||cents>cfg.max_label_cents)fail('Label price $'+(cents/100).toFixed(2)+' is over the $'+(cfg.max_label_cents/100).toFixed(2)+' limit. Raise the limit in Shipping or buy this one by hand.',{definite:true,review:true});
   await save({purchase_started:true,rate_id:rate.object_id,rate_cents:cents});started=true;
   const t=await request('/transactions/',{rate:rate.object_id,label_file_type:'PDF_4x6',metadata:tag(id),async:false});
   if(t.status==='SUCCESS'&&t.tracking_number){outcome=await finish(id,t,rate);outcome.status='synced';await transaction(async s=>{const k='shippo-count-'+today,c=await s.get('integrations',k)||{id:k,n:0};c.n++;await s.put('integrations',k,c)})}
   else if(t.status==='ERROR'){await save({purchase_started:false});started=false;fail('Shippo could not buy the label: '+((t.messages||[]).map(m=>m.text).filter(Boolean).join(' ').slice(0,300)||'no reason given'),{definite:true,review:true})}
   else fail('Shippo has not finished the label yet ('+(t.status||'unknown')+'). It will be checked again.',{uncertain:true});
  }
 }catch(e){const review=!!e.review||(started&&!e.definite);outcome={status:review?'needs_review':'failed',message:e.message}}
 await transaction(async s=>{const c=await s.get('outbox',key);if(c?.lease!==q.lease)return;Object.assign(c,{status:outcome.status,message:outcome.message||'',lease_until:0,checked_at:now(),next_attempt:now()+Math.min(3600,60*2**Math.min(c.attempts,6))});await s.put('outbox',key,c);const stored=await s.get('orders',id);if(stored&&stored.status==='paid'){stored.shippo_status=outcome.status;stored.shippo_message=outcome.message||'';if(outcome.status==='needs_review')stored.shippo_needs_review=true;await s.put('orders',id,stored)}});
 return outcome;
}
// Staff checked the order (address fixed, or the label confirmed in Shippo): look for a label once more, then allow a new purchase.
async function retry(id){await transaction(async s=>{const o=await s.get('orders',id);if(!o)fail('Order not found.');o.shippo_needs_review=false;o.shippo_message='';o.shippo_status='queued';await s.put('orders',id,o);const q=await s.get('outbox','shippo-'+id);if(q){q.purchase_started=false;q.status='failed';q.next_attempt=0;q.lease_until=0;await s.put('outbox',q.id,q)}});return buy(id)}
async function enabled(){return transaction(async s=>status(await s.get('integrations','shippo')).enabled)}
async function pending(limit=3){
 const batch=await transaction(async s=>{if(!status(await s.get('integrations','shippo')).enabled)return[];const outbox=await s.list('outbox');return(await s.list('orders')).filter(eligible).filter(o=>{const q=outbox.find(x=>x.id==='shippo-'+o.id);return !(q?.purchase_started&&q.status!=='failed')&&(q?.next_attempt||0)<=now()}).sort((a,b)=>(a.paid||0)-(b.paid||0)).slice(0,limit).map(o=>o.id)});
 const results=[];for(const id of batch)results.push(await buy(id));return{processed:batch.length,results};
}
module.exports={configured,status,check,buy,retry,pending,enabled,eligible,shipmentBody,fromAddress,settings,DEFAULTS,tag};

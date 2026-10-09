'use strict';
// Customer shipping updates. ShipStation tells us the moment a label is created (carrier, service,
// tracking number). UPS's own Track API tells us the delivery date, "out for delivery" and "delivered".
// Every customer email has a fixed id per order and event, so it can never be sent twice.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs'),emails=require('./store-email.cjs');
const now=()=>Math.floor(Date.now()/1000),fail=m=>{throw new Error(m)},todayET=()=>new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});

const CARRIERS={
 ups:{name:'UPS',url:t=>'https://www.ups.com/track?loc=en_US&tracknum='+encodeURIComponent(t)},
 fedex:{name:'FedEx',url:t=>'https://www.fedex.com/fedextrack/?trknbr='+encodeURIComponent(t)},
 usps:{name:'USPS',url:t=>'https://tools.usps.com/go/TrackConfirmAction?tLabels='+encodeURIComponent(t)},
 dhl:{name:'DHL',url:t=>'https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id='+encodeURIComponent(t)}
};
const SERVICES={ups_ground:'UPS Ground',ups_2nd_day_air:'UPS 2nd Day Air',ups_2nd_day_air_am:'UPS 2nd Day Air A.M.',ups_3_day_select:'UPS 3 Day Select',ups_next_day_air:'UPS Next Day Air',ups_next_day_air_saver:'UPS Next Day Air Saver',ups_next_day_air_early_am:'UPS Next Day Air Early',ups_ground_saver:'UPS Ground Saver',fedex_ground:'FedEx Ground',fedex_home_delivery:'FedEx Home Delivery',fedex_2day:'FedEx 2Day',fedex_2day_one_rate:'FedEx 2Day One Rate',fedex_express_saver:'FedEx Express Saver',fedex_express_saver_one_rate:'FedEx Express Saver One Rate',usps_priority_mail:'USPS Priority Mail',usps_ground_advantage:'USPS Ground Advantage',usps_priority_mail_express:'USPS Priority Mail Express'};

function cleanTracking(v){return String(v||'').replace(/\s+/g,'').toUpperCase().slice(0,60)}
function carrierOf(code,tracking){
 const c=String(code||'').toLowerCase();
 if(c.startsWith('ups'))return 'ups';if(c.startsWith('fedex'))return 'fedex';if(c.startsWith('dhl'))return 'dhl';
 if(c.includes('usps')||c.startsWith('stamps_com')||c.startsWith('endicia'))return 'usps';
 const t=cleanTracking(tracking);if(/^1Z[0-9A-Z]{16}$/.test(t))return 'ups';
 return '';
}
function serviceName(code,carrier){
 const c=String(code||'').toLowerCase().replace(/[^a-z0-9_]/g,'');if(SERVICES[c])return SERVICES[c];
 if(!c)return CARRIERS[carrier]?.name||'';
 return c.split('_').map(w=>({ups:'UPS',usps:'USPS',fedex:'FedEx',dhl:'DHL',am:'A.M.'}[w]||w.charAt(0).toUpperCase()+w.slice(1))).join(' ').slice(0,80);
}
const isoDate=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:null};
function shipment(carrierCode,serviceCode,tracking,extra={}){
 const t=cleanTracking(tracking),carrier=carrierOf(carrierCode,t);
 return{carrier,carrier_name:CARRIERS[carrier]?.name||'',service:serviceName(serviceCode,carrier),tracking:t,tracking_url:carrier&&t?CARRIERS[carrier].url(t):'',label_created_at:now(),...extra};
}
// From a ShipStation V1 shipment record.
const fromShipStation=x=>shipment(x.carrierCode,x.serviceCode,x.trackingNumber,{ship_date:isoDate(x.shipDate),shipstation_shipment_id:x.shipmentId??null,source:'shipstation'});
// From a tracking number typed into Management.
const fromManual=t=>cleanTracking(t)?shipment('','',t,{ship_date:todayET(),source:'manual'}):null;

// ---------- UPS Track API (developer.ups.com: OAuth client credentials + /api/track/v1/details) ----------
const upsConfigured=()=>!!process.env.UPS_CLIENT_ID&&!!process.env.UPS_CLIENT_SECRET;
const UPS_BASE=()=>process.env.UPS_API_BASE==='cie'?'https://wwwcie.ups.com':'https://onlinetools.ups.com';
let upsToken=null;
async function upsAuth(){
 if(upsToken&&upsToken.until>now()+120&&upsToken.key===process.env.UPS_CLIENT_ID)return upsToken.token;
 let r;try{r=await fetch(UPS_BASE()+'/security/v1/oauth/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(process.env.UPS_CLIENT_ID+':'+process.env.UPS_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded',...(/^[0-9A-Z]{6}$/i.test(process.env.UPS_ACCOUNT_NUMBER||'')?{'x-merchant-id':process.env.UPS_ACCOUNT_NUMBER}:{})},body:'grant_type=client_credentials',redirect:'error',signal:AbortSignal.timeout(8000)})}catch{fail('UPS did not answer the sign-in request.')}
 if(!r.ok)fail('UPS refused the sign-in (HTTP '+r.status+'). Check UPS_CLIENT_ID and UPS_CLIENT_SECRET in Netlify.');
 const x=await r.json().catch(()=>null);if(typeof x?.access_token!=='string')fail('UPS sign-in returned no token.');
 upsToken={token:x.access_token,until:now()+Math.max(300,Math.min(Number(x.expires_in)||0,14000)),key:process.env.UPS_CLIENT_ID};return upsToken.token;
}
const ymd=v=>{const m=String(v||'').match(/^(\d{4})(\d{2})(\d{2})$/);return m?`${m[1]}-${m[2]}-${m[3]}`:null};
const hm=v=>{const m=String(v||'').match(/^(\d{2})(\d{2})(\d{2})?$/);if(!m)return null;let h=Number(m[1]);const ap=h>=12?'PM':'AM';h=h%12||12;return `${h}:${m[2]} ${ap}`};
// Reads one UPS package record into the few facts a customer needs.
function readUps(pkg){
 const st=pkg?.currentStatus||{},type=String(st.type||'').toUpperCase(),text=String(st.description||st.simplifiedTextDescription||'').trim().slice(0,160);
 const dates=Array.isArray(pkg?.deliveryDate)?pkg.deliveryDate:[],pick=t=>ymd(dates.find(d=>d?.type===t)?.date);
 const dt=pkg?.deliveryTime||{},dtype=String(dt.type||'').toUpperCase();
 const deliveredDate=pick('DEL')||(type==='D'?ymd(pkg?.activity?.[0]?.date):null);
 let window='';
 if(['EDW','CDW','IDW'].includes(dtype)&&hm(dt.startTime)&&hm(dt.endTime))window=`between ${hm(dt.startTime)} and ${hm(dt.endTime)}`;
 else if(dtype==='CMT'&&hm(dt.endTime))window=`by ${hm(dt.endTime)}`;
 else if(dtype==='EOD')window='by end of day';
 const state=deliveredDate||type==='D'?'delivered':(type==='O'||/out for delivery/i.test(text))?'out_for_delivery':type==='X'?'exception':(type==='M'||type==='MV')?'label_created':type?'in_transit':'unknown';
 const loc=pkg?.activity?.[0]?.location?.address,where=loc&&loc.city?[loc.city,loc.stateProvince].filter(Boolean).join(', ').slice(0,80):'';
 return{state,ups_type:type,status_text:text,scheduled_date:pick('RDD')||pick('SDD')||null,rescheduled:!!pick('RDD'),window,delivered_date:deliveredDate,delivered_time:dtype==='DEL'?hm(dt.endTime):(type==='D'?hm(pkg?.activity?.[0]?.time):null),delivered_location:String(pkg?.deliveryInformation?.location||'').slice(0,80),last_location:where,checked_at:now()};
}
async function upsTrack(number){
 const token=await upsAuth();let r;
 try{r=await fetch(UPS_BASE()+'/api/track/v1/details/'+encodeURIComponent(number)+'?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false',{headers:{Authorization:'Bearer '+token,transId:crypto.randomBytes(16).toString('hex'),transactionSrc:'glowstore'},redirect:'error',signal:AbortSignal.timeout(8000)})}catch{fail('UPS tracking did not answer.')}
 if(r.status===404)return{state:'not_found',status_text:'UPS has no record yet.',checked_at:now()};
 if(r.status===401)upsToken=null;
 if(!r.ok)fail('UPS tracking returned HTTP '+r.status+'.');
 const x=await r.json().catch(()=>null),pkg=x?.trackResponse?.shipment?.[0]?.package?.[0];
 if(!pkg)return{state:'not_found',status_text:'UPS has no record yet.',checked_at:now()};
 if(pkg.trackingNumber&&cleanTracking(pkg.trackingNumber)!==cleanTracking(number))fail('UPS answered for a different tracking number.');
 return readUps(pkg);
}

// ---------- customer emails ----------
const longDate=d=>{const m=String(d||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toLocaleDateString('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric'}):''};
const first=o=>String(o.customer?.name||'').trim().split(/\s+/)[0]||'there';
const itemLines=o=>(o.items||[]).map(i=>`${i.name} × ${i.quantity}`);
const shipTo=o=>{const c=o.customer||{};return `Shipping to: ${c.name}, ${c.address}, ${c.city}, ${c.state} ${c.zip}`};
const viewLink=o=>emails.viewLink(o);
function trackingLines(sh){return[sh.service?'Carrier: '+sh.service:sh.carrier_name?'Carrier: '+sh.carrier_name:null,'Tracking number: '+sh.tracking].filter(Boolean)}
function send(s,o,id,kind,subject,title,lines){
 if(o.is_test!==false)return null;const sh=o.shipment||{};
 return emails.enqueue(s,{id,kind,brand:o.brand,to:o.customer.email,related_id:o.id,subject,content:emails.template(title,lines,sh.tracking_url||null,'Track your package',viewLink(o),'View your order')});
}
function queueEta(s,o,d){
 const date=longDate(d.scheduled_date),changed=!!o.delivery?.emailed_date&&o.delivery.emailed_date!==d.scheduled_date;
 return send(s,o,'order-eta-'+o.id+'-'+d.scheduled_date,'order_delivery_date',(changed?'New delivery date: ':'Arriving ')+date+' · Glow Lab '+o.id,
  changed?`UPS has a new delivery date: ${date}.`:`UPS says your package will arrive ${date}.`,
  ['Hi '+first(o)+',',changed?`UPS changed the delivery date for order ${o.id}. It was ${longDate(o.delivery.emailed_date)}.`:`Good news: UPS gave your package for order ${o.id} a delivery date.`,'Delivery date: '+date+(d.window?' ('+d.window+')':''),...trackingLines(o.shipment),shipTo(o),'UPS can change this date. If it does, we will email you the new one.']);
}
const queueOut=(s,o,d)=>send(s,o,'order-out-'+o.id,'order_out_for_delivery','Out for delivery today · Glow Lab '+o.id,'Your package is out for delivery today.',['Hi '+first(o)+',',`UPS has your package for order ${o.id} on the truck for delivery today${d.window?', '+d.window:''}.`,...trackingLines(o.shipment),shipTo(o)]);
const queueDelivered=(s,o,d)=>send(s,o,'order-delivered-'+o.id,'order_delivered','Delivered · Glow Lab '+o.id,'Your package was delivered.',['Hi '+first(o)+',',`UPS delivered your package for order ${o.id}${d.delivered_date?' on '+longDate(d.delivered_date):''}${d.delivered_time?' at '+d.delivered_time:''}.`,...(d.delivered_location?['Left at: '+d.delivered_location]:[]),...trackingLines(o.shipment),'Can’t find it? Reply to this email and we will help right away.']);

// Decide what is new since the last check and queue at most the emails that are now true.
async function applyUps(s,o,d){
 const prev=o.delivery||{},jobs=[];
 o.delivery={...prev,...d,emailed_date:prev.emailed_date||null,first_scan_at:prev.first_scan_at||(['in_transit','out_for_delivery','delivered','exception'].includes(d.state)?now():null)};
 if(d.state==='delivered'){o.delivery.delivered=true;jobs.push(await queueDelivered(s,o,d))}
 else{
  if(d.scheduled_date&&d.scheduled_date!==prev.emailed_date&&(prev.date_emails||0)<4){jobs.push(await queueEta(s,o,d));o.delivery.emailed_date=d.scheduled_date;o.delivery.date_emails=(prev.date_emails||0)+1}
  if(d.state==='out_for_delivery')jobs.push(await queueOut(s,o,d));
 }
 return jobs.filter(Boolean);
}
// How soon to look again: often while a date is missing or on delivery day, otherwise hourly.
function nextCheck(o,d){
 if(d.state==='delivered')return null;
 const today=todayET();
 if(d.state==='out_for_delivery'||d.scheduled_date===today)return now()+15*60;
 if(!d.scheduled_date)return now()+20*60;
 return now()+60*60;
}
const trackable=o=>o?.is_test===false&&o.status==='shipped'&&o.shipment?.carrier==='ups'&&!!o.shipment.tracking&&!o.delivery?.delivered&&(o.shipment.label_created_at||0)>now()-30*86400;
async function refreshOne(id){
 const o=await transaction(s=>s.get('orders',id));if(!trackable(o))return{status:'skipped'};
 let d;try{d=await upsTrack(o.shipment.tracking)}catch(e){await transaction(async s=>{const c=await s.get('orders',id);if(c){c.delivery={...(c.delivery||{}),error:e.message,next_check:now()+30*60,checked_at:now()};await s.put('orders',id,c)}});return{status:'error',message:e.message}}
 let jobs=[];
 await transaction(async s=>{const c=await s.get('orders',id);if(!trackable(c)||c.shipment.tracking!==o.shipment.tracking)return;jobs=await applyUps(s,c,d);c.delivery.error='';c.delivery.next_check=nextCheck(c,d);await s.put('orders',id,c)});
 for(const j of jobs)await emails.safeDispatch(j);
 return{status:d.state};
}
async function refreshDue(limit=8){
 if(!upsConfigured())return{status:'not_configured',processed:0};
 const due=await transaction(async s=>(await s.list('orders')).filter(trackable).filter(o=>(o.delivery?.next_check||0)<=now()).sort((a,b)=>(a.delivery?.next_check||0)-(b.delivery?.next_check||0)).slice(0,limit).map(o=>o.id));
 const results=await Promise.all(due.map(refreshOne));
 return{processed:due.length,results};
}
// "Label made but UPS never scanned it" is how parcels got left behind in September. Staff see it.
const noScan=o=>o?.status==='shipped'&&o.shipment?.carrier==='ups'&&!o.delivery?.first_scan_at&&(o.shipment.label_created_at||0)<now()-26*3600;
module.exports={CARRIERS,carrierOf,serviceName,cleanTracking,fromShipStation,fromManual,upsConfigured,upsTrack,readUps,applyUps,refreshOne,refreshDue,trackable,noScan,viewLink,longDate,_reset:()=>{upsToken=null}};

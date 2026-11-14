'use strict';
// "Your package may be a little late" (Jonah, 13 Nov 2026: "the faa has halted all flights and we need to alert them that
// their order might be delayed"). Verified first: the FAA ordered a nationwide ground stop on Friday afternoon, 13 Nov
// 2026 (air traffic control communications problem), lifted after about four hours; cargo flights were delayed too.
// One email per order whose shipping label was made on the chosen day (America/New_York). Never twice per order.
// Owner only. preview lists the orders (no customer details), test sends one copy to a test address, send needs the
// typed confirmation, status counts the outbox.
const tracking=require('./order-tracking.cjs');
const DAY=d=>new Date(d*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const first=o=>{const w=String(o.customer?.name||'').trim().split(/\s+/)[0]||'';return /^[A-Za-zÀ-ÿ'’-]{2,20}$/.test(w)?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():'there'};
function orders(all,day){return all.filter(o=>o.is_test===false&&o.status==='shipped'&&o.customer?.email&&o.shipment?.label_created_at&&o.shipment.carrier!=='in_person'&&DAY(o.shipment.label_created_at)===day).sort((a,b)=>a.shipment.label_created_at-b.shipment.label_created_at)}
function content(o){
 const sh=o.shipment||{};
 const subject='Heads-up: your order may be a little late · Glow Lab '+o.id;
 const title='Your package may be a little late.';
 const lines=['Hi '+first(o)+',',
  `Your order ${o.id} is on its way. We wanted to let you know right away about something outside our control.`,
  'On Friday afternoon the FAA stopped all flights across the U.S. for several hours because of an air traffic control communications problem. Flights are moving again, but airlines and carriers are still catching up, so your package may arrive a day or two later than expected.',
  'Nothing is wrong with your order, and there is nothing you need to do.',
  ...[sh.service?'Carrier: '+sh.service:sh.carrier_name?'Carrier: '+sh.carrier_name:null,sh.tracking?'Tracking number: '+sh.tracking:null].filter(Boolean)];
 return{subject,title,lines};
}
module.exports={DAY,orders,content,first};

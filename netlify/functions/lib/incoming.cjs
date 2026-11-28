'use strict';
// Incoming stock (Jonah, 27 Nov 2026: "where we are more confident on our inventory ... see what is coming in today and
// what is ordered ... then it relays it to packing.html so we can see what's coming in but also what can be packed and
// what can't"). A scheduled task reads the supplier's ERP every 2 hours (8 AM – 6 PM ET) and saves what it found here.
// Packing Check reads it back and works out, order by order, what can be packed now, what can be packed when today's
// delivery lands, what is waiting on a later delivery, and what is not on order at all.
//
//   GET  /admin/incoming  → the last saved list
//   POST /admin/incoming  {source, checked_at, shipments:[{ref, status, eta, carrier, tracking, note,
//                          lines:[{name, qty, product_id?}]}]}  → replaces it (staff or owner)
// qty is in single vials (a box of 10 = 10). product_id is the store product the line was matched to; a line the task
// could not match is kept with product_id null and shown as "not matched" so nothing is silently dropped.
const STATUSES=['ordered','processing','shipped','out_for_delivery','delivered','received'];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const str=(v,max)=>String(v==null?'':v).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const day=v=>{const s=str(v,10);return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))?s:''};
function clean(b,products,now){
 if(!b||!Array.isArray(b.shipments))fail('Send a shipments list.');if(b.shipments.length>60)fail('Too many shipments (60 at most).');
 const ids=new Set(products.map(p=>p.id));
 const shipments=b.shipments.map((x,i)=>{if(!x||typeof x!=='object')fail('Shipment '+(i+1)+' is not valid.');
  const status=STATUSES.includes(x.status)?x.status:fail('Shipment '+(i+1)+': status must be one of '+STATUSES.join(', ')+'.');
  const lines=(Array.isArray(x.lines)?x.lines:[]).slice(0,150).map((l,j)=>{const qty=Math.round(Number(l&&l.qty));if(!Number.isFinite(qty)||qty<1||qty>100000)fail('Shipment '+(i+1)+' line '+(j+1)+': qty must be a whole number of vials.');
   const pid=l.product_id==null||l.product_id===''?null:Number(l.product_id);return{name:str(l.name,120)||'Unnamed item',qty,product_id:pid!=null&&ids.has(pid)?pid:null}});
  if(!lines.length)fail('Shipment '+(i+1)+' has no items.');
  return{ref:str(x.ref,60),status,eta:day(x.eta),carrier:str(x.carrier,30),tracking:str(x.tracking,60),note:str(x.note,200),ordered_on:day(x.ordered_on),lines}});
 return{source:str(b.source,80)||'Supplier ERP',checked_at:Number.isFinite(Number(b.checked_at))?Math.floor(Number(b.checked_at)):now,saved_at:now,shipments}}
async function route(s,path,body,method,actor,now=Math.floor(Date.now()/1000)){
 if(path!=='/admin/incoming')return null;
 if(method==='GET')return (await s.get('integrations','incoming'))||{source:'',checked_at:0,saved_at:0,shipments:[]};
 if(method==='POST'){const rec=clean(body,await s.list('products'),now);{/* a delivery already added to stock (Received) stays received */const got=((await s.get('integrations','incoming_received'))||{}).refs||{};for(const x of rec.shipments)if(x.ref&&got[x.ref])x.status='received'}rec.saved_by=actor;await s.put('integrations','incoming',rec);return{ok:true,shipments:rec.shipments.length,lines:rec.shipments.reduce((n,x)=>n+x.lines.length,0),unmatched:rec.shipments.reduce((n,x)=>n+x.lines.filter(l=>l.product_id===null).length,0)}}
 fail('Endpoint not found.',404)}
module.exports={route,clean,STATUSES};

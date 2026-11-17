'use strict';
// Waiting on (Jonah, 17 Nov 2026: "a thing where we basically put in what we are waiting on so that we can hold your order").
// Staff add a product the store is waiting on (stuck in customs, late from the supplier). Every open order with it gets a
// hold on those lines. Jonah's choices:
//   - customers see nothing different in the store;
//   - the rest of the order ships now: packing leaves the held lines out, and only an order where EVERYTHING is
//     waiting is skipped by Automatic labels;
//   - one email when the order goes on hold and one when it arrives (Autopilot "Waiting-on emails", OFF until switched on).
// "It's here" releases the holds. An order not packed yet just packs everything in its own box. An order whose box
// already went gets a ready-made Packing page shipment for the held items (stock is not taken twice: the order took it).
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const clean=(v,max)=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const familyName=n=>String(n||'').split(' · ')[0].trim();
function firstName(o){let n=String(o?.customer?.name||'').trim().split(/\s+/)[0]||'';if(!/\s/.test(String(o?.customer?.name||'').trim())&&n.includes('-'))n=n.split('-')[0];
 if(!n)return 'there';return n===n.toUpperCase()||n===n.toLowerCase()?n.charAt(0).toUpperCase()+n.slice(1).toLowerCase():n}
function blank(){return{lines:[],released:[],notices:{},arrivals:{},excluded:[]}}
function shape(h){const b=blank();if(!h)return b;return{...b,...h,lines:h.lines||[],released:h.released||[],notices:h.notices||{},arrivals:h.arrivals||{},excluded:h.excluded||[]}}
// The box has left (or is ready to): packed, or the carrier has it.
function boxGone(o){const t=o.track||{},d=o.delivery||{};return !!o.packed||!!(t.first_scan_at||d.first_scan_at)||['in_transit','out_for_delivery','delivered'].includes(t.state)||['in_transit','out_for_delivery','delivered'].includes(d.state)}
// An order that can still get a NEW hold: live, paid, not packed, not with the carrier. "Shipped" here only means a label
// was bought, so a shipped order counts while its label is under 7 days old (the Packing page uses the same rule).
function holdable(o,t=now()){if(!o||o.is_test!==false)return false;if(boxGone(o))return false;if(o.status==='paid')return true;
 return o.status==='shipped'&&(Number(o.shipment?.label_created_at)||Number(o.paid)||0)>t-7*86400}
// Lines still waiting, and whether that is the whole order (then Automatic labels skips it).
function heldLines(o){return shape(o?.hold).lines}
function fullyHeld(o){const lines=heldLines(o);if(!lines.length)return false;return (o.items||[]).every(i=>{const q=lines.filter(l=>l.id===Number(i.id)).reduce((n,l)=>n+l.quantity,0);return q>=(Number(i.quantity)||1)})}

async function active(s){return (await s.list('waiting_on')).filter(w=>w.status==='waiting')}
// Puts holds on open orders that have a waiting product. Safe to run any time (Autopilot runs it every minute).
async function sweepIn(s,t=now()){const list=await active(s);if(!list.length)return 0;const ids=new Set(list.map(w=>w.product_id));
 const orders=s.listLite?await s.listLite('orders'):await s.list('orders');let n=0;
 for(const lite of orders){if(!(lite.items||[]).some(i=>ids.has(Number(i.id))))continue;if(!holdable(lite,t)&&!heldLines(lite).length)continue;
  const o=await s.get('orders',lite.id);if(!o||!holdable(o,t))continue;const h=shape(o.hold);let changed=false;
  for(const w of list)for(const i of o.items||[]){if(Number(i.id)!==w.product_id||h.excluded.includes(w.id))continue;
   if(h.lines.some(l=>l.waiting_id===w.id&&l.id===w.product_id)||h.released.some(l=>l.waiting_id===w.id&&l.id===w.product_id))continue;
   h.lines.push({id:w.product_id,name:String(i.name||w.name),quantity:Math.max(1,Number(i.quantity)||1),waiting_id:w.id,since:t});if(!h.notices[w.id])h.notices[w.id]={status:'pending'};changed=true}
  if(changed){o.hold=h;await s.put('orders',o.id,o);n++}}
 return n}
async function sweep(){return transaction(s=>sweepIn(s))}

function log(s,action,id){return s.get('audit','log').then(l=>{l=l||[];l.push({created:now(),action,order_id:id});return s.put('audit','log',l.slice(-5000))})}
async function staffName(s,sid){const rec=sid?await s.get('sessions',sid):null,st=rec?.staff_id?await s.get('staff',rec.staff_id):null;return String(st?.name||st?.email||'Owner').trim().split(/[\s@]+/)[0].slice(0,30)}

async function add(s,{product_id,reason,expected},by){const p=await s.get('products',Number(product_id));if(!p)bad('Choose the product you are waiting on.');
 if((await active(s)).some(w=>w.product_id===p.id))bad(p.name+' is already on the waiting list.',409);
 const r=clean(reason,80).replace(/[.!]+$/,''),day=clean(expected,10);if(day&&!/^\d{4}-\d{2}-\d{2}$/.test(day))bad('Choose a date, or leave it blank.');
 const id='W'+now().toString(36).toUpperCase()+crypto.randomBytes(2).toString('hex').toUpperCase();
 const w={id,product_id:p.id,name:p.name,reason:r,expected:day,status:'waiting',created:now(),created_by:by};await s.put('waiting_on',id,w);await log(s,'waiting_on_added',p.name);
 const held=await sweepIn(s);return{ok:true,id,held}}
// It's here: release every hold for this item.
async function arrived(s,id,by){const w=await s.get('waiting_on',id);if(!w)bad('Not found.',404);if(w.status!=='waiting')bad('This one is already '+(w.status==='arrived'?'marked as here':'removed')+'.',409);
 const orders=s.listLite?await s.listLite('orders'):await s.list('orders');let released=0,shipments=0;
 for(const lite of orders){if(!heldLines(lite).some(l=>l.waiting_id===id))continue;const o=await s.get('orders',lite.id);const h=shape(o.hold),lines=h.lines.filter(l=>l.waiting_id===id);if(!lines.length)continue;
  h.lines=h.lines.filter(l=>l.waiting_id!==id);const live=['paid','shipped'].includes(o.status),gone=boxGone(o);let sid=null;
  if(live&&gone){sid='SHIP-'+crypto.createHash('sha256').update('hold:'+o.id+':'+id).digest('hex').slice(0,10).toUpperCase();
   if(!await s.get('manual_shipments',sid)){const c=o.customer||{},items=[];
    for(const l of lines){const p=await s.get('products',l.id),same=items.find(x=>x.id===l.id);if(same){same.quantity+=l.quantity;continue}
     items.push({id:l.id,name:p?.name||l.name,quantity:l.quantity,units:Number.isInteger(p?.units)?p.units:1,...(p&&Array.isArray(p.components)&&p.components.length?{draws:p.components.map(x=>({id:x.id,qty:x.qty}))}:{})})}
    await s.put('manual_shipments',sid,{id:sid,brand:o.brand||'glow',status:'open',reason:'waiting',note:'Was waiting on '+familyName(w.name)+(w.reason?' ('+w.reason+')':''),order_id:o.id,
     to:{name:clean(c.name,100),address:clean(c.address,100),address2:clean(c.address2,100),city:clean(c.city,60),state:clean(c.state,2).toUpperCase(),zip:clean(c.zip,10),phone:clean(c.phone,32),email:clean(c.email,150).toLowerCase()},
     items,stock_taken:false,created:now(),created_by:by});shipments++}}
  h.released.push(...lines.map(l=>({...l,released_at:now(),how:sid?'shipment':'with_box',...(sid?{shipment_id:sid}:{})})));
  if(live)h.arrivals[id]={status:'pending'};if(h.notices[id]?.status==='pending')h.notices[id]={status:'skipped',why:'arrived first'};
  o.hold=h;await s.put('orders',o.id,o);released++}
 w.status='arrived';w.arrived_at=now();w.arrived_by=by;await s.put('waiting_on',id,w);await log(s,'waiting_on_arrived',w.name);return{ok:true,released,shipments}}
// Remove from the list without "it's here" (added by mistake): holds come off, no emails.
async function cancel(s,id,by){const w=await s.get('waiting_on',id);if(!w)bad('Not found.',404);if(w.status!=='waiting')bad('This one is already closed.',409);
 const orders=s.listLite?await s.listLite('orders'):await s.list('orders');
 for(const lite of orders){if(!heldLines(lite).some(l=>l.waiting_id===id)&&!shape(lite.hold).notices[id])continue;const o=await s.get('orders',lite.id),h=shape(o.hold);h.lines=h.lines.filter(l=>l.waiting_id!==id);if(h.notices[id]?.status==='pending')h.notices[id]={status:'skipped',why:'removed from the list'};o.hold=h;await s.put('orders',o.id,o)}
 w.status='removed';w.removed_at=now();w.removed_by=by;await s.put('waiting_on',id,w);await log(s,'waiting_on_removed',w.name);return{ok:true}}
// Per order: leave this order out (it is not waiting), put it back, or say how the customer was told.
async function orderAction(s,{order_id,waiting_id,action}){const o=await s.get('orders',String(order_id||''));if(!o)bad('Order not found.',404);const w=await s.get('waiting_on',String(waiting_id||''));if(!w)bad('Not found.',404);const h=shape(o.hold);
 if(action==='exclude'){if(!h.excluded.includes(w.id))h.excluded.push(w.id);h.lines=h.lines.filter(l=>l.waiting_id!==w.id);if(h.notices[w.id]?.status==='pending')h.notices[w.id]={status:'skipped',why:'not this order'}}
 else if(action==='include'){h.excluded=h.excluded.filter(x=>x!==w.id);if(h.notices[w.id]?.why==='not this order')delete h.notices[w.id];o.hold=h;await s.put('orders',o.id,o);if(w.status==='waiting')await sweepIn(s);return{ok:true}}
 else if(action==='told_by_hand'||action==='no_email'){if(h.notices[w.id]?.status==='sent')bad('The hold email already went to this customer.',409);h.notices[w.id]={status:action==='told_by_hand'?'by_hand':'skipped',why:action==='told_by_hand'?'told by hand':'no email',at:now()}}
 else if(action==='email'){if(h.notices[w.id]?.status==='sent')bad('The hold email already went to this customer.',409);h.notices[w.id]={status:'pending'}}
 else bad('Unknown action.');
 o.hold=h;await s.put('orders',o.id,o);return{ok:true}}

// ---- the two emails ----
function holdEmail(o,w){const name=familyName(w.name),first=firstName(o),lines=heldLines(o).filter(l=>l.waiting_id===w.id),rest=!fullyHeld(o)&&(o.items||[]).length>lines.length;
 const day=w.expected?new Date(w.expected+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'long',day:'numeric'}):'';
 return{subject:'An update on your Glow Lab order · '+o.id,title:'A quick update on your order.',lines:['Hi '+first+',',
  'A quick update on your order '+o.id+'. We’re waiting on our '+name+' shipment'+(w.reason?', which is '+w.reason+' right now':'')+'. As soon as it reaches us, we’ll get it out to you.'+(day?' We expect it around '+day+'.':''),
  ...(rest?['The rest of your order is shipping as normal.']:[]),'Thank you so much for your patience, and just reply here if you have any questions.']}}
function hereEmail(o,w,how){const name=familyName(w.name),first=firstName(o);
 return{subject:'Good news: your '+name+' is here · '+o.id,title:'It’s here.',lines:['Hi '+first+',','Good news! The '+name+' for your order '+o.id+' has arrived.',
  how==='shipment'?'We’re packing it now, and it will ship to you on its own. You’ll get the tracking number as soon as it’s on the way.':'We’re packing your order now, and you’ll get the tracking number as soon as it ships.','Thank you so much for waiting with us.']}}
function preview(){const o={id:'GLP-EXAMPLE',customer:{name:'Jane Example'},items:[{id:1,quantity:1},{id:2,quantity:1}],hold:{lines:[{id:1,quantity:1,waiting_id:'W'}]}},w={id:'W',name:'Glow Fuel',reason:'held up in customs',expected:''};
 const a=holdEmail(o,w),b=hereEmail(o,w,'with_box');return{hold:{subject:a.subject,text:a.lines.join('\n\n')},here:{subject:b.subject,text:b.lines.join('\n\n')}}}
// Autopilot "Waiting-on emails": one hold email per order and item, one it's-here email after "It's here". 9 AM–8 PM Eastern.
async function emailsRun(limit=25,t=Date.now()){const h=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)));if(h<9||h>=20)return{status:'quiet_hours',sent:0};
 const emails=require('./store-email.cjs');if(!emails.configuration().ready)return{status:'email_not_configured',sent:0};
 const jobs=await transaction(async s=>{const all=new Map((await s.list('waiting_on')).map(w=>[w.id,w])),out=[];const orders=s.listLite?await s.listLite('orders'):await s.list('orders');
  for(const lite of orders){if(out.length>=limit)break;const hh=shape(lite.hold);if(!Object.values(hh.notices).some(x=>x.status==='pending')&&!Object.values(hh.arrivals).some(x=>x.status==='pending'))continue;
   const o=await s.get('orders',lite.id),hold=shape(o.hold),to=String(o.customer?.email||'').trim();let changed=false;
   for(const [wid,n] of Object.entries(hold.notices)){if(n.status!=='pending')continue;const w=all.get(wid),still=hold.lines.some(l=>l.waiting_id===wid);
    if(!w||w.status!=='waiting'||!still||!to||!['paid','shipped'].includes(o.status)){hold.notices[wid]={status:'skipped',why:!to?'no email':'not waiting any more'};changed=true;continue}
    const c=holdEmail(o,w),job=await emails.enqueue(s,{id:'hold-'+o.id+'-'+wid,kind:'hold_notice',brand:o.brand||'glow',to,related_id:o.id,subject:c.subject,content:emails.template(c.title,c.lines,null,null,null,null,{eyebrow:'Order '+o.id})});
    hold.notices[wid]={status:'sent',at:now(),job:job||null};changed=true;if(job)out.push(job)}
   for(const [wid,n] of Object.entries(hold.arrivals)){if(n.status!=='pending')continue;const w=all.get(wid),rel=hold.released.find(l=>l.waiting_id===wid);
    if(!w||!rel||!to||!['paid','shipped'].includes(o.status)){hold.arrivals[wid]={status:'skipped',why:!to?'no email':'order closed'};changed=true;continue}
    const c=hereEmail(o,w,rel.how),job=await emails.enqueue(s,{id:'hold-here-'+o.id+'-'+wid,kind:'hold_arrived',brand:o.brand||'glow',to,related_id:o.id,subject:c.subject,content:emails.template(c.title,c.lines,null,null,null,null,{eyebrow:'Order '+o.id})});
    hold.arrivals[wid]={status:'sent',at:now(),job:job||null};changed=true;if(job)out.push(job)}
   if(changed){o.hold=hold;await s.put('orders',o.id,o)}}
  return out});
 for(const j of jobs)await emails.safeDispatch(j);return{status:'ok',sent:jobs.length}}

// Management → Ship & stock → Waiting on.
async function overview(s){const list=(await s.list('waiting_on')).sort((a,b)=>b.created-a.created),cut=now()-30*86400,shown=list.filter(w=>w.status==='waiting'||(w.arrived_at||w.removed_at||0)>cut);
 const orders=s.listLite?await s.listLite('orders'):await s.list('orders');
 const rows=shown.map(w=>{const os=[];for(const o of orders){const h=shape(o.hold),held=h.lines.filter(l=>l.waiting_id===w.id),rel=h.released.filter(l=>l.waiting_id===w.id),out=h.excluded.includes(w.id);
   const has=(o.items||[]).some(i=>Number(i.id)===w.product_id);if(!held.length&&!rel.length&&!(out&&has))continue;
   os.push({id:o.id,status:o.status,first:firstName(o),name:String(o.customer?.name||''),quantity:(held.length?held:rel).reduce((n,l)=>n+l.quantity,0)||((o.items||[]).find(i=>Number(i.id)===w.product_id)?.quantity||0),
    whole:fullyHeld(o)&&held.length>0,packed:!!o.packed,excluded:out,released:rel.length?{how:rel[0].how,shipment_id:rel[0].shipment_id||null}:null,notice:h.notices[w.id]||null,arrival:h.arrivals[w.id]||null,paid:o.paid||o.created||0})}
  os.sort((a,b)=>b.paid-a.paid);return{...w,orders:os}});
 return{rows,preview:preview()}}

async function route(path,body,h,method,{session}){const ok=b=>({status:200,headers:{},body:b});if(!path.startsWith('/admin/waiting'))return null;
 if(path==='/admin/waiting'&&method==='GET'){await transaction(s=>session(s,h));return ok(await transaction(overview))}
 if(method!=='POST')return null;
 return ok(await transaction(async s=>{const sid=await session(s,h),by=await staffName(s,sid);
  if(path==='/admin/waiting/add')return add(s,body,by);
  if(path==='/admin/waiting/arrived')return arrived(s,String(body.id||''),by);
  if(path==='/admin/waiting/remove')return cancel(s,String(body.id||''),by);
  if(path==='/admin/waiting/order')return orderAction(s,body);
  bad('Not found.',404)}))}

module.exports={route,sweep,sweepIn,emailsRun,overview,holdable,heldLines,fullyHeld,boxGone,holdEmail,hereEmail,preview,firstName};

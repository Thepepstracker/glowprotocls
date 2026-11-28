'use strict';
// Inventory you can trust (Jonah, 27 Nov 2026: "i need you to know whats going in and out and i want to be more focused
// and confident about what we have"; "build now").
//   1. In / out log: every change to a store count is written to stock_log with before, after, why and who.
//      The reason comes from the request that changed it (an order, a cancel, a count, a delivery, a product edit…).
//   2. Count sheet: staff type what is physically on the shelf. The store count = shelf − what the waiting boxes still
//      need (the store takes stock off when an order is placed, so those vials are on the shelf but already counted out).
//   3. Received: a supplier delivery from the incoming list is added to the counts in one tap, once.
//
//   GET  /admin/inventory              → pools: name, store count, waiting in boxes, should be on the shelf
//   GET  /admin/inventory/log          → the last 30 days of moves (newest first, at most 1,500)
//   POST /admin/inventory/count        {counts:[{product_id, shelf}], note}
//   POST /admin/inventory/receive      {ref}  (an incoming shipment; its matched lines are added to stock)
const {AsyncLocalStorage}=require('node:async_hooks');
const ctx=new AsyncLocalStorage();
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const now=()=>Math.floor(Date.now()/1000);
const lineUnits=l=>Math.max(1,Number.isSafeInteger(l&&l.units)?l.units:1);
const lineDraws=l=>Array.isArray(l&&l.draws)&&l.draws.length?l.draws:[{id:l.id,qty:lineUnits(l)}];
const poolKey=p=>p.stock_pool||('p'+p.id);

// What a move is called in the log, by the request that made it.
const SOURCES=[[/^\/orders(\/|$)|^\/checkout|^\/quote/,'Order placed'],[/^\/admin\/inventory\/count/,'Shelf count'],[/^\/admin\/inventory\/receive/,'Delivery received'],
 [/^\/admin\/manual-shipment/,'Free / replacement box'],[/^\/admin\/product/,'Product edited'],[/^\/admin\/(status|order)/,'Order changed or canceled'],
 [/refund/,'Refund'],[/subscri/,'Subscription box'],[/^\/admin\/live/,'Live show'],[/expire|autopilot|cron|sweep/,'Unpaid order closed']];
function reasonOf(path){const p=String(path||'');for(const [re,name] of SOURCES)if(re.test(p))return name;return p?'Store: '+p.slice(0,40):'Automatic (store)'}
function run(meta,fn){return ctx.run({...meta},fn)}
function current(){return ctx.getStore()||{}}
// Called by store-core's setStock (one entry per pool change).
async function logMove(s,p,from,to){if(from===to)return;const c=current(),t=now(),id=t+'-'+Math.random().toString(36).slice(2,8);
 await s.put('stock_log',id,{id,at:t,product_id:p.id,name:p.name,pool:poolKey(p),from,to,delta:to-from,reason:c.reason||reasonOf(c.path),ref:c.ref||'',by:c.actor||'',note:c.note||''})}

function poolsOf(products){const pools=new Map();for(const p of products){const k=poolKey(p);let x=pools.get(k);if(!x){x={key:k,name:p.name,stock:Number(p.stock)||0,ids:[],active:false,single:null};pools.set(k,x)}
 x.ids.push(p.id);if(p.active)x.active=true;if(p.brand!=='zader'&&!(Number(p.units)>1)&&!(p.components||[]).length&&!x.single){x.single=p.id;x.name=p.name;x.stock=Number(p.stock)||0}}return pools}
// Vials still on the shelf that the store has already taken off the count: orders placed but not sent yet.
function waiting(orders,manuals,t=now()){const need=new Map(),add=(id,q)=>need.set(id,(need.get(id)||0)+q);
 const open=['order_received','awaiting_payment','payment_submitted','paid'];
 for(const o of orders){if(o.is_test!==false)continue;let take=open.includes(o.status);
  if(o.status==='shipped'){const sh=o.shipment||{},d=o.delivery||{},tr=o.track||{};take=!(o.packed&&o.packed.at)&&(sh.label_created_at||0)>t-7*86400&&!d.first_scan_at&&!tr.first_scan_at&&!d.delivered&&tr.state!=='delivered'&&tr.state!=='in_transit'}
  if(!take)continue;for(const l of o.items||[])for(const d of lineDraws(l))add(d.id,(l.quantity||0)*(d.qty||1))}
 for(const m of manuals||[]){if(m.status!=='open'||!m.stock_taken||(m.packed&&m.packed.at)||m.label_created_at&&m.label_created_at<t-7*86400)continue;for(const l of m.items||[])for(const d of lineDraws(l))add(d.id,(l.quantity||0)*(d.qty||1))}
 return need}
async function overview(s){const [products,orders,manuals]=await Promise.all([s.list('products'),s.listLite?s.listLite('orders'):s.list('orders'),s.list('manual_shipments')]);
 const pools=poolsOf(products),need=waiting(orders,manuals),byId=new Map(products.map(p=>[p.id,p]));
 const out=[];for(const x of pools.values()){let w=0;for(const id of x.ids)w+=need.get(id)||0;out.push({key:x.key,product_id:x.single||x.ids[0],name:x.name,active:x.active,store:x.stock,waiting:w,shelf:x.stock+w})}
 out.sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));return{pools:out,at:now()}}

async function route(s,path,body,method,actor,setStock){
 if(path==='/admin/inventory'&&method==='GET')return overview(s);
 if(path==='/admin/inventory/log'&&method==='GET'){const cut=now()-30*86400;const rows=(await s.list('stock_log')).filter(r=>r.at>=cut).sort((a,b)=>b.at-a.at||(b.id>a.id?1:-1)).slice(0,1500);return{log:rows}}
 if(path==='/admin/inventory/count'&&method==='POST'){const counts=Array.isArray(body.counts)?body.counts:fail('Send the counts.');if(!counts.length)fail('Type at least one count.');if(counts.length>400)fail('Too many lines.');
  const note=String(body.note||'').replace(/\s+/g,' ').trim().slice(0,200);const ov=await overview(s),byPool=new Map(ov.pools.map(p=>[p.key,p])),products=await s.list('products'),byId=new Map(products.map(p=>[p.id,p]));const done=[],seen=new Set();
  const plan=[];for(const c of counts){const p=byId.get(Number(c.product_id));if(!p)fail('A product was not found. Refresh and try again.');const shelf=Number(c.shelf);if(!Number.isInteger(shelf)||shelf<0||shelf>100000)fail('Counts must be whole numbers, 0 or more ('+p.name+').');
   const k=poolKey(p);if(seen.has(k))fail(p.name+' is listed twice (same shelf pile).');seen.add(k);plan.push({p,shelf,x:byPool.get(k)})}
  // everything is checked first, so a bad line never leaves half the counts saved
  for(const {p,shelf,x} of plan){const stock=shelf-(x?x.waiting:0);const fresh=await s.get('products',p.id);
   await ctx.run({...current(),reason:'Shelf count',note,actor},()=>setStock(s,fresh,stock));done.push({name:x?x.name:p.name,shelf,waiting:x?x.waiting:0,before:x?x.store:p.stock,after:stock})}
  return{ok:true,changed:done.filter(d=>d.before!==d.after).length,counted:done}}
 if(path==='/admin/inventory/receive'&&method==='POST'){const ref=String(body.ref||'').trim().slice(0,60);if(!ref)fail('Which delivery?');const inc=await s.get('integrations','incoming');const sh=inc&&(inc.shipments||[]).find(x=>x.ref===ref);if(!sh)fail('That delivery is not in the incoming list. Refresh.',404);
  const done=(await s.get('integrations','incoming_received'))||{refs:{}};if(done.refs[ref])fail('This delivery was already added to stock on '+new Date(done.refs[ref].at*1000).toLocaleDateString('en-US',{timeZone:'America/New_York'})+'.',409);
  const lines=sh.lines.filter(l=>l.product_id!=null);if(!lines.length)fail('None of the items in this delivery are matched to a product.');const added=[];
  for(const l of lines){const p=await s.get('products',l.product_id);if(!p)continue;await ctx.run({...current(),reason:'Delivery received',ref,actor},()=>setStock(s,p,(Number(p.stock)||0)+l.qty));added.push({name:p.name,qty:l.qty})}
  done.refs[ref]={at:now(),by:actor,lines:added};await s.put('integrations','incoming_received',done);sh.status='received';sh.received_at=now();await s.put('integrations','incoming',inc);
  return{ok:true,added,unmatched:sh.lines.filter(l=>l.product_id==null).map(l=>l.name+' ×'+l.qty)}}
 return null}
module.exports={run,current,logMove,route,overview,waiting,reasonOf};

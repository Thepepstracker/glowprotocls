'use strict';
// Waiting on (Jonah, 17 Nov 2026): put in what we're waiting on, hold the orders that have it. Jonah's choices: nothing
// changes for customers in the store; the rest of the order ships now; one hold email and one it's-here email.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-waiting-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'waiting-on-tests-session-secret-32-chars',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),wo=require('../../netlify/functions/lib/waiting-on.cjs'),autopilot=require('../../netlify/functions/lib/autopilot.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const sent=[];const oldFetch=global.fetch;global.fetch=async(url,opts={})=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const N=()=>Math.floor(Date.now()/1000),noon=()=>new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T17:00:00Z').getTime();
let owner,A,B;
const cust=(name,email)=>({name,email,phone:'+14045550111',address:'1 Main St',city:'Canton',state:'GA',zip:'30114'});
const put=o=>transaction(s=>s.put('orders',o.id,o)).then(()=>o);
const order=(id,items,extra={})=>put({id,status:'paid',is_test:false,brand:'glow',created:N()-3600,paid:N()-3600,total:5000,items:items.map(([p,q])=>({id:p.id,name:p.name,quantity:q,price:p.price})),customer:cust('pat buyer',id.toLowerCase()+'@example.test'),...extra});
const get=id=>transaction(s=>s.get('orders',id));
const admin=(p,b)=>call(p,b,owner).then(r=>r.body);

test('setup',async()=>{await transaction(seed);await transaction(async s=>{const st=await s.get('settings','main');Object.assign(st,{demo:false,checkout_enabled:true});await s.put('settings','main',st)});
 owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 [A,B]=await transaction(async s=>{const ps=(await s.list('products')).filter(p=>p.active&&!(p.components||[]).length&&!(Number(p.units)>1)&&!p.stock_pool);return [ps[0],ps[1]]});
 await order('GLP-0000000WO01',[[A,1],[B,1]]);
 await order('GLP-0000000WO02',[[A,2]],{customer:cust('FELECIA LOWERY','felecia@example.test')});
 await order('GLP-0000000WO03',[[A,1],[B,1]],{status:'shipped',shipment:{label_url:'https://x/l.pdf',label_created_at:N()-2*86400},customer:cust('carolyn-dennis','carolyn@example.test')});
 await order('GLP-0000000WO04',[[A,1]],{status:'shipped',shipment:{label_url:'https://x/l.pdf',label_created_at:N()-86400},packed:{at:N()-80000,by:'Owner',fp:'x'}});
 await order('GLP-0000000WO05',[[A,1]],{status:'shipped',shipment:{label_url:'https://x/l.pdf',label_created_at:N()-10*86400},paid:N()-10*86400});
 await order('GLP-0000000WO06',[[A,1]],{is_test:true});
 await order('GLP-0000000WO07',[[A,1]],{status:'awaiting_payment',paid:null});
 await order('GLP-0000000WO09',[[A,1]],{status:'shipped',shipment:{label_url:'https://x/l.pdf',label_created_at:N()-86400},track:{state:'in_transit',first_scan_at:N()-3600}});
});

test('adding a product holds every open order that has it, and only those',async()=>{
 await assert.rejects(call('/admin/waiting/add',{product_id:A.id}),e=>e.status===401||e.status===403,'staff only');
 const r=await admin('/admin/waiting/add',{product_id:A.id,reason:'held up in customs.',expected:''});assert.equal(r.held,3);
 await assert.rejects(admin('/admin/waiting/add',{product_id:A.id,reason:'x'}),e=>e.status===409,'once');
 const o1=await get('GLP-0000000WO01'),o2=await get('GLP-0000000WO02'),o3=await get('GLP-0000000WO03');
 assert.deepEqual(o1.hold.lines.map(l=>[l.id,l.quantity]),[[A.id,1]]);assert.equal(wo.fullyHeld(o1),false,'B still ships now');
 assert.equal(wo.fullyHeld(o2),true,'everything waiting');assert.equal(o2.hold.lines[0].quantity,2);assert(o3.hold.lines.length,'label bought but not packed: still held');
 for(const id of ['GLP-0000000WO04','GLP-0000000WO05','GLP-0000000WO06','GLP-0000000WO07','GLP-0000000WO09'])assert.equal((await get(id)).hold,undefined,id+' is not held (packed, old label, test, unpaid, with the carrier)');
 const w=(await transaction(s=>s.list('waiting_on')))[0];assert.equal(w.reason,'held up in customs','trailing full stop dropped');
});

test('Automatic labels skip an order where everything is waiting, and only that one',async()=>{
 const shippo=require('../../netlify/functions/lib/shippo.cjs'),src=fs.readFileSync(path.join(__dirname,'../../netlify/functions/lib/shippo.cjs'),'utf8');
 assert.match(src,/filter\(eligible\)\.filter\(o=>!require\('\.\/waiting-on\.cjs'\)\.fullyHeld\(o\)\)/);assert(shippo);
 const lite=await transaction(s=>s.listLite('orders'));assert.equal(wo.fullyHeld(lite.find(o=>o.id==='GLP-0000000WO02')),true,'works on the lite list Automatic labels reads');
});

test('a new order with it is held by the sweep that Autopilot runs every minute, even with every switch OFF',async()=>{
 await order('GLP-0000000WO08',[[A,1],[B,2]]);assert.equal((await get('GLP-0000000WO08')).hold,undefined);
 await autopilot.tick();assert.equal((await get('GLP-0000000WO08')).hold.lines.length,1);
 // The unpaid one is held once it's paid.
 await transaction(async s=>{const o=await s.get('orders','GLP-0000000WO07');o.status='paid';o.paid=N();await s.put('orders',o.id,o)});await wo.sweep();assert.equal((await get('GLP-0000000WO07')).hold.lines.length,1);
 assert.equal((await autopilot.status()).tasks.find(t=>t.key==='holds').on,false,'the emails start OFF');
});

test('per order: not this order, put it back, told by hand',async()=>{const w=(await transaction(s=>s.list('waiting_on')))[0];
 await admin('/admin/waiting/order',{order_id:'GLP-0000000WO07',waiting_id:w.id,action:'exclude'});let o=await get('GLP-0000000WO07');assert.equal(o.hold.lines.length,0);assert.equal(o.hold.notices[w.id].status,'skipped');
 await wo.sweep();assert.equal((await get('GLP-0000000WO07')).hold.lines.length,0,'stays off hold');
 await admin('/admin/waiting/order',{order_id:'GLP-0000000WO07',waiting_id:w.id,action:'include'});o=await get('GLP-0000000WO07');assert.equal(o.hold.lines.length,1);assert.equal(o.hold.notices[w.id].status,'pending','gets the email again');
 await admin('/admin/waiting/order',{order_id:'GLP-0000000WO07',waiting_id:w.id,action:'exclude'});
 await admin('/admin/waiting/order',{order_id:'GLP-0000000WO01',waiting_id:w.id,action:'told_by_hand'});assert.equal((await get('GLP-0000000WO01')).hold.notices[w.id].status,'by_hand');
});

test('hold emails: one per order, the approved wording, first names fixed, quiet at night',async()=>{
 const late=new Date(new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'})+'T03:00:00Z').getTime()+86400000;assert.equal((await wo.emailsRun(25,late)).status,'quiet_hours');
 sent.length=0;const r=await wo.emailsRun(25,noon());assert.equal(r.sent,3,'WO02, WO03, WO08 (WO01 told by hand, WO07 not this order)');
 const to=x=>sent.find(m=>m.to[0]===x);assert(!to('glp-0000000wo01@example.test'));assert(!to('glp-0000000wo07@example.test'));
 const f=to('felecia@example.test');assert.equal(f.subject,'An update on your Glow Lab order · GLP-0000000WO02');assert.match(f.text,/Hi Felecia,/);
 assert.match(f.text,/We’re waiting on our .+ shipment, which is held up in customs right now\. As soon as it reaches us, we’ll get it out to you\./);assert.doesNotMatch(f.text,/rest of your order/,'whole order waiting');
 const c=to('carolyn@example.test');assert.match(c.text,/Hi Carolyn,/);assert.match(c.text,/The rest of your order is shipping as normal\./);assert.match(c.text,/just reply here if you have any questions/);
 assert.equal((await wo.emailsRun(25,noon())).sent,0,'never twice');
});

test('It’s here: an unpacked order packs it in its own box; a box that already went gets a Packing page shipment; stock is not taken twice',async()=>{
 const w=(await transaction(s=>s.list('waiting_on')))[0];
 await transaction(async s=>{const o=await s.get('orders','GLP-0000000WO01');o.packed={at:N(),by:'Owner',fp:'x'};await s.put('orders',o.id,o)}); // the rest of WO01 already shipped
 const stock=async()=>(await transaction(s=>s.get('products',A.id))).stock,before=await stock();
 const r=await admin('/admin/waiting/arrived',{id:w.id});assert.equal(r.shipments,1);assert(r.released>=4);assert.equal(await stock(),before,'no stock moved');
 const o1=await get('GLP-0000000WO01'),o2=await get('GLP-0000000WO02');assert.equal(o1.hold.lines.length,0);assert.equal(o1.hold.released[0].how,'shipment');assert.equal(o2.hold.released[0].how,'with_box');assert.equal(wo.fullyHeld(o2),false,'labels can be bought again');
 const m=await transaction(s=>s.get('manual_shipments',o1.hold.released[0].shipment_id));assert.equal(m.reason,'waiting');assert.equal(m.order_id,'GLP-0000000WO01');assert.equal(m.stock_taken,false);assert.deepEqual(m.items.map(i=>[i.id,i.quantity]),[[A.id,1]]);assert.equal(m.to.zip,'30114');assert.match(m.note,/held up in customs/);
 await assert.rejects(admin('/admin/waiting/arrived',{id:w.id}),e=>e.status===409,'once');
 sent.length=0;await wo.emailsRun(25,noon());const t1=sent.find(x=>x.to[0]==='glp-0000000wo01@example.test'),t2=sent.find(x=>x.to[0]==='felecia@example.test');
 assert.match(t1.subject,/^Good news: your .+ is here · GLP-0000000WO01$/);assert.match(t1.text,/ship to you on its own/);assert.match(t2.text,/We’re packing your order now/);
 assert(!sent.some(x=>x.to[0]==='glp-0000000wo07@example.test'),'not this order: no it’s-here email either');
 await wo.sweep();assert.equal((await get('GLP-0000000WO02')).hold.lines.length,0,'no new holds once it’s here');
});

test('Remove (added by mistake): holds come off and no emails go out',async()=>{
 const {id}=await admin('/admin/waiting/add',{product_id:B.id,reason:'late from the supplier'});await order('GLP-0000000WO10',[[B,1]]);await wo.sweep();assert.equal((await get('GLP-0000000WO10')).hold.lines.length,1);
 await admin('/admin/waiting/remove',{id});const o=await get('GLP-0000000WO10');assert.equal(o.hold.lines.length,0);assert.equal(o.hold.notices[id].status,'skipped');
 sent.length=0;await wo.emailsRun(25,noon());assert(!sent.some(x=>x.to[0]==='glp-0000000wo10@example.test'));
});

test('Management list: staff only, rows with orders and both email previews',async()=>{
 await assert.rejects(call('/admin/waiting'),e=>e.status===401||e.status===403);
 const v=await admin('/admin/waiting');assert.equal(v.rows.length,2);const a=v.rows.find(r=>r.product_id===A.id);assert.equal(a.status,'arrived');assert(a.orders.some(o=>o.id==='GLP-0000000WO07'&&o.excluded));
 assert.match(v.preview.hold.text,/held up in customs/);assert.match(v.preview.here.subject,/Good news/);
 assert.equal(wo.firstName({customer:{name:'carolyn-dennis'}}),'Carolyn');assert.equal(wo.firstName({customer:{name:'Mary-Kate Olsen'}}),'Mary-Kate');assert.equal(wo.firstName({customer:{name:'FELECIA LOWERY'}}),'Felecia');
});

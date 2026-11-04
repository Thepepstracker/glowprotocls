'use strict';
// Autopilot (4 Nov 2026): background jobs start OFF, only the owner can switch them, and payment reminders
// go out on day 1, 3 and 6 to invoiced unpaid orders only — never twice, never in quiet hours, never after payment.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-autopilot-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'autopilot-tests-session-secret-more-than-32',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'1',STORE_EMAIL_FROM:'team@example.com',RESEND_API_KEY:'test-not-real'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),ap=require('../../netlify/functions/lib/autopilot.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const cookie=r=>r.headers['Set-Cookie'].split(';')[0];const sent=[];const oldFetch=global.fetch;
global.fetch=async(url,opts)=>{if(String(url).includes('resend.com')){sent.push(JSON.parse(opts.body));return{ok:true,status:200,json:async()=>({id:'x'+sent.length})}}throw new Error('no network in tests')};
after(()=>{global.fetch=oldFetch;ap.stop();fs.rmSync(tmp,{recursive:true,force:true})});
const DAY=86400,T=Math.floor(Date.UTC(2026,10,4,17,0)/1000); // 12:00 PM Eastern
const order=(id,days,extra={})=>({id,status:'awaiting_payment',is_test:false,created:T-days*DAY-60,invoice_sent_at:T-days*DAY,expires:T-days*DAY+7*DAY,total:12999,items:[],token_hash:'x',customer:{name:'Pat Buyer',email:id.toLowerCase()+'@example.test'},...extra});

test('reminder schedule: day 1, 3, 6; newest due only; skips paid, test, uninvoiced, screenshot and near-expiry orders',()=>{
 assert.equal(ap.dueStep(order('A',0.5),T),null);
 assert.equal(ap.dueStep(order('A',1.2),T).key,'d1');
 assert.equal(ap.dueStep(order('A',4),T).key,'d3','only the newest due reminder, not d1 and d3 together');
 assert.equal(ap.dueStep(order('A',6.2),T).key,'d6');
 assert.equal(ap.dueStep(order('A',6.97),T),null,'under an hour before release: nothing');
 assert.equal(ap.dueStep(order('A',4,{auto_collect:{round:'0',d1:1,d3:1}}),T),null,'never twice');
 assert.equal(ap.dueStep(order('A',4,{last_payment_reminder_at:T-3600}),T),null,'not right after a manual reminder');
 for(const x of [{status:'paid'},{status:'order_received'},{is_test:true},{has_receipt:true},{receipt:'data'},{paid:T}])assert.equal(ap.dueStep(order('A',4,x),T),null,JSON.stringify(x));
 assert.equal(ap.dueStep(order('A',2,{restored_at:T-2*DAY,restore_count:1,auto_collect:{round:'0',d1:1,d3:1}}),T).key,'d1','a reinstated order starts a fresh round');
 const last=ap.reminderCopy({key:'d6',last:true},order('A',6.2));assert.match(last.subject,/^Last reminder/);assert(last.lines.some(l=>/We will hold it until/.test(l)));assert(!last.lines.join(' ').match(/dose|inject|treat/i),'RUO: no health wording');
});

test('Autopilot starts OFF; staff can view but only the owner can switch; collect sends each reminder once',async()=>{
 await transaction(seed);const owner=cookie(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD}));
 const st=await call('/admin/autopilot',undefined,owner);assert.equal(st.body.tasks.length,5);assert(st.body.tasks.every(t=>t.on===false),'every task starts OFF');assert.equal(st.body.preview.length,2);
 await call('/admin/staff/invite',{email:'packer@example.com',name:'Packer'},owner);const m=sent.at(-1).text.match(/#staff=([a-f0-9]{64})\.([A-Za-z0-9_-]{43})/);
 const staff=cookie(await call('/staff/setup',{id:m[1],token:m[2],password:'long staff passphrase for testing'}));
 assert.equal((await call('/admin/autopilot',undefined,staff)).body.tasks.length,5,'staff can look');
 await assert.rejects(call('/admin/autopilot',{task:'collect',on:true},staff),e=>e.status===403);
 await assert.rejects(call('/admin/autopilot',{task:'nope',on:true},owner),e=>e.status===400);
 const on=await call('/admin/autopilot',{task:'collect',on:true},owner);assert.equal(on.body.tasks.find(t=>t.key==='collect').on,true);
 await transaction(async s=>{for(const o of [order('GLP-D1',1.5),order('GLP-D4',4),order('GLP-PAID',4,{status:'paid',paid:T}),order('GLP-NEW',0.2)])await s.put('orders',o.id,o)});
 const before=sent.length;
 assert.equal((await ap.collect(10,T-14*3600)).status,'quiet_hours','10 PM Eastern: nothing sent');
 const r=await ap.collect(10,T);assert.equal(r.sent,2);const mails=sent.slice(before);assert.deepEqual(mails.map(x=>x.to[0]).sort(),['glp-d1@example.test','glp-d4@example.test']);assert(mails.every(x=>/Friendly payment reminder/.test(x.subject)));
 assert.equal((await ap.collect(10,T+600)).sent,0,'running again sends nothing');
 const d4=await transaction(s=>s.get('orders','GLP-D4'));assert(d4.auto_collect.d1&&d4.auto_collect.d3);assert.equal(d4.last_payment_reminder_at,T);
 const later=T+2*DAY+3600;const r2=await ap.collect(10,later);assert.equal(r2.sent,3,'D1 gets day 3, D4 the last reminder, NEW its day-1 reminder');assert(sent.slice(-3).some(x=>/^Last reminder/.test(x.subject)));
 await call('/admin/autopilot',{task:'collect',on:false},owner);assert.equal((await call('/admin/autopilot',undefined,owner)).body.tasks.find(t=>t.key==='collect').on,false);
});

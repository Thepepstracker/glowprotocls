'use strict';
// Autopilot (Jonah, 4 Nov 2026). Sevalla runs only the web process, so the background jobs in
// tools/sevalla/worker.cjs were never scheduled. This runs them inside the web process instead,
// once a minute, and only the ones the owner switches on in Management → Autopilot. Every switch starts OFF.
//   email     retry queued customer emails that failed the first time
//   tracking  ask UPS for delivery updates (customers get "out for delivery" / "delivered" emails)
//   labels    buy Shippo labels for paid orders (Shippo's own switch, $15 price check and daily limit still apply)
//   collect   payment reminders for invoiced, unpaid orders: day 1, day 3, and a last reminder on day 6
//             (the store already releases an unpaid invoiced order on day 7)
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const TASKS={
 email:{name:'Email retries',every:60,help:'Re-sends customer emails that failed the first time, retries automatic Stripe invoices that failed to send, and voids the Stripe invoice of any canceled or expired order.'},
 tracking:{name:'UPS delivery updates',every:300,help:'Checks UPS for each shipped package. Customers get the out-for-delivery and delivered emails.'},
 labels:{name:'Automatic labels',every:60,help:'Buys the UPS label for each paid order through Shippo. The $15 price check, the daily limit and Shippo’s own ON switch still apply.'},
 collect:{name:'Payment reminders',every:3600,help:'Emails invoiced, unpaid customers on day 1, day 3 and day 6. The store releases the order on day 7.'},
 reorders:{name:'Reorder reminders',every:3600,help:'About 30 days after a customer’s last order (up to 90), one email puts the same items back in their bag in one tap and mentions Subscribe & save. Not sent to subscribers or anyone who unsubscribed. 10 AM–7 PM Eastern. Needs STORE_POSTAL_ADDRESS set.'},
 bags:{name:'Bag reminders',every:900,help:'Signed-in customers who leave items in their bag get one reminder 3–48 hours later (at most one every 7 days), unless they ordered. 9 AM–9 PM Eastern. Needs STORE_POSTAL_ADDRESS set.'},
 reviews:{name:'Review requests',every:3600,help:'2 days after delivery (or 7 days after shipping), one email asks the customer to rate their order. Reviews only show on the store after you approve them in Management → Growth. Needs STORE_POSTAL_ADDRESS set.'},
 subscriptions:{name:'Subscribe & save orders',every:3600,help:'Two days before each subscription’s ship date (10 AM–6 PM Eastern), makes the repeat order at the customer’s tier price and charges their saved card through Stripe. Emails the customer 3 days before each charge. Confirms first payments made on Stripe Checkout. While this is OFF, customers cannot start a subscription in the bag. A declined card is flagged; it is never charged twice.'}
};
const STEPS=[{key:'d1',days:1},{key:'d3',days:3},{key:'d6',days:6,last:true}];
const ID=crypto.randomBytes(6).toString('hex');
function blank(){return{tasks:Object.fromEntries(Object.keys(TASKS).map(k=>[k,{on:false}]))}}
function shape(rec){const r=blank();for(const k of Object.keys(TASKS))Object.assign(r.tasks[k],rec?.tasks?.[k]||{});return r}
async function status(){const rec=shape(await transaction(s=>s.get('integrations','autopilot')));return{tasks:Object.entries(TASKS).map(([key,t])=>({key,name:t.name,help:t.help,every:t.every,...rec.tasks[key]})),steps:STEPS,preview:previewEmails()}}
async function set(task,on,by='owner'){if(!TASKS[task])throw Object.assign(new Error('Unknown autopilot task.'),{status:400});return transaction(async s=>{const rec=shape(await s.get('integrations','autopilot'));rec.tasks[task]={...rec.tasks[task],on:!!on,changed_at:now(),changed_by:by};await s.put('integrations','autopilot',rec);return{task,on:!!on}})}
// The Eastern-time hour, so reminders only go out 9 AM–8 PM.
function etHour(t=Date.now()){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)))}
function longDate(ts){return new Date(ts*1000).toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric'})}
function collectable(o){return !!o&&o.is_test===false&&o.status==='awaiting_payment'&&!o.receipt&&!o.has_receipt&&!o.paid&&!!o.customer?.email&&!(o.proof_required===true&&o.checkout_stage==='draft')}
function base(o){return Math.max(o.invoice_sent_at||0,o.restored_at||0)||o.created||0}
// Which reminder is due now, if any. Only the newest due one is sent, so switching this on never floods an old order.
function dueStep(o,t=now()){if(!collectable(o))return null;const age=t-base(o),sent=o.auto_collect||{},round=String(o.restore_count||0);if(sent.round!==undefined&&String(sent.round)!==round)return dueStep({...o,auto_collect:{}},t);
 if((o.expires||0)<=t+3600)return null;if((o.last_payment_reminder_at||0)>t-20*3600)return null;
 const due=STEPS.filter(x=>age>=x.days*86400).pop();if(!due||sent[due.key])return null;return due}
// Reminder wording. Shown to the owner in Management before the switch can be turned on.
function reminderCopy(step,o){const last=!!step?.last,name=o.customer?.name||'there',hold=o.expires?longDate(o.expires):'';
 return last?{subject:'Last reminder · your Glow Lab order '+o.id,lines:['Hi '+name+',','We are still holding your order, but we have not received your payment yet.','Order: '+o.id,'Order total: '+money(o.total),(hold?'We will hold it until '+hold+'. After that, the items go back into stock for other customers.':'We will hold it a little longer. After that, the items go back into stock for other customers.'),'Please use your invoice or the payment options on your order page to pay. Once we verify it, your order goes straight into our packing queue.','If you have already paid, please do not pay again. Reply to this email with your payment details so we can find it.','Changed your mind? No problem. Just reply and let us know.']}
 :null}
function money(c){return '$'+((c||0)/100).toFixed(2)}
function previewEmails(){const o={id:'GLP-EXAMPLE',total:12999,customer:{name:'Jane'},expires:now()+86400};return[{step:'Day 1 and day 3',subject:'Friendly payment reminder · Glow Lab GLP-EXAMPLE',lines:require('./store-email.cjs').reminderLines(o),button:'View your order and payment options'},{step:'Day 6 (last reminder)',...reminderCopy(STEPS[2],o),button:'View your order and payment options'}]}
// Payment reminders. Needs the order-link signer and the email queue from the store.
async function collect(limit=10,t=now()){
 if(etHour(t*1000)<9||etHour(t*1000)>=20)return{status:'quiet_hours',sent:0};
 const core=require('./store-core.cjs'),emails=require('./store-email.cjs');if(!emails.configuration().ready)return{status:'email_not_configured',sent:0};
 const jobs=await transaction(async s=>{const ids=(await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>dueStep(o,t)).sort((a,b)=>base(a)-base(b)).slice(0,limit).map(o=>o.id),out=[];
  for(const id of ids){const o=await s.get('orders',id),step=dueStep(o,t);if(!step)continue;const round=String(o.restore_count||0),jobId='auto-collect-'+o.id+'-r'+round+'-'+step.key;
   const job=await emails.queueReminder(s,o,core.reminderToken(o),jobId,reminderCopy(step,o));if(!job)continue;
   const sent=o.auto_collect&&String(o.auto_collect.round)===round?o.auto_collect:{round};for(const x of STEPS)if(x.days<=step.days&&!sent[x.key])sent[x.key]=t;o.auto_collect=sent;o.last_payment_reminder_at=t;o.last_payment_reminder_job=jobId;await s.put('orders',o.id,o);
   const log=await s.get('audit','log')||[];log.push({created:t,action:'auto_payment_reminder_'+step.key,order_id:o.id});await s.put('audit','log',log.slice(-5000));out.push(job)}
  return out});
 for(const j of jobs)await emails.safeDispatch(j);
 return{status:'ok',sent:jobs.length};
}
async function runTask(key){
 // Email retries also retry automatic Stripe invoices that failed to send (up to 5 tries each), which worker.cjs did on Netlify.
 if(key==='email'){const r=await require('./store-email.cjs').dispatchPending(8,20000);try{await require('./auto-invoice.cjs').retryFailed(5)}catch(e){console.error('Invoice retry failed.',{message:String(e&&e.message||e).slice(0,160)})}try{await require('./auto-invoice.cjs').voidPending(10)}catch(e){console.error('Invoice void failed.',{message:String(e&&e.message||e).slice(0,160)})}return r}
 if(key==='tracking')return require('./order-tracking.cjs').refreshDue(8);
 if(key==='labels'){const shippo=require('./shippo.cjs');if(!await shippo.enabled())return{status:'shippo_off'};return shippo.pending(3)}
 if(key==='collect')return collect();
 if(key==='subscriptions')return require('./subscriptions.cjs').run();
 if(key==='reorders')return require('./growth.cjs').reorders();
 if(key==='bags')return require('./growth.cjs').bags();
 if(key==='reviews')return require('./growth.cjs').reviews();
}
let running=false;
// One pass: runs each switched-on task whose interval has passed. Holds a short lease so two copies of the app never overlap.
async function tick(){
 if(running)return;running=true;
 try{
  const plan=await transaction(async s=>{const rec=shape(await s.get('integrations','autopilot')),lease=await s.get('integrations','autopilot-lease');if(lease&&lease.until>now()&&lease.holder!==ID)return null;
   const due=Object.keys(TASKS).filter(k=>rec.tasks[k].on&&(rec.tasks[k].last_run||0)+TASKS[k].every<=now()+5);if(!due.length)return[];await s.put('integrations','autopilot-lease',{id:'autopilot-lease',holder:ID,until:now()+120});return due});
  if(!plan||!plan.length)return;
  for(const key of plan){let result,error='';try{result=await runTask(key)}catch(e){error=String(e&&e.message||e).slice(0,200)}
   await transaction(async s=>{const rec=shape(await s.get('integrations','autopilot'));Object.assign(rec.tasks[key],{last_run:now(),last_error:error,last_result:summary(result)});await s.put('integrations','autopilot',rec)})}
  await transaction(async s=>{const lease=await s.get('integrations','autopilot-lease');if(lease?.holder===ID)await s.put('integrations','autopilot-lease',{id:'autopilot-lease',holder:ID,until:0})});
 }catch(e){console.error('Autopilot pass failed.',{message:String(e&&e.message||e).slice(0,200)})}
 finally{running=false}
}
function summary(r){if(!r||typeof r!=='object')return '';if(typeof r.made==='number'&&r.status==='ok')return r.made+' made · '+(r.paid||0)+' paid'+(r.failed?' · '+r.failed+' NOT paid':'')+(r.cards?' · '+r.cards+' card'+(r.cards===1?'':'s')+' saved':'');if(r.status&&r.status!=='ok')return String(r.status).replace(/_/g,' ');if(typeof r.sent==='number')return r.sent+' sent';if(typeof r.processed==='number')return r.processed+' processed';return 'done'}
let timer=null;
function start(intervalMs=60000){if(timer)return timer;timer=setInterval(()=>{tick()},intervalMs);if(timer.unref)timer.unref();setTimeout(()=>{tick()},15000).unref?.();return timer}
function stop(){if(timer)clearInterval(timer);timer=null}
module.exports={TASKS,STEPS,status,set,tick,start,stop,collect,dueStep,collectable,reminderCopy,previewEmails,etHour};

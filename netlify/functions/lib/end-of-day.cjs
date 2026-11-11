'use strict';
// End of day (Jonah, 11 Nov 2026): "i feel like i have to grind every night or im losing money, never really any time to wind down".
// One check that answers "can I stop for tonight?": anything that will break or upset a customer before morning is
// listed under "Fix before bed"; everything else that is normal work waits under "Tomorrow". All clear = nothing to fix.
// Read-only: it never changes an order, email or label.
const {transaction}=require('./store-db.cjs'),brands=require('./brands.cjs');
const now=()=>Math.floor(Date.now()/1000);
const DAY=86400;
const list=(s,k)=>s.listLite?s.listLite(k):s.list(k);
const name=o=>{const n=String(o.customer?.name||o.to?.name||'').trim().split(/\s+/);return (n[0]||'Customer')+(n.length>1?' '+n[n.length-1][0].toUpperCase()+'.':'')};
const isTestAddress=e=>/@example\.(com|org|net)$/i.test(String(e||''));

function check({orders,subs,emails,printLog,manuals},brand,t=now()){
 const mine=x=>(x.brand||'glow')===brand;
 const live=orders.filter(o=>o.is_test===false&&mine(o)&&!o.legacy_import);
 const printed=id=>!!(printLog.find(r=>r.id===id)||{}).label;
 // ---- fix before bed ----
 const labelProblems=live.filter(o=>o.shippo_needs_review||o.shippo_status==='needs_review'||(o.label_status==='buying'&&(o.label_started_at||o.updated||0)<t-900))
  .map(o=>({id:o.id,name:name(o),why:String(o.shippo_message||'The label purchase did not finish.').slice(0,140)}));
 const subProblems=subs.filter(x=>mine(x)&&x.status!=='canceled'&&(x.payment_issue||x.problem))
  .map(x=>({id:x.id,name:name(x),why:String(x.problem||'Card payment did not go through.').slice(0,140)}));
 const emailProblems=emails.filter(j=>(j.brand||'glow')===brand&&(j.created||0)>t-DAY&&['rejected','needs_review'].includes(j.status)&&!isTestAddress(j.to))
  .map(j=>({id:j.id,kind:j.kind||'email',why:String(j.message||'Email was not sent.').slice(0,140)}));
 const emailStuck=emails.filter(j=>(j.brand||'glow')===brand&&(j.created||0)>t-DAY&&j.status==='retry'&&(j.attempts||0)>=3&&!isTestAddress(j.to)).length;
 // ---- tomorrow (normal work, nothing breaks overnight) ----
 const toLabel=live.filter(o=>o.status==='paid'&&!o.tracking&&!o.shipment?.tracking);
 const notPrinted=[...live.filter(o=>o.status==='shipped'&&o.shipment?.label_created_at>t-3*DAY&&!o.delivery?.first_scan_at&&!printed(o.id)).map(o=>({id:o.id,name:name(o)})),
  ...manuals.filter(m=>mine(m)&&m.status!=='canceled'&&m.tracking&&(m.label_created_at||m.created||0)>t-3*DAY&&!printed(m.id)).map(m=>({id:m.id,name:name(m)}))];
 const toVerify=live.filter(o=>o.status==='payment_submitted');
 const unpaid=live.filter(o=>['order_received','awaiting_payment'].includes(o.status)&&o.checkout_stage!=='draft');
 const fix=[...labelProblems.map(x=>({type:'label',...x})),...subProblems.map(x=>({type:'subscription',...x})),...emailProblems.map(x=>({type:'email',...x}))];
 if(emailStuck)fix.push({type:'email',id:'retry',name:'',why:emailStuck+' email'+(emailStuck===1?' has':'s have')+' failed 3 or more times today.'});
 const today=live.filter(o=>(o.paid||0)>t-DAY&&['paid','shipped'].includes(o.status));
 return{brand,checked_at:t,all_clear:fix.length===0,fix,
  tomorrow:{to_label:toLabel.length,to_label_cents:toLabel.reduce((n,o)=>n+(o.total||0),0),not_printed:notPrinted.length,not_printed_list:notPrinted.slice(0,10),
   to_verify:toVerify.length,to_verify_list:toVerify.slice(0,10).map(o=>({id:o.id,name:name(o),cents:o.total||0,method:o.payment_method||''})),unpaid:unpaid.length,unpaid_cents:unpaid.reduce((n,o)=>n+(o.balance_due_cents||o.total||0),0)},
  today:{paid_orders:today.length,paid_cents:today.reduce((n,o)=>n+(o.verified_payment_cents??o.total??0),0)}};
}

async function route(path,body,h,method,{session}){
 if(path!=='/admin/end-of-day')return null;
 if(method!=='GET')return null;
 return transaction(async s=>{await session(s,h);const brand=brands.fromHeaders(h).id;
  const data={orders:await list(s,'orders'),subs:await s.list('subscriptions'),emails:await s.list('email_outbox'),printLog:await s.list('print_log'),manuals:await s.list('manual_shipments')};
  return{status:200,headers:{},body:check(data,brand)}});
}
module.exports={route,check};

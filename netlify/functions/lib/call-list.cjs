'use strict';
// Daily "who to call" email for staff. Once a day (12 noon hour, Eastern), every shipped order whose
// package should have landed a few days ago and has a phone number goes on one email to Jonah.
// Each order is listed once. Nothing is sent on days with nobody to call.
const {transaction}=require('./store-db.cjs');
const emails=require('./store-email.cjs');
const DAY=86400;
const now=()=>Math.floor(Date.now()/1000);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((n||0)/100);
const isDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d);
function etDate(sec=now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(sec*1000))}
function etHour(sec=now()){return Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(sec*1000)))}
function daysBetween(a,b){return Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/864e5)}
function longDay(d){return new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'})}
function phoneDigits(p){const d=String(p||'').replace(/\D/g,'');return d.length===11&&d[0]==='1'?d.slice(1):d}
function prettyPhone(d){return d.length===10?'('+d.slice(0,3)+') '+d.slice(3,6)+'-'+d.slice(6):d}
// When the package left (or landed, if UPS has told us). Orders shipped before label tracking existed
// have no ship date, so the day after payment is used and marked as an estimate.
function landing(o){
 const sh=o.shipment||{};
 if(isDay(sh.delivered_date))return{day:sh.delivered_date,kind:'delivered'};
 if(isDay(sh.ship_date))return{day:sh.ship_date,kind:'shipped'};
 if(o.paid)return{day:etDate(o.paid+DAY),kind:'estimate'};
 return null;
}
function due(orders,today=etDate()){
 const counts=new Map();
 for(const o of orders)if(o.is_test===false&&!['canceled','expired'].includes(o.status)){const e=String(o.customer?.email||'').toLowerCase();counts.set(e,(counts.get(e)||0)+1)}
 const list=[];
 for(const o of orders){
  if(o.status!=='shipped'||o.is_test!==false||o.call_listed_at)continue;
  const phone=phoneDigits(o.customer?.phone);if(phone.length<10)continue;
  const l=landing(o);if(!l)continue;
  const age=daysBetween(l.day,today);
  // Delivered 2–7 days ago, or shipped 4–9 days ago (about two days in transit).
  if(l.kind==='delivered'?(age<2||age>7):(age<4||age>9))continue;
  list.push({o,phone,landing:l,age,orders:counts.get(String(o.customer.email||'').toLowerCase())||1});
 }
 // First orders first (the people most likely never to come back), then oldest first.
 return list.sort((a,b)=>(a.orders===1?0:1)-(b.orders===1?0:1)||b.age-a.age||a.o.id.localeCompare(b.o.id));
}
function firstName(o){return String(o.customer?.name||'').trim().split(/\s+/)[0]||'a customer'}
function render(list,today){
 const n=list.length,subject=n+' to call today · '+firstName(list[0].o)+(n>1?' and '+(n===2?'1 other':(n-1)+' others'):'');
 const when=x=>x.landing.kind==='delivered'?'Delivered '+longDay(x.landing.day)+' ('+x.age+' day'+(x.age===1?'':'s')+' ago)':(x.landing.kind==='shipped'?'Shipped ':'Shipped about ')+longDay(x.landing.day)+' ('+x.age+' days ago)';
 const items=o=>(o.items||[]).map(i=>i.name+' × '+i.quantity).join(', ');
 const ask='What to ask: did it turn up, was anything cracked or missing, did the vials match what they ordered, did the website or paying give them any trouble. Then tell them when the next live is.';
 const dont='What not to ask: how it is working for them. If they tell you, do not write it down.';
 const vm='Voicemail: "Hi, it’s Jonah from Glow Lab, Heather’s son. Nothing’s wrong, I was just checking your order turned up in one piece. If anything was off, call or email us and we’ll sort it right away. Take care."';
 const text=[subject,...list.map((x,i)=>(i+1)+'. '+x.o.customer.name+(x.orders===1?' (FIRST ORDER)':'')+'\n   '+prettyPhone(x.phone)+'\n   '+items(x.o)+'\n   '+x.o.id+' · '+money(x.o.total)+' · '+when(x)),ask,dont,vm,'Glow Lab'].join('\n\n');
 const rows=list.map(x=>`<tr><td style="padding:14px 0;border-top:1px solid #e4dccd"><div style="font-size:19px;font-weight:700">${esc(x.o.customer.name)}${x.orders===1?' <span style="background:#1f7a3a;color:#fff;font-size:11px;letter-spacing:.08em;padding:2px 8px;border-radius:10px;vertical-align:middle">FIRST ORDER</span>':''}</div><a href="tel:+1${esc(x.phone)}" style="display:inline-block;margin:8px 0;padding:10px 16px;background:#1b1b1b;color:#fff;text-decoration:none;border-radius:8px;font-size:20px;font-weight:700">📞 ${esc(prettyPhone(x.phone))}</a><div style="font-size:15px">${esc(items(x.o))}</div><div style="font-size:13px;color:#6b6459;margin-top:4px">${esc(x.o.id)} · ${esc(money(x.o.total))} · ${esc(when(x))}${x.orders>1?' · order '+x.orders+' with us':''}</div></td></tr>`).join('');
 const html=`<!doctype html><html><body style="margin:0;background:#f6f3ec;color:#1b1b1b;font-family:Arial,Helvetica,sans-serif"><div style="max-width:600px;margin:0 auto;padding:24px 18px"><div style="font-size:12px;letter-spacing:.2em;color:#b88a2e;font-weight:700">GLOW LAB · CALL LIST · ${esc(longDay(today))}</div><h1 style="font-size:24px;margin:8px 0 4px">${esc(n+' to call today')}</h1><p style="margin:0 0 8px;color:#6b6459">Tap a number to call. Best between 1 and 5 PM.</p><table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table><div style="margin-top:18px;padding:14px;background:#fff;border:1px solid #e4dccd;border-radius:10px;font-size:15px;line-height:1.5"><p style="margin:0 0 8px"><b>${esc(ask.split(':')[0])}:</b>${esc(ask.slice(ask.indexOf(':')+1))}</p><p style="margin:0 0 8px;color:#a23b1d"><b>${esc(dont.split(':')[0])}:</b>${esc(dont.slice(dont.indexOf(':')+1))}</p><p style="margin:0;color:#6b6459">${esc(vm)}</p></div><p style="font-size:12px;color:#888;margin-top:16px">Each order appears on one day's list only. This email is only sent on days with someone to call.</p></div></body></html>`;
 return{subject,content:{text,html}};
}
function recipient(){const t=(process.env.STORE_CALL_LIST_TO||'jonahglowwithheather@gmail.com').trim();return /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(t)?t:null}
// force: send now regardless of the hour (Management "send it to me now"). preview: build the list only.
async function run({force=false,preview=false,max=25}={}){
 const t=now(),today=etDate(t);
 if(!force&&!preview&&etHour(t)!==12)return{status:'not_time'};
 const to=recipient();if(!to&&!preview)return{status:'no_recipient'};
 return transaction(async s=>{
  const all=await s.list('orders'),list=due(all,today).slice(0,max);
  const summary=list.map(x=>({id:x.o.id,name:x.o.customer.name,phone:prettyPhone(x.phone),first:x.orders===1,landed:x.landing.kind,day:x.landing.day,age:x.age}));
  if(preview)return{status:'preview',today,count:list.length,list:summary};
  const id='call-list-'+today+(force?'-now-'+t:'');
  if(!force&&await s.get('email_outbox',id))return{status:'already_sent',today};
  if(!list.length)return{status:'nobody',today,count:0};
  const {subject,content}=render(list,today);
  const job=await emails.enqueue(s,{id,kind:'call_list',to,related_id:today,subject,content,brand:'glow',expires:t+8*3600});
  if(!job)return{status:'email_not_configured',count:list.length,list:summary};
  for(const x of list){const o=await s.get('orders',x.o.id);if(o&&!o.call_listed_at){o.call_listed_at=t;o.call_list_id=id;await s.put('orders',o.id,o)}}
  return{status:'queued',job,today,count:list.length,list:summary};
 });
}
module.exports={run,due,render,landing,etDate,etHour,phoneDigits};

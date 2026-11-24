'use strict';
// Giveaway winners (Jonah, 23 Nov 2026: "if they arnt in the live they still get a notifcation where it says they were the
// winners in the give away"). Staff pick a winner's most recent order in Management, choose the prize, and Send:
//   - the prize is added free ($0) to that order, so it ships in the same box (skipped if it is already on the order at $0);
//   - an email "You won the Glow Lab giveaway!" goes to the customer (preview first);
//   - a phone alert goes to any Glow Lab app the customer turned alerts on in;
//   - the next time they open their account a "You won" pop-up shows once; one tap and it's gone, and the prize shows on
//     that order in their order history.
// Records live in `giveaway_wins`. One win per (order, click key): pressing Send twice never sends twice.
const crypto=require('crypto');
const {transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const bad=(m,status=400)=>{const e=new Error(m);e.status=status;throw e};
const first=n=>String(n||'').trim().split(/\s+/)[0]||'there';
const cap=s=>String(s||'').replace(/^./,c=>c.toUpperCase());

function prizeText(prize){return prize.map(p=>(p.quantity>1?p.quantity+' × ':'')+p.name).join(', ')}

// The email. Uses the store's own template (gold header, card, button) so it looks like every other Glow Lab email.
function content(o,prize,note){const emails=require('./store-email.cjs');const url=emails.configuration().origin+'/store-next/account';
 const name=first(o.customer?.name);
 return{subject:'You won the Glow Lab giveaway! 🎉',
  content:emails.template('You won the giveaway! 🎉',[
   'Hi '+cap(name)+',',
   'Congratulations! You were picked as a winner in the Glow Lab giveaway.',
   ...prize.map(p=>p.name+' × '+p.quantity),
   'Your prize has been added free to your order '+o.id+', so it ships in the same box. You don’t need to do anything.',
   ...(note?[note]:[]),
   'What happens next: we pack your prize with your order and send you the tracking number as soon as it ships.'],
   url,'See your order',null,null,{eyebrow:'Glow Lab giveaway'})}}

function customerId(o){if(o.customer_id)return o.customer_id;try{const accounts=require('./customer-accounts.cjs');return accounts.hash(accounts.email(o.customer?.email||''))}catch{return ''}}

// Unseen wins for the account page pop-up.
async function unseen(s,cid){if(!cid)return[];return(await s.list('giveaway_wins')).filter(w=>w.customer_id===cid&&!w.seen_at).sort((a,b)=>a.created-b.created).map(w=>({id:w.id,order_id:w.order_id,prize:w.prize,note:w.note||'',created:w.created}))}

async function route(path,body,h,method){
 if(path==='/account/giveaway/seen'&&method==='POST'){const accounts=require('./customer-accounts.cjs');
  const out=await transaction(async s=>{const a=await accounts.session(s,h,true);const w=await s.get('giveaway_wins',String(body.id||'').slice(0,80));if(w&&w.customer_id===a.id&&!w.seen_at){w.seen_at=now();await s.put('giveaway_wins',w.id,w)}return{ok:true}});
  return{status:200,headers:{},body:out}}
 return null}

// Phone alert to every app this customer turned alerts on in (orders or deals; a win is about their own order).
async function push(cid,o,prize){if(!cid)return 0;try{const wp=require('./web-push.cjs');const r=await wp.sendTo('cust_push_subs',x=>x.customer_id===cid,{title:'🎉 You won the Glow Lab giveaway!',body:prizeText(prize)+' was added free to your order '+o.id+'.',url:'/store-next/account',tag:'win-'+o.id});return Array.isArray(r)?r.length:(r?.sent||0)}catch{return 0}}

module.exports={content,unseen,route,push,customerId,prizeText,hash};

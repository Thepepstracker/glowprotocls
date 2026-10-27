'use strict';
// Automatic invoices (Jonah, 24 Oct 2026). New Card / Cash App orders get a Stripe invoice the moment they are placed,
// delivered by email (Stripe sends it) or by text (Twilio sends the pay link), as the customer chose at checkout.
// The invoice only ever says "Glow Lab": no products, no order details. The order ID lives in hidden metadata.
// When Stripe reports the invoice paid, the order is re-checked against Stripe's API and then marked paid.
// Secrets live only in Netlify: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const fail=(m,extra={})=>{throw Object.assign(new Error(m),{status:502},extra)};
const METHODS=['card_invoice','cashapp']; // Venmo and Zelle are never invoiced
const LABEL='Glow Lab';

const stripeKey=()=>{const v=String(process.env.STRIPE_SECRET_KEY||'').trim();return /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(v)?v:''};
const twilio=()=>{const e=process.env;const sid=String(e.TWILIO_ACCOUNT_SID||'').trim(),tok=String(e.TWILIO_AUTH_TOKEN||'').trim(),from=String(e.TWILIO_FROM_NUMBER||'').trim();return /^AC[a-f0-9]{32}$/i.test(sid)&&tok.length>=16&&/^\+1\d{10}$/.test(from)?{sid,tok,from}:null};
function status(settings){const key=stripeKey();return{stripe:!!key,stripe_mode:key?(key.includes('_live_')?'live':'test'):null,webhook:String(process.env.STRIPE_WEBHOOK_SECRET||'').trim().startsWith('whsec_'),texting:!!twilio(),enabled:settings?.auto_invoice===true}}
// Is this order's payment method invoiced automatically right now?
const invoiced=(payment,settings)=>payment==='card_invoice'||(payment==='cashapp'&&settings?.auto_invoice===true&&!!stripeKey());
// Only orders placed after the switch was turned on: older orders may already have a hand-sent invoice.
const eligible=(o,settings,{force=false}={})=>!!o&&o.is_test===false&&settings?.auto_invoice===true&&!!stripeKey()&&METHODS.includes(o.payment_method)&&['order_received','awaiting_payment'].includes(o.status)&&o.total>=50&&(force||(o.created||0)>=(settings.auto_invoice_since||Infinity));

// ---- Stripe REST (form-encoded) ----
function form(obj,prefix='',out=[]){for(const[k,v]of Object.entries(obj)){if(v===undefined||v===null)continue;const key=prefix?prefix+'['+k+']':k;
 if(Array.isArray(v))v.forEach((x,i)=>typeof x==='object'?form(x,key+'['+i+']',out):out.push(encodeURIComponent(key+'[]')+'='+encodeURIComponent(x)));
 else if(typeof v==='object')form(v,key,out);else out.push(encodeURIComponent(key)+'='+encodeURIComponent(String(v)))}return out}
async function stripe(path,{method='GET',body=null,idem=''}={}){const key=stripeKey();if(!key)fail('STRIPE_SECRET_KEY is not saved in Netlify.');
 let r;try{r=await fetch('https://api.stripe.com/v1'+path,{method,headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded','Stripe-Version':'2024-06-20',...(idem?{'Idempotency-Key':idem}:{})},...(body?{body:form(body).join('&')}:{}),signal:AbortSignal.timeout(20000)})}catch(e){fail('Stripe could not be reached ('+String(e?.name||'error')+').',{uncertain:true})}
 let d=null;try{d=await r.json()}catch{}if(!r.ok)fail('Stripe: '+String(d?.error?.message||('HTTP '+r.status)).slice(0,200),{definite:r.status>=400&&r.status<500});return d}

// ---- Twilio ----
async function sendText(to,body){const t=twilio();if(!t)fail('Texting is not set up (TWILIO_* in Netlify).',{definite:true});
 const d=String(to||'').replace(/\D/g,'');const num=d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:'';if(!num)fail('No valid US mobile number on the order.',{definite:true});
 let r;try{r=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+t.sid+'/Messages.json',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(t.sid+':'+t.tok).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:num,From:t.from,Body:body}).toString(),signal:AbortSignal.timeout(15000)})}catch(e){fail('Twilio could not be reached.',{uncertain:true})}
 let j=null;try{j=await r.json()}catch{}if(!r.ok)fail('Text not sent: '+String(j?.message||('HTTP '+r.status)).slice(0,160),{definite:true});return{sid:String(j?.sid||''),to:num.slice(0,-4).replace(/\d/g,'•')+num.slice(-4)}}

// ---- Create + deliver one order's invoice. Safe to call more than once: a lease plus Stripe idempotency keys
// (order + revision) mean one order revision gets exactly one invoice. An edited total voids the old one first.
async function sendFor(id,{force=false}={}){
 const claim=await transaction(async s=>{const settings=await s.get('settings','main');const o=await s.get('orders',id);if(!eligible(o,settings,{force}))return null;
  const si=o.stripe_invoice;if(si&&si.revision===(o.revision||0)&&si.amount===o.total&&['open','paid','sending'].includes(si.status)&&!(si.status==='sending'&&si.lease_until<now()))return null;
  const resend=!!(si&&si.status==='resend'&&si.id&&si.revision===(o.revision||0)&&si.amount===o.total);
  const old=si&&si.id&&si.status==='open'&&(si.amount!==o.total||si.revision!==(o.revision||0))?si.id:null;
  o.stripe_invoice={...(si||{}),status:'sending',lease_until:now()+90,revision:o.revision||0,amount:o.total,tries:si&&si.revision===(o.revision||0)?si.tries||0:0};await s.put('orders',id,o);return{o,old,resend:resend?si.id:null}});
 if(!claim)return{status:'skipped'};const{o,old,resend}=claim;const rev=o.revision||0,c=o.customer||{},via=o.invoice_via==='text'?'text':'email';
 const save=async patch=>transaction(async s=>{const x=await s.get('orders',id);if(!x)return;x.stripe_invoice={...(x.stripe_invoice||{}),...patch};
  if(patch.status==='open'&&x.status==='order_received'){x.status='awaiting_payment';x.invoice_sent_at=now();x.invoice_sent_by='auto';x.expires=now()+7*86400;x.payment_window_days=7}await s.put('orders',id,x)});
 try{
  if(resend){const cur=await stripe('/invoices/'+resend);if(cur.status!=='open')fail('That invoice is '+cur.status+', not open.',{definite:true});return await deliver(cur,true)}
  if(old){try{await stripe('/invoices/'+old+'/void',{method:'POST',idem:'glp-void-'+old})}catch(e){if(!/void|status/i.test(e.message))throw e}}
  const email=String(c.email||'').trim().toLowerCase();if(!email)fail('The order has no email.',{definite:true});
  const found=await stripe('/customers?limit=1&email='+encodeURIComponent(email));
  const cust=found?.data?.[0]||await stripe('/customers',{method:'POST',idem:'glp-cust-'+crypto.createHash('sha256').update(email).digest('hex').slice(0,32),body:{email,name:String(c.name||'').slice(0,100),...(c.phone?{phone:String(c.phone).slice(0,20)}:{})}});
  const inv=await stripe('/invoices',{method:'POST',idem:'glp-inv-'+id+'-r'+rev,body:{customer:cust.id,collection_method:'send_invoice',days_until_due:7,auto_advance:'false',pending_invoice_items_behavior:'exclude',
   payment_settings:{payment_method_types:['card','cashapp']},metadata:{order_id:id,revision:String(rev),source:'glow-store'}}});
  await stripe('/invoiceitems',{method:'POST',idem:'glp-ii-'+id+'-r'+rev,body:{customer:cust.id,invoice:inv.id,amount:String(o.total),currency:'usd',description:LABEL}});
  const fin=inv.status==='draft'?await stripe('/invoices/'+inv.id+'/finalize',{method:'POST',idem:'glp-fin-'+inv.id,body:{auto_advance:'false'}}):inv;
  if(fin.amount_due!==o.total)fail('Stripe invoice total $'+(fin.amount_due/100).toFixed(2)+' does not match the order $'+(o.total/100).toFixed(2)+'.',{definite:true});
  return await deliver(fin,false);
  async function deliver(fin,again){let delivered=via,text=null,note='';
   if(via==='text'){try{text=await sendText(c.phone,'Glow Lab: your invoice for $'+(o.total/100).toFixed(2)+' is ready. Pay securely by card or Cash App: '+fin.hosted_invoice_url+' Reply STOP to opt out.')}
    catch(e){note=e.message+' Sent by email instead.';delivered='email'}}
   if(delivered==='email')await stripe('/invoices/'+fin.id+'/send',{method:'POST',idem:again?'':'glp-send-'+fin.id});
   await save({id:fin.id,number:fin.number||'',url:fin.hosted_invoice_url||'',status:'open',via:delivered,asked:via,sent_at:now(),text_sid:text?.sid||'',text_to:text?.to||'',note,lease_until:0,error:'',...(again?{resent_at:now()}:{})});
   return{status:again?'resent':'sent',via:delivered,note}}
 }catch(e){const tries=((o.stripe_invoice&&o.stripe_invoice.tries)||0)+1;await save({status:'failed',error:String(e.message).slice(0,200),lease_until:0,failed_at:now(),tries});return{status:'failed',message:e.message}}
}

// Every minute (shipping worker): retry invoices that failed to send, up to 5 tries, 2+ minutes apart.
async function retryFailed(limit=5){const ids=await transaction(async s=>{const settings=await s.get('settings','main');return (await (s.listLite?s.listLite('orders'):s.list('orders'))).filter(o=>eligible(o,settings)&&(!o.stripe_invoice||(o.stripe_invoice.status==='failed'&&(o.stripe_invoice.tries||0)<5&&now()-(o.stripe_invoice.failed_at||0)>120)||(o.stripe_invoice.status==='sending'&&o.stripe_invoice.lease_until<now()))&&now()-(o.created||0)>60).slice(0,limit).map(o=>o.id)});
 const out=[];for(const id of ids)out.push(await sendFor(id));return{processed:ids.length,out}}

// ---- Stripe webhook ----
// Header "t=<unix>,v1=<hex>": HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret; 5-minute tolerance.
function verify(raw,header,secret=process.env.STRIPE_WEBHOOK_SECRET,tolerance=300){secret=String(secret||'').trim();if(!secret.startsWith('whsec_'))return false;
 const parts={};for(const p of String(header||'').split(',')){const[k,v]=p.split('=');if(!k||!v)continue;(parts[k.trim()]=parts[k.trim()]||[]).push(v.trim())}
 const t=Number(parts.t?.[0]);if(!t||Math.abs(now()-t)>tolerance)return false;const want=crypto.createHmac('sha256',secret).update(t+'.'+raw).digest('hex');
 return (parts.v1||[]).some(v=>v.length===want.length&&crypto.timingSafeEqual(Buffer.from(v),Buffer.from(want)))}
// Mark an order paid only after Stripe's own API says this invoice is paid in full, in USD, for this order.
async function paidFromStripe(invoiceId,applyPaid){const inv=await stripe('/invoices/'+encodeURIComponent(String(invoiceId)));
 const id=inv?.metadata?.order_id;if(!id)return{status:'ignored',reason:'not a store invoice'};
 if(inv.status!=='paid'||inv.currency!=='usd')return{status:'ignored',reason:'invoice not paid'};
 const live=stripeKey().includes('_live_');if(inv.livemode!==live)return{status:'ignored',reason:'mode mismatch'};
 return transaction(async s=>{const o=await s.get('orders',id);if(!o)return{status:'ignored',reason:'order missing'};
  if(o.status==='paid'||o.status==='shipped'){if(o.payment_reference!==inv.id){o.stripe_invoice={...(o.stripe_invoice||{}),status:'paid_again',paid_at:now()};await s.put('orders',id,o);return{status:'review',order_id:id,reason:'order was already paid another way; check for a double payment'}}return{status:'already'}}
  if(!['order_received','awaiting_payment','payment_submitted'].includes(o.status))return{status:'review',order_id:id,reason:'order is '+o.status};
  if(inv.amount_paid<o.total){o.stripe_invoice={...(o.stripe_invoice||{}),status:'short',amount_paid:inv.amount_paid};await s.put('orders',id,o);return{status:'review',order_id:id,reason:'paid less than the order total'}}
  o.payment_reference=inv.id;o.stripe_invoice={...(o.stripe_invoice||{}),id:inv.id,status:'paid',paid_at:now(),amount_paid:inv.amount_paid};
  const job=await applyPaid(s,o,{by:'stripe',source:'stripe_invoice'});return{status:'paid',order_id:id,job}})}

// What the checkout page may know: is auto-invoicing live, and can it text.
const publicFlags=settings=>({auto_invoice:settings?.auto_invoice===true&&!!stripeKey(),invoice_text:settings?.auto_invoice===true&&!!stripeKey()&&!!twilio()});
module.exports={retryFailed,publicFlags,METHODS,LABEL,status,invoiced,eligible,sendFor,verify,paidFromStripe,sendText,_form:form};

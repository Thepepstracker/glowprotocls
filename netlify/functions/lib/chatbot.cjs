'use strict';
// Glow chat (Jonah, 25 Nov 2026: "we are creating a chat bot today"). A chat bubble on glowglps.com and in the Glow Lab app
// that answers shoppers with Claude: products and store questions, "where's my order" (order number + email), suggests
// products with an Add to bag button, and hands anything it can't answer to Jonah and Heather.
//   POST /chat                      {cid, messages:[{role,content}]} → {reply, products, handoff}
//   POST /chat/handoff              {name,email,question,cid} → straight to the team (no AI)
//   GET  /chat/status               → {on}
//   GET  /admin/chat                handed-off questions, recent chats, today's usage, on/off
//   POST /admin/chat/settings       {on}            owner switch
//   POST /admin/chat/handoff/done   {id, done}
// Needs ANTHROPIC_API_KEY on the server. CHAT_MODEL picks the model (default claude-sonnet-5-5). CHAT_DAILY_MAX caps
// replies per day (default 1500) so a flood can't run up the bill.
// Research-use rule: the bot never gives dosing, use, reconstitution-for-use or health advice; it says so and points to
// what it can help with. Order details are only shown when the order number AND the order email match.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {transaction}=require('./store-db.cjs');const brands=require('./brands.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const money=c=>'$'+(Math.round(c||0)/100).toFixed(2);
const etDay=t=>new Date(t*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const clientIp=h=>String(h['cf-connecting-ip']||h['x-nf-client-connection-ip']||h['x-forwarded-for']||h['x-real-ip']||'local').split(',')[0].trim();
const API='https://api.anthropic.com/v1/messages';
const MODEL=()=>String(process.env.CHAT_MODEL||'claude-sonnet-5-5').trim();
const DAILY_MAX=()=>Math.max(1,Number(process.env.CHAT_DAILY_MAX)||1500);
let fetchImpl=(...a)=>fetch(...a);
const HANDOFF_TEXT='I can pass your question to Heather and Jonah. Tap “Message the team” below and they will reply by email.';

// The site's own FAQ, as plain text, so the bot answers the same way the website does.
let FAQ=null;
function faqText(){if(FAQ!==null)return FAQ;try{const s=fs.readFileSync(path.resolve(__dirname,'../../../faq.html'),'utf8');
 FAQ=s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<header[\s\S]*?<\/header>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&[a-z#0-9]+;/gi,' ').replace(/\s+/g,' ').trim().slice(0,12000)}catch{FAQ=''}return FAQ}

const RULES=`You are "Glow", the shop helper on the Glow Lab Protocols website and app (glowglps.com). Glow Lab is a small family business in Ball Ground, Georgia, run by Heather and her son Jonah. Many customers are older and not comfortable with technology, and many come to you about an order.

HOW TO TALK (Jonah: "very warm and sweet, catered to help people that aren't tech savvy, professional when it needs to be")
- Be warm, sweet and patient, like a kind neighbor who works at the shop. Plain everyday words, short sentences, no jargon, no tables, no markdown headings. Usually 1-4 short sentences; use a short list only when it really helps.
- Help people who aren't comfortable with technology. Give one simple step at a time, and say exactly where to find things ("Your order number starts with GLP- and is at the top of your order email"). Never make anyone feel silly, and never rush them. If they seem stuck, offer to walk them through it.
- The little things matter. When they share their name, use their first name now and then (not in every message). When they say thank you, answer "My pleasure!" Thank them for shopping with a family business when it fits. Remember what they already told you in this chat and never ask for it twice. End with a gentle offer to help with anything else when the conversation is wrapping up.
- If something went wrong (a late package, a cracked vial, a payment problem), first say you're sorry it happened, then help right away.
- Be professional when it matters: complaints, payments, refunds, privacy, and the research-use rule. Stay calm, clear and kind, with no jokes and no emoji.
- No emoji, except at most one 💛 when saying thank you or goodbye.
- Never make up prices, stock, sizes, order details, policies or dates. For products use find_products. For an order use order_status. If you don't know, say so and offer to pass the question to the team.
- Tools answer instantly, so don't say "let me check" or "one moment". Write your whole answer in your final message, after any tool calls: answer every part of the question there.
- When you suggest or mention specific products the shopper might buy, call show_products with their ids so they get a card with an Add to bag button. Never more than 4.

RESEARCH-USE RULE (very important, never break it)
- Glow Lab peptides, nasal sprays and lab supplies are sold for research use only, not for human consumption. Never give dosing, amounts to take or inject, injection or nasal-spray use instructions, reconstitution amounts for use, cycles, stacking, protocols for a person, or what a product does in the body. Never make health, medical, weight-loss, anti-aging or treatment claims, and never compare products by effects.
- If asked, kindly say you can't help with dosing, use or health questions, and offer what you can do: product details and size, price, stock, storage, certificates of analysis (COA page), shipping, orders. Don't lecture. Don't suggest they ask a doctor about using a product.
- Glow topicals (Protocol 01, Protocol 02, Glow Eyes, Cu-Hair, Rose Recovery Mist) are cosmetic serums for external use only. You may describe them as cosmetics (skin care, external use, patch test recommended) and name their key ingredients, but make no medical or drug-like claims.
- Never discuss other brands, competitors, or where else to buy.

ORDERS AND PRIVACY
- If the shopper is signed in (see STORE FACTS), use my_account for their orders, points and level: no number or code needed.
- Otherwise there are two ways to find an order. Offer the easy one first:
  1. They know the order number (like GLP-6B78CCF0E8, on the order email or packing slip): ask for it and the email used on the order, then use order_status.
  2. They don't have the number: ask for the email they ordered with and use send_order_code. A 6-digit code goes to that email. Ask them to check their inbox (and spam folder) and type the code here, then use check_order_code. Never skip the code.
- Only share what the tools return. Never guess, and never say whether an email or order exists unless a tool shows it.
- Never ask for or accept card numbers, bank details, passwords or codes in chat. Payments happen on the order page or invoice, never in this chat.
- You cannot change, cancel, refund, re-ship or discount orders, and you cannot promise any of that. For those, wrong or missing items, damaged vials, payment problems, wholesale, affiliates or anything you can't answer: offer to hand it to the team. Ask for their name, email and the question, then call hand_off. After hand_off, tell them Heather or Jonah will reply by email.

SHOPPING HELP
- Help people find products by name, size and price. If something is sold out, say so and say they can tap "Notify me" on the product page.
- Don't invent discount codes. Mention only the sale and points information given below.
- When someone picks a product or asks what goes with it, you may use suggest_addons and offer at most 2 of its results in one friendly sentence ("Customers often add ..."), shown as cards with show_products. Never push, never repeat the offer, and never say what a research product does.
- Glow Points questions: signed-in shoppers get their real balance from my_account. Others: explain points from STORE FACTS and invite them to sign in at glowglps.com/store-next/account.`;

async function settingsOf(s){return (await s.get('settings','main'))||{}}
// Who sees the chat: 'off', 'staff' (only signed-in Glow Admin, for testing) or 'on' (everyone). Starts as 'staff'.
const MODES=['off','staff','on'];
async function chatSettings(s){const c=(await s.get('settings','chat'))||{id:'chat'};const mode=MODES.includes(c.mode)?c.mode:c.on===false?'off':c.on===true?'on':'staff';return{...c,mode}}
const openTo=(cs,staff)=>configured()&&(cs.mode==='on'||(cs.mode==='staff'&&staff));
const configured=()=>!!String(process.env.ANTHROPIC_API_KEY||'').trim();

function facts(settings,t=now()){
 const bf=settings.black_friday||{},bfOn=bf.on&&(!bf.end_at||bf.end_at>t)&&(!bf.start_at||bf.start_at<=t);
 const pay=Object.entries(settings.payment_links||{}).filter(([,v])=>v).map(([k])=>({venmo:'Venmo',cashapp:'Cash App',zelle:'Zelle',paypal:'PayPal',bitcoin:'Bitcoin'})[k]||k);
 const when=x=>new Date(x*1000).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'});
 return ['STORE FACTS (current)','- Today: '+new Date(t*1000).toLocaleString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' (Eastern time).',
  '- Shipping: '+money(settings.shipping_cents??1500)+' per order; free on orders of '+money(settings.free_shipping_cents??25000)+' or more. Orders ship with UPS (USPS for P.O. boxes). Tracking is emailed when the label is made.',
  '- Paying: at checkout customers can pay by card (a secure card invoice by email)'+(pay.length?' or with '+pay.join(', ')+' and then upload their payment screenshot':'')+'. An order is packed after payment is confirmed.',
  '- Glow Points: a free account earns points on products (1 point per $1, more at higher Glow Levels). Each point is worth 5 cents (100 points = $5 off). Account page: glowglps.com/store-next/account.',
  '- Subscribe & save: choose items to come every month at a discount; shown in the bag.',
  '- Gift lists: anyone can make a wish list and share it; friends buy from it and it ships to the list owner (glowglps.com/store-next/registry).',
  '- Certificates of analysis: glowglps.com/coa.html. FAQ: glowglps.com/faq.html. Email: support@glowglps.com.',
  bfOn?'- BLACK FRIDAY SALE is on until '+when(bf.end_at)+': Black Friday catalog items have special prices and most other items are 30% off. The prices find_products returns already include the sale. Codes can\'t be added on top of sale prices.':'- No store-wide sale is running right now.'].join('\n')}

function system(settings,customer){return [{type:'text',text:RULES+'\n\nTHE SITE\'S FAQ (use it for policy answers)\n'+faqText(),cache_control:{type:'ephemeral'}},{type:'text',text:facts(settings)+'\n'+(customer?'- This shopper is SIGNED IN as '+first(customer.name)+'. Greet them by first name once, and use my_account for their orders and points.':'- This shopper is not signed in.')}]}

const TOOLS=[
 {name:'find_products',description:'Search the Glow Lab store for products by name, ingredient or size. Returns id, name, size, current price, whether it is in stock, and the product page link.',input_schema:{type:'object',properties:{query:{type:'string',description:'What to look for, e.g. "BPC-157 10 mg", "nasal spray", "serum", "Little Bells"'}},required:['query']}},
 {name:'show_products',description:'Show product cards with an Add to bag button under your reply. Use ids from find_products. At most 4.',input_schema:{type:'object',properties:{product_ids:{type:'array',items:{type:'integer'},maxItems:4}},required:['product_ids']}},
 {name:'order_status',description:'Look up one order. Needs the order number and the email used on that order; both must match.',input_schema:{type:'object',properties:{order_number:{type:'string'},email:{type:'string'}},required:['order_number','email']}},
 {name:'my_account',description:'Only for a signed-in shopper: their first name, Glow Points available and what they are worth, Glow Level, and their recent orders with status and tracking.',input_schema:{type:'object',properties:{}}},
 {name:'send_order_code',description:'For a shopper who is not signed in and does not have their order number: emails a 6-digit code to the email they ordered with. Always answers the same way, whether or not that email has orders.',input_schema:{type:'object',properties:{email:{type:'string'}},required:['email']}},
 {name:'check_order_code',description:'Checks the 6-digit code the shopper typed (from send_order_code) and, if right, returns their recent orders with status and tracking.',input_schema:{type:'object',properties:{email:{type:'string'},code:{type:'string'}},required:['email','code']}},
 {name:'suggest_addons',description:'Products other customers bought together with the given products (from real orders). Use to offer a gentle add-on.',input_schema:{type:'object',properties:{product_ids:{type:'array',items:{type:'integer'},maxItems:4}},required:['product_ids']}},
 {name:'hand_off',description:'Send the shopper\'s question to Heather and Jonah, who reply by email. Use when you can\'t help or the shopper wants a person. Needs their name, email and the question in their words.',input_schema:{type:'object',properties:{name:{type:'string'},email:{type:'string'},question:{type:'string'}},required:['name','email','question']}}];

// ---------- tools ----------
const isEmail=e=>/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(String(e||'').trim());
const slugify=v=>String(v||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[’'+]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
const pageUrl=p=>'/store-next/p/'+(/^[a-z0-9-]{1,80}$/.test(String(p.slug||''))?p.slug:slugify(String(p.name||'').split(' · ')[0]));
async function shopProducts(s){const all=await s.list('products'),byId=new Map(all.map(p=>[p.id,p]));
 return all.filter(p=>p.active&&brands.productBrand(p)==='glow'&&!p.members_only).map(p=>{let stock=Math.floor(Math.max(0,p.stock||0)/brands.units(p));
  if(Array.isArray(p.components)&&p.components.length){stock=Infinity;for(const c of p.components){const x=byId.get(c.id);stock=Math.min(stock,x?Math.floor(Math.max(0,x.stock||0)/(c.qty||1)):0)}if(stock===Infinity)stock=0}
  return{id:p.id,name:p.name,size:p.size||'',price:p.price,regular:p.regular_price&&p.regular_price>p.price?p.regular_price:null,in_stock:stock>0,image:p.image||'',url:pageUrl(p),sku:p.sku||''}})}
function search(list,q){const words=String(q||'').toLowerCase().replace(/[^a-z0-9+. -]/g,' ').split(/\s+/).filter(w=>w.length>1&&!['the','and','for','with','what','have','you','your','do','any','a','some','got','need','want'].includes(w));
 if(!words.length)return[];const SYN={shirt:'tee',shirts:'tee','t-shirt':'tee',tshirt:'tee',spray:'nasal',sprays:'nasal',serums:'serum',kits:'kit',minis:'mini'};for(let i=0;i<words.length;i++)if(SYN[words[i]])words.push(SYN[words[i]]);const norm=x=>x.toLowerCase().replace(/[^a-z0-9]+/g,'');
 return list.map(p=>{const hay=(p.name+' '+p.size).toLowerCase(),toks=hay.split(/[^a-z0-9+.]+/).filter(Boolean),flat=norm(hay+' '+p.sku);let sc=0;
  for(const w of words){const wn=norm(w);if(toks.includes(w))sc+=3;else if(toks.some(t=>t.startsWith(w)))sc+=1.5;else if(wn&&flat.includes(wn))sc+=1}
  if(sc&&hay.startsWith(words[0]))sc+=1;if(sc&&/kit of 10/i.test(p.name)&&!words.includes('kit'))sc-=0.5;if(sc&&/(tote|tee|pouch|hoodie|hat|mug|bag)\b/i.test(p.name)&&!words.some(w=>/tote|tee|shirt|pouch|merch|hoodie|hat|mug|bag/.test(w)))sc-=1.5;if(sc&&p.in_stock)sc+=0.25;
  return{p,sc}}).filter(x=>x.sc>0).sort((a,b)=>b.sc-a.sc||a.p.name.localeCompare(b.p.name)).slice(0,10).map(x=>x.p)}
const STATUS={order_received:'Waiting for payment',awaiting_payment:'Waiting for payment (an invoice was sent)',payment_submitted:'Payment screenshot received; the team is checking it',paid:'Paid and in line to be packed',shipped:'Shipped',canceled:'Canceled',expired:'Closed (it was never paid)'};
function orderView(o){const sh=o.shipment||{},d=o.delivery||{},t=o.track||{},st=d.state||t.state||'';
 const out={order_number:o.id,status:STATUS[o.status]||o.status,placed:etDay(o.created||0),total:money(o.total),items:(o.items||[]).map(i=>i.quantity+' × '+i.name)};
 if(['order_received','awaiting_payment'].includes(o.status))out.note='Pay with the link in the order email or on the order page. If they already paid, they should not pay again; the team can check.';
 if(o.status==='shipped'){const inPerson=sh.carrier==='in_person';out.shipping=inPerson?'Handed over in person':d.delivered||st==='delivered'?'Delivered'+(d.delivered_at?' on '+etDay(d.delivered_at):''):st==='out_for_delivery'?'Out for delivery today':(d.first_scan_at||t.first_scan_at||st==='in_transit')?'On the way':'Label created; waiting for the carrier to scan it';
  if(!inPerson&&(o.tracking||sh.tracking)){const n=String(o.tracking||sh.tracking).replace(/\s+/g,''),usps=/^(9\d{15,25}|[A-Z]{2}\d{9}US)$/.test(n);out.carrier=usps?'USPS':'UPS';out.tracking_number=n;out.tracking_link=usps?'https://tools.usps.com/go/TrackConfirmAction?tLabels='+n:'https://www.ups.com/track?loc=en_US&tracknum='+n}
  if(d.scheduled_date)out.expected_delivery=d.scheduled_date}
 if(o.hold&&Array.isArray(o.hold.lines)&&o.hold.lines.length)out.coming_separately='Some items are on the way to us and will ship on their own.';
 return out}
async function rate(kind,key,limit,seconds){return transaction(async s=>{const k=hash('chat:'+kind+':'+key),old=await s.get('customer_limits',k),r=old?.until>now()?old:{count:0,until:now()+seconds};if(r.count>=limit)return false;r.count++;await s.put('customer_limits',k,r);return true})}

async function runTool(name,input,ctx){input=input&&typeof input==='object'?input:{};
 if(name==='find_products'){const list=await transaction(shopProducts);const hits=search(list,String(input.query||'').slice(0,80));ctx.seen.push(...hits);
  return hits.length?{products:hits.map(p=>({id:p.id,name:p.name,price:money(p.price),...(p.regular?{was:money(p.regular)}:{}),in_stock:p.in_stock,page:'https://glowglps.com'+p.url}))}:{products:[],note:'Nothing matched. Try another word, or browse glowglps.com/store-next/.'}}
 if(name==='show_products'){const ids=(Array.isArray(input.product_ids)?input.product_ids:[]).map(Number).filter(Number.isSafeInteger).slice(0,4);
  const list=await transaction(shopProducts),byId=new Map(list.map(p=>[p.id,p]));for(const id of ids)if(byId.has(id)&&!ctx.show.some(p=>p.id===id))ctx.show.push(byId.get(id));ctx.show=ctx.show.slice(0,4);return{shown:ctx.show.map(p=>p.name)}}
 if(name==='order_status'){if(!await rate('order',ctx.ip,8,3600))return{error:'Too many order lookups from here. Please try again in an hour, or email support@glowglps.com.'};
  let n=String(input.order_number||'').toUpperCase().replace(/[^A-Z0-9-]/g,'');if(/^[0-9A-F]{10}$/.test(n))n='GLP-'+n;const email=String(input.email||'').trim().toLowerCase();
  const none={found:false,message:'No order matches that order number and email. Check the order number on the order email or packing slip, and use the email the order was placed with.'};
  if(!/^[A-Z]{2,5}-[0-9A-F]{10}$/.test(n)||!isEmail(email))return none;
  const o=await transaction(s=>s.get('orders',n));if(!o||o.is_test!==false||String(o.customer?.email||'').trim().toLowerCase()!==email||brands.orderBrand(o).id!=='glow')return none;
  ctx.order=o.id;return{found:true,...orderView(o)}}

 if(name==='my_account'){const c=ctx.customer;if(!c)return{signed_in:false,note:'Not signed in. Offer order number + email, or the email code, or signing in at glowglps.com/store-next/account.'};
  return transaction(async s=>{const acc=require('./customer-accounts.cjs'),lv=require('./glow-levels.cjs');const w=acc.publicWallet(await acc.wallet(s,c.id));let level=null;try{const L=await lv.levelOf(s,c.id);level={name:L.tier.name,...(L.next?{next_level:L.next.name,points_to_next_level:L.next.needed_points}:{})}}catch{}
   const orders=(await s.list('orders')).filter(o=>o.customer_id===c.id&&o.is_test===false&&brands.orderBrand(o).id==='glow').sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,5).map(orderView);
   return{signed_in:true,first_name:first(c.name),points_available:w.available,points_worth:money(w.value_cents),glow_level:level,recent_orders:orders}})}
 if(name==='send_order_code'){if(!ctx.cid)return{error:'Please refresh the page and try again.'};const email=String(input.email||'').trim().toLowerCase();if(!isEmail(email))return{error:'That email does not look complete. Ask them to type it again.'};
  if(!await rate('code-ip',ctx.ip,5,3600)||!await rate('code-email',email,3,3600))return{error:'Too many codes were asked for. Please try again in an hour, or email support@glowglps.com.'};
  const sent={sent:true,message:'If that email has orders with us, a 6-digit code is on its way. It works for 15 minutes. Ask them to check their inbox and spam folder, then type the code here.'};
  const has=await transaction(async s=>(await s.list('orders')).some(o=>o.is_test===false&&String(o.customer?.email||'').trim().toLowerCase()===email&&brands.orderBrand(o).id==='glow'));if(!has)return sent;
  const code=makeCode(),key=hash('chat-code:'+ctx.cid+':'+email);await transaction(s=>s.put('chat_codes',key,{id:key,code:hash('code:'+code),expires:now()+900,tries:0,created:now()}));
  const ok=await sendMail(email,code).catch(()=>false);return ok?sent:{error:'The code email could not be sent right now. Offer the order number + email way, or a person.'}}
 if(name==='check_order_code'){const email=String(input.email||'').trim().toLowerCase(),code=String(input.code||'').replace(/\D/g,'');if(!ctx.cid||!isEmail(email))return{found:false,message:'Ask for the email again.'};
  const key=hash('chat-code:'+ctx.cid+':'+email);const r=await transaction(async s=>{const c=await s.get('chat_codes',key);if(!c||c.expires<now())return'expired';if(c.verified_until>now())return'ok';if(c.tries>=5)return'locked';
   if(code.length===6&&crypto.timingSafeEqual(Buffer.from(hash('code:'+code)),Buffer.from(c.code))){c.verified_until=now()+1800;await s.put('chat_codes',key,c);return'ok'}c.tries++;await s.put('chat_codes',key,c);return c.tries>=5?'locked':'wrong'});
  if(r==='expired')return{found:false,message:'That code has expired or was never sent. Offer to send a new one.'};
  if(r==='locked')return{found:false,message:'Too many wrong tries. Offer to send a new code in a little while, or a person.'};
  if(r==='wrong')return{found:false,message:'That code is not right. Ask them to check the newest email from Glow Lab and type the 6 numbers again.'};
  const orders=await transaction(async s=>(await s.list('orders')).filter(o=>o.is_test===false&&String(o.customer?.email||'').trim().toLowerCase()===email&&brands.orderBrand(o).id==='glow').sort((a,b)=>(b.created||0)-(a.created||0)).slice(0,5).map(orderView));
  if(orders[0])ctx.order=orders[0].order_number;return{found:true,recent_orders:orders}}
 if(name==='suggest_addons'){const ids=(Array.isArray(input.product_ids)?input.product_ids:[]).map(Number).filter(Number.isSafeInteger).slice(0,4);if(!ids.length)return{products:[]};
  const rel=await transaction(s=>require('./shop-extras.cjs').related(s,{ids,brand:'glow',limit:3})),list=await transaction(shopProducts),byId=new Map(list.map(p=>[p.id,p]));
  const out=rel.map(r=>byId.get(r.id)).filter(p=>p&&p.in_stock).map(p=>({id:p.id,name:p.name,price:money(p.price),why:'often bought together'}));ctx.seen.push(...out.map(x=>byId.get(x.id)));return{products:out}}
 if(name==='hand_off'){const nm=String(input.name||'').trim().slice(0,80),email=String(input.email||'').trim().toLowerCase().slice(0,200),q=String(input.question||'').trim().slice(0,1500);
  if(!nm||!isEmail(email)||!q)return{error:'I need the shopper\'s name, a valid email and their question.'};
  if(ctx.handoff)return{ok:true,already:true,ticket:ctx.handoff.id};
  if(!await rate('handoff',ctx.ip,4,3600))return{error:'Too many messages from here today. Please email support@glowglps.com.'};
  const rec={id:'ch-'+crypto.randomBytes(5).toString('hex'),created:now(),name:nm,email,question:q,status:'open',cid:ctx.cid||'',order:ctx.order||'',transcript:ctx.history.slice(-12).map(m=>({role:m.role,text:String(m.content).slice(0,600)}))};
  await transaction(s=>s.put('chat_handoffs',rec.id,rec));ctx.handoff=rec;await alertStaff(rec).catch(()=>{});return{ok:true,ticket:rec.id}}
 return{error:'Unknown tool.'}}

const first=n=>String(n||'').trim().split(/\s+/)[0].slice(0,40);
let sendMail=(...a)=>mailCode(...a);
let makeCode=()=>String(crypto.randomInt(0,1000000)).padStart(6,'0');
async function mailCode(email,code){const emails=require('./store-email.cjs');
 const id=await transaction(s=>emails.enqueue(s,{id:'chat-code-'+hash(email+':'+code+':'+now()).slice(0,24),kind:'chat_order_code',brand:'glow',to:email,related_id:'chat',expires:now()+900,subject:'Your Glow Lab code: '+code,
  content:emails.template('Your code is '+code,['You asked our website chat to look up your orders. Type this code in the chat:',code,'It works for 15 minutes. If you did not ask for it, you can ignore this email. Nobody can see your orders without it.'],null,null)}));
 if(!id)return false;const r=await emails.safeDispatch(id);return !r||r.status!=='retry'}
async function alertStaff(rec){const emails=require('./store-email.cjs');
 const lines=['A shopper asked the website chat for a person.','Name: '+rec.name,'Email: '+rec.email,'Question: '+rec.question,...(rec.order?['Order: '+rec.order]:[]),'','Reply to them by email. Mark it done in Glow Admin → More → Chat.'];
 const ids=await transaction(async s=>{const out=[];for(const to of emails.alertRecipients())out.push(await emails.enqueue(s,{id:'chat-handoff-'+rec.id+'-'+hash(to).slice(0,8),kind:'staff_chat_handoff',brand:'glow',to,related_id:rec.id,expires:now()+86400,subject:'💬 Chat question from '+rec.name,content:emails.template('Chat question from '+rec.name,lines,'mailto:'+rec.email+'?subject='+encodeURIComponent('Your question to Glow Lab'),'Reply to '+rec.name)}));return out.filter(Boolean)});
 for(const id of ids)await emails.safeDispatch(id);
 try{await require('./web-push.cjs').sendAll({title:'💬 Chat question',body:rec.name+': '+rec.question.slice(0,110),url:'/store-next/admin#chat',tag:rec.id})}catch{}}

// ---------- Claude ----------
async function callClaude(sys,messages){const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),30000);
 try{const r=await fetchImpl(API,{method:'POST',signal:ctl.signal,headers:{'content-type':'application/json','x-api-key':String(process.env.ANTHROPIC_API_KEY).trim(),'anthropic-version':'2023-06-01'},body:JSON.stringify({model:MODEL(),max_tokens:700,system:sys,tools:TOOLS,messages})});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j?.error?.message||('Claude API '+r.status)),{api:r.status});return j}finally{clearTimeout(timer)}}

function cleanHistory(raw){if(!Array.isArray(raw))bad('Invalid chat.');const m=raw.slice(-20).map(x=>({role:x&&x.role==='assistant'?'assistant':'user',content:String(x&&x.content||'').trim().slice(0,1500)})).filter(x=>x.content);
 while(m.length&&m[0].role!=='user')m.shift();const out=[];for(const x of m){if(out.length&&out[out.length-1].role===x.role)out[out.length-1].content+='\n'+x.content;else out.push(x)}
 if(!out.length||out[out.length-1].role!=='user')bad('Type a message first.');return out}
const pub=p=>({id:p.id,name:p.name,size:p.size,price:p.price,regular:p.regular,in_stock:p.in_stock,image:p.image,url:p.url});

async function chat(body,h,staff,customer){const ip=clientIp(h),cid=/^[a-z0-9]{12,40}$/.test(String(body.cid||''))?String(body.cid):'';
 const history=cleanHistory(body.messages);
 const {settings,cs}=await transaction(async s=>({settings:await settingsOf(s),cs:await chatSettings(s)}));
 if(!openTo(cs,staff))return{reply:'The chat helper is resting right now. '+HANDOFF_TEXT,products:[],offer_handoff:true,off:true};
 if(!await rate('msg',ip,40,3600))return{reply:'You\'ve sent a lot of messages in a short time. Please try again a little later, or email support@glowglps.com.',products:[],offer_handoff:true};
 const day=etDay(now()),usage=await transaction(async s=>{const u=(await s.get('chat_usage',day))||{id:day,replies:0,input:0,output:0,cache_read:0,handoffs:0};if(u.replies>=DAILY_MAX())return null;u.replies++;await s.put('chat_usage',day,u);return u});
 if(!usage)return{reply:'The chat is very busy today. '+HANDOFF_TEXT,products:[],offer_handoff:true};
 const ctx={ip,cid,history,seen:[],show:[],order:'',handoff:null,customer:customer||null},sys=system(settings,customer),msgs=history.map(x=>({role:x.role,content:x.content}));
 let reply='',parts=[],tokens={input:0,output:0,cache_read:0};
 try{for(let i=0;i<6;i++){const r=await callClaude(sys,msgs);const u=r.usage||{};tokens.input+=(u.input_tokens||0)+(u.cache_creation_input_tokens||0);tokens.output+=u.output_tokens||0;tokens.cache_read+=u.cache_read_input_tokens||0;
   const content=Array.isArray(r.content)?r.content:[];msgs.push({role:'assistant',content});
   // Claude often writes the answer next to a tool call, then only a short wrap-up at the end: keep every part.
   const said=content.filter(b=>b.type==='text').map(b=>b.text.trim()).filter(Boolean).join('\n');const kept=r.stop_reason==='tool_use'?said.replace(/(^|\n|(?<=[.!?])\s+)(let me|i'll|i will|one moment|give me a (sec|second|moment)|checking|looking)\b[^.!?\n]*[.!?…]*/gi,' ').replace(/\s{2,}/g,' ').trim():said;if(kept)parts.push(kept);
   if(r.stop_reason!=='tool_use'){reply=parts.join('\n\n').trim();break}
   const results=[];for(const b of content.filter(b=>b.type==='tool_use')){let out;try{out=await runTool(b.name,b.input,ctx)}catch(e){out={error:'That did not work. '+String(e.message||'').slice(0,120)}}results.push({type:'tool_result',tool_use_id:b.id,content:JSON.stringify(out)})}
   msgs.push({role:'user',content:results})}}
 catch(e){const why=(e.api?'Claude API '+e.api+': ':'')+String(e.name==='AbortError'?'took too long':e.message||'error').replace(/sk-ant-[\w-]+/g,'[key]').slice(0,240);console.error('[chat] '+why);await saveLog(ctx,cid,ip,history,'',why).catch(()=>{});return{reply:'Sorry, I couldn\'t answer just now. Please try again in a moment. '+HANDOFF_TEXT,products:[],offer_handoff:true}}
 if(!reply)reply='Sorry, I got stuck on that one. '+HANDOFF_TEXT;
 await transaction(async s=>{const u=(await s.get('chat_usage',day))||usage;u.input+=tokens.input;u.output+=tokens.output;u.cache_read+=tokens.cache_read;if(ctx.handoff)u.handoffs=(u.handoffs||0)+1;await s.put('chat_usage',day,u)});
 await saveLog(ctx,cid,ip,history,reply).catch(()=>{});
 return{reply,products:ctx.show.map(pub),...(ctx.handoff?{handoff:{id:ctx.handoff.id}}:{})}}

// One record per conversation, so the team can read what shoppers ask. Kept 30 days.
async function saveLog(ctx,cid,ip,history,reply,error){if(!cid)return;await transaction(async s=>{const id='c-'+cid,old=await s.get('chat_logs',id),t=now();
 const msgs=history.map(m=>({role:m.role,text:m.content.slice(0,1500)}));if(reply)msgs.push({role:'assistant',text:reply.slice(0,2000)});
 await s.put('chat_logs',id,{id,created:old?.created||t,updated:t,ip:hash(ip).slice(0,16),messages:msgs.slice(-40),products:ctx.show.map(p=>p.name),order:ctx.order||old?.order||'',handoff:ctx.handoff?.id||old?.handoff||'',...(error?{error}:{})});
 if(Math.random()<0.05){for(const l of await s.list('chat_logs'))if((l.updated||0)<t-30*86400)await s.remove('chat_logs',l.id)}})}

async function adminView(s){const day=etDay(now()),usage=(await s.get('chat_usage',day))||{replies:0,input:0,output:0,cache_read:0,handoffs:0};
 const handoffs=(await s.list('chat_handoffs')).sort((a,b)=>b.created-a.created).slice(0,100);
 const chats=(await s.list('chat_logs')).sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,60).map(l=>({id:l.id,updated:l.updated,first:(l.messages.find(m=>m.role==='user')||{}).text?.slice(0,140)||'',turns:l.messages.filter(m=>m.role==='user').length,order:l.order||'',handoff:l.handoff||'',error:l.error||'',messages:l.messages}));
 const cs=await chatSettings(s);return{on:cs.mode==='on',mode:cs.mode,configured:configured(),model:MODEL(),daily_max:DAILY_MAX(),usage,handoffs,chats}}

async function shopper(h){try{const a=await transaction(s=>require('./customer-accounts.cjs').session(s,h));return a?{id:a.id,name:a.name||'',email:a.email||''}:null}catch{return null}}
async function isStaff(h,session){try{return !!(await transaction(s=>session(s,h)))}catch{return false}}
async function route(path,body,h,method,{session}){
 if(path==='/chat/status'&&method==='GET'){if(brands.fromHeaders(h).id!=='glow')return{status:200,headers:{},body:{on:false}};const cs=await transaction(chatSettings),staff=cs.mode==='staff'&&await isStaff(h,session);return{status:200,headers:{'Cache-Control':'no-store'},body:{on:openTo(cs,staff),...(cs.mode==='staff'&&staff&&configured()?{preview:true}:{})}}}
 // "Message the team" form in the bubble: goes straight to the team, no AI needed.
 if(path==='/chat/handoff'&&method==='POST'){if(brands.fromHeaders(h).id!=='glow')bad('Not found.',404);let history=[];try{history=cleanHistory([...(Array.isArray(body.messages)?body.messages:[]),{role:'user',content:String(body.question||'')}])}catch{}
  const ctx={ip:clientIp(h),cid:/^[a-z0-9]{12,40}$/.test(String(body.cid||''))?String(body.cid):'',history,seen:[],show:[],order:'',handoff:null};
  const out=await runTool('hand_off',{name:body.name,email:body.email,question:body.question},ctx);if(out.error)bad(out.error,out.error.startsWith('Too many')?429:400);
  if(ctx.handoff)await transaction(async s=>{const day=etDay(now()),u=(await s.get('chat_usage',day))||{id:day,replies:0,input:0,output:0,cache_read:0,handoffs:0};u.handoffs=(u.handoffs||0)+1;await s.put('chat_usage',day,u)});
  return{status:200,headers:{},body:{ok:true,ticket:out.ticket}}}
 if(path==='/chat'&&method==='POST'){if(brands.fromHeaders(h).id!=='glow')bad('Not found.',404);return{status:200,headers:{'Cache-Control':'no-store'},body:await chat(body,h,await isStaff(h,session),await shopper(h))}}
 if(!path.startsWith('/admin/chat'))return null;
 return transaction(async s=>{const sid=await session(s,h);
  if(path==='/admin/chat'&&method==='GET')return{status:200,headers:{},body:await adminView(s)};
  if(path==='/admin/chat/settings'&&method==='POST'){const rec=await s.get('sessions',sid);if(rec?.staff_id)bad('Only the owner can switch the chat on or off.',403);const mode=MODES.includes(body.mode)?body.mode:typeof body.on==='boolean'?(body.on?'on':'off'):'';if(!mode)bad('Choose Off, Team only or Everyone.');await s.put('settings','chat',{id:'chat',mode,changed:now()});return{status:200,headers:{},body:{ok:true,mode,on:mode==='on'}}}
  if(path==='/admin/chat/handoff/done'&&method==='POST'){const r=await s.get('chat_handoffs',String(body.id||'').slice(0,40));if(!r)bad('Question not found.',404);r.status=body.done===false?'open':'done';r.done_at=r.status==='done'?now():null;r.done_by=(await s.get('sessions',sid))?.staff_id||'owner';await s.put('chat_handoffs',r.id,r);return{status:200,headers:{},body:{ok:true,handoff:r}}}
  return null})}

module.exports={route,chat,runTool,search,facts,RULES,TOOLS,cleanHistory,orderView,_setFetch:f=>{fetchImpl=f},_setCode:f=>{makeCode=f},_setMail:f=>{sendMail=f}};

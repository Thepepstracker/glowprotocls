'use strict';
// Mystery gift on the packing slip (Jonah, 18 Nov 2026: "lets make the qr codes good for when they receive their package on
// the packing slip ... more points or something super dope" → "mystery gift box is exactly it"; guests: "scanning it makes the
// app appear on the phone").
// Every Glow 4x6 slip gets its own QR: /store-next/unbox/<order id>.<12-character signature>. The signature is an HMAC of the
// order id with the store's session secret, so a code can't be guessed or made for another order. Scanning shows a gift box;
// opening it works ONCE per order. The prize is drawn here on the server, never in the browser:
//   50 points (75%) · 100 points (20%) · 250 points (5%)  → about 70 points ($3.50) per box on average.
// Who gets it: the order's account; for a gift-list order, the list owner (they hold the box). A guest's prize is held on the
// order and added when they make (or verify) a Glow account with the order email, the same way their order points are.
// Bonus points don't count toward Glow levels (kind 'unbox_bonus' is not an earning kind). A full refund takes them back.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const PRIZES=[[75,50],[20,100],[5,250]];
const TOKEN=/^((?:GLP)-[A-F0-9]{10})\.([A-Za-z0-9_-]{12})$/;
function secret(){const s=process.env.STORE_SESSION_SECRET||'';if(s.length<32)bad('Mystery gifts are not set up yet.',503);return s}
function sig(id){return crypto.createHmac('sha256',secret()).update('unbox:'+id).digest('base64url').slice(0,12)}
// The slip's code for an order (Management only). Glow orders only: Zader and Pep Puppy have no Glow Points.
function key(o){if(!o||!/^GLP-[A-F0-9]{10}$/.test(String(o.id||''))||(o.brand&&o.brand!=='glow'))return null;try{return o.id+'.'+sig(o.id)}catch{return null}}
function parse(token){const m=TOKEN.exec(String(token||''));if(!m)return null;const want=Buffer.from(sig(m[1])),got=Buffer.from(m[2]);return want.length===got.length&&crypto.timingSafeEqual(want,got)?m[1]:null}
function draw(){const r=crypto.randomInt(100);let acc=0;for(const [pct,pts] of PRIZES){acc+=pct;if(r<acc)return pts}return PRIZES[0][1]}
const open_=o=>['paid','shipped'].includes(o.status)&&!o.refund_due_cents;
const firstOf=n=>{const f=String(n||'').trim().split(/\s+/)[0]||'';return f?f.charAt(0).toUpperCase()+f.slice(1).toLowerCase():'friend'};
function maskEmail(e){const [u,d]=String(e||'').split('@');if(!u||!d)return '';return u.slice(0,1)+'•••'+(u.length>2?u.slice(-1):'')+'@'+d}
// Whose account the prize belongs to, if they have one.
function recipientId(o){return o.gift?.owner_id||o.customer_id||null}
async function view(s,o){const accounts=require('./customer-accounts.cjs');const u=o.unbox||null,rid=recipientId(o),a=rid?await s.get('customers',rid):null;
 const first=o.gift?(o.gift.to_first||firstOf(o.gift.to_name)):firstOf(o.customer?.name);
 const state=u?'opened':open_(o)?'ready':'locked';
 const out={state,first,is_test:o.is_test!==false,has_account:!!a?.verified,...(u?{prize:u.prize,value_cents:u.prize*5,credited:!!u.credited_to,held:!!u.held}:{})};
 if(!a?.verified&&!o.gift){out.email_hint=maskEmail(o.customer?.email);out.order_points=Math.max(0,Math.floor(((o.subtotal||0)-(o.discount||0))/100))}
 if(u?.credited_to&&a){try{out.balance=accounts.publicWallet(await accounts.wallet(s,a.id)).available}catch{}}
 return out}
async function credit(s,o,id){const accounts=require('./customer-accounts.cjs');if(await accounts.event(s,id,'unbox:'+o.id,'unbox_bonus',o.unbox.prize,0,o.id,'Mystery gift from your packing slip 🎁')){o.unbox.credited_to=id;o.unbox.credited_at=now();delete o.unbox.held}}
async function open(s,o){if(o.unbox)return;if(!open_(o))bad('This gift unlocks once your order has shipped.',409);
 o.unbox={prize:draw(),opened_at:now()};
 if(o.is_test!==false){o.unbox.preview=true;return}
 const rid=recipientId(o),a=rid?await s.get('customers',rid):null;
 if(a?.verified)await credit(s,o,a.id);else o.unbox.held=true}
// Called when an account is loaded (after its guest orders are claimed): add any prize a guest opened before signing up.
async function claimHeld(s,a){if(!a?.verified)return 0;let n=0;for(const o of await s.list('orders')){if(!o.unbox?.held||o.unbox.credited_to||o.is_test!==false||o.gift)continue;if(o.customer_id!==a.id)continue;await credit(s,o,a.id);await s.put('orders',o.id,o);n++}return n}
// A full refund takes the bonus back (refunds.cjs).
async function takeBack(s,o,event,why){const u=o.unbox;if(!u?.credited_to||u.taken_back)return;await event(s,u.credited_to,'unbox-undo:'+o.id,'order_adjustment',-u.prize,0,o.id,why);u.taken_back=now()}
async function route(path,body,h,method){const m=path.match(/^\/unbox\/([A-Za-z0-9._-]{10,40})(\/open)?$/);if(!m)return null;
 const id=parse(m[1]);if(!id)bad('This gift code isn’t valid. Check the QR code on your packing slip.',404);
 if(method==='GET'&&!m[2]){const out=await transaction(async s=>{const o=await s.get('orders',id);if(!o)bad('Order not found.',404);return view(s,o)});return{status:200,headers:{'cache-control':'no-store'},body:out}}
 if(method==='POST'&&m[2]){const out=await transaction(async s=>{const o=await s.get('orders',id);if(!o)bad('Order not found.',404);await open(s,o);await s.put('orders',o.id,o);return view(s,o)});return{status:200,headers:{'cache-control':'no-store'},body:out}}
 bad('Method not allowed.',405)}
module.exports={route,key,parse,draw,open,view,claimHeld,takeBack,PRIZES};

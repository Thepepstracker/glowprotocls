'use strict';
// Gift lists (Jonah, 18 Nov 2026: "a gift registry ... for the customers to make their own registries and share them").
// Jonah's choices:
//   - the gift ships to the list owner. The buyer never sees the owner's street or ZIP: only first name, city and state;
//   - mainly for the holidays / Christmas;
//   - the buyer can add a gift message, printed on the packing slip;
//   - thank-you points: the owner earns 1 Glow Point per $1 of gifts once a gift order is paid (taken back if it is
//     marked unpaid by mistake or refunded in full).
// A list belongs to a signed-in, verified customer. Its link is /store-next/registry/<slug>. Only products on the list
// can go in a gift order, and the shipping address is filled in here on the server, never by the buyer's browser.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const clean=(v,max)=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const OCCASIONS={christmas:'Christmas',holidays:'The holidays',birthday:'Birthday',other:'Just because'};
const STATES=/^(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|AS|GU|MP|PR|VI|AA|AE|AP)$/;
const MAX_LISTS=5,MAX_ITEMS=40,MESSAGE_MAX=300;
// Orders that count against a list: still open or paid. Cancelled, expired and refunded ones free the item again.
const COUNTS=['order_received','awaiting_payment','payment_submitted','paid','shipped'];
const firstOf=n=>{const f=clean(n,100).split(' ')[0]||'';return f?f.charAt(0).toUpperCase()+f.slice(1):'Your friend'};
const slugOk=v=>/^[a-z0-9]{10}$/.test(String(v||''));

function shipTo(b){const a=b&&typeof b==='object'?b:{},t={name:clean(a.name,100),address:clean(a.address,200),city:clean(a.city,80),state:clean(a.state,2).toUpperCase(),zip:clean(a.zip,10)};
 if(!t.name||!t.address||!t.city)bad('Add the name, street and city the gifts ship to.');if(!STATES.test(t.state))bad('Enter a two-letter state code.');if(!/^\d{5}(-\d{4})?$/.test(t.zip))bad('Enter a five-digit ZIP code.');return t}
function itemsIn(list,products){if(!Array.isArray(list))return [];const seen=new Set(),out=[];for(const x of list.slice(0,MAX_ITEMS)){const id=Number(x?.id),want=Math.max(1,Math.min(20,Math.floor(Number(x?.want)||1)));
 if(!Number.isSafeInteger(id)||seen.has(id))continue;const p=products.get(id);if(!p||!p.active)continue;seen.add(id);out.push({id,want})}return out}
async function productMap(s){const m=new Map();for(const p of await s.list('products'))m.set(p.id,p);return m}
async function giftedCounts(s,regId){const n=new Map();for(const o of await s.list('orders')){if(o.gift?.registry_id!==regId||!COUNTS.includes(o.status))continue;for(const i of o.items||[])n.set(i.id,(n.get(i.id)||0)+Number(i.quantity||0))}return n}
async function owned(s,a,id){const r=await s.get('registries',String(id||''));if(!r||r.owner_id!==a.id)bad('Gift list not found.',404);return r}
// What the owner sees: everything, including the address and how many of each were gifted.
async function ownerView(s,r){const n=await giftedCounts(s,r.id);return{id:r.id,title:r.title,occasion:r.occasion,note:r.note,ship_to:r.ship_to,closed:!!r.closed,created:r.created,updated:r.updated,thanks_points:r.thanks_points||0,items:r.items.map(i=>({...i,gifted:n.get(i.id)||0}))}}
// What anyone with the link sees: first name, city and state. Never the street, ZIP, email or full name.
async function publicView(s,r){const n=await giftedCounts(s,r.id);return{id:r.id,title:r.title,occasion:r.occasion,occasion_name:OCCASIONS[r.occasion]||'',note:r.note,closed:!!r.closed,owner_first:firstOf(r.ship_to?.name||r.owner_name),city:r.ship_to?.city||'',state:r.ship_to?.state||'',items:r.items.map(i=>({id:i.id,want:i.want,gifted:n.get(i.id)||0}))}}

async function save(s,a,b){if(!a.verified)bad('Confirm your email first, then make a gift list.',403);const products=await productMap(s);
 const title=clean(b.title,80)||'My holiday list',occasion=OCCASIONS[b.occasion]?b.occasion:'christmas',note=clean(b.note,400),items=itemsIn(b.items,products),ship=shipTo(b.ship_to);
 let r=b.id?await owned(s,a,b.id):null;
 if(!r){const mine=(await s.list('registries')).filter(x=>x.owner_id===a.id&&!x.closed);if(mine.length>=MAX_LISTS)bad('You can have '+MAX_LISTS+' open gift lists. Close one first.');
  let id;do{id=crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,10)}while(id.length<10||await s.get('registries',id));
  r={id,owner_id:a.id,owner_name:clean(a.name,100),created:now(),thanks_points:0}}
 Object.assign(r,{title,occasion,note,items,ship_to:ship,updated:now(),closed:b.closed===true});await s.put('registries',r.id,r);return ownerView(s,r)}

// Checkout: before the order is built. Fills the owner's address into the order's customer block (the buyer's browser
// sends none) and checks every line is on the list. Returns what the order records under o.gift.
async function prepare(s,body,items){const slug=String(body.registry||'');if(!slugOk(slug))bad('This gift list link is not valid.',404);
 const r=await s.get('registries',slug);if(!r||r.closed)bad('This gift list is closed. Ask your friend for a new link.',404);
 const on=new Set(r.items.map(i=>i.id));for(const it of items||[])if(!on.has(Number(it.id)))bad('A gift order can only hold things from this gift list. Take the other items out first.');
 const c=body.customer&&typeof body.customer==='object'?body.customer:{};body.customer={...c,address:r.ship_to.address,city:r.ship_to.city,state:r.ship_to.state,zip:r.ship_to.zip};
 return{registry_id:r.id,owner_id:r.owner_id,to_name:r.ship_to.name,to_first:firstOf(r.ship_to.name),city:r.ship_to.city,state:r.ship_to.state,title:r.title,message:clean(body.gift_message,MESSAGE_MAX)}}
// A buyer editing a gift order: its lines must still be on the list (open or closed).
async function checkItems(s,regId,items){const r=await s.get('registries',String(regId||''));if(!r)return;const on=new Set(r.items.map(i=>i.id));for(const it of items||[])if(!on.has(Number(it.id)))bad('A gift order can only hold things from this gift list.')}
function stamp(o,gift){o.gift={...gift,from_name:clean(o.customer?.name,100)}}
// The buyer's copy of a gift order: street and ZIP removed, the owner's full name replaced by their first name.
function buyerView(v){if(!v||!v.gift)return v;const {owner_id,to_name,...g}=v.gift;return{...v,customer:{...v.customer,address:'',zip:'',address2:''},gift:g}}
// Edits by the buyer keep the owner's address.
function keepAddress(o,input){if(!o.gift)return input;const c=input&&typeof input==='object'?input:{};return{...c,address:o.customer.address,city:o.customer.city,state:o.customer.state,zip:o.customer.zip}}
function shipName(o){return o?.gift?.to_name||o?.customer?.name||''}

// Thank-you points: called from customer-accounts paid()/unpaid() and refunds.
const thanksFor=o=>Math.max(0,Math.floor(((Number(o.subtotal)||0)-(Number(o.discount)||0))/100));
async function thank(s,o,event,key){if(o.is_test!==false||!o.gift?.owner_id||o.gift.thanks_awarded)return;const a=await s.get('customers',o.gift.owner_id);if(!a?.verified)return;const pts=thanksFor(o);if(!pts)return;
 if(await event(s,a.id,'gift-thanks:'+o.id+key,'earned',pts,0,o.id,'Thank-you points: '+(o.gift.from_name?firstOf(o.gift.from_name):'a friend')+' sent a gift from your list'))o.gift.thanks_awarded=pts;
 const r=await s.get('registries',o.gift.registry_id);if(r){r.thanks_points=(r.thanks_points||0)+pts;await s.put('registries',r.id,r)}}
async function unthank(s,o,event,key,why){const pts=o.gift?.thanks_awarded;if(!pts)return;await event(s,o.gift.owner_id,'gift-unthank:'+o.id+key,'order_adjustment',-pts,0,o.id,why);o.gift.thanks_awarded=0;
 const r=await s.get('registries',o.gift.registry_id);if(r){r.thanks_points=Math.max(0,(r.thanks_points||0)-pts);await s.put('registries',r.id,r)}}

// Routes: /registry/<slug> is public; /account/registries[/save] need the owner's sign-in.
async function route(path,body,h,method){const accounts=require('./customer-accounts.cjs');
 const pub=path.match(/^\/registry\/([a-z0-9]{10})$/);
 if(pub&&method==='GET'){const out=await transaction(async s=>{const r=await s.get('registries',pub[1]);if(!r)bad('This gift list was not found. Check the link with your friend.',404);const v=await publicView(s,r);const a=await accounts.session(s,h).catch(()=>null);v.mine=!!a&&a.id===r.owner_id;return v});return{status:200,headers:{'cache-control':'no-store'},body:out}}
 if(path==='/account/registries'&&method==='GET'){const out=await transaction(async s=>{const a=await accounts.session(s,h,true);const mine=(await s.list('registries')).filter(r=>r.owner_id===a.id).sort((x,y)=>y.created-x.created);const lists=[];for(const r of mine)lists.push(await ownerView(s,r));return{lists,ship_to:a.ship_to||null,name:a.name||''}});return{status:200,headers:{'cache-control':'no-store'},body:out}}
 if(path==='/account/registries/save'&&method==='POST'){const out=await transaction(async s=>save(s,await accounts.session(s,h,true),body||{}));return{status:200,headers:{},body:out}}
 return null}

module.exports={route,save,prepare,checkItems,stamp,buyerView,keepAddress,shipName,thank,unthank,thanksFor,publicView,ownerView,OCCASIONS,MESSAGE_MAX};

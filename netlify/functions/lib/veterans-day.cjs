'use strict';
// Veterans Day subscription gifts (Jonah, 10 Nov 2026): "big veterans day. subscriptions only sale. 125+ gives them free
// trz 20mg, 250+ gives them 2 mito 31 and a bag of their choice, 400+ get a free aicar 50mg, 600+ they choose their own kit."
// Answers: the gifts STACK; the amount is the FIRST BOX total after the 15% (before shipping); the bag is a Glow merch bag
// (customer picks the color); the kit is any in-stock Kit of 10 up to KIT_CAP_CENTS (Jonah did not give a number: $400).
// New subscriptions only, Wednesday 11 Nov 2026, midnight to midnight Eastern. Gifts go on the first box only, at $0,
// and take stock like any item; they never change the price, the 15%, points, or what the repeat boxes contain.
const WINDOW={start:Date.parse('2026-11-11T00:00:00-05:00')/1000,end:Date.parse('2026-11-12T00:00:00-05:00')/1000};
const KIT_CAP_CENTS=40000,BAG_COLORS=['Black','White','Purple'],TAG='FREE Veterans Day gift';
const TIERS=[
 {id:'vd125',min:12500,items:[{id:11,quantity:1}]},
 {id:'vd250',min:25000,items:[{id:28,quantity:2}],bag:true},
 {id:'vd400',min:40000,items:[{id:24,quantity:1}]},
 {id:'vd600',min:60000,items:[],kit:true}
];
const now=()=>Math.floor(Date.now()/1000);
const isOpen=(brand,t=now())=>(brand?.id||brand)==='glow'&&t>=WINDOW.start&&t<WINDOW.end;
const kitOk=p=>p&&p.active&&(p.brand||'glow')==='glow'&&Number(p.units)===10&&p.price>0&&p.price<=KIT_CAP_CENTS&&Math.floor((p.stock||0)/10)>=1;
const short=n=>String(n||'').replace(/\s*·\s*/g,' ').trim();

// What the bag shows: every tier with its gifts, which are unlocked for this box, and how far to the next.
async function view(s,brand,baseCents,t=now()){
 if(!isOpen(brand,t))return null;
 const products=await s.list('products'),byId=new Map(products.map(p=>[p.id,p]));
 const tiers=TIERS.map(x=>({id:x.id,min_cents:x.min,unlocked:baseCents>=x.min,bag:!!x.bag,kit:!!x.kit,
  gifts:x.items.map(i=>{const p=byId.get(i.id);return{id:i.id,quantity:i.quantity,name:short(p?.name)||'Gift',value_cents:(p?.price||0)*i.quantity,in_stock:!!p&&p.active&&(p.stock||0)>=i.quantity}})}));
 const next=tiers.find(x=>!x.unlocked);
 const kits=products.filter(kitOk).sort((a,b)=>b.price-a.price||String(a.name).localeCompare(b.name)).map(p=>({id:p.id,name:short(p.name),price_cents:p.price}));
 return{open:true,ends_at:WINDOW.end,base_cents:baseCents,tiers,next:next?{id:next.id,min_cents:next.min_cents,need_cents:next.min_cents-baseCents}:null,
  unlocked:tiers.filter(x=>x.unlocked).length,bag_colors:BAG_COLORS,kit_cap_cents:KIT_CAP_CENTS,kits};
}

// The $0 gift lines for a new subscription's first box. lineFor(id,qty) builds a normal priced line (stock checked), or throws.
async function gifts(s,brand,baseCents,choice,lineFor,t=now()){
 if(!isOpen(brand,t))return null;
 const won=TIERS.filter(x=>baseCents>=x.min);if(!won.length)return null;
 const bag=String(choice?.bag||'').trim(),kitId=Number(choice?.kit_id);
 if(won.some(x=>x.bag)&&!BAG_COLORS.includes(bag))throw Object.assign(new Error('Choose the color of your free Glow bag.'),{status:400});
 let kit=null;if(won.some(x=>x.kit)){kit=await s.get('products',kitId);if(!kitOk(kit))throw Object.assign(new Error('Choose your free Kit of 10 (up to $'+KIT_CAP_CENTS/100+').'),{status:400})}
 const lines=[],missing=[];
 const add=async(id,quantity)=>{try{const l=await lineFor(id,quantity);lines.push({...l,name:short(l.name)+' · '+TAG,list_price:l.price,price:0,amount:0,promo_excluded:true,gift:'veterans-day'})}catch{const p=await s.get('products',id);missing.push(short(p?.name)||'Gift #'+id)}};
 for(const x of won){for(const i of x.items)await add(i.id,i.quantity);if(x.kit)await add(kit.id,1)}
 if(missing.length&&won.some(x=>x.kit)&&missing.includes(short(kit.name)))throw Object.assign(new Error('That kit just sold out. Choose another free Kit of 10.'),{status:409});
 const note='🎖️ Veterans Day gifts: '+[...lines.map(l=>l.quantity+'× '+l.name.replace(' · '+TAG,'')),...(won.some(x=>x.bag)?['1× Glow merch bag ('+bag+')']:[])].join(', ')+(missing.length?' · SOLD OUT, could not add: '+missing.join(', '):'');
 return{lines,record:{promo:'veterans-day-2026',tiers:won.map(x=>x.id),base_cents:baseCents,bag:won.some(x=>x.bag)?bag:null,kit_id:kit?kit.id:null,missing,gift_value_cents:lines.reduce((n,l)=>n+(l.list_price||0)*l.quantity,0)},note};
}
module.exports={WINDOW,TIERS,KIT_CAP_CENTS,BAG_COLORS,isOpen,view,gifts};

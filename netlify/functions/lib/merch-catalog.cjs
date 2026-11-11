'use strict';
const OPENING_STOCK_MIGRATION='glow-shirts-opening-stock-10-20261014-v1';
const MIGRATION='glow-shirts-20261014-v1';
const COLORS=['Black','White','Purple'];
const SIZES=['S','M','L','XL','2XL','3XL'];
const DESIGNS=[
 {key:'glowlab-og',name:'Glowlab OG Club Tee',image:'/img/merch/glowlab-og-model.webp',design_image:'/img/merch/glowlab-og-design.webp',model_color:'Purple'},
 {key:'pep-ho-for-life',name:'Pep Ho for Life Tee',image:'/img/merch/pep-life-black-model.webp',design_image:'/img/merch/pep-life-black-design.webp',model_color:'Black',white_image:'/img/merch/pep-life-white-model.webp',white_design_image:'/img/merch/pep-life-white-design.webp'}
];
async function ensureMerchCatalog(s){
 await ensureCollection202611(s);
 if(await s.get('migrations',MIGRATION))return ensureMerchOpeningStock(s);
 const all=await s.list('products');const bySku=new Map(all.map(p=>[p.sku,p]));let nextId=Math.max(0,...all.map(p=>p.id));let created=0;
 for(const d of DESIGNS)for(const color of COLORS)for(const size of SIZES){
  const sku='merch-'+d.key+'-'+color.toLowerCase()+'-'+size.toLowerCase();if(bySku.has(sku))continue;
  const white=color==='White'&&d.white_image;
  const p={id:++nextId,brand:'glow',category:'merch',merch_design:d.key,slug:'merch-'+d.key,name:d.name+' · '+color+' · '+size,sku,color,size,price:3200,stock:0,active:1,image:white?d.white_image:d.image,design_image:white?d.white_design_image:d.design_image,model_color:white?'White':d.model_color,additional_images:d.white_image?[d.image,d.design_image,d.white_image,d.white_design_image]:[d.image,d.design_image],source:'Owner-approved apparel; opening stock awaiting quantities'};
  await s.put('products',p.id,p);bySku.set(sku,p);created++;
 }
 await s.put('migrations',MIGRATION,{applied:Math.floor(Date.now()/1000),created});await ensureMerchOpeningStock(s);return true;
}
async function ensureMerchOpeningStock(s){
 if(await s.get('migrations',OPENING_STOCK_MIGRATION))return false;
 const expected=new Set(DESIGNS.flatMap(d=>COLORS.flatMap(color=>SIZES.map(size=>'merch-'+d.key+'-'+color.toLowerCase()+'-'+size.toLowerCase()))));
 const shirts=(await s.list('products')).filter(p=>p.brand==='glow'&&p.category==='merch'&&expected.has(p.sku));
 if(shirts.length!==expected.size||new Set(shirts.map(p=>p.sku)).size!==expected.size)throw Object.assign(new Error('Shirt inventory setup is incomplete.'),{status:503});
 for(const p of shirts){p.stock=10;p.source='Owner-approved apparel; opening stock 10 per size and color';await s.put('products',p.id,p)}
 await s.put('migrations',OPENING_STOCK_MIGRATION,{applied:Math.floor(Date.now()/1000),updated:shirts.length,units_per_variant:10,total_units:shirts.length*10});return true;
}
// New merch collection (Jonah, 11 Nov 2026): 18 product photos -> 5 shirts (S-XL), 7 totes, 6 zipper pouches.
// Prices: tee $32, long sleeve $38, tote $25, pouch $18. Opening stock 10 of each (per size for shirts), to be corrected in
// Management. Photos: /img/merch/collection-2026-11/<file>.webp (made from the owner's product photos, white background).
const COLLECTION_MIGRATION='glow-merch-collection-20261111-v1',COLLECTION='2026-11',SHIRT_SIZES=['S','M','L','XL'];
const COLLECTION_ITEMS=[
 {key:'glow-bee-tee',kind:'tee',name:'Glow Bee Tee',color:'White',file:'glow-bee-white-tee',price:3200},
 {key:'mots-c-bear-tee',kind:'tee',name:'MOTS-C Bear Tee',color:'Black',file:'mots-c-black-tee',price:3200},
 {key:'pep-ho-chest-tee',kind:'tee',name:'Pep Ho for Life Chest Logo Tee',color:'Black',file:'pep-ho-black-tee',price:3200},
 {key:'peptide-pioneer-tee',kind:'tee',name:'GLP Peptide Pioneer Tee',color:'White',file:'peptide-pioneer-white-tee',price:3200},
 {key:'luggage-long-sleeve',kind:'long-sleeve',name:'More Than My Luggage Long Sleeve',color:'White',file:'luggage-white-long-sleeve',price:3800},
 {key:'pep-ho-tote-natural',kind:'tote',name:'Pep Ho for Life Tote',color:'Natural',file:'pep-ho-natural-tote',price:2500},
 {key:'pep-for-that-tote-natural',kind:'tote',name:'I Have a Pep for That Tote',color:'Natural',file:'pep-for-that-natural-tote',price:2500},
 {key:'pep-ho-tote-black',kind:'tote',name:'Pep Ho for Life Tote',color:'Black',file:'pep-ho-black-tote',price:2500},
 {key:'peptide-pioneer-tote-natural',kind:'tote',name:'Peptide Pioneer Tote',color:'Natural',file:'peptide-pioneer-natural-tote',price:2500},
 {key:'glow-lab-tote-natural',kind:'tote',name:'Glow Lab Protocols Tote',color:'Natural',file:'glow-lab-natural-tote',price:2500},
 {key:'luggage-tote-black',kind:'tote',name:'More Than My Luggage Tote',color:'Black',file:'luggage-black-tote',price:2500},
 {key:'mots-c-bear-tote-black',kind:'tote',name:'MOTS-C Bear Tote',color:'Black',file:'mots-c-black-tote',price:2500},
 {key:'pep-ho-pouch-natural',kind:'pouch',name:'Pep Ho for Life Zipper Pouch',color:'Natural',file:'pep-ho-natural-pouch',price:1800},
 {key:'mots-c-bear-pouch-natural',kind:'pouch',name:'MOTS-C Bear Zipper Pouch',color:'Natural',file:'mots-c-natural-pouch',price:1800},
 {key:'glow-up-pouch-natural',kind:'pouch',name:'Ready for a Glow Up Zipper Pouch',color:'Natural',file:'glow-up-natural-pouch',price:1800},
 {key:'pep-ho-pouch-black',kind:'pouch',name:'Pep Ho for Life Zipper Pouch',color:'Black',file:'pep-ho-black-pouch',price:1800},
 {key:'mots-c-bear-pouch-black',kind:'pouch',name:'MOTS-C Bear Zipper Pouch',color:'Black',file:'mots-c-black-pouch',price:1800},
 {key:'luggage-pouch-natural',kind:'pouch',name:'More Than My Luggage Zipper Pouch',color:'Natural',file:'luggage-natural-pouch',price:1800}
];
const shirt=k=>k==='tee'||k==='long-sleeve';
function collectionProducts(){const out=[];for(const d of COLLECTION_ITEMS){const image='/img/merch/collection-2026-11/'+d.file+'.webp';
 for(const size of shirt(d.kind)?SHIRT_SIZES:[null])out.push({brand:'glow',category:'merch',merch_collection:COLLECTION,merch_kind:d.kind,merch_design:d.key,slug:'merch-'+d.key,
  name:d.name+' · '+d.color+(size?' · '+size:''),sku:'merch-'+d.key+(size?'-'+size.toLowerCase():''),color:d.color,...(size?{size}:{}),price:d.price,stock:10,active:1,image,
  source:'Owner product photo set 11 Nov 2026; opening stock 10'})}return out}
async function ensureCollection202611(s){
 if(await s.get('migrations',COLLECTION_MIGRATION))return false;
 // A store being rebuilt from scratch (no settings yet: the Sevalla recovery path) starts with zero stock, like every other product there.
 const live=!!await s.get('settings','main'),all=await s.list('products'),bySku=new Set(all.map(p=>p.sku));let nextId=Math.max(0,...all.map(p=>p.id)),created=0;
 for(const p of collectionProducts()){if(bySku.has(p.sku))continue;const row={id:++nextId,...p,...(live?{}:{stock:0,source:'Owner product photo set 11 Nov 2026; recovery catalog, stock not verified'})};await s.put('products',row.id,row);created++}
 await s.put('migrations',COLLECTION_MIGRATION,{applied:Math.floor(Date.now()/1000),created});return true;
}
module.exports={ensureMerchCatalog,DESIGNS,COLORS,SIZES,MIGRATION,COLLECTION_ITEMS,COLLECTION_MIGRATION,collectionProducts,ensureCollection202611};

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
module.exports={ensureMerchCatalog,DESIGNS,COLORS,SIZES,MIGRATION};

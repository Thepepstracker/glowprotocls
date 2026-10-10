'use strict';
// One store, several brands. Each brand has its own domain, catalog rows (product.brand), coupons
// (coupon.brand) and order prefix; all brands share the database, payment recipients and the
// Management area. Rows without a brand field belong to Glow, so every existing record keeps working.
const BRANDS={
 glow:{id:'glow',name:'Glow Lab',legal_name:'Glow Lab Protocols',hosts:['glowglps.com','www.glowglps.com','glowlabprotocols.com','www.glowlabprotocols.com'],dev_hosts:[],origin:'',order_prefix:'GLP',rewards:true,affiliates:true,waitlist:false,accent:'#c9a24b',email_from_env:''},
 zader:{id:'zader',name:'Zader Health',legal_name:'Zader Health',hosts:['zaderhealth.com','www.zaderhealth.com'],dev_hosts:['zader.localhost'],origin:'https://zaderhealth.com',order_prefix:'ZDR',rewards:false,affiliates:false,waitlist:false,accent:'#03b9d5',email_from_env:'STORE_EMAIL_FROM_ZADER'},
 peppuppy:{id:'peppuppy',name:'Pep Puppy',legal_name:'Pep Puppy',hosts:['peppuppy.com','www.peppuppy.com'],dev_hosts:['peppuppy.localhost'],origin:'https://peppuppy.com',order_prefix:'PEP',rewards:false,affiliates:false,waitlist:true,accent:'#5d399d',email_from_env:'STORE_EMAIL_FROM_PEPPUPPY'}
};
const ids=Object.keys(BRANDS);
function get(id){return BRANDS[id]||BRANDS.glow}
function validId(id){if(id===undefined||id===null||id==='')return 'glow';if(typeof id!=='string'||!BRANDS[id])throw Object.assign(new Error('Choose a valid store brand.'),{status:400});return id}
function hostOf(value){const v=String(value||'').split(',')[0].trim().toLowerCase();if(!v)return '';try{return new URL(/^[a-z]+:\/\//.test(v)?v:'https://'+v).hostname}catch{return ''}}
function byHost(host){for(const b of Object.values(BRANDS)){if(b.hosts.includes(host))return b;if(process.env.STORE_LOCAL&&b.dev_hosts.includes(host))return b}return null}
// Netlify passes the visited domain as Host / x-forwarded-host. Unknown hosts (deploy previews,
// netlify.app, localhost) are Glow, so the existing site behaves exactly as before.
function fromHeaders(h={}){const x=Object.fromEntries(Object.entries(h||{}).map(([k,v])=>[k.toLowerCase(),v]));return byHost(hostOf(x['x-forwarded-host']))||byHost(hostOf(x.host))||BRANDS.glow}
function allHosts(){return new Set(Object.values(BRANDS).flatMap(b=>b.hosts))}
const productBrand=p=>(p&&p.brand)||'glow';
const couponBrand=c=>(c&&c.brand)||'glow';
const orderBrand=o=>get((o&&o.brand)||'glow');
function publicBrand(b){return{id:b.id,name:b.name,legal_name:b.legal_name,rewards:b.rewards,affiliates:b.affiliates,waitlist:b.waitlist}}
// Customers never see exact counts. The server still enforces real stock at checkout.
const PUBLIC_STOCK=99;
// Live stores hide exact counts; preview/test mode keeps them so staff can check reservations.
function publicProduct(p,hide=true){return hide?{...p,stock:p.stock>0?PUBLIC_STOCK:0,in_stock:p.stock>0}:{...p,in_stock:p.stock>0}}
function emailFrom(b,fallback){return (b.email_from_env&&process.env[b.email_from_env])||fallback}

// Zader Health catalog. Each row shares one stock count with its Glow counterpart (same vial),
// through the existing stock-group mechanism, so a sale on either store reduces the same number.
// Prices are Zader's own (read from the Zader WooCommerce store on 7 Oct 2026).
const ZADER_IMAGE='/img/zader/zader-vial.jpg';
const ZADER_CATALOG=[
 ['Acetic Acid 0.6% · 10 mL','acetic-acid-10-ml',1399,'10 mL'],
 ['Vitamin B-12 · 10 mL','vitamin-b12-10-ml',5699,'10 mL'],
 ['Lipo-C with B-12 · 10 mL','lipo-c-b12-10-ml',7499,'10 mL'],
 ['BAC Water · 3 mL','bac-water-3-ml',899,'3 mL'],
 ['BAC Water · 10 mL','bac-water-10-ml',1699,'10 mL'],
 ['BAC Water · 20 mL','bac-water-20-ml',3099,'20 mL'],
 ['5-Amino-1MQ · 5 mg','5-amino-1mq-5-mg',6199,'5 mg'],
 ['5-Amino-1MQ · 50 mg','5-amino-1mq-50-mg',11099,'50 mg'],
 ['AICAR · 50 mg','aicar-50-mg',8899,'50 mg'],
 ['AICAR · 100 mg','aicar-100-mg',13999,'100 mg'],
 ['GLP-3R · 10 mg','reta-10-mg',7699,'10 mg'],
 ['GLP-3R · 20 mg','reta-20-mg',13999,'20 mg'],
 ['GLP-2T · 10 mg','tirz-10-10-mg',7199,'10 mg'],
 ['GLP-2T · 15 mg','tirz-10-15-mg',11599,'15 mg'],
 ['GLP-2T · 20 mg','tirz-10-20-mg',13299,'20 mg'],
 ['GLP-2T · 30 mg','tirz-10-30-mg',16899,'30 mg'],
 ['FOX-04 DRI · 10 mg','fox-04-10-mg',13499,'10 mg'],
 ['ARA-290 · 10 mg','ara-290-10-mg',7699,'10 mg'],
 ['Thymosin Alpha-1 · 5 mg','thymosin-alpha-1-5-mg',7199,'5 mg'],
 ['Pinealon · 10 mg','',9399,'10 mg','zdr-pinealon-10-mg'],
 ['Epithalon · 50 mg','epithalon-50-50-mg',16899,'50 mg'],
 ['PT-141 · 10 mg','pt-141-10-mg',5699,'10 mg'],
 ['DSIP · 5 mg','dsip-5-mg',5499,'5 mg'],
 ['Selank · 10 mg','selank-10-mg',5699,'10 mg'],
 ['Ipamorelin · 10 mg','ipamorelin-10-mg',10899,'10 mg'],
 ['KPV · 10 mg','kpv-10-mg',4299,'10 mg'],
 ['KLOW · 80 mg','klow-blend-80-mg',14799,'80 mg'],
 ['TB-500 · 10 mg','tb-500-10-mg',8399,'10 mg'],
 ['GHK-Cu · 100 mg','ghk-cu-100-mg',4999,'100 mg'],
 ['NAD+ · 500 mg','nad-500-mg',6999,'500 mg'],
 ['GLP-31 · 10 mg','ss-31-10-mg',6999,'10 mg'],
 ['MOTS-c · 10 mg','mots-c-10-mg',5999,'10 mg'],
 ['Adamax · 5 mg','adamax-5-mg',8199,'5 mg'],
 ['Adamax · 10 mg','adamax-10-mg',10099,'10 mg'],
 ['Glutathione · 750 mg','glutathione-750-mg',6499,'750 mg'],
 ['Glutathione · 1500 mg','glutathione-1500-mg',10099,'1500 mg'],
 ['BPC-157 · 5 mg','',4999,'5 mg','zdr-bpc-157-5-mg'],
 ['BPC-157 · 10 mg','bpc-157-10-mg',5499,'10 mg'],
 ['Tesamorelin · 5 mg','tesamorelin-5-mg',8399,'5 mg'],
 ['Tesamorelin · 10 mg','tesamorelin-10-mg',11799,'10 mg']
];
// Each Zader product has its own label photo (name and strength on the vial).
const ZADER_PHOTOS=new Set(["zdr-5-amino-1mq-5-mg", "zdr-5-amino-1mq-50-mg", "zdr-acetic-acid-10-ml", "zdr-adamax-10-mg", "zdr-adamax-5-mg", "zdr-aicar-100-mg", "zdr-aicar-50-mg", "zdr-ara-290-10-mg", "zdr-bac-water-10-ml", "zdr-bac-water-20-ml", "zdr-bac-water-3-ml", "zdr-bpc-157-10-mg", "zdr-bpc-157-5-mg", "zdr-dsip-5-mg", "zdr-epithalon-50-50-mg", "zdr-fox-04-10-mg", "zdr-ghk-cu-100-mg", "zdr-glutathione-1500-mg", "zdr-glutathione-750-mg", "zdr-ipamorelin-10-mg", "zdr-klow-blend-80-mg", "zdr-kpv-10-mg", "zdr-lipo-c-b12-10-ml", "zdr-mots-c-10-mg", "zdr-nad-500-mg", "zdr-pinealon-10-mg", "zdr-pt-141-10-mg", "zdr-reta-10-mg", "zdr-reta-20-mg", "zdr-selank-10-mg", "zdr-ss-31-10-mg", "zdr-tb-500-10-mg", "zdr-tesamorelin-10-mg", "zdr-tesamorelin-5-mg", "zdr-thymosin-alpha-1-5-mg", "zdr-tirz-10-10-mg", "zdr-tirz-10-15-mg", "zdr-tirz-10-20-mg", "zdr-tirz-10-30-mg", "zdr-vitamin-b12-10-ml"]);
const zaderPhoto=sku=>ZADER_PHOTOS.has(sku)?'/img/zader/products/'+sku+'.jpg':ZADER_IMAGE;
const ZADER_MIGRATION='zader-catalog-v1',ZADER_PHOTO_MIGRATION='zader-photos-v1';
// Runs once, inside the normal store transaction. Idempotent: guarded by a migration record and by SKU.
// Once: swap the shared stand-in vial for each product's own photo. Photos staff changed are kept.
async function ensureZaderPhotos(s){
 if(await s.get('migrations',ZADER_PHOTO_MIGRATION))return false;
 let changed=0;for(const p of await s.list('products')){if(p.brand==='zader'&&p.image===ZADER_IMAGE&&ZADER_PHOTOS.has(p.sku)){p.image=zaderPhoto(p.sku);await s.put('products',p.id,p);changed++}}
 await s.put('migrations',ZADER_PHOTO_MIGRATION,{applied:Math.floor(Date.now()/1000),changed});return true;
}
async function ensureZaderCatalog(s,validSlug){
 if(await s.get('migrations',ZADER_MIGRATION))return ensureZaderPhotos(s);
 const all=await s.list('products');if(!all.length)return false;
 const bySku=new Map(all.map(p=>[String(p.sku).toLowerCase(),p]));let nextId=Math.max(0,...all.map(p=>p.id));let created=0,linked=0;
 for(const [name,glowSku,price,size,ownSku] of ZADER_CATALOG){
  const sku=ownSku||'zdr-'+glowSku;if(bySku.has(sku))continue;
  const glow=glowSku?bySku.get(glowSku):null;let pool='',stock=0;
  if(glow){
   pool=glow.stock_pool||('shared-'+glowSku).slice(0,60);
   if(!validSlug(pool))pool=('shared-'+String(glow.id)).slice(0,60);
   if(!glow.stock_pool){glow.stock_pool=pool;await s.put('products',glow.id,glow);linked++}
   stock=glow.stock;
  }
  const p={id:++nextId,brand:'zader',name,sku,slug:sku,size,price,stock,stock_pool:pool,active:1,image:zaderPhoto(sku),source:glow?'zader catalog; shares stock with Glow '+glow.sku:'zader catalog; own stock'};
  await s.put('products',p.id,p);bySku.set(sku,p);created++;
 }
 await s.put('migrations',ZADER_MIGRATION,{applied:Math.floor(Date.now()/1000),created,linked});
 await ensureZaderPhotos(s);
 return true;
}
module.exports={BRANDS,ids,get,validId,fromHeaders,allHosts,productBrand,couponBrand,orderBrand,publicBrand,publicProduct,emailFrom,PUBLIC_STOCK,ZADER_CATALOG,ZADER_PHOTOS,ensureZaderCatalog,ensureZaderPhotos,hostOf};

'use strict';
// Website features (Jonah, 16 Nov 2026: "lets add better features to the website"): product pages, back-in-stock alerts,
// and smart add-ons in the bag.
//
//   Product pages   /store-next/p/<slug>: one page per product family (all sizes of GLP-2T on one page). The page itself
//                   is drawn by the store app; here: the family slug rules, the server-side title/description/structured
//                   data so a shared link and Google show the product, and product links in the sitemap.
//   Add-ons         "Goes well with": products bought together in real paid orders (counts only, nothing personal),
//                   plus BAC water for research peptides. Only active, in-stock products of the same store.
//   Back in stock   "Notify me" on sold-out products. When any size of that product is back in stock, one email (and a
//                   phone alert in the app, if they have alerts on) goes out, oldest request first. Runs from the
//                   Autopilot switch "Back-in-stock alerts" (starts OFF); requests are saved either way.
const crypto=require('node:crypto'),{transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const lower=e=>String(e||'').trim().toLowerCase();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---- product families ----
const slugify=v=>String(v||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[’'+]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80);
function familyName(p){return String(p?.name||'').split(' · ')[0].trim()}
function familySlug(p){return /^[a-z0-9-]{1,80}$/.test(String(p?.slug||''))?p.slug:slugify(familyName(p))}
function isPeptide(p){const sku=String(p.sku||'').toLowerCase();return p.category!=='cosmetic'&&p.category!=='merch'&&!p.merch_design&&!sku.startsWith('bundle-')&&!/^(protocol-|glow-eyes|rose-recovery|cu-hair|bac-water|acetic-acid|magnet-|lipo-c|vitamin-b12)/.test(sku)&&/\bmg\b/i.test(String(p.size||p.name))}
const brandOf=p=>(p&&p.brand)||'glow';

// ---- "Goes well with" ----
let cache=null;const CACHE_SECONDS=600;
async function pairs(s){if(cache&&cache.at>now()-CACHE_SECONDS)return cache.map;const products=new Map((await s.list('products')).map(p=>[p.id,p])),map=new Map();
 const list=s.listLite?await s.listLite('orders'):await s.list('orders');
 for(const o of list){if(o.is_test!==false||!['paid','shipped'].includes(o.status))continue;const fams=[...new Set((o.items||[]).map(i=>products.get(Number(i.id))).filter(Boolean).map(familySlug))];
  for(const a of fams)for(const b of fams)if(a!==b){const m=map.get(a)||new Map();m.set(b,(m.get(b)||0)+1);map.set(a,m)}}
 cache={at:now(),map};return map}
function resetCache(){cache=null}
// The size people actually buy: the in-stock member of a family that sold the most (else the cheapest in stock).
async function bestOf(s,brand,slug,sold){const opts=(await s.list('products')).filter(p=>p.active&&brandOf(p)===brand&&familySlug(p)===slug&&Number(p.stock)>0&&!(Number(p.units)>1));
 return opts.sort((a,b)=>(sold.get(b.id)||0)-(sold.get(a.id)||0)||a.price-b.price)[0]||null}
async function related(s,{slugs=[],ids=[],brand='glow',limit=3}){const all=await s.list('products'),byId=new Map(all.map(p=>[p.id,p]));
 const have=new Set([...slugs.map(String),...ids.map(i=>byId.get(Number(i))).filter(Boolean).map(familySlug)].filter(x=>/^[a-z0-9-]{1,80}$/.test(x)));if(!have.size)return[];
 const map=await pairs(s),score=new Map();for(const f of have)for(const [g,n] of (map.get(f)||new Map()))if(!have.has(g))score.set(g,(score.get(g)||0)+n);
 for(const [g,n] of [...score])if(n<2)score.delete(g); // at least two different orders bought them together
 // Research peptides are mixed with bacteriostatic water: suggest it when it isn't in the bag.
 const peptide=[...have].some(f=>all.some(p=>familySlug(p)===f&&isPeptide(p)));if(peptide&&!have.has('bac-water'))score.set('bac-water',Math.max(score.get('bac-water')||0,1e6));
 const sold=new Map();const list=s.listLite?await s.listLite('orders'):await s.list('orders');for(const o of list)if(o.is_test===false&&['paid','shipped'].includes(o.status))for(const i of o.items||[])sold.set(Number(i.id),(sold.get(Number(i.id))||0)+(Number(i.quantity)||0));
 const out=[];for(const [g] of [...score].sort((a,b)=>b[1]-a[1])){if(out.length>=limit)break;const p=await bestOf(s,brand,g,sold);if(p)out.push({id:p.id,slug:g,why:g==='bac-water'&&score.get(g)>=1e6?'mix':'together'})}
 return out}

// ---- back-in-stock alerts ----
async function requestAlert(s,{productId,email,customer,brand}){const p=await s.get('products',Number(productId));if(!p||!p.active||brandOf(p)!==brand)bad('Product not found.',404);
 const slug=familySlug(p),to=customer?.email||email;if(!to||typeof to!=='string'||to.length>150||!/^\S+@[^\s@]+\.[^\s@]+$/.test(to.trim()))bad('Enter a valid email address.');const addr=lower(to);
 const inStock=(await s.list('products')).some(x=>x.active&&brandOf(x)===brand&&familySlug(x)===slug&&Number(x.stock)>0&&!(Number(x.units)>1));if(inStock)bad('Good news: it’s in stock right now.',409);
 const id=hash('stock:'+brand+':'+slug+':'+addr).slice(0,40),old=await s.get('stock_alerts',id);if(old&&!old.notified_at)return{saved:true,already:true};
 await s.put('stock_alerts',id,{id,brand,slug,product_id:p.id,name:familyName(p),email:addr,customer_id:customer?.id||null,created:now(),created_ms:Date.now(),notified_at:null});return{saved:true}}
function alertEmail(name,url){return{subject:'It’s back: '+name+' · Glow Lab',title:name+' is back in stock.',button:'Shop '+name,
 lines:['Hi there,','You asked us to let you know when '+name+' was back. It’s in stock now.','Restocks can sell out quickly, so we wanted you to hear first. Tap below to see it.','You’re getting this one email because you tapped “Notify me” on our store. We won’t send another about this product.']}}
async function restocks(limit=40,t=Date.now()){const h=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'}).format(new Date(t)));if(h<8||h>=21)return{status:'quiet_hours',sent:0};
 const emails=require('./store-email.cjs'),brands=require('./brands.cjs');if(!emails.configuration().ready)return{status:'email_not_configured',sent:0};
 const {jobs,pushes}=await transaction(async s=>{const waiting=(await s.list('stock_alerts')).filter(a=>!a.notified_at).sort((a,b)=>(a.created_ms||a.created*1000)-(b.created_ms||b.created*1000));if(!waiting.length)return{jobs:[],pushes:[]};
  const products=await s.list('products'),jobs=[],pushes=[];
  for(const a of waiting){if(jobs.length>=limit)break;const back=products.some(x=>x.active&&brandOf(x)===a.brand&&familySlug(x)===a.slug&&Number(x.stock)>0&&!(Number(x.units)>1));if(!back)continue;
   const origin=String(brands.BRANDS[a.brand]?.origin||process.env.STORE_ORIGIN||'').replace(/\/$/,''),url=origin+'/store-next/p/'+a.slug,c=alertEmail(a.name,url);
   const job=await emails.enqueue(s,{id:'stock-back-'+a.id,kind:'stock_alert',brand:a.brand,to:a.email,related_id:a.id,subject:c.subject,content:emails.template(c.title,c.lines,url,c.button,null,null,{eyebrow:'Back in stock'})});
   const r=await s.get('stock_alerts',a.id);r.notified_at=now();r.job=job||null;await s.put('stock_alerts',a.id,r);if(job)jobs.push(job);
   if(a.customer_id)pushes.push({customer:a.customer_id,m:{title:a.name+' is back ✨',body:'You asked us to tell you. It’s in stock now.',url:'/store-next/p/'+a.slug,tag:'stock:'+a.slug}})}
  return{jobs,pushes}});
 for(const j of jobs)await emails.safeDispatch(j);
 for(const p of pushes){try{await require('./web-push.cjs').sendTo('cust_push_subs',x=>x.customer_id===p.customer,p.m)}catch{}}
 return{status:'ok',sent:jobs.length}}
async function alertSummary(s){const rows=new Map();for(const a of await s.list('stock_alerts')){const k=a.brand+':'+a.slug,r=rows.get(k)||{brand:a.brand,slug:a.slug,name:a.name,waiting:0,notified:0,oldest:0};if(a.notified_at)r.notified++;else{r.waiting++;r.oldest=r.oldest?Math.min(r.oldest,a.created):a.created}rows.set(k,r)}
 return [...rows.values()].sort((a,b)=>b.waiting-a.waiting||a.name.localeCompare(b.name))}

// ---- product page: server-side title, description and structured data ----
function productHead(html,{products,slug,origin,brandName}){const fam=products.filter(p=>familySlug(p)===slug&&!(Number(p.units)>1));if(!fam.length||!html.includes('</head>'))return html;
 const name=familyName(fam[0]),sizes=[...new Set(fam.map(p=>p.size).filter(Boolean))],prices=fam.map(p=>p.price/100),low=Math.min(...prices),high=Math.max(...prices),inStock=fam.some(p=>p.in_stock!==false&&Number(p.stock)>0);
 const url=origin+'/store-next/p/'+slug,img=fam.find(p=>p.image)?.image,image=img?(/^https?:/.test(img)?img:origin+img):origin+'/img/og-glow.jpg';
 const title=name+(sizes.length?' · '+sizes.join(', '):'')+' · '+brandName,desc='Shop '+name+(sizes.length?' ('+sizes.join(', ')+')':'')+' at '+brandName+'. '+(inStock?'In stock and ready to ship.':'Currently sold out: tap Notify me to hear first when it’s back.')+' For research use only.';
 const ld={'@context':'https://schema.org','@type':'Product',name,image:[image],url,brand:{'@type':'Brand',name:brandName},description:desc,offers:fam.length>1?{'@type':'AggregateOffer',lowPrice:low.toFixed(2),highPrice:high.toFixed(2),offerCount:fam.length,priceCurrency:'USD',availability:'https://schema.org/'+(inStock?'InStock':'OutOfStock'),url}:{'@type':'Offer',price:low.toFixed(2),priceCurrency:'USD',availability:'https://schema.org/'+(inStock?'InStock':'OutOfStock'),url}};
 const tags=`<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}"><meta property="og:type" content="product"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">${JSON.stringify(ld).replace(/</g,'\\'+'u003c')}</script>`;
 return html.replace(/<title>[\s\S]*?<\/title>/,'').replace(/<meta name="description"[^>]*>/,'').replace(/<link rel="canonical"[^>]*>/,'').replace(/<meta property="og:(title|description|url|image|type)"[^>]*>/g,'').replace('</head>',tags+'</head>')}
function sitemapWith(xml,{products,origin}){const slugs=[...new Set(products.filter(p=>!(Number(p.units)>1)).map(familySlug))].sort(),day=new Date().toISOString().slice(0,10);
 const urls=slugs.map(sl=>`  <url><loc>${esc(origin+'/store-next/p/'+sl)}</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>${day}</lastmod></url>`).join('\n');
 return xml.replace(/https:\/\/glowlabprotocols\.com/g,origin).replace('</urlset>',`  <url><loc>${esc(origin+'/store-next/')}</loc><changefreq>daily</changefreq><priority>1.0</priority><lastmod>${day}</lastmod></url>\n${urls}\n</urlset>`)}

async function route(path,body,h,method,{session}){const ok=b=>({status:200,headers:{},body:b}),brands=require('./brands.cjs'),accounts=require('./customer-accounts.cjs'),brand=brands.fromHeaders(h).id;
 if(path==='/related'&&method==='POST'){const ids=(Array.isArray(body.ids)?body.ids:[]).slice(0,30).map(Number).filter(Number.isInteger),slugs=(Array.isArray(body.slugs)?body.slugs:[]).slice(0,10).map(String);return ok({items:await transaction(s=>related(s,{ids,slugs,brand,limit:Math.min(4,Math.max(1,Number(body.limit)||3))}))})}
 if(path==='/stock-alert'&&method==='POST'){await accounts.rate('stock-alert',String(h['x-nf-client-connection-ip']||h['x-forwarded-for']||'local').split(',')[0].trim(),20,3600);
  return ok(await transaction(async s=>{const a=await accounts.session(s,h);return requestAlert(s,{productId:body.product_id,email:body.email,customer:a,brand})}))}
 if(path==='/admin/stock-alerts'&&method==='GET'){await transaction(s=>session(s,h));return ok({rows:await transaction(alertSummary)})}
 return null}

module.exports={familySlug,familyName,slugify,isPeptide,related,pairs,resetCache,requestAlert,restocks,alertEmail,alertSummary,productHead,sitemapWith,route};

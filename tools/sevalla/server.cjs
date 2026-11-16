'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const TYPES={'.webmanifest':'application/manifest+json','.mp3':'audio/mpeg','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.xml':'application/xml','.pdf':'application/pdf'};
const security={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cache-Control':'no-store'};
async function body(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk)}return Buffer.concat(chunks).toString('utf8')}
function publicFile(p){
 if(p==='/'||p==='/store-next'||p==='/store-next/'||/^\/store-next\/(?:profile\/[a-z0-9-]+|p\/[a-z0-9-]{1,80}|[a-z0-9-]+)\/?$/.test(p)&&!p.includes('/merch'))return 'store-next/index.html';
 if(/^\/store-next\/merch\/?$/.test(p))return 'store-next/merch.html';
 const rel=p.replace(/^\//,'');
 if(rel.split('/').some(x=>!x||x.startsWith('.')||x==='..'))return null;
 if(!TYPES[path.extname(rel)])return null;
 if(!rel.includes('/')||/^(img|product-images|store-next)\//.test(rel))return rel;
 return null;
}
// Zader Health (zaderhealth.com) is a second brand on this same store (Jonah, 8 Nov 2026: everything Glow has, Zader gets).
// Same rules the old Netlify site used (netlify.toml): www goes to the bare domain, Zader's own policy pages, Glow-only
// pages bounce home, and every other page is the Zader storefront app. Scripts, styles and pictures are served as usual.
const ZADER_HOSTS=new Set(['zaderhealth.com','www.zaderhealth.com']);
const ZADER_PAGES={'/terms':'zader-terms','/privacy':'zader-privacy','/shipping':'zader-shipping','/contact':'zader-contact'};
const GLOW_ONLY=/^\/(?:about|affiliate|bpc-157-research-guide|checkout|coa|faq|glow-loyalty|peptide-storage-and-handling|price-desk|tonight|peptides|privacy|terms)\.html$|^\/store-next\/(?:index\.html|merch(?:\.html)?\/?|live\.html|affiliate(?:\.html)?\/?|live\/?)$/;
function requestHost(req){const h=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();return h.replace(/:\d+$/,'')}
function zaderRoute(p){
 if(p==='/robots.txt')return{file:'store-next/zader-robots.txt'};if(p==='/sitemap.xml')return{file:'store-next/zader-sitemap.xml'};
 const page=ZADER_PAGES[p.replace(/(?:\.html|\/)$/,'')];if(page)return{file:'store-next/'+page+'.html'};
 if(GLOW_ONLY.test(p))return{redirect:'/'};
 const ext=path.extname(p);if(ext&&ext!=='.html')return null; // scripts, styles, pictures: normal rules
 if(p==='/store-next/packing.html')return{file:'store-next/packing.html'};
 return{file:'store-next/zader.html'};
}
// Link preview for the My account page (Jonah, 14 Nov 2026): it is the link shared on TikTok, so a text or DM shows the
// Glow Lab Protocols logo card (img/og-glow-logo.png, no vials) instead of the vial banner. Every other page is unchanged.
function shareCard(html,p){if(!/^\/store-next\/account\/?$/.test(p)||!html.includes('/img/og-glow.jpg"'))return html;
 return html.replace(/(<meta (?:property="og:image"|name="twitter:image") content="[^"]*?)\/img\/og-glow\.jpg"/g,'$1/img/og-glow-logo.png"').replace('<meta property="og:image:alt" content="Glow Lab Protocols vials with gold caps">','<meta property="og:image:alt" content="Glow Lab Protocols logo">').replace('<meta property="og:url" content="https://glowglps.com/">','<meta property="og:url" content="https://glowglps.com/store-next/account">')}
// Glow Lab customer app (Jonah, 14 Nov 2026: "now lets make one for everyone"). On the Glow store pages (not Management):
// the app manifest, launch screens and full-screen mode. A customer who adds it from an affiliate's store keeps that store
// (the manifest's start page is that store), so the affiliate keeps the credit.
const STORE_APP_PAGE=/^\/(?:store-next\/?)?$|^\/store-next\/(?:account|merch|p\/[a-z0-9-]{1,80}|[a-z0-9-]{1,60})\/?$/;
function storeApp(html,p){if(!STORE_APP_PAGE.test(p)||/^\/store-next\/admin\/?$/.test(p)||!html.includes('</head>')||html.includes('rel="manifest"'))return html;
 const slug=(p.match(/^\/store-next\/([a-z0-9-]{1,60})\/?$/)||[])[1],s=slug&&!['account','merch'].includes(slug)?'?s='+slug:'';
 return html.replace('<meta name="viewport" content="width=device-width,initial-scale=1">','<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">')
  .replace('</head>','<link rel="manifest" href="/store-next/app.webmanifest'+s+'"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Glow Lab"><meta name="apple-mobile-web-app-status-bar-style" content="default">'+SPLASH+'</head>')}
const SPLASH='<link rel="apple-touch-startup-image" href="/img/app/splash-1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1284x2778.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1242x2688.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)">';
function storeManifest(q){const s=/^[a-z0-9-]{1,60}$/.test(q||'')&&!['admin','account','merch'].includes(q)?q:'';
 return JSON.stringify({name:'Glow Lab',short_name:'Glow Lab',description:'Shop Glow Lab Protocols, track your orders and use your Glow Points.',id:'/store-next/',start_url:'/store-next/'+(s?s:'')+'?app=1',scope:'/store-next/',display:'standalone',background_color:'#faf7f2',theme_color:'#faf7f2',
  icons:[{src:'/img/store-app-192.png',sizes:'192x192',type:'image/png'},{src:'/img/store-app-512.png',sizes:'512x512',type:'image/png'},{src:'/img/store-app-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}],
  shortcuts:[{name:'My account',url:'/store-next/account?app=1'},{name:'Bag',url:'/store-next/'+(s?s:'')+'?app=1#bag'}]})}
// Glow Admin phone app (Jonah, 14 Nov 2026: "an app for me and my mom that mimics the admin dashboard"). On the Management
// page only: the app manifest, its own MANAGE icon and full-screen mode, so "Add to Home Screen" makes a separate app.
function adminApp(html,p){if(!/^\/store-next\/admin\/?$/.test(p)||!html.includes('</head>'))return html;
 return html.replace('<link rel="apple-touch-icon" href="/apple-touch-icon.png">','<link rel="apple-touch-icon" href="/img/admin-app-180.png">').replace('<meta name="theme-color" content="#f7f3ec">','<meta name="theme-color" content="#faf7f2">')
  .replace('<meta name="viewport" content="width=device-width,initial-scale=1">','<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">').replace('</head>','<link rel="manifest" href="/store-next/admin.webmanifest"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Glow Admin"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="apple-touch-startup-image" href="/img/app/splash-1170x2532.png" media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1179x2556.png" media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1206x2622.png" media="(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1284x2778.png" media="(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1290x2796.png" media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1320x2868.png" media="(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1125x2436.png" media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-828x1792.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-1242x2688.png" media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"><link rel="apple-touch-startup-image" href="/img/app/splash-750x1334.png" media="(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"></head>')}
function createServer({apiHandler,webhook,ready=async()=>true,transform=async html=>html}={}){
 return http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  const send=(status,data,type='text/plain; charset=utf-8',headers={})=>{res.writeHead(status,{...security,'Content-Type':type,...headers});res.end(req.method==='HEAD'?undefined:data)};
  if(url.pathname==='/health/live')return send(200,'ok');
  if(url.pathname==='/health/ready'){await ready();return send(200,'ready')}
  if(url.pathname==='/.netlify/functions/stripe-webhook'||url.pathname==='/api/stripe-webhook'){
   if(!webhook)return send(503,'Webhook not configured');
   if(req.method!=='POST')return send(405,'Method not allowed');
   const raw=await body(req,512*1024),result=await webhook(raw,req.headers);return send(result.status,result.body,'application/json');
  }
  if(url.pathname==='/.netlify/functions/store-next'||url.pathname.startsWith('/api/')){
   const raw=await body(req,5*1024*1024),route=url.pathname.startsWith('/api/')?url.pathname.slice(4):url.searchParams.get('route');
   const result=await apiHandler({httpMethod:req.method,headers:req.headers,queryStringParameters:{route:route||'/catalog'},body:raw});
   return send(result.statusCode,result.isBase64Encoded?Buffer.from(result.body,'base64'):result.body,'application/json',result.headers);
  }
  if(!['GET','HEAD'].includes(req.method))return send(405,'Method not allowed');
  const host=requestHost(req);
  if(ZADER_HOSTS.has(host)){
   if(host==='www.zaderhealth.com')return send(301,'',undefined,{Location:'https://zaderhealth.com'+url.pathname+url.search});
   let zp;try{zp=decodeURIComponent(url.pathname)}catch{return send(400,'Invalid path')}
   const z=zaderRoute(zp);
   if(z?.redirect)return send(301,'',undefined,{Location:z.redirect});
   if(z?.file){const data=await fs.readFile(path.join(ROOT,z.file));const type=TYPES[path.extname(z.file)];return send(200,type.startsWith('text/html')?data.toString():data,type)}
  }
  const redirects={'/index.html':'/store-next/','/checkout.html':'/store-next/','/checkout':'/store-next/','/cart':'/store-next/','/shop':'/store-next/','/my-account':'/store-next/account','/account':'/store-next/account'};
  if(redirects[url.pathname])return send(302,'',undefined,{Location:redirects[url.pathname]});
  let decoded;try{decoded=decodeURIComponent(url.pathname)}catch{return send(400,'Invalid path')}
  if(decoded==='/store-next/app.webmanifest')return send(200,storeManifest(url.searchParams.get('s')),'application/manifest+json',{'Cache-Control':'no-cache'});
  // Product pages and the sitemap (Jonah, 16 Nov 2026): a shared product link shows the product's name, price and photo,
  // and Google finds every product. Uses the public catalog; if it can't be read, the page is served as usual.
  const catalog=async()=>{try{const r=await apiHandler({httpMethod:'GET',headers:req.headers,queryStringParameters:{route:'/catalog'},body:''});return r.statusCode===200?JSON.parse(r.body).products||[]:null}catch{return null}};
  const siteOrigin=['glowglps.com','www.glowglps.com','glowlabprotocols.com','www.glowlabprotocols.com'].includes(host)?'https://'+host.replace(/^www\./,''):String(process.env.STORE_ORIGIN||'https://glowglps.com').replace(/\/$/,'');
  if(decoded==='/sitemap.xml'){let xml;try{xml=(await fs.readFile(path.join(ROOT,'sitemap.xml'))).toString()}catch{return send(404,'Not found')}const products=await catalog();if(products)xml=require('../../netlify/functions/lib/shop-extras.cjs').sitemapWith(xml,{products,origin:siteOrigin});return send(200,xml,'application/xml',{'Cache-Control':'no-cache'})}
  const productSlug=(decoded.match(/^\/store-next\/p\/([a-z0-9-]{1,80})\/?$/)||[])[1];
  let file=publicFile(decoded);
  if(!file&&/^\/[a-z0-9-]+\/?$/.test(decoded)){
   const info=decoded.replace(/\/$/,'')+'.html';try{await fs.access(path.join(ROOT,info));file=info.slice(1)}catch{return send(302,'',undefined,{Location:'/store-next'+decoded})}
  }
  if(!file)return send(404,'Not found');
  const target=path.resolve(ROOT,file);if(!target.startsWith(ROOT+path.sep))return send(404,'Not found');
  let data;try{data=await fs.readFile(target)}catch{return send(404,'Not found')}
  const type=TYPES[path.extname(file)];
  if(type.startsWith('text/html')){data=storeApp(adminApp(shareCard(await transform(data.toString(),req),decoded),decoded),decoded);if(productSlug){const products=await catalog();if(products)data=require('../../netlify/functions/lib/shop-extras.cjs').productHead(data,{products,slug:productSlug,origin:siteOrigin,brandName:'Glow Lab Protocols'})}return send(200,data,type)}
  // Pages stay no-store. Photos may be kept for an hour; scripts and styles are re-checked on every visit (a 304 when unchanged).
  const etag='"'+crypto.createHash('sha1').update(data).digest('base64url')+'"',cache=type.startsWith('image/')?'public, max-age=3600, stale-while-revalidate=86400':'no-cache',headers={ETag:etag,'Cache-Control':cache};
  if(String(req.headers['if-none-match']||'').split(/\s*,\s*/).map(t=>t.replace(/^W\//,'')).includes(etag)){res.writeHead(304,{...security,...headers});return res.end()}
  return send(200,data,type,headers);
 }catch(e){res.writeHead(e.status||503,{...security,'Content-Type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'Service temporarily unavailable.'}));}});
}
async function start(){
 if(process.env.STORE_LOCAL)throw new Error('STORE_LOCAL must not be set on Sevalla.');
 for(const [key,min]of [['STORE_DATABASE_URL',1],['STORE_ORIGIN',1],['STORE_ADMIN_PASSWORD',12],['STORE_SESSION_SECRET',32]])if(!process.env[key]||process.env[key].length<min)throw new Error('Configure '+key+' in the server environment.');
 const origin=new URL(process.env.STORE_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==process.env.STORE_ORIGIN)throw new Error('STORE_ORIGIN must be the exact HTTPS origin without a trailing slash.');
 const sharp=require('sharp');for(const name of ['affiliate-photos','payment-receipts','catalog-photo-upload'])require('../../netlify/functions/lib/'+name+'.cjs').configureImageProcessor(sharp);
 const {Pool}=require('pg'),probe=new Pool({connectionString:process.env.STORE_DATABASE_URL,max:1,connectionTimeoutMillis:5000});probe.on('error',()=>console.error('Readiness database connection lost.'));
 const handler=require('../../netlify/functions/lib/store-handler.cjs').handler,invoice=require('../../netlify/functions/lib/auto-invoice.cjs'),core=require('../../netlify/functions/lib/store-core.cjs');
 const edge=(await import('../../netlify/edge-functions/fix-product-images.js')).default;
 const server=createServer({apiHandler:handler,ready:()=>probe.query('SELECT 1 FROM glow_store_records LIMIT 1'),transform:async(html,req)=>{const response=await edge(new Request(origin.origin+req.url),{next:async()=>new Response(html,{headers:{'Content-Type':'text/html'}})});return response.text()},webhook:async(raw,headers)=>{
  if(!invoice.verify(raw,headers['stripe-signature']))return{status:400,body:JSON.stringify({error:'Bad signature'})};
  let event;try{event=JSON.parse(raw)}catch{return{status:400,body:JSON.stringify({error:'Bad JSON'})}}
  if(event.type!=='invoice.paid')return{status:200,body:JSON.stringify({received:true,ignored:true})};
  const id=event.data?.object?.id;if(!/^in_[A-Za-z0-9]+$/.test(String(id||'')))return{status:400,body:JSON.stringify({error:'Invalid invoice ID'})};
  const result=await core.stripeInvoicePaid(id);return{status:200,body:JSON.stringify({received:true,result:result.status})};
 }});
 const port=Number(process.env.PORT||8080);server.listen(port,'0.0.0.0',()=>console.log('Glow store listening on port '+port));
 // Autopilot: background jobs inside this process (Sevalla runs only the web process). Each job is OFF until the owner switches it on.
 require('../../netlify/functions/lib/autopilot.cjs').start();
 // Phone app: new-order alerts to the phones that turned them on in Management → Today (web-push.cjs).
 require('../../netlify/functions/lib/web-push.cjs').start();
 for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{server.close(()=>probe.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(1),15000).unref()});
}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={createServer,publicFile,zaderRoute,shareCard,adminApp,storeApp,storeManifest};

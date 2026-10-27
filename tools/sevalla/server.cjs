'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const ROOT=path.resolve(__dirname,'../..');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8','.xml':'application/xml','.pdf':'application/pdf'};
const security={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cache-Control':'no-store'};
async function body(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Request too large'),{status:413});chunks.push(chunk)}return Buffer.concat(chunks).toString('utf8')}
function publicFile(p){
 if(p==='/'||p==='/store-next'||p==='/store-next/'||/^\/store-next\/(?:profile\/[a-z0-9-]+|[a-z0-9-]+)\/?$/.test(p)&&!p.includes('/merch'))return 'store-next/index.html';
 if(/^\/store-next\/merch\/?$/.test(p))return 'store-next/merch.html';
 const rel=p.replace(/^\//,'');
 if(rel.split('/').some(x=>!x||x.startsWith('.')||x==='..'))return null;
 if(!TYPES[path.extname(rel)])return null;
 if(!rel.includes('/')||/^(img|product-images|store-next)\//.test(rel))return rel;
 return null;
}
function createServer({apiHandler,webhook,ready=async()=>true,transform=async html=>html}={}){
 return http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  const send=(status,data,type='text/plain; charset=utf-8',headers={})=>{res.writeHead(status,{...security,'Content-Type':type,...headers});res.end(req.method==='HEAD'?undefined:data)};
  if(url.pathname==='/health/live')return send(200,'ok');
  if(url.pathname==='/health/ready'){await ready();return send(200,'ready')}
  if(url.pathname==='/.netlify/functions/stripe-webhook'){
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
  const redirects={'/index.html':'/store-next/','/checkout.html':'/store-next/','/checkout':'/store-next/','/cart':'/store-next/','/shop':'/store-next/','/my-account':'/store-next/account','/account':'/store-next/account'};
  if(redirects[url.pathname])return send(302,'',undefined,{Location:redirects[url.pathname]});
  let decoded;try{decoded=decodeURIComponent(url.pathname)}catch{return send(400,'Invalid path')}
  let file=publicFile(decoded);
  if(!file&&/^\/[a-z0-9-]+\/?$/.test(decoded)){
   const info=decoded.replace(/\/$/,'')+'.html';try{await fs.access(path.join(ROOT,info));file=info.slice(1)}catch{return send(302,'',undefined,{Location:'/store-next'+decoded})}
  }
  if(!file)return send(404,'Not found');
  const target=path.resolve(ROOT,file);if(!target.startsWith(ROOT+path.sep))return send(404,'Not found');
  let data;try{data=await fs.readFile(target)}catch{return send(404,'Not found')}
  const type=TYPES[path.extname(file)];
  if(type.startsWith('text/html'))data=await transform(data.toString(),req);
  return send(200,data,type);
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
 for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{server.close(()=>probe.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(1),15000).unref()});
}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={createServer,publicFile};

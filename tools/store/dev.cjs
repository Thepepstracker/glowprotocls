'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
process.env.STORE_LOCAL='1';process.env.STORE_ADMIN_PASSWORD=process.env.STORE_ADMIN_PASSWORD||crypto.randomBytes(12).toString('hex');process.env.STORE_SESSION_SECRET=process.env.STORE_SESSION_SECRET||crypto.randomBytes(32).toString('hex');
const port=Number(process.env.PORT||8787);process.env.STORE_ORIGIN=`http://127.0.0.1:${port}`;
const root=path.resolve(__dirname,'../..'),{transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('./seed-data.cjs'),{handler}=require('../../netlify/functions/lib/store-handler.cjs');
const content={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp'};
transaction(seed).then(()=>{
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/.netlify/functions/store-next'){
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>5*1024*1024){res.writeHead(413);res.end('Request too large');return}}
  const result=await handler({httpMethod:req.method,headers:req.headers,queryStringParameters:Object.fromEntries(url.searchParams),body:raw});res.writeHead(result.statusCode,result.headers);res.end(result.isBase64Encoded?Buffer.from(result.body,'base64'):result.body);return;
 }
 if(req.method!=='GET'){res.writeHead(405);res.end('Method not allowed');return}
 let target;
 if(/^\/store-next\/?$/.test(url.pathname)||/^\/store-next\/(admin|[a-z0-9-]+)\/?$/.test(url.pathname))target=path.join(root,'store-next/index.html');
 else{let clean;try{clean=decodeURIComponent(url.pathname)}catch{res.writeHead(400);res.end();return}target=path.resolve(root,'.'+clean)}
 const rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel)||rel.split(path.sep).some(p=>p.startsWith('.'))||!content[path.extname(target)]){res.writeHead(404);res.end('Not found');return}
 fs.readFile(target,(error,data)=>{if(error){res.writeHead(404);res.end('Not found');return}res.writeHead(200,{'Content-Type':content[path.extname(target)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data)})
});server.listen(port,'127.0.0.1',()=>console.log(`Standalone test store: http://127.0.0.1:${port}/store-next/\nDashboard: http://127.0.0.1:${port}/store-next/admin\nAdmin password: ${process.env.STORE_ADMIN_PASSWORD}\nTest mode only. Payments, GoAffPro and ShipStation are disconnected.`));
}).catch(e=>{console.error(e.message);process.exitCode=1});

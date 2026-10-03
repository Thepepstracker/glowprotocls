'use strict';
const {handle}=require('./lib/store-core.cjs');
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function parseBody(raw){try{return raw?JSON.parse(raw):{}}catch{throw Object.assign(new Error('Invalid JSON.'),{status:400})}}
exports.handler=async event=>{
 try{
  const path=(event.queryStringParameters?.route||'').replace(/\/$/,'')||'/catalog';
  const raw=event.isBase64Encoded?Buffer.from(event.body||'','base64').toString():event.body||'';
  if(Buffer.byteLength(raw)>5*1024*1024)return{statusCode:413,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({error:'Request exceeds the upload limit.'})};
  const result=await handle({path,method:event.httpMethod,headers:event.headers,body:parseBody(raw)});
  if(result.body?._binary)return{statusCode:200,headers:{...headers,...result.headers,'Content-Type':result.body._type},body:result.body._binary,isBase64Encoded:true};
  return{statusCode:result.status,headers:{...headers,...result.headers,'Content-Type':'application/json'},body:JSON.stringify(result.body)};
 }catch(e){return{statusCode:e.status||500,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({error:e.status?e.message:'Store request failed. Please try again.'})}}
};

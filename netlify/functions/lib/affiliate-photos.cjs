'use strict';
const crypto=require('node:crypto');
let imageProcessor;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function configureImageProcessor(factory){imageProcessor=factory}
async function authorize(store,slug,token){
 const a=await store.get('affiliates',slug);
 const expected=Buffer.from(a?.photo_link_hash||''),actual=Buffer.from(hash(typeof token==='string'?token:''));
 if(!a?.active||!a.photo_link_expires||a.photo_link_expires<=Math.floor(Date.now()/1000)||expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual))fail('This photo upload link is unavailable or expired. Ask the store owner for a new link.',403);
 return a;
}
async function issueLink(store,slug){
 const a=await store.get('affiliates',slug);if(!a?.active)fail('Enable this storefront before creating its photo upload link.',404);
 const token=crypto.randomBytes(32).toString('base64url');a.photo_link_hash=hash(token);a.photo_link_expires=Math.floor(Date.now()/1000)+30*86400;
 await store.put('affiliates',slug,a);return{slug,token,expires:a.photo_link_expires};
}
async function encodePhoto(body){
 const formats={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
 if(!formats[body.mime]||typeof body.file!=='string'||body.file.length>4200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.file))fail('Choose a JPEG, PNG, or WebP photo up to 3 MB.');
 const raw=Buffer.from(body.file,'base64');if(!raw.length||raw.length>3*1024*1024)fail('Choose a photo up to 3 MB.');
 const signatures={'image/png':Buffer.from([137,80,78,71,13,10,26,10]),'image/jpeg':Buffer.from([255,216,255]),'image/webp':Buffer.from('RIFF')};
 const signature=signatures[body.mime];
 if(!raw.subarray(0,signature.length).equals(signature)||(body.mime==='image/webp'&&raw.subarray(8,12).toString()!=='WEBP'))fail('Choose a still JPEG, PNG, or WebP photo matching its file type.');
 const sharp=imageProcessor||(process.env.STORE_LOCAL?require('sharp'):null);if(!sharp)fail('Photo processing is not configured.',503);
 try{
  const image=sharp(raw,{limitInputPixels:25000000,failOn:'warning'}),metadata=await image.metadata();
  if(metadata.format!==formats[body.mime]||(metadata.pages||1)!==1)fail('Choose a still JPEG, PNG, or WebP photo.');
  // Decode and re-encode: retain no original bytes, EXIF, location data or embedded metadata.
  const output=await image.rotate().resize(512,512,{fit:'cover',position:'centre'}).flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer();
  if(output.length>512000)fail('This photo could not be resized. Choose another photo.');
  return{data:output.toString('base64'),mime:'image/jpeg',updated:Math.floor(Date.now()/1000)};
 }catch(e){if(e.status)throw e;fail('This photo could not be read. Choose a valid JPEG, PNG, or WebP image.')}
}
module.exports={configureImageProcessor,authorize,issueLink,encodePhoto};

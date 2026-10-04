'use strict';
let imageProcessor;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function configureImageProcessor(factory){imageProcessor=factory}
async function encodeReceipt(body){
 const formats={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
 if(!formats[body.mime]||typeof body.file!=='string'||body.file.length>4200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.file))fail('Choose a PNG, JPEG, or WebP screenshot up to 3 MB.');
 const raw=Buffer.from(body.file,'base64');if(!raw.length||raw.length>3*1024*1024)fail('Screenshot format is invalid or exceeds 3 MB.');
 const sharp=imageProcessor||(process.env.STORE_LOCAL?require('sharp'):null);if(!sharp)fail('Receipt processing is not configured.',503);
 try{
  const image=sharp(raw,{limitInputPixels:25000000,failOn:'warning'}),meta=await image.metadata();
  if(meta.format!==formats[body.mime]||(meta.pages||1)!==1)fail('Screenshot format is invalid. Choose a still image matching its file type.');
  // Keep the entire receipt readable, without cropping or retaining embedded metadata.
  const output=await image.rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:90}).toBuffer();
  if(output.length>3*1024*1024)fail('Screenshot is too large after processing.');
  return{data:output.toString('base64'),mime:'image/jpeg'};
 }catch(e){if(e.status)throw e;fail('Screenshot format is invalid or incomplete. Choose a readable PNG, JPEG, or WebP image.')}
}
module.exports={configureImageProcessor,encodeReceipt};

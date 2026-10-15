'use strict';
const crypto=require('node:crypto');
let processor;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
function configureImageProcessor(factory){processor=factory}
function eligible(p){return !!p?.sku&&!/^information-/i.test(p.sku)}
async function encodePhoto(photo){
 const formats={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
 if(!photo||!formats[photo.mime]||typeof photo.file!=='string'||photo.file.length>4200000||!/^[A-Za-z0-9+/]+={0,2}$/.test(photo.file))fail('Choose a still JPG, PNG, or WebP photo, up to 3 MB.');
 const raw=Buffer.from(photo.file,'base64');if(!raw.length||raw.length>3*1024*1024)fail('Choose a photo up to 3 MB.');
 const sharp=processor||(process.env.STORE_LOCAL?require('sharp'):null);if(!sharp)fail('Product photo processing is not configured.',503);
 try{
  const image=sharp(raw,{limitInputPixels:25000000,failOn:'warning'}),meta=await image.metadata();
  if(meta.format!==formats[photo.mime]||(meta.pages||1)!==1)fail('Choose a still JPG, PNG, or WebP image matching its file type.');
  const out=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:88}).toBuffer();
  if(out.length>1500000)fail('The processed photo is too large. Choose a smaller image.');
  return {data:out.toString('base64'),mime:'image/webp',created:Math.floor(Date.now()/1000)};
 }catch(e){if(e.status)throw e;fail('This image could not be read. Choose another JPG, PNG, or WebP photo.')}
}
const imageUrl=id=>'/.netlify/functions/store-next?route='+encodeURIComponent('/product-images/'+id);
async function applyPhotoUpdate(s,product,update){
 if(update===undefined)return product;
 if(update?.expected_revision!==undefined&&update.expected_revision!==(product.photo_revision||0))fail('Photos changed since you opened this product. Refresh and try again.',409);
 if(!eligible(product))fail('Photo uploads are unavailable for reference-only items.');
 if(!update||typeof update!=='object'||Array.isArray(update))fail('Invalid photo update.');
 const existing=[...new Set([product.image,...(product.additional_images||[])].filter(Boolean))];
 const keep=update.keep===undefined?[...(product.additional_images||[])]:update.keep;
 if(!Array.isArray(keep)||keep.length>12||keep.some(url=>typeof url!=='string'||!existing.includes(url)))fail('Refresh the product before changing its saved photos.');
 const additions=update.add||[];if(!Array.isArray(additions)||additions.length>4)fail('Add up to four extra photos at a time.');
 const uploads=[...(update.hero?[update.hero]:[]),...additions];
 if(uploads.reduce((n,p)=>n+(typeof p?.file==='string'?p.file.length:4200001),0)>4200000)fail('Choose photos totaling up to 3 MB per save.');
 if(update.featured_existing&&!existing.includes(update.featured_existing))fail('Choose a featured photo already saved on this product.');
 let hero=update.remove_hero?'':product.image||'';if(update.featured_existing)hero=update.featured_existing;
 const encoded=[];for(const photo of uploads)encoded.push(await encodePhoto(photo));
 let next=0;const write=async image=>{const id=crypto.randomBytes(16).toString('hex');await s.put('catalog_images',id,image);return imageUrl(id)};
 if(update.hero)hero=await write(encoded[next++]);
 const gallery=[...keep];for(;next<encoded.length;next++)gallery.push(await write(encoded[next]));
 const photos=[...new Set(gallery)].filter(url=>url!==hero);if(photos.length>12)fail('Keep up to 12 additional photos on each listing.');
 const changedHero=hero!==product.image;const updated={...product,image:hero,additional_images:photos,photo_revision:(product.photo_revision||0)+1};
 if(changedHero&&product.merch_design)updated.model_color='';
 return updated;
}
module.exports={configureImageProcessor,eligible,encodePhoto,applyPhotoUpdate,imageUrl};

'use strict';
const crypto=require('node:crypto'),accounts=require('./customer-accounts.cjs'),brands=require('./brands.cjs');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const fresh=()=>({title:'My Christmas wish list',items:[],revision:0,share_token:null});
const token=()=>crypto.randomBytes(32).toString('base64url');
// Deliberately no customer IDs, contact details, orders, purchases or fulfillment state in this DTO.
async function view(s,r,project){const items=[];for(const id of r.items){const p=await s.get('products',id);if(!p?.active||brands.productBrand(p)!=='glow'){items.push({id,available:false,name:'Product currently unavailable'});continue}const x=await project(s,p);items.push({id,name:x.name,price:x.price,image:x.image||'',available:x.stock>0})}return{title:r.title,items}}
async function route(s,{path,method,headers:h,body,brand,project}){
 if(brand.id!=='glow')fail('Registry not found.',404);
 if(path==='/registry/shared'&&method==='GET'){
  const raw=h['x-registry-token'];if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw))fail('This wish list link is unavailable.',404);
  const index=await s.get('registry_links',accounts.hash(raw));const r=index&&await s.get('gift_registries',index.owner);
  if(!r?.share_token||r.share_token!==raw)fail('This wish list link is unavailable.',404);
  return view(s,r,project);
 }
 if(path!=='/registry'||!['GET','POST'].includes(method))fail('Registry not found.',404);
 const a=await accounts.session(s,h,true);let r=await s.get('gift_registries',a.id)||fresh();
 if(method==='POST'){
  if(!Number.isSafeInteger(body.expected_revision)||body.expected_revision!==r.revision)fail('Your wish list changed in another window. Reload it before editing.',409);
  // Rate limit only this account; do not depend on client-controlled forwarding headers.
  const now=Math.floor(Date.now()/1000),key=a.id,old=await s.get('registry_limits',key),limit=old?.until>now?old:{count:0,until:now+60};if(limit.count>=60)fail('Too many wish list edits. Try again in a minute.',429);
  switch(body.action){
   case 'add': {
    if(!Number.isSafeInteger(body.product_id)||body.product_id<1)fail('Choose a valid product.');
    const p=await s.get('products',body.product_id);if(!p?.active||brands.productBrand(p)!=='glow')fail('This product is unavailable.',404);
    if(!r.items.includes(p.id)){if(r.items.length>=100)fail('Your wish list can contain up to 100 products.');r.items.push(p.id)}break;
   }
   case 'remove':if(!Number.isSafeInteger(body.product_id))fail('Choose a valid product.');r.items=r.items.filter(id=>id!==body.product_id);break;
   case 'rename':if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>80||/[\x00-\x1f\x7f]/.test(body.title))fail('Use a wish list title with 1–80 characters.');r.title=body.title.trim();break;
   case 'share':case 'rotate':
    if(body.action==='rotate'||!r.share_token){if(r.share_token)await s.remove('registry_links',accounts.hash(r.share_token));r.share_token=token();await s.put('registry_links',accounts.hash(r.share_token),{owner:a.id})}break;
   case 'unshare':if(r.share_token)await s.remove('registry_links',accounts.hash(r.share_token));r.share_token=null;break;
   default:fail('Choose a valid wish list action.');
  }
  r.revision++;r.updated=now;limit.count++;await s.put('registry_limits',key,limit);await s.put('gift_registries',a.id,r);
 }
 return{...await view(s,r,project),revision:r.revision,share_token:r.share_token};
}
module.exports={route};

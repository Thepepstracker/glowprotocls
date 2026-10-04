'use strict';
const crypto=require('node:crypto');
const reserved=new Set(['admin','account','account-setup','api','shop','store-next']);
function validSlug(slug){return typeof slug==='string'&&slug.length<=60&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)&&!reserved.has(slug)}
function nameSlug(name){return name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,45).replace(/-$/,'')||'affiliate'}
async function createStorefronts(store,profiles){
 const all=await store.list('affiliates'),slugs=new Set(all.map(a=>a.slug));
 const byId=new Map(all.filter(a=>a.goaffpro_id).map(a=>[String(a.goaffpro_id),a]));
 const result={created:0,existing:0,skipped:0,storefronts:[]};
 for(const profile of profiles){
  // Approval and identity come from the server-side API response, never the browser preview.
  if(profile.status!=='approved'||!profile.id||!profile.name.trim()){result.skipped++;continue}
  const old=byId.get(profile.id);
  if(old){result.existing++;result.storefronts.push({slug:old.slug,name:old.name,active:old.active});continue}
  const base=nameSlug(profile.name),suffix=crypto.createHash('sha256').update(profile.id).digest('hex').slice(0,8);
  let slug=base;if(!validSlug(slug)||slugs.has(slug))slug=base+'-'+suffix;
  for(let n=2;slugs.has(slug)||!validSlug(slug);n++)slug=base+'-'+suffix+'-'+n;
  const affiliate={slug,name:profile.name.trim(),bio:'',goaffpro_id:profile.id,goaffpro_ref_code:profile.ref_code,commission_bps:1500,active:1,source:'goaffpro',created:Math.floor(Date.now()/1000)};
  await store.put('affiliates',slug,affiliate);slugs.add(slug);byId.set(profile.id,affiliate);
  result.created++;result.storefronts.push({slug,name:affiliate.name,active:1});
 }
 return result;
}
module.exports={validSlug,createStorefronts};

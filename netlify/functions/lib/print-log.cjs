'use strict';
// Print log (Jonah, 9 Nov 2026): "an update on the packing.html, that we can see which of them have been printed or not".
// Packing Check records every time a shipping label or packing slip is printed (sent to the label printer, opened to
// print, or printed from the browser), on the server, so every computer sees the same ✓ Printed / Not printed.
// One small record per order or manual shipment (print_log). It never changes the order itself.
const {transaction}=require('./store-db.cjs');
const now=()=>Math.floor(Date.now()/1000);
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const ID=/^(GLP|ZDR|PEP|SHIP|REP)-[A-Z0-9-]{4,40}$/,WHAT=['label','slip'],VIA=['printer','opened','browser','earlier'];
const KEEP=45*86400;

async function route(path,body,h,method,{session}){
 if(path!=='/admin/printed')return null;
 const who=await transaction(async s=>{const sid=await session(s,h);return (await s.get('sessions',sid))?.staff_id||'owner'});
 const ok=b=>({status:200,headers:{},body:b});
 if(method==='GET')return ok(await transaction(async s=>{const cut=now()-KEEP,out={};for(const r of await s.list('print_log'))if((r.updated||0)>=cut)out[r.id]={label:r.label||null,slip:r.slip||null};return{printed:out}}));
 if(method==='POST'){
  const what=String(body.what||''),via=String(body.via||'printer'),ids=[...new Set((Array.isArray(body.ids)?body.ids:[body.id]).map(x=>String(x||'').toUpperCase()))].filter(x=>ID.test(x)).slice(0,100);
  if(!WHAT.includes(what))bad('Say label or slip.');if(!VIA.includes(via))bad('Unknown print method.');if(!ids.length)bad('No order to mark.');
  const at=via==='earlier'&&Number.isFinite(Number(body.at))&&Number(body.at)>1.6e9&&Number(body.at)<=now()+60?Math.floor(Number(body.at)):now();
  return ok(await transaction(async s=>{const out={};for(const id of ids){const r=await s.get('print_log',id)||{id};const prev=r[what];
   if(via==='earlier'&&prev)continue; // moving an old record from one computer never overwrites a real one
   r[what]={at,by:who,via,count:(prev?.count||0)+1,first:prev?.first||at};r.updated=now();await s.put('print_log',id,r);out[id]={label:r.label||null,slip:r.slip||null}}return{printed:out}}))}
 bad('Not found.',404);
}
module.exports={route};

'use strict';
// Serum Station (Jonah, 24 Nov 2026: "create an area just like packing.html, but for the serum making … beautiful").
// The page (store-next/serumsbuild.html) holds the recipes and does the scaling. This file keeps the batch log and,
// when a batch is finished, adds the bottles to each product's stock in one step:
//   POST /admin/serums/batch       record a finished batch (+ bottles to stock). Same click key twice = recorded once.
//   GET  /admin/serums/batches     the batch log, newest first.
//   POST /admin/serums/batch/void  undo a batch typed by mistake: takes its bottles back off stock and marks it void.
// Records live in `serum_batches`. Lot numbers: <CODE>-<YYYYMMDD>-<NN>, e.g. P01-20261124-01 (Eastern date).
const crypto=require('node:crypto');
const now=()=>Math.floor(Date.now()/1000);
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const str=(v,max,req=false)=>{if(v==null)v='';if(typeof v!=='string')bad('Invalid text field.');v=v.trim();if(req&&!v)bad('Complete the required fields.');if(v.length>max)bad('A field is too long.');return v};
const whole=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)bad('Enter a whole number from '+min+' to '+max+'.');return v};
const num=(v,min,max)=>{const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)bad('Enter a number from '+min+' to '+max+'.');return Math.round(n*1000)/1000};
const easternDay=t=>new Date(t*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'}).replace(/-/g,'');

async function list(s){return (await s.list('serum_batches')).sort((a,b)=>(b.created-a.created)||String(b.lot).localeCompare(String(a.lot))).slice(0,300)}

// setStock(s,p,stock) is the store's own setter: it moves every product that shares the stock group too.
async function record(s,body,actor,setStock){
 const key=str(body.key,100,true),id='sb-'+hash(key).slice(0,20);
 const prior=await s.get('serum_batches',id);if(prior)return{ok:true,already:true,batch:prior};
 const recipe=str(body.recipe,40,true).toLowerCase();if(!/^[a-z0-9-]+$/.test(recipe))bad('Unknown recipe.');
 const code=str(body.code||'',8).toUpperCase().replace(/[^A-Z0-9]/g,'')||'SER';
 const name=str(body.name,80,true),made_by=str(body.made_by,60,true),ph=str(body.ph,12),notes=str(body.notes,600);
 const batch_g=num(body.batch_g??0,0,100000);
 const ings=Array.isArray(body.ingredients)?body.ingredients.slice(0,25):[];
 const ingredients=ings.map(x=>({name:str(x&&x.name,60,true),amount:num(x&&x.amount,0,100000),unit:str(x&&x.unit,6,true)}));
 const raw=Array.isArray(body.yields)?body.yields.slice(0,6):[];const addStock=body.add_stock!==false;
 if(!raw.length&&!(batch_g>0&&!addStock))bad('Enter how many bottles you filled.');const yields=[];const seen=new Set();
 for(const y of raw){const pid=whole(y&&y.id,1,10000000),q=whole(y&&y.quantity,0,5000);if(seen.has(pid))bad('A product is listed twice.');seen.add(pid);
  const p=await s.get('products',pid);if(!p)bad('A product was not found. Refresh the page and try again.',404);
  const line={id:p.id,name:p.name,quantity:q,added:0};
  if(addStock&&q>0){line.stock_before=Number(p.stock)||0;await setStock(s,p,line.stock_before+q);line.stock_after=line.stock_before+q;line.added=q}
  yields.push(line)}
 if(!yields.some(y=>y.quantity>0)&&!(batch_g>0&&!addStock))bad('Enter how many bottles you filled.');
 const t=now(),day=easternDay(t),same=(await s.list('serum_batches')).filter(b=>b.code===code&&b.day===day).length;
 const lot=code+'-'+day+'-'+String(same+1).padStart(2,'0');
 const batch={id,key_hash:hash(key),created:t,day,lot,code,recipe,name,made_by,ph,notes,batch_g,ingredients,yields,added_to_stock:addStock,by:actor||'owner'};
 await s.put('serum_batches',id,batch);return{ok:true,batch}}

async function voidBatch(s,body,actor,setStock){
 const b=await s.get('serum_batches',str(body.id,40,true));if(!b)bad('Batch not found.',404);if(b.voided_at)return{ok:true,already:true,batch:b};
 for(const y of b.yields||[]){if(!y.added)continue;const p=await s.get('products',y.id);if(!p)continue;const cur=Number(p.stock)||0;
  if(cur<y.added)bad('Only '+cur+' '+p.name+' are left in stock, so '+y.added+' cannot be taken back off. Fix the count in Management instead.',409)}
 for(const y of b.yields||[]){if(!y.added)continue;const p=await s.get('products',y.id);if(!p)continue;await setStock(s,p,(Number(p.stock)||0)-y.added)}
 b.voided_at=now();b.voided_by=actor||'owner';await s.put('serum_batches',b.id,b);return{ok:true,batch:b}}

async function route(s,path,method,body,actor,setStock){
 if(path==='/admin/serums/batches'&&method==='GET')return{batches:await list(s)};
 if(path==='/admin/serums/batch'&&method==='POST')return record(s,body,actor,setStock);
 if(path==='/admin/serums/batch/void'&&method==='POST')return voidBatch(s,body,actor,setStock);
 return null}

module.exports={route,record,voidBatch,list,easternDay};

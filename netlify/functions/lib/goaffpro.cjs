'use strict';
const crypto=require('node:crypto');
const key=()=>process.env.GOAFFPRO_ACCESS_TOKEN?.trim()||'';
const fingerprint=()=>crypto.createHash('sha256').update(key()).digest('hex');
function status(record){return{configured:!!key(),verified:!!key()&&record?.fingerprint===fingerprint(),checked_at:record?.fingerprint===fingerprint()?record.checked_at:null,order_reporting:false}}
const fail=(message,status)=>{throw Object.assign(new Error(message),{status})};
async function checkConnection(){
 if(!key())fail('Save GOAFFPRO_ACCESS_TOKEN in Netlify before checking the connection.',503);
 let response;
 try{response=await fetch('https://api.goaffpro.com/v1/admin/affiliates?fields=id,name,ref_code,status&status=approved&limit=100&offset=0',{headers:{'x-goaffpro-access-token':key(),Accept:'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'})}catch{fail('GoAffPro could not be reached. Please try again.',502)}
 if(response.status===401||response.status===403)fail('GoAffPro rejected the key. Check the access token and affiliate.profile.read permission.',502);
 if(response.status===429)fail('GoAffPro is limiting requests. Wait a moment before trying again.',503);
 if(!response.ok)fail('GoAffPro returned an error. Please try again later.',502);
 let data;try{data=await response.json()}catch{fail('GoAffPro returned an unreadable response.',502)}
 if(!Array.isArray(data?.affiliates)||data.affiliates.length>100)fail('GoAffPro returned an unexpected affiliate list.',502);
 const clean=(v,max)=>typeof v==='string'?v.slice(0,max):'';
 const affiliates=data.affiliates.map(a=>({id:typeof a?.id==='string'||Number.isSafeInteger(a?.id)?String(a.id).slice(0,100):'',name:clean(a?.name,150),ref_code:clean(a?.ref_code,100),status:clean(a?.status,30)}));
 if(affiliates.some(a=>!a.id))fail('GoAffPro returned an affiliate without an ID.',502);
 return{affiliates,record:{fingerprint:fingerprint(),checked_at:Math.floor(Date.now()/1000)},limit:100};
}
module.exports={status,checkConnection};

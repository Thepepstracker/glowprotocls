'use strict';
const crypto=require('node:crypto');
const key=()=>process.env.GOAFFPRO_ACCESS_TOKEN?.trim()||'';
const fingerprint=()=>crypto.createHash('sha256').update(key()).digest('hex');
function status(record){return{configured:!!key(),verified:!!key()&&record?.fingerprint===fingerprint(),checked_at:record?.fingerprint===fingerprint()?record.checked_at:null,order_reporting:true,reporting_read_verified:!!key()&&record?.fingerprint===fingerprint()&&!!record.reporting_checked_at}}
const fail=(message,status)=>{throw Object.assign(new Error(message),{status})};
async function request(path,body){
 if(!key())throw Object.assign(new Error('GoAffPro access token is not configured.'),{status:503,kind:'authorization'});
 let response;try{response=await fetch('https://api.goaffpro.com/v1'+path,{method:body?'POST':'GET',headers:{'x-goaffpro-access-token':key(),Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(6000),redirect:'error'})}catch{throw Object.assign(new Error('GoAffPro could not be reached. Check the reporting status before trying again.'),{status:502,kind:'connection'})}
 if([401,403].includes(response.status))throw Object.assign(new Error('GoAffPro rejected this request. The key needs sales.read, sales.write, affiliate.profile.read and affiliate.email.read.'),{status:502,kind:'authorization'});
 if(!response.ok)throw Object.assign(new Error('GoAffPro returned an error. Check the reporting status.'),{status:502,kind:'response'});
 let data;try{data=await response.json()}catch{throw Object.assign(new Error('GoAffPro returned an unreadable response.'),{status:502,kind:'response'})}
 if(data?.error||data?.result?.error)throw Object.assign(new Error('GoAffPro did not confirm this request. Check the reporting status.'),{status:502,kind:'response'});
 return data;
}
async function reportingCheck(){
 const orders=await request('/admin/orders?fields=id,number&limit=1');if(!Array.isArray(orders?.orders))fail('GoAffPro returned an unexpected order response.',502);
 const profiles=await request('/admin/affiliates?fields=id,status,email&status=approved&limit=1');if(!Array.isArray(profiles?.affiliates))fail('GoAffPro returned an unexpected affiliate response.',502);
 if(!profiles.affiliates.length||!profiles.affiliates[0].email)fail('The key must allow affiliate.email.read so the store can block self-purchases. Check this permission in GoAffPro.',502);
 return{fingerprint:fingerprint(),checked_at:Math.floor(Date.now()/1000),reporting_checked_at:Math.floor(Date.now()/1000)};
}
async function checkConnection(offset=0){
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('Invalid affiliate page.',400);
 if(!key())fail('Save GOAFFPRO_ACCESS_TOKEN in Netlify before checking the connection.',503);
 let response;
 try{response=await fetch('https://api.goaffpro.com/v1/admin/affiliates?fields=id,name,ref_code,status&status=approved&limit=100&offset='+offset,{headers:{'x-goaffpro-access-token':key(),Accept:'application/json'},signal:AbortSignal.timeout(8000),redirect:'error'})}catch{fail('GoAffPro could not be reached. Please try again.',502)}
 if(response.status===401||response.status===403)fail('GoAffPro rejected the key. Check the access token and affiliate.profile.read permission.',502);
 if(response.status===429)fail('GoAffPro is limiting requests. Wait a moment before trying again.',503);
 if(!response.ok)fail('GoAffPro returned an error. Please try again later.',502);
 let data;try{data=await response.json()}catch{fail('GoAffPro returned an unreadable response.',502)}
 if(!Array.isArray(data?.affiliates)||data.affiliates.length>100)fail('GoAffPro returned an unexpected affiliate list.',502);
 const clean=(v,max)=>typeof v==='string'?v.slice(0,max):'';
 const affiliates=data.affiliates.map(a=>({id:typeof a?.id==='string'||Number.isSafeInteger(a?.id)?String(a.id).slice(0,100):'',name:clean(a?.name,150),ref_code:clean(a?.ref_code,100),status:clean(a?.status,30)}));
 if(affiliates.some(a=>!a.id))fail('GoAffPro returned an affiliate without an ID.',502);
 return{affiliates,record:{fingerprint:fingerprint(),checked_at:Math.floor(Date.now()/1000)},limit:100,offset,has_more:data.affiliates.length===100};
}
module.exports={status,checkConnection,request,reportingCheck,fingerprint};

'use strict';
const fail=message=>{throw Object.assign(new Error(message),{status:400})};
const cents=(v,label)=>{if(!Number.isSafeInteger(v)||v<0||v>10000000)fail('Enter a valid '+label+' in cents.');return v};
const flag=(v,label)=>{if(![true,false,0,1].includes(v))fail('Choose a valid '+label+'.');return !!v};
const copy=(v,max,label)=>{if(typeof v!=='string'||v.trim().length>max)fail('Enter '+label+' within '+max+' characters.');return v.trim()};
// Store the actual checkout price on the product, so every quote, coupon,
// reservation and order uses the same amount as the spotlight and catalog.
function apply(old,body){
 const regular=cents(body.price??old.regular_price??old.price,'regular price');
 const intro=body.intro_price===null||body.intro_price===''?null:body.intro_price===undefined?(old.intro_price??null):cents(body.intro_price,'introductory price');
 const active=flag(body.intro_active??old.intro_active??false,'introductory price setting');
 if(active&&(intro===null||intro>=regular))fail('The introductory price must be lower than the regular price.');
 return{regular_price:regular,intro_price:intro,intro_active:active,price:active?intro:regular,
 spotlight:flag(body.spotlight??old.spotlight??false,'spotlight setting'),
 spotlight_headline:copy(body.spotlight_headline??old.spotlight_headline??'',120,'a spotlight heading'),
 spotlight_copy:copy(body.spotlight_copy??old.spotlight_copy??'',600,'spotlight text'),
 spotlight_note:copy(body.spotlight_note??old.spotlight_note??'',150,'a spotlight offer note')};
}
module.exports={apply};

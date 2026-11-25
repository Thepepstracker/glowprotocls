'use strict';
// Glow chat (Jonah, 25 Nov 2026): customer chat bubble backed by Claude. Claude is replaced by a scripted stand-in here.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-chat-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'chat-tests-session-secret-32-chars!!!',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
delete process.env.ANTHROPIC_API_KEY;
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs');
const bot=require('../../netlify/functions/lib/chatbot.cjs');
let ipn=0;const call=(p,b,cookie,extra)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1','x-forwarded-for':'10.0.0.'+(extra?.ip??1),...(cookie?{cookie}:{}),...(extra?.host?{host:extra.host}:{})},body:b||{}});
const oldFetch=global.fetch;global.fetch=async u=>{throw new Error('unexpected fetch '+u)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
// Scripted Claude: each step is a function of the request body that returns an API response.
let script=[],seen=[];
bot._setFetch(async(url,opts)=>{const body=JSON.parse(opts.body);seen.push(body);const step=script.shift();if(!step)throw new Error('no scripted reply');const r=step(body);return{ok:r.status?false:true,status:r.status||200,json:async()=>r.json||r}});
const say=t=>()=>({stop_reason:'end_turn',content:[{type:'text',text:t}],usage:{input_tokens:100,output_tokens:20}});
const use=(name,input,id='t'+Math.random())=>()=>({stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}],usage:{input_tokens:100,output_tokens:10}});
const lastResult=body=>JSON.parse(body.messages[body.messages.length-1].content[0].content);
let owner,P;

test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 P=await transaction(async s=>{const p=(await s.list('products')).find(p=>p.active&&!(p.components||[]).length&&!(Number(p.units)>1));p.stock=7;await s.put('products',p.id,p);
  await s.put('orders','GLP-0123456789',{id:'GLP-0123456789',created:1795400000,status:'shipped',is_test:false,brand:'glow',total:12345,customer:{name:'Pat Lee',email:'Pat@Example.org',address:'1 Secret St',city:'Town',state:'GA',zip:'30107',phone:'5551234567'},items:[{id:p.id,name:p.name,quantity:2}],tracking:'1Z999AA10123456784',shipment:{carrier:'ups',service:'UPS Ground',tracking:'1Z999AA10123456784'},delivery:{state:'in_transit'}});
  return p})});

test('without an API key the bubble stays off and chat answers politely',async()=>{
 assert.equal((await call('/chat/status')).body.on,false);
 const r=await call('/chat',{cid:'abcdefabcdef12',messages:[{role:'user',content:'hi'}]});assert.equal(r.body.off,true);assert.equal(r.body.offer_handoff,true);assert.equal(seen.length,0)});

test('with a key it starts in Team only: the owner can test it, shoppers cannot see it yet',async()=>{process.env.ANTHROPIC_API_KEY='test-key';
 assert.equal((await call('/chat/status')).body.on,false);
 const o=(await call('/chat/status',null,owner)).body;assert.equal(o.on,true);assert.equal(o.preview,true);
 assert.equal((await call('/chat',{cid:'abcdefabcdef11',messages:[{role:'user',content:'hi'}]})).body.off,true);assert.equal(seen.length,0);
 script=[say('Hi Jonah!')];assert.equal((await call('/chat',{cid:'abcdefabcdef11',messages:[{role:'user',content:'hi'}]},owner)).body.reply,'Hi Jonah!');
 assert.equal((await call('/admin/chat',null,owner)).body.mode,'staff');
 await assert.rejects(call('/admin/chat/settings',{mode:'sideways'},owner),e=>e.status===400);
 assert.equal((await call('/admin/chat/settings',{mode:'on'},owner)).body.mode,'on');
 const pub=(await call('/chat/status')).body;assert.equal(pub.on,true);assert.equal(pub.preview,undefined)});

test('with a key: finds a product, shows it with Add to bag, and answers',async()=>{
 const q=P.name.split(' · ')[0];
 script=[use('find_products',{query:q}),body=>{const res=lastResult(body);assert.ok(res.products.some(x=>x.id===P.id),'found the product');return use('show_products',{product_ids:[P.id,999999]})()},say('Here it is!')];
 const r=await call('/chat',{cid:'abcdefabcdef12',messages:[{role:'user',content:'Do you have '+q+'?'}]});
 assert.equal(r.body.reply,'Here it is!');assert.deepEqual(r.body.products.map(p=>p.id),[P.id]);assert.equal(r.body.products[0].in_stock,true);assert.match(r.body.products[0].url,/^\/store-next\/p\//);
 const first=seen[seen.length-3];assert.equal(first.model,'claude-sonnet-5-5');assert.ok(first.tools.some(t=>t.name==='order_status'));
 assert.match(first.system[0].text,/never give dosing/i);assert.match(first.system[1].text,/Shipping: \$15\.00/);assert.equal(first.system[0].cache_control.type,'ephemeral')});

test('order lookup needs the right order number AND email, and never shows the address',async()=>{
 script=[use('order_status',{order_number:'GLP-0123456789',email:'someone@else.com'}),body=>{const res=lastResult(body);assert.equal(res.found,false);assert.ok(!JSON.stringify(res).includes('Pat'));return say('Not found')()}];
 await call('/chat',{cid:'abcdefabcdef13',messages:[{role:'user',content:'where is GLP-0123456789'}]});
 script=[use('order_status',{order_number:'0123456789',email:' pat@example.org '}),body=>{const res=lastResult(body);assert.equal(res.found,true);assert.equal(res.status,'Shipped');assert.equal(res.carrier,'UPS');assert.equal(res.tracking_number,'1Z999AA10123456784');assert.match(res.tracking_link,/ups\.com/);
   const s=JSON.stringify(res);assert.ok(!s.includes('Secret')&&!s.includes('555')&&!s.includes('Town'));return say('On the way!')()}];
 const r=await call('/chat',{cid:'abcdefabcdef13',messages:[{role:'user',content:'0123456789 pat@example.org'}]});assert.equal(r.body.reply,'On the way!')});

test('hand off saves the question for the team and shows in Management',async()=>{
 script=[use('hand_off',{name:'Pat Lee',email:'pat@example.org',question:'My vial cap was cracked'}),body=>{assert.equal(lastResult(body).ok,true);return say('Sent to the team.')()}];
 const r=await call('/chat',{cid:'abcdefabcdef14',messages:[{role:'user',content:'my vial cap was cracked, I want a person'}]});assert.match(r.body.handoff.id,/^ch-/);
 await assert.rejects(call('/admin/chat'),e=>e.status===401);
 const v=(await call('/admin/chat',null,owner)).body;const hq=v.handoffs.find(x=>x.id===r.body.handoff.id);assert.equal(hq.question,'My vial cap was cracked');assert.equal(hq.status,'open');assert.ok(v.chats.some(c=>c.handoff===r.body.handoff.id));assert.ok(v.usage.replies>=4);
 const d=await call('/admin/chat/handoff/done',{id:r.body.handoff.id,done:true},owner);assert.equal(d.body.handoff.status,'done')});

test('the owner can switch the chat off',async()=>{await call('/admin/chat/settings',{on:false},owner);assert.equal((await call('/chat/status')).body.on,false);
 const r=await call('/chat',{cid:'abcdefabcdef15',messages:[{role:'user',content:'hi'}]});assert.equal(r.body.off,true);await call('/admin/chat/settings',{on:true},owner)});

test('a Claude outage gives a friendly answer, not an error',async()=>{script=[()=>({status:529,json:{error:{message:'overloaded'}}})];
 const r=await call('/chat',{cid:'abcdefabcdef16',messages:[{role:'user',content:'hi'}]});assert.equal(r.status,200);assert.equal(r.body.offer_handoff,true)});

test('limits: per-visitor messages and a daily cap',async()=>{process.env.CHAT_DAILY_MAX='1';
 const r=await call('/chat',{cid:'abcdefabcdef17',messages:[{role:'user',content:'hi'}]},null,{ip:9});assert.match(r.body.reply,/very busy/);delete process.env.CHAT_DAILY_MAX;
 script=Array.from({length:45},()=>say('ok'));let last;for(let i=0;i<41;i++)last=await call('/chat',{cid:'abcdefabcdef18',messages:[{role:'user',content:'hi '+i}]},null,{ip:7});assert.match(last.body.reply,/a lot of messages/);script=[]});

test('bad chats are refused and Zader has no chat',async()=>{
 await assert.rejects(call('/chat',{messages:[{role:'assistant',content:'hi'}]},null,{ip:3}),e=>e.status===400);
 await assert.rejects(call('/chat',{messages:'nope'},null,{ip:3}),e=>e.status===400);
 const h=bot.cleanHistory([{role:'user',content:'a'},{role:'user',content:'b'},{role:'assistant',content:'c'},{role:'user',content:'x'.repeat(5000)}]);assert.equal(h.length,3);assert.equal(h[0].content,'a\nb');assert.equal(h[2].content.length,1500);
 assert.equal((await call('/chat/status',null,null,{host:'zaderhealth.com'})).body.on,false)});

test('Message the team form goes straight to the team without AI',async()=>{const before=seen.length;
 const r=await call('/chat/handoff',{name:'Sam',email:'sam@example.org',question:'Do you do wholesale?',cid:'abcdefabcdef19'},null,{ip:11});assert.equal(r.body.ok,true);assert.equal(seen.length,before);
 const v=(await call('/admin/chat',null,owner)).body;assert.ok(v.handoffs.some(x=>x.name==='Sam'&&x.question==='Do you do wholesale?'));
 await assert.rejects(call('/chat/handoff',{name:'Sam',email:'nope',question:'x'},null,{ip:11}),e=>e.status===400)});

test('text Claude writes next to a tool call is kept; "let me check" filler is not',async()=>{const step=(text,name,input)=>()=>({stop_reason:'tool_use',content:[{type:'text',text},{type:'tool_use',id:'x'+Math.random(),name,input}],usage:{input_tokens:1,output_tokens:1}});
 script=[step('Let me check that for you!','find_products',{query:'serum'}),step('Protocol 01 is our serum. Shipping is $15, free over $250.','show_products',{product_ids:[P.id]}),say('Anything else?')];
 const r=await call('/chat',{cid:'abcdefabcdef21',messages:[{role:'user',content:'serum and shipping?'}]},owner);
 assert.equal(r.body.reply,'Protocol 01 is our serum. Shipping is $15, free over $250.\n\nAnything else?')});

test('a "let me check" sentence is dropped but the rest of that message is kept',async()=>{const step=(text,name,input)=>()=>({stop_reason:'tool_use',content:[{type:'text',text},{type:'tool_use',id:'x'+Math.random(),name,input}],usage:{input_tokens:1,output_tokens:1}});
 script=[step("Shipping is $15, free on orders of $250 or more. Let me look up our serums for you!",'find_products',{query:'serum'}),say('I found three serums below.')];
 const r=await call('/chat',{cid:'abcdefabcdef22',messages:[{role:'user',content:'serum and shipping?'}]},owner);
 assert.equal(r.body.reply,'Shipping is $15, free on orders of $250 or more.\n\nI found three serums below.')});

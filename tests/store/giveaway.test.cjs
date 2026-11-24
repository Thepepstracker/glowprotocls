'use strict';
// Giveaway winners (Jonah, 23 Nov 2026): preview, send adds the prize free to the order (once), email + one-time account pop-up.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-giveaway-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'db.sqlite'),STORE_ADMIN_PASSWORD:'owner-test-password',STORE_SESSION_SECRET:'giveaway-tests-session-secret-32-chars!',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),gw=require('../../netlify/functions/lib/giveaway.cjs');
const call=(p,b,cookie)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:b||{}});
const oldFetch=global.fetch;global.fetch=async u=>{throw new Error('unexpected fetch '+u)};
after(()=>{global.fetch=oldFetch;fs.rmSync(tmp,{recursive:true,force:true})});
const N=()=>Math.floor(Date.now()/1000);let owner,P,Q,cid;
const admin=(p,b)=>call(p,b,owner);const get=id=>transaction(s=>s.get('orders',id));

test('setup',async()=>{await transaction(seed);owner=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0];
 [P,Q]=await transaction(async s=>{const ps=(await s.list('products')).filter(p=>p.active&&!(p.components||[]).length&&!(Number(p.units)>1)&&!p.stock_pool).slice(0,2);for(const p of ps){p.stock=10;await s.put('products',p.id,p)}return ps});
 cid=await transaction(async s=>{const id=accounts.hash('winner@example.test');await s.put('customers',id,{id,email:'winner@example.test',name:'Holly Winner',verified:true,auth_version:1,created:N()-86400});return id});
 await transaction(s=>s.put('orders','GLP-00000WIN001',{id:'GLP-00000WIN001',status:'paid',is_test:false,brand:'glow',customer_id:cid,created:N()-3600,paid:N()-3500,subtotal:5000,discount:0,shipping:1500,tax:0,total:6500,verified_payment_cents:6500,payment_method:'zelle',items:[{id:P.id,name:P.name,quantity:1,price:5000,amount:5000}],customer:{name:'Holly Winner',email:'winner@example.test',address:'1 Main',city:'Canton',state:'GA',zip:'30114'},revision:0}));
});

test('preview shows the email and what will be added, and changes nothing',async()=>{
 const r=await admin('/admin/giveaway/preview',{order_id:'GLP-00000WIN001',items:[{id:Q.id,quantity:2}],note:'Thanks for watching!'});
 assert.equal(r.status,200);assert.equal(r.body.preview,true);assert.match(r.body.subject,/You won/);assert.match(r.body.html,/You won the giveaway/);assert.match(r.body.html,/Thanks for watching!/);
 assert.deepEqual(r.body.adds,[Q.name+' × 2']);const o=await get('GLP-00000WIN001');assert.equal(o.items.length,1);
});

test('send adds the prize free once, keeps the total, and leaves a one-time pop-up',async()=>{
 const stock0=(await transaction(s=>s.get('products',Q.id))).stock;
 const r=await admin('/admin/giveaway/send',{order_id:'GLP-00000WIN001',items:[{id:Q.id,quantity:2}],note:'',key:'click-key-0001'});
 assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.push_to,undefined);
 let o=await get('GLP-00000WIN001');const line=o.items.find(i=>i.id===Q.id);assert.ok(line);assert.equal(line.amount,0);assert.equal(o.total,6500);assert.equal(o.status,'paid');
 assert.equal((await transaction(s=>s.get('products',Q.id))).stock,stock0-2);
 // Same click again: nothing doubles.
 const again=await admin('/admin/giveaway/send',{order_id:'GLP-00000WIN001',items:[{id:Q.id,quantity:2}],key:'click-key-0001'});assert.equal(again.body.already,true);
 o=await get('GLP-00000WIN001');assert.equal(o.items.filter(i=>i.id===Q.id).length,1);
 // A new click with the prize already on at $0 does not add it again (Holly's case).
 const pv=await admin('/admin/giveaway/preview',{order_id:'GLP-00000WIN001',items:[{id:Q.id,quantity:2}]});assert.deepEqual(pv.body.adds,[]);assert.equal(pv.body.already.length,1);
 // Account pop-up: shows once, gone after "seen".
 const wins=await transaction(s=>gw.unseen(s,cid));assert.equal(wins.length,1);assert.equal(wins[0].order_id,'GLP-00000WIN001');assert.deepEqual(wins[0].prize,[{name:Q.name,quantity:2}]);
 await transaction(async s=>{const w=await s.get('giveaway_wins',wins[0].id);w.seen_at=N();await s.put('giveaway_wins',w.id,w)});
 assert.equal((await transaction(s=>gw.unseen(s,cid))).length,0);
});

test('a shipped order cannot take a new prize',async()=>{
 await transaction(async s=>{const o=await s.get('orders','GLP-00000WIN001');o.status='shipped';await s.put('orders',o.id,o)});
 await assert.rejects(admin('/admin/giveaway/send',{order_id:'GLP-00000WIN001',items:[{id:P.id,quantity:1}],key:'click-key-0002'}),e=>e.status===409&&/already shipped/.test(e.message));
});

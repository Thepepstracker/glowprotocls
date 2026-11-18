'use strict';
// Mystery gift on the packing slip (Jonah, 18 Nov 2026). One code per order, opens once, prize drawn on the server.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-unbox-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'unbox-fixture-password',STORE_SESSION_SECRET:'unbox-fixture-session-secret-longer-than-32-chars',STORE_ORIGIN:'http://127.0.0.1:8787',STORE_EMAIL_ENABLED:'0'});
const {handle}=require('../../netlify/functions/lib/store-core.cjs'),{transaction}=require('../../netlify/functions/lib/store-db.cjs'),accounts=require('../../netlify/functions/lib/customer-accounts.cjs'),unbox=require('../../netlify/functions/lib/unbox.cjs');
const call=(p,body,cookie)=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...(cookie?{cookie}:{})},body:body||{}}).catch(e=>({status:e.status||500,body:{error:e.message}}));
const N=()=>Math.floor(Date.now()/1000);after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const order=(id,extra)=>transaction(s=>s.put('orders',id,{id,brand:'glow',status:'shipped',is_test:false,paid:N()-3600,created:N()-7200,subtotal:7900,discount:0,total:9400,items:[{id:9,name:'Lipo-C',quantity:1}],customer:{name:'pat sample',email:'pat@example.test',address:'1 Main',city:'Canton',state:'GA',zip:'30114'},...extra}));
async function person(email,name){const id=accounts.hash(email);await transaction(s=>s.put('customers',id,{id,email,name,created:N(),verified:true,auth_version:1,password:null}));return id}
const bal=id=>transaction(s=>accounts.wallet(s,id)).then(w=>w.balance);

before(async()=>{await transaction(require('../../tools/store/seed-data.cjs').seed)});

test('a code belongs to one order and cannot be guessed or moved',()=>{
 const k=unbox.key({id:'GLP-AAAAAAAAA1',brand:'glow'});assert.match(k,/^GLP-AAAAAAAAA1\.[A-Za-z0-9_-]{12}$/);
 assert.equal(unbox.parse(k),'GLP-AAAAAAAAA1');
 assert.equal(unbox.parse('GLP-AAAAAAAAA2.'+k.split('.')[1]),null,'same code on another order fails');
 assert.equal(unbox.parse(k.slice(0,-1)+(k.endsWith('A')?'B':'A')),null,'a changed code fails');
 assert.equal(unbox.key({id:'ZDR-AAAAAAAAA1',brand:'zader'}),null,'Zader has no Glow Points');
});

test('the prize draw is 50 / 100 / 250 at about 75 / 20 / 5 percent',()=>{const n={50:0,100:0,250:0};for(let i=0;i<20000;i++)n[unbox.draw()]++;
 assert.deepEqual(Object.keys(n).map(Number).sort((a,b)=>a-b),[50,100,250]);assert.ok(Math.abs(n[50]/20000-0.75)<0.02,JSON.stringify(n));assert.ok(Math.abs(n[100]/20000-0.20)<0.02);assert.ok(Math.abs(n[250]/20000-0.05)<0.01)});

test('an account holder opens it once and gets the points once',async()=>{
 const cid=await person('pat@example.test','Pat Sample');await order('GLP-AAAAAAAAA1',{customer_id:cid});const k=unbox.key({id:'GLP-AAAAAAAAA1'});
 assert.equal((await call('/unbox/GLP-AAAAAAAAA1.xxxxxxxxxxxx')).status,404);
 const v=await call('/unbox/'+k);assert.equal(v.status,200);assert.equal(v.body.state,'ready');assert.equal(v.body.first,'Pat');assert.equal(v.body.prize,undefined,'the prize is not known before opening');
 const before=await bal(cid),o1=await call('/unbox/'+k+'/open',{});assert.equal(o1.status,200);assert.ok([50,100,250].includes(o1.body.prize));assert.equal(o1.body.credited,true);
 assert.equal(await bal(cid),before+o1.body.prize);
 const o2=await call('/unbox/'+k+'/open',{});assert.equal(o2.body.prize,o1.body.prize,'opening again shows the same prize');assert.equal(await bal(cid),before+o1.body.prize,'no second credit');
 const led=(await transaction(s=>s.list('rewards_ledger'))).filter(e=>e.customer_id===cid&&e.kind==='unbox_bonus');assert.equal(led.length,1);
});

test('not shipped or paid yet: locked, and cannot be opened',async()=>{await order('GLP-AAAAAAAAA2',{status:'awaiting_payment',paid:null});const k=unbox.key({id:'GLP-AAAAAAAAA2'});
 assert.equal((await call('/unbox/'+k)).body.state,'locked');assert.equal((await call('/unbox/'+k+'/open',{})).status,409)});

test('a guest’s prize is held, then added when they make an account with the order email',async()=>{
 await order('GLP-AAAAAAAAA3',{customer:{name:'Gia Guest',email:'gia@example.test'}});const k=unbox.key({id:'GLP-AAAAAAAAA3'});
 const v=await call('/unbox/'+k);assert.equal(v.body.has_account,false);assert.equal(v.body.email_hint,'g•••a@example.test');assert.equal(v.body.order_points,79);
 const o=await call('/unbox/'+k+'/open',{});assert.equal(o.body.held,true);assert.equal(o.body.credited,false);
 const gid=await person('gia@example.test','Gia Guest');await transaction(async s=>accounts.accountData(s,await s.get('customers',gid)));
 const w=await bal(gid);assert.equal(w,79+o.body.prize,'order points + mystery gift');
 const again=await call('/unbox/'+k);assert.equal(again.body.credited,true);
});

test('a gift-list order: the list owner (who holds the box) gets it',async()=>{const owner=await person('owner@example.test','Bria Owner');
 await order('GLP-AAAAAAAAA4',{customer:{name:'Sam Buyer',email:'sam@example.test'},gift:{owner_id:owner,to_name:'Bria Owner',to_first:'Bria'}});const k=unbox.key({id:'GLP-AAAAAAAAA4'});
 assert.equal((await call('/unbox/'+k)).body.first,'Bria');const o=await call('/unbox/'+k+'/open',{});assert.equal(o.body.credited,true);assert.equal(await bal(owner),o.body.prize)});

test('a test order opens but adds no real points; a full refund takes real ones back',async()=>{
 await order('GLP-AAAAAAAAA5',{is_test:true});const t=await call('/unbox/'+unbox.key({id:'GLP-AAAAAAAAA5'})+'/open',{});assert.equal(t.body.is_test,true);assert.equal(t.body.credited,false);
 const cid=accounts.hash('pat@example.test'),before=await bal(cid);
 await transaction(async s=>{const o=await s.get('orders','GLP-AAAAAAAAA1');await unbox.takeBack(s,o,accounts.event,'refund');await s.put('orders',o.id,o)});
 const o=await transaction(s=>s.get('orders','GLP-AAAAAAAAA1'));assert.equal(await bal(cid),before-o.unbox.prize);assert.ok(o.unbox.taken_back);
});

test('Management data gives the slip its code; the packing slip and live server use it',async()=>{
 const lg=await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD});assert.ok(lg.headers,JSON.stringify(lg.body));const owner=lg.headers['Set-Cookie'].split(';')[0];
 const d=(await call('/admin/data',undefined,owner)).body;const o=d.orders.find(x=>x.id==='GLP-AAAAAAAAA1');assert.equal(o.unbox_key,unbox.key({id:'GLP-AAAAAAAAA1'}));assert.ok(o.unbox.prize);
 const pack=fs.readFileSync(path.join(__dirname,'../../store-next/packing.html'),'utf8');assert.ok(pack.includes("'https://glowglps.com/store-next/unbox/'+o.unbox_key"));
 const app=fs.readFileSync(path.join(__dirname,'../../store-next/app.js'),'utf8');for(const s of ['function loadUnbox','function ubOpen',"loadUnbox()"])assert.ok(app.includes(s),s);
 assert.equal(require('../../tools/sevalla/server.cjs').publicFile('/store-next/unbox/'+unbox.key({id:'GLP-AAAAAAAAA1'})),'store-next/index.html');
});

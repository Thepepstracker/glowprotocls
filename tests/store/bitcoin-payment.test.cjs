'use strict';
// Bitcoin as a payment choice (Jonah, 10 Nov 2026): paid like Zelle. The store shows a Bitcoin receiving address,
// the customer sends the dollar amount in BTC, uploads a screenshot + transaction ID, and staff check Cash App.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'glow-bitcoin-'));Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(tmp,'store.sqlite'),STORE_ADMIN_PASSWORD:'bitcoin-test-admin-password',STORE_SESSION_SECRET:'bitcoin-test-session-secret-long-enough'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs');let cookie;
const call=(p,body,headers={})=>handle({path:p,method:body===undefined?'GET':'POST',headers:{'x-store-request':'1',...headers},body:body||{}}),admin=(p,b)=>call(p,b,{cookie});
const orderBody=extra=>({items:[{id:1,quantity:1}],payment_method:'bitcoin',affiliate:'',idempotency_key:crypto.randomUUID(),customer:{name:'Test',email:'test@example.com',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30301'},...extra});
const BTC='bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // a well-known example bech32 address
const settings=links=>admin('/admin/settings',{shipping_cents:1500,free_shipping_cents:25000,payment_links:{zelle:'recipient@example.com',...links}});
before(async()=>{await transaction(seed);cookie=(await call('/admin/login',{password:process.env.STORE_ADMIN_PASSWORD})).headers['Set-Cookie'].split(';')[0]});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));

test('only a real Bitcoin receiving address is accepted; secrets and look-alikes are refused',async()=>{
 for(const bad of ['bc1qBAD','5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ','xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi','abandon ability able about above absent absorb abstract absurd abuse access accident','https://cash.app/$example','bc1oaaaaaaaaaaaaaaaaaaaa'])
  await assert.rejects(settings({bitcoin:bad}),/Bitcoin receiving address/,bad.slice(0,12));
 for(const good of [BTC,'1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2','3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy']){await settings({bitcoin:'  '+good+' '});assert.equal((await call('/catalog')).body.settings.payment_links.bitcoin,good)}
 await settings({});assert.equal((await call('/catalog')).body.settings.payment_links.bitcoin,undefined,'blank hides Bitcoin');
});

test('live Bitcoin order: refused until an address is saved, then placed, receipt + transaction ID submitted for staff to verify',async()=>{
 await settings({});await admin('/admin/checkout-settings',{mode:'live',tax_mode:'none'});
 await assert.rejects(call('/orders',orderBody()),/not available/);
 await settings({bitcoin:BTC});
 const o=(await call('/orders',orderBody())).body;assert.equal(o.order.is_test,false);assert.equal(o.order.payment_method,'bitcoin');assert.equal(o.order.status,'order_received');
 const raw=await sharp({create:{width:400,height:800,channels:3,background:'#ffffff'}}).png().toBuffer();
 const r=(await call('/orders/'+o.order.id+'/receipt',{payment_method:'bitcoin',reference:'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16',mime:'image/png',file:raw.toString('base64')},{'x-order-token':o.token})).body;
 assert.equal(r.status,'payment_submitted');assert.equal(r.payment_method,'bitcoin');
 const stored=await transaction(s=>s.get('orders',o.order.id));assert.equal(stored.payment_reference.slice(0,8),'f4184fc5');assert.equal(stored.paid||null,null,'never marked paid by itself');
 // staff verify it in Cash App, then mark it paid like any Zelle order
 await admin('/admin/status',{id:o.order.id,status:'paid',verified:true});assert.equal((await transaction(s=>s.get('orders',o.order.id))).status,'paid');
});

test('a Zelle order can switch to Bitcoin at the receipt step only when Bitcoin is on',async()=>{
 const o=(await call('/orders',orderBody({payment_method:'zelle'}))).body;const raw=await sharp({create:{width:300,height:600,channels:3,background:'#ffffff'}}).png().toBuffer();
 await settings({});
 await assert.rejects(call('/orders/'+o.order.id+'/receipt',{payment_method:'bitcoin',reference:'x',mime:'image/png',file:raw.toString('base64')},{'x-order-token':o.token}),/available payment method/);
 await settings({bitcoin:BTC});
 assert.equal((await call('/orders/'+o.order.id+'/receipt',{payment_method:'bitcoin',reference:'x',mime:'image/png',file:raw.toString('base64')},{'x-order-token':o.token})).body.payment_method,'bitcoin');
});

'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glow-limits-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(dir,'store.sqlite'),STORE_SESSION_SECRET:'limits-test-secret-at-least-thirty-two-characters',STORE_ORIGIN:'https://glowglps.com'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{maxOrderQuantity}=require('../../netlify/functions/lib/product-limits.cjs');
const variants=[['Selank · 5 mg','selank-5-mg'],['Semax · 5 mg','semax-5-mg'],['GHK-Cu · 100 mg','ghk-cu-100-mg']];
const call=(p,b)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',host:'glowglps.com'},body:b||{}});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('checkout caps the combined sale group at three without reserving rejected stock',async()=>{
 await transaction(async s=>{await seed(s);for(const [i,[name,sku]] of variants.entries())await s.put('products',9000+i,{id:9000+i,name,sku,price:1300,stock:100,active:1,brand:'glow'});await s.put('products',9003,{id:9003,name:'Semax · 10 mg',sku:'semax-10-mg',price:3999,stock:100,active:1,brand:'glow'});});
 const catalog=(await call('/catalog')).body;
 for(let i=0;i<3;i++)assert.equal(catalog.products.find(p=>p.id===9000+i).max_order_quantity,3);
 assert.equal(catalog.products.find(p=>p.id===9003).max_order_quantity,undefined);
 const customer={name:'Example Customer',email:'limits@example.com',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30107'};
 for(let i=0;i<3;i++){
  const items=[{id:9000+i,quantity:4}];
  await assert.rejects(call('/quote',{items}),e=>e.status===409&&/Limit 3 sale vials total per order/.test(e.message));
  await assert.rejects(call('/orders',{items,customer,payment_method:'zelle',idempotency_key:crypto.randomUUID()}),/Limit 3 sale vials total per order/);
 }
 await transaction(async s=>{assert.equal((await s.list('orders')).length,0);for(let i=0;i<3;i++)assert.equal((await s.get('products',9000+i)).stock,100)});
 await assert.rejects(call('/quote',{items:[{id:9000,quantity:2},{id:9000,quantity:2}]}),/Duplicate/);
 const combinations=[[{id:9000,quantity:2},{id:9001,quantity:2}],[{id:9000,quantity:3},{id:9002,quantity:1}],[{id:9000,quantity:1},{id:9001,quantity:1},{id:9002,quantity:2}]];
 for(const items of combinations){
  await assert.rejects(call('/quote',{items}),/Limit 3 sale vials total per order/);
  await assert.rejects(call('/orders',{items,customer,payment_method:'zelle',idempotency_key:crypto.randomUUID()}),/Limit 3 sale vials total per order/);
 }
 await transaction(async s=>{assert.equal((await s.list('orders')).length,0);for(let i=0;i<3;i++)assert.equal((await s.get('products',9000+i)).stock,100)});
 for(const items of [[{id:9000,quantity:3}],[{id:9000,quantity:2},{id:9002,quantity:1}],variants.map((_,i)=>({id:9000+i,quantity:1}))])assert.equal((await call('/quote',{items})).body.subtotal,3900);
 const items=variants.map((_,i)=>({id:9000+i,quantity:1}));
 const placed=(await call('/orders',{items,customer,payment_method:'zelle',idempotency_key:crypto.randomUUID()})).body;
 assert.equal(placed.order.items.reduce((n,p)=>n+p.quantity,0),3);
 assert.equal((await call('/quote',{items:[...items,{id:9003,quantity:4}]})).body.subtotal,19896);
 assert.equal((await call('/quote',{items:[{id:9003,quantity:4}]})).body.subtotal,15996);
 for(const sku of ['selank-10-mg','semax-10-mg','ghk-cu-50-mg','selank-5-mg-kit'])assert.equal(maxOrderQuantity({sku}),null);
 assert.equal(maxOrderQuantity({sku:'selank-5-mg',units:10}),null);
 assert.equal(maxOrderQuantity({sku:'selank-5-mg',brand:'zader'}),null);
});
test('storefront shares the group limit across product cards and trims an older nine-vial saved bag',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../../store-next/app.js'),'utf8');
 const helpers=src.slice(src.indexOf('function productOrderLimit'),src.indexOf('\nconst button'));
 const card=src.slice(src.indexOf('function productCard('),src.indexOf('\nfunction groupedProducts'));
 const products=variants.map(([name,sku],i)=>({id:9000+i,name,sku,stock:99,max_order_quantity:3,purchase_limit_group:'glow-13-flash-sale',max_group_quantity:3}));
 const normal={id:9003,name:'Semax · 10 mg',stock:99};products.push(normal);
 const notices=[],ctx={state:{cart:new Map([[9000,2],[9001,1]]),catalog:{products}},toast:s=>notices.push(s),esc:String,beautyProductDescription:()=>'',productPriceHtml:()=>'',Map};vm.createContext(ctx);vm.runInContext(helpers+'\n'+card,ctx);
 for(const p of products.slice(0,3)){
  assert.match(ctx.productCard(p),/Limit 3 sale vials total per order/);
  assert.match(ctx.productCard(p),/data-action="add"[^>]*disabled/);
 }
 assert.doesNotMatch(ctx.productCard(normal),/data-action="add"[^>]*disabled/);
 ctx.state.cart.set(9000,1);assert.equal(ctx.productCanAdd(products[2]),true);
 ctx.state.cart=new Map([[9000,3],[9001,3],[9002,3],[9003,4]]);ctx.trimSavedCartLimits();
 assert.equal(Array.from(ctx.state.cart).filter(([id])=>id!==9003).reduce((n,[,qty])=>n+qty,0),3);
 assert.equal(ctx.state.cart.get(9003),4);assert.ok(notices.length);
 const language=require('../../store-next/language.js');assert.match(language.translateText('Limit 3 sale vials total per order. Mix and match.'),/Límite total de 3/);
});

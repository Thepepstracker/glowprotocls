'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'glow-limits-'));
Object.assign(process.env,{STORE_LOCAL:'1',STORE_SQLITE_PATH:path.join(dir,'store.sqlite'),STORE_SESSION_SECRET:'limits-test-secret-at-least-thirty-two-characters',STORE_ORIGIN:'https://glowglps.com'});
const {transaction}=require('../../netlify/functions/lib/store-db.cjs'),{seed}=require('../../tools/store/seed-data.cjs'),{handle}=require('../../netlify/functions/lib/store-core.cjs'),{maxOrderQuantity}=require('../../netlify/functions/lib/product-limits.cjs');
const variants=[['Selank · 5 mg','selank-5-mg'],['Semax · 5 mg','semax-5-mg'],['GHK-Cu · 100 mg','ghk-cu-100-mg']];
const call=(p,b)=>handle({path:p,method:b?'POST':'GET',headers:{'x-store-request':'1',host:'glowglps.com'},body:b||{}});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('after the Oct 31 sale the former sale vials sell in normal amounts again',async()=>{
 await transaction(async s=>{await seed(s);for(const [i,[name,sku]] of variants.entries())await s.put('products',9000+i,{id:9000+i,name,sku,price:2999,stock:100,active:1,brand:'glow'});});
 const catalog=(await call('/catalog')).body;
 for(let i=0;i<3;i++)assert.equal(catalog.products.find(p=>p.id===9000+i).max_order_quantity,undefined);
 for(let i=0;i<3;i++)assert.equal((await call('/quote',{items:[{id:9000+i,quantity:4}]})).body.subtotal,4*2999);
 assert.equal((await call('/quote',{items:variants.map((_,i)=>({id:9000+i,quantity:2}))})).body.subtotal,6*2999);
 const customer={name:'Example Customer',email:'limits@example.com',phone:'2025550101',address:'1 Example Street',city:'Example',state:'GA',zip:'30107'};
 const placed=(await call('/orders',{items:[{id:9000,quantity:5}],customer,payment_method:'zelle',idempotency_key:crypto.randomUUID()})).body;
 assert.equal(placed.order.items[0].quantity,5);
 for(const [,sku] of variants)assert.equal(maxOrderQuantity({sku}),null);
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

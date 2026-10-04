'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('hosted migration preserves edits and starts with zero stock and no sample affiliates or coupons',()=>{
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');
 try{
  const sql=fs.readFileSync(path.resolve(__dirname,'../../netlify/database/migrations/0001_glow_store.sql'),'utf8');
  db.exec(sql);
  const products=db.prepare("SELECT payload FROM glow_store_records WHERE kind='products'").all().map(r=>JSON.parse(r.payload));
  assert.equal(products.length,58);assert.ok(products.every(p=>p.stock===0));
  assert.equal(products.find(p=>p.slug==='kpv').price,3399);
  assert.equal(db.prepare("SELECT count(*) AS n FROM glow_store_records WHERE kind IN ('coupons','affiliates')").get().n,0);
  db.prepare("UPDATE glow_store_records SET payload=? WHERE kind='products' AND key='1'").run(JSON.stringify({...products[0],stock:7,price:4567}));
  db.exec(sql);
  const saved=JSON.parse(db.prepare("SELECT payload FROM glow_store_records WHERE kind='products' AND key='1'").get().payload);
  assert.equal(saved.stock,7);assert.equal(saved.price,4567);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM glow_store_records WHERE kind='settings'").get().payload).demo,true);
 }finally{db.close()}
});

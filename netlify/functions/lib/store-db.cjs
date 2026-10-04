'use strict';
const path=require('node:path'),fs=require('node:fs');
let queue=Promise.resolve(), pool;
function sqliteDb(){
 if(!process.env.STORE_LOCAL)throw Object.assign(new Error('The store database is not connected. Use the local development command or configure STORE_DATABASE_URL.'),{status:503});
 const {DatabaseSync}=require('node:sqlite');const file=process.env.STORE_SQLITE_PATH||path.resolve('.store-data/store.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});
 const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS glow_store_records(kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,key));');return db;
}
async function transaction(work){
 if(process.env.STORE_DATABASE_URL || (!process.env.STORE_LOCAL && process.env.NETLIFY)){
  if(!pool){
   if(process.env.STORE_DATABASE_URL){const {Pool}=require('pg');pool=new Pool({connectionString:process.env.STORE_DATABASE_URL,max:3,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});}
   else{const {getDatabase}=require('@netlify/database');pool=getDatabase().pool;}
  }
  const c=await pool.connect();
  try{await c.query('BEGIN');await c.query('SET LOCAL statement_timeout=15000');await c.query('SELECT pg_advisory_xact_lock(70619026)');
   const s=remoteStore(c);const result=await work(s);await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }
 const run=queue.then(async()=>{const db=sqliteDb();try{db.exec('BEGIN IMMEDIATE');const result=await work(localStore(db));db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}finally{db.close()}});
 queue=run.catch(()=>{});return run;
}
function localStore(db){return{
 get:async(kind,key)=>{const r=db.prepare('SELECT payload FROM glow_store_records WHERE kind=? AND key=?').get(kind,String(key));return r?JSON.parse(r.payload):null},
 list:async kind=>db.prepare('SELECT payload FROM glow_store_records WHERE kind=? ORDER BY key').all(kind).map(r=>JSON.parse(r.payload)),
 put:async(kind,key,value)=>db.prepare('INSERT INTO glow_store_records(kind,key,payload) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload').run(kind,String(key),JSON.stringify(value)),
 remove:async(kind,key)=>db.prepare('DELETE FROM glow_store_records WHERE kind=? AND key=?').run(kind,String(key))
}}
function remoteStore(c){return{
 get:async(kind,key)=>{const r=await c.query('SELECT payload FROM glow_store_records WHERE kind=$1 AND key=$2',[kind,String(key)]);return r.rows.length?JSON.parse(r.rows[0].payload):null},
 list:async kind=>(await c.query('SELECT payload FROM glow_store_records WHERE kind=$1 ORDER BY key',[kind])).rows.map(r=>JSON.parse(r.payload)),
 put:async(kind,key,value)=>c.query('INSERT INTO glow_store_records(kind,key,payload) VALUES($1,$2,$3) ON CONFLICT(kind,key) DO UPDATE SET payload=excluded.payload',[kind,String(key),JSON.stringify(value)]),
 remove:async(kind,key)=>c.query('DELETE FROM glow_store_records WHERE kind=$1 AND key=$2',[kind,String(key)])
}}
module.exports={transaction};

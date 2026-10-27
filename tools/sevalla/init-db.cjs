'use strict';
// Run explicitly against a NEW private Sevalla database. No customer data or demo inventory.
const fs=require('node:fs'),path=require('node:path');
async function init(){
 if(!process.env.STORE_DATABASE_URL)throw new Error('Configure STORE_DATABASE_URL first.');
 const {Client}=require('pg'),client=new Client({connectionString:process.env.STORE_DATABASE_URL});
 try{await client.connect();await client.query(fs.readFileSync(path.resolve(__dirname,'../store/schema.sql'),'utf8'));console.log('Store schema ready. Existing records preserved. No inventory, accounts or orders have been imported.')}finally{await client.end()}
}
init().catch(e=>{console.error(e.code||e.name);process.exitCode=1});

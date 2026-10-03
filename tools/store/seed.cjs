'use strict';
const {transaction}=require('../../netlify/functions/lib/store-db.cjs');const{seed}=require('./seed-data.cjs');
transaction(seed).then(created=>console.log(created?'Catalog imported with DEMONSTRATION inventory.':'Existing data preserved; no reseeding.')).catch(e=>{console.error(e.message);process.exitCode=1});

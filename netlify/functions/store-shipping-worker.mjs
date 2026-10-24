import database from './lib/store-db.cjs';
import shipping from './lib/shipstation.cjs';
import tracker from './lib/order-tracking.cjs';
import shippo from './lib/shippo.cjs';
import autoInvoice from './lib/auto-invoice.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
// Every minute: when Shippo is on, buy the UPS label for newly paid orders (tracking email goes out at
// once) and stop sending new orders to ShipStation. Otherwise send paid orders to ShipStation as before.
// Labels made in ShipStation are still picked up, then UPS is asked about packages that are due a check.
export default async()=>{
 let useShippo=false;try{useShippo=await shippo.enabled()}catch{console.error('Shippo status check requires review.')}
 if(useShippo){try{await shippo.pending(3)}catch{console.error('Shippo label queue requires review.')}}
 else{try{await shipping.pending(6)}catch{console.error('Store shipping queue requires review.')}}
 try{await shipping.syncShipments()}catch{console.error('ShipStation label check requires review.')}
 try{await tracker.refreshDue(8)}catch{console.error('UPS tracking check requires review.')}
 try{await autoInvoice.retryFailed(5)}catch{console.error('Automatic invoice retry requires review.')}
};
export const config={schedule:'* * * * *'};

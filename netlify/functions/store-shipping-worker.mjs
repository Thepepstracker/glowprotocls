import database from './lib/store-db.cjs';
import shipping from './lib/shipstation.cjs';
import tracker from './lib/order-tracking.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
// Every minute: send newly paid orders to ShipStation, pick up new labels (tracking email goes out
// at once), then ask UPS about packages that are due a check (delivery date, out for delivery, delivered).
export default async()=>{
 try{await shipping.pending(6)}catch{console.error('Store shipping queue requires review.')}
 try{await shipping.syncShipments()}catch{console.error('ShipStation label check requires review.')}
 try{await tracker.refreshDue(8)}catch{console.error('UPS tracking check requires review.')}
};
export const config={schedule:'* * * * *'};

import database from './lib/store-db.cjs';
import callList from './lib/call-list.cjs';
import emails from './lib/store-email.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
// Hourly; it only acts in the 12 o'clock hour Eastern (DST-safe) and sends at most one call list a day.
export default async()=>{
 try{const r=await callList.run();if(r.job)await emails.safeDispatch(r.job)}
 catch{console.error('Daily call list requires review.')}
};
export const config={schedule:'15 * * * *'};

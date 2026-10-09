import database from './lib/store-db.cjs';
import emails from './lib/store-email.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
// Scheduled functions are invoked by Netlify, not a public HTTP URL.
export default async () => {
 try { await emails.dispatchPending(12,20000); }
 catch { console.error('Store email queue requires review.'); }
};
export const config={schedule:'* * * * *'};

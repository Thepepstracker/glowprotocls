import database from './lib/store-db.cjs';
import shipping from './lib/shipstation.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
export default async()=>{try{await shipping.pending(2)}catch{console.error('Store shipping queue requires review.')}};
export const config={schedule:'*/5 * * * *'};

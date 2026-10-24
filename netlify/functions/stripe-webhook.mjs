import database from './lib/store-db.cjs';
import core from './lib/store-core.cjs';
import autoInvoice from './lib/auto-invoice.cjs';
import {getDatabase} from '@netlify/database';
database.configureHostedDatabase(getDatabase);
// Stripe → store (24 Oct 2026). Point a Stripe webhook at https://glowglps.com/.netlify/functions/stripe-webhook with the
// event "invoice.paid". The signature is checked with STRIPE_WEBHOOK_SECRET, then the invoice is re-read from Stripe's own
// API before any order is marked paid, so a forged or replayed request cannot mark anything paid.
export default async function stripeWebhook(request){
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const raw=await request.text();
 if(raw.length>512*1024)return new Response('Too large',{status:413});
 if(!autoInvoice.verify(raw,request.headers.get('stripe-signature')))return new Response('Bad signature',{status:400});
 let event;try{event=JSON.parse(raw)}catch{return new Response('Bad JSON',{status:400})}
 if(event.type!=='invoice.paid')return Response.json({received:true,ignored:event.type});
 const id=event.data?.object?.id;if(!/^in_[A-Za-z0-9]+$/.test(String(id||'')))return Response.json({received:true,ignored:'no invoice id'});
 try{const r=await core.stripeInvoicePaid(id);return Response.json({received:true,result:r.status,reason:r.reason||null})}
 catch(e){console.error('Stripe webhook needs review',{message:String(e.message||'').slice(0,200)});return new Response('Retry later',{status:500})}
}

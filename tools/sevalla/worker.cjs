'use strict';
// One-shot tasks for Sevalla scheduled jobs. Enable only after old workers are stopped.
async function run(){
 if(!process.env.STORE_DATABASE_URL||process.env.STORE_LOCAL)throw new Error('A private production database is required.');
 if(process.env.STORE_WORKERS_ENABLED!=='1')throw new Error('Workers are paused. Set STORE_WORKERS_ENABLED=1 only after checking for duplicate jobs.');
 const task=process.argv[2],lib='../../netlify/functions/lib/';
 if(task==='email')await require(lib+'store-email.cjs').dispatchPending(12,20000);
 else if(task==='shipping'){
  const shippo=require(lib+'shippo.cjs'),shipping=require(lib+'shipstation.cjs');
  if(await shippo.enabled())await shippo.pending(3);else await shipping.pending(6);
  await shipping.syncShipments();await require(lib+'order-tracking.cjs').refreshDue(8);await require(lib+'auto-invoice.cjs').retryFailed(5);
 }else if(task==='calls'){const r=await require(lib+'call-list.cjs').run();if(r.job)await require(lib+'store-email.cjs').safeDispatch(r.job)}
 else throw new Error('Choose email, shipping or calls.');
 console.log('Scheduled task completed: '+task);
}
run().then(()=>process.exit(0)).catch(e=>{console.error('Scheduled task failed.',{name:e.name,code:e.code||null});process.exit(1)});

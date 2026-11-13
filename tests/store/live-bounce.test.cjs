'use strict';
// Live bounce rate (Jonah, 13 Nov 2026): a visitor on the site one minute or less who never added to the bag "bounced".
const test=require('node:test'),assert=require('node:assert/strict');
const live=require('../../netlify/functions/lib/live.cjs');
test('bounce = one minute or less and nothing in the bag; typical time on the site is the median',()=>{
 const t=1794500000,L={id:'LIVE-T',started_at:t,ended_at:t+3600,goal_cents:0};
 const v=(id,mins,x={})=>({id,live:'LIVE-T',first:t,minutes:Array.from({length:mins},(_,i)=>Math.floor(t/60)+i),last:t+mins*60,src:'direct',...x});
 const V=[v('a',1),v('b',1),v('c',1,{bag:true}),v('d',4),v('e',10),v('f',0)];
 const r=live.report([],V,[],L,[L]);
 assert.equal(r.site.visitors,6);assert.equal(r.site.bounced,3,'a, b and f; c added to the bag');assert.equal(r.site.bounce_rate_pct,50);assert.equal(r.site.median_minutes,1);
 const none=live.report([],[],[],L,[L]);assert.equal(none.site.bounce_rate_pct,null);assert.equal(none.site.median_minutes,null);
});

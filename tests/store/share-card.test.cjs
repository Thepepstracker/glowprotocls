'use strict';
// Jonah, 14 Nov 2026: the My account link (shared on TikTok) shows the logo card, not the vial banner, when sent by text.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createServer}=require('../../tools/sevalla/server.cjs');
const og=h=>({image:(h.match(/<meta property="og:image" content="([^"]+)"/)||[])[1],tw:(h.match(/<meta name="twitter:image" content="([^"]+)"/)||[])[1],url:(h.match(/<meta property="og:url" content="([^"]+)"/)||[])[1],alt:(h.match(/<meta property="og:image:alt" content="([^"]+)"/)||[])[1]});
test('My account link preview is the logo card; the rest of the store keeps the vial banner',async t=>{
 const server=createServer({apiHandler:async()=>({statusCode:200,headers:{},body:'{}'})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 for(const p of ['/store-next/account','/store-next/account/']){const m=og(await (await fetch(base+p)).text());
  assert.equal(m.image,'https://glowglps.com/img/og-glow-logo.png',p);assert.equal(m.tw,'https://glowglps.com/img/og-glow-logo.png',p);assert.equal(m.url,'https://glowglps.com/store-next/account');assert.equal(m.alt,'Glow Lab Protocols logo')}
 for(const p of ['/','/store-next/','/store-next/sample']){const m=og(await (await fetch(base+p)).text());assert.equal(m.image,'https://glowglps.com/img/og-glow.jpg',p);assert.equal(m.tw,'https://glowglps.com/img/og-glow.jpg',p)}
 const r=await fetch(base+'/img/og-glow-logo.png');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
 const b=Buffer.from(await r.arrayBuffer());assert.equal(b.toString('latin1',1,4),'PNG');assert.deepEqual([b.readUInt32BE(16),b.readUInt32BE(20)],[1200,630]);
});

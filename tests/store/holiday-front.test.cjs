'use strict';
// Holiday front page + falling Christmas trees (Jonah, 21 Nov 2026: mom's "It's a Wonderful Life at Glow GLP's" picture).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../..'),app=fs.readFileSync(path.join(root,'store-next/app.js'),'utf8');
test('the holiday hero shows 21 Nov 2026 to 6 Jan 2027 and then the normal hero comes back',()=>{
 for(const s of ["Date.parse('2026-11-21T00:00:00-05:00')","Date.parse('2027-01-07T00:00:00-05:00')","&&xmOn()?xmHero():",'/img/hero-holiday-2026.webp','class="xm-shop" href="#collection"'])assert.ok(app.includes(s),s);
 const img=fs.readFileSync(path.join(root,'img/hero-holiday-2026.webp'));assert.equal(img.slice(0,4).toString(),'RIFF');assert.equal(img.slice(8,12).toString(),'WEBP');
});
test('Christmas trees fall like the flags did: random, endless, decorative only, off for reduced motion and in Management',()=>{
 for(const s of ['function xmDrop(box,midway)','fall.onfinish=()=>{el.remove();setTimeout(()=>xmDrop(box,false)','/\\/(admin|packing|live|staff)/','prefers-reduced-motion: reduce'])assert.ok(app.includes(s),s);
 const css=fs.readFileSync(path.join(root,'store-next/styles.css'),'utf8');assert.ok(css.includes('.xm-snow-page{position:fixed;inset:0;z-index:-1}'));assert.ok(css.includes('pointer-events:none'));
});

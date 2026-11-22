'use strict';
// Holiday app (Jonah, 22 Nov 2026: "i want to make it just as festive as the website is right now").
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../..'),app=fs.readFileSync(path.join(root,'store-next/app.js'),'utf8'),css=fs.readFileSync(path.join(root,'store-next/styles.css'),'utf8');
const fn=name=>{const i=app.indexOf('function '+name+'(');assert.ok(i>=0,name);let d=0,j=app.indexOf('{',i);for(;j<app.length;j++){if(app[j]==='{')d++;else if(app[j]==='}'&&--d===0)break}return app.slice(i,j+1)};
test('only in the Glow app during the holiday window: lights on the header and tab bar, a Santa hat on Shop',()=>{
 assert.ok(app.includes('function xmApp(){try{return STORE_APP&&xmOn()}catch{return false}}'));
 const dress=fn('xmAppDress');assert.match(dress,/^function xmAppDress\(\)\{if\(!xmApp\(\)/);
 for(const s of ["querySelector('body>header')","querySelector('.sa-tabbar')",'[data-sa-k="shop"]','xm-hat'])assert.ok(dress.includes(s),s);
 for(const s of ['.xm-lights{','@keyframes xm-twinkle','.sa-tabbar .xm-hat{','prefers-reduced-motion:reduce){.xm-lights i{animation:none'])assert.ok(css.includes(s),s);
});
test('holiday greeting: "Happy holidays" until Christmas, then "Happy New Year"; Thanksgiving week ends on the 29th',()=>{
 const ctx={};vm.runInNewContext(fn('xmNewYear')+fn('xmGreet')+fn('opSeason')+';this.g=xmGreet;this.s=opSeason;',ctx);
 const d=s=>new Date(s+'T12:00:00');
 assert.equal(ctx.g(d('2026-11-22')),'Happy holidays');assert.equal(ctx.g(d('2026-12-25')),'Happy holidays');assert.equal(ctx.g(d('2026-12-26')),'Happy New Year');assert.equal(ctx.g(d('2027-01-06')),'Happy New Year');
 assert.equal(ctx.s(d('2026-11-26'))[1],'Happy Thanksgiving week');assert.equal(ctx.s(d('2026-11-30'))[1],'Merry Christmas season');
});
test('opener gets falling trees, lights and the hat; account says the holiday greeting; Glow card gets holly and snow (not Zader)',()=>{
 const op=fn('opShow');for(const s of ["el.classList.add('op-xm')",'xm-snow-op xm-flakes','xmGreet().toUpperCase()','xmDrop(box,true)','op-hat'])assert.ok(op.includes(s),s);
 assert.ok(app.includes("<h1>${xmOn()?xmGreet():'Hi'}, "));
 const card=fn('glowCardHtml');assert.ok(card.includes('const xm=!Z&&xmOn()'));assert.ok(card.includes('gc-holly'));
});
test('welcome screen: gold background with falling blue snowflakes; the lines say "order", not "box"',()=>{
 assert.ok(fn('xmDrop').includes("const flake=!box.classList.contains('xm-trees')"));assert.ok(app.includes('<symbol id="xm-flake"'));
 for(const s of ['.op-xm .op-h span{background-image:linear-gradient(180deg,#5fa9e6,#2468a8)','.xm-flakes span{height:var(--s)}'])assert.ok(css.includes(s),s);assert.ok(!css.includes('.op-xm{background:'),'the gold background stays');
 const lines=fn('opLines');assert.ok(lines.includes('Your order is out for delivery today.'));assert.ok(lines.includes('Your order was delivered.'));assert.ok(!/Your box/.test(lines));
});

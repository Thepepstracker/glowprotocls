'use strict';
// Pace colors (Jonah, 26 Nov 2026): Rainbow, Galaxy and Diamond above Purple; Diamond is the top ("i want the rainbow to be diamond"), shared by Packing Check and Management.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const P=require('../../store-next/pace.js');
const now=Math.floor(Date.UTC(2026,10,26,22,0,0)/1000); // Thu 26 Nov 2026, 5 PM ET
const paid=(daysAgo,cents,extra)=>({is_test:false,status:'paid',total:cents,created:now-Math.round(daysAgo*86400),...extra});
test('the ladder: Blue 1× · Gold 1.5× · Purple 2× · Rainbow 2.5× · Galaxy 3× · Diamond 4×',()=>{
 assert.deepEqual(P.tiersFor(1000,'week').map(t=>[t.k,t.at]),[['diamond',4000],['galaxy',3000],['rainbow',2500],['purple',2000],['gold',1500],['blue',1000]]);
 assert.deepEqual(P.marks(1000).map(m=>m.name),['Blue','Gold','Purple','Rainbow','Galaxy','Diamond']);
 assert.match(P.legend(1000),/Blue 1× · Gold 1\.5× · Purple 2× · Rainbow 2\.5× · Galaxy 3× · Diamond 4×/)});
test('week target is last week (never under $4,500) and the day target is a seventh of it',()=>{
 const last=[1,2,3,4,5,6,7].map(i=>paid(3+i,140000)); // the 7 days of last week (Mon 16 – Sun 22 Nov … within range)
 const t=P.targetFor(last,now,0);assert.ok(t>=450000);
 assert.equal(P.day([],now).target,Math.round(P.targetFor([],now,0)/7));assert.equal(P.targetFor([],now,0),450000,'floor');
 assert.equal(P.weekKeys(now,0).keys[0],'2026-11-23','weeks start Monday')});
test('day colors: hitting 2×, 2.5×, 3× and 4× of the day target gives Purple, Rainbow, Galaxy and Diamond',()=>{
 const dt=Math.round(450000/7);for(const [m,k] of [[1,'blue'],[1.5,'gold'],[2,'purple'],[2.5,'rainbow'],[3,'galaxy'],[4,'diamond']]){const d=P.day([paid(0.01,Math.ceil(dt*m))],now);assert.equal(d.tier.k,k,m+'×')}
 const top=P.day([paid(0.01,dt*5)],now);assert.equal(top.next,null);assert.equal(top.pct,100);
 const mid=P.day([paid(0.01,Math.ceil(dt*2.2))],now);assert.equal(mid.next.name,'Rainbow')});
test('free, test and old-store orders never count',()=>{const dt=Math.round(450000/7);
 for(const extra of [{comped:{}},{is_test:true},{legacy_import:true},{status:'awaiting_payment'}])assert.notEqual(P.day([paid(0.01,dt*3,extra)],now).tier.k,'galaxy',JSON.stringify(extra))});
test('Packing Check and Management both use pace.js',()=>{const root=path.join(__dirname,'../../store-next');
 const pk=fs.readFileSync(path.join(root,'packing.html'),'utf8'),ix=fs.readFileSync(path.join(root,'index.html'),'utf8'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
 assert.ok(pk.indexOf('<script src="pace.js"></script>')>0&&pk.indexOf('<script src="pace.js"></script>')<pk.indexOf('<script>\n'),'loaded before the page script');
 assert.match(pk,/function tiersFor\(t\)\{return GlowPace\.tiersFor\(t,'week'\)\}/);assert.match(pk,/\.t-diamond\{/);assert.match(pk,/\.t-galaxy\{/);assert.match(pk,/\.t-rainbow\{/);
 assert.ok(ix.indexOf('/store-next/pace.js')>0&&ix.indexOf('/store-next/pace.js')<ix.indexOf('/store-next/app.js'));assert.match(app,/function paceCircles\(orders\)/)});

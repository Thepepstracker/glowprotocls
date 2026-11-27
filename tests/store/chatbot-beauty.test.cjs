'use strict';
// Beauty serums in the chat bot (Jonah, 26 Nov 2026): the bot gets each serum's page description and key ingredients,
// and a search for "serum" / "skin care" / "scalp" / "under eye" finds them even when the name has no such word.
const test=require('node:test'),assert=require('node:assert/strict');
const bot=require('../../netlify/functions/lib/chatbot.cjs');
// The live Glow beauty products on 26 Nov 2026, plus two research items that must not come back for beauty words.
const raw=[[32,'Protocol 01 · 15 mL / 0.5 oz','15 mL / 0.5 oz','protocol-01-15-ml-0-5-oz','protocol-01'],[33,'Protocol 01 · 50 mL / 1.7 oz','50 mL / 1.7 oz','protocol-01-50-ml-1-7-oz','protocol-01'],
 [34,'Protocol 02 · 15 mL','15 mL','protocol-02-15-ml','protocol-02'],[35,'Glow Eyes · 0.34 fl oz / 10 mL','0.34 fl oz / 10 mL','glow-eyes-0-34-fl-oz-10-ml','glow-eyes'],
 [36,'Glow Eyes Luxe with KPV · 0.34 fl oz / 10 mL','0.34 fl oz / 10 mL','glow-eyes-luxe-kpv-0-34-fl-oz-10-ml','glow-eyes-luxe-kpv'],[37,'Rose Recovery Mist · 60 mL','60 mL','rose-recovery-mist-60-ml','rose-recovery-mist'],
 [38,'Cu-Hair 01 · 30 mL','30 mL','cu-hair-01-30-ml','cu-hair-01'],[39,'Cu-Hair 02 · 30 mL','30 mL','cu-hair-02-30-ml','cu-hair-02'],
 [1,'BPC-157 · 10 mg','10 mg','bpc-157-10mg',''],[2,'GHK-Cu · 50 mg','50 mg','ghk-cu-50mg','']];
const list=raw.map(([id,name,size,sku,slug])=>{const p={id,name,size,sku,slug,price:3000,in_stock:true};p.beauty=bot.beautyOf(p);return p});
const ids=q=>bot.search(list,q).map(p=>p.id);
test('every live serum gets its page description, ingredients and a type',()=>{for(const p of list.filter(p=>p.id>2)){assert.ok(p.beauty,p.name);assert.ok(p.beauty.description.length>40,p.name);assert.ok(p.beauty.ingredients,p.name);assert.ok(p.beauty.kind,p.name)}
 assert.equal(list.find(p=>p.id===1).beauty,null);assert.equal(list.find(p=>p.id===2).beauty,null);
 assert.match(list.find(p=>p.id===36).beauty.ingredients,/KPV/);assert.equal(list.find(p=>p.id===39).beauty.kind,'Scalp and hair serum')});
test('"beauty serums" finds all 8 beauty products and no research peptide',()=>{const r=ids('what beauty serums do you have');assert.deepEqual([...r].sort((a,b)=>a-b),[32,33,34,35,36,37,38,39])});
test('focus words find the right serums',()=>{assert.deepEqual(ids('scalp').sort(),[38,39]);assert.deepEqual(ids('under eye').slice(0,2).sort(),[35,36]);assert.equal(ids('facial mist')[0],37);assert.ok(ids('skin care').includes(32))});
test('a research search is not crowded by serums',()=>{assert.equal(ids('BPC-157')[0],1);assert.equal(ids('GHK-Cu 50 mg')[0],2)});
test('find_products hands the bot the description',async()=>{assert.match(bot.RULES,/BEAUTY SERUMS/);assert.match(bot.RULES,/patch test/)});

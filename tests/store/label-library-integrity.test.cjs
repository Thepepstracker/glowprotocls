'use strict';
// Every label in the hub must have a whole thumbnail and a whole image (13 Nov 2026: a thumbs.bin from another build was
// committed with the box label, so every picture but the first broke and the label designs "vanished" from the admin).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const DIR=path.join(__dirname,'../../label-library'),L=JSON.parse(fs.readFileSync(path.join(DIR,'labels.json'),'utf8')),thumbs=fs.readFileSync(path.join(DIR,'thumbs.bin'));
test('every thumbnail is a whole JPEG at its recorded place',()=>{const bad=[];for(const l of L.labels){const [o,n]=l.thumb,b=thumbs.subarray(o,o+n);if(b.length!==n||b[0]!==0xff||b[1]!==0xd8||b[n-2]!==0xff||b[n-1]!==0xd9)bad.push(l.id)}assert.deepEqual(bad,[])});
test('every label image unpacks to its recorded size',()=>{const cache={};for(const l of L.labels){const [f,o,n]=l.img;cache[f]??=fs.readFileSync(path.join(DIR,f));const px=zlib.inflateSync(cache[f].subarray(o,o+n));assert.equal(px.length,l.w*l.h*(l.cs==='cmyk'?4:3),l.id)}});
test('ids are unique and every kind is known',()=>{const ids=L.labels.map(l=>l.id);assert.equal(new Set(ids).size,ids.length);for(const l of L.labels)assert.ok(!l.kind||L.kinds[l.kind],l.id)});

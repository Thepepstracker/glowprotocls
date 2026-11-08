'use strict';
// Label hub (Jonah, 8 Nov 2026): "a hub for all of our vial labels ... already perfected and i just gotta print them".
// Every approved vial label lives in label-library/ (not public): one exact label image per product, taken
// pixel-for-pixel from the printer-adjusted sheets proven on the HP OfficeJet (Oct 30 read test), plus the 48
// sticker positions from those same sheets. A sheet is built here as a PDF that places each label at exactly the
// position the proven sheets use, so a full sheet of one product is identical to the old file, and a custom sheet
// (several products, any count, starting at any sticker) uses the same placement.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const DIR=path.resolve(__dirname,'../../../label-library');
const bad=(m,status=400)=>{throw Object.assign(new Error(m),{status})};
const MAX_PAGES=20,PER=48;
let LIB=null;
// Label images are packed into a few files (img-1.bin …) so the library uploads in one commit; labels.json says where each one sits.
function slice(file,off,len){const fd=fs.openSync(path.join(DIR,file),'r');try{const b=Buffer.alloc(len);fs.readSync(fd,b,0,len,off);return b}finally{fs.closeSync(fd)}}
function lib(){if(!LIB){const j=JSON.parse(fs.readFileSync(path.join(DIR,'labels.json'),'utf8'));j.byId=new Map(j.labels.map(l=>[l.id,l]));LIB=j}return LIB}
const ID=/^[a-z0-9-]{2,60}$/;

// Fill order: sticker 1 is the top-left, then across the row, then down (4 across, 12 down).
// start = first free sticker on a part-used sheet. newRow = every product after the first starts on a fresh row.
function plan(items,{start=1,newRow=true}={}){
 const L=lib(),cols=L.sheet.cols;start=Math.trunc(Number(start)||1);if(start<1||start>PER)bad('Start sticker must be 1 to 48.');
 if(!Array.isArray(items)||!items.length)bad('Pick at least one label.');if(items.length>120)bad('Too many labels in one print.');
 let i=start-1,total=0;const slots=[];
 items.forEach((it,n)=>{const id=String(it?.id||''),count=Math.trunc(Number(it?.count));if(!ID.test(id)||!L.byId.has(id))bad('Unknown label.');
  if(!(count>=1))bad('Enter how many of each label (1 or more).');total+=count;if(total>PER*MAX_PAGES)bad('That is more than 20 sheets. Print it in two goes.');
  if(newRow&&n>0&&i%cols)i+=cols-i%cols;for(let k=0;k<count;k++)slots[i++]=id});
 const pages=Math.ceil(i/PER);if(pages>MAX_PAGES)bad('That is more than 20 sheets. Print it in two goes.');
 return Array.from({length:pages},(_,p)=>Array.from({length:PER},(_,c)=>slots[p*PER+c]||null));
}

// A small, exact PDF writer: one image object per label used, drawn at the proven positions.
function pdf(pages,title){
 const L=lib(),objs=[],add=b=>{objs.push(b);return objs.length};
 const used=[...new Set(pages.flat().filter(Boolean))],names=new Map(used.map((id,k)=>[id,'L'+k]));
 const cat=add(null),root=add(null);let icc=0;
 if(used.some(id=>L.byId.get(id).cs==='icc')){const raw=fs.readFileSync(path.join(DIR,'icc.bin'));icc=add(Buffer.concat([Buffer.from(`<< /N ${L.icc.N} /Alternate /DeviceRGB${L.icc.Filter?' /Filter '+L.icc.Filter:''} /Length ${raw.length} >>\nstream\n`),raw,Buffer.from('\nendstream')]))}
 const img=new Map(used.map(id=>{const l=L.byId.get(id),raw=slice(...l.img);
  return[id,add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${l.w} /Height ${l.h} /BitsPerComponent 8 /ColorSpace ${l.cs==='icc'?`[/ICCBased ${icc} 0 R]`:'/DeviceRGB'} /Filter /FlateDecode /Length ${raw.length} >>\nstream\n`),raw,Buffer.from('\nendstream')]))]}));
 const kids=pages.map(slots=>{const body=slots.map((id,c)=>{if(!id)return'';const[x,y,w,h]=L.sheet.pos[c];return`q\n${w} 0 0 ${h} ${x} ${y} cm\n/${names.get(id)} Do\nQ\n`}).join('');
  const content=add(Buffer.from(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}endstream`));
  const xo=[...new Set(slots.filter(Boolean))].map(id=>`/${names.get(id)} ${img.get(id)} 0 R`).join(' ');
  return add(Buffer.from(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 ${L.sheet.w} ${L.sheet.h}] /Resources << /XObject << ${xo} >> >> /Contents ${content} 0 R >>`))});
 objs[cat-1]=Buffer.from(`<< /Type /Catalog /Pages ${root} 0 R /ViewerPreferences << /PrintScaling /None >> >>`);
 objs[root-1]=Buffer.from(`<< /Type /Pages /Kids [${kids.map(k=>k+' 0 R').join(' ')}] /Count ${kids.length} >>`);
 const info=add(Buffer.from(`<< /Title (${String(title||'Glow Lab vial labels').replace(/[^A-Za-z0-9 .,+\-·×#/]/g,'').replace(/·|×/g,'-').slice(0,120)}) /Creator (Glow Lab label hub) >>`));
 const parts=[Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n','latin1')],offs=[];let len=parts[0].length;
 objs.forEach((b,k)=>{offs.push(len);const o=Buffer.concat([Buffer.from(`${k+1} 0 obj\n`),b,Buffer.from('\nendobj\n')]);parts.push(o);len+=o.length});
 const xref=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n${offs.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objs.length+1} /Root ${cat} 0 R /Info ${info} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
 parts.push(Buffer.from(xref));return Buffer.concat(parts);
}

async function route(path_,body,h,method,{session}){
 if(!path_.startsWith('/admin/labels'))return null;
 const {transaction}=require('./store-db.cjs');await transaction(s=>session(s,h));
 const L=lib();
 if(path_==='/admin/labels'&&method==='GET')return{status:200,headers:{},body:{sheet:{name:L.sheet.name,cols:L.sheet.cols,rows:L.sheet.rows,adjust:L.sheet.adjust},labels:L.labels.map(({id,name,strength})=>({id,name,strength})),sheets:L.sheets,version:L.version}};
 const t=path_.match(/^\/admin\/labels\/thumb\/([a-z0-9-]{2,60})$/);
 if(t&&method==='GET'){if(!L.byId.has(t[1]))bad('Label not found.',404);return{status:200,headers:{'Cache-Control':'private, max-age=86400'},body:{_binary:slice('thumbs.bin',...L.byId.get(t[1]).thumb).toString('base64'),_type:'image/jpeg'}}}
 const f=path_.match(/^\/admin\/labels\/sheet\/([a-z0-9-]{2,60})$/);
 if(f&&method==='GET'){if(!L.sheets.some(s=>s.id===f[1]))bad('Sheet not found.',404);return{status:200,headers:{},body:{_binary:fs.readFileSync(path.join(DIR,'sheet-'+f[1]+'.pdf')).toString('base64'),_type:'application/pdf'}}}
 if(path_==='/admin/labels/build'&&method==='POST'){const pages=plan(body.items,{start:body.start,newRow:body.new_row!==false});
  const title=(body.items.length===1?L.byId.get(body.items[0].id).name+' '+L.byId.get(body.items[0].id).strength:body.items.length+' labels')+' - vial labels';
  return{status:200,headers:{'X-Label-Pages':String(pages.length)},body:{_binary:pdf(pages,title).toString('base64'),_type:'application/pdf'}}}
 bad('Not found.',404);
}
module.exports={route,plan,pdf,lib};

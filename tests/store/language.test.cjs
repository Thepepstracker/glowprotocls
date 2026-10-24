'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {translateText:t,phrases}=require('../../store-next/language.js');
test('Spanish checkout copy distinguishes submitting proof from verified payment',()=>{
 assert.equal(t('Submit order'),'Enviar pedido');assert.equal(t('Awaiting payment'),'Pendiente de pago');assert.equal(t('Payment review'),'Pago en revisión');assert.equal(t('Paid · in queue'),'Pagado · En cola de preparación');
 assert.match(t('Uploading does not mark the order paid.'),/no marca el pedido como pagado/);
 assert.match(t('Your order will be submitted now. Our team will email you a credit card invoice. No screenshot is required for this option. Payment has not been received, and your order enters the fulfillment queue only after staff verify payment.'),/Aún no hemos recibido el pago/);
 assert.match(t('Keep this checkout tab open. After paying, return here, attach your screenshot, select the method you used, and press Submit order.'),/pulsa Enviar pedido/);
});
test('dynamic translations preserve money, recipient data, tracking identifiers and codes',()=>{
 assert.equal(t('View bag (3)'),'Ver bolsa (3)');assert.equal(t('Applied coupons: SCARECROW, PEACE20'),'Códigos aplicados: SCARECROW, PEACE20');
 assert.equal(t('Enter $123.45 in the payment service. Use Copy amount below.'),'Ingresa $123.45 en el servicio de pago. Usa Copiar importe abajo.');
 for(const data of ['GLP-TEST000001','2025550123','carla@example.com','123 Example Street, Unit TEST','NAD+ · 500 mg','https://cash.app/$glowlabprotocols','scarecrow','$1,062.10'])assert.equal(t(data),data);
 assert.equal(t('Carla Peace’s Glow Store'),'Tienda Glow de Carla Peace');assert.equal(t('Only 2 of NAD+ · 500 mg available.'),'Solo hay 2 unidades disponibles de NAD+ · 500 mg.');
 assert.equal(t('Submit order','en'),'Submit order');assert.equal(t('  Add to bag  '),'  Agregar a la bolsa  ');
});
test('combined checkout text and source English stay deterministic',()=>{
 const input='Shipping is calculated after discounts. Rewards can be used with eligible coupon codes.';assert.equal(t(input),'El envío se calcula después de los descuentos. Puedes usar tus recompensas con códigos de descuento elegibles.');
 assert.equal(t('We will email a credit card invoice to someone@example.com.'),'Te enviaremos por correo una factura para pagar con tarjeta a someone@example.com.');
 assert.equal(t('Your own text that has not been translated'),'Your own text that has not been translated');
 assert.ok(Object.keys(phrases).length>500);for(const [en,es]of Object.entries(phrases)){assert.ok(en.trim());assert.equal(typeof es,'string');assert.ok(es.trim())}
});
test('public pages load the language choice without changing shopping source',()=>{
 const root=path.join(__dirname,'../..');for(const p of ['store-next/index.html','store-next/merch.html','about.html','contact.html','faq.html','terms.html','coa.html','affiliate.html','glow-loyalty.html','bpc-157-research-guide.html','peptide-storage-and-handling.html']){const html=fs.readFileSync(path.join(root,p),'utf8');assert.equal((html.match(/src="\/store-next\/language\.js"/g)||[]).length,1,p)}
 const source=fs.readFileSync(path.join(root,'store-next/language.js'),'utf8');assert.doesNotMatch(source,/\bfetch\s*\(|XMLHttpRequest|innerHTML\s*=\s*translate/);assert.match(source,/localStorage\.setItem\(key,value\)/);assert.match(source,/dialog\.showModal\(\)/);
});

test('adjacent multi-sentence checkout notices translate together',()=>{const a='Confirm your shipping address and choose how you’ll pay. Venmo, Cash App and Zelle require a payment screenshot to submit. For a credit card, submit your order now and we will email you an invoice.',b='A private order link will be emailed when your checkout is saved. Keep this page open while you pay.';assert.equal(t(a+' '+b),t(a)+' '+t(b));assert.doesNotMatch(t(a+' '+b),/Confirm your|Keep this/)});

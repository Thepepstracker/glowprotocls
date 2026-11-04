'use strict';
const bundles={
 '737':['/product-images/metabolic-reset.webp'],
 '738':['/product-images/metabolic-reset-ii.webp'],
 '751':['/product-images/r4-cellular-reset.webp','/product-images/r4-cellular-reset-alternate.webp'],
 '774':['/product-images/bundle-epithalon-100mg.webp'],
 '795':['/product-images/bundle-radiance-reset.webp']
};
// Photos uploaded before 3 Nov 2026 were saved with the /.netlify/functions/store-next?route= address, which Sevalla refuses (403).
const LEGACY='/.netlify/functions/store-next?route=';
const fixUrl=u=>typeof u==='string'&&u.startsWith(LEGACY)?'/api'+decodeURIComponent(u.slice(LEGACY.length)):u;
function withProductPhotos(product){
 product={...product,image:fixUrl(product.image),...(product.additional_images?{additional_images:product.additional_images.map(fixUrl)}:{})};
 const key=String(product.bundle||((product.sku||'').match(/^bundle-(\d+)-/)||[])[1]||'');
 const images=product.sku==='glp-2t-60-mg'?['/product-images/glp-2t-60mg.webp']:bundles[key];
 // Built-in photos are only a fallback: anything uploaded in Management always wins.
 if(!images||product.image&&!product.image.includes('product-placeholder.svg'))return product;
 const uploaded=product.additional_images||[];
 return {...product,image:images[0],additional_images:uploaded.length?uploaded:images.slice(1)};
}
module.exports={withProductPhotos};

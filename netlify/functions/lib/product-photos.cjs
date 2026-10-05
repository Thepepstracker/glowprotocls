'use strict';
const bundles={
 '737':['/product-images/metabolic-reset.webp'],
 '738':['/product-images/metabolic-reset-ii.webp'],
 '751':['/product-images/r4-cellular-reset.webp','/product-images/r4-cellular-reset-alternate.webp'],
 '774':['/product-images/bundle-epithalon-100mg.webp'],
 '795':['/product-images/bundle-radiance-reset.webp']
};
function withProductPhotos(product){
 const key=String(product.bundle||((product.sku||'').match(/^bundle-(\d+)-/)||[])[1]||'');
 const images=bundles[key];
 if(!images||product.image&&!product.image.includes('product-placeholder.svg'))return product;
 return {...product,image:images[0],additional_images:images.slice(1)};
}
module.exports={withProductPhotos};

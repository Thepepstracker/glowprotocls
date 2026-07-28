export default async (_request, context) => {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return response;
  }

  let html = await response.text();

  const productImageHelper =
    'const uploadedImageBySlug={' +
    'aicar:"/aicar.png",' +
    '"5-amino-1mq":"/5-amino-1mq.png",' +
    '"bpc-157":"/product-images/bpc157.png",' +
    '"glutathione-1500":"/product-images/product-placeholder.svg",' +
    '"klow-blend":"/product-images/klow.png",' +
    '"pt-141":"/product-images/product-placeholder.svg",' +
    '"reta-20":"/product-images/retatrutide.png",' +
    'selank:"/selank.png",' +
    '"ss-31":"/product-images/ss31.png",' +
    '"tesamorelin-ipamorelin":"/product-images/product-placeholder.svg"' +
    '};' +
    'const productImage=p=>uploadedImageBySlug[p.slug]||p.img||"/product-images/product-placeholder.svg";';

  html = html
    .replace(
      ".card .ph img{width:100%;height:100%;object-fit:cover}",
      ".card .ph img{width:100%;height:100%;object-fit:contain;padding:12px}"
    )
    .replace(
      ".pimg img{width:100%;object-fit:cover}",
      ".pimg img{width:100%;height:auto;object-fit:contain;padding:20px}"
    )
    .replace(
      ".citem img{width:70px;height:88px;object-fit:cover;border-radius:6px;background:#f6f2ea}",
      ".citem img{width:70px;height:88px;object-fit:contain;border-radius:6px;background:#f6f2ea;padding:4px}"
    )
    .replace(
      /const uploadedImageBySlug=\{[^}]*\};const productImage=p=>uploadedImageBySlug\[p\.slug\]\|\|p\.img(?:\|\|"\/product-images\/product-placeholder\.svg")?;/,
      productImageHelper
    );

  return new Response(html, response);
};

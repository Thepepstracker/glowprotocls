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


  // Seasonal accents are scoped to Glow domains and leave all other brands unchanged.
  const glowHosts = new Set(["glowglps.com","www.glowglps.com","glowlabprotocols.com","www.glowlabprotocols.com","glps.shop","www.glps.shop"]);
  if (glowHosts.has(new URL(_request.url).hostname) && !html.includes('id="glow-halloween-styles"')) {
    html = html.replace(/<\/head>/i, '<link id="glow-halloween-styles" rel="stylesheet" href="/store-next/halloween.css"></head>');
    html = html.replace(/<\/body>/i, "<div class=\"glow-season-corner\" aria-hidden=\"true\"><svg class=\"season-bat\" viewBox=\"0 0 100 65\" fill=\"currentColor\" focusable=\"false\" aria-hidden=\"true\"><path d=\"M0 13 16 25 23 0 39 23 46 20 48 11 52 20 59 23 76 0 84 25 100 13 87 46 72 36 62 49 50 65 38 49 27 36 13 46Z\"/></svg></div><div class=\"glow-season-footer\" aria-hidden=\"true\"><svg class=\"season-bat\" viewBox=\"0 0 100 65\" fill=\"currentColor\" focusable=\"false\" aria-hidden=\"true\"><path d=\"M0 13 16 25 23 0 39 23 46 20 48 11 52 20 59 23 76 0 84 25 100 13 87 46 72 36 62 49 50 65 38 49 27 36 13 46Z\"/></svg><svg viewBox=\"0 0 64 58\" fill=\"none\" focusable=\"false\" aria-hidden=\"true\"><path d=\"M31 13c0-7 3-10 8-11\" stroke=\"#9c7432\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M33 14c14-8 27 2 27 18 0 17-12 25-28 23C14 57 4 48 4 33 4 17 18 7 33 14Z\" fill=\"#ede1c8\" stroke=\"#aa8040\" stroke-width=\"2\"/><ellipse cx=\"25\" cy=\"34\" rx=\"12\" ry=\"21\" stroke=\"#b89153\" stroke-width=\"2\"/><ellipse cx=\"39\" cy=\"34\" rx=\"12\" ry=\"21\" stroke=\"#b89153\" stroke-width=\"2\"/><path d=\"M32 14v41\" stroke=\"#b89153\" stroke-width=\"2\"/></svg><svg class=\"season-bat\" viewBox=\"0 0 100 65\" fill=\"currentColor\" focusable=\"false\" aria-hidden=\"true\"><path d=\"M0 13 16 25 23 0 39 23 46 20 48 11 52 20 59 23 76 0 84 25 100 13 87 46 72 36 62 49 50 65 38 49 27 36 13 46Z\"/></svg></div>" + '</body>');
  }

  return new Response(html, response);
};

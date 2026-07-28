export default async (_request, context) => {
  const response = await context.next();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return response;
  }

  let html = await response.text();

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
    );

  return new Response(html, response);
};

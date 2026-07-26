from __future__ import annotations

from io import BytesIO
from pathlib import Path
import base64
import html
import json
import re
import urllib.request

from PIL import Image

INDEX_PATH = Path("index.html")
LLMS_PATH = Path("llms.txt")
STORE_API = "https://glps.shop/wp-json/wc/store/v1/products/{product_id}"
PRODUCT_PAGE = "https://glps.shop/?post_type=product&p={product_id}"
USER_AGENT = "Mozilla/5.0 (compatible; GlowLabCatalogUpdater/1.0)"


def request_bytes(url: str) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(), response.headers.get_content_type()


def fetch_image_url(product_id: int) -> str:
    try:
        payload, _ = request_bytes(STORE_API.format(product_id=product_id))
        product = json.loads(payload.decode("utf-8"))
        images = product.get("images") or []
        if images and images[0].get("src"):
            return images[0]["src"]
    except Exception as error:
        print(f"Store API lookup failed for {product_id}: {error}")

    page, _ = request_bytes(PRODUCT_PAGE.format(product_id=product_id))
    page_text = page.decode("utf-8", errors="replace")
    patterns = [
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'<img[^>]+class=["\'][^"\']*wp-post-image[^"\']*["\'][^>]+src=["\']([^"\']+)',
        r'<img[^>]+src=["\']([^"\']+)["\'][^>]+class=["\'][^"\']*wp-post-image',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_text, flags=re.IGNORECASE)
        if match:
            return html.unescape(match.group(1))

    raise RuntimeError(f"Could not locate the featured image for WooCommerce product {product_id}.")


def optimized_data_uri(product_id: int) -> str:
    image_url = fetch_image_url(product_id)
    print(f"Product {product_id} image: {image_url}")
    payload, _ = request_bytes(image_url)

    with Image.open(BytesIO(payload)) as source:
        image = source.convert("RGB")
        image.thumbnail((1200, 1600), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, format="WEBP", quality=88, method=6, optimize=True)

    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    print(f"Product {product_id} optimized image: {len(output.getvalue())} bytes")
    return "data:image/webp;base64," + encoded


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def build_products() -> list[dict]:
    return [
        {
            "slug": "glow-eyes",
            "group": "topicals",
            "name": "Glow Eyes",
            "category": "Under-Eye Serum",
            "dose": "0.34 fl oz / 10 mL",
            "price": 39.99,
            "tagline": "GHK-Cu + SNAP-8 + caffeine + panthenol",
            "description": "A targeted under-eye serum combining GHK-Cu, SNAP-8, caffeine, and panthenol in a lightweight roller formula. Designed to hydrate and refresh the delicate eye area while supporting a smoother, more rested-looking appearance.",
            "benefits": [
                "GHK-Cu supports skin-conditioning and collagen-signaling research",
                "SNAP-8 is studied for softening the look of expression lines",
                "Caffeine and panthenol help refresh, hydrate, and condition the under-eye area",
            ],
            "specs": [
                ["Key actives", "GHK-Cu, SNAP-8, caffeine, panthenol"],
                ["Size", "0.34 fl oz / 10 mL roller"],
                ["Storage", "Cool, dark; avoid direct sunlight"],
            ],
            "prep_label": "How to use",
            "prep": "Apply a small amount beneath the eyes using the roller applicator, then gently pat in. Use on clean, dry skin once or twice daily. Avoid direct contact with the eyes. Patch-test first. External use only.",
            "dosing": None,
            "caution": False,
            "disclaimer": "External research / cosmetic use only. Not for injection or ingestion.",
            "img": optimized_data_uri(484),
            "wc": 484,
        },
        {
            "slug": "glow-eyes-luxe-kpv",
            "group": "topicals",
            "name": "Glow Eyes Luxe with KPV",
            "category": "Under-Eye Serum",
            "dose": "0.34 fl oz / 10 mL",
            "price": 64.99,
            "tagline": "Advanced under-eye serum with KPV",
            "description": "The elevated Glow Eyes formula, enhanced with KPV alongside GHK-Cu, SNAP-8, caffeine, and panthenol. This advanced roller serum is designed to hydrate, condition, and refresh the delicate eye area while supporting a smoother, calmer, more revitalized appearance.",
            "benefits": [
                "KPV adds advanced skin-conditioning and calming support",
                "GHK-Cu and SNAP-8 support smoother-looking, conditioned skin",
                "Caffeine and panthenol help refresh and hydrate the under-eye area",
            ],
            "specs": [
                ["Key actives", "KPV, GHK-Cu, SNAP-8, caffeine, panthenol"],
                ["Size", "0.34 fl oz / 10 mL roller"],
                ["Storage", "Cool, dark; avoid direct sunlight"],
            ],
            "prep_label": "How to use",
            "prep": "Apply a small amount beneath the eyes using the roller applicator, then gently pat in. Use on clean, dry skin once or twice daily. Avoid direct contact with the eyes. Patch-test first. External use only.",
            "dosing": None,
            "caution": False,
            "disclaimer": "External research / cosmetic use only. Not for injection or ingestion.",
            "img": optimized_data_uri(485),
            "wc": 485,
        },
    ]


def update_product_catalog(text: str, products: list[dict]) -> str:
    if '"slug":"glow-eyes"' in text or '"slug":"glow-eyes-luxe-kpv"' in text:
        raise RuntimeError("One or both Glow Eyes products already exist; refusing to create duplicates.")

    anchor = '},{"slug":"rose-recovery-mist"'
    if anchor not in text:
        raise RuntimeError("Could not find the Rose Recovery Mist catalog anchor.")

    insertion = "}," + ",".join(compact_json(product) for product in products) + ',{"slug":"rose-recovery-mist"'
    updated = text.replace(anchor, insertion, 1)

    for product in products:
        if f'"slug":"{product["slug"]}"' not in updated:
            raise RuntimeError(f'Failed to insert {product["slug"]}.')
        if f'"wc":{product["wc"]}' not in updated:
            raise RuntimeError(f'Failed to connect WooCommerce product {product["wc"]}.')

    return updated


def update_structured_data(text: str, products: list[dict]) -> str:
    pattern = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.DOTALL)
    item_list_updates = 0

    def replace(match: re.Match) -> str:
        nonlocal item_list_updates
        try:
            data = json.loads(match.group(1))
        except json.JSONDecodeError:
            return match.group(0)

        if data.get("@type") != "ItemList":
            return match.group(0)

        items = data.setdefault("itemListElement", [])
        names = {item.get("name") for item in items if isinstance(item, dict)}
        position = max([item.get("position", 0) for item in items if isinstance(item, dict)] or [0]) + 1

        for product in products:
            if product["name"] in names:
                continue
            items.append(
                {
                    "@type": "Product",
                    "position": position,
                    "name": f'{product["name"]} {product["dose"]}',
                    "category": "Skincare & Topicals",
                    "brand": {"@type": "Brand", "name": "Glow Lab Protocols"},
                    "url": f'https://glowlabprotocols.com/#product/{product["slug"]}',
                    "offers": {
                        "@type": "Offer",
                        "price": product["price"],
                        "priceCurrency": "USD",
                        "availability": "https://schema.org/InStock",
                        "url": f'https://glowlabprotocols.com/#product/{product["slug"]}',
                    },
                }
            )
            position += 1

        item_list_updates += 1
        return '<script type="application/ld+json">' + compact_json(data) + "</script>"

    updated = pattern.sub(replace, text)
    if item_list_updates != 1:
        raise RuntimeError(f"Expected one ItemList structured-data block; found {item_list_updates}.")
    return updated


def update_llms() -> None:
    if not LLMS_PATH.exists():
        return

    text = LLMS_PATH.read_text(encoding="utf-8")
    if "Glow Eyes Luxe with KPV" in text:
        return

    heading = "## Skincare & topicals\n"
    if heading not in text:
        raise RuntimeError("Could not find the Skincare & topicals section in llms.txt.")

    additions = (
        "- Glow Eyes — 0.34 fl oz / 10 mL — $39.99\n"
        "- Glow Eyes Luxe with KPV — 0.34 fl oz / 10 mL — $64.99\n"
    )
    LLMS_PATH.write_text(text.replace(heading, heading + additions, 1), encoding="utf-8")


def main() -> None:
    products = build_products()
    original = INDEX_PATH.read_text(encoding="utf-8")
    updated = update_product_catalog(original, products)
    updated = update_structured_data(updated, products)
    INDEX_PATH.write_text(updated, encoding="utf-8")
    update_llms()

    print("Added Glow Eyes and Glow Eyes Luxe with KPV.")
    print("WooCommerce IDs: 484 and 485.")
    print(f"index.html characters: {len(original)} -> {len(updated)}")


if __name__ == "__main__":
    main()

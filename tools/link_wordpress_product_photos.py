from __future__ import annotations

import json
from pathlib import Path

INDEX_PATH = Path("index.html")
REPORT_PATH = Path("wordpress-photo-link-report.txt")

PRODUCT_IMAGES = {
    "glutathione-1500": "https://glps.shop/wp-content/uploads/2026/07/01-glutathione-1500mg.webp",
    "reta-20": "https://glps.shop/wp-content/uploads/2026/07/02-reta-20mg.webp",
    "klow-blend": "https://glps.shop/wp-content/uploads/2026/07/03-klow-80mg.webp",
    "bpc-157": "https://glps.shop/wp-content/uploads/2026/07/04-bpc-157-10mg.webp",
    "selank": "https://glps.shop/wp-content/uploads/2026/07/05-selank-10mg.webp",
    "tesamorelin-ipamorelin": "https://glps.shop/wp-content/uploads/2026/07/06-tesa-ipa-13mg-3mg.webp",
    "pt-141": "https://glps.shop/wp-content/uploads/2026/07/07-pt-141-10mg.webp",
    "ss-31": "https://glps.shop/wp-content/uploads/2026/07/08-ss-31-10mg.webp",
}


def replace_product_image(text: str, product_slug: str, image_url: str) -> str:
    marker = f'"slug":"{product_slug}"'
    product_start = text.find(marker)
    if product_start < 0:
        raise LookupError(f"Catalog product slug not found: {product_slug}")

    next_product = text.find('},{"slug":"', product_start + len(marker))
    product_end = next_product if next_product >= 0 else len(text)
    img_marker = '"img":"'
    img_start = text.find(img_marker, product_start, product_end)
    if img_start < 0:
        raise LookupError(f"Image field not found for product: {product_slug}")

    value_start = img_start + len(img_marker)
    cursor = value_start
    while cursor < product_end:
        quote = text.find('"', cursor, product_end)
        if quote < 0:
            break
        backslashes = 0
        check = quote - 1
        while check >= value_start and text[check] == "\\":
            backslashes += 1
            check -= 1
        if backslashes % 2 == 0:
            escaped_url = json.dumps(image_url, ensure_ascii=False)[1:-1]
            return text[:value_start] + escaped_url + text[quote:]
        cursor = quote + 1
    raise ValueError(f"Could not determine end of image value for: {product_slug}")


def main() -> None:
    text = INDEX_PATH.read_text(encoding="utf-8")
    report_lines = ["FINAL PRODUCT PHOTO LINK REPORT", ""]

    for product_slug, image_url in PRODUCT_IMAGES.items():
        text = replace_product_image(text, product_slug, image_url)
        report_lines.extend(
            [
                f"PRODUCT_SLUG: {product_slug}",
                f"IMAGE: {image_url}",
                "STATUS: LINKED",
                "---",
            ]
        )

    INDEX_PATH.write_text(text, encoding="utf-8")
    REPORT_PATH.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print(f"Linked {len(PRODUCT_IMAGES)} final product photos.")


if __name__ == "__main__":
    main()

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


def object_bounds(text: str, product_slug: str) -> tuple[int, int]:
    marker = f'"slug":"{product_slug}"'
    marker_pos = text.find(marker)
    if marker_pos < 0:
        raise LookupError(f"Catalog product slug not found: {product_slug}")

    start = marker_pos
    while start >= 0 and text[start] != "{":
        start -= 1
    if start < 0:
        raise ValueError(f"Could not locate product object start: {product_slug}")

    depth = 0
    in_string = False
    escaped = False
    for cursor in range(start, len(text)):
        char = text[cursor]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return start, cursor + 1

    raise ValueError(f"Could not locate product object end: {product_slug}")


def replace_product_image(text: str, product_slug: str, image_url: str) -> str:
    start, end = object_bounds(text, product_slug)
    product = json.loads(text[start:end])
    product["img"] = image_url
    replacement = json.dumps(product, ensure_ascii=False, separators=(",", ":"))
    return text[:start] + replacement + text[end:]


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

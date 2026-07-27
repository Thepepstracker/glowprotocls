from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

MEDIA_API = "https://glps.shop/wp-json/wp/v2/media"
INDEX_PATH = Path("index.html")
REPORT_PATH = Path("wordpress-photo-link-report.txt")

PRODUCTS = {
    "glutathione-1500": ["01-glutathione-1500mg", "glutathione-1500mg"],
    "reta-20": ["02-reta-20mg", "reta-20mg"],
    "klow-blend": ["03-klow-80mg", "klow-80mg"],
    "bpc-157": ["04-bpc-157-10mg", "bpc-157-10mg"],
    "selank": ["05-selank-10mg", "selank-10mg"],
    "tesamorelin-ipamorelin": ["06-tesa-ipa-13mg-3mg", "tesa-ipa-13mg-3mg"],
    "pt-141": ["07-pt-141-10mg", "pt-141-10mg"],
    "ss-31": ["08-ss-31-10mg", "ss-31-10mg"],
}


def fetch_recent_media() -> list[dict]:
    media: list[dict] = []
    headers = {"User-Agent": "GlowLabProtocolsCatalogUpdater/1.0"}
    for page in range(1, 4):
        query = urllib.parse.urlencode(
            {
                "per_page": 100,
                "page": page,
                "orderby": "date",
                "order": "desc",
            }
        )
        request = urllib.request.Request(f"{MEDIA_API}?{query}", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                batch = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            if page == 1:
                raise RuntimeError(f"Could not read WordPress Media Library: {exc}") from exc
            break
        if not isinstance(batch, list) or not batch:
            break
        media.extend(batch)
        if len(batch) < 100:
            break
        time.sleep(0.4)
    return media


def normalize(value: str) -> str:
    value = urllib.parse.unquote(value).lower()
    value = re.sub(r"\.(png|jpe?g|webp)$", "", value)
    value = re.sub(r"-\d+x\d+$", "", value)
    return value


def select_media_url(media: list[dict], expected_stems: list[str]) -> str:
    expected = [normalize(stem) for stem in expected_stems]
    scored: list[tuple[int, str, str]] = []
    for item in media:
        source_url = str(item.get("source_url") or "")
        slug = str(item.get("slug") or "")
        title = str((item.get("title") or {}).get("rendered") or "")
        filename = Path(urllib.parse.urlparse(source_url).path).name
        haystacks = [normalize(filename), normalize(slug), normalize(title)]
        score = 0
        for stem in expected:
            for haystack in haystacks:
                if haystack == stem:
                    score = max(score, 100)
                elif stem in haystack:
                    score = max(score, 80)
                elif haystack in stem and len(haystack) > 5:
                    score = max(score, 60)
        if score and source_url:
            scored.append((score, source_url, filename))
    if not scored:
        raise LookupError(f"No WordPress media matched: {', '.join(expected_stems)}")
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored[0][1]


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
    media = fetch_recent_media()
    if not media:
        raise RuntimeError("WordPress Media Library returned no media items")

    text = INDEX_PATH.read_text(encoding="utf-8")
    report_lines = ["WORDPRESS PRODUCT PHOTO LINK REPORT", ""]

    for product_slug, expected_stems in PRODUCTS.items():
        url = select_media_url(media, expected_stems)
        text = replace_product_image(text, product_slug, url)
        report_lines.extend(
            [
                f"PRODUCT_SLUG: {product_slug}",
                f"WORDPRESS_IMAGE: {url}",
                "STATUS: LINKED",
                "---",
            ]
        )

    INDEX_PATH.write_text(text, encoding="utf-8")
    REPORT_PATH.write_text("\n".join(report_lines) + "\n", encoding="utf-8")
    print(f"Linked {len(PRODUCTS)} final WordPress product photos.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path

INDEX = Path("index.html")
REPORT = Path("missing-images-report.txt")
STORE_API = "https://glps.shop/wp-json/wc/store/v1/products/{}"


def get_wc_image(product_id: int | None) -> tuple[str, str]:
    if not product_id:
        return "NO_WC_ID", ""
    request = urllib.request.Request(
        STORE_API.format(product_id),
        headers={"User-Agent": "GlowLabCatalogAudit/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        return f"HTTP_{exc.code}", ""
    except Exception as exc:  # noqa: BLE001
        return f"ERROR_{type(exc).__name__}", ""

    images = data.get("images") or []
    if not images:
        return "NO_WC_IMAGE", ""
    source = images[0].get("src") or images[0].get("thumbnail") or ""
    return ("WC_IMAGE_AVAILABLE" if source else "NO_WC_IMAGE"), source


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")

    # Product objects are minified and each contains slug, group, name, img, and wc.
    object_pattern = re.compile(
        r'\{\"slug\":\"(?P<slug>[^\"]+)\"(?P<body>.*?)(?=\},\{\"slug\":|\}\];)',
        re.DOTALL,
    )

    rows: list[dict[str, object]] = []
    for match in object_pattern.finditer(text):
        slug = match.group("slug")
        body = match.group("body")

        def capture(pattern: str, default: str = "") -> str:
            found = re.search(pattern, body, re.DOTALL)
            return found.group(1) if found else default

        name = capture(r'\"name\":\"([^\"]+)\"', slug)
        group = capture(r'\"group\":\"([^\"]+)\"')
        image = capture(r'\"img\":\"([^\"]*)\"')
        wc_raw = capture(r'\"wc\":(null|\d+)', "null")
        wc_id = None if wc_raw == "null" else int(wc_raw)

        is_placeholder = (
            image.startswith("data:image/svg+xml")
            or "Photo%20coming%20soon" in image
            or "Photo coming soon" in image
            or not image
        )
        if not is_placeholder:
            continue

        wc_status, wc_image = get_wc_image(wc_id)
        rows.append(
            {
                "slug": slug,
                "name": name,
                "group": group,
                "wc_id": wc_id,
                "wc_status": wc_status,
                "wc_image": wc_image,
            }
        )

    lines = [
        "MISSING PRODUCT IMAGE AUDIT",
        f"Placeholder products found: {len(rows)}",
        "",
    ]
    for row in rows:
        lines.extend(
            [
                f"NAME: {row['name']}",
                f"SLUG: {row['slug']}",
                f"GROUP: {row['group']}",
                f"WC_ID: {row['wc_id']}",
                f"WC_STATUS: {row['wc_status']}",
                f"WC_IMAGE: {row['wc_image']}",
                "---",
            ]
        )

    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(REPORT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()

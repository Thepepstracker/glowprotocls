from __future__ import annotations

import html
import re
from pathlib import Path
from urllib.parse import quote

INDEX = Path("index.html")

PRODUCTS = [
    {
        "slug": "adamax-10",
        "name": "ADAMAX",
        "dose": "10 mg",
        "subtitle": "RESEARCH PEPTIDE",
        "wc": 463,
    },
    {
        "slug": "reta-20",
        "name": "RETATRUTIDE",
        "dose": "20 mg",
        "subtitle": "RESEARCH PEPTIDE",
        "wc": 464,
    },
    {
        "slug": "glutathione-1500",
        "name": "GLUTATHIONE",
        "dose": "1500 mg",
        "subtitle": "REDUCED L-GLUTATHIONE",
        "wc": 465,
    },
]


def make_render(product: dict[str, object]) -> str:
    name = html.escape(str(product["name"]))
    dose = html.escape(str(product["dose"]))
    subtitle = html.escape(str(product["subtitle"]))

    name_size = 39 if len(name) <= 9 else 32 if len(name) <= 12 else 27

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fffdf9"/>
    <stop offset="0.55" stop-color="#f5eee2"/>
    <stop offset="1" stop-color="#e8dcc9"/>
  </linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#9f7329"/>
    <stop offset="0.45" stop-color="#d8b66a"/>
    <stop offset="1" stop-color="#a9792b"/>
  </linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#d9d9d9" stop-opacity=".55"/>
    <stop offset=".25" stop-color="#ffffff" stop-opacity=".92"/>
    <stop offset=".65" stop-color="#e7e7e7" stop-opacity=".56"/>
    <stop offset="1" stop-color="#bdbdbd" stop-opacity=".55"/>
  </linearGradient>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
    <feDropShadow dx="0" dy="22" stdDeviation="18" flood-color="#6b5437" flood-opacity=".22"/>
  </filter>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="22"/>
  </filter>
</defs>
<rect width="900" height="900" fill="url(#bg)"/>
<circle cx="725" cy="170" r="165" fill="#ffffff" opacity=".38" filter="url(#soft)"/>
<circle cx="115" cy="710" r="185" fill="#c9a24b" opacity=".09" filter="url(#soft)"/>
<ellipse cx="455" cy="782" rx="275" ry="48" fill="#7b6548" opacity=".14" filter="url(#soft)"/>

<!-- Presentation box -->
<g filter="url(#shadow)">
  <rect x="138" y="185" width="295" height="520" rx="9" fill="#fff" stroke="#e0d4c2" stroke-width="3"/>
  <rect x="138" y="663" width="295" height="42" fill="url(#gold)"/>
  <text x="285" y="300" text-anchor="middle" font-family="Georgia,serif" font-size="95" fill="url(#gold)">GLP</text>
  <text x="285" y="352" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" letter-spacing="5" fill="#1b1b1b">GLOW LAB</text>
  <text x="285" y="384" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" letter-spacing="4" fill="#b18438">PROTOCOLS</text>
  <line x1="188" y1="418" x2="382" y2="418" stroke="#d9c7a7"/>
  <text x="285" y="453" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" letter-spacing="3" fill="#555">ADVANCED PEPTIDE SCIENCE</text>
  <text x="285" y="535" text-anchor="middle" font-family="Arial,sans-serif" font-size="{name_size}" font-weight="700" fill="#161616">{name}</text>
  <text x="285" y="574" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#b18438">{dose}</text>
  <text x="285" y="612" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" letter-spacing="2" fill="#5e5a54">{subtitle}</text>
</g>

<!-- Vial -->
<g filter="url(#shadow)">
  <rect x="478" y="208" width="230" height="92" rx="22" fill="#d9d9d9" stroke="#9d9d9d" stroke-width="3"/>
  <rect x="493" y="197" width="200" height="34" rx="8" fill="#f5f5f5" stroke="#aaa" stroke-width="3"/>
  <g opacity=".65">
    <line x1="515" y1="203" x2="515" y2="225" stroke="#aaa"/>
    <line x1="545" y1="203" x2="545" y2="225" stroke="#aaa"/>
    <line x1="575" y1="203" x2="575" y2="225" stroke="#aaa"/>
    <line x1="605" y1="203" x2="605" y2="225" stroke="#aaa"/>
    <line x1="635" y1="203" x2="635" y2="225" stroke="#aaa"/>
    <line x1="665" y1="203" x2="665" y2="225" stroke="#aaa"/>
  </g>
  <path d="M495 286 Q478 310 478 345 L478 708 Q478 744 514 754 L672 754 Q708 744 708 708 L708 345 Q708 310 691 286Z" fill="url(#glass)" stroke="#aaa" stroke-width="3"/>
  <rect x="493" y="335" width="200" height="345" rx="5" fill="#fffdfb" stroke="#ded4c7" stroke-width="2"/>
  <rect x="493" y="647" width="200" height="33" fill="url(#gold)"/>
  <text x="593" y="412" text-anchor="middle" font-family="Georgia,serif" font-size="65" fill="url(#gold)">GLP</text>
  <text x="593" y="450" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" letter-spacing="3" fill="#1b1b1b">GLOW LAB</text>
  <text x="593" y="473" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" letter-spacing="3" fill="#b18438">PROTOCOLS</text>
  <text x="593" y="495" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" letter-spacing="1.8" fill="#555">ADVANCED PEPTIDE SCIENCE</text>
  <line x1="520" y1="516" x2="666" y2="516" stroke="#d9c7a7"/>
  <text x="593" y="557" text-anchor="middle" font-family="Arial,sans-serif" font-size="{max(20, name_size-8)}" font-weight="700" fill="#151515">{name}</text>
  <text x="593" y="590" text-anchor="middle" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#b18438">{dose}</text>
  <text x="593" y="615" text-anchor="middle" font-family="Arial,sans-serif" font-size="8.5" letter-spacing="1.2" fill="#555">{subtitle}</text>
  <rect x="530" y="624" width="126" height="18" fill="none" stroke="#222" stroke-width="1.5"/>
  <text x="593" y="637" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" font-weight="700" letter-spacing="1" fill="#222">RESEARCH USE ONLY</text>
</g>

<!-- Quality marks -->
<g font-family="Arial,sans-serif" fill="#4d4943">
  <circle cx="383" cy="760" r="19" fill="none" stroke="#b18438" stroke-width="2"/>
  <text x="383" y="765" text-anchor="middle" font-size="10" font-weight="700" fill="#b18438">99+</text>
  <text x="411" y="757" font-size="11" font-weight="700">PURITY</text>
  <text x="411" y="773" font-size="9">QUALITY ASSURED</text>
  <circle cx="566" cy="760" r="19" fill="none" stroke="#b18438" stroke-width="2"/>
  <path d="M557 760 l7 7 l12 -15" fill="none" stroke="#b18438" stroke-width="3"/>
  <text x="594" y="757" font-size="11" font-weight="700">THIRD PARTY</text>
  <text x="594" y="773" font-size="9">TESTED</text>
</g>
<text x="450" y="838" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" letter-spacing="4" fill="#8c7651">THE GLOW STANDARD</text>
</svg>'''

    return "data:image/svg+xml;charset=UTF-8," + quote(svg, safe="")


def replace_image(text: str, product: dict[str, object]) -> str:
    slug = str(product["slug"])
    wc = int(product["wc"])
    image = make_render(product)

    pattern = re.compile(
        rf'(\{{"slug":"{re.escape(slug)}".*?"img":")[^"]*(","wc":{wc}\}})',
        re.DOTALL,
    )
    updated, count = pattern.subn(lambda match: match.group(1) + image + match.group(2), text, count=1)
    if count != 1:
        raise RuntimeError(f"Could not replace image for {slug}; matches={count}")
    return updated


def cleanup() -> None:
    paths = [
        Path("missing-images-report.txt"),
        Path("tools/audit_missing_images.py"),
        Path(".github/workflows/audit-missing-product-images.yml"),
        Path("tools/add_missing_product_renders.py"),
        Path(".github/workflows/add-missing-product-renders.yml"),
    ]
    for path in paths:
        if path.exists():
            path.unlink()


def main() -> None:
    original = INDEX.read_text(encoding="utf-8")
    updated = original
    for product in PRODUCTS:
        updated = replace_image(updated, product)

    if updated == original:
        raise RuntimeError("index.html did not change")

    INDEX.write_text(updated, encoding="utf-8")
    cleanup()

    print("Added GLP-branded renders for:")
    for product in PRODUCTS:
        print(f"- {product['name']} {product['dose']} (WooCommerce {product['wc']})")


if __name__ == "__main__":
    main()

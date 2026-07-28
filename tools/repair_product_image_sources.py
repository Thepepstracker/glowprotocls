from __future__ import annotations

import re
from pathlib import Path

INDEX = Path("index.html")
PLACEHOLDER = Path("product-images/product-placeholder.svg")
REPORT = Path("product-image-repair-report.txt")

LOCAL_IMAGES = {
    "aicar": "/product-images/aicar.png",
    "bpc-157": "/product-images/bpc157.png",
    "klow-blend": "/product-images/klow.png",
    "reta-20": "/product-images/retatrutide.png",
    "ss-31": "/product-images/ss31.png",
}

HELPER = (
    'const uploadedImageBySlug={'
    'aicar:"/product-images/aicar.png",'
    '"bpc-157":"/product-images/bpc157.png",'
    '"klow-blend":"/product-images/klow.png",'
    '"reta-20":"/product-images/retatrutide.png",'
    '"ss-31":"/product-images/ss31.png"'
    '};'
    'const productImage=p=>uploadedImageBySlug[p.slug]||p.img||"/product-images/product-placeholder.svg";'
)

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900" role="img" aria-label="Glow Lab Protocols product image">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#faf7f1"/></linearGradient></defs>
<rect width="900" height="900" rx="36" fill="url(#g)"/>
<rect x="70" y="70" width="760" height="760" rx="28" fill="none" stroke="#d8bd7e" stroke-width="3"/>
<circle cx="450" cy="360" r="132" fill="#fff" stroke="#c9a24b" stroke-width="5"/>
<text x="450" y="335" text-anchor="middle" font-family="Georgia,serif" font-size="88" font-weight="700" fill="#c9a24b">GLP</text>
<text x="450" y="395" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" letter-spacing="7" fill="#1b1b1b">GLOW LAB</text>
<text x="450" y="430" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" letter-spacing="5" fill="#1b1b1b">PROTOCOLS</text>
<text x="450" y="590" text-anchor="middle" font-family="Georgia,serif" font-size="48" fill="#1b1b1b">Product Photo</text>
<text x="450" y="645" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" letter-spacing="2" fill="#6f6a61">IMAGE BEING UPDATED</text>
</svg>
'''


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")

    helper_pattern = re.compile(
        r'const uploadedImageBySlug=\{.*?\};const productImage=p=>uploadedImageBySlug\[p\.slug\]\|\|p\.img(?:\|\|"/product-images/product-placeholder\.svg")?;',
        re.DOTALL,
    )
    text, helper_count = helper_pattern.subn(HELPER, text, count=1)
    if helper_count != 1:
        raise RuntimeError(f"Expected one product image helper, found {helper_count}")

    image_tag = '<img src="${productImage(p)}"'
    fallback_tag = '''<img src="${productImage(p)}" onerror="this.onerror=null;this.src='/product-images/product-placeholder.svg'"'''
    if "product-placeholder.svg'\"" not in text:
        image_count = text.count(image_tag)
        if image_count < 2:
            raise RuntimeError(f"Expected at least two product image renderers, found {image_count}")
        text = text.replace(image_tag, fallback_tag)
    else:
        image_count = 0

    INDEX.write_text(text, encoding="utf-8")
    PLACEHOLDER.parent.mkdir(parents=True, exist_ok=True)
    PLACEHOLDER.write_text(SVG, encoding="utf-8")

    REPORT.write_text(
        "PRODUCT IMAGE REPAIR REPORT\n\n"
        "Exact local images enabled:\n"
        "- BPC-157 10 mg\n"
        "- KLOW 80 mg\n"
        "- Retatrutide 20 mg (corrected slug from reta to reta-20)\n"
        "- SS-31 10 mg\n\n"
        "Fallback protection added to catalog cards and product modals.\n"
        "Products whose external WordPress image is unavailable now show a branded placeholder instead of a broken image.\n",
        encoding="utf-8",
    )
    print("Repaired product image source mapping and added resilient fallbacks.")


if __name__ == "__main__":
    main()

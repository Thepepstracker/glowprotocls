import json
import re
from pathlib import Path

INDEX = Path("index.html")
LLMS = Path("llms.txt")

updates = {
    "bpc-157": {
        "name": "BPC-157",
        "dose": "10 mg",
    },
    "klow-blend": {
        "name": "KLOW",
        "dose": "80 mg",
        "tagline": "Multi-peptide research blend",
    },
    "tesamorelin-ipamorelin": {
        "name": "Tesamorelin / Ipamorelin",
        "dose": "13 mg / 3 mg",
        "tagline": "TESA / IPA research blend",
    },
}


def object_bounds(text: str, slug: str) -> tuple[int, int]:
    needle = f'"slug":"{slug}"'
    pos = text.find(needle)
    if pos < 0:
        raise RuntimeError(f"Could not find product slug: {slug}")

    start = pos
    while start >= 0 and text[start] != "{":
        start -= 1
    if start < 0:
        raise RuntimeError(f"Could not find object start for: {slug}")

    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1

    raise RuntimeError(f"Could not find object end for: {slug}")


text = INDEX.read_text(encoding="utf-8")

for slug, fields in updates.items():
    start, end = object_bounds(text, slug)
    product = json.loads(text[start:end])
    product.update(fields)
    replacement = json.dumps(product, ensure_ascii=False, separators=(",", ":"))
    text = text[:start] + replacement + text[end:]

# Keep searchable structured product names synchronized.
text = text.replace('"name":"BPC-157 5 mg"', '"name":"BPC-157 10 mg"')
text = text.replace(
    '"name":"Tesamorelin + Ipamorelin 10 mg / 10 mg"',
    '"name":"Tesamorelin / Ipamorelin 13 mg / 3 mg"',
)
text = text.replace(
    '"name":"KLOW Blend Multi-peptide blend"',
    '"name":"KLOW 80 mg"',
)

INDEX.write_text(text, encoding="utf-8")

if LLMS.exists():
    llms = LLMS.read_text(encoding="utf-8")
    llms = re.sub(r"^- BPC-157 — .*?$", "- BPC-157 — 10 mg — $32.00", llms, flags=re.MULTILINE)
    llms = re.sub(
        r"^- Tesamorelin \+ Ipamorelin — .*?$",
        "- Tesamorelin / Ipamorelin — 13 mg / 3 mg — $82.00",
        llms,
        flags=re.MULTILINE,
    )
    llms = re.sub(
        r"^- KLOW blend .*?$",
        "- KLOW blend (GHK-Cu, BPC-157, TB-500, KPV) — 80 mg — $86.99",
        llms,
        flags=re.MULTILINE,
    )
    LLMS.write_text(llms, encoding="utf-8")

print("Updated final label names and doses in index.html and llms.txt")

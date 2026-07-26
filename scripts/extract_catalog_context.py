from pathlib import Path

source_path = Path("index.html")
output_path = Path("catalog-context.txt")

text = source_path.read_text(encoding="utf-8")

needles = [
    "Protocol 01",
    "Protocol 02",
    "Rose Recovery",
    "Cu-Hair",
    "Glow CPR",
    "const products",
    "let products",
    "productData",
    "product-data",
    "wcProduct",
    "woocommerce",
    "add-to-cart",
    "add_to_cart",
    "data-product-id",
    "data-wc-id",
    "product-card",
    "topicals",
]

parts = [
    "CATALOG CONTEXT EXTRACT\n",
    f"index.html characters: {len(text)}\n",
    f"index.html lines: {text.count(chr(10)) + 1}\n",
]

seen_ranges: list[tuple[int, int]] = []
for needle in needles:
    start_search = 0
    while True:
        index = text.lower().find(needle.lower(), start_search)
        if index == -1:
            break
        start = max(0, index - 1800)
        end = min(len(text), index + len(needle) + 3600)
        if not any(start >= previous_start and end <= previous_end for previous_start, previous_end in seen_ranges):
            seen_ranges.append((start, end))
            parts.append("\n" + "=" * 80 + "\n")
            parts.append(f"MATCH: {needle!r} at character {index}\n")
            parts.append("=" * 80 + "\n")
            parts.append(text[start:end])
            parts.append("\n")
        start_search = index + len(needle)

parts.append("\n" + "=" * 80 + "\n")
parts.append("FINAL 12000 CHARACTERS OF INDEX.HTML\n")
parts.append("=" * 80 + "\n")
parts.append(text[-12000:])
parts.append("\n")

output_path.write_text("".join(parts), encoding="utf-8")
print(f"Wrote {output_path} with {output_path.stat().st_size} bytes")

from pathlib import Path
import re

source_path = Path("index.html")
output_path = Path("catalog-context.txt")

raw_text = source_path.read_text(encoding="utf-8")

# Remove only embedded image payloads from this diagnostic copy. The live index is untouched.
text = re.sub(
    r"data:image/[^\"']+",
    "[EMBEDDED_IMAGE_DATA_OMITTED]",
    raw_text,
    flags=re.IGNORECASE,
)

needles = [
    '"slug":"protocol-01"',
    '"slug":"protocol-02"',
    '"slug":"rose-recovery-mist"',
    '"slug":"cu-hair-01"',
    '"slug":"cu-hair-02"',
    '"group":"topicals"',
    "const products",
    "let products",
    "productData",
    "add_to_cart",
    "data-product-id",
    "wc:",
    "renderProducts",
    "openProduct",
]

parts = [
    "CLEAN CATALOG CONTEXT EXTRACT\n",
    f"index.html characters: {len(raw_text)}\n",
    f"sanitized characters: {len(text)}\n",
    f"index.html lines: {raw_text.count(chr(10)) + 1}\n",
]

seen_ranges: list[tuple[int, int]] = []
for needle in needles:
    start_search = 0
    while True:
        index = text.lower().find(needle.lower(), start_search)
        if index == -1:
            break
        start = max(0, index - 1400)
        end = min(len(text), index + len(needle) + 4200)
        if not any(start >= previous_start and end <= previous_end for previous_start, previous_end in seen_ranges):
            seen_ranges.append((start, end))
            parts.append("\n" + "=" * 80 + "\n")
            parts.append(f"MATCH: {needle!r} at sanitized character {index}\n")
            parts.append("=" * 80 + "\n")
            parts.append(text[start:end])
            parts.append("\n")
        start_search = index + len(needle)

parts.append("\n" + "=" * 80 + "\n")
parts.append("FINAL 18000 SANITIZED CHARACTERS OF INDEX.HTML\n")
parts.append("=" * 80 + "\n")
parts.append(text[-18000:])
parts.append("\n")

output_path.write_text("".join(parts), encoding="utf-8")
print(f"Wrote {output_path} with {output_path.stat().st_size} bytes")

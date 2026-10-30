"""Read the printed name sitting on a signature line."""

from __future__ import annotations

import json
import sys

import fitz


def nearby_texts(pdf_bytes: bytes, boxes: list[dict]) -> list[dict]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    found: list[dict] = []
    try:
        for box in boxes:
            index = int(box.get("index") or 0)
            page_index = int(box.get("page") or 1) - 1
            if page_index < 0 or page_index >= doc.page_count:
                found.append({"index": index, "text": ""})
                continue
            page = doc[page_index]
            x0 = float(box.get("x") or 0)
            y0 = float(box.get("y") or 0)
            x1 = x0 + float(box.get("width") or 0)
            y1 = y0 + float(box.get("height") or 0)
            # Name is printed on the line or to its right. Keep the band
            # short so the next "OR" signer is not included.
            rect = fitz.Rect(x0 - 24, y0 - 6, x1 + 340, y1 + 18) & page.rect
            text = "" if rect.is_empty else page.get_textbox(rect)
            found.append({"index": index, "text": " ".join(text.split())})
    finally:
        doc.close()
    return found


def main() -> None:
    pdf_path = sys.argv[1]
    payload = json.load(sys.stdin)
    with open(pdf_path, "rb") as handle:
        pdf_bytes = handle.read()
    json.dump(nearby_texts(pdf_bytes, payload.get("boxes") or []), sys.stdout)


if __name__ == "__main__":
    main()

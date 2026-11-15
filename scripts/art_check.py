#!/usr/bin/env python3
"""Is a Japanese promo's artwork also printed in English? Compares card images.

For every tracked Japanese card, the artwork area of its TCGplayer image is hashed and compared
with every English card of the same Pokemon (any price). A close match means the same art was
printed in English, so the Japanese card isn't a Japan exclusive and the app hides it.

Hashes are cached in data/art_hashes.json (keyed by TCGplayer product id), so only new cards are
downloaded. Results go to data/art_matches.json (every Japanese card, its closest English cards and
the distance) and onto each Japanese card in data/singles.json as "artEn" when it matched.

Run by the daily sync; can also be run alone after a sync: python scripts/art_check.py
Needs Pillow (pip install pillow); without it the check is skipped and nothing is hidden.
"""
from __future__ import annotations

import io
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, SINGLES_PATH, http_get, write_json  # noqa: E402

HASHES = DATA / "art_hashes.json"
MATCHES = DATA / "art_matches.json"
# Bits that may differ (of 256) for two images to count as the same artwork. Same art in another
# language differs mostly in text and frame, which the crop avoids. Tuned on the calibration report.
DEFAULT_THRESHOLD = 52
MAX_DOWNLOADS = 3000  # per run; the cache fills up over a few runs if there's more
TIME_BUDGET = 15 * 60  # seconds


def art_hash(img_bytes: bytes) -> str | None:
    """256-bit difference hash of the artwork area (the middle of the art box), as hex."""
    from PIL import Image  # noqa: PLC0415
    try:
        im = Image.open(io.BytesIO(img_bytes)).convert("L")
    except Exception:
        return None
    w, h = im.size
    if w < 50 or h < 50:
        return None
    # Middle of the art box on a standard frame; on full arts it's the middle of the picture.
    box = (int(w * 0.14), int(h * 0.13), int(w * 0.86), int(h * 0.46))
    im = im.crop(box).resize((17, 16), Image.LANCZOS)
    px = list(im.getdata())
    bits = 0
    for y in range(16):
        row = px[y * 17:(y + 1) * 17]
        for x in range(16):
            bits = (bits << 1) | (1 if row[x] > row[x + 1] else 0)
    return f"{bits:064x}"


def dist(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def image_url(url: str | None) -> str | None:
    if not url:
        return None
    return re.sub(r"_\d+w\.(jpg|png)$", r"_200w.\1", url)


def run(cfg: dict, english_singles: list[dict] | None = None) -> None:
    try:
        import PIL  # noqa: F401, PLC0415
    except ImportError:
        print("Art check skipped: Pillow isn't installed.")
        return
    jc = (cfg.get("singles") or {}).get("japan") or {}
    threshold = jc.get("artMatchThreshold", DEFAULT_THRESHOLD)
    s = json.loads(SINGLES_PATH.read_text())
    jp = [c for c in s["cards"] if c.get("lang") == "ja"]
    if not jp:
        return
    mons = {c["pokemon"] for c in jp}
    rx = {m: re.compile(rf"\b{re.escape(m)}\b", re.I) for m in mons}
    # English candidates: every English single of these Pokemon the sync saw (any price), else the tracked ones.
    pool = english_singles if english_singles is not None else [c for c in s["cards"] if c.get("lang") != "ja"]
    en = [c for c in pool if c.get("lang") != "ja" and any(r.search(c["name"]) for r in rx.values())]
    cache = json.loads(HASHES.read_text()) if HASHES.exists() else {}
    t0, got, failed = time.time(), 0, 0
    for c in jp + en:
        k = str(c["id"])
        if k in cache or got >= MAX_DOWNLOADS or time.time() - t0 > TIME_BUDGET:
            continue
        url = image_url(c.get("img"))
        b = http_get(url, binary=True, sleep=0.03) if url else None
        h = art_hash(b) if b else None
        cache[k] = h  # None = no usable image; not retried until the cache entry is removed
        got += 1
        failed += h is None
    write_json(HASHES, cache)
    print(f"Art check: {got} new images hashed ({failed} unusable), {len(cache)} cached")

    report, n_match = [], 0
    for c in jp:
        h = cache.get(str(c["id"]))
        cands = []
        if h:
            for e in en:
                if not rx[c["pokemon"]].search(e["name"]):
                    continue
                eh = cache.get(str(e["id"]))
                if eh:
                    cands.append((dist(h, eh), e))
        cands.sort(key=lambda x: x[0])
        best = [{"id": e["id"], "name": e["name"], "group": e.get("group") or e.get("setName"), "dist": d} for d, e in cands[:3]]
        matched = bool(best) and best[0]["dist"] <= threshold
        c.pop("artEn", None)
        c["artChecked"] = bool(h) and bool(cands)
        if matched:
            c["artEn"] = best[0]
            n_match += 1
        report.append({"id": c["id"], "name": c["name"], "group": c.get("group"), "price": c["price"],
                       "hashed": bool(h), "candidates": len(cands), "sameArtInEnglish": matched, "closest": best})
    report.sort(key=lambda r: (r["closest"][0]["dist"] if r["closest"] else 999))
    write_json(MATCHES, {"threshold": threshold, "note": "dist = bits that differ of 256; at or under the threshold counts as the same artwork",
                         "cards": report})
    write_json(SINGLES_PATH, s)
    print(f"Art check: {n_match} of {len(jp)} Japanese cards share art with an English card (threshold {threshold})")


if __name__ == "__main__":
    from common import load_config  # noqa: E402
    run(load_config())

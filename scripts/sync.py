#!/usr/bin/env python3
"""Daily sync: pull TCGplayer Pokémon prices (via the tcgcsv.com mirror), find sets whose
chase cards feature the tracked Pokémon, record today's sealed-product prices into history.

Run by .github/workflows/sync.yml once a day. Standard library only.

  python scripts/sync.py              # normal run (skips if source hasn't updated)
  python scripts/sync.py --force      # run even if already synced today
  python scripts/sync.py --fixture DIR  # read responses from a local mirror (testing)
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BASE, META_PATH, best_price, chase_score, classify_sealed, compact_history, day_index,
    http_get, is_single, load_config, load_history, parent_name, parse_ts, put_point, write_json,
)
from common import HISTORY_PATH  # noqa: E402

FIXTURE: Path | None = None


def fetch(path: str, text: bool = False):
    if FIXTURE:
        p = FIXTURE / path.lstrip("/")
        if not p.exists():
            return None
        return p.read_text() if text else json.loads(p.read_text())
    if text:
        b = http_get(BASE + path, binary=True)
        return b.decode().strip() if b else None
    return http_get(BASE + path)


def results(resp) -> list:
    if not resp or not resp.get("success", True):
        return []
    return resp.get("results") or []


def main():
    global FIXTURE
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--fixture")
    args = ap.parse_args()
    if args.fixture:
        FIXTURE = Path(args.fixture)

    cfg = load_config()
    cat = cfg["categoryId"]
    tr = cfg["tracking"]

    last_updated = (fetch("/last-updated.txt", text=True) or "").strip()
    old_meta = json.loads(META_PATH.read_text()) if META_PATH.exists() else {}
    if not args.force and last_updated and old_meta.get("sourceUpdated") == last_updated and not old_meta.get("demo"):
        print(f"Source unchanged since {last_updated}; nothing to do.")
        return

    price_date = parse_ts(last_updated) or datetime.now(timezone.utc).date().isoformat()
    today = day_index(datetime.fromisoformat(price_date).date())

    groups = results(fetch(f"/tcgplayer/{cat}/groups"))
    print(f"{len(groups)} groups")
    by_name = {g["name"].strip(): g for g in groups}

    # Map gallery/vault sub-groups onto their parent set so their chase cards count.
    parent_of: dict[int, int] = {}
    for g in groups:
        pn = parent_name(g["name"])
        if pn and pn in by_name:
            parent_of[g["groupId"]] = by_name[pn]["groupId"]

    singles: dict[int, list] = {}  # parent groupId -> [{id,name,price,number,rarity,img}]
    sealed: list[dict] = []
    excluded = set(tr.get("excludeGroupIds") or [])

    for i, g in enumerate(groups, 1):
        gid = g["groupId"]
        if gid in excluded:
            continue
        products = results(fetch(f"/tcgplayer/{cat}/{gid}/products"))
        if not products:
            continue
        prices_rows = results(fetch(f"/tcgplayer/{cat}/{gid}/prices"))
        by_pid: dict[int, list] = {}
        for r in prices_rows:
            by_pid.setdefault(r["productId"], []).append(r)
        pgid = parent_of.get(gid, gid)
        for p in products:
            bp = best_price(by_pid.get(p["productId"], []))
            if is_single(p):
                if bp:
                    ext = {e["name"]: e["value"] for e in p.get("extendedData") or []}
                    singles.setdefault(pgid, []).append({
                        "id": p["productId"], "name": p["name"], "price": bp["price"],
                        "number": ext.get("Number"), "rarity": ext.get("Rarity"),
                        "img": p.get("imageUrl"), "url": p.get("url"),
                    })
            else:
                t = classify_sealed(p["name"])
                if t and pgid == gid:  # sealed lives in the main group
                    sealed.append({
                        "id": p["productId"], "groupId": gid, "name": p["name"], "type": t,
                        "img": p.get("imageUrl"), "url": p.get("url"),
                        "presale": bool((p.get("presaleInfo") or {}).get("isPresale")),
                        **({"price": bp["price"], "market": bp["market"], "low": bp["low"], "mid": bp["mid"]} if bp else {"price": None}),
                    })
        if i % 25 == 0:
            print(f"  {i}/{len(groups)} groups processed")

    # ---- decide which sets to track -------------------------------------------------
    always = set(tr.get("alwaysIncludeGroupIds") or [])
    sets_out = {}
    for g in groups:
        gid = g["groupId"]
        if gid in parent_of or gid in excluded:
            continue
        top = sorted(singles.get(gid, []), key=lambda s: -s["price"])[: tr["topSinglesPerSet"]]
        cs = chase_score(top, cfg["chasePokemon"])
        has_chase = any(c["price"] >= tr["minChaseCardPrice"] for c in cs["iconic"])
        if not (has_chase or gid in always):
            continue
        sets_out[gid] = {
            "id": gid, "name": g["name"], "abbr": g.get("abbreviation"),
            "release": parse_ts(g.get("publishedOn")),
            "topSingles": [{k: s[k] for k in ("id", "name", "price", "number", "rarity", "img", "url")} for s in top],
            "singlesIndex": round(sum(s["price"] for s in top[:5]), 2),
            "chaseScore": cs["score"],
        }

    products_out = []
    for s in sealed:
        if s["groupId"] not in sets_out:
            continue
        if s["price"] is None or s["price"] < tr["minSealedPrice"]:
            continue
        products_out.append(s)
    # Group-specific Pokémon Center ETB: TCGplayer often names them "... Elite Trainer Box [Pokemon Center Exclusive]"
    print(f"Tracking {len(sets_out)} sets, {len(products_out)} sealed products")

    # ---- history ----------------------------------------------------------------------
    history = load_history()
    keep = set()
    for p in products_out:
        key = str(p["id"])
        put_point(history, key, today, p["price"])
        keep.add(key)
    for s in sets_out.values():
        key = f"set:{s['id']}"
        put_point(history, key, today, s["singlesIndex"])
        keep.add(key)
    # keep series for products that dropped out temporarily (e.g. no sales today)
    for key in history["series"]:
        if key.isdigit() and any(str(p["id"]) == key for p in old_meta.get("products", [])):
            keep.add(key)
    h = cfg["history"]
    compact_history(history, today, h["dailyWindowDays"], h["olderBucketDays"], keep)
    history["lastDay"] = today

    meta = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceUpdated": last_updated,
        "priceDate": price_date,
        "source": "TCGplayer market prices via tcgcsv.com",
        "demo": False,
        "sets": list(sets_out.values()),
        "products": products_out,
    }
    write_json(META_PATH, meta)
    write_json(HISTORY_PATH, history)
    print(f"Wrote {META_PATH.name} and {HISTORY_PATH.name} for {price_date}")


if __name__ == "__main__":
    main()

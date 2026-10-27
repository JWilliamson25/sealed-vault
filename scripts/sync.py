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
from common import (  # noqa: E402
    SINGLE_EXCLUDE_RE, SINGLES_HISTORY_PATH, SINGLES_PATH, card_era, card_tier, chase_regexes, single_price,
)

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
    old_singles = json.loads(SINGLES_PATH.read_text()) if SINGLES_PATH.exists() else {}
    old_sub = {c["id"]: c.get("sub") for c in old_singles.get("cards", [])}
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
                    sp = single_price(by_pid.get(p["productId"], []), old_sub.get(p["productId"]))
                    singles.setdefault(pgid, []).append({
                        "id": p["productId"], "name": p["name"], "price": bp["price"],
                        "number": ext.get("Number"), "rarity": ext.get("Rarity"),
                        "img": p.get("imageUrl"), "url": p.get("url"),
                        "group": g["name"], "sub": sp["sub"], "sprice": sp["price"], "low": sp["low"],
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
        release = parse_ts(g.get("publishedOn"))
        if release and release == price_date:
            # Old catch-all groups (Miscellaneous, POP Series…) come back stamped with today's
            # date. That isn't a release date; the app treats it as unknown.
            release = None
        sets_out[gid] = {
            "id": gid, "name": g["name"], "abbr": g.get("abbreviation"),
            "release": release,
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

    sync_singles(cfg, groups, parent_of, singles, old_singles, price_date, today)


def group_release(g: dict, price_date: str) -> str | None:
    rel = parse_ts(g.get("publishedOn"))
    return None if rel == price_date else rel  # catch-all groups come back stamped with today


def sync_singles(cfg, groups, parent_of, singles, old_singles, price_date, today):
    """Track singles of the chase Pokemon inside the configured price band, plus peer medians."""
    sc = cfg.get("singles") or {}
    lo, hi = sc.get("trackMin", 20), sc.get("trackMax", 450)
    rx = chase_regexes(cfg["chasePokemon"])
    gby = {g["groupId"]: g for g in groups}
    was_tracked = {c["id"] for c in old_singles.get("cards", [])}

    cards, peers_raw = [], {}
    for pgid, lst in singles.items():
        parent = gby.get(pgid, {})
        release = group_release(parent, price_date)
        for c in lst:
            if SINGLE_EXCLUDE_RE.search(c["name"]) or SINGLE_EXCLUDE_RE.search(c.get("group") or ""):
                continue
            mon = next((nm for nm, _w, r in rx if r.search(c["name"])), None)
            if not mon:
                continue
            tier = card_tier(c["name"], c.get("rarity"), c.get("number"), release)
            era = card_era(release)
            price = c["sprice"]
            if price and price >= 3:  # peers use every price, so the band doesn't skew them
                peers_raw.setdefault(f"{mon}|{tier}|{era}", []).append(price)
            in_band = lo <= price <= hi
            keep_band = c["id"] in was_tracked and lo * 0.5 <= price <= hi * 2
            if not (in_band or keep_band):
                continue
            cards.append({
                "id": c["id"], "name": c["name"], "pokemon": mon, "tier": tier, "era": era,
                "rarity": c.get("rarity"), "number": c.get("number"), "sub": c.get("sub"),
                "setId": pgid, "setName": parent.get("name", c.get("group")), "group": c.get("group"),
                "release": release, "price": price, "low": c.get("low"), "img": c.get("img"), "url": c.get("url"),
            })

    def med(v):
        v = sorted(v)
        n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2
    peers = {k: {"median": round(med(v), 2), "n": len(v)} for k, v in peers_raw.items()}

    hist = load_history_file(SINGLES_HISTORY_PATH)
    keep = set()
    for c in cards:
        put_point(hist, str(c["id"]), today, c["price"])
        keep.add(str(c["id"]))
        keep.add(f"g:{c['id']}")  # PSA 10 series from the Scrydex import
    h = cfg["history"]
    compact_history(hist, today, h["dailyWindowDays"], h["olderBucketDays"], keep)
    hist["lastDay"] = today
    out = {**{k: v for k, v in old_singles.items() if k in ("psa10", "psa10Date", "scrydex")},
           "priceDate": price_date, "cards": cards, "peers": peers}
    write_json(SINGLES_PATH, out)
    write_json(SINGLES_HISTORY_PATH, hist)
    print(f"Tracking {len(cards)} singles of your chase Pokemon (${lo}-${hi}); {len(peers)} peer groups")


def load_history_file(path):
    if path.exists():
        return json.loads(path.read_text())
    return {"epoch": "2024-01-01", "series": {}}


if __name__ == "__main__":
    main()

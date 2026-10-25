#!/usr/bin/env python3
"""One-time backfill of past prices from tcgcsv.com's daily price archives (Feb 2024 onward),
so trend math works from day one instead of after months of daily syncs.

Run once via the "Backfill price history" workflow (Actions tab -> Run workflow).
Needs data/meta.json from a normal sync first, and the `7z` command (p7zip-full).

Be a good neighbour: each archive is ~2-4 MB and never changes, so every date is downloaded
at most once (finished dates are remembered in history.json -> "backfilled").

  python scripts/backfill.py --step 7 --since 2024-02-08
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BASE, HISTORY_PATH, META_PATH, best_price, compact_history, day_index, http_get,
    load_config, load_history, write_json,
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2024-02-08")
    ap.add_argument("--step", type=int, default=7, help="days between samples")
    ap.add_argument("--max", type=int, default=200, help="max archives this run")
    args = ap.parse_args()

    if not META_PATH.exists():
        sys.exit("Run scripts/sync.py first (needs data/meta.json).")
    if not shutil.which("7z"):
        sys.exit("The 7z command is required (apt-get install p7zip-full).")

    cfg = load_config()
    cat = cfg["categoryId"]
    meta = json.loads(META_PATH.read_text())
    history = load_history()
    done = set(history.get("backfilled", []))

    wanted_products = {p["id"]: p["groupId"] for p in meta["products"]}
    set_top5 = {s["id"]: [t["id"] for t in s["topSingles"][:5]] for s in meta["sets"]}
    # group ids whose price files we need: product groups + subgroups holding top singles are
    # unknown here, so we read every group folder for the category (it's local after extract).

    start = date.fromisoformat(args.since)
    end = date.fromisoformat(meta["priceDate"]) - timedelta(days=1)
    dates = []
    d = start
    while d <= end:
        if d.isoformat() not in done:
            dates.append(d)
        d += timedelta(days=args.step)
    dates = dates[: args.max]
    print(f"{len(dates)} archive dates to fetch")

    all_ids = set(wanted_products)
    for ids in set_top5.values():
        all_ids.update(ids)

    for n, d in enumerate(dates, 1):
        ds = d.isoformat()
        url = f"{BASE}/archive/tcgplayer/prices-{ds}.ppmd.7z"
        blob = http_get(url, binary=True, sleep=1.0)
        if blob is None:
            print(f"  {ds}: no archive")
            done.add(ds)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            arc = Path(tmp) / "a.7z"
            arc.write_bytes(blob)
            out = Path(tmp) / "x"
            subprocess.run(["7z", "x", str(arc), f"-o{out}", f"{ds}/{cat}/*", "-y", "-bso0", "-bsp0"], check=False)
            rows_by_pid: dict[int, list] = {}
            for f in (out / ds / str(cat)).glob("*/prices"):
                try:
                    data = json.loads(f.read_text())
                except Exception:
                    continue
                for r in data.get("results") or []:
                    if r.get("productId") in all_ids:
                        rows_by_pid.setdefault(r["productId"], []).append(r)
        day = day_index(d)
        got = 0
        for pid in wanted_products:
            bp = best_price(rows_by_pid.get(pid, []))
            if bp:
                s = history["series"].setdefault(str(pid), [])
                if not any(p[0] == day for p in s):
                    s.append([day, bp["price"]])
                    got += 1
        for gid, ids in set_top5.items():
            vals = [best_price(rows_by_pid.get(i, [])) for i in ids]
            vals = [v["price"] for v in vals if v]
            if len(vals) >= 3:
                s = history["series"].setdefault(f"set:{gid}", [])
                if not any(p[0] == day for p in s):
                    s.append([day, round(sum(vals), 2)])
        done.add(ds)
        print(f"  [{n}/{len(dates)}] {ds}: {got} product prices")
        if n % 10 == 0:  # checkpoint
            history["backfilled"] = sorted(done)
            write_json(HISTORY_PATH, history)

    keep = {str(p["id"]) for p in meta["products"]} | {f"set:{s['id']}" for s in meta["sets"]}
    h = cfg["history"]
    compact_history(history, history.get("lastDay", day_index(end)), h["dailyWindowDays"], h["olderBucketDays"], keep)
    history["backfilled"] = sorted(done)
    write_json(HISTORY_PATH, history)
    print("Backfill complete.")


if __name__ == "__main__":
    main()

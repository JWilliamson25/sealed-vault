#!/usr/bin/env python3
"""Backfill past prices from tcgcsv.com's daily price archives, so trend math works without
waiting weeks for the daily sync to build history.

Run from the "Backfill price history" workflow (Actions tab -> Run workflow).
Needs data/meta.json from a normal sync first, and the `7z` command (p7zip-full).

Order matters: the dates the engine needs most come first.
  1. The last --recent-days, every --recent-step days (90-day lows/averages, 30/90-day trends).
  2. Then older dates back to --since, every --old-step days (6-month and 1-year views).

Being a good neighbour (tcgcsv usage guidelines):
  - Archives never change, so each date is downloaded at most once. Finished dates are
    remembered in history.json -> "backfilled" and skipped forever after.
  - One request at a time with a pause between, and a custom User-Agent.
  - A 403 (refused) is never retried. The script records why and stops, so a server that
    said no is never hammered.

Every run writes data/backfill_report.json (what was fetched, what was refused, the server's
response headers on a refusal) so the outcome can be read without the Actions log.

  python scripts/backfill.py
  python scripts/backfill.py --recent-days 120 --recent-step 3 --old-step 7 --max 150
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BASE, DATA, HISTORY_PATH, META_PATH, USER_AGENT, best_price, compact_history, day_index,
    load_config, load_history, write_json,
)

REPORT_PATH = DATA / "backfill_report.json"
FIRST_ARCHIVE = date(2024, 2, 8)


class Refused(Exception):
    def __init__(self, code: int, headers: dict, body: str):
        super().__init__(f"HTTP {code}")
        self.code, self.headers, self.body = code, headers, body


def download(url: str) -> bytes | None:
    """One GET. Returns None on 404, raises Refused on 401/403/429, retries other errors twice."""
    last = None
    for attempt in range(3):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code in (401, 403, 429):
                try:
                    body = e.read(600).decode("utf-8", "replace")
                except Exception:
                    body = ""
                keep = ("server", "cf-ray", "cf-mitigated", "cf-cache-status", "retry-after", "content-type", "x-cache")
                raise Refused(e.code, {k: v for k, v in e.headers.items() if k.lower() in keep}, body)
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed: {url}: {last}")


def plan_dates(newest: date, since: date, recent_days: int, recent_step: int, old_step: int, done: set[str]) -> list[date]:
    out, seen = [], set()
    d = newest
    while d >= since and (newest - d).days < recent_days:
        out.append(d); seen.add(d); d -= timedelta(days=recent_step)
    d = newest - timedelta(days=recent_days)
    while d >= since:
        if d not in seen:
            out.append(d)
        d -= timedelta(days=old_step)
    return [d for d in out if d.isoformat() not in done]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=FIRST_ARCHIVE.isoformat())
    ap.add_argument("--recent-days", type=int, default=120)
    ap.add_argument("--recent-step", type=int, default=3)
    ap.add_argument("--old-step", type=int, default=7)
    ap.add_argument("--max", type=int, default=150, help="max archives this run")
    ap.add_argument("--pause", type=float, default=2.0, help="seconds between downloads")
    args = ap.parse_args()

    report = {"started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "fetched": [], "missing": [],
              "refused": None, "error": None, "productPricesAdded": 0}

    def finish(history=None, status="ok"):
        report["status"] = status
        report["finished"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if history is not None:
            report["backfilledTotal"] = len(history.get("backfilled", []))
        write_json(REPORT_PATH, report, compact=False)

    if not META_PATH.exists():
        sys.exit("Run scripts/sync.py first (needs data/meta.json).")
    if not shutil.which("7z"):
        sys.exit("The 7z command is required (apt-get install p7zip-full).")

    cfg = load_config()
    cat = cfg["categoryId"]
    meta = json.loads(META_PATH.read_text())
    history = load_history()
    done = set(history.get("backfilled", []))

    wanted_products = {p["id"] for p in meta["products"]}
    set_top5 = {s["id"]: [t["id"] for t in s["topSingles"][:5]] for s in meta["sets"]}
    all_ids = set(wanted_products)
    for ids in set_top5.values():
        all_ids.update(ids)

    newest = date.fromisoformat(meta["priceDate"]) - timedelta(days=1)
    since = max(date.fromisoformat(args.since), FIRST_ARCHIVE)
    dates = plan_dates(newest, since, args.recent_days, args.recent_step, args.old_step, done)[: args.max]
    report["planned"] = len(dates)
    print(f"{len(dates)} archive dates to fetch this run, newest first ({dates[0] if dates else '-'} → {dates[-1] if dates else '-'})")

    def save():
        history["backfilled"] = sorted(done)
        write_json(HISTORY_PATH, history)

    status = "ok"
    for n, d in enumerate(dates, 1):
        ds = d.isoformat()
        url = f"{BASE}/archive/tcgplayer/prices-{ds}.ppmd.7z"
        try:
            blob = download(url)
        except Refused as e:
            report["refused"] = {"date": ds, "url": url, "code": e.code, "headers": e.headers, "body": e.body[:600]}
            print(f"  {ds}: refused (HTTP {e.code}) - stopping without retrying. Headers: {e.headers}")
            status = "refused"
            break
        except RuntimeError as e:
            report["error"] = str(e)
            print(f"  {ds}: {e} - stopping.")
            status = "error"
            break
        if blob is None:
            print(f"  {ds}: no archive for this date")
            report["missing"].append(ds)
            done.add(ds)
            continue
        with tempfile.TemporaryDirectory() as tmp:
            arc = Path(tmp) / "a.7z"
            arc.write_bytes(blob)
            out = Path(tmp) / "x"
            # Extract everything (a few tens of MB) rather than guess 7z's path-filter rules,
            # then read <date>/<categoryId>/<groupId>/prices wherever it landed.
            subprocess.run(["7z", "x", str(arc), f"-o{out}", "-y", "-bso0", "-bsp0"], check=False)
            rows_by_pid: dict[int, list] = {}
            for f in out.rglob("prices"):
                if not (f.is_file() and f.parent.parent.name == str(cat)):
                    continue
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
        if not rows_by_pid:
            # Downloaded but nothing readable inside: don't mark it done, so a later run can retry it.
            print(f"  [{n}/{len(dates)}] {ds}: archive had no Pokémon prices we could read")
            report.setdefault("unreadable", []).append(ds)
        else:
            done.add(ds)
            report["fetched"].append(ds)
            report["productPricesAdded"] += got
            print(f"  [{n}/{len(dates)}] {ds}: {got} product prices ({len(blob) / 1e6:.1f} MB)")
        if n % 10 == 0:
            save()
        time.sleep(args.pause)

    for s in history["series"].values():
        s.sort(key=lambda p: p[0])
    keep = {str(p["id"]) for p in meta["products"]} | {f"set:{s['id']}" for s in meta["sets"]}
    h = cfg["history"]
    compact_history(history, history.get("lastDay", day_index(newest)), h["dailyWindowDays"], h["olderBucketDays"], keep)
    save()
    finish(history, status)
    print(f"Done ({status}): {len(report['fetched'])} archive(s) added, {report['productPricesAdded']} product prices.")
    # A refusal isn't a failure of this script; it's recorded in the report and the data so far is kept.
    sys.exit(1 if status == "error" else 0)


if __name__ == "__main__":
    main()

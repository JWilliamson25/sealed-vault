#!/usr/bin/env python3
"""One-time import of past sealed-product prices from the Scrydex API into data/history.json.

Run it from the "Import price history from Scrydex (one-time)" workflow. The API key and team
ID are read from environment variables, which the workflow fills from encrypted GitHub secrets
(SCRYDEX_API_KEY, SCRYDEX_TEAM_ID). They are never written to disk or printed.

What it does:
  1. Lists Scrydex's English Pokémon sealed products (cheap: ~1 credit per 100 products).
  2. Matches each product this app tracks (TCGplayer ids) to a Scrydex product by set name,
     product type, product name, and current price. Unsure matches are skipped, not guessed.
  3. Checks once that Scrydex has price history for sealed products, and stops early if not.
  4. Downloads each matched product's history from 2024-01-01 up to the first day this app
     already has, and stitches it on (scaled so the line meets today's TCGplayer data cleanly).
     Existing TCGplayer days are never overwritten.
  5. Writes data/scrydex_report.json listing every match and skip, so you can check it.

  python scripts/scrydex_import.py --dry-run     # match only, writes the report, ~30-60 credits
  python scripts/scrydex_import.py               # full import, stops before --max-credits
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    DATA, EPOCH, HISTORY_PATH, META_PATH, classify_sealed, compact_history, day_index,
    load_config, load_history, write_json,
)

BASE = os.environ.get("SCRYDEX_BASE", "https://api.scrydex.com")
REPORT_PATH = DATA / "scrydex_report.json"
HISTORY_COST = 3  # credits per price-history request (per Scrydex docs)


class Budget(Exception):
    pass


class Api:
    def __init__(self, key: str, team: str, max_credits: int):
        self.headers = {"X-Api-Key": key, "X-Team-ID": team, "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (compatible; SealedVault/1.0)"}
        self.max = max_credits
        self.used = 0

    def get(self, path: str, params: dict | None = None, cost: int = 1):
        if self.used + cost > self.max:
            raise Budget()
        url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in range(4):
            req = urllib.request.Request(url, headers=self.headers)
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    self.used += cost
                    time.sleep(0.05)
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    self.used += cost
                    return None
                if e.code in (401, 403):
                    try:
                        detail = e.read().decode("utf-8", "replace")[:400]
                    except Exception:
                        detail = ""
                    for secret in (self.headers["X-Api-Key"], self.headers["X-Team-ID"]):
                        detail = detail.replace(secret, "***")  # never echo credentials
                    server = e.headers.get("Server", "?")
                    sys.exit(f"Scrydex refused the request: HTTP {e.code} on {path}\n"
                             f"  Server header: {server}\n"
                             f"  Scrydex said: {detail or '(empty response)'}\n"
                             f"  Key length {len(self.headers['X-Api-Key'])} chars, team ID length "
                             f"{len(self.headers['X-Team-ID'])} chars (values hidden).")
                if e.code == 429:
                    time.sleep(2 + 2 * attempt)
                    continue
                if 500 <= e.code < 600:
                    time.sleep(3 * (attempt + 1))
                    continue
                raise RuntimeError(f"Scrydex HTTP {e.code} for {path}") from None
            except urllib.error.URLError:
                time.sleep(3 * (attempt + 1))
        raise RuntimeError(f"Scrydex request kept failing: {path}")


def pages(api: Api, path: str, params: dict, cost: int = 1):
    """Yield items across pages, handling both camelCase and snake_case paging keys."""
    page = 1
    seen = 0
    while True:
        resp = api.get(path, {**params, "page": page}, cost=cost)
        if not resp:
            return
        data = resp.get("data") or []
        yield from data
        seen += len(data)
        total = resp.get("totalCount", resp.get("total_count"))
        if not data or (total is not None and seen >= total):
            return
        page += 1


# ------------------------------------------------------------------ matching ---

STOP = {"pokemon", "pokémon", "tcg", "the", "and", "of", "box", "trainer", "elite", "booster",
        "exclusive", "center", "pack", "packs", "bundle", "collection"}


def norm(s: str) -> str:
    s = s.lower().replace("é", "e").replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def set_key(name: str) -> str:
    """'SV08: Surging Sparks' -> 'surging sparks'; 'SV: Scarlet and Violet 151' -> '151'."""
    n = name.split(":", 1)[1] if ":" in name else name
    n = norm(n)
    n = re.sub(r"^(scarlet and violet|sword and shield|sun and moon|mega evolution)\s+(?=\S)", "", n)
    return n


def tokens(s: str) -> set[str]:
    return {t for t in norm(s).split() if t not in STOP}


def sim(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a | b else 1.0


def latest_prices(product: dict):
    """[(variant, condition, market)] from an include=prices product."""
    out = []
    for v in product.get("variants") or []:
        for p in v.get("prices") or []:
            if p.get("type", "raw") == "raw" and p.get("market"):
                out.append((v.get("name"), p.get("condition"), float(p["market"])))
    return out


def match_products(meta: dict, sealed: list[dict]):
    sets_by_id = {s["id"]: s for s in meta["sets"]}
    by_set: dict[str, list] = {}
    for sp in sealed:
        exp = sp.get("expansion") or {}
        by_set.setdefault(set_key(exp.get("name") or ""), []).append(sp)

    matches, skips = [], []
    for p in meta["products"]:
        gname = sets_by_id.get(p["groupId"], {}).get("name", "")
        k = set_key(gname)
        cands = by_set.get(k)
        if not cands:  # looser: best token overlap between set names
            best = max(by_set, key=lambda s: sim(set(k.split()), set(s.split())), default=None)
            if best and sim(set(k.split()), set(best.split())) >= 0.67:
                cands = by_set[best]
        if not cands:
            skips.append({"tcgplayer": p["name"], "set": gname, "why": "set not found on Scrydex"})
            continue
        same_type = [c for c in cands if classify_sealed(c.get("name", "")) == p["type"]]
        if not same_type:
            skips.append({"tcgplayer": p["name"], "set": gname, "why": f"no {p['type']} in that set on Scrydex"})
            continue
        pt = tokens(p["name"]) - tokens(gname)
        scored = []
        for c in same_type:
            ct = tokens(c["name"]) - tokens(c.get("expansion", {}).get("name", ""))
            s_name = sim(pt, ct)
            prices = latest_prices(c)
            best_px = min(prices, key=lambda x: abs(x[2] - p["price"]), default=None)
            ratio = best_px[2] / p["price"] if best_px and p["price"] else None
            s_price = 0 if ratio is None else max(0.0, 1 - abs(1 - ratio))
            scored.append((s_name * 0.6 + s_price * 0.4, s_name, ratio, c, best_px))
        scored.sort(key=lambda x: -x[0])
        score, s_name, ratio, c, best_px = scored[0]
        runner = scored[1][0] if len(scored) > 1 else 0
        why = None
        if ratio is None:
            why = "Scrydex has no current price to confirm the match"
        elif not (0.6 <= ratio <= 1.67):
            why = f"prices disagree (Scrydex {best_px[2]:.2f} vs TCGplayer {p['price']:.2f})"
        elif len(scored) > 1 and score - runner < 0.08 and s_name < 0.99:
            why = f"ambiguous between '{c['name']}' and '{scored[1][3]['name']}'"
        if why:
            skips.append({"tcgplayer": p["name"], "set": gname, "why": why})
            continue
        matches.append({"tcgplayerId": p["id"], "tcgplayer": p["name"], "scrydexId": c["id"],
                        "scrydex": c["name"], "variant": best_px[0], "condition": best_px[1],
                        "priceRatio": round(ratio, 3), "confidence": round(score, 2)})
    return matches, skips


# ------------------------------------------------------------------- history ---

def history_points(api: Api, sid: str, variant, condition, start: date, end: date):
    pts = {}
    params = {"start_date": start.isoformat(), "end_date": end.isoformat(), "page_size": 100}
    for entry in pages(api, f"/pokemon/v1/sealed/{urllib.parse.quote(sid)}/price_history", params, cost=HISTORY_COST):
        try:
            d = date.fromisoformat(entry["date"][:10].replace("/", "-"))
        except (KeyError, ValueError):
            continue
        raw = [x for x in entry.get("prices") or [] if x.get("type", "raw") == "raw" and x.get("market")]
        pick = [x for x in raw if x.get("variant") == variant and x.get("condition") == condition] or \
               [x for x in raw if x.get("variant") == variant] or raw
        if pick:
            pts[day_index(d)] = float(pick[0]["market"])
    return pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="match and report only")
    ap.add_argument("--max-credits", type=int, default=40000)
    args = ap.parse_args()

    key, team = os.environ.get("SCRYDEX_API_KEY", "").strip(), os.environ.get("SCRYDEX_TEAM_ID", "").strip()
    if not key or not team:
        sys.exit("Missing SCRYDEX_API_KEY or SCRYDEX_TEAM_ID. Add both under Settings -> Secrets and "
                 "variables -> Actions in your GitHub repo.")
    if not META_PATH.exists():
        sys.exit("Run the daily price sync first (needs data/meta.json).")
    meta = json.loads(META_PATH.read_text())
    if meta.get("demo"):
        sys.exit("data/meta.json is still demo data. Run the daily price sync first.")

    api = Api(key, team, args.max_credits)

    print("Checking the key with Scrydex…")
    usage = api.get("/account/v1/usage")
    if usage is not None:
        u = usage.get("data", usage)
        print(f"  Key works. Credits remaining: {u.get('remaining_credits', u.get('credits_remaining', '?'))}")
    print("Listing Scrydex sealed products…")
    sealed = [s for s in pages(api, "/pokemon/v1/sealed", {"include": "prices", "page_size": 100})
              if (s.get("language_code") or s.get("expansion", {}).get("language_code") or "EN").upper() == "EN"]
    print(f"  {len(sealed)} English sealed products ({api.used} credits)")

    matches, skips = match_products(meta, sealed)
    print(f"Matched {len(matches)} of {len(meta['products'])} tracked products; {len(skips)} skipped.")
    report = {"priceDate": meta["priceDate"], "matched": matches, "skipped": skips, "imported": {}}

    if args.dry_run or not matches:
        report["creditsUsed"] = api.used
        write_json(REPORT_PATH, report, compact=False)
        print(f"Dry run done. See data/scrydex_report.json. Credits used: {api.used}")
        return

    # Order by set strength so a budget stop still covers the products that matter most.
    set_score = {s["id"]: s.get("chaseScore", 0) for s in meta["sets"]}
    gid_of = {p["id"]: p["groupId"] for p in meta["products"]}
    sets_by_id = {s["id"]: s for s in meta["sets"]}
    matches.sort(key=lambda m: -set_score.get(gid_of[m["tcgplayerId"]], 0))

    history = load_history()
    cfg = load_config()
    today = history.get("lastDay", day_index(date.fromisoformat(meta["priceDate"])))
    probed = False
    imported = 0
    try:
        for m in matches:
            key_ = str(m["tcgplayerId"])
            existing = history["series"].get(key_, [])
            first_day = min((p[0] for p in existing), default=today)
            rel = sets_by_id.get(gid_of[m["tcgplayerId"]], {}).get("release")
            start = max(EPOCH, date.fromisoformat(rel) - timedelta(days=14)) if rel else EPOCH
            if first_day <= day_index(start) + 14:  # already covered (e.g. a re-run)
                continue
            end = EPOCH + timedelta(days=first_day + 7)  # small overlap to line the sources up
            pts = history_points(api, m["scrydexId"], m["variant"], m["condition"], start, end)
            if not probed:
                probed = True
                if not pts:
                    report["creditsUsed"] = api.used
                    write_json(REPORT_PATH, report, compact=False)
                    sys.exit("Scrydex returned no price history for the first sealed product, so it "
                             "likely doesn't offer history for sealed items. Stopped early to save "
                             f"credits ({api.used} used). Nothing was changed.")
            if not pts:
                report["imported"][key_] = "no history returned"
                continue
            # Scale to meet TCGplayer at the seam so charts don't jump between sources.
            anchor = next((v for d, v in sorted(existing) if d >= first_day), None)
            near = [v for d, v in pts.items() if abs(d - first_day) <= 7]
            ratio = (anchor / (sum(near) / len(near))) if anchor and near else 1 / m["priceRatio"]
            if not (0.75 <= ratio <= 1.33):
                report["imported"][key_] = f"skipped: sources {ratio:.2f}x apart at the seam"
                continue
            have = {p[0] for p in existing}
            new = [[d, round(v * ratio, 2)] for d, v in pts.items() if d < first_day and d not in have]
            history["series"][key_] = sorted(existing + new, key=lambda p: p[0])
            report["imported"][key_] = f"{len(new)} days added (scaled {ratio:.3f})"
            imported += 1
            print(f"  {m['tcgplayer']}: +{len(new)} days  ({api.used} credits)")
            if imported % 20 == 0:
                write_json(HISTORY_PATH, history)
    except Budget:
        print(f"Stopped at the --max-credits limit ({args.max_credits}). Re-run to continue; "
              "finished products are skipped.")

    keep = {str(p["id"]) for p in meta["products"]} | {f"set:{s['id']}" for s in meta["sets"]}
    h = cfg["history"]
    compact_history(history, today, h["dailyWindowDays"], h["olderBucketDays"], keep)
    history.setdefault("sources", {})["scrydex"] = f"older history for {imported} products imported {meta['priceDate']}"
    write_json(HISTORY_PATH, history)
    report["creditsUsed"] = api.used
    write_json(REPORT_PATH, report, compact=False)
    print(f"Done: history added for {imported} products. Credits used: {api.used}.")


if __name__ == "__main__":
    main()

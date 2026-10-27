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
HISTORY_PATH_TMPL = os.environ.get("SCRYDEX_HISTORY_PATH", "/pokemon/v1/sealed/{id}/price_history")


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


SERIES = r"(scarlet and violet|sword and shield|sun and moon|mega evolution|black and white|diamond and pearl|heartgold soulsilver)"
SET_ALIASES = {
    "sm base set": "sun and moon", "sm base": "sun and moon", "xy base set": "xy", "xy base": "xy",
    "base set": "base", "base set shadowless": "base", "base set 1st edition": "base",
    "black and white": "black and white", "diamond and pearl": "diamond and pearl",
    "heartgold soulsilver": "heartgold and soulsilver", "hgss": "heartgold and soulsilver",
}


def set_keys(name: str) -> list[str]:
    """All the spellings a set might go by:
    'SV08: Surging Sparks' / 'SM - Guardians Rising' / 'EX Power Keepers' / 'SV: Scarlet & Violet 151'."""
    raw = norm(name)
    n = name
    m = re.match(r"^\s*[A-Za-z]{1,5}\d{0,3}[a-z]?\s*(?::|\s-\s)\s*(.+)$", n)  # 'SV08: x', 'SM - x'
    if m:
        n = m.group(1)
    n = norm(n)
    out: list[str] = []

    def add(k):
        if k and k not in out:
            out.append(k)
        if k in SET_ALIASES and SET_ALIASES[k] not in out:
            out.append(SET_ALIASES[k])
    add(n)                                                    # most specific first
    add(re.sub(rf"^{SERIES}\s+(?=\S)", "", n))               # 'scarlet and violet 151' -> '151'
    add(re.sub(r"^(ex|sm|xy|swsh|sv|me|bw|dp)\s+", "", n))    # 'ex power keepers' -> 'power keepers'
    add(re.sub(r"\s+(set|expansion)$", "", n))
    add(raw)
    return out


def clean_name(name: str) -> str:
    n = re.sub(r"[\[(][^\])]*(exclusive|sam'?s club|costco|walmart|target|dollar general|3-tab|international|retail|best buy|gamestop)[^\])]*[\])]",
               " ", name, flags=re.I)                    # retailer notes; keep '(Toxtricity V)', '[Set of 3]'
    n = n.replace("[", " ").replace("]", " ").replace("(", " ").replace(")", " ")
    n = norm(n)
    return re.sub(rf"^{SERIES}\s+", "", n)


EDITION = {"1st", "first", "edition", "unlimited", "revised", "shadowless"}  # told apart by price variant


def stem(t: str) -> str:
    return t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith("ss") else t


def tokens(s: str) -> set[str]:
    return {stem(t) for t in clean_name(s).split() if t not in STOP and t not in EDITION}


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


def is_pc_variant(v) -> bool:
    return bool(v) and bool(re.search(r"center|pokemoncenter|\bpc\b|exclusive", str(v), re.I))


def pick(p: dict, cands: list[dict], strip_set: str | None, need_pc_variant: bool = False):
    """Best candidate by name + price. Returns (match_dict, None) or (None, reason)."""
    pt = tokens(p["name"]) - (tokens(strip_set) if strip_set else set())
    scored = []
    for c in cands:
        ct = tokens(c["name"]) - (tokens(c.get("expansion", {}).get("name", "")) if strip_set else set())
        s_name = sim(pt, ct)
        prices = latest_prices(c)
        if need_pc_variant:
            prices = [x for x in prices if is_pc_variant(x[0])]
        best_px = min(prices, key=lambda x: abs(x[2] - p["price"]), default=None)
        ratio = best_px[2] / p["price"] if best_px and p["price"] else None
        s_price = 0 if ratio is None else max(0.0, 1 - abs(1 - ratio))
        scored.append((s_name * 0.6 + s_price * 0.4, s_name, ratio, c, best_px))
    if not scored:
        return None, "no candidates"
    scored.sort(key=lambda x: -x[0])
    score, s_name, ratio, c, best_px = scored[0]
    runner = scored[1] if len(scored) > 1 else None
    if ratio is None:
        return None, "Scrydex has no current price to confirm the match"
    pc = lambda n: bool(re.search(r"pok[eé]mon center", n, re.I))
    if pc(p["name"]) != (pc(c["name"]) or is_pc_variant(best_px[0])):
        return None, f"Pokémon Center vs regular mismatch ('{c['name']}')"
    if not (0.6 <= ratio <= 1.67):
        return None, f"prices disagree (Scrydex '{c['name']}' {best_px[2]:.2f} vs TCGplayer {p['price']:.2f})"
    if strip_set is None and s_name < 0.75:
        return None, f"no close name match (best: '{c['name']}')"
    if strip_set is not None and s_name < 0.5:
        return None, f"no close name match in set (best: '{c['name']}')"
    if runner and score - runner[0] < 0.08 and not (s_name >= 0.99 and runner[1] < 0.99):
        return None, f"ambiguous between '{c['name']}' and '{runner[3]['name']}'"
    return {"tcgplayerId": p["id"], "tcgplayer": p["name"], "scrydexId": c["id"], "scrydex": c["name"],
            "scrydexSet": c.get("expansion", {}).get("name"), "variant": best_px[0], "condition": best_px[1],
            "priceRatio": round(ratio, 3), "confidence": round(score, 2)}, None


def match_products(meta: dict, sealed: list[dict]):
    sets_by_id = {s["id"]: s for s in meta["sets"]}
    by_key: dict[str, list] = {}
    for sp in sealed:
        for k in set_keys((sp.get("expansion") or {}).get("name") or ""):
            by_key.setdefault(k, []).append(sp)
    by_type: dict[str, list] = {}
    for sp in sealed:
        by_type.setdefault(classify_sealed(sp.get("name", "")), []).append(sp)

    matches, skips = [], []
    for p in meta["products"]:
        gname = sets_by_id.get(p["groupId"], {}).get("name", "")
        cands = []
        for k in set_keys(gname):
            cands = by_key.get(k) or cands
            if cands:
                break
        cands = list({c["id"]: c for c in cands}.values())

        if cands:
            same = [c for c in cands if classify_sealed(c.get("name", "")) == p["type"]]
            m, why = (pick(p, same, gname) if same else (None, None))
            if not same and p["type"] == "pc_etb":
                # Scrydex may list the Pokémon Center ETB as a variant of the regular ETB.
                etbs = [c for c in cands if classify_sealed(c.get("name", "")) == "etb"
                        and any(is_pc_variant(v.get("name")) for v in c.get("variants") or [])]
                m, why = pick(p, etbs, gname, need_pc_variant=True) if etbs else (None, None)
            if m:
                matches.append(m)
                continue
            if why is None:
                names = sorted({c["name"] for c in cands})[:12]
                skips.append({"tcgplayer": p["name"], "set": gname, "why": f"no {p['type']} in that set on Scrydex",
                              "scrydexHas": names})
            else:
                skips.append({"tcgplayer": p["name"], "set": gname, "why": why})
            continue

        # Set not found (e.g. TCGplayer's 'Miscellaneous Cards & Products'): match on the
        # full product name across every Scrydex product of the same type, strictly.
        m, why = pick(p, by_type.get(p["type"], []), None)
        if m:
            m["via"] = "name-only"
            matches.append(m)
        else:
            skips.append({"tcgplayer": p["name"], "set": gname, "why": f"set not found on Scrydex; {why}"})
    best: dict[tuple, dict] = {}
    for m in matches:
        k = (m["scrydexId"], m["variant"])
        if k not in best or m["confidence"] > best[k]["confidence"]:
            best[k] = m
    kept = []
    for m in matches:
        w = best[(m["scrydexId"], m["variant"])]
        if w is m:
            kept.append(m)
        else:
            skips.append({"tcgplayer": m["tcgplayer"], "set": "", "why": f"duplicate: '{m['scrydex']}' already "
                          f"matched to '{w['tcgplayer']}'"})
    return kept, skips


# ------------------------------------------------------------------- history ---

def history_points(api: Api, sid: str, variant, condition, start: date, end: date):
    pts = {}
    params = {"start_date": start.isoformat(), "end_date": end.isoformat(), "page_size": 100}
    path = HISTORY_PATH_TMPL.format(id=urllib.parse.quote(sid))
    for entry in pages(api, path, params, cost=HISTORY_COST):
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


def raw_get(api: Api, path: str, params: dict):
    """One request, returning (status, parsed-or-text) without exiting on errors. Never prints headers."""
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers=api.headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # connection dropped, timeout…
        return "no response", type(e).__name__
    api.used += HISTORY_COST
    try:
        return status, json.loads(body)
    except ValueError:
        return status, body[:300]


def describe(obj) -> str:
    if not isinstance(obj, dict):
        return repr(obj)[:300]
    data = obj.get("data")
    keys = sorted(obj.keys())
    if isinstance(data, list):
        first = json.dumps(data[0])[:400] if data else "(empty list)"
        total = obj.get("total_count", obj.get("totalCount"))
        return f"keys={keys} entries={len(data)} total={total}\n        first entry: {first}"
    return f"keys={keys} body: {json.dumps(obj)[:400]}"


def probe(api: Api, matches: list, meta: dict):
    """Ask Scrydex for history several ways on a few long-established products, plus a card as a control."""
    wanted = ["Evolving Skies Booster Box", "151 Elite Trainer Box", "Brilliant Stars Booster Box",
              "Crown Zenith Elite Trainer Box", "Lost Origin Booster Box"]
    picks = []
    for w in wanted:
        m = next((m for m in matches if w.lower() in m["scrydex"].lower()), None)
        if m and m not in picks:
            picks.append(m)
    picks = (picks or matches)[:3]
    yday = date.fromisoformat(meta["priceDate"]) - timedelta(days=1)
    rng = {"start_date": (yday - timedelta(days=60)).isoformat(), "end_date": yday.isoformat()}
    shapes = [
        ("sealed price_history, days", "/pokemon/v1/sealed/{id}/price_history", {"days": 60}),
        ("sealed price_history, dates", "/pokemon/v1/sealed/{id}/price_history", rng),
        ("sealed price-history (dash)", "/pokemon/v1/sealed/{id}/price-history", {"days": 60}),
        ("cards price_history w/ sealed id", "/pokemon/v1/cards/{id}/price_history", {"days": 60}),
    ]
    print("\nPROBE: how does Scrydex serve sealed price history?")
    status, obj = raw_get(api, "/pokemon/v1/cards/swsh7-215/price_history", {"days": 30})
    print(f"  control (a card): HTTP {status}  {describe(obj)}")
    for m in picks:
        print(f"\n  {m['scrydex']}  (id {m['scrydexId']})")
        for label, tmpl, params in shapes:
            status, obj = raw_get(api, tmpl.format(id=urllib.parse.quote(m["scrydexId"])), params)
            print(f"    {label}: HTTP {status}  {describe(obj)}")
    print(f"\nProbe done. Credits used: about {api.used}. Nothing was changed.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="match and report only")
    ap.add_argument("--probe", action="store_true", help="test how Scrydex serves sealed price history (~40 credits)")
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
    report = {"priceDate": meta["priceDate"], "matched": matches, "skipped": skips, "imported": {},
              "scrydexSets": sorted({(x.get("expansion") or {}).get("name") or "" for x in sealed})}

    if args.probe:
        probe(api, matches, meta)
        return

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
            end = min(EPOCH + timedelta(days=first_day + 7),  # small overlap to line the sources up
                      date.fromisoformat(meta["priceDate"]) - timedelta(days=1))
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

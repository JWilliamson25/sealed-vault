#!/usr/bin/env python3
"""Researched facts about singles that the price feed can't see, kept in data/card_facts.json.

TCGplayer's feed only shows today's market price, and the Scrydex import only reaches back about six
months. A veteran buyer also looks at where a card traded over the last couple of years, what copies
actually sell for, PSA 9 and PSA 10 sales, the PSA population and whether the art has been reprinted.
Those facts are looked up (by hand or by a scheduled Claude task) and recorded here. The app uses
them in place of guesses, and won't call a card with a short price history a Buy until they exist.

  python scripts/card_facts.py todo [--limit 15]     # cards most worth researching next
  python scripts/card_facts.py show 284266
  python scripts/card_facts.py set 284266 low=28.48@2025-12-26 high=65.93@2026-06-20 \\
      sold=38-55.25 psa10=400-676 psa9=75 reprint=none note="..." source=https://...
  python scripts/card_facts.py touch 284266           # re-checked, nothing changed

Fields (all optional; prices are raw near-mint in USD unless named):
  low=PRICE@DATE     lowest raw price in the last 24 months (skip the first weeks after release)
  high=PRICE@DATE    highest raw price in the last 24 months
  sold=LO-HI[~MED]   recent sold range for raw near-mint (eBay/TCGplayer solds, last ~30 days)
  psa10=LO-HI        recent PSA 10 sold range       psa9=PRICE   recent PSA 9 sold price
  pop10=N poptotal=N popdate=DATE   PSA population (gem rate = pop10 / poptotal)
  reprint=none|same_art|announced|risk   same_art: this artwork was reprinted elsewhere (e.g. Classic
                     Collection); announced: a reprint is announced; risk: credible rumours
  hype=TEXT          what's driving attention on the Pokemon right now (new chase cards, anime, game)
  note=TEXT  source=URL (repeatable; appended)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FACTS = ROOT / "data" / "card_facts.json"
SINGLES = ROOT / "data" / "singles.json"
SHIST = ROOT / "data" / "singles_history.json"
CONFIG = ROOT / "config.json"
FRESH_DAYS = 120  # long-run range, pop, reprint status
SOLD_FRESH_DAYS = 45  # recent sold prices


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(facts):
    FACTS.write_text(json.dumps(facts, indent=1, ensure_ascii=False) + "\n")


def today() -> str:
    s = load(SINGLES, {})
    return s.get("priceDate") or datetime.now(timezone.utc).date().isoformat()


def age(d: str | None, ref: str) -> int | None:
    if not d:
        return None
    return (date.fromisoformat(ref) - date.fromisoformat(d)).days


def money(v: str) -> float:
    return round(float(v.replace("$", "").replace(",", "")), 2)


def parse_range(v: str) -> dict:
    """'38-55.25' or '38-55.25~46' -> {low, high, median?}"""
    m = re.fullmatch(r"\$?([\d.,]+)\s*-\s*\$?([\d.,]+)(?:\s*~\s*\$?([\d.,]+))?", v.strip())
    if not m:
        sys.exit(f"Can't read range '{v}'. Use LO-HI or LO-HI~MEDIAN, e.g. 38-55.25~46")
    out = {"low": money(m.group(1)), "high": money(m.group(2))}
    if m.group(3):
        out["median"] = money(m.group(3))
    return out


def parse_at(v: str) -> dict:
    m = re.fullmatch(r"\$?([\d.,]+)@(\d{4}-\d{2}-\d{2})", v.strip())
    if not m:
        sys.exit(f"Can't read '{v}'. Use PRICE@YYYY-MM-DD, e.g. 28.48@2025-12-26")
    return {"price": money(m.group(1)), "date": m.group(2)}


def card_name(cid: str) -> str:
    for c in load(SINGLES, {}).get("cards", []):
        if str(c["id"]) == cid:
            return f"{c['name']} — {c.get('group') or c.get('setName')} {c.get('number') or ''}".strip()
    return ""


def cmd_set(cid: str, pairs: list[str], touch_only=False):
    facts = load(FACTS, {"cards": {}})
    rec = facts["cards"].setdefault(cid, {})
    rec.setdefault("name", card_name(cid))
    ref = today()
    for p in pairs:
        if "=" not in p:
            sys.exit(f"Expected key=value, got '{p}'")
        k, v = p.split("=", 1)
        k = k.strip().lower()
        if k in ("low", "high"):
            rec["longLow" if k == "low" else "longHigh"] = parse_at(v)
        elif k == "sold":
            rec["sold"] = {**parse_range(v), "date": ref}
        elif k == "psa10":
            rec["psa10Sold"] = {**parse_range(v), "date": ref}
        elif k == "psa9":
            rec["psa9Sold"] = {"price": money(v), "date": ref}
        elif k in ("pop10", "poptotal", "popdate"):
            pop = rec.setdefault("pop", {})
            pop[{"pop10": "psa10", "poptotal": "total", "popdate": "date"}[k]] = v if k == "popdate" else int(v.replace(",", ""))
            pop.setdefault("date", ref)
        elif k == "reprint":
            if v not in ("none", "same_art", "announced", "risk"):
                sys.exit("reprint must be none, same_art, announced or risk")
            rec["reprint"] = v
        elif k in ("hype", "note"):
            rec[k] = v
        elif k == "source":
            rec.setdefault("sources", [])
            if v not in rec["sources"]:
                rec["sources"].append(v)
        else:
            sys.exit(f"Unknown field '{k}'. See the top of this file.")
    rec["verified"] = ref
    facts["cards"] = dict(sorted(facts["cards"].items(), key=lambda kv: kv[0]))
    save(facts)
    print(("Touched " if touch_only else "Saved ") + f"{cid} {rec.get('name', '')}")


def cmd_show(cid: str):
    rec = load(FACTS, {"cards": {}})["cards"].get(cid)
    print(json.dumps(rec, indent=1) if rec else f"No facts for {cid} {card_name(cid)}")


RANK = {"verify": 0, "strong_buy": 1, "buy": 1, "accumulate": 2, "wait": 3}


def engine_calls():
    """The app's own calls (scripts/singles_calls.js), or None if Node isn't installed."""
    import shutil
    import subprocess
    if not shutil.which("node"):
        return None
    r = subprocess.run(["node", str(ROOT / "scripts" / "singles_calls.js")], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def cmd_todo(limit: int):
    """Cards in your budget worth researching next: first the ones the app calls "Check first" (they
    look like buys but their long-run price isn't known), then buys and cards within 10% of their
    buy-under price. Cards with fresh facts are skipped."""
    cfg = load(CONFIG, {})
    b = cfg.get("singles") or {}
    lo, hi = b.get("budgetMin", 30), b.get("budgetMax", 300)
    calls = engine_calls()
    if calls is not None:
        ref = today()
        facts = load(FACTS, {"cards": {}})["cards"]
        rows = []
        for c in calls:
            if not (lo <= c["price"] <= hi) or c["signal"] not in RANK:
                continue
            f = facts.get(str(c["id"]), {})
            a = age(f.get("verified"), ref)
            if a is not None and a <= FRESH_DAYS:
                continue
            gap = c["price"] / c["target"] - 1 if c.get("target") else 9
            if c["signal"] == "wait" and gap > 0.10:
                continue
            rows.append((RANK[c["signal"]], gap, -c["score"], c))
        rows.sort(key=lambda r: r[:3])
        print(f"Cards to research ({len(rows)} in your ${lo}-${hi} budget; Check first, then buys, then near target):")
        for *_k, c in rows[:limit]:
            print(f"  {c['id']:>7}  ${c['price']:>7.2f}  {c['signal']:<10} buy<{('$%.2f' % c['target']) if c.get('target') else '—':>8}  "
                  f"{c['name']} — {c['group']} {c.get('number') or ''}")
        if not rows:
            print("  none")
        return
    print("(Node not found: falling back to a price-only shortlist.)")
    s, h = load(SINGLES, {}), load(SHIST, {"series": {}})
    facts = load(FACTS, {"cards": {}})["cards"]
    ref = today()
    rows = []
    for c in s.get("cards", []):
        if not (lo <= c["price"] <= hi):
            continue
        f = facts.get(str(c["id"]), {})
        a = age(f.get("verified"), ref)
        if a is not None and a <= FRESH_DAYS and f.get("longLow"):
            continue
        ser = h["series"].get(str(c["id"])) or []
        vals = [v for _d, v in ser[-180:]]
        if len(vals) < 5:
            continue
        low, high = min(vals), max(vals)
        near_low = c["price"] / low - 1  # 0 = at its low
        drop = 1 - c["price"] / high
        rows.append((near_low - drop * 0.5, c, low, high, a))
    rows.sort(key=lambda r: r[0])
    print(f"Cards to research (in your ${lo}-${hi} budget, near their lows, facts missing or older than {FRESH_DAYS} days):")
    for _k, c, low, high, a in rows[:limit]:
        print(f"  {c['id']:>7}  ${c['price']:>7.2f}  (6-mo low ${low:.2f}, high ${high:.2f})  {c['name']} — "
              f"{c.get('group') or c.get('setName')} {c.get('number') or ''}"
              f"{'' if a is None else f'  [facts {a} days old]'}")
    if not rows:
        print("  none")


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return
    if a[0] == "todo":
        limit = int(a[a.index("--limit") + 1]) if "--limit" in a else 15
        cmd_todo(limit)
    elif a[0] == "show" and len(a) == 2:
        cmd_show(a[1])
    elif a[0] == "set" and len(a) >= 3:
        cmd_set(a[1], a[2:])
    elif a[0] == "touch" and len(a) == 2:
        cmd_set(a[1], [], touch_only=True)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()

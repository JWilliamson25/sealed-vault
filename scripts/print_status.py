#!/usr/bin/env python3
"""Print-status bookkeeping for the weekly reprint check.

The engine (assets/engine.js) reads config.json -> setOverrides to decide whether a set is
still being printed. Nothing in the price data can tell that, so a scheduled Claude task
searches reprint and restock news each week and records the result with this script.

  python scripts/print_status.py todo
      Every tracked set old enough for print status to matter (9 months to 5 years),
      with its current status, when it was last checked, and whether it's stale.

  python scripts/print_status.py set "SV10: Destined Rivals" in_print "ETB reprint on shelves; ..."
      Record a status (in_print | likely_out_of_print | out_of_print) with the evidence,
      stamped with today's date. Use the exact set name printed by `todo`.

  python scripts/print_status.py touch "SWSH: Crown Zenith"
      Nothing changed: keep the status and note, refresh the check date.
"""
import datetime
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"
META = ROOT / "data" / "meta.json"
STATUSES = ("in_print", "likely_out_of_print", "out_of_print")
STALE_DAYS = 30  # keep in step with PRINT_STALE_DAYS in assets/engine.js
# Same grab-bag groups the engine ignores (CATCHALL_RE in assets/engine.js).
CATCHALL = re.compile(r"miscellaneous|promo|pop series|mcdonald|burger king|prize pack|exclusives|jumbo|league|"
                      r"championship|trainer kit|my first battle|trading card game classic|calendar|best of|"
                      r"world collection|alternate art", re.I)


def load_config():
    return json.loads(CONFIG.read_text())


def save_config(c):
    CONFIG.write_text(json.dumps(c, indent=2, ensure_ascii=False) + "\n")


def today():
    return datetime.date.today()


def tracked_sets():
    meta = json.loads(META.read_text())
    counts = {}
    for p in meta["products"]:
        counts[p["groupId"]] = counts.get(p["groupId"], 0) + 1
    out = []
    for s in meta["sets"]:
        rel = s.get("release")
        if not rel or not counts.get(s["id"]) or CATCHALL.search(s["name"]):
            continue
        age = (today() - datetime.date.fromisoformat(rel)).days / 30.44
        if 9 <= age < 60:
            out.append({"name": s["name"], "id": s["id"], "release": rel, "ageMonths": round(age, 1), "products": counts[s["id"]]})
    return sorted(out, key=lambda x: x["release"], reverse=True)


def cmd_todo():
    so = load_config().get("setOverrides", {})
    rows = []
    for s in tracked_sets():
        cur = so.get(s["name"]) or so.get(str(s["id"])) or {}
        checked = cur.get("verified")
        age = (today() - datetime.date.fromisoformat(checked)).days if checked else None
        rows.append({**s, "printStatus": cur.get("printStatus"), "verified": checked, "daysSinceCheck": age,
                     "stale": cur.get("printStatus") is None or age is None or age > STALE_DAYS, "note": cur.get("note")})
    print(json.dumps(rows, indent=2, ensure_ascii=False))


def entry_for(c, name):
    names = {s["name"] for s in tracked_sets()}
    if name not in names and name not in c.get("setOverrides", {}):
        sys.exit(f"Unknown set {name!r}. Use a name exactly as `todo` prints it.")
    return c.setdefault("setOverrides", {}).setdefault(name, {})


def cmd_set(name, status, note):
    if status not in STATUSES:
        sys.exit(f"status must be one of {', '.join(STATUSES)}")
    if not note.strip():
        sys.exit("give the evidence as a note (what was found, with months)")
    c = load_config()
    e = entry_for(c, name)
    e.update({"printStatus": status, "verified": today().isoformat(), "note": note.strip()})
    save_config(c)
    print(f"{name}: {status} ({e['verified']})")


def cmd_touch(name):
    c = load_config()
    e = entry_for(c, name)
    if not e.get("printStatus"):
        sys.exit(f"{name} has no status yet; use `set`.")
    e["verified"] = today().isoformat()
    save_config(c)
    print(f"{name}: still {e['printStatus']} ({e['verified']})")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["todo"]:
        cmd_todo()
    elif a[:1] == ["set"] and len(a) == 4:
        cmd_set(a[1], a[2], a[3])
    elif a[:1] == ["touch"] and len(a) == 2:
        cmd_touch(a[1])
    else:
        sys.exit(__doc__)

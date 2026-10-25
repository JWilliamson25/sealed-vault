#!/usr/bin/env python3
"""Build DEMO data (fictional sets, simulated prices) by running the real sync.py against a
fake tcgcsv mirror over ~2.5 simulated years. Lets you preview the site before the first real
sync. The app shows a 'Demo data' banner; the first real sync replaces it.

  python scripts/make_demo.py
"""
from __future__ import annotations

import json
import math
import random
import shutil
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
random.seed(7)

TODAY = date(2026, 10, 24)

# name, release, chase strength 0-1, chase cards (name, base price), sealed types
SETS = [
    ("DEMO1: Ember Crown", date(2021, 8, 27), 0.95, [("Umbreon VMAX (Alternate Art)", 1100), ("Rayquaza VMAX (Alternate Art)", 520), ("Sylveon VMAX (Alternate Art)", 260)]),
    ("DEMO2: Tidal Legends", date(2022, 11, 11), 0.8, [("Lugia V (Alternate Art)", 310), ("Pikachu VMAX", 70)]),
    ("DEMO3: Starlight 151", date(2023, 9, 22), 0.9, [("Charizard ex (Special Illustration Rare)", 260), ("Mew ex", 75), ("Pikachu (Illustration Rare)", 60)]),
    ("DEMO4: Shadow Waltz", date(2024, 11, 8), 0.7, [("Pikachu ex (Special Illustration Rare)", 330), ("Gengar ex", 45)]),
    ("DEMO5: Prism Bloom", date(2025, 1, 17), 0.85, [("Umbreon ex (Special Illustration Rare)", 1050), ("Sylveon ex (Special Illustration Rare)", 140), ("Eevee (Illustration Rare)", 55)]),
    ("DEMO6: Iron Meadow", date(2025, 7, 18), 0.4, [("Mewtwo ex (Special Illustration Rare)", 48)]),
    ("DEMO7: Mega Dawn", date(2026, 3, 27), 0.6, [("Mega Charizard X ex (Special Illustration Rare)", 290)]),
    ("DEMO8: Storm Spire", date(2026, 9, 16), 0.75, [("Mega Rayquaza ex (Special Illustration Rare)", 420), ("Pikachu (Illustration Rare)", 70)]),
    ("DEMO9: Quiet Grove", date(2023, 3, 31), 0.1, [("Bulbasaur (Illustration Rare)", 22)]),
]
SEALED = [
    ("Booster Box", 161.64), ("Elite Trainer Box", 49.99), ("Elite Trainer Box [Pokemon Center Exclusive]", 59.99),
    ("Booster Bundle", 26.94), ("3 Pack Blister", 14.99), ("Booster Pack", 4.49),
]


def multiple_at(age_days: float, strength: float, pid: int) -> float:
    """Simulated price / retail multiple through a modern set's life cycle."""
    m = age_days / 30.4
    if m < 0:
        return None
    if m < 2:
        base = 1.35 - 0.15 * m
    elif m < 9:
        base = 1.05 - 0.12 * (m - 2) / 7
    elif m < 14:
        base = 0.93 + (m - 9) * 0.03
    else:
        growth = 0.012 + 0.035 * strength  # monthly
        base = 1.08 * math.exp(growth * (m - 14))
    base *= 0.7 + 0.6 * strength if m > 14 else 1
    wobble = 1 + 0.04 * math.sin(m * 1.7 + pid) + random.uniform(-0.015, 0.015)
    return max(0.6, base * wobble)


def build_fixture(root: Path, day: date):
    cat = root / "tcgplayer" / "3"
    cat.mkdir(parents=True, exist_ok=True)
    groups = []
    gid = 9000
    pid = 900000
    for name, rel, strength, chase in SETS:
        if rel > day + timedelta(days=21):
            continue
        gid += 1
        groups.append({"groupId": gid, "name": name, "abbreviation": name.split(":")[0], "publishedOn": rel.isoformat() + "T00:00:00", "categoryId": 3})
        products, prices = [], []
        age = (day - rel).days
        for i, (cname, cprice) in enumerate(chase):
            pid += 1
            products.append({"productId": pid, "name": cname, "imageUrl": "", "url": f"https://www.tcgplayer.com/product/{pid}",
                             "extendedData": [{"name": "Number", "value": f"{200 + i}/190"}, {"name": "Rarity", "value": "Special Illustration Rare"}]})
            drift = 0.75 + 0.5 * min(1, max(0, age) / 900) + 0.05 * math.sin(age / 40 + i)
            prices.append({"productId": pid, "marketPrice": round(cprice * drift, 2), "midPrice": cprice, "subTypeName": "Holofoil"})
        for j in range(8):  # filler singles
            pid += 1
            products.append({"productId": pid, "name": f"Filler Card {j}", "imageUrl": "", "url": "",
                             "extendedData": [{"name": "Number", "value": f"{j}/190"}, {"name": "Rarity", "value": "Rare"}]})
            prices.append({"productId": pid, "marketPrice": round(3 + j * 1.5, 2), "subTypeName": "Normal"})
        for k, (sname, retail) in enumerate(SEALED):
            pid += 1
            products.append({"productId": pid, "name": f"{name.split(': ')[1]} {sname}", "imageUrl": "", "url": f"https://www.tcgplayer.com/product/{pid}", "extendedData": []})
            mult = multiple_at(age, strength * (1.1 if k in (0, 2) else 1.0), pid)
            if mult:
                spike = 1.3 if (name.startswith("DEMO4") and k == 1 and (TODAY - day).days < 20) else 1
                prices.append({"productId": pid, "marketPrice": round(retail * mult * spike, 2), "lowPrice": round(retail * mult * 0.95, 2), "midPrice": round(retail * mult * 1.05, 2), "subTypeName": "Normal"})
        g = cat / str(gid)
        g.mkdir(exist_ok=True)
        (g / "products").write_text(json.dumps({"success": True, "results": products}))
        (g / "prices").write_text(json.dumps({"success": True, "results": prices}))
    (cat / "groups").write_text(json.dumps({"success": True, "results": groups}))
    (root / "last-updated.txt").write_text(day.isoformat() + "T20:00:00")


def main():
    for f in ("meta.json", "history.json"):
        (DATA / f).unlink(missing_ok=True)
    days = []
    d = date(2024, 2, 8)
    while d < TODAY - timedelta(days=120):
        days.append(d)
        d += timedelta(days=7)
    d = TODAY - timedelta(days=120)
    while d <= TODAY:
        days.append(d)
        d += timedelta(days=1)
    with tempfile.TemporaryDirectory() as tmp:
        for n, day in enumerate(days):
            fx = Path(tmp) / "fx"
            shutil.rmtree(fx, ignore_errors=True)
            build_fixture(fx, day)
            subprocess.run([sys.executable, str(ROOT / "scripts" / "sync.py"), "--fixture", str(fx), "--force"],
                           check=True, stdout=subprocess.DEVNULL)
    meta = json.loads((DATA / "meta.json").read_text())
    meta["demo"] = True
    meta["source"] = "DEMO — simulated prices for fictional sets"
    (DATA / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"Demo data written: {len(meta['sets'])} sets, {len(meta['products'])} products, {len(days)} sync days")


if __name__ == "__main__":
    main()

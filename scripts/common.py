"""Shared helpers for the sync and backfill scripts (standard library only)."""
from __future__ import annotations

import json
import math
import re
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG_PATH = ROOT / "config.json"
META_PATH = DATA / "meta.json"
HISTORY_PATH = DATA / "history.json"

BASE = "https://tcgcsv.com"
USER_AGENT = "PokeSealedVault/1.0 (personal GitHub Pages tracker)"
EPOCH = date(2024, 1, 1)  # history day indexes count from here


def load_config() -> dict:
    return json.loads(CONFIG_PATH.read_text())


def http_get(url: str, *, binary: bool = False, retries: int = 3, sleep: float = 0.12):
    """GET with a custom User-Agent, polite delay, and retries. Returns None on 404."""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
            time.sleep(sleep)
            return body if binary else json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                time.sleep(sleep)
                return None
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} tries: {url}: {last}")


def day_index(d: date) -> int:
    return (d - EPOCH).days


def index_to_date(i: int) -> date:
    return EPOCH + timedelta(days=i)


# ---------------------------------------------------------------- products ---

EXCLUDE_RE = re.compile(
    r"code card|card sleeves|\bsleeves\b|deck box|playmat|play mat|portfolio|"
    r"\bpin\b(?! collection)|\bcoin\b(?! collection)|damage counter|jumbo|oversized|"
    r"empty|display only|art print|figure only|digital",
    re.I,
)

TYPE_RULES = [
    ("case", re.compile(r"\bcase\b", re.I)),
    ("pc_etb", re.compile(r"pok[eé]mon center.*elite trainer box|elite trainer box.*pok[eé]mon center", re.I)),
    ("etb", re.compile(r"elite trainer box", re.I)),
    ("booster_bundle", re.compile(r"booster bundle", re.I)),
    ("booster_box", re.compile(r"booster box|booster display", re.I)),
    ("upc", re.compile(r"ultra[- ]premium collection|super[- ]premium collection", re.I)),
    ("build_battle", re.compile(r"build (?:&|and) battle", re.I)),
    ("blister3", re.compile(r"3[- ]pack blister|three[- ]pack|blister", re.I)),
    ("sleeved", re.compile(r"sleeved booster", re.I)),
    ("tin", re.compile(r"\btins?\b", re.I)),
    ("premium_collection", re.compile(r"collection|premium|box set|gift box|surprise box|chest|art bundle|\bset of \d", re.I)),
    ("pack", re.compile(r"booster pack|\bbooster\b|\bpack\b", re.I)),
]


def ext_map(product: dict) -> dict:
    return {e.get("name"): e.get("value") for e in product.get("extendedData") or []}


def is_single(product: dict) -> bool:
    ext = ext_map(product)
    return "Number" in ext or "Rarity" in ext


def classify_sealed(name: str) -> str | None:
    if EXCLUDE_RE.search(name):
        return None
    for t, rx in TYPE_RULES:
        if rx.search(name):
            return t
    return None


def best_price(rows: list[dict]) -> dict | None:
    """Pick the representative price row for a product (highest market across sub-types)."""
    best = None
    for r in rows:
        m = r.get("marketPrice") or r.get("midPrice")
        if m is None:
            continue
        if best is None or m > best["price"]:
            best = {
                "price": round(float(m), 2),
                "market": r.get("marketPrice"),
                "low": r.get("lowPrice"),
                "mid": r.get("midPrice"),
                "sub": r.get("subTypeName"),
            }
    return best


# ------------------------------------------------------------------- sets ----

SUBGROUP_SUFFIX = re.compile(
    r"\s*(?::|-)?\s*(trainer gallery|galarian gallery|shiny vault|classic collection|"
    r"radiant collection|special illustration rares?)\s*$",
    re.I,
)


def parent_name(group_name: str) -> str | None:
    """'SWSH12: Silver Tempest Trainer Gallery' -> 'SWSH12: Silver Tempest'."""
    if SUBGROUP_SUFFIX.search(group_name):
        return SUBGROUP_SUFFIX.sub("", group_name).strip()
    return None


def chase_regexes(chase: list[dict]):
    return [(c["name"], c.get("weight", 1.0), re.compile(rf"\b{re.escape(c['name'])}\b", re.I)) for c in chase]


def chase_score(top_singles: list[dict], chase: list[dict]) -> dict:
    """Mirror of the JS chaseScore in assets/engine.js. top_singles: [{name, price}] sorted desc."""
    rx = chase_regexes(chase)
    iconic = []
    for s in top_singles:
        for nm, w, r in rx:
            if r.search(s["name"]):
                iconic.append({**s, "pokemon": nm, "weight": w})
                break
    best = max((c["price"] * c["weight"] for c in iconic), default=0)

    def lscale(v, lo, hi):
        if v <= 0:
            return 0.0
        return max(0.0, min(1.0, (math.log10(v) - math.log10(lo)) / (math.log10(hi) - math.log10(lo))))

    s1 = lscale(best, 15, 1200) * 60
    s2 = min(sum(1 for c in iconic if c["price"] >= 40), 4) / 4 * 20
    depth = sum(s["price"] for s in top_singles[:10])
    s3 = lscale(depth, 80, 3000) * 20
    return {"score": round(s1 + s2 + s3, 1), "iconic": iconic, "best": round(best, 2), "depth": round(depth, 2)}


# ---------------------------------------------------------------- history ----

def load_history() -> dict:
    if HISTORY_PATH.exists():
        return json.loads(HISTORY_PATH.read_text())
    return {"epoch": EPOCH.isoformat(), "series": {}, "backfilled": []}


def put_point(history: dict, key: str, day: int, value: float | None, overwrite: bool = True):
    if value is None:
        return
    s = history["series"].setdefault(key, [])
    for p in s:
        if p[0] == day:
            if overwrite:
                p[1] = round(value, 2)
            return
    s.append([day, round(value, 2)])


def compact_history(history: dict, today: int, daily_window: int, bucket: int, keep_keys: set[str]):
    """Keep daily points for the recent window, one point per bucket before that; drop untracked keys."""
    out = {}
    for key, pts in history["series"].items():
        if key not in keep_keys:
            continue
        pts = sorted(pts, key=lambda p: p[0])
        recent = [p for p in pts if p[0] >= today - daily_window]
        old = {}
        for p in pts:
            if p[0] < today - daily_window:
                old[p[0] // bucket] = p  # last point in each bucket wins
        out[key] = sorted(old.values(), key=lambda p: p[0]) + recent
    history["series"] = out


def write_json(path: Path, obj, compact: bool = True):
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        path.write_text(json.dumps(obj, separators=(",", ":")))
    else:
        path.write_text(json.dumps(obj, indent=1))


def parse_ts(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "")[:19]).date().isoformat()
    except ValueError:
        return s[:10]

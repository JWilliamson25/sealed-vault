"""Product catalog for the Collection tab: every Pokemon product on TCGplayer (singles and sealed,
English and Japanese) with today's price for each printing, so the app can look up what a card or
box could be, list the possible matches, and value a collection.

Written by the daily sync to data/catalog/en.json and data/catalog/ja.json:
  {"date": "YYYY-MM-DD", "lang": "en",
   "subs": ["Normal", "Holofoil", ...],                 # printing names, indexed by the rows below
   "groups": [[groupId, name, release, abbreviation], ...],
   "items": [[productId, name, number, groupId, kind, [[subIndex, price], ...]], ...]}
kind: "s" = single card, "p" = sealed or other product. Images: tcgplayer-cdn.tcgplayer.com/product/{id}_200w.jpg

The English catalog is rebuilt every sync from data the sync already downloads. The Japanese one
needs every Japanese group (several hundred requests), so it's rebuilt weekly; in between, groups
the sync fetched anyway (promos, collection items) update its prices.
"""
from __future__ import annotations

import json
from pathlib import Path

from common import DATA, ext_map, is_single, parse_ts, write_json

CAT_DIR = DATA / "catalog"


class Catalog:
    def __init__(self, lang: str, date: str):
        self.lang, self.date = lang, date
        self.subs: list[str] = []
        self.groups: dict[int, list] = {}
        self.items: dict[int, list] = {}
        self.full: str | None = None  # date of the last full rebuild (Japanese catalog)

    def sub_index(self, name: str | None) -> int:
        name = name or "Normal"
        if name not in self.subs:
            self.subs.append(name)
        return self.subs.index(name)

    def add_group(self, g: dict):
        self.groups[g["groupId"]] = [g["groupId"], g["name"], parse_ts(g.get("publishedOn")), g.get("abbreviation") or ""]

    def add_products(self, gid: int, products: list[dict], by_pid: dict[int, list]):
        for p in products:
            ext = ext_map(p)
            prices = []
            for r in by_pid.get(p["productId"], []):
                m = r.get("marketPrice") or r.get("midPrice")
                if m is not None:
                    prices.append([self.sub_index(r.get("subTypeName")), round(float(m), 2)])
            self.items[p["productId"]] = [p["productId"], p.get("name") or "", ext.get("Number") or "", gid,
                                          "s" if is_single(p) else "p", prices]

    def price(self, pid: int, sub: str | None = None) -> float | None:
        """Price of one printing (or the highest if not given / not found)."""
        it = self.items.get(pid)
        if not it or not it[5]:
            return None
        if sub and sub in self.subs:
            si = self.subs.index(sub)
            for s, v in it[5]:
                if s == si:
                    return v
        return max(v for _s, v in it[5])

    def to_json(self) -> dict:
        return {"date": self.date, "full": self.full or self.date, "lang": self.lang, "subs": self.subs,
                "groups": sorted(self.groups.values(), key=lambda g: (g[2] or "", g[1])),
                "items": list(self.items.values())}

    def save(self):
        write_json(CAT_DIR / f"{self.lang}.json", self.to_json())

    @classmethod
    def load(cls, lang: str) -> "Catalog | None":
        p = CAT_DIR / f"{lang}.json"
        if not p.exists():
            return None
        d = json.loads(p.read_text())
        c = cls(lang, d.get("date"))
        c.full = d.get("full")
        c.subs = d.get("subs", [])
        c.groups = {g[0]: g for g in d.get("groups", [])}
        c.items = {it[0]: it for it in d.get("items", [])}
        return c

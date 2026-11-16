"""Daily prices for your collection, kept in your PRIVATE collection repo.

The app saves your collection to collection.json in a private GitHub repo. Each daily sync reads it
(with the COLLECTION_TOKEN secret), looks up today's price of every item in the catalog the sync just
built, and appends it to price_history.json in that same private repo. Nothing about your collection
is written to this public repo, and the logs only show counts (Action logs are public too).

Secrets/variables on the sealed-vault repo:
  COLLECTION_TOKEN  secret: fine-grained token with Contents read/write on the private repo
  COLLECTION_REPO   variable (optional): owner/repo, default JWilliamson25/sealed-vault-collection

price_history.json: {"epoch": "2024-01-01", "lastDay": N,
                     "series": {"<productId>|<printing>": [[day, price], ...]}}
"""
from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request

from common import EPOCH

API = "https://api.github.com"


def _req(method: str, path: str, token: str, body: dict | None = None, raw: bool = False):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None, headers={
        "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28",
        "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
        "User-Agent": "sealed-vault-sync"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            return b if raw else (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise RuntimeError(f"GitHub API {method} {path.split('/contents/')[-1]}: HTTP {e.code}") from None


def _conf():
    token = os.environ.get("COLLECTION_TOKEN", "").strip()
    repo = (os.environ.get("COLLECTION_REPO") or "JWilliamson25/sealed-vault-collection").strip()
    return token, repo


def read_file(name: str):
    """(parsed JSON, sha) of a file in the private repo, or (None, None)."""
    token, repo = _conf()
    meta = _req("GET", f"/repos/{repo}/contents/{name}", token)
    if not meta:
        return None, None
    raw = _req("GET", f"/repos/{repo}/contents/{name}", token, raw=True)
    return json.loads(raw), meta.get("sha")


def write_file(name: str, obj, sha: str | None, message: str):
    token, repo = _conf()
    body = {"message": message, "content": base64.b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode()}
    if sha:
        body["sha"] = sha
    _req("PUT", f"/repos/{repo}/contents/{name}", token, body)


def load_collection() -> dict | None:
    """The collection, or None when no token is set up (then everything else is skipped)."""
    token, _repo = _conf()
    if not token:
        print("Collection: no COLLECTION_TOKEN secret; skipping.")
        return None
    try:
        col, _sha = read_file("collection.json")
    except Exception as e:
        print(f"Collection: couldn't read it ({e}); skipping.")
        return None
    if not col:
        print("Collection: no collection.json yet; skipping.")
        return None
    return col


def jp_group_ids(col: dict | None) -> set[int]:
    return {int(i["groupId"]) for i in (col or {}).get("items", []) if i.get("lang") == "ja" and i.get("groupId")}


def record_prices(col: dict, catalogs: dict, price_date: str, day: int):
    items = col.get("items", [])
    if not items:
        return
    try:
        hist, sha = read_file("price_history.json")
    except Exception as e:
        print(f"Collection: couldn't read price history ({e}); skipping.")
        return
    hist = hist or {"epoch": EPOCH.isoformat(), "series": {}}
    series = hist.setdefault("series", {})
    n = 0
    for it in items:
        cat = catalogs.get(it.get("lang") or "en")
        if not cat:
            continue
        p = cat.price(int(it["id"]), it.get("sub"))
        if p is None:
            continue
        key = f"{it['id']}|{it.get('sub') or ''}"
        s = series.setdefault(key, [])
        if s and s[-1][0] == day:
            s[-1][1] = p
        else:
            s.append([day, p])
        n += 1
    hist["lastDay"] = day
    hist["priceDate"] = price_date
    try:
        write_file("price_history.json", hist, sha, f"Collection prices for {price_date}")
        print(f"Collection: recorded {n} of {len(items)} item prices.")
    except Exception as e:
        print(f"Collection: couldn't save price history ({e}).")

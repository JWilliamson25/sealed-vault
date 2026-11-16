/* Sealed Vault — your collection.
 *
 * Saved to collection.json in a PRIVATE GitHub repo (default JWilliamson25/sealed-vault-collection),
 * read and written straight from the browser with a fine-grained token kept only on this device.
 * The public site never contains your collection; without the token nobody can load it.
 *
 * Lookups use data/catalog/{en,ja}.json (every Pokémon product on TCGplayer, written by the daily
 * sync). Values use today's catalog price for the exact printing; history comes from
 * price_history.json in the private repo (the daily sync writes it) plus the public price history
 * for anything the tracker already follows.
 *
 * Profit: a card with no price entered counts as pulled ($0 cost). Sealed product with no price
 * entered is left out of profit until you add what you paid.
 */
(function (global) {
  "use strict";
  const E = global.Engine;
  const LSK = { conf: "sv.collection.conf", cache: "sv.collection.cache" };
  const DEFAULT_REPO = "JWilliamson25/sealed-vault-collection";
  const API = "https://api.github.com";
  const IMG = (id) => `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`;
  const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt$ = (v) => E.fmt$(v);
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ------------------------------------------------------- GitHub storage --- */
  const conf = () => ls.get(LSK.conf, null);
  const b64enc = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
  async function gh(method, path, body, raw) {
    const c = conf();
    const r = await fetch(API + path, {
      method, cache: "no-store",
      headers: { Authorization: `Bearer ${c.token}`, "X-GitHub-Api-Version": "2022-11-28", Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error(`GitHub said ${r.status}`); e.status = r.status; throw e; }
    return raw ? r.text() : r.json();
  }
  async function readFile(name) {
    const c = conf();
    const meta = await gh("GET", `/repos/${c.repo}/contents/${name}`);
    if (!meta) return { json: null, sha: null };
    const text = await gh("GET", `/repos/${c.repo}/contents/${name}`, null, true);
    return { json: JSON.parse(text), sha: meta.sha };
  }
  async function writeFile(name, obj, sha, message) {
    const c = conf();
    const body = { message, content: b64enc(JSON.stringify(obj, null, 1)) };
    if (sha) body.sha = sha;
    const r = await gh("PUT", `/repos/${c.repo}/contents/${name}`, body);
    return r.content.sha;
  }

  const S = { col: null, sha: null, history: null, status: "idle", error: null, catalog: {}, catalogLoading: null };

  async function loadCollection(force) {
    const cached = ls.get(LSK.cache, null);
    if (cached && !force && !S.col) { S.col = cached.col; S.sha = cached.sha; }
    if (!conf()) return;
    S.status = "loading";
    try {
      const { json, sha } = await readFile("collection.json");
      S.col = json || { version: 1, items: [] };
      S.sha = sha;
      ls.set(LSK.cache, { col: S.col, sha: S.sha, at: Date.now() });
      S.status = "ok"; S.error = null;
      readFile("price_history.json").then(({ json: h }) => { S.history = h; global.dispatchEvent(new Event("collection:history")); }).catch(() => {});
    } catch (e) {
      S.status = "error";
      S.error = e.status === 401 ? "The token was refused — it may have expired. Paste a new one below."
        : e.status === 403 ? "The token can't read that repo. Check it has Contents: Read and write on it."
        : navigator.onLine === false ? "You're offline — showing the copy saved on this device." : `Couldn't load your collection (${e.message}).`;
    }
  }

  /** Apply a change and save it. On a conflict (changed on another device), reload and re-apply once. */
  async function mutate(fn, message) {
    if (!S.col) S.col = { version: 1, items: [] };
    fn(S.col);
    ls.set(LSK.cache, { col: S.col, sha: S.sha, at: Date.now(), dirty: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        S.col.updated = new Date().toISOString();
        S.sha = await writeFile("collection.json", S.col, S.sha, message);
        ls.set(LSK.cache, { col: S.col, sha: S.sha, at: Date.now() });
        return true;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt === 0) {
          const { json, sha } = await readFile("collection.json");
          S.col = json || { version: 1, items: [] }; S.sha = sha; fn(S.col); continue;
        }
        S.error = "Saved on this device, but not to GitHub yet (" + e.message + "). It'll retry on your next change.";
        return false;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------- catalog --- */
  function loadCatalog(lang) {
    if (S.catalog[lang]) return Promise.resolve(S.catalog[lang]);
    if (S.catalogLoading?.[lang]) return S.catalogLoading[lang];
    S.catalogLoading ||= {};
    return (S.catalogLoading[lang] = fetch(`data/catalog/${lang}.json`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return null;
      const groups = new Map(d.groups.map(([id, name, release, abbr]) => [id, { id, name, release, abbr }]));
      const items = d.items.map(([id, name, number, gid, kind, prices]) => {
        const g = groups.get(gid) || {};
        const p = {}; for (const [si, v] of prices) p[d.subs[si]] = v;
        const best = prices.length ? Math.max(...prices.map((x) => x[1])) : null;
        const hay = `${name} ${number} ${g.name || ""} ${g.abbr || ""}`.toLowerCase();
        return { id, name, number, gid, kind, prices: p, best, lang, set: g.name || "", release: g.release || null, hay, numKey: numKey(number) };
      });
      const byId = new Map(items.map((i) => [i.id, i]));
      return (S.catalog[lang] = { date: d.date, items, byId, groups });
    }));
  }
  const numKey = (n) => { const m = String(n || "").toUpperCase().match(/^([A-Z-]*?)0*(\d+)([A-Z]?)(?:\s*\/\s*([A-Z-]*?)0*(\d*)([A-Z-]*))?$/); return m ? { pre: m[1], n: m[2], suf: m[3], dpre: m[4] || "", d: m[5] || "", dsuf: m[6] || "" } : null; };
  const catItem = (it) => S.catalog[it.lang || "en"]?.byId.get(Number(it.id)) || null;

  /** Search the catalog: every word must appear in the name, number or set; numbers match exactly. */
  function search(q, { lang = "both", kind = "all", limit = 40 } = {}) {
    const words = q.toLowerCase().replace(/[^\p{L}\p{N}/\-' ]/gu, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const nums = words.filter((w) => /\d/.test(w)).map(numKey).filter(Boolean);
    const text = words.filter((w) => !/\d/.test(w));
    const langs = lang === "both" ? ["en", "ja"] : [lang];
    const out = [];
    for (const l of langs) {
      const cat = S.catalog[l]; if (!cat) continue;
      for (const it of cat.items) {
        if (kind === "single" && it.kind !== "s") continue;
        if (kind === "sealed" && it.kind !== "p") continue;
        if (!text.every((w) => it.hay.includes(w))) continue;
        let score = 0;
        if (nums.length) {
          const k = it.numKey; if (!k) continue;
          const hit = nums.find((n) => n.n === k.n && (n.pre === k.pre || !n.pre) && (!n.d || (n.d === k.d && (!n.dpre || n.dpre === k.dpre))));
          if (!hit) continue;
          score += hit.d ? 60 : 30;
        }
        const nm = it.name.toLowerCase();
        if (text.length && text.every((w) => nm.includes(w))) score += 20;
        const phrase = text.join(" ");
        if (phrase && nm.includes(phrase)) score += 8;
        if (/\bcase\b/.test(nm) && !text.includes("case")) score -= 15; // "booster box" means the box, not a case of them
        score -= Math.min(8, nm.length / 12); // shorter, closer names first
        if (text.length && nm.startsWith(text[0])) score += 10;
        score += Math.min(10, Math.log10((it.best || 0) + 1) * 4);
        out.push([score, it]);
      }
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  }

  /* -------------------------------------------------------------- values --- */
  function itemValue(it, ctx) {
    const c = catItem(it);
    const raw = c ? (it.sub && c.prices[it.sub] != null ? c.prices[it.sub] : c.best) : null;
    let unit = raw, how = "market";
    if (it.grade) {
      const psa = ctx.psa10?.[it.id]?.price;
      if (it.gradedValue != null) { unit = it.gradedValue; how = "your value"; }
      else if (/^PSA 10$/i.test(it.grade) && psa) { unit = psa; how = "PSA 10 price"; }
      else how = "raw price (add a graded value)";
    }
    return { unit, total: unit != null ? unit * it.qty : null, raw, how, c };
  }
  function costBasis(it) {
    if (it.cost != null) return { known: true, total: it.cost * it.qty };
    if (it.kind === "single") return { known: true, total: 0, pulled: true };
    return { known: false, total: null };
  }

  function totals(items, ctx) {
    let value = 0, cost = 0, valueKnown = 0, missing = 0, sealedNoCost = 0, sealedPaid = 0, sealedValue = 0;
    for (const it of items) {
      const v = itemValue(it, ctx), cb = costBasis(it);
      if (v.total == null) { missing++; continue; }
      value += v.total;
      if (cb.known) { cost += cb.total; valueKnown += v.total; }
      if (it.kind === "sealed") { if (cb.known) { sealedPaid += cb.total; sealedValue += v.total; } else sealedNoCost++; }
    }
    return { value, cost, profit: valueKnown - cost, valueKnown, missing, sealedNoCost, sealedPaid, sealedValue };
  }

  /** Daily value of the current collection: private history + public history, flat-filled at the edges. */
  function valueSeries(items, ctx, sinceAdded) {
    const perItem = items.map((it) => {
      const key = `${it.id}|${it.sub || ""}`;
      const priv = S.history?.series?.[key] || S.history?.series?.[`${it.id}|`] || [];
      const pub = ctx.publicSeries(it.id) || [];
      const m = new Map(pub.map(([d, v]) => [d, v])); for (const [d, v] of priv) m.set(d, v);
      const pts = [...m.entries()].sort((a, b) => a[0] - b[0]);
      return { it, pts, from: sinceAdded && it.added ? E.dateToDay(it.added) : -Infinity };
    }).filter((x) => x.pts.length && !x.it.grade);
    if (!perItem.length) return [];
    const last = Math.max(...perItem.map((x) => x.pts[x.pts.length - 1][0]));
    const first = Math.max(Math.min(...perItem.map((x) => Math.max(x.pts[0][0], x.from))), last - 730);
    const out = [];
    const idx = perItem.map(() => 0);
    for (let d = first; d <= last; d++) {
      let sum = 0;
      perItem.forEach((x, i) => {
        if (d < x.from) return;
        while (idx[i] + 1 < x.pts.length && x.pts[idx[i] + 1][0] <= d) idx[i]++;
        sum += x.pts[idx[i]][1] * x.it.qty; // before its first price, its first known price
      });
      out.push([E.dayToDate(d).getTime(), Math.round(sum * 100) / 100]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- scan --- */
  function loadTesseract() {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = TESSERACT; s.onload = () => res(global.Tesseract); s.onerror = () => rej(new Error("Couldn't load the text reader")); document.head.appendChild(s); });
  }
  async function prepImage(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0, cv.width, cv.height);
    const d = g.getImageData(0, 0, cv.width, cv.height), a = d.data;
    for (let i = 0; i < a.length; i += 4) { const y = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; const v = Math.max(0, Math.min(255, (y - 128) * 1.6 + 128)); a[i] = a[i + 1] = a[i + 2] = v; }
    g.putImageData(d, 0, 0);
    return cv;
  }
  /** Read a card photo: collector number(s) and name words → catalog candidates. */
  async function scan(file, onStatus) {
    onStatus("Loading the text reader (first time takes a moment)…");
    const T = await loadTesseract();
    const cv = await prepImage(file);
    onStatus("Reading the card…");
    const { data } = await T.recognize(cv, "eng");
    const text = (data.text || "").replace(/[|]/g, "/");
    // Collector numbers: 4/102, TG06/TG30, 203/XY-P, 001/SV-P; black star promos: SWSH062, SM183, SVP 085.
    const nums = [...text.matchAll(/\b([A-Z]{0,4}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,4}\d{1,3}|[A-Z]{1,4}-P)\b/gi)].map((m) => `${m[1]}/${m[2]}`.toUpperCase());
    for (const m of text.matchAll(/\b(SWSH|SM|XY|BW|DP|HGSS|SVP|SV|MEP)\s?(\d{2,3})\b/gi)) nums.push(`${m[1]}${m[2]}`.toUpperCase());
    const tokens = new Set(text.toLowerCase().split(/[^a-zé'-]+/).filter((w) => w.length >= 4));
    // Name words: words from the scan that start a catalog card name (Pokémon names, "Dark", "Team Rocket's"…).
    const starts = new Set();
    for (const l of ["en", "ja"]) for (const it of S.catalog[l]?.items || []) if (it.kind === "s") starts.add(it.name.toLowerCase().split(/[\s-]/)[0]);
    const nameWords = [...tokens].filter((w) => starts.has(w)).slice(0, 3);
    const seen = new Map();
    const add = (list, bonus) => list.forEach((it, i) => { const s = (seen.get(it) || 0) + bonus - i * 0.5; seen.set(it, s); });
    for (const n of nums) {
      add(search(n, { kind: "single", limit: 30 }), 40);
      for (const w of nameWords) add(search(`${w} ${n}`, { kind: "single", limit: 15 }), 80);
      const first = n.split("/")[0]; for (const w of nameWords) add(search(`${w} ${first}`, { kind: "single", limit: 15 }), 30);
    }
    for (const w of nameWords) add(search(w, { kind: "single", limit: 20 }), 5);
    const results = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0]);
    return { results, text, nums, nameWords, query: [nameWords[0], nums[0]].filter(Boolean).join(" ") };
  }

  global.Collection = { conf, setConf: (c) => ls.set(LSK.conf, c), clearConf: () => { localStorage.removeItem(LSK.conf); localStorage.removeItem(LSK.cache); S.col = null; S.sha = null; },
    S, DEFAULT_REPO, IMG, loadCollection, mutate, loadCatalog, search, itemValue, costBasis, totals, valueSeries, scan, uid, today, numKey, catItem, readFile };
})(window);

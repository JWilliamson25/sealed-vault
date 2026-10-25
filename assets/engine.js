/* Sealed Vault — recommendation engine.
 *
 * Encodes the rules of thumb long-time sealed Pokémon investors use for 4+ year holds:
 *  1. Chase cards drive sealed demand. A set carried by Charizard / Umbreon / Pikachu-tier
 *     cards keeps getting opened (and so gets scarcer) long after print ends.
 *  2. Modern sets follow a life cycle: release hype -> print-run trough -> out-of-print climb
 *     -> established appreciation -> slower "vintage-modern" growth.
 *     The best entries are usually the late print-run trough and the out-of-print transition.
 *  3. Never chase a spike. 30-day jumps usually retrace; set a target and wait.
 *  4. Don't catch a falling knife in-print — wait for the slide to flatten unless at retail.
 *  5. When chase singles climb but sealed hasn't moved, sealed tends to catch up.
 *  6. Format matters: booster boxes / cases > Pokémon Center ETBs / UPCs > ETBs > bundles >
 *     blisters/packs/tins for long-term liquidity and growth.
 *
 * Data rules (added after the app called guesses "Strong buy"):
 *  A. A buy-under target is never derived from today's price. It comes from a verified retail
 *     price (early in a set's life) or from real price history. With neither, there is no call.
 *  B. Catch-all TCGplayer groups (Miscellaneous, promos, POP series…) are not sets. Their
 *     release date and "chase cards" mean nothing for a given product.
 *  C. Retail is only known for formats with one fixed MSRP, or when set per product in
 *     config.json → productOverrides. Everything else has no retail.
 *  D. Strong buy needs real history, a real release date and real chase cards.
 *
 * Everything here is transparent heuristics, not financial advice.
 */
(function (global) {
  "use strict";

  const DAY = 86400000;
  const EPOCH = Date.UTC(2024, 0, 1);
  const MIN_HIST_DAYS = 45;

  const TYPE_LABEL = {
    booster_box: "Booster Box", case: "Sealed Case", display: "Display (multi-unit)", lot: "Bundle / lot",
    pc_etb: "Pokémon Center ETB", etb: "Elite Trainer Box", upc: "Ultra-Premium Collection", spc: "Super-Premium Collection",
    booster_bundle: "Booster Bundle", premium_collection: "Collection", build_battle: "Build & Battle",
    blister3: "3-Pack Blister", blister2: "2-Pack Blister", blister1: "Checklane / 1-Pack Blister", blister_other: "Blister",
    sleeved: "Sleeved Pack", pack: "Booster Pack", tin: "Tin", mini_tin: "Mini Tin",
  };

  const PHASES = {
    hype:        { label: "Release hype",       lifecycle: 30, blurb: "Brand new — prices usually sag as print waves land." },
    trough:      { label: "Print-run trough",   lifecycle: 80, blurb: "Still printing; historically the cheapest window to accumulate." },
    transition:  { label: "Out-of-print climb", lifecycle: 90, blurb: "Supply is drying up — this is when sealed historically starts to climb." },
    established: { label: "Established",        lifecycle: 70, blurb: "Already appreciating; buy dips, not rips." },
    vintage:     { label: "Vintage-modern",     lifecycle: 55, blurb: "Mature; slower, steadier growth — only the strongest chase sets keep compounding." },
    unknown:     { label: "Release date unknown", lifecycle: 50, blurb: "This product's release date isn't known, so its life-cycle phase can't be judged." },
  };

  const SIGNALS = {
    strong_buy: { label: "Strong buy", rank: 0, icon: "▲▲" },
    buy:        { label: "Buy",        rank: 1, icon: "▲" },
    accumulate: { label: "Accumulate", rank: 2, icon: "◆" },
    wait:       { label: "Wait",       rank: 3, icon: "■" },
    overheated: { label: "Overheated", rank: 4, icon: "!" },
    falling:    { label: "Still falling", rank: 4, icon: "▼" },
    pass:       { label: "Pass",       rank: 5, icon: "–" },
    no_call:    { label: "Not enough data", rank: 6, icon: "?" },
  };

  const CONFIDENCE = {
    high:   { label: "High confidence" },
    medium: { label: "Medium confidence" },
    low:    { label: "Low confidence" },
  };

  // TCGplayer groups that are grab-bags of products from many years, not one set.
  const CATCHALL_RE = /miscellaneous|promo|pop series|mcdonald|burger king|prize pack|exclusives|jumbo|league|championship|trainer kit|my first battle|trading card game classic|calendar|best of|world collection|alternate art/i;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lscale = (v, lo, hi) => (v <= 0 ? 0 : clamp((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dayToDate = (d) => new Date(EPOCH + d * DAY);
  const dateToDay = (iso) => Math.round((Date.parse(iso + "T00:00:00Z") - EPOCH) / DAY);

  /** Finer format than the sync's classifier, from the product name. */
  function refineType(name, t) {
    const n = name || "";
    if (/\bcase\b/i.test(n)) return "case";
    if (/\bdisplay\b/i.test(n)) return "display";
    if (/costco|sam'?s club|\bbj'?s\b|\bset of \d+\b|\b\d+-pack\b(?!\s*blister)|\bbundle of\b|\band (?:tin|pok[eé] ?ball|booster bundle|\d+ bonus)/i.test(n)) return "lot";
    if (/super[- ]premium collection/i.test(n)) return "spc";
    if (/ultra[- ]premium collection/i.test(n)) return "upc";
    if (/mini tin/i.test(n)) return "mini_tin";
    if (/\b(?:3|three)[- ]pack blister/i.test(n)) return "blister3";
    if (/\b(?:2|two)[- ]?(?:mini-)?pack blister|2 mini-pack blister/i.test(n)) return "blister2";
    if (/checklane|single[- ]pack blister|\b1[- ]pack blister/i.test(n)) return "blister1";
    if (t === "blister3") return "blister_other";
    return t;
  }

  /** What a case / display / lot contains, for its format score. */
  function innerType(name) {
    const n = (name || "").replace(/\b(case|display)\b/gi, "");
    for (const [t, re] of [["booster_box", /booster box/i], ["pc_etb", /pok[eé]mon center.*elite trainer box/i], ["etb", /elite trainer box/i],
      ["booster_bundle", /booster bundle/i], ["upc", /ultra[- ]premium/i], ["spc", /super[- ]premium/i], ["mini_tin", /mini tin/i], ["tin", /\btins?\b/i],
      ["sleeved", /sleeved/i], ["blister3", /blister/i]]) if (re.test(n)) return t;
    return null;
  }

  /** Mirror of scripts/common.py chase_score so the Settings chase list can rescore live. */
  function chaseScore(topSingles, chaseList) {
    const rx = chaseList.map((c) => ({ name: c.name, w: c.weight ?? 1, re: new RegExp(`\\b${escRe(c.name)}\\b`, "i") }));
    const iconic = [];
    for (const s of topSingles) {
      const hit = rx.find((r) => r.re.test(s.name));
      if (hit) iconic.push({ ...s, pokemon: hit.name, weight: hit.w });
    }
    const best = Math.max(0, ...iconic.map((c) => c.price * c.weight));
    const s1 = lscale(best, 15, 1200) * 60;
    const s2 = (Math.min(iconic.filter((c) => c.price >= 40).length, 4) / 4) * 20;
    const depth = topSingles.slice(0, 10).reduce((a, s) => a + s.price, 0);
    const s3 = lscale(depth, 80, 3000) * 20;
    const score = Math.round((s1 + s2 + s3) * 10) / 10;
    const tier = score >= 70 ? "Elite" : score >= 50 ? "Strong" : score >= 30 ? "Moderate" : "Weak";
    return { score, tier, iconic, depth };
  }

  /* ----------------------------------------------------------- stats ---- */
  function seriesStats(series, lastDay) {
    if (!series || !series.length) return { n: 0, spanDays: 0 };
    const pts = series.slice().sort((a, b) => a[0] - b[0]);
    const end = lastDay ?? pts[pts.length - 1][0];
    const valueAt = (day) => {
      // last point at or before `day` (within 21 days), else null
      let v = null;
      for (const [d, p] of pts) { if (d <= day) v = d >= day - 21 ? p : null; else break; }
      return v;
    };
    const cur = pts[pts.length - 1][1];
    const ch = (days) => { const v = valueAt(end - days); return v ? (cur / v - 1) * 100 : null; };
    const win = (days) => pts.filter(([d]) => d >= end - days).map(([, p]) => p);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const w90 = win(90), w180 = win(180), w365 = win(365);
    return {
      n: pts.length, spanDays: end - pts[0][0], cur,
      ch30: ch(30), ch90: ch(90), ch365: ch(365),
      low30: w90.length ? Math.min(...win(30)) : null,
      low90: w90.length ? Math.min(...w90) : null,
      low180: w180.length ? Math.min(...w180) : null,
      high365: w365.length ? Math.max(...w365) : null,
      ma90: mean(w90), ma180: mean(w180),
      allLow: Math.min(...pts.map((p) => p[1])), allHigh: Math.max(...pts.map((p) => p[1])),
    };
  }

  function phaseFor(ageMonths) {
    if (ageMonths == null) return "unknown";
    if (ageMonths < 2) return "hype";
    if (ageMonths < 12) return "trough";
    if (ageMonths < 24) return "transition";
    if (ageMonths < 48) return "established";
    return "vintage";
  }

  /** Days of real price history the app has (longest product series). */
  function historyDays(meta, history) {
    let best = 0;
    for (const p of meta.products) {
      const s = history.series[String(p.id)];
      if (s && s.length) best = Math.max(best, s.length);
    }
    return best;
  }

  const fmt$ = (v) => (v == null ? "—" : "$" + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)));
  const fmtPct = (v) => { if (v == null) return "—"; const r = Math.round(v); return r === 0 ? "0%" : (r > 0 ? "+" : "") + r + "%"; };

  /* ---------------------------------------------------------- engine ---- */
  /**
   * @param ctx {meta, history, settings:{chasePokemon, retailReference, retailOverrides, productOverrides, formatScore, risk}}
   * @returns array of analysed products
   */
  function analyse(ctx) {
    const { meta, history, settings } = ctx;
    const lastDay = history.lastDay ?? dateToDay(meta.priceDate);
    const nowMs = Date.parse(meta.priceDate + "T00:00:00Z");
    const ageOf = (iso) => (iso ? (nowMs - Date.parse(iso + "T00:00:00Z")) / DAY / 30.44 : null);
    const riskMult = { conservative: 0.95, balanced: 1, aggressive: 1.05 }[settings.risk || "balanced"];
    const overrides = settings.productOverrides || {};

    const sets = {};
    for (const s of meta.sets) {
      const catchall = CATCHALL_RE.test(s.name);
      // tcgcsv stamps some old catch-all groups with today's date; a release "today" is not a release.
      const release = catchall || !s.release || s.release === meta.priceDate ? null : s.release;
      const cs = chaseScore(s.topSingles, settings.chasePokemon);
      const idx = seriesStats(history.series["set:" + s.id], lastDay);
      const ageMonths = ageOf(release);
      sets[s.id] = { ...s, kind: catchall ? "catchall" : "expansion", release, chase: cs, singlesStats: idx, ageMonths, phase: phaseFor(ageMonths) };
    }
    // Real expansions, longest name first, for linking catch-all products ("Costco Evolving Skies ETB…") to a set.
    const linkable = Object.values(sets).filter((s) => s.kind === "expansion")
      .map((s) => ({ s, key: s.name.replace(/^[A-Z0-9]+:\s*/i, "").replace(/^(?:SV|SWSH|ME|SM|XY)\s*-\s*/i, "").trim() }))
      .filter((x) => x.key.length >= 5).sort((a, b) => b.key.length - a.key.length)
      .map((x) => ({ ...x, re: new RegExp(`\\b${escRe(x.key)}\\b`, "i") }));
    const chaseRx = settings.chasePokemon.map((c) => ({ name: c.name, w: c.weight ?? 1, re: new RegExp(`\\b${escRe(c.name)}\\b`, "i") }));

    const out = [];
    for (const p of meta.products) {
      const set = sets[p.groupId];
      if (!set) continue;
      const ov = overrides[p.id] || overrides[String(p.id)] || {};
      const type = refineType(p.name, p.type);
      const price = p.price;
      const st = seriesStats(history.series[String(p.id)], lastDay);
      const enoughHist = st.n >= 6 && st.spanDays >= MIN_HIST_DAYS;

      /* --- retail: per product, else a fixed-MSRP format default (never for catch-all multi-era groups' odd formats) */
      let retail = null, retailSrc = "none";
      if (ov.retail != null) { retail = ov.retail; retailSrc = "product"; }
      else if (settings.retailOverrides?.[p.id] != null) { retail = settings.retailOverrides[p.id]; retailSrc = "product"; }
      else if (settings.retailReference?.[type] != null) { retail = settings.retailReference[type]; retailSrc = "format"; }
      const mult = retail ? price / retail : null;

      /* --- release & phase: from the product override, else the set (only if it's a real set) */
      const release = ov.release || set.release || null;
      const ageMonths = ageOf(release);
      const phase = phaseFor(ageMonths);

      /* --- chase: the set's cards, a set named in the product, or only the Pokémon on the box */
      let chaseInfo, chaseSrc;
      if (set.kind === "expansion") { chaseInfo = set.chase; chaseSrc = "set"; }
      else {
        const link = linkable.find((x) => x.re.test(p.name));
        if (link) { chaseInfo = { ...link.s.chase, linkedSet: link.s.name }; chaseSrc = "linked"; }
        else {
          const hit = chaseRx.find((r) => r.re.test(p.name));
          chaseInfo = hit ? { score: Math.round(40 * hit.w), tier: "Name only", iconic: [], pokemon: hit.name } : { score: 0, tier: "None", iconic: [] };
          chaseSrc = hit ? "name" : "none";
        }
      }
      const chase = chaseInfo.score;
      const c01 = chase / 100;

      /* --- target buy price: from retail or from history, never from today's price ---------- */
      let target = null, targetWhy;
      const early = phase === "hype" || phase === "trough";
      if (early && retail) {
        if (phase === "hype") {
          target = Math.min(retail * (1 + 0.1 * c01), enoughHist && st.low30 != null ? st.low30 : Infinity);
          targetWhy = "near retail — let the release premium bleed out";
        } else {
          const r = retail * (1 + 0.15 * c01);
          target = enoughHist && st.low90 != null ? Math.min(Math.max(st.low90 * 1.05, retail * 0.9), r) : r;
          targetWhy = "retail-ish while it's still printing";
        }
      } else if (enoughHist) {
        if (phase === "hype" || phase === "trough") { target = st.low90; targetWhy = "its 90-day low — no retail price on file, so only buy it at its cheapest"; }
        else if (phase === "transition") { target = Math.min(st.ma90 * 0.97, st.low90 * 1.08); targetWhy = "just under the 90-day average — buy the dips while supply dries up"; }
        else if (phase === "established") { target = (st.ma180 ?? st.ma90) * 0.93; targetWhy = "~7% under the 6-month average"; }
        else if (phase === "vintage") { target = (st.ma180 ?? st.ma90) * 0.95; targetWhy = "~5% under the 6-month average"; }
        else { target = (st.ma180 ?? st.ma90) * 0.93; targetWhy = "~7% under the 6-month average (release date unknown)"; }
      } else {
        targetWhy = early
          ? `no retail price on file and only ${st.n} day${st.n === 1 ? "" : "s"} of price history`
          : `needs about ${MIN_HIST_DAYS} days of price history (has ${st.n})`;
      }
      if (target != null) target = Math.round(target * riskMult * 100) / 100;

      /* --- component scores (0-100) ---------------------------------------- */
      let value = null;
      if (target != null) {
        value = clamp(100 - ((price / target - 0.95) / 0.4) * 100, 0, 100);
        if (phase === "hype" && mult && mult > 1.4) value = Math.min(value, 20);
      }
      const lifecycle = PHASES[phase].lifecycle;
      const fmtType = type === "case" || type === "display" || type === "lot" ? innerType(p.name) : type;
      let format = (settings.formatScore?.[fmtType] ?? 5) * 10;
      if (type === "lot") format = Math.max(0, format - 10);

      let momentum = 50;
      const flags = [];
      const ch30 = st.ch30, ch90 = st.ch90, ch365 = st.ch365;
      const idx90 = chaseSrc === "set" ? set.singlesStats.ch90 : null;
      if (ch30 != null) {
        if (ch30 > 25) { momentum = 15; flags.push("spike"); }
        else if (ch30 > 15) momentum = 35;
        else if (ch30 < -10 && early) {
          if (retail && price <= retail * 1.05) momentum = 60; else { momentum = 30; flags.push("falling"); }
        } else if (ch90 != null && ch90 < -15 && ch30 < -5) { momentum = 25; flags.push("falling"); }
        else if (ch90 != null && ch90 < -8 && Math.abs(ch30) < 4) { momentum = 80; flags.push("bottoming"); }
        else if (ch365 != null && ch365 > 15 && ch30 < -5) { momentum = 85; flags.push("dip_in_uptrend"); }
        else if (ch90 != null && ch90 >= 5 && ch90 <= 25 && ch30 > -5 && ch30 < 10) { momentum = 70; flags.push("steady_up"); }
      }
      if (idx90 != null && ch90 != null) {
        if (idx90 > 15 && ch90 < 5) { momentum = Math.min(100, momentum + 15); flags.push("divergence"); }
        if (idx90 < -20) { momentum = Math.max(0, momentum - 15); flags.push("chase_falling"); }
      }

      const score = value != null
        ? Math.round(0.3 * chase + 0.25 * value + 0.15 * lifecycle + 0.15 * momentum + 0.15 * format)
        : Math.round((0.3 * chase + 0.15 * lifecycle + 0.15 * momentum + 0.15 * format) / 0.75);
      const quality = Math.round((0.3 * chase + 0.15 * lifecycle + 0.15 * format) / 0.6);

      /* --- data checks & confidence ---------------------------------------- */
      const checks = [
        { k: "history", ok: enoughHist, label: enoughHist ? `${st.n} days of price history` : `Only ${st.n} day${st.n === 1 ? "" : "s"} of price history (needs ~${MIN_HIST_DAYS})` },
        { k: "release", ok: phase !== "unknown", label: phase !== "unknown" ? `Release date ${release}${ov.release ? " (set for this product)" : ""}` : "Release date unknown" },
        { k: "retail", ok: retailSrc !== "none", label: retailSrc === "product" ? `Retail ${fmt$(retail)} (set for this product)` : retailSrc === "format" ? `Retail ${fmt$(retail)} (standard ${TYPE_LABEL[type] || type} MSRP)` : "No retail price on file" },
        { k: "chase", ok: chaseSrc === "set", label: chaseSrc === "set" ? `Chase cards from ${set.name}` : chaseSrc === "linked" ? `Chase cards borrowed from ${chaseInfo.linkedSet} (named in the product)` : chaseSrc === "name" ? `No set chase cards — scored only on ${chaseInfo.pokemon} being on the box` : "Can't tie this product to any chase cards" },
      ];
      const misses = checks.filter((c) => !c.ok).map((c) => c.k);
      const confidence = !enoughHist ? "low" : misses.length === 0 && st.spanDays > 365 && st.n > 40 ? "high" : misses.length <= 1 ? "medium" : "low";

      /* --- signal ------------------------------------------------------------ */
      let signal;
      if (target == null) signal = chaseSrc === "set" && (quality < 40 || chase < 30) ? "pass" : "no_call";
      else if (quality < 40 || chase < 30) signal = chaseSrc === "set" || chaseSrc === "linked" ? "pass" : "no_call";
      else if (flags.includes("spike") && price > target) signal = "overheated";
      else if (flags.includes("falling")) signal = "falling";
      else if (price <= target && score >= 68) signal = "strong_buy";
      else if (price <= target * 1.05 && score >= 55) signal = "buy";
      else if (price <= target * 1.12 && quality >= 60 && chase >= 50) signal = "accumulate";
      else signal = "wait";

      // Strong buy only on real data: history, release date, the set's own chase cards.
      const downgraded = [];
      if (signal === "strong_buy" && (confidence === "low" || misses.length)) { signal = "buy"; downgraded.push("Capped at Buy until the data checks below pass."); }
      // A low-confidence Buy is only allowed when it's anchored to a known retail price.
      if ((signal === "buy" || signal === "accumulate") && confidence === "low" && !(early && retail)) { signal = "wait"; downgraded.push("Not a buy on this little data."); }

      /* --- reasons, veteran voice -------------------------------------------- */
      const reasons = [];
      const topIconic = (chaseInfo.iconic || []).slice(0, 2).map((c) => `${c.name} (${fmt$(c.price)})`).join(" and ");
      if (chaseSrc === "set" || chaseSrc === "linked") {
        const via = chaseSrc === "linked" ? ` (from ${chaseInfo.linkedSet})` : "";
        if (chaseInfo.tier === "Elite" || chaseInfo.tier === "Strong")
          reasons.push(`${chaseInfo.tier} chase${via}: ${topIconic || "deep chase list"} — the kind of cards that keep people ripping this set for years.`);
        else if ((chaseInfo.iconic || []).length) reasons.push(`${chaseInfo.tier} chase${via}: ${topIconic}. Not enough to carry the set on its own.`);
        else reasons.push("No headline chase from your list — long-term demand will be weaker.");
        if (chase < 30) reasons.push("Chase score under 30 — not a set I'd park money in for 4+ years.");
      } else if (chaseSrc === "name") {
        reasons.push(`Filed in TCGplayer's “${set.name}” group, which isn't a set. The only chase signal is ${chaseInfo.pokemon} on the box — no chase cards are tied to it.`);
      } else {
        reasons.push(`Filed in TCGplayer's “${set.name}” group, which isn't a set, and the name doesn't point to one — there are no chase cards to judge it by.`);
      }
      if (phase === "unknown") reasons.push("Release date unknown — add it in config.json → productOverrides to get a life-cycle read.");
      else reasons.push(`${PHASES[phase].label} (${Math.max(0, ageMonths).toFixed(0)} mo old): ${PHASES[phase].blurb}`);
      if (target == null) reasons.push(`No buy-under price yet: ${targetWhy}.`);
      if (mult != null) {
        const m = mult.toFixed(2) + "× retail";
        if (mult <= 1.05 && chaseSrc === "set") reasons.push(`At ${m} — buying near retail on a chase set is the cleanest long-term entry there is.`);
        else if (phase === "hype" && mult > 1.3) reasons.push(`At ${m} on a brand-new product — you're paying the release premium.`);
        else reasons.push(`Trading at ${m}${retailSrc === "format" ? " (standard MSRP for this format)" : ""}.`);
      } else if (type === "case" || type === "display" || type === "lot") reasons.push("Multi-unit product — there's no single retail price to compare against.");
      if (flags.includes("spike")) reasons.push(`Up ${fmtPct(ch30)} in 30 days. Spikes like this usually retrace — set an alert at ${fmt$(target)} and be patient.`);
      if (flags.includes("falling")) reasons.push(early
        ? `Down ${fmtPct(ch30)} in 30 days while still in print — let it flatten before buying.`
        : `Down ${fmtPct(ch90)} over 90 days and still sliding (${fmtPct(ch30)} this month) — don't catch a falling knife; wait for it to flatten.`);
      if (flags.includes("bottoming")) reasons.push(`Fell ${fmtPct(ch90)} over 90 days but has flattened this month — looks like it's finding a floor.`);
      if (flags.includes("dip_in_uptrend")) reasons.push(`A ${fmtPct(ch30)} pullback inside a ${fmtPct(ch365)} yearly uptrend — dips like this are where you add.`);
      if (flags.includes("steady_up")) reasons.push(`Steady climb (${fmtPct(ch90)} over 90 days) without a blow-off — healthy.`);
      if (flags.includes("divergence")) reasons.push(`Chase singles are up ${fmtPct(idx90)} over 90 days but this is flat — sealed tends to catch up to its singles.`);
      if (flags.includes("chase_falling")) reasons.push(`Chase singles are down ${fmtPct(idx90)} over 90 days — demand for the set is cooling.`);
      if (["pack", "sleeved", "tin", "mini_tin", "blister1"].includes(type)) reasons.push("Loose packs, blisters and tins are the weakest long-term format (weighing risk, low premium).");
      if (type === "booster_box" || fmtType === "booster_box") reasons.push("Booster boxes are the most liquid long-term sealed format.");
      if (p.presale) reasons.push("Still in presale — no real market yet.");
      reasons.push(...downgraded);
      if (confidence === "low" && target != null) reasons.push("Thin data so far — treat this call as provisional.");

      const pick = (re) => reasons.find((x) => re.test(x));
      const headline = (signal === "no_call" ? pick(/^No buy-under price/) : null) ||
        pick(/^(Up |Down |Fell |A [-+]|Chase singles|Steady climb)/) || pick(/retail —|release premium/) ||
        (chase < 30 && chaseSrc === "set" ? pick(/Chase score under/) : null) || reasons[1] || reasons[0];

      out.push({
        ...p, type, set, release, ageMonths, chaseInfo, chaseSrc, headline, retail, retailSrc, mult, stats: st, phase, target, targetWhy,
        value, lifecycle, format, momentum, chase, score, quality, signal, confidence, checks, flags, reasons,
        gap: target != null ? (price / target - 1) * 100 : null,
      });
    }

    // Comparable-set benchmark: what 4-6 year old sets of the same chase tier & type trade at today.
    for (const a of out) {
      if (a.chaseSrc !== "set" || a.ageMonths == null || a.ageMonths >= 42) continue;
      const peers = out.filter((b) => b.type === a.type && b.chaseSrc === "set" && b.retailSrc !== "none" && b.chaseInfo.tier === a.chaseInfo.tier && b.ageMonths != null && b.ageMonths >= 42 && b.ageMonths <= 78 && b.mult);
      if (peers.length >= 2) {
        const ms = peers.map((b) => b.mult).sort((x, y) => x - y);
        a.benchmark = { median: ms[Math.floor(ms.length / 2)], n: ms.length };
      }
    }
    return out;
  }

  function claudePrompt(a, meta) {
    const s = a.stats;
    const rel = a.release ? `released ${a.release}, ~${Math.round(a.ageMonths)} months ago` : "release date unknown to my tracker";
    const chase = a.chaseSrc === "set" || a.chaseSrc === "linked"
      ? (a.chaseInfo.iconic || []).slice(0, 4).map((c) => `${c.name} ${fmt$(c.price)}`).join("; ") || "none from my list"
      : "none tied to this product (it's in a catch-all TCGplayer group)";
    return [
      `I'm a sealed Pokémon TCG investor holding 4+ years. Act as a veteran sealed-product investor and give me a second opinion on this buy. Search the web for anything recent (reprint announcements, Pokémon Center restocks, set news) before answering. Check the release date and MSRP yourself — my tracker may have them wrong.`,
      ``,
      `Product: ${a.name} — TCGplayer group "${a.set.name}" (${rel})`,
      `Format: ${TYPE_LABEL[a.type] || a.type}`,
      `TCGplayer market price (${meta.priceDate}): ${fmt$(a.price)}${a.retail ? ` (${a.mult.toFixed(2)}× retail of ${fmt$(a.retail)}${a.retailSrc === "format" ? ", a standard format MSRP" : ""})` : " (no retail price on file)"}`,
      `Change: 30d ${fmtPct(s.ch30)}, 90d ${fmtPct(s.ch90)}, 1y ${fmtPct(s.ch365)}; 90-day low ${fmt$(s.low90)}; 1-year high ${fmt$(s.high365)} (${s.n} day${s.n === 1 ? "" : "s"} of history)`,
      `Top chase cards${a.chaseSrc === "linked" ? ` (from ${a.chaseInfo.linkedSet})` : ""}: ${chase}`,
      `Chase singles index 90d: ${fmtPct(a.chaseSrc === "set" ? a.set.singlesStats.ch90 : null)}`,
      `My tracker says: ${SIGNALS[a.signal].label}${a.target != null ? `, target buy ${fmt$(a.target)}` : ", no target yet"}, score ${a.score}/100 (${PHASES[a.phase].label}), ${CONFIDENCE[a.confidence].label.toLowerCase()}.`,
      `Data gaps: ${a.checks.filter((c) => !c.ok).map((c) => c.label).join("; ") || "none"}`,
      ``,
      `Questions: Is this a good entry for a 4+ year hold? Would you buy now, set a lower limit, or skip? What's the biggest risk (reprints, print volume, chase card decline)?`,
    ].join("\n");
  }

  global.Engine = { analyse, chaseScore, seriesStats, historyDays, claudePrompt, refineType, TYPE_LABEL, PHASES, SIGNALS, CONFIDENCE, MIN_HIST_DAYS, dayToDate, dateToDay, fmt$, fmtPct };
})(window);

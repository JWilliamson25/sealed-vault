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
 * Everything here is transparent heuristics, not financial advice.
 */
(function (global) {
  "use strict";

  const DAY = 86400000;
  const EPOCH = Date.UTC(2024, 0, 1);

  const TYPE_LABEL = {
    booster_box: "Booster Box", case: "Sealed Case", pc_etb: "Pokémon Center ETB", etb: "Elite Trainer Box",
    upc: "Ultra/Super Premium", booster_bundle: "Booster Bundle", premium_collection: "Collection",
    build_battle: "Build & Battle", blister3: "3-Pack Blister", sleeved: "Sleeved Pack", pack: "Booster Pack", tin: "Tin",
  };

  const PHASES = {
    hype:        { label: "Release hype",      lifecycle: 30, blurb: "Brand new — prices usually sag as print waves land." },
    trough:      { label: "Print-run trough",  lifecycle: 80, blurb: "Still printing; historically the cheapest window to accumulate." },
    transition:  { label: "Out-of-print climb", lifecycle: 90, blurb: "Supply is drying up — this is when sealed historically starts to climb." },
    established: { label: "Established",       lifecycle: 70, blurb: "Already appreciating; buy dips, not rips." },
    vintage:     { label: "Vintage-modern",    lifecycle: 55, blurb: "Mature; slower, steadier growth — only the strongest chase sets keep compounding." },
  };

  const SIGNALS = {
    strong_buy: { label: "Strong buy", rank: 0, icon: "▲▲" },
    buy:        { label: "Buy",        rank: 1, icon: "▲" },
    accumulate: { label: "Accumulate", rank: 2, icon: "◆" },
    wait:       { label: "Wait",       rank: 3, icon: "■" },
    overheated: { label: "Overheated", rank: 4, icon: "!" },
    falling:    { label: "Still falling", rank: 4, icon: "▼" },
    pass:       { label: "Pass",       rank: 5, icon: "–" },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lscale = (v, lo, hi) => (v <= 0 ? 0 : clamp((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1));
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dayToDate = (d) => new Date(EPOCH + d * DAY);
  const dateToDay = (iso) => Math.round((Date.parse(iso + "T00:00:00Z") - EPOCH) / DAY);

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
    if (!series || !series.length) return { n: 0 };
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
    if (ageMonths < 2) return "hype";
    if (ageMonths < 12) return "trough";
    if (ageMonths < 24) return "transition";
    if (ageMonths < 48) return "established";
    return "vintage";
  }

  const fmt$ = (v) => (v == null ? "—" : "$" + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)));
  const fmtPct = (v) => { if (v == null) return "—"; const r = Math.round(v); return r === 0 ? "0%" : (r > 0 ? "+" : "") + r + "%"; };

  /* ---------------------------------------------------------- engine ---- */
  /**
   * @param ctx {meta, history, settings:{chasePokemon, retailReference, retailOverrides, formatScore, risk}}
   * @returns array of analysed products
   */
  function analyse(ctx) {
    const { meta, history, settings } = ctx;
    const lastDay = history.lastDay ?? dateToDay(meta.priceDate);
    const nowMs = Date.parse(meta.priceDate + "T00:00:00Z");
    const riskMult = { conservative: 0.95, balanced: 1, aggressive: 1.05 }[settings.risk || "balanced"];

    const sets = {};
    for (const s of meta.sets) {
      const cs = chaseScore(s.topSingles, settings.chasePokemon);
      const idx = seriesStats(history.series["set:" + s.id], lastDay);
      const ageMonths = s.release ? (nowMs - Date.parse(s.release + "T00:00:00Z")) / DAY / 30.44 : 0;
      sets[s.id] = { ...s, chase: cs, singlesStats: idx, ageMonths, phase: phaseFor(ageMonths) };
    }

    const out = [];
    for (const p of meta.products) {
      const set = sets[p.groupId];
      if (!set) continue;
      const price = p.price;
      const st = seriesStats(history.series[String(p.id)], lastDay);
      const retail = settings.retailOverrides?.[p.id] ?? settings.retailReference?.[p.type] ?? null;
      const mult = retail ? price / retail : null;
      const chase = set.chase.score;
      const c01 = chase / 100;
      const phase = set.phase;
      const enoughHist = st.n >= 6 && st.spanDays >= 45;

      /* --- target buy price ------------------------------------------------ */
      let target, targetWhy;
      const lowOr = (v, f) => (v != null ? v : f);
      if (phase === "hype") {
        target = retail ? Math.min(retail * (1 + 0.1 * c01), lowOr(st.low30, Infinity)) : price * 0.8;
        targetWhy = retail ? "near retail — let the release premium bleed out" : "~20% under release pricing";
      } else if (phase === "trough") {
        const r = retail ? retail * (1 + 0.15 * c01) : null;
        const h = st.low90 != null ? st.low90 * 1.05 : null;
        target = r != null && h != null ? Math.min(Math.max(h, retail * 0.9), r) : r ?? h ?? price * 0.9;
        targetWhy = "retail-ish while it's still printing";
      } else if (phase === "transition") {
        target = enoughHist ? Math.min(st.ma90 * 0.97, st.low90 * 1.08) : price * 0.93;
        targetWhy = "just under the 90-day average — buy the dips while supply dries up";
      } else if (phase === "established") {
        target = enoughHist ? lowOr(st.ma180, st.ma90) * 0.93 : price * 0.92;
        targetWhy = "~7% under the 6-month average";
      } else {
        target = enoughHist ? lowOr(st.ma180, st.ma90) * 0.95 : price * 0.93;
        targetWhy = "~5% under the 6-month average";
      }
      target = Math.round(target * riskMult * 100) / 100;

      /* --- component scores (0-100) ---------------------------------------- */
      const ratio = price / target;
      let value = clamp(100 - ((ratio - 0.95) / 0.4) * 100, 0, 100);
      if (phase === "hype" && mult && mult > 1.4) value = Math.min(value, 20);

      const lifecycle = PHASES[phase].lifecycle;
      const format = (settings.formatScore?.[p.type] ?? 5) * 10;

      let momentum = 50;
      const flags = [];
      const ch30 = st.ch30, ch90 = st.ch90, ch365 = st.ch365;
      const idx90 = set.singlesStats.ch90;
      if (ch30 != null) {
        if (ch30 > 25) { momentum = 15; flags.push("spike"); }
        else if (ch30 > 15) momentum = 35;
        else if (ch30 < -10 && (phase === "hype" || phase === "trough")) {
          if (retail && price <= retail * 1.05) momentum = 60; else { momentum = 30; flags.push("falling"); }
        } else if (ch90 != null && ch90 < -8 && Math.abs(ch30) < 4) { momentum = 80; flags.push("bottoming"); }
        else if (ch365 != null && ch365 > 15 && ch30 < -5) { momentum = 85; flags.push("dip_in_uptrend"); }
        else if (ch90 != null && ch90 >= 5 && ch90 <= 25 && ch30 > -5 && ch30 < 10) { momentum = 70; flags.push("steady_up"); }
      }
      if (idx90 != null && ch90 != null) {
        if (idx90 > 15 && ch90 < 5) { momentum = Math.min(100, momentum + 15); flags.push("divergence"); }
        if (idx90 < -20) { momentum = Math.max(0, momentum - 15); flags.push("chase_falling"); }
      }

      const score = Math.round(0.3 * chase + 0.25 * value + 0.15 * lifecycle + 0.15 * momentum + 0.15 * format);
      const quality = Math.round((0.3 * chase + 0.15 * lifecycle + 0.15 * format) / 0.6);

      /* --- signal ------------------------------------------------------------ */
      let signal;
      if (quality < 40 || chase < 30) signal = "pass";
      else if (flags.includes("spike") && price > target) signal = "overheated";
      else if (flags.includes("falling")) signal = "falling";
      else if (price <= target && score >= 68) signal = "strong_buy";
      else if (price <= target * 1.05 && score >= 55) signal = "buy";
      else if (price <= target * 1.12 && quality >= 60 && chase >= 50) signal = "accumulate";
      else signal = "wait";

      const confidence = !enoughHist ? "low" : st.spanDays > 365 && st.n > 40 ? "high" : "medium";

      /* --- reasons, veteran voice -------------------------------------------- */
      const reasons = [];
      const topIconic = set.chase.iconic.slice(0, 2).map((c) => `${c.name} (${fmt$(c.price)})`).join(" and ");
      if (set.chase.tier === "Elite" || set.chase.tier === "Strong")
        reasons.push(`${set.chase.tier} chase: ${topIconic || "deep chase list"} — the kind of cards that keep people ripping this set for years.`);
      else if (set.chase.iconic.length)
        reasons.push(`${set.chase.tier} chase: ${topIconic}. Not enough to carry the set on its own.`);
      else reasons.push("No headline chase from your list — long-term demand will be weaker.");
      if (chase < 30) reasons.push("Chase score under 30 — not a set I'd park money in for 4+ years.");
      reasons.push(`${PHASES[phase].label} (${Math.max(0, set.ageMonths).toFixed(0)} mo old): ${PHASES[phase].blurb}`);
      if (mult != null) {
        const m = mult.toFixed(2) + "× retail";
        if (mult <= 1.05) reasons.push(`At ${m} — buying near retail on a chase set is the cleanest long-term entry there is.`);
        else if (phase === "hype" && mult > 1.3) reasons.push(`At ${m} on a brand-new set — you're paying the release premium.`);
        else reasons.push(`Trading at ${m}.`);
      }
      if (flags.includes("spike")) reasons.push(`Up ${fmtPct(ch30)} in 30 days. Spikes like this usually retrace — set an alert at ${fmt$(target)} and be patient.`);
      if (flags.includes("falling")) reasons.push(`Down ${fmtPct(ch30)} in 30 days while still in print — let it flatten before buying.`);
      if (flags.includes("bottoming")) reasons.push(`Fell ${fmtPct(ch90)} over 90 days but has flattened this month — looks like it's finding a floor.`);
      if (flags.includes("dip_in_uptrend")) reasons.push(`A ${fmtPct(ch30)} pullback inside a ${fmtPct(ch365)} yearly uptrend — dips like this are where you add.`);
      if (flags.includes("steady_up")) reasons.push(`Steady climb (${fmtPct(ch90)} over 90 days) without a blow-off — healthy.`);
      if (flags.includes("divergence")) reasons.push(`Chase singles are up ${fmtPct(idx90)} over 90 days but this is flat — sealed tends to catch up to its singles.`);
      if (flags.includes("chase_falling")) reasons.push(`Chase singles are down ${fmtPct(idx90)} over 90 days — demand for the set is cooling.`);
      if (p.type === "pack" || p.type === "sleeved" || p.type === "tin") reasons.push("Loose packs and tins are the weakest long-term format (weighing risk, low premium).");
      if (p.type === "booster_box" || p.type === "case") reasons.push("Booster boxes are the most liquid long-term sealed format.");
      if (p.presale) reasons.push("Still in presale — no real market yet.");
      if (confidence === "low") reasons.push("Thin price history so far — treat this call as provisional.");

      const pick = (re) => reasons.find((x) => re.test(x));
      const headline = pick(/^(Up |Down |Fell |A [-+]|Chase singles|Steady climb)/) || pick(/retail —|release premium/) ||
        (chase < 30 ? pick(/Chase score under/) : null) || reasons[1] || reasons[0];

      out.push({
        ...p, set, headline, retail, mult, stats: st, phase, target, targetWhy, value, lifecycle, format, momentum,
        chase, score, quality, signal, confidence, flags, reasons,
        gap: (price / target - 1) * 100,
      });
    }

    // Comparable-set benchmark: what 4-6 year old sets of the same chase tier & type trade at today.
    for (const a of out) {
      const peers = out.filter((b) => b.type === a.type && b.set.chase.tier === a.set.chase.tier && b.set.ageMonths >= 42 && b.set.ageMonths <= 78 && b.mult);
      if (peers.length >= 2 && a.set.ageMonths < 42) {
        const ms = peers.map((b) => b.mult).sort((x, y) => x - y);
        a.benchmark = { median: ms[Math.floor(ms.length / 2)], n: ms.length };
      }
    }
    return out;
  }

  function claudePrompt(a, meta) {
    const s = a.stats;
    return [
      `I'm a sealed Pokémon TCG investor holding 4+ years. Act as a veteran sealed-product investor and give me a second opinion on this buy. Search the web for anything recent (reprint announcements, Pokémon Center restocks, set news) before answering.`,
      ``,
      `Product: ${a.name} — ${a.set.name} (released ${a.set.release}, ~${Math.round(a.set.ageMonths)} months ago)`,
      `Format: ${TYPE_LABEL[a.type] || a.type}`,
      `TCGplayer market price (${meta.priceDate}): ${fmt$(a.price)}${a.retail ? ` (${a.mult.toFixed(2)}× retail of ${fmt$(a.retail)})` : ""}`,
      `Change: 30d ${fmtPct(s.ch30)}, 90d ${fmtPct(s.ch90)}, 1y ${fmtPct(s.ch365)}; 90-day low ${fmt$(s.low90)}; 1-year high ${fmt$(s.high365)}`,
      `Top chase cards: ${a.set.chase.iconic.slice(0, 4).map((c) => `${c.name} ${fmt$(c.price)}`).join("; ") || "none from my list"}`,
      `Chase singles index 90d: ${fmtPct(a.set.singlesStats.ch90)}`,
      `My tracker says: ${SIGNALS[a.signal].label}, target buy ${fmt$(a.target)}, score ${a.score}/100 (${a.phase} phase).`,
      ``,
      `Questions: Is this a good entry for a 4+ year hold? Would you buy now, set a lower limit, or skip? What's the biggest risk (reprints, print volume, chase card decline)?`,
    ].join("\n");
  }

  global.Engine = { analyse, chaseScore, seriesStats, claudePrompt, TYPE_LABEL, PHASES, SIGNALS, dayToDate, dateToDay, fmt$, fmtPct };
})(window);

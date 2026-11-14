/* Sealed Vault — singles engine.
 *
 * Scores raw singles of popular Pokémon for a 4+ year hold the way an experienced buyer does: a
 * checklist of seven things, each scored 0–100, then hard rules that stop a guess from becoming a buy.
 *
 *  1. Demand (25%)      — the Pokémon (your chase weights) × the card type. SIRs and alt arts compound;
 *                         plain gallery holos, promos and reprints mostly ride the Pokémon.
 *  2. Value (15%)       — price vs like-for-like cards: same card type and era. Gallery holos (TG/GG/RC)
 *                         are compared with gallery holos, never with illustration rares or alt arts.
 *                         Setmates (the same card type in the same set, any Pokémon) show how much of
 *                         the price is the Pokémon rather than the card.
 *  3. Price position (20%) — where today's price sits in the longest range known: daily history plus
 *                         researched 2-year lows/highs (data/card_facts.json). A card that has run up
 *                         from its low is not a discount when it gives some back.
 *  4. Momentum & market (15%) — spikes, slides, flattened pullbacks, and the card against the whole
 *                         singles market and against its own Pokémon (a Pokémon in a hype cycle).
 *  5. Supply (10%)      — where the set is in its print life, print status, reprints of the same art,
 *                         promos and mass-distributed cards.
 *  6. Grading (5%)      — PSA 10 and PSA 9 against raw, gem rate. Decides raw vs slab.
 *  7. Liquidity & costs (10%) — budget fit, listing spread, real sold prices vs TCGplayer market, and
 *                         what it must gain just to cover selling fees.
 *
 * Hard rules: a buy-under price is never derived from today's price. A card with under a year of price
 * history and no researched long-run low is never better than "Check first". Strong buy needs the long
 * range, like-for-like peers, and no Pokémon hype cycle. Heuristics, not financial advice.
 */
(function (global) {
  "use strict";
  const E = global.Engine;
  const DAY = 86400000;

  const TIERS = {
    sir:       { label: "Special Illustration Rare",    demand: 100 },
    alt:       { label: "Alternate Art",                demand: 100 },
    ir:        { label: "Illustration Rare",            demand: 82 },
    gallery_v: { label: "Gallery V / VMAX / full art",  demand: 72 },
    vintage:   { label: "Vintage holo & rare",          demand: 72 },
    shiny:     { label: "Shiny",                        demand: 62 },
    rainbow:   { label: "Rainbow Rare",                 demand: 60 },
    gallery:   { label: "Gallery holo (TG / GG / RC)",  demand: 56 },
    secret:    { label: "Secret Rare",                  demand: 55 },
    ultra:     { label: "Ultra Rare / Full Art",        demand: 55 },
    gold:      { label: "Gold / Hyper Rare",            demand: 50 },
    other:     { label: "Special rare",                 demand: 48 },
    promo:     { label: "Promo",                        demand: 42 },
    base:      { label: "Regular rare",                 demand: 38 },
    classic:   { label: "Classic Collection reprint",   demand: 30 },
  };
  // Lower-case names for use mid-sentence (keeps TG / GG / RC and V / VMAX capitalised).
  const NOUN = { sir: "special illustration rare", alt: "alternate art", ir: "illustration rare", gallery_v: "gallery V / VMAX / full art", vintage: "vintage holo",
    shiny: "shiny", rainbow: "rainbow rare", gallery: "gallery holo (TG / GG / RC)", secret: "secret rare", ultra: "ultra rare / full art", gold: "gold / hyper rare",
    other: "special rare", promo: "promo", base: "regular rare", classic: "Classic Collection reprint" };
  const PILLARS = {
    demand:    { label: "Demand", w: 0.25, what: "the Pokémon × the card type" },
    value:     { label: "Value vs like-for-like cards", w: 0.15, what: "same card type and era" },
    position:  { label: "Price position", w: 0.20, what: "where it sits in its long-run range" },
    momentum:  { label: "Momentum & market", w: 0.15, what: "trend, the whole market, its Pokémon" },
    supply:    { label: "Supply & reprints", w: 0.10, what: "print life, reprints, distribution" },
    grading:   { label: "Grading", w: 0.05, what: "PSA 10 / PSA 9 vs raw, gem rate" },
    liquidity: { label: "Liquidity & costs", w: 0.10, what: "budget, sold prices, fees" },
  };
  const PROMO_GROUP_RE = /promo|miscellaneous|league|championship|prize pack|mcdonald|burger king|jumbo/i;
  const ERAS = { sv: "Scarlet & Violet / Mega era", swsh: "Sword & Shield era", smxy: "Sun & Moon / XY era", classic: "2003–2013", wotc: "WotC era", unknown: "era unknown" };
  const FACTS_FRESH = 120, FACTS_RANGE_OK = 365, SOLD_FRESH = 45;
  const SELL_FEE = 0.1325, SELL_FIXED = 1.5; // TCGplayer-style ~13% fees plus ~$1.50 per order

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const median = (a) => { if (!a.length) return null; const v = a.slice().sort((x, y) => x - y); const n = v.length; return n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2; };
  const monthYear = (day) => E.dayToDate(day).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  const isoMonth = (iso) => monthYear(E.dateToDay(iso));
  const pctOf = (a, b) => Math.round((a / b - 1) * 100);

  /** Data synced before the gallery split still says "ir" for TG/GG/RC cards: sort them here too. */
  function refineTier(c, srarity) {
    const num = String(c.number || "").toUpperCase();
    if (c.tier !== "ir" || !/^(TG|GG|RC)\d/.test(num)) return c.tier;
    const r = String(c.rarity || "").toLowerCase(), sr = String(srarity || "").toLowerCase(), n = c.name || "";
    if (/secret|gold|hyper/.test(r + " " + sr) || /\((secret|gold)\)/i.test(n)) return "gold";
    if (/\b(V|VMAX|VSTAR|GX|EX|ex)\b|full art/.test(n) || /holo (v|vmax|vstar|ex|gx)\b|rare ultra/.test(sr)) return "gallery_v";
    return "gallery";
  }

  /** PSA 10 price that ignores a sudden jump that then freezes (one odd sale or listing stuck in the average). */
  function robustPsa(series, lastDay, saved) {
    const pts = (series || []).slice().sort((a, b) => a[0] - b[0]);
    if (!pts.length) return { price: saved ?? null };
    const v = pts[pts.length - 1][1];
    let i = pts.length - 1;
    while (i > 0 && Math.abs(pts[i - 1][1] / v - 1) <= 0.03) i--;
    const start = pts[i][0];
    const before = pts.filter(([d]) => d < start && d >= start - 90).map((p) => p[1]);
    const mBefore = median(before);
    if (before.length >= 5 && mBefore && v > 2 * mBefore) return { price: mBefore, jump: { to: v, since: start, from: mBefore } };
    let recent = pts.filter(([d]) => d >= lastDay - 60).map((p) => p[1]);
    if (!recent.length) recent = [v];
    const q1 = recent.slice().sort((a, b) => a - b)[Math.floor(recent.length / 4)];
    const kept = recent.filter((x) => x <= q1 * 2);
    const mixed = kept.length < recent.length;
    return { price: median(kept), ...(mixed ? { jump: { to: Math.max(...recent), from: median(kept), since: pts.find(([, x]) => x > q1 * 2)?.[0] ?? start, mixed: true } } : {}) };
  }
  const geo = (pairs) => { let s = 0, w = 0; for (const [v, n] of pairs) if (v > 0 && n > 0) { s += Math.log(v) * n; w += n; } return w ? Math.exp(s / w) : null; };

  /** Fair-value table from the sync's peer medians. Peers are tier-pure: a gallery holo is never
   *  compared with illustration rares. Old data that still lumps gallery cards into "ir" is skipped. */
  function fairModel(peers, legacy) {
    const byTE = {}, byMon = {};
    for (const [k, v] of Object.entries(peers || {})) {
      const [mon, tier, era] = k.split("|");
      if (legacy && tier === "ir" && era !== "sv") continue; // pre-split groups mixed TG/GG/RC into "ir"
      (byTE[`${tier}|${era}`] ||= []).push([v.median, v.n, mon]);
    }
    const te = {};
    for (const [k, rows] of Object.entries(byTE)) te[k] = { median: geo(rows.map(([m, n]) => [m, n])), n: rows.reduce((a, r) => a + r[1], 0) };
    for (const [k, v] of Object.entries(peers || {})) {
      const [mon, tier, era] = k.split("|");
      const base = te[`${tier}|${era}`];
      if (!base || !base.median || v.n < 2) continue;
      (byMon[mon] ||= []).push([v.median / base.median, v.n]);
    }
    const monFactor = {};
    for (const [m, rows] of Object.entries(byMon)) monFactor[m] = clamp(geo(rows) || 1, 0.4, 4);
    return {
      fair(card) {
        if (legacy && (card.tier === "gallery" || card.tier === "gallery_v" || (card.tier === "ir" && card.era !== "sv"))) return null;
        const own = peers?.[`${card.pokemon}|${card.tier}|${card.era}`];
        if (own && own.n >= 5) return { kind: "own", value: own.median, n: own.n, how: `the median of ${own.n} ${card.pokemon} ${NOUN[card.tier]} cards from the ${ERAS[card.era]}` };
        const base = te[`${card.tier}|${card.era}`];
        if (base && base.n >= 6) {
          const f = monFactor[card.pokemon] ?? 1;
          return { kind: "borrowed", value: base.median * f, n: base.n, how: `${base.n} ${NOUN[card.tier]} cards of your chase Pokémon from the ${ERAS[card.era]}, scaled for how ${card.pokemon} usually sells` };
        }
        return null;
      },
    };
  }

  /** % change of a series over `days`, using the last point at or before that day (within 21 days). */
  function changeOver(series, lastDay, days) {
    if (!series || series.length < 2) return null;
    const pts = series.slice().sort((a, b) => a[0] - b[0]);
    const cur = pts[pts.length - 1][1];
    let v = null;
    for (const [d, p] of pts) { if (d <= lastDay - days) v = d >= lastDay - days - 21 ? p : null; else break; }
    return v ? (cur / v - 1) * 100 : null;
  }

  function analyse(ctx) {
    const { singles, history, meta, sealedHistory, settings } = ctx;
    const facts = ctx.facts?.cards || {};
    const lastDay = history.lastDay ?? E.dateToDay(singles.priceDate);
    const nowMs = Date.parse(singles.priceDate + "T00:00:00Z");
    const ageDays = (iso) => (iso ? Math.round((nowMs - Date.parse(iso + "T00:00:00Z")) / DAY) : null);
    const weights = Object.fromEntries(settings.chasePokemon.map((c) => [c.name.toLowerCase(), c.weight ?? 1]));
    const legacy = !singles.setTiers; // synced before the gallery split
    const srar = singles.srarity || {};
    const cards = singles.cards.map((c) => ({ ...c, tier: TIERS[refineTier(c, srar[c.id])] ? refineTier(c, srar[c.id]) : "other" }));
    const model = fairModel(singles.peers, legacy);
    const psa = singles.psa10 || {}, psa9 = singles.psa9 || {};
    const b = settings.singles;
    const setOv = settings.setOverrides || {};

    const setSealed90 = {};
    for (const s of meta?.sets || []) {
      const st = E.seriesStats(sealedHistory?.series?.["set:" + s.id], sealedHistory?.lastDay);
      if (st.ch90 != null) setSealed90[s.id] = st.ch90;
    }

    // Market and per-Pokémon indexes: the median card's change. Tells a card falling with the whole
    // market from one falling alone, and catches a Pokémon in a hype cycle.
    const ch = {};
    for (const c of cards) { const s = history.series[String(c.id)]; ch[c.id] = { d90: changeOver(s, lastDay, 90), d180: changeOver(s, lastDay, 180) }; }
    const idx = (list) => {
      const a90 = list.map((c) => ch[c.id].d90).filter((v) => v != null), a180 = list.map((c) => ch[c.id].d180).filter((v) => v != null);
      return { d90: a90.length >= 3 ? median(a90) : null, d180: a180.length >= 3 ? median(a180) : null, n: Math.max(a90.length, a180.length) };
    };
    const mkt = idx(cards.filter((c) => !c.release || ageDays(c.release) > 180)); // new-set slides would swamp it
    const byMon = {};
    for (const c of cards) (byMon[c.pokemon] ||= []).push(c);
    const monIdx = Object.fromEntries(Object.entries(byMon).map(([m, l]) => [m, idx(l.filter((c) => !c.release || ageDays(c.release) > 180))]));

    const bySetMon = {};
    for (const c of cards) (bySetMon[`${c.setId}|${c.pokemon}`] ||= []).push(c);

    const out = [];
    for (const c of cards) {
      const price = c.price;
      const F = facts[c.id] || facts[String(c.id)] || null;
      const fAge = ageDays(F?.verified);
      const fFresh = fAge != null && fAge <= FACTS_FRESH;
      const soldAge = ageDays(F?.sold?.date);
      const soldFresh = !!F?.sold && soldAge != null && soldAge <= SOLD_FRESH;
      const soldMid = F?.sold ? F.sold.median ?? (F.sold.low + F.sold.high) / 2 : null;

      const st = E.seriesStats(history.series[String(c.id)], lastDay);
      const g = E.seriesStats(history.series["g:" + c.id], lastDay);
      const psaR = robustPsa(history.series["g:" + c.id], lastDay, psa[c.id]?.price);
      const psaF = F?.psa10Sold && ageDays(F.psa10Sold.date) <= 60 ? F.psa10Sold : null;
      const psaConflict = psaF && psaR.price && (psaR.price < psaF.low * 0.85 || psaR.price > psaF.high * 1.15);
      const psaNow = psaF ? (psaF.median ?? (psaF.low + psaF.high) / 2) : psaR.price;
      const psa9Now = F?.psa9Sold?.price ?? psa9[c.id]?.price ?? null;
      const groupDate = PROMO_GROUP_RE.test(c.setName || c.group || "");
      const ageMonths = c.release && !groupDate ? (nowMs - Date.parse(c.release + "T00:00:00Z")) / DAY / 30.44 : null;
      const phase = ageMonths == null ? "unknown" : ageMonths < 2 ? "hype" : ageMonths < 12 ? "trough" : ageMonths < 24 ? "transition" : ageMonths < 48 ? "established" : "vintage";
      const enoughHist = st.n >= 6 && st.spanDays >= E.MIN_HIST_DAYS && st.staleDays <= 21 && st.ma90 != null && st.low90 != null;
      const fair = model.fair(c);
      const ratio = fair ? fair.value / price : null; // >1 = cheaper than similar cards
      const peerOk = fair && fair.n >= 8;
      const mate = singles.setTiers?.[`${c.group || c.setName}|${c.tier}`] || null;
      const mates = mate && mate.n >= 3 ? mate : null;
      const matePrem = mates ? price / mates.median : null;

      /* --- the long-run range: history plus researched lows/highs --- */
      const ser = (history.series[String(c.id)] || []).filter(([d]) => d >= lastDay - 730).slice().sort((a, b2) => a[0] - b2[0]);
      const histStart = ser.length ? ser[0][0] : null;
      const vals = ser.map((p) => p[1]);
      let lo = vals.length ? Math.min(...vals) : null, hi = vals.length ? Math.max(...vals) : null;
      let loDay = ser.find((p) => p[1] === lo)?.[0] ?? null, hiDay = ser.find((p) => p[1] === hi)?.[0] ?? null;
      let loSrc = "history", hiSrc = "history";
      const rangeFactsOk = F && fAge != null && fAge <= FACTS_RANGE_OK;
      if (rangeFactsOk && F.longLow && ageDays(F.longLow.date) <= 730 && (lo == null || F.longLow.price < lo)) { lo = F.longLow.price; loDay = E.dateToDay(F.longLow.date); loSrc = "facts"; }
      if (rangeFactsOk && F.longHigh && ageDays(F.longHigh.date) <= 730 && (hi == null || F.longHigh.price > hi)) { hi = F.longHigh.price; hiDay = E.dateToDay(F.longHigh.date); hiSrc = "facts"; }
      const histYear = histStart != null && lastDay - histStart >= 330;
      const longKnown = histYear || !!(rangeFactsOk && F.longLow);
      const shortHist = !histYear;
      // A run-up: the card at least 1.6x'd from its low to a later high inside two years.
      const runup = lo != null && hi != null && hi / lo >= 1.6 && hiDay != null && loDay != null && hiDay > loDay;
      const runAnchor = runup ? Math.min(lo * 1.3, lo + 0.35 * (hi - lo)) : null;
      const offPeak = runup && price < hi * 0.92;

      /* --- buy-under price: the lowest of every anchor that applies, never today's price --- */
      const anchors = [];
      if (enoughHist) anchors.push([Math.min(st.ma90 * 0.95, st.low90 * 1.05, median(vals.slice(-180)) * 0.95), "below its 90-day average and typical price, close to its 90-day low"]);
      if (runup) anchors.push([runAnchor, `no more than 30% over where it sat before its run-up (${E.fmt$(lo)} in ${monthYear(loDay)}, peak ${E.fmt$(hi)} in ${monthYear(hiDay)}), and no more than a third of the way back up`]);
      const topTier = TIERS[c.tier].demand >= 82;
      const peerCap = peerOk ? fair.value * (topTier ? 1 : 0.92) : null;
      if (peerCap != null) anchors.push([peerCap, topTier ? `no more than similar cards' median (${E.fmt$(fair.value)})` : `about 8% under similar cards' median (${E.fmt$(fair.value)}) — in line with its peers is a fair price, not a discount`]);
      if (soldFresh && soldMid) anchors.push([soldMid * 0.97, `a little under what copies actually sell for (recent solds ${E.fmt$(F.sold.low)}–${E.fmt$(F.sold.high)})`]);
      let target = null, targetWhy, peerCapped = false;
      if (anchors.length && (enoughHist || runup || soldFresh)) {
        const best = anchors.reduce((a, x) => (x[0] < a[0] ? x : a));
        [target, targetWhy] = best;
        peerCapped = best[0] === peerCap;
      } else targetWhy = `it needs ${E.MIN_HIST_DAYS}+ days of price history, or researched prices in data/card_facts.json`;
      const mi = monIdx[c.pokemon] || {};
      const monHot = mi.d180 != null && mi.d180 >= 30 && (mkt.d180 == null || mi.d180 - mkt.d180 >= 20);
      const spot = (singles.spotlight?.[c.pokemon] || []).filter((x) => x.name !== c.name && ageDays(x.release) <= 300 && x.price >= 100);
      if (target != null && phase === "hype") { target *= 0.85; targetWhy += ", minus 15% because new-set singles usually keep falling"; }
      if (target != null && monHot) { target *= 0.93; targetWhy += `, minus 7% while ${c.pokemon} is in a hype cycle`; }
      if (target != null) target = Math.round(Math.min(target, b.budgetMax) * { conservative: 0.95, balanced: 1, aggressive: 1.05 }[settings.risk || "balanced"] * 100) / 100;

      /* --- pillar 1: demand --- */
      const monW = weights[c.pokemon.toLowerCase()] ?? 0.7;
      const demand = Math.round(0.55 * TIERS[c.tier].demand + 0.45 * monW * 100);

      /* --- pillar 2: value vs like-for-like --- */
      let value = ratio == null ? 50 : Math.round(clamp((Math.log(ratio) + 0.25) / 0.75, 0, 1) * 100);
      if (fair?.kind === "borrowed") value = Math.round(50 + (value - 50) / 2);

      /* --- pillar 3: price position in its long-run range --- */
      let position = 50;
      if (lo != null && hi != null && hi > lo * 1.05) position = Math.round(100 - clamp((price - lo) / (hi - lo), 0, 1) * 80);
      if (runup && price > runAnchor) position = Math.min(position, 40);
      if (!longKnown) position = Math.round(45 + (position - 45) * 0.4); // six months can't show where it really sits

      /* --- pillar 4: momentum & market --- */
      const flags = [];
      let momentum = 50;
      const high = st.high365 ?? st.allHigh;
      const dd = high ? 1 - price / high : null;
      if (st.ch30 != null) {
        if (st.ch30 > 25) { momentum = 12; flags.push("spike"); }
        else if (st.ch30 < -15) { momentum = 22; flags.push("falling"); }
        else if (st.ch90 != null && st.ch90 <= -12 && st.ch30 <= -4 && st.low90 != null && price <= st.low90 * 1.03) { momentum = 25; flags.push("falling", "slow_slide"); }
        else if (dd != null && dd >= 0.2 && st.ch30 > -5 && !longKnown) { momentum = 45; flags.push("unwind"); }
        else if (dd != null && dd >= 0.25 && st.ch30 > -5 && !(runup && price > runAnchor)) { momentum = 82; flags.push("pullback"); }
        else if (st.ch90 != null && st.ch90 >= 5 && st.ch90 <= 30 && st.ch30 < 12) { momentum = 66; flags.push("steady"); }
      }
      const rs = st.ch90 != null && mkt.d90 != null ? st.ch90 - mkt.d90 : null;
      if (rs != null && rs <= -15 && st.ch30 != null && st.ch30 > -3 && !flags.includes("falling")) { momentum = Math.min(100, momentum + 8); flags.push("lagging_market"); }
      const lag = setSealed90[c.setId] != null && st.ch90 != null ? st.ch90 - setSealed90[c.setId] : null;
      if (lag != null && lag < -15 && !flags.includes("falling")) { momentum = Math.min(100, momentum + 6); flags.push("lagging_set"); }
      if (monHot) { momentum = Math.max(0, momentum - 10); flags.push("pokemon_hype"); }

      /* --- pillar 5: supply & reprints --- */
      const so = setOv[c.setName] || setOv[c.group] || setOv[c.setId] || setOv[String(c.setId)] || {};
      const printStatus = so.printStatus || null;
      let supply = { hype: 25, trough: 80, transition: 82, established: 68, vintage: 62, unknown: 50 }[phase];
      if (printStatus === "in_print" && ageMonths != null && ageMonths >= 12) supply = 60;
      if (printStatus === "out_of_print" || printStatus === "likely_out_of_print") supply = Math.min(100, supply + 8);
      if (c.tier === "classic") supply -= 25;
      if (c.tier === "promo") supply -= 15;
      const reprint = fFresh ? F.reprint || null : null;
      if (reprint === "none") supply += 5;
      if (reprint === "same_art") supply -= 25;
      if (reprint === "risk") supply -= 15;
      if (reprint === "announced") supply -= 40;
      supply = clamp(Math.round(supply), 0, 100);

      /* --- pillar 6: grading --- */
      const m = psaNow ? psaNow / price : null;
      const pop = fFresh && F.pop?.psa10 && F.pop?.total ? F.pop : null;
      const gem = pop ? pop.psa10 / pop.total : null;
      let grading = m == null ? 50 : m >= 12 ? 45 : m >= 4 ? 62 : m <= 2.5 && psaNow <= b.budgetMax ? 80 : 58;
      if (gem != null && gem < 0.1) grading -= 5;
      if (gem != null && gem > 0.5 && m != null && m >= 6) grading -= 10;
      if (psa9Now && psa9Now <= price * 1.25) grading += 5;
      grading = clamp(grading, 0, 100);

      /* --- pillar 7: liquidity & costs --- */
      const budgetFit = price <= b.sweetSpotMax ? 100 : price <= b.budgetMax ? 65 : 0;
      const breakeven = (price + SELL_FIXED) / (1 - SELL_FEE);
      const feeDrag = breakeven / price - 1;
      const lowGap = c.low && c.low > 0 ? c.low / price : null;
      let liquidity = Math.round(0.75 * budgetFit + 25 * (price >= 30 ? 1 : 0.5));
      if (soldFresh && soldMid < price * 0.93) liquidity -= 10; // market overstates real sales
      liquidity = clamp(liquidity, 0, 100);

      const pillars = { demand, value, position, momentum, supply, grading, liquidity };
      const score = Math.round(Object.entries(PILLARS).reduce((s, [k, p]) => s + p.w * pillars[k], 0));

      /* --- confidence --- */
      const confidence = longKnown && enoughHist && fair && (soldFresh || st.spanDays >= 180) ? "high" : enoughHist || longKnown ? "medium" : "low";

      /* --- signal and hard rules --- */
      let signal;
      const buyish = () => ["strong_buy", "buy", "accumulate", "verify"].includes(signal);
      const guard = [];
      if (target == null) signal = "no_call";
      else if (demand < 45) signal = "pass";
      else if (flags.includes("spike") && price > target) signal = "overheated";
      else if (flags.includes("falling")) signal = "falling";
      else if (price <= target && score >= 68 && confidence !== "low") signal = "strong_buy";
      else if (price <= target && score >= 55) signal = "buy";
      else if (price <= target * 1.08 && score >= 60) signal = "accumulate";
      else signal = "wait";
      if (price > b.budgetMax && buyish()) signal = "wait";
      if (st.ch30 != null && buyish()) {
        if (st.ch30 <= -10) { signal = "falling"; flags.push("still_dropping"); }
        else if (st.ch30 <= -5 && signal === "strong_buy") signal = "buy";
      }
      const drifting = st.ch30 != null && st.ch90 != null && st.ch30 <= -3 && st.ch90 <= -5;
      if (signal === "accumulate" && drifting) { signal = "wait"; flags.push("drifting"); guard.push(`Still drifting down (${E.fmtPct(st.ch30)} this month, ${E.fmtPct(st.ch90)} over 90 days), so there's no reason to pay above ${E.fmt$(target)} — set a limit there instead.`); }
      if (reprint === "announced" && buyish()) { signal = "wait"; guard.push("A reprint has been announced — wait to see what it does to supply."); }
      // Strong buy needs the whole checklist: the long-run range, like-for-like peers, no hype cycle.
      if (signal === "strong_buy") {
        const why = [];
        if (!longKnown) why.push("the long-run price range isn't known");
        if (!peerOk) why.push("there aren't enough like-for-like cards to compare with");
        if (monHot) why.push(`${c.pokemon} is in a hype cycle`);
        if (drifting) why.push("it's still drifting down");
        if (psaConflict) why.push("PSA 10 sources disagree");
        if (why.length) { signal = "buy"; guard.push(`Capped at Buy: ${why.join(", ")}.`); }
      }
      // The rule that stops a six-month history from calling a run-up's give-back a discount.
      if (buyish() && !longKnown) {
        signal = "verify";
        guard.push(`Looks like a buy on ${Math.round(st.spanDays / 30.44)} months of prices, but where it traded before that isn't known. Look up its 2-year low and high and recent sold prices (Ask Claude), then record them in data/card_facts.json — the call updates on its own.`);
      }
      if (buyish() && fair?.kind === "borrowed" && ratio >= 2 && !soldFresh && signal !== "verify") {
        signal = "verify";
        guard.push("Far under a borrowed comparison — that usually means the comparison group is off. Confirm with recent sold listings.");
      }

      /* --- reasons, most important first --- */
      const R = [];
      const tl = TIERS[c.tier].label, tn = NOUN[c.tier];
      if (ratio != null) {
        if (ratio >= 2) R.push(`Less than half ${fair.how} (${E.fmt$(fair.value)}) — a gap this big usually means the group holds stronger cards; look closer.`);
        else if (ratio >= 1.3) R.push(`About ${Math.round((1 - 1 / ratio) * 100)}% cheaper than ${fair.how} (${E.fmt$(fair.value)}).`);
        else if (ratio <= 0.75) R.push(`Already ${Math.round((1 / ratio - 1) * 100)}% above ${fair.how} (${E.fmt$(fair.value)}) — you're paying up for this one.`);
        else R.push(`In line with ${fair.how} (${E.fmt$(fair.value)}).`);
      } else R.push(legacy && (c.tier === "gallery" || c.tier === "gallery_v") ? `No like-for-like comparison yet: ${tn} cards get their own peer group from the next daily sync.` : `Too few ${tn} cards from the ${ERAS[c.era]} to compare its price with.`);
      if (mates) {
        const others = mates.n - 1;
        if (matePrem >= 4) R.push(`Its setmates — the ${others} other ${tn} cards in ${c.group || c.setName} — sell for a median ${E.fmt$(mates.median)}. At ${matePrem.toFixed(0)}× that, this price is about ${c.pokemon}, not the card type: it rises and falls with ${c.pokemon}'s popularity.`);
        else if (matePrem >= 1.5) R.push(`${matePrem.toFixed(1)}× the median of its ${others} setmates (${E.fmt$(mates.median)}, same card type in ${c.group || c.setName}).`);
        else R.push(`Priced close to its setmates (${E.fmt$(mates.median)} median, same card type in ${c.group || c.setName}) — the Pokémon isn't adding much premium.`);
      }
      R.push(`${tl} of ${c.pokemon}: ${demand >= 75 ? "the kind of card collectors keep chasing for years" : demand >= 60 ? "solid demand, though not a top-tier chase card type" : "demand rides mostly on the Pokémon — fine to collect, weaker as a long hold"}.`);
      if (runup) {
        const lsrc = loSrc === "facts" ? " (researched)" : "";
        R.push(price > runAnchor
          ? `Ran up from ${E.fmt$(lo)}${lsrc} in ${monthYear(loDay)} to ${E.fmt$(hi)} in ${monthYear(hiDay)} and is still ${pctOf(price, lo)}% above that low. ${offPeak ? "The drop from the peak is the run-up unwinding, not a discount." : "Buying near a run-up's peak is chasing."} Buy-under is capped near the pre-run-up level.`
          : `Ran up from ${E.fmt$(lo)}${lsrc} to ${E.fmt$(hi)} and has given most of it back — now within reach of its pre-run-up price.`);
      } else if (longKnown && lo != null && hi != null && hi > lo * 1.05) R.push(`Over its known range (${E.fmt$(lo)}–${E.fmt$(hi)}), today's price sits ${Math.round(clamp((price - lo) / (hi - lo), 0, 1) * 100)}% of the way up.`);
      if (flags.includes("unwind")) R.push(`Down ${Math.round(dd * 100)}% from ${E.fmt$(high)}, but its price history only starts ${monthYear(histStart)}, so that high may have been a run-up — the drop isn't necessarily a discount.`);
      if (flags.includes("pullback")) R.push(`Down ${Math.round(dd * 100)}% from its 1-year high (${E.fmt$(high)}) and flat this month — a pullback that's settling.`);
      if (flags.includes("spike")) R.push(`Up ${E.fmtPct(st.ch30)} in 30 days. Spikes usually give some back — wait for ${E.fmt$(target)}.`);
      if (flags.includes("still_dropping")) R.push(`At its buy-under price, but down ${Math.abs(Math.round(st.ch30))}% in the last 30 days — wait for it to flatten.`);
      if (flags.includes("slow_slide")) R.push(`Down ${Math.abs(Math.round(st.ch90))}% over 90 days and still making new lows (${E.fmtPct(st.ch30)} this month) — wait until it flattens for a few weeks.`);
      else if (flags.includes("falling")) R.push(`Down ${Math.abs(Math.round(st.ch30))}% in 30 days and still sliding — let it settle.`);
      if (flags.includes("steady")) R.push(`Steady climb (${E.fmtPct(st.ch90)} over 90 days) without a blow-off.`);
      if (rs != null && mkt.d90 != null) {
        if (flags.includes("lagging_market")) R.push(`Lagging the singles market (${E.fmtPct(st.ch90)} vs ${E.fmtPct(mkt.d90)} for the median tracked card over 90 days) and flattening.`);
        else if (st.ch90 <= -10 && Math.abs(rs) <= 6) R.push(`Falling with the whole market (median tracked card ${E.fmtPct(mkt.d90)} over 90 days), not on its own.`);
      }
      if (monHot) R.push(`${c.pokemon} is in a hype cycle: its cards are up a median ${E.fmtPct(mi.d180)} in 6 months vs ${E.fmtPct(mkt.d180)} for the market. Hype pulls future gains forward and often fades — targets are 7% lower and nothing is a Strong buy.`);
      if (spot.length) R.push(`${c.pokemon} has new chase cards out (${spot.slice(0, 2).map((x) => `${x.name.replace(/\s+-\s+.*$/, "")} ${E.fmt$(x.price)}, ${isoMonth(x.release)}`).join("; ")}). New cards draw attention to the Pokémon now and compete for the same collectors' money later.`);
      if (F?.hype && fFresh) R.push(`Researched: ${F.hype}.`);
      if (lag != null && flags.includes("lagging_set")) R.push(`Lagging its set: ${E.fmtPct(st.ch90)} over 90 days vs ${E.fmtPct(setSealed90[c.setId])} for the set's sealed product.`);
      if (phase !== "unknown") R.push(`${E.PHASES[phase].label} (${Math.max(0, ageMonths).toFixed(0)} mo): ${phase === "hype" ? "new-set singles usually fall for months as more packs get opened." : phase === "trough" ? "still being printed — singles usually bottom in this window." : phase === "transition" ? "printing has likely ended; good cards tend to recover from here." : "an older card; moves are slower and driven by demand, not supply."}${printStatus ? ` Set print status: ${printStatus.replace(/_/g, " ")}${so.verified ? ` (checked ${so.verified})` : ""}.` : ""}`);
      if (reprint === "none") R.push("Researched: no reprint of this card or its art.");
      else if (reprint === "same_art") R.push("Researched: this artwork has been reprinted elsewhere — the reprint caps demand for this version.");
      else if (reprint === "risk") R.push("Researched: credible reprint risk.");
      else if (c.tier === "classic") R.push("A Classic Collection reprint of an older card — collectors pay for the original, not the reprint.");
      if (c.tier === "promo") R.push(groupDate ? "Promo: many were mass-distributed (events, movie giveaways, box toppers, jumbo packs), so check how widely before treating it as scarce. Its listed date is the promo group's start, not this card's." : "Promo: many were mass-distributed, so check how widely before treating it as scarce.");
      // Grading
      if (psaConflict) R.push(`PSA 10 sources disagree: Scrydex ${E.fmt$(psaR.price)} vs recent sales ${E.fmt$(psaF.low)}–${E.fmt$(psaF.high)}. Using the sales.`);
      else if (psaR.jump?.mixed && !psaF) R.push(`Scrydex mixes two PSA 10 prices for this card (about ${E.fmt$(psaR.jump.from)} and ${E.fmt$(psaR.jump.to)}). Using ${E.fmt$(psaR.price)}; check recent sold listings.`);
      else if (psaR.jump && !psaF) R.push(`Scrydex's PSA 10 price jumped from about ${E.fmt$(psaR.jump.from)} to ${E.fmt$(psaR.jump.to)} and froze there — likely one odd sale. Using ${E.fmt$(psaR.price)}.`);
      if (psaNow) {
        if (psaNow > b.budgetMax) R.push(`PSA 10 runs about ${E.fmt$(psaNow)} (${m.toFixed(m >= 10 ? 0 : 1)}× raw) — over your ${E.fmt$(b.budgetMax)} max, so raw is the only way in. ${m >= 12 ? "A premium that steep tends to shrink as more copies get graded." : ""}`.trim());
        else if (m >= 12) R.push(`PSA 10 runs about ${E.fmt$(psaNow)}, ${m.toFixed(0)}× raw. A premium that steep tends to shrink as more copies get graded — raw is the better long hold.`);
        else if (m <= 2.5) R.push(`A PSA 10 is only ${m.toFixed(1)}× raw (${E.fmt$(psaNow)}) and within budget — the slab removes condition risk for little extra and is likely the better buy.`);
        else R.push(`A PSA 10 runs about ${E.fmt$(psaNow)} (${m.toFixed(1)}× raw).`);
      }
      if (psa9Now) R.push(psa9Now <= price * 1.25 ? `PSA 9 sells for about ${E.fmt$(psa9Now)}, barely above raw — a 9 removes condition risk for little extra.` : `PSA 9 about ${E.fmt$(psa9Now)} vs PSA 10 ${E.fmt$(psaNow)}: ${psaNow && psaNow / psa9Now >= 4 ? "a steep 9-to-10 cliff, so a raw copy is only worth grading if it's clearly perfect." : "a modest 9-to-10 gap."}`);
      if (gem != null) R.push(`PSA population: ${pop.psa10.toLocaleString()} 10s of ${pop.total.toLocaleString()} graded (${Math.round(gem * 100)}% gem rate${pop.date ? `, ${pop.date}` : ""}). ${gem < 0.1 ? "10s are scarce — raw copies often have flaws; buy with clear photos." : gem > 0.5 ? "10s are common, so the PSA 10 premium is likely to keep shrinking." : ""}`.trim());
      else if (m != null && m >= 4 && !psa9Now && price <= b.sweetSpotMax) R.push("Worth grading only if your copy is clearly well centered and clean (grading costs ~$20–25+ per card, and many modern pulls don't get a 10).");
      // Liquidity & costs
      if (soldFresh) R.push(soldMid < price * 0.93 ? `Recent sales center on ${E.fmt$(soldMid)} (${E.fmt$(F.sold.low)}–${E.fmt$(F.sold.high)}), under the TCGplayer market — don't pay market.` : `Recent sales ${E.fmt$(F.sold.low)}–${E.fmt$(F.sold.high)} back up the market price.`);
      else if (lowGap != null && lowGap <= 0.8) R.push(`Listings start at ${E.fmt$(c.low)}, ${Math.round((1 - lowGap) * 100)}% under market — either thin trading or room to buy under market. Check sold prices, and buy with photos.`);
      R.push(`Selling costs (~13% fees plus shipping) mean it has to reach about ${E.fmt$(breakeven)} (+${Math.round(feeDrag * 100)}%) just to break even.`);
      R.push(...guard);
      if (peerCapped && price > target) R.push(`Fair price, not a bargain: the buy-under price is ${E.fmt$(target)}, ${targetWhy}.`);
      if (price > b.budgetMax) R.push(`Now above your ${E.fmt$(b.budgetMax)} max; kept in the list so its history continues.`);
      if (!enoughHist) R.push(`Only ${st.n} day${st.n === 1 ? "" : "s"} of price history so far — treat this call as provisional.`);
      if (F?.note && fFresh) R.push(`Research notes (${F.verified}): ${F.note}`);

      /* --- the investor checklist: what was checked, what's missing --- */
      const checks = [
        { k: "type", ok: true, label: `Card type: ${tl}` },
        { k: "peers", ok: !!fair, label: fair ? `Compared with ${fair.n} like-for-like cards${fair.kind === "borrowed" ? " (other Pokémon, scaled)" : ""}` : "No like-for-like cards to compare with" },
        { k: "setmates", ok: !!mates, label: mates ? `Setmates: ${mates.n} ${tn} cards in ${c.group || c.setName}, median ${E.fmt$(mates.median)}` : "Setmate prices not synced yet" },
        { k: "range", ok: longKnown, label: longKnown ? `Long-run range ${E.fmt$(lo)}–${E.fmt$(hi)}${loSrc === "facts" || hiSrc === "facts" ? " (incl. researched prices)" : ""}` : `Only ${Math.round(st.spanDays / 30.44)} months of prices — 2-year low/high not researched` },
        { k: "sold", ok: soldFresh, label: soldFresh ? `Recent sold ${E.fmt$(F.sold.low)}–${E.fmt$(F.sold.high)} (${F.sold.date})` : F?.sold ? `Sold prices are ${soldAge} days old` : "Recent sold prices not checked (TCGplayer market can run high)" },
        { k: "psa", ok: !!psaNow && !psaConflict && !(psaR.jump && !psaF), label: psaNow ? `PSA 10 ${E.fmt$(psaNow)}${psaF ? " (recent sales)" : " (Scrydex)"}${psaConflict ? " — sources disagree" : ""}` : "No PSA 10 price" },
        { k: "psa9", ok: !!psa9Now, label: psa9Now ? `PSA 9 ${E.fmt$(psa9Now)}` : "No PSA 9 price" },
        { k: "pop", ok: gem != null, label: gem != null ? `Gem rate ${Math.round(gem * 100)}%` : "PSA population not checked" },
        { k: "reprint", ok: !!reprint || c.tier === "classic", label: reprint ? `Reprint check: ${reprint.replace("_", " ")} (${F.verified})` : c.tier === "classic" ? "Is itself a reprint" : "Reprints of this art not checked" },
        { k: "print", ok: !!printStatus || (ageMonths != null && ageMonths >= 48), label: printStatus ? `Set ${printStatus.replace(/_/g, " ")}` : ageMonths != null && ageMonths >= 48 ? "Set long out of print" : "Set print status not recorded" },
        { k: "release", ok: !!c.release && !groupDate, label: groupDate ? "Release date unknown (promo or catch-all group)" : c.release ? `Released ${c.release}` : "Release date unknown" },
        { k: "hype", ok: !monHot, label: monHot ? `${c.pokemon} in a hype cycle (${E.fmtPct(mi.d180)} in 6 mo)` : mi.d180 != null ? `${c.pokemon} cards ${E.fmtPct(mi.d180)} in 6 mo (market ${E.fmtPct(mkt.d180)})` : `Not enough ${c.pokemon} cards to read a trend` },
        { k: "budget", ok: price <= b.budgetMax, label: price <= b.sweetSpotMax ? "In your sweet spot" : price <= b.budgetMax ? "In budget, above sweet spot" : "Over your max" },
      ];
      const missing = checks.filter((x) => !x.ok).map((x) => x.label);

      const short = signal === "verify" ? (runup && price > runAnchor ? `Still ${pctOf(price, lo)}% over its pre-run-up ${E.fmt$(lo)} — check first` : `Looks cheap on ${Math.round(st.spanDays / 30.44)} months of data — check its long-run price first`)
        : flags.includes("spike") ? `Up ${E.fmtPct(st.ch30)} in 30 days — wait for it to cool`
        : flags.includes("still_dropping") ? `At target but down ${Math.abs(Math.round(st.ch30))}% this month — let it flatten`
        : runup && price > runAnchor ? `Still ${pctOf(price, lo)}% above its pre-run-up price (${E.fmt$(lo)})`
        : flags.includes("slow_slide") ? `Down ${Math.abs(Math.round(st.ch90))}% in 90 days, still making new lows`
        : flags.includes("falling") ? `Down ${Math.abs(Math.round(st.ch30))}% in 30 days and still sliding`
        : flags.includes("drifting") ? `Drifting down (${E.fmtPct(st.ch90)} in 90 days) — wait for ${E.fmt$(target)}`
        : monHot && buyish() ? `${c.pokemon} is in a hype cycle — buy only under ${E.fmt$(target)}`
        : peerCapped && price > target && ratio != null && ratio < 1.1 ? `Fair price — in line with similar cards (${E.fmt$(fair.value)}); buy under ${E.fmt$(target)}`
        : ratio != null && ratio >= 1.15 ? `${Math.round((1 - 1 / ratio) * 100)}% under like-for-like cards (${E.fmt$(fair.value)})`
        : flags.includes("pullback") ? `${Math.round(dd * 100)}% off its 1-year high and settling`
        : ratio != null && ratio <= 0.75 ? `${Math.round((1 / ratio - 1) * 100)}% over like-for-like cards (${E.fmt$(fair.value)})`
        : matePrem != null && matePrem >= 4 ? `${matePrem.toFixed(0)}× its setmates — priced on ${c.pokemon}'s popularity`
        : ratio != null ? `In line with like-for-like cards (${E.fmt$(fair.value)})` : `No like-for-like cards to compare yet`;

      out.push({
        ...c, kind: "single", checks, missing, short, peerCapped, groupDate, psaMult: m, histStart, runup, lowAll: lo, highAll: hi, loDay, hiDay, runAnchor,
        psaJump: psaR.jump || null, psaConflict, psaScrydex: psaR.price, psa9: psa9Now, gem, facts: F, factsFresh: fFresh, soldFresh, longKnown,
        set: { id: c.setId, name: c.setName }, stats: st, psa: { price: psaNow, stats: g }, mates, matePrem, monIdx: mi, mktIdx: mkt, monHot, spotlight: spot,
        ageMonths, phase, printStatus, fair, ratio, target, targetWhy, gap: target != null ? (price / target - 1) * 100 : null, breakeven,
        pillars, demand, value, momentum, budgetFit, score, confidence, signal, flags, reasons: R,
        headline: R[0], tierLabel: tl, eraLabel: ERAS[c.era],
      });
    }
    return out;
  }

  function claudePrompt(r, priceDate, b) {
    const f = r.facts;
    const P = r.pillars;
    return [
      `Act as a veteran Pokémon TCG singles investor. I buy raw (sometimes PSA 10) singles of popular Pokémon to hold 4+ years. My budget is ${E.fmt$(b.budgetMin)}–${E.fmt$(b.budgetMax)} per card, sweet spot up to ${E.fmt$(b.sweetSpotMax)}. Search the web for recent sales and news on this card, then give me a second opinion.`,
      "",
      `Card: ${r.name} — ${r.group || r.setName}${r.number ? ` #${r.number}` : ""} (my tracker classes it as: ${r.tierLabel}${r.sub ? `, ${r.sub}` : ""}), ${r.groupDate ? `release unknown to my tracker (${r.release || "no date"} is the promo group's start date)` : `released ${r.release || "unknown"}`}`,
      `TCGplayer market (raw, ${priceDate}): ${E.fmt$(r.price)} (lowest listing ${E.fmt$(r.low)}); 30d ${E.fmtPct(r.stats.ch30)}, 90d ${E.fmtPct(r.stats.ch90)}, 1y high ${E.fmt$(r.stats.high365)}`,
      r.histStart != null ? `My daily price history starts ${E.dayToDate(r.histStart).toISOString().slice(0, 10)}.${r.lowAll != null ? ` Known range ${E.fmt$(r.lowAll)}–${E.fmt$(r.highAll)}${r.runup ? " (a run-up)" : ""}.` : ""}` : "",
      r.psa.price ? `PSA 10: about ${E.fmt$(r.psa.price)}${r.psaConflict ? ` (Scrydex says ${E.fmt$(r.psaScrydex)} — sources disagree)` : ""}${r.psa9 ? `; PSA 9 about ${E.fmt$(r.psa9)}` : ""}` : "PSA 10: unknown",
      r.fair ? `Like-for-like cards${r.fair.kind === "borrowed" ? " (borrowed estimate)" : ""}: ${r.fair.how}, median ${E.fmt$(r.fair.value)} (this card is ${r.ratio >= 1 ? Math.round((1 - 1 / r.ratio) * 100) + "% under" : Math.round((1 / r.ratio - 1) * 100) + "% over"} that)` : "Like-for-like cards: none to compare with yet",
      r.mates ? `Setmates (same card type in the same set, any Pokémon): median ${E.fmt$(r.mates.median)} across ${r.mates.n} cards; this card is ${r.matePrem.toFixed(1)}× that` : "",
      r.monIdx?.d180 != null ? `${r.pokemon}'s tracked cards: ${E.fmtPct(r.monIdx.d180)} over 6 months (median tracked card ${E.fmtPct(r.mktIdx.d180)})${r.monHot ? " — my tracker calls this a hype cycle" : ""}` : "",
      f ? `Researched facts on file (${f.verified}): ${[f.longLow && `2-yr low ${E.fmt$(f.longLow.price)} (${f.longLow.date})`, f.longHigh && `high ${E.fmt$(f.longHigh.price)} (${f.longHigh.date})`, f.sold && `sold ${E.fmt$(f.sold.low)}–${E.fmt$(f.sold.high)} (${f.sold.date})`, f.reprint && `reprint: ${f.reprint}`].filter(Boolean).join("; ")}` : "",
      `My tracker says: ${E.SIGNALS[r.signal].label}${r.target != null ? `, buy under ${E.fmt$(r.target)} (${r.targetWhy})` : ""}, score ${r.score}/100 — demand ${P.demand}, value ${P.value}, price position ${P.position}, momentum ${P.momentum}, supply ${P.supply}, grading ${P.grading}, liquidity ${P.liquidity}.`,
      r.missing.length ? `What my tracker couldn't check: ${r.missing.join("; ")}.` : "",
      "",
      "Where you disagree with my tracker, say which fact it's missing or getting wrong, so I can fix it. Is it actually undervalued or just a weaker card? Would you buy raw now, set a lower limit, buy a PSA 10 instead, or skip? Biggest risks (reprints, more copies coming, condition)?",
      "Finish with the facts for my tracker's research file, one per line, only those you found with a source: 2-year low (price and month), 2-year high (price and month), recent raw sold range, PSA 10 sold range, PSA 9 price, PSA 10 and total population, reprint status (none / same art reprinted / announced / risk), and what's driving attention on this Pokémon right now.",
    ].filter(Boolean).join("\n");
  }

  global.Singles = { analyse, claudePrompt, TIERS, PILLARS, ERAS };
})(window);

/* Sealed Vault — singles engine.
 *
 * Long-hold rules for raw singles of popular Pokémon, written down so they're applied the same way
 * every day:
 *  1. Demand is the Pokémon plus the rarity. Special Illustration Rares and alt arts of iconic Pokémon
 *     are the cards that keep compounding; regular rares, promos and reprints mostly don't.
 *  2. Compare a card with similar cards (same Pokémon, rarity tier, era). A big discount to that
 *     group's median is the best hint a card is undervalued — but some cards are simply weaker, so
 *     it's one input, not the verdict.
 *  3. Singles usually bottom while their set is still being printed, then recover once printing stops.
 *  4. Buy pullbacks that have flattened, not spikes and not active slides.
 *  5. Raw copies carry condition risk; the PSA 10 price shows what a perfect copy is worth.
 *
 * Heuristics, not financial advice.
 */
(function (global) {
  "use strict";
  const E = global.Engine;
  const DAY = 86400000;

  const TIERS = {
    sir:     { label: "Special Illustration Rare", demand: 100 },
    alt:     { label: "Alternate Art",              demand: 100 },
    ir:      { label: "Illustration / Gallery",     demand: 82 },
    vintage: { label: "Vintage holo & rare",        demand: 72 },
    secret:  { label: "Secret / Hyper Rare",        demand: 62 },
    shiny:   { label: "Shiny",                      demand: 62 },
    ultra:   { label: "Ultra Rare / Full Art",      demand: 55 },
    other:   { label: "Special rare",               demand: 48 },
    promo:   { label: "Promo",                      demand: 42 },
    base:    { label: "Regular rare",               demand: 38 },
    classic: { label: "Classic Collection reprint", demand: 30 },
  };
  const ERAS = { sv: "Scarlet & Violet / Mega era", swsh: "Sword & Shield era", smxy: "Sun & Moon / XY era", classic: "2003–2013", wotc: "WotC era", unknown: "era unknown" };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const geo = (pairs) => { // weighted geometric mean of [value, weight]
    let s = 0, w = 0;
    for (const [v, n] of pairs) if (v > 0 && n > 0) { s += Math.log(v) * n; w += n; }
    return w ? Math.exp(s / w) : null;
  };

  /** Fair-value table from the sync's peer medians (computed over every price, not just your band). */
  function fairModel(peers) {
    const byTE = {}, byMon = {};
    for (const [k, v] of Object.entries(peers || {})) {
      const [mon, tier, era] = k.split("|");
      (byTE[`${tier}|${era}`] ||= []).push([v.median, v.n, mon]);
    }
    const te = {};
    for (const [k, rows] of Object.entries(byTE)) te[k] = { median: geo(rows.map(([m, n]) => [m, n])), n: rows.reduce((a, r) => a + r[1], 0) };
    // How much more (or less) a Pokémon's cards sell for than the average Pokémon of the same tier & era.
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
        const own = peers?.[`${card.pokemon}|${card.tier}|${card.era}`];
        if (own && own.n >= 5) return { value: own.median, n: own.n, how: `the median of ${own.n} ${card.pokemon} ${TIERS[card.tier].label.toLowerCase()} cards from the ${ERAS[card.era]}` };
        const base = te[`${card.tier}|${card.era}`];
        if (base && base.n >= 6) {
          const f = monFactor[card.pokemon] ?? 1;
          return { value: base.median * f, n: base.n, how: `${base.n} ${TIERS[card.tier].label.toLowerCase()} cards from the ${ERAS[card.era]}, adjusted for how ${card.pokemon} usually sells` };
        }
        return null;
      },
    };
  }

  function analyse(ctx) {
    const { singles, history, meta, sealedHistory, settings } = ctx;
    const lastDay = history.lastDay ?? E.dateToDay(singles.priceDate);
    const nowMs = Date.parse(singles.priceDate + "T00:00:00Z");
    const weights = Object.fromEntries(settings.chasePokemon.map((c) => [c.name.toLowerCase(), c.weight ?? 1]));
    const model = fairModel(singles.peers);
    const psa = singles.psa10 || {};
    const b = settings.singles;

    // Each set's sealed trend, to spot cards lagging their own set.
    const setSealed90 = {};
    for (const s of meta?.sets || []) {
      const st = E.seriesStats(sealedHistory?.series?.["set:" + s.id], sealedHistory?.lastDay);
      if (st.ch90 != null) setSealed90[s.id] = st.ch90;
    }

    const out = [];
    for (const c of singles.cards) {
      const price = c.price;
      const st = E.seriesStats(history.series[String(c.id)], lastDay);
      const g = E.seriesStats(history.series["g:" + c.id], lastDay);
      const psaNow = psa[c.id]?.price ?? (g.n ? g.cur : null);
      const ageMonths = c.release ? (nowMs - Date.parse(c.release + "T00:00:00Z")) / DAY / 30.44 : null;
      const phase = (() => { if (ageMonths == null) return "unknown"; if (ageMonths < 2) return "hype"; if (ageMonths < 12) return "trough"; if (ageMonths < 24) return "transition"; if (ageMonths < 48) return "established"; return "vintage"; })();
      const enoughHist = st.n >= 6 && st.spanDays >= E.MIN_HIST_DAYS && st.staleDays <= 21 && st.ma90 != null && st.low90 != null;
      const fair = model.fair(c);
      const ratio = fair ? fair.value / price : null; // >1 = cheaper than similar cards

      /* --- buy-under target (never derived from today's price) --- */
      let target = null, targetWhy;
      if (enoughHist) {
        target = Math.min(st.ma90 * 0.95, st.low90 * 1.08);
        targetWhy = "just under its 90-day average, near its 90-day low";
      } else if (fair && fair.n >= 8) {
        target = fair.value * 0.8;
        targetWhy = "20% under similar cards' median (not enough price history yet)";
      } else targetWhy = "not enough price history and too few similar cards to compare with";
      if (target != null && phase === "hype") { target *= 0.85; targetWhy += ", minus 15% because new-set singles usually keep falling"; }
      if (target != null) target = Math.round(Math.min(target, b.budgetMax) * { conservative: 0.95, balanced: 1, aggressive: 1.05 }[settings.risk || "balanced"] * 100) / 100;

      /* --- scores --- */
      const monW = weights[c.pokemon.toLowerCase()] ?? 0.7;
      const demand = Math.round(0.55 * TIERS[c.tier].demand + 0.45 * monW * 100);
      const value = ratio == null ? 50 : Math.round(clamp((ratio - 0.8) / 0.8, 0, 1) * 100);
      const timing = { hype: 25, trough: 85, transition: 85, established: 65, vintage: 60, unknown: 50 }[phase];
      const flags = [];
      let momentum = 50;
      const high = st.high365 ?? st.allHigh;
      const dd = high ? 1 - price / high : null;
      if (st.ch30 != null) {
        if (st.ch30 > 25) { momentum = 12; flags.push("spike"); }
        else if (st.ch30 < -15) { momentum = 22; flags.push("falling"); }
        else if (dd != null && dd >= 0.25 && st.ch30 > -5) { momentum = 88; flags.push("pullback"); }
        else if (st.ch90 != null && st.ch90 >= 5 && st.ch90 <= 30 && st.ch30 < 12) { momentum = 66; flags.push("steady"); }
      }
      const lag = setSealed90[c.setId] != null && st.ch90 != null ? st.ch90 - setSealed90[c.setId] : null;
      if (lag != null && lag < -15) { momentum = Math.min(100, momentum + 10); flags.push("lagging_set"); }
      const budgetFit = price <= b.sweetSpotMax ? 100 : price <= b.budgetMax ? 65 : 0;
      const score = Math.round(0.3 * value + 0.25 * demand + 0.2 * momentum + 0.15 * timing + 0.1 * budgetFit);

      /* --- confidence & signal --- */
      const realSpan = st.spanDays;
      const confidence = enoughHist && realSpan >= 180 && st.n >= 30 && fair ? "high" : enoughHist || (fair && fair.n >= 8) ? "medium" : "low";
      let signal;
      if (target == null) signal = "no_call";
      else if (demand < 45) signal = "pass";
      else if (flags.includes("spike") && price > target) signal = "overheated";
      else if (flags.includes("falling")) signal = "falling";
      else if (price <= target && score >= 66 && confidence !== "low") signal = "strong_buy";
      else if (price <= target * 1.05 && score >= 55) signal = "buy";
      else if (price <= target * 1.12 && ratio != null && ratio >= 1.15) signal = "accumulate";
      else signal = "wait";
      if (signal === "strong_buy" && !enoughHist) signal = "buy"; // no Strong buy without real history
      if (price > b.budgetMax && ["strong_buy", "buy", "accumulate"].includes(signal)) signal = "wait"; // over your max

      /* --- reasons --- */
      const R = [];
      if (ratio != null) {
        if (ratio >= 1.3) R.push(`About ${Math.round((1 - 1 / ratio) * 100)}% cheaper than ${fair.how} (${E.fmt$(fair.value)}). Cards this far under their peers are where undervalued buys hide — check that it isn't just a weaker card.`);
        else if (ratio <= 0.75) R.push(`Already ${Math.round((1 / ratio - 1) * 100)}% above ${fair.how} (${E.fmt$(fair.value)}) — you're paying up for this one.`);
        else R.push(`In line with ${fair.how} (${E.fmt$(fair.value)}).`);
      } else R.push("Too few similar cards to compare its price with.");
      R.push(`${TIERS[c.tier].label} of ${c.pokemon}: ${demand >= 75 ? "the kind of card collectors keep chasing for years" : demand >= 55 ? "solid demand, not a top-tier chase" : "weak long-term demand — fine to collect, not a strong hold"}.`);
      if (phase !== "unknown") R.push(`${E.PHASES[phase].label} (${Math.max(0, ageMonths).toFixed(0)} mo): ${phase === "hype" ? "new-set singles usually fall for months as more packs get opened." : phase === "trough" ? "still being printed — singles usually bottom in this window." : phase === "transition" ? "printing has likely ended; good cards tend to recover from here." : "an older card; moves are slower and driven by demand, not supply."}`);
      if (flags.includes("pullback")) R.push(`Down ${Math.round(dd * 100)}% from its 1-year high (${E.fmt$(high)}) and flat this month — a pullback that's settling.`);
      if (flags.includes("spike")) R.push(`Up ${E.fmtPct(st.ch30)} in 30 days. Spikes usually give some back — wait for ${E.fmt$(target)}.`);
      if (flags.includes("falling")) R.push(`Down ${E.fmtPct(st.ch30)} in 30 days and still sliding — let it settle.`);
      if (flags.includes("steady")) R.push(`Steady climb (${E.fmtPct(st.ch90)} over 90 days) without a blow-off.`);
      if (flags.includes("lagging_set")) R.push(`Lagging its set: ${E.fmtPct(st.ch90)} over 90 days vs ${E.fmtPct(setSealed90[c.setId])} for the set's sealed product.`);
      if (psaNow) {
        const m = psaNow / price;
        if (psaNow <= b.budgetMax) R.push(`A PSA 10 copy runs about ${E.fmt$(psaNow)} — within your budget, and graded copies skip the condition risk of raw.`);
        else R.push(`PSA 10 copies sell for about ${E.fmt$(psaNow)} (${m.toFixed(1)}× raw). Raw is the only way in at your budget; buy clean near-mint copies.`);
        if (m >= 4 && price <= b.sweetSpotMax) R.push("Big gap between raw and PSA 10 — worth grading only if your copy is clearly well centered and clean (grading costs ~$20–25+ per card, and many modern pulls don't get a 10).");
      }
      if (price > b.budgetMax) R.push(`Now above your ${E.fmt$(b.budgetMax)} max; kept in the list so its history continues.`);
      if (!enoughHist) R.push(`Only ${st.n} day${st.n === 1 ? "" : "s"} of price history so far — treat this call as provisional.`);

      const checks = [
        { k: "history", ok: enoughHist, label: enoughHist ? `${st.spanDays} days of price history` : `Only ${st.spanDays} days of price history (needs ${E.MIN_HIST_DAYS})` },
        { k: "peers", ok: !!fair, label: fair ? `Compared with ${fair.n} similar cards` : "Too few similar cards to compare with" },
        { k: "release", ok: !!c.release, label: c.release ? `Released ${c.release}` : "Release date unknown (promo or catch-all group)" },
        { k: "psa", ok: !!psaNow, label: psaNow ? "PSA 10 price known" : "No PSA 10 price" },
      ];
      // One short line for the card face; the full reasons are in the detail view.
      const short = flags.includes("spike") ? `Up ${E.fmtPct(st.ch30)} in 30 days — wait for it to cool`
        : flags.includes("falling") ? `Down ${E.fmtPct(st.ch30)} in 30 days and still sliding`
        : ratio != null && ratio >= 1.3 ? `${Math.round((1 - 1 / ratio) * 100)}% under similar cards (${E.fmt$(fair.value)})`
        : flags.includes("pullback") ? `${Math.round(dd * 100)}% off its 1-year high and settling`
        : ratio != null && ratio <= 0.75 ? `${Math.round((1 / ratio - 1) * 100)}% over similar cards (${E.fmt$(fair.value)})`
        : flags.includes("lagging_set") ? "Lagging its own set's sealed product"
        : ratio != null ? `In line with similar cards (${E.fmt$(fair.value)})` : "Too few similar cards to compare";
      out.push({
        ...c, kind: "single", checks, short, set: { id: c.setId, name: c.setName }, stats: st, psa: { price: psaNow, stats: g },
        ageMonths, phase, fair, ratio, target, targetWhy, gap: target != null ? (price / target - 1) * 100 : null,
        demand, value, momentum, timing, budgetFit, score, confidence, signal, flags, reasons: R,
        headline: R[0], tierLabel: TIERS[c.tier].label, eraLabel: ERAS[c.era],
      });
    }
    return out;
  }

  function claudePrompt(r, priceDate, b) {
    return [
      `Act as a veteran Pokémon TCG singles investor. I buy raw (sometimes PSA 10) singles of popular Pokémon to hold 4+ years. My budget is ${E.fmt$(b.budgetMin)}–${E.fmt$(b.budgetMax)} per card, sweet spot up to ${E.fmt$(b.sweetSpotMax)}. Search the web for recent sales and news on this card, then give me a second opinion.`,
      "",
      `Card: ${r.name} — ${r.setName}${r.number ? ` #${r.number}` : ""} (${r.tierLabel}${r.sub ? `, ${r.sub}` : ""}), released ${r.release || "unknown"}`,
      `TCGplayer market (raw, ${priceDate}): ${E.fmt$(r.price)}; 30d ${E.fmtPct(r.stats.ch30)}, 90d ${E.fmtPct(r.stats.ch90)}, 1y high ${E.fmt$(r.stats.high365)}`,
      r.psa.price ? `PSA 10: about ${E.fmt$(r.psa.price)}` : "PSA 10: unknown",
      r.fair ? `Similar cards: ${r.fair.how}, median ${E.fmt$(r.fair.value)}` : "",
      `My tracker says: ${E.SIGNALS[r.signal].label}, buy under ${E.fmt$(r.target)}, score ${r.score}/100.`,
      "",
      "Is it actually undervalued or just a weaker card? Would you buy raw now, set a lower limit, buy a PSA 10 instead, or skip? Biggest risks (reprints, more copies coming, condition)?",
    ].filter(Boolean).join("\n");
  }

  global.Singles = { analyse, claudePrompt, TIERS, ERAS };
})(window);

/* Sealed Vault — UI. Vanilla JS, no build step. */
(function () {
  "use strict";
  const E = window.Engine;
  const S = window.Singles;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt$ = E.fmt$, fmtPct = E.fmtPct;
  const LS = { settings: "sv.settings", watch: "sv.watch", hold: "sv.holdings" };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const state = {
    meta: null, history: null, config: null, rows: [], byId: new Map(),
    singles: null, singlesHistory: null, sRows: [], sById: new Map(),
    sFilters: { q: "", band: "sweet", pokemon: "", tier: "", signal: "", sort: "score", lang: "", limit: 48 },
    sChart: "raw",
    watch: new Set(store.get(LS.watch, [])), holdings: store.get(LS.hold, {}),
    filters: { q: "", type: "", signal: "", pokemon: "", sort: "rank", dir: 1 },
    range: "1y",
  };

  const SETTINGS_V = 2; // v2: retail prices saved before the data fix are ignored (they carried the wrong defaults)
  function settings() {
    const s = store.get(LS.settings, {});
    const c = state.config;
    // Saved retail prices only apply while config.json's retail list is the one they were saved against.
    const fresh = (s.v || 1) >= SETTINGS_V && s.cfgRetail === JSON.stringify(c.retailReference);
    return {
      chasePokemon: s.chasePokemon || c.chasePokemon,
      retailReference: { ...c.retailReference, ...(fresh ? s.retailReference || {} : {}) },
      retailOverrides: { ...(c.retailOverrides || {}), ...(fresh ? s.retailOverrides || {} : {}) },
      productOverrides: c.productOverrides || {},
      setOverrides: c.setOverrides || {},
      formatScore: c.formatScore,
      risk: s.risk || "balanced",
      singles: { budgetMin: 30, budgetMax: 300, sweetSpotMax: 100, ...(c.singles || {}), ...(s.singles || {}) },
    };
  }

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600); }
  const sigPill = (k) => `<span class="sig sig-${k}"><i aria-hidden="true">${E.SIGNALS[k].icon}</i>${E.SIGNALS[k].label}</span>`;
  const confPill = (r) => `<span class="conf conf-${r.confidence}" title="${esc(r.checks.filter((c) => !c.ok).map((c) => c.label).join("; ") || "All data checks pass")}">${E.CONFIDENCE[r.confidence].label}</span>`;
  const pct = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="${v > 0.5 ? "up" : v < -0.5 ? "down" : ""}">${fmtPct(v)}</span>`);
  const thumb = (r) => (r.img ? `<img class="thumb" src="${esc(r.img)}" alt="" loading="lazy">` : `<div class="thumb">${esc(E.TYPE_LABEL[r.type] || "")}</div>`);
  const seriesPts = (id, sinceDays, hist = state.history) => {
    const s = hist.series[String(id)] || [];
    const last = hist.lastDay ?? 0;
    return s.filter(([d]) => sinceDays == null || d >= last - sinceDays).map(([d, v]) => [E.dayToDate(d).getTime(), v]);
  };

  /* ------------------------------------------------------------- load ---- */
  async function load() {
    try {
      const [config, meta, history] = await Promise.all([
        fetch("config.json", { cache: "no-cache" }).then((r) => r.json()),
        fetch("data/meta.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("meta"); return r.json(); }),
        fetch("data/history.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { series: {} })),
      ]);
      Object.assign(state, { config, meta, history });
      // Singles are optional: older syncs didn't write them.
      const [singles, singlesHistory, cardFacts] = await Promise.all([
        fetch("data/singles.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("data/singles_history.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { series: {} })).catch(() => ({ series: {} })),
        // Researched long-run prices, sold prices, population and reprint status (scripts/card_facts.py).
        fetch("data/card_facts.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : { cards: {} })).catch(() => ({ cards: {} })),
      ]);
      Object.assign(state, { singles, singlesHistory, cardFacts });
    } catch (e) {
      $("#main").innerHTML = `<div class="empty"><h2>No price data yet</h2><p>Run the “Daily price sync” workflow from your repository's Actions tab, then reload. If you opened index.html straight from disk, serve the folder instead (for example <code>python -m http.server</code>) — browsers block local data files.</p></div>`;
      $("#asof").textContent = "";
      return;
    }
    const d = new Date(state.meta.priceDate + "T00:00:00Z").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    $("#asof").textContent = `TCGplayer market prices as of ${d}`;
    const hd = E.historyDays(state.meta, state.history);
    if (state.meta.demo) $("#banner").innerHTML = `<div class="banner"><p><strong>Demo data.</strong> These are fictional sets with simulated prices so you can try the app. Real TCGplayer prices replace them after the first daily sync runs.</p></div>`;
    else if (hd < E.MIN_HIST_POINTS) $("#banner").innerHTML = `<div class="banner"><p><strong>${hd} day${hd === 1 ? "" : "s"} of daily prices so far.</strong> Until there are ${E.MIN_HIST_POINTS} (about ${E.MIN_HIST_DAYS} days of syncing), the only calls the app makes are against a known retail price, and most products show “Not enough data.” Nothing is a Strong buy until then.</p></div>`;
    recompute();
    window.addEventListener("hashchange", route);
    route();
  }

  function recompute() {
    state.rows = E.analyse({ meta: state.meta, history: state.history, settings: settings() });
    state.byId = new Map(state.rows.map((r) => [String(r.id), r]));
    if (state.singles && S) {
      state.sRows = S.analyse({ singles: state.singles, history: state.singlesHistory, meta: state.meta, sealedHistory: state.history, settings: settings(), facts: state.cardFacts });
      state.sById = new Map(state.sRows.map((r) => [String(r.id), r]));
    }
  }
  // Load your collection in the background (if set up) so product pages can show what you own.
  setTimeout(() => { if (window.Collection?.conf()) window.Collection.loadCollection(); }, 0);
  const anyById = (id) => state.byId.get(String(id)) || state.sById.get(String(id));

  /* ------------------------------------------------------------ router --- */
  function route() {
    const h = location.hash.slice(1) || "picks";
    const [view, arg] = h.split("/");
    if (view === "p" && arg) { if (!$("#main").dataset.view) renderView("picks"); openDetail(arg); return; }
    if (view === "s" && arg) { if (!$("#main").dataset.view) renderView("singles"); openSingle(arg); return; }
    closeDetail(false);
    renderView(view);
  }
  function renderView(view) {
    const views = { picks: renderPicks, singles: renderSingles, products: renderProducts, sets: renderSets, portfolio: renderPortfolio, collection: renderCollection, settings: renderSettings, about: renderAbout };
    const fn = views[view] || renderPicks;
    $("#main").dataset.view = view;
    document.querySelectorAll(".tabs a").forEach((a) => { if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    fn();
  }

  /* ------------------------------------------------------------- picks --- */
  function slab(r) {
    const holo = r.signal === "strong_buy";
    const pts = seriesPts(r.id, 180);
    return `<button class="slab" data-open="${r.id}">
      <div class="slab-label${holo ? " holo" : ""}">
        <span class="slab-set">${esc(r.set.name)}</span>
        <span class="slab-name">${esc(r.name)}</span>
        <span class="grade g-${r.signal}"><b>${E.SIGNALS[r.signal].label}</b><span>score ${r.score}</span></span>
      </div>
      <div class="slab-body">${thumb(r)}
        <div class="prices">
          <div>Market<strong class="price">${fmt$(r.price)}</strong></div>
          <div>Buy under<strong class="price">${fmt$(r.target)}</strong></div>
        </div>
      </div>
      <p class="slab-why">${esc(r.headline)}</p>
      <div class="slab-foot"><span>${confPill(r)}</span><span class="foot-trend">30d ${pct(r.stats.ch30)} ${Charts.sparkline(pts)}</span></div>
    </button>`;
  }

  function renderPicks() {
    const rows = state.rows.slice();
    const buys = rows.filter((r) => ["strong_buy", "buy"].includes(r.signal)).sort((a, b) => E.SIGNALS[a.signal].rank - E.SIGNALS[b.signal].rank || b.score - a.score);
    const acc = rows.filter((r) => r.signal === "accumulate").sort((a, b) => b.score - a.score).slice(0, 6);
    const hot = rows.filter((r) => r.signal === "overheated" || r.signal === "falling").sort((a, b) => b.score - a.score);
    const watched = rows.filter((r) => state.watch.has(String(r.id)));
    const noCall = rows.filter((r) => r.signal === "no_call").length;
    const near = watched.filter((r) => r.target != null && r.price <= r.target * 1.03);
    $("#main").innerHTML = `
      <h1>Today's desk</h1>
      <p class="lede">Sealed products from sets carried by ${esc(settings().chasePokemon.slice(0, 4).map((c) => c.name).join(", "))} and the rest of your chase list, scored for a 4+ year hold. “Buy under” is the price I'd be happy paying today.</p>
      <div class="controls"><button class="btn" id="brief">Ask Claude about today's picks</button></div>
      ${near.length ? `<section class="section"><div class="section-head"><h2>Your watchlist hit its targets</h2></div><div class="slabs">${near.map(slab).join("")}</div></section>` : ""}
      <section class="section">
        <div class="section-head"><h2>Buy now</h2><span class="muted small">${buys.length} products at or under target</span></div>
        ${buys.length ? `<div class="slabs">${buys.map(slab).join("")}</div>` : `<div class="empty">Nothing is a buy today${noCall ? ` — and ${noCall} products don't have enough data for a call yet` : ""}. That's normal — patience is most of this game.</div>`}
      </section>
      ${acc.length ? `<section class="section"><div class="section-head"><h2>Worth accumulating slowly</h2><span class="muted small">Strong sets a little above target — buy a piece, not the position</span></div><div class="slabs">${acc.map(slab).join("")}</div></section>` : ""}
      ${singlesTeaser()}
      ${hot.length ? `<section class="section"><div class="section-head"><h2>Hold off</h2><span class="muted small">Spiking or still sliding — wait for these to settle</span></div><div class="slabs">${hot.map(slab).join("")}</div></section>` : ""}`;
    $("#brief").onclick = () => askClaude(deskBrief(buys, acc, hot));
  }

  function deskBrief(buys, acc, hot) {
    const line = (r) => `- ${r.name} (${r.set.name}, ${r.ageMonths != null ? Math.round(r.ageMonths) + " mo" : "release unknown"}): ${fmt$(r.price)}${r.retail ? ` (retail ${fmt$(r.retail)})` : ""}, target ${fmt$(r.target)}, 30d ${fmtPct(r.stats.ch30)}, 1y ${fmtPct(r.stats.ch365)}, ${E.SIGNALS[r.signal].label}, ${E.CONFIDENCE[r.confidence].label.toLowerCase()}`;
    return [
      `Act as a veteran sealed Pokémon TCG investor. I hold sealed product 4+ years. My tracker (TCGplayer market prices, ${state.meta.priceDate}) flagged the items below. It only has ${E.historyDays(state.meta, state.history)} day(s) of price history, so check MSRPs and release dates yourself. Search the web for any recent reprint or restock news on these sets, then tell me which 3 you'd actually buy, which you'd skip, and why. Give a max price for each.`,
      "", "Buy now:", ...buys.slice(0, 12).map(line), "", "Accumulate slowly:", ...acc.map(line), "", "Hold off:", ...hot.slice(0, 6).map(line),
    ].join("\n");
  }

  function askClaude(prompt) {
    const done = () => toast("Prompt copied. Paste it into Claude if it isn't already filled in.");
    (navigator.clipboard?.writeText(prompt) || Promise.reject()).then(done, () => toast("Opening Claude with your prompt."));
    window.open("https://claude.ai/new?q=" + encodeURIComponent(prompt), "_blank", "noopener");
  }


  /* ----------------------------------------------------------- singles --- */
  const openAttr = (r) => (r.kind === "single" ? `data-open-single="${r.id}"` : `data-open="${r.id}"`);
  const cardImg = (r, big) => (r.img ? `<img src="${esc(big ? r.img.replace(/_200w(\.\w+)$/, "_in_1000x1000$1") : r.img)}" alt="${esc(r.name)}" loading="lazy">` : `<div class="noimg">${esc(r.name)}</div>`);
  const sPts = (id, days) => seriesPts(id, days, state.singlesHistory);
  const whole$ = (v) => "$" + Math.round(v).toLocaleString();

  function cardSlab(r) {
    const holo = r.signal === "strong_buy";
    return `<button class="slab card-slab" data-open-single="${r.id}">
      <div class="slab-label${holo ? " holo" : ""}">
        <span class="slab-set">${esc(r.tierLabel)}</span>
        <span class="slab-name">${esc(r.name)}</span>
        <span class="grade g-${r.signal}"><b>${E.SIGNALS[r.signal].label}</b><span>score ${r.score} · ${r.passes}/5 steps</span></span>
      </div>
      <div class="card-art">${cardImg(r)}</div>
      <div class="card-set">${r.lang === "ja" ? `<span class="lang-ja">JP</span> ` : ""}${esc(r.setName)}${r.number ? ` · ${esc(r.number)}` : ""}</div>
      <div class="prices">
        <div>Raw<strong class="price">${fmt$(r.price)}</strong></div>
        <div>Buy under<strong class="price">${fmt$(r.target)}</strong></div>
        <div>PSA 10<strong class="price">${fmt$(r.psa.price)}</strong></div>
      </div>
      <p class="slab-why">${esc(r.short)}</p>
      <div class="slab-foot"><span>${confPill(r)}</span><span class="foot-trend">30d ${pct(r.stats.ch30)} ${Charts.sparkline(sPts(r.id, 180))}</span></div>
    </button>`;
  }

  function inBand(r) {
    const b = settings().singles;
    return r.price >= b.budgetMin && r.price <= (state.sFilters.band === "sweet" ? b.sweetSpotMax : b.budgetMax);
  }

  function singlesTeaser() {
    if (!state.sRows.length) return "";
    const b = settings().singles;
    const top = state.sRows.filter((r) => ["strong_buy", "buy", "verify"].includes(r.signal) && r.price >= b.budgetMin && r.price <= b.budgetMax)
      .sort((a, z) => E.SIGNALS[a.signal].rank - E.SIGNALS[z.signal].rank || z.score - a.score).slice(0, 4);
    if (!top.length) return "";
    return `<section class="section"><div class="section-head"><h2>Singles worth a look</h2><a class="small" href="#singles">All singles</a></div><div class="slabs cards">${top.map(cardSlab).join("")}</div></section>`;
  }

  const S_SORTS = {
    score: { label: "Best score", fn: (a, z) => E.SIGNALS[a.signal].rank - E.SIGNALS[z.signal].rank || z.score - a.score },
    value: { label: "Most under similar cards", fn: (a, z) => (z.ratio ?? 0) - (a.ratio ?? 0) },
    pullback: { label: "Biggest pullback", fn: (a, z) => (a.stats.high365 ? a.price / a.stats.high365 : 9) - (z.stats.high365 ? z.price / z.stats.high365 : 9) },
    price: { label: "Lowest price", fn: (a, z) => a.price - z.price },
  };

  function renderSingles() {
    const f = state.sFilters; const b = settings().singles;
    if (!state.singles) {
      $("#main").innerHTML = `<h1>Singles</h1><div class="empty" style="margin-top:16px">No singles data yet. It appears after the next daily price sync runs.</div>`;
      return;
    }
    const mons = [...new Set(state.sRows.map((r) => r.pokemon))].sort();
    const tiers = Object.entries(S.TIERS).filter(([k]) => state.sRows.some((r) => r.tier === k));
    $("#main").innerHTML = `
      <h1>Singles</h1>
      <p class="lede">Cards of your chase Pokémon, raw near-mint TCGplayer prices, scored for a 4+ year hold. “Buy under” is the most I'd pay for a raw copy today.${state.singles.psa10Date ? ` PSA 10 prices as of ${esc(state.singles.psa10Date)}.` : ""}</p>
      <div class="controls">
        <div class="seg" role="group" aria-label="Price range">
          <button data-band="sweet" aria-pressed="${f.band === "sweet"}">Sweet spot ${whole$(b.budgetMin)}–${whole$(b.sweetSpotMax)}</button>
          <button data-band="all" aria-pressed="${f.band === "all"}">Up to ${whole$(b.budgetMax)}</button>
        </div>
        <input type="search" id="sq" placeholder="Search card or set" value="${esc(f.q)}" aria-label="Search singles">
        <select id="slang" aria-label="Language"><option value="">English & Japanese</option><option value="en" ${f.lang === "en" ? "selected" : ""}>English</option><option value="ja" ${f.lang === "ja" ? "selected" : ""}>Japanese promos</option></select>
        <select id="smon" aria-label="Pokémon"><option value="">Any Pokémon</option>${mons.map((m) => `<option ${f.pokemon === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
        <select id="stier" aria-label="Rarity"><option value="">Any rarity</option>${tiers.map(([k, v]) => `<option value="${k}" ${f.tier === k ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>
        <select id="ssig" aria-label="Signal"><option value="">All signals</option>${Object.entries(E.SIGNALS).map(([k, v]) => `<option value="${k}" ${f.signal === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
        <select id="ssort" aria-label="Sort">${Object.entries(S_SORTS).map(([k, v]) => `<option value="${k}" ${f.sort === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
      </div>
      <div id="sgrid"></div>`;
    const upd = () => { f.q = $("#sq").value; f.pokemon = $("#smon").value; f.tier = $("#stier").value; f.signal = $("#ssig").value; f.sort = $("#ssort").value; f.lang = $("#slang").value; f.limit = 48; drawSingles(); };
    ["#sq", "#slang", "#smon", "#stier", "#ssig", "#ssort"].forEach((x) => $(x).addEventListener("input", upd));
    document.querySelectorAll("[data-band]").forEach((x) => x.onclick = () => { f.band = x.dataset.band; f.limit = 48; renderSingles(); });
    drawSingles();
  }

  function drawSingles() {
    const f = state.sFilters; const q = f.q.trim().toLowerCase();
    const rows = state.sRows.filter((r) => inBand(r) && (!q || (r.name + " " + r.setName).toLowerCase().includes(q)) &&
      (!f.lang || r.lang === f.lang) && (!f.pokemon || r.pokemon === f.pokemon) && (!f.tier || r.tier === f.tier) && (!f.signal || r.signal === f.signal)).sort(S_SORTS[f.sort].fn);
    const buys = rows.filter((r) => r.signal === "strong_buy" || r.signal === "buy").length;
    const checkFirst = rows.filter((r) => r.signal === "verify").length;
    $("#sgrid").innerHTML = rows.length
      ? `<p class="small muted" style="margin:0 0 12px">${rows.length} cards · ${buys} buy${buys === 1 ? "" : "s"}${checkFirst ? ` · ${checkFirst} to check first (look like buys, but their long-run price isn't known yet)` : ""}${f.lang !== "en" && S.hiddenJp.length ? ` · ${S.hiddenJp.length} Japanese promo${S.hiddenJp.length === 1 ? "" : "s"} hidden because the same art was printed in English` : ""}</p>
         <div class="slabs cards">${rows.slice(0, f.limit).map(cardSlab).join("")}</div>
         ${rows.length > f.limit ? `<div class="more"><button class="btn" id="smore">Show ${Math.min(48, rows.length - f.limit)} more</button></div>` : ""}`
      : `<div class="empty">No cards match. Try the full budget range or clear a filter.</div>`;
    const m = $("#smore"); if (m) m.onclick = () => { f.limit += 48; drawSingles(); };
  }

  function openSingle(id) {
    const r = state.sById.get(String(id));
    if (!r) { location.hash = "#singles"; return; }
    const sheet = $("#sheet"), panel = $("#sheet-panel");
    const st = r.stats, b = settings().singles;
    const watched = state.watch.has(String(r.id));
    const lots = state.holdings[r.id] || [];
    const peers = state.sRows.filter((x) => x.pokemon === r.pokemon && x.tier === r.tier && x.era === r.era).sort((a, z) => z.price - a.price).slice(0, 8);
    const hasPsaHist = (state.singlesHistory.series["g:" + r.id] || []).length > 1;
    panel.innerHTML = `
      <div class="sheet-head">
        <div><div class="pset">${esc(r.setName)}${r.number ? ` · ${esc(r.number)}` : ""} · ${esc(r.tierLabel)}${r.sub ? ` · ${esc(r.sub)}` : ""}</div><h2 id="sheet-title">${esc(r.name)}</h2></div>
        <div style="display:flex;gap:4px"><button class="star" id="star" aria-pressed="${watched}" aria-label="Watch this card" title="Watch">★</button><button class="btn ghost" data-close aria-label="Close">Close</button></div>
      </div>
      <div class="sheet-body">
        <div class="card verdict">
          <div><span class="big grade g-${r.signal}" style="text-align:left"><b>${E.SIGNALS[r.signal].label}</b></span>
          <p style="margin-top:8px">${r.target != null
            ? `Buy a raw copy under <strong>${fmt$(r.target)}</strong> — ${esc(r.targetWhy)}. Market is ${fmt$(r.price)} (${Math.abs(Math.round(r.gap)) === 0 ? "right at" : Math.abs(Math.round(r.gap)) + "% " + (r.gap > 0 ? "over" : "under")} target).`
            : `No buy-under price yet — ${esc(r.targetWhy)}. Market is ${fmt$(r.price)}.`}</p>
          <p class="small" style="margin:6px 0 0">${confPill(r)}</p></div>
          <div class="detail-art">${cardImg(r, true)}</div>
        </div>
        <div class="card">
          <div class="section-head" style="margin:0 0 8px"><h3 style="margin:0">Price history</h3>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${hasPsaHist ? `<div class="seg" role="group" aria-label="Copy">${[["raw", "Raw"], ["psa", "PSA 10"]].map(([k, l]) => `<button data-copy="${k}" aria-pressed="${state.sChart === k}">${l}</button>`).join("")}</div>` : ""}
              <div class="seg" role="group" aria-label="Range">${[["3m", 90], ["1y", 365], ["all", null]].map(([k]) => `<button data-range="${k}" aria-pressed="${state.range === k}">${k === "all" ? "All" : k.toUpperCase()}</button>`).join("")}</div>
            </div></div>
          <div id="chart"></div>
          <div class="legend" id="slegend"></div>
        </div>
        <div class="card"><h3>Why</h3><ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div class="card"><h3>Five-step framework <span class="muted small">— passes ${r.passes} of 5</span></h3>
          <ol class="steps">${Object.entries(S.STEPS).map(([k, label]) => { const v = r.steps[k]; return `<li class="step-${v === true ? "pass" : v === false ? "fail" : "unknown"}"><span aria-hidden="true">${v === true ? "✓" : v === false ? "✗" : "?"}</span> <strong>${esc(label)}</strong> <span class="sr-only">${v === true ? "passes" : v === false ? "fails" : "unknown"}</span></li>`; }).join("")}</ol>
          <p class="small muted" style="margin:8px 0 0">A Buy needs ${settings().singles.framework?.minPasses ?? 3} of 5 and must not fail the ceiling; a Strong buy passes all five. Price is the final filter either way.</p>
        </div>
        <div class="card"><h3>Investor checklist</h3>
          <table class="pillars"><tbody>${Object.entries(S.PILLARS).map(([k, p]) => `<tr><th scope="row">${esc(p.label)} <span class="muted small">${Math.round(p.w * 100)}% · ${esc(p.what)}</span></th><td class="num">${r.pillars[k]}</td><td class="bar-cell"><span class="pbar"><i style="width:${r.pillars[k]}%"></i></span></td></tr>`).join("")}
            <tr class="total"><th scope="row">Score</th><td class="num">${r.score}</td><td></td></tr></tbody></table>
          <ul class="checks" style="margin-top:12px">${r.checks.map((c) => `<li><span aria-hidden="true">${c.ok ? "✓" : "✗"}</span><span class="sr-only">${c.ok ? "Checked:" : "Missing:"}</span> ${esc(c.label)}</li>`).join("")}</ul>
          ${r.checks.some((c) => !c.ok && ["range", "sold", "pop", "reprint", "psa9"].includes(c.k)) ? `<p class="small muted" style="margin:10px 0 0">Researched facts live in <code>data/card_facts.json</code> (card id <code>${r.id}</code>). Record them with <code>python scripts/card_facts.py set ${r.id} low=PRICE@DATE high=PRICE@DATE sold=LO-HI …</code> — Ask Claude lists them at the end of its answer.</p>` : ""}
        </div>
        <div class="card"><h3>Numbers</h3><div class="kv">
          <div>Raw market<strong>${fmt$(r.price)}</strong></div><div>TCGplayer low<strong>${fmt$(r.low)}</strong></div>
          <div>PSA 10<strong>${fmt$(r.psa.price)}</strong></div><div>PSA 10 ÷ raw<strong>${r.psa.price ? (r.psa.price / r.price).toFixed(1) + "×" : "—"}</strong></div>
          <div>30 days<strong>${pct(st.ch30)}</strong></div><div>90 days<strong>${pct(st.ch90)}</strong></div>
          <div>90-day low<strong>${fmt$(st.low90)}</strong></div><div>1-year high<strong>${fmt$(st.high365)}</strong></div>
          <div>Long-run low<strong>${fmt$(r.lowAll)}</strong></div><div>Long-run high<strong>${fmt$(r.highAll)}</strong></div>
          <div>PSA 9<strong>${fmt$(r.psa9)}</strong></div><div>Gem rate<strong>${r.gem != null ? Math.round(r.gem * 100) + "%" : "—"}</strong></div>
          <div>Like-for-like<strong>${r.fair ? fmt$(r.fair.value) : "—"}</strong></div><div>Setmates median<strong>${r.mates ? fmt$(r.mates.median) : "—"}</strong></div>
          <div>Break-even sale<strong>${fmt$(r.breakeven)}</strong></div><div>Released<strong>${esc(r.release || "—")}</strong></div>
        </div></div>
        ${peers.length > 1 ? `<div class="card"><h3>Similar cards you're tracking</h3>
          <p class="small muted" style="margin:0 0 8px">${esc(r.pokemon)} · ${esc(r.tierLabel)} · ${esc(r.eraLabel)}${r.fair ? `. Like-for-like median: ${fmt$(r.fair.value)}` : ""}</p>
          <table class="peers"><tbody>${peers.map((x) => `<tr class="${x.id === r.id ? "me" : ""}" data-open-single="${x.id}"><td>${esc(x.name)} <span class="muted small">${esc(x.setName)}</span></td><td class="num">${fmt$(x.price)}</td><td>${sigPill(x.signal)}</td></tr>`).join("")}</tbody></table>
        </div>` : ""}
        <div class="card"><h3>Your collection</h3>
          ${(() => { const own = (C.S.col?.items || []).filter((x) => String(x.id) === String(r.id)); return own.length ? `<p class="small" style="margin:0 0 8px">You have ${own.reduce((a, x) => a + x.qty, 0)} (${own.map((x) => `${x.qty}${x.grade ? " " + esc(x.grade) : ""}${x.cost != null ? " @ " + fmt$(x.cost) : ""}`).join(", ")}). Edit them on the <a href="#collection">Collection</a> tab.</p>` : ""; })()}
          <div class="actions"><button class="btn" id="addcol">Add to collection</button></div>
        </div>
        <div class="actions">
          <button class="btn primary" id="ask">Ask Claude for a second opinion</button>
          ${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open on TCGplayer</a>` : ""}
        </div>
      </div>`;
    const draw = () => {
      const days = { "3m": 90, "1y": 365, all: null }[state.range];
      const psa = state.sChart === "psa" && hasPsaHist;
      const refs = !psa && r.target != null ? [{ value: r.target, label: "Buy " + fmt$(r.target), cls: "series-target" }] : [];
      Charts.priceChart($("#chart"), sPts(psa ? "g:" + r.id : r.id, days), refs);
      $("#slegend").innerHTML = psa ? "<span>PSA 10 price (Scrydex)</span>" : `<span>Raw near-mint price</span>${refs.length ? '<span class="l-target">Buy under</span>' : ""}`;
    };
    if (sheet.getAttribute("aria-hidden") !== "false") { sheet.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; panel.querySelector("[data-close]").focus(); }
    draw();
    panel.querySelectorAll("[data-range]").forEach((x) => x.onclick = () => { state.range = x.dataset.range; panel.querySelectorAll("[data-range]").forEach((y) => y.setAttribute("aria-pressed", y === x)); draw(); });
    panel.querySelectorAll("[data-copy]").forEach((x) => x.onclick = () => { state.sChart = x.dataset.copy; panel.querySelectorAll("[data-copy]").forEach((y) => y.setAttribute("aria-pressed", y === x)); draw(); });
    $("#star").onclick = (e) => {
      const k = String(r.id); state.watch.has(k) ? state.watch.delete(k) : state.watch.add(k); store.set(LS.watch, [...state.watch]);
      e.currentTarget.setAttribute("aria-pressed", state.watch.has(k)); toast(state.watch.has(k) ? "Added to watchlist." : "Removed from watchlist.");
    };
    $("#addcol").onclick = () => openCollectionAdd({ pick: { lang: r.lang === "ja" ? "ja" : "en", id: r.id } });
    panel.querySelectorAll("[data-rmlot]").forEach((x) => x.onclick = () => { state.holdings[r.id].splice(+x.dataset.rmlot, 1); if (!state.holdings[r.id].length) delete state.holdings[r.id]; store.set(LS.hold, state.holdings); openSingle(r.id); });
    $("#ask").onclick = () => askClaude(S.claudePrompt(r, state.singles.priceDate, b));
  }

  /* ---------------------------------------------------------- products --- */
  function renderProducts() {
    const f = state.filters;
    const types = [...new Set(state.rows.map((r) => r.type))];
    const mons = settings().chasePokemon.map((c) => c.name);
    $("#main").innerHTML = `
      <h1>All tracked sealed</h1>
      <p class="lede">${state.rows.length} products across ${state.meta.sets.length} chase sets. Click any row for the full read.</p>
      <div class="controls">
        <input type="search" id="q" placeholder="Search product or set" value="${esc(f.q)}" aria-label="Search">
        <select id="ftype" aria-label="Format"><option value="">All formats</option>${types.map((t) => `<option value="${t}" ${f.type === t ? "selected" : ""}>${E.TYPE_LABEL[t] || t}</option>`).join("")}</select>
        <select id="fsig" aria-label="Signal"><option value="">All signals</option>${Object.entries(E.SIGNALS).filter(([k]) => k !== "verify").map(([k, v]) => `<option value="${k}" ${f.signal === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
        <select id="fmon" aria-label="Chase Pokémon"><option value="">Any chase Pokémon</option>${mons.map((m) => `<option ${f.pokemon === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select>
      </div>
      <div id="ptable"></div>`;
    const upd = () => { f.q = $("#q").value; f.type = $("#ftype").value; f.signal = $("#fsig").value; f.pokemon = $("#fmon").value; drawTable(); };
    ["#q", "#ftype", "#fsig", "#fmon"].forEach((s) => $(s).addEventListener("input", upd));
    drawTable();
  }

  const COLS = [
    { k: "name", label: "Product", get: (r) => r.name },
    { k: "price", label: "Market", num: true, get: (r) => r.price },
    { k: "target", label: "Buy under", num: true, get: (r) => r.target },
    { k: "gap", label: "vs target", num: true, get: (r) => r.gap ?? 999 },
    { k: "ch30", label: "30d", num: true, get: (r) => r.stats.ch30 ?? -999 },
    { k: "ch365", label: "1y", num: true, get: (r) => r.stats.ch365 ?? -999 },
    { k: "mult", label: "× retail", num: true, get: (r) => r.mult ?? 0 },
    { k: "rank", label: "Signal", get: (r) => E.SIGNALS[r.signal].rank * 1000 - r.score },
    { k: "score", label: "Score", num: true, get: (r) => r.score },
  ];

  function filtered() {
    const f = state.filters; const q = f.q.trim().toLowerCase();
    let rows = state.rows.filter((r) =>
      (!q || (r.name + " " + r.set.name).toLowerCase().includes(q)) && (!f.type || r.type === f.type) && (!f.signal || r.signal === f.signal) &&
      (!f.pokemon || (r.chaseInfo.iconic || []).some((c) => c.pokemon === f.pokemon) || r.chaseInfo.pokemon === f.pokemon));
    const col = COLS.find((c) => c.k === f.sort) || COLS[7];
    rows.sort((a, b) => { const x = col.get(a), y = col.get(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * f.dir; });
    return rows;
  }

  function drawTable() {
    const rows = filtered(); const f = state.filters;
    const head = COLS.map((c) => `<th class="${c.num ? "num" : ""}" ${f.sort === c.k ? `aria-sort="${f.dir > 0 ? "ascending" : "descending"}"` : ""}><button data-sort="${c.k}">${c.label}</button></th>`).join("");
    const body = rows.map((r) => `<tr data-open="${r.id}">
        <td><div class="pname">${esc(r.name)}</div><div class="pset">${esc(r.set.name)} · ${esc(E.TYPE_LABEL[r.type])}</div></td>
        <td class="num">${fmt$(r.price)}</td><td class="num">${fmt$(r.target)}</td><td class="num">${pct(r.gap)}</td>
        <td class="num">${pct(r.stats.ch30)}</td><td class="num">${pct(r.stats.ch365)}</td><td class="num">${r.mult ? r.mult.toFixed(2) + "×" : "—"}</td>
        <td>${sigPill(r.signal)}<div>${confPill(r)}</div></td><td class="num">${r.score}<span class="score-bar"><span style="width:${r.score}%"></span></span></td></tr>`).join("");
    const list = rows.map((r) => `<div class="list-item" data-open="${r.id}" role="button" tabindex="0">
        <div><div class="pname">${esc(r.name)}</div><div class="pset">${esc(r.set.name)}</div></div>
        <div style="text-align:right"><strong class="price">${fmt$(r.price)}</strong><div class="small muted">under ${fmt$(r.target)}</div></div>
        <div>${sigPill(r.signal)} ${confPill(r)}</div><div class="small" style="text-align:right">30d ${pct(r.stats.ch30)}</div></div>`).join("");
    $("#ptable").innerHTML = rows.length
      ? `<div class="table-wrap collapsible"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><div class="list list-wrap">${list}</div>`
      : `<div class="empty">No products match those filters.</div>`;
    $("#ptable").querySelectorAll("[data-sort]").forEach((b) => b.onclick = () => { const k = b.dataset.sort; if (f.sort === k) f.dir *= -1; else { f.sort = k; f.dir = k === "rank" || k === "name" ? 1 : -1; } drawTable(); });
  }

  /* -------------------------------------------------------------- sets --- */
  function renderSets() {
    const sets = new Map();
    for (const r of state.rows) sets.set(r.set.id, r.set);
    const list = [...sets.values()].sort((a, b) => b.chase.score - a.chase.score);
    const best = (s) => state.rows.filter((r) => r.set.id === s.id).sort((a, b) => E.SIGNALS[a.signal].rank - E.SIGNALS[b.signal].rank || b.score - a.score)[0];
    $("#main").innerHTML = `
      <h1>Chase sets</h1>
      <p class="lede">Sets where a card from your chase list sells for at least $${state.config.tracking.minChaseCardPrice}. Chase score blends the strongest chase card, how many big hits there are, and the depth of the top 10 singles.</p>
      <div class="table-wrap" style="margin-top:16px"><table>
        <thead><tr><th>Set</th><th>Released</th><th>Phase</th><th class="num">Chase score</th><th>Top chase cards</th><th class="num">Chase singles 90d</th><th>Best sealed call</th></tr></thead>
        <tbody>${list.map((s) => { const b = best(s); return `<tr ${b ? `data-open="${b.id}"` : ""}>
          <td class="pname">${esc(s.name)}${s.kind === "catchall" ? '<div class="small muted">Catch-all group, not a set — products are scored one by one</div>' : ""}</td><td style="white-space:nowrap">${esc(s.release || "—")}</td><td>${s.kind === "catchall" ? '<span class="muted">—</span>' : esc(E.PHASES[s.phase].label)}</td>
          <td class="num">${s.kind === "catchall" ? '<span class="muted">—</span>' : `${s.chase.score.toFixed(0)} <span class="muted small">${s.chase.tier}</span>`}</td>
          <td class="small">${s.kind === "catchall" ? '<span class="muted">Not one set\'s cards</span>' : s.chase.iconic.slice(0, 3).map((c) => `${esc(c.name)} <span class="muted">${fmt$(c.price)}</span>`).join("<br>") || '<span class="muted">none from your list</span>'}</td>
          <td class="num">${pct(s.singlesStats.ch90)}</td><td>${b ? `${sigPill(b.signal)}<div class="small muted">${esc(E.TYPE_LABEL[b.type])}</div>` : ""}</td></tr>`; }).join("")}</tbody>
      </table></div>`;
  }

  /* --------------------------------------------------------- portfolio --- */
  function renderPortfolio() {
    const ids = new Set([...state.watch, ...Object.keys(state.holdings)]);
    const rows = [...ids].map((id) => anyById(id)).filter(Boolean);
    let cost = 0, value = 0;
    const holdRows = rows.filter((r) => (state.holdings[r.id] || []).length).map((r) => {
      const lots = state.holdings[r.id]; const qty = lots.reduce((a, l) => a + l.qty, 0); const c = lots.reduce((a, l) => a + l.qty * l.cost, 0);
      cost += c; value += qty * r.price; return { r, qty, c, v: qty * r.price };
    });
    const watchRows = rows.filter((r) => state.watch.has(String(r.id)));
    $("#main").innerHTML = `
      <h1>Watchlist</h1>
      <p class="lede">Your watchlist lives in this browser only. What you own is now in <a href="#collection">Collection</a>, saved privately and synced between devices.</p>
      <div class="controls"><button class="btn" id="exp">Export backup</button><label class="btn">Import backup<input type="file" id="imp" accept="application/json" hidden></label></div>
      <section class="section">
        ${watchRows.length ? `<div class="slabs">${watchRows.filter((r) => r.kind !== "single").map(slab).join("")}</div>${watchRows.some((r) => r.kind === "single") ? `<div class="slabs cards" style="margin-top:16px">${watchRows.filter((r) => r.kind === "single").map(cardSlab).join("")}</div>` : ""}` : `<div class="empty">Star products from their detail view to watch them. Watched items that drop under target show at the top of Picks.</div>`}
      </section>`;
    $("#exp").onclick = () => {
      const blob = new Blob([JSON.stringify({ watch: [...state.watch], holdings: state.holdings, settings: store.get(LS.settings, {}) }, null, 1)], { type: "application/json" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sealed-vault-backup-${state.meta.priceDate}.json`; a.click();
    };
    $("#imp").onchange = async (e) => {
      try {
        const j = JSON.parse(await e.target.files[0].text());
        state.watch = new Set(j.watch || []); state.holdings = j.holdings || {};
        store.set(LS.watch, [...state.watch]); store.set(LS.hold, state.holdings); if (j.settings) store.set(LS.settings, j.settings);
        recompute(); renderPortfolio(); toast("Backup imported.");
      } catch { toast("That file isn't a Sealed Vault backup."); }
    };
  }

  /* -------------------------------------------------------- collection --- */
  const C = window.Collection;
  const colCtx = () => ({ psa10: state.singles?.psa10 || {}, publicSeries: (id) => state.history?.series?.[String(id)] || state.singlesHistory?.series?.[String(id)] || null });
  const GRADES = ["", "PSA 10", "PSA 9", "PSA 8", "PSA 7", "BGS 10", "BGS 9.5", "BGS 9", "CGC 10", "CGC 9.5", "CGC 9", "TAG 10", "Other graded"];
  const langBadge = (l) => (l === "ja" ? '<span class="lang-ja">JP</span> ' : "");
  let colLoaded = false;

  async function renderCollection() {
    const main = $("#main");
    if (!C.conf()) { renderCollectionSetup(); return; }
    if (!colLoaded) {
      main.innerHTML = `<h1>Collection</h1><p class="lede">Loading your collection…</p>`;
      colLoaded = true;
      await Promise.all([C.loadCollection(), C.loadCatalog("en")]);
      if ((C.S.col?.items || []).some((i) => i.lang === "ja")) await C.loadCatalog("ja");
      if ($("#main").dataset.view === "collection") renderCollection();
      return;
    }
    const items = C.S.col?.items || [];
    const ctx = colCtx();
    const t = C.totals(items, ctx);
    const q = (state.colQ || "").toLowerCase();
    const shown = items.filter((it) => !q || `${it.name} ${it.number || ""} ${it.set || ""}`.toLowerCase().includes(q));
    // Group by set (TCGplayer group), oldest set first; cards by number, sealed after cards.
    const sets = new Map();
    for (const it of shown) {
      const k = `${it.lang || "en"}:${it.groupId}`;
      const g = C.S.catalog[it.lang || "en"]?.groups.get(Number(it.groupId));
      if (!sets.has(k)) sets.set(k, { name: g?.name || it.set || "Unknown set", release: g?.release || "", lang: it.lang || "en", items: [] });
      sets.get(k).items.push(it);
    }
    const nk = (it) => { const k = C.numKey(it.number); return k ? `${k.pre}${String(k.n).padStart(4, "0")}${k.suf}` : "zzzz"; };
    const setList = [...sets.values()].sort((a, b) => (a.release || "9999").localeCompare(b.release || "9999") || a.name.localeCompare(b.name));
    for (const s of setList) s.items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "sealed" ? 1 : -1) || nk(a).localeCompare(nk(b)) || a.name.localeCompare(b.name));
    const profitPct = t.cost > 0 ? (t.profit / t.cost) * 100 : null;
    const oldLots = Object.values(state.holdings || {}).reduce((a, l) => a + l.length, 0);
    main.innerHTML = `
      <div class="section-head" style="margin-top:0"><h1 style="margin:0">Collection</h1>
        <div class="actions"><button class="btn primary" id="col-add">Add cards or sealed</button><button class="btn" id="col-refresh" title="Reload from GitHub">Refresh</button></div></div>
      ${C.S.error ? `<div class="card warn-card" role="alert" style="margin-top:12px">${esc(C.S.error)}</div>` : ""}
      <div class="kv col-totals" style="margin-top:14px">
        <div>Market value<strong>${fmt$(t.value)}</strong></div>
        <div>You paid<strong>${fmt$(t.cost)}</strong></div>
        <div>Profit<strong class="${t.profit >= 0 ? "up" : "down"}">${t.profit >= 0 ? "+" : "−"}${fmt$(Math.abs(t.profit))}${profitPct != null ? ` <span class="small">(${fmtPct(profitPct)})</span>` : ""}</strong></div>
        <div>Items<strong>${items.reduce((a, i) => a + i.qty, 0)}</strong></div>
        ${t.sealedPaid > 0 ? `<div>Sealed: paid → now<strong>${fmt$(t.sealedPaid)} → ${fmt$(t.sealedValue)}</strong></div>` : ""}
      </div>
      <p class="small muted" style="margin:8px 0 0">Cards with no price entered count as pulled ($0 cost).${t.sealedNoCost ? ` <strong>${t.sealedNoCost} sealed item${t.sealedNoCost === 1 ? " has" : "s have"} no price paid</strong> — left out of profit until you add it.` : ""}${t.missing ? ` ${t.missing} item${t.missing === 1 ? " has" : "s have"} no market price on TCGplayer.` : ""}</p>
      ${oldLots ? `<div class="card" style="margin-top:12px"><p style="margin:0 0 8px">${oldLots} holding${oldLots === 1 ? "" : "s"} from the old “My vault” list are saved in this browser only.</p><button class="btn" id="col-import">Move them into your collection</button></div>` : ""}
      ${items.length ? `<div class="card" style="margin-top:16px">
        <div class="section-head" style="margin:0 0 8px"><h3 style="margin:0">Value over time</h3>
          <div class="seg" role="group" aria-label="What to chart"><button data-cv="all" aria-pressed="${state.colChart !== "added"}">What it's all worth</button><button data-cv="added" aria-pressed="${state.colChart === "added"}">Since I added each</button></div></div>
        <div id="col-chart"></div>
        <p class="small muted" style="margin:6px 0 0">Market value of what's in your collection now, from daily prices. Graded items are left out of the chart. Items without older prices count at their first known price.</p>
      </div>` : ""}
      <div class="controls" style="margin-top:16px"><input type="search" id="col-q" placeholder="Search your collection" value="${esc(state.colQ || "")}" aria-label="Search your collection"></div>
      ${items.length ? setList.map((s) => {
        const sv = s.items.reduce((a, it) => a + (C.itemValue(it, ctx).total || 0), 0);
        return `<section class="col-set"><div class="section-head"><h2>${langBadge(s.lang)}${esc(s.name)} <span class="muted small">${esc((s.release || "").slice(0, 4))}</span></h2><span class="small">${s.items.reduce((a, i) => a + i.qty, 0)} · ${fmt$(sv)}</span></div>
          <div class="table-wrap"><table class="col-table"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Paid each</th><th class="num">Market each</th><th class="num">Value</th><th class="num">Gain</th></tr></thead><tbody>
          ${s.items.map((it) => { const v = C.itemValue(it, ctx), cb = C.costBasis(it); const gain = v.total != null && cb.known ? v.total - cb.total : null;
            return `<tr class="col-row" data-col-edit="${esc(it.uid)}" tabindex="0"><td><div class="col-item"><img src="${C.IMG(it.id)}" alt="" loading="lazy"><div><div class="pname">${esc(it.name)}</div><div class="pset">${it.number ? esc(it.number) + " · " : ""}${esc(it.kind === "sealed" ? "Sealed" : it.sub || "")}${it.grade ? ` · <strong>${esc(it.grade)}</strong>` : ""}</div></div></div></td>
              <td class="num">${it.qty}</td><td class="num">${it.cost != null ? fmt$(it.cost) : it.kind === "single" ? '<span class="muted">pulled</span>' : '<span class="down small">add price</span>'}</td>
              <td class="num">${v.unit != null ? fmt$(v.unit) : "—"}${it.grade && v.how !== "market" ? `<div class="muted small">${esc(v.how)}</div>` : ""}</td><td class="num">${v.total != null ? fmt$(v.total) : "—"}</td>
              <td class="num">${gain == null ? "—" : `<span class="${gain >= 0 ? "up" : "down"}">${gain >= 0 ? "+" : "−"}${fmt$(Math.abs(gain))}</span>`}</td></tr>`; }).join("")}
          </tbody></table></div></section>`; }).join("") : `<div class="empty">Nothing here yet. Use “Add cards or sealed” to search, or scan a card with your phone's camera.</div>`}
      <p class="small muted" style="margin-top:20px">Saved to <code>${esc(C.conf().repo)}</code> (private). <button class="btn ghost small" id="col-setup">Connection settings</button></p>`;
    $("#col-add").onclick = () => openCollectionAdd();
    $("#col-refresh").onclick = async () => { colLoaded = false; await C.loadCollection(true); renderCollection(); };
    $("#col-setup").onclick = () => renderCollectionSetup();
    $("#col-q").oninput = (e) => { state.colQ = e.target.value; const pos = e.target.selectionStart; renderCollection(); const n = $("#col-q"); n.focus(); n.setSelectionRange(pos, pos); };
    document.querySelectorAll("[data-col-edit]").forEach((tr) => { tr.onclick = () => openCollectionEdit(tr.dataset.colEdit); tr.onkeydown = (e) => { if (e.key === "Enter") tr.click(); }; });
    document.querySelectorAll("[data-cv]").forEach((b) => b.onclick = () => { state.colChart = b.dataset.cv; renderCollection(); });
    if ($("#col-import")) $("#col-import").onclick = importOldHoldings;
    if (items.length) Charts.priceChart($("#col-chart"), C.valueSeries(items, ctx, state.colChart === "added"), []);
  }
  window.addEventListener("collection:history", () => { if ($("#main").dataset.view === "collection") renderCollection(); });

  async function importOldHoldings() {
    const add = [];
    for (const [id, lots] of Object.entries(state.holdings || {})) {
      const r = anyById(id); if (!r) continue;
      for (const l of lots) add.push({ uid: C.uid(), id: Number(id), lang: r.lang === "ja" ? "ja" : "en", kind: r.kind === "single" ? "single" : "sealed", groupId: r.kind === "single" ? (r.groupId ?? null) : r.groupId ?? r.set?.id, name: r.name, number: r.number || "", set: r.group || r.set?.name || "", sub: r.sub || null, qty: l.qty, cost: l.cost ?? null, grade: null, added: l.date || C.today(), note: l.note || "" });
    }
    // Fill missing group ids from the catalog.
    await C.loadCatalog("en"); await C.loadCatalog("ja");
    for (const a of add) { const c = C.catItem(a); if (c) { a.groupId = c.gid; a.set = c.set; } }
    const ok = await C.mutate((col) => col.items.push(...add), `Import ${add.length} holdings`);
    if (ok) { state.holdings = {}; store.set(LS.hold, {}); }
    toast(ok ? `Moved ${add.length} holdings into your collection.` : "Couldn't save to GitHub — try again.");
    renderCollection();
  }

  function renderCollectionSetup() {
    const c = C.conf() || {};
    $("#main").innerHTML = `
      <h1>Collection</h1>
      <p class="lede">Your collection is saved in a <strong>private</strong> GitHub repo, so nobody visiting this site can see what you own or what you paid. One-time setup, about five minutes:</p>
      <div class="card" style="margin-top:16px"><ol class="setup-steps">
        <li><strong>Create a private repo.</strong> <a href="https://github.com/new?name=sealed-vault-collection&visibility=private" target="_blank" rel="noopener">Open github.com/new</a>, name it <code>sealed-vault-collection</code>, choose <strong>Private</strong>, and create it.</li>
        <li><strong>Create a token.</strong> <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Open the fine-grained token page</a>. Name it “Sealed Vault”, pick an expiration (up to a year), under <em>Repository access</em> choose <strong>Only select repositories</strong> → <code>sealed-vault-collection</code>, and under <em>Permissions → Repository permissions</em> set <strong>Contents: Read and write</strong>. Generate it and copy it.</li>
        <li><strong>Paste it below</strong> and press Connect. Do the same on your phone (or on your computer) — the token is only kept in the browser you paste it into.</li>
        <li><strong>Turn on daily value history.</strong> In <a href="https://github.com/JWilliamson25/sealed-vault/settings/secrets/actions/new" target="_blank" rel="noopener">sealed-vault → Settings → Secrets and variables → Actions</a>, add a secret named <code>COLLECTION_TOKEN</code> with the same token. ${c.repo && c.repo !== C.DEFAULT_REPO ? `Since your repo isn't the default name, also add a <em>variable</em> <code>COLLECTION_REPO</code> = <code>${esc(c.repo)}</code>.` : ""}</li>
      </ol></div>
      <div class="card" style="margin-top:16px"><div class="form-grid">
        <label class="field">Private repo (owner/name)<input id="cs-repo" value="${esc(c.repo || C.DEFAULT_REPO)}" autocomplete="off" spellcheck="false"></label>
        <label class="field">Token<input id="cs-token" type="password" value="${esc(c.token || "")}" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
      </div>
      <div class="actions" style="margin-top:12px"><button class="btn primary" id="cs-save">Connect</button>${c.token ? '<button class="btn" id="cs-forget">Forget on this device</button>' : ""}${C.conf() ? '<button class="btn ghost" id="cs-back">Back to collection</button>' : ""}</div>
      <p class="small muted" style="margin:10px 0 0" id="cs-msg"></p></div>`;
    $("#cs-save").onclick = async () => {
      const repo = $("#cs-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, ""), token = $("#cs-token").value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) { $("#cs-msg").textContent = "Enter the repo as owner/name and paste the token."; return; }
      $("#cs-msg").textContent = "Checking…";
      const prev = C.conf(); C.setConf({ repo, token });
      try {
        const { json } = await C.readFile("collection.json");
        if (!json) await C.mutate(() => {}, "Start collection");
        colLoaded = false; toast("Connected."); renderCollection();
      } catch (e) {
        if (prev) C.setConf(prev); else C.clearConf();
        $("#cs-msg").textContent = e.status === 401 ? "GitHub refused that token. Copy it again (it starts with github_pat_)." : e.status === 403 ? "That token can't use this repo. Give it Contents: Read and write on the repo." : `Couldn't reach the repo (${e.message}). Check the name and that the token has access to it.`;
      }
    };
    if ($("#cs-forget")) $("#cs-forget").onclick = () => { C.clearConf(); colLoaded = false; toast("Token removed from this device."); renderCollectionSetup(); };
    if ($("#cs-back")) $("#cs-back").onclick = () => renderCollection();
  }

  /* add / scan / edit sheet */
  function showSheet(html) {
    const sheet = $("#sheet"), panel = $("#sheet-panel");
    panel.innerHTML = html;
    if (sheet.getAttribute("aria-hidden") !== "false") { sheet.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; }
    return panel;
  }
  function hideSheet() { const sheet = $("#sheet"); sheet.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; }

  function resultList(list) {
    if (!list.length) return `<p class="muted small">No matches. Try fewer words, or the card number like <code>TG06</code> or <code>4/102</code>.</p>`;
    return `<div class="pick-list">${list.map((it) => `<button class="pick" data-pick="${it.lang}:${it.id}">
      <img src="${C.IMG(it.id)}" alt="" loading="lazy"><span class="pick-text"><span class="pname">${langBadge(it.lang)}${esc(it.name)}</span>
      <span class="pset">${esc(it.set)}${it.number ? ` · ${esc(it.number)}` : ""}${it.kind === "p" ? " · Sealed" : ""}</span></span>
      <span class="price">${it.best != null ? fmt$(it.best) : "—"}</span></button>`).join("")}</div>`;
  }

  async function openCollectionAdd(opts = {}) {
    if (!C.conf()) { location.hash = "#collection"; toast("Set up your collection first."); return; }
    const st = state.colAdd ||= { mode: "search", q: "", lang: "en", kind: "all" };
    const panel = showSheet(`
      <div class="sheet-head"><div><h2 id="sheet-title">Add to collection</h2></div><button class="btn ghost" id="ca-close" aria-label="Close">Close</button></div>
      <div class="sheet-body">
        <div class="seg" role="group" aria-label="How to add"><button data-mode="search" aria-pressed="${st.mode === "search"}">Search</button><button data-mode="scan" aria-pressed="${st.mode === "scan"}">Scan a card</button></div>
        <div id="ca-body" style="margin-top:12px"></div>
      </div>`);
    panel.querySelector("#ca-close").onclick = () => { hideSheet(); if ($("#main").dataset.view === "collection") renderCollection(); };
    panel.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { st.mode = b.dataset.mode; openCollectionAdd(); });
    const body = panel.querySelector("#ca-body");
    if (opts.pick) { await C.loadCatalog(opts.pick.lang); const it = C.S.catalog[opts.pick.lang]?.byId.get(Number(opts.pick.id)); if (it) return itemForm(body, it, null); }
    if (st.mode === "search") {
      body.innerHTML = `<div class="controls" style="margin:0">
          <input type="search" id="ca-q" placeholder="Name, number or set — e.g. gengar tg06, charizard delta, 151 booster box" value="${esc(st.q)}" aria-label="Search for a card or product" style="flex:1 1 260px">
          <select id="ca-lang" aria-label="Language"><option value="en" ${st.lang === "en" ? "selected" : ""}>English</option><option value="ja" ${st.lang === "ja" ? "selected" : ""}>Japanese</option><option value="both" ${st.lang === "both" ? "selected" : ""}>Both</option></select>
          <select id="ca-kind" aria-label="Type"><option value="all">Cards & sealed</option><option value="single" ${st.kind === "single" ? "selected" : ""}>Cards</option><option value="sealed" ${st.kind === "sealed" ? "selected" : ""}>Sealed</option></select></div>
        <p class="small muted" id="ca-status" style="margin:8px 0">Loading the card list…</p><div id="ca-results"></div>`;
      const run = async () => {
        st.q = $("#ca-q").value; st.lang = $("#ca-lang").value; st.kind = $("#ca-kind").value;
        const langs = st.lang === "both" ? ["en", "ja"] : [st.lang];
        await Promise.all(langs.map(C.loadCatalog));
        const res = st.q.trim().length >= 2 ? C.search(st.q, { lang: st.lang, kind: st.kind }) : [];
        $("#ca-status").textContent = st.q.trim().length < 2 ? "Type at least two letters. Every word has to match; numbers match the card number." : `${res.length === 40 ? "Top 40" : res.length} possible match${res.length === 1 ? "" : "es"} — pick yours:`;
        $("#ca-results").innerHTML = st.q.trim().length >= 2 ? resultList(res) : "";
        bindPicks(body);
      };
      let tm; $("#ca-q").oninput = () => { clearTimeout(tm); tm = setTimeout(run, 200); };
      $("#ca-lang").onchange = run; $("#ca-kind").onchange = run;
      $("#ca-q").focus(); run();
    } else {
      body.innerHTML = `<p class="small" style="margin:0 0 10px">Take a photo of the card straight on, in good light, with the name and the number in the bottom corner readable. You'll get a list of possible matches to pick from.</p>
        <label class="btn primary">Take or choose a photo<input type="file" id="ca-photo" accept="image/*" capture="environment" hidden></label>
        <div id="ca-scan" style="margin-top:12px"></div>`;
      $("#ca-photo").onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const out = $("#ca-scan");
        out.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="Your photo" class="scan-preview"><p class="small muted" id="ca-sstat">Loading…</p>`;
        try {
          await Promise.all([C.loadCatalog("en"), C.loadCatalog("ja")]);
          const r = await C.scan(f, (m) => { const s = $("#ca-sstat"); if (s) s.textContent = m; });
          out.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="Your photo" class="scan-preview">
            <p class="small" style="margin:8px 0">${r.nums.length || r.nameWords.length ? `Read: <strong>${esc([...r.nameWords, ...r.nums].join(", "))}</strong>.` : "Couldn't read the name or number — try another photo, or search below."} Not right? Edit the search:</p>
            <div class="controls" style="margin:0"><input type="search" id="ca-sq" value="${esc(r.query)}" aria-label="Search" style="flex:1"><button class="btn" id="ca-sgo">Search</button></div>
            <div id="ca-sres" style="margin-top:10px">${resultList(r.results)}</div>`;
          bindPicks(body);
          $("#ca-sgo").onclick = () => { $("#ca-sres").innerHTML = resultList(C.search($("#ca-sq").value, { lang: "both" })); bindPicks(body); };
        } catch (err) { out.innerHTML = `<p class="down">Scanning didn't work here (${esc(err.message)}). Use Search instead.</p>`; }
      };
    }
  }
  function bindPicks(body) {
    body.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => { const [l, id] = b.dataset.pick.split(":"); itemForm(body, C.S.catalog[l].byId.get(Number(id)), null); });
  }

  function itemForm(body, it, existing) {
    const subs = Object.entries(it.prices);
    const e = existing || {};
    const defSub = e.sub || (subs.length ? subs.sort((a, b) => b[1] - a[1])[0][0] : "");
    const owned = (C.S.col?.items || []).filter((x) => x.id === it.id && x.uid !== e.uid).reduce((a, x) => a + x.qty, 0);
    body.innerHTML = `
      <div class="col-form-head"><img src="${C.IMG(it.id)}" alt=""><div><div class="pname">${langBadge(it.lang)}${esc(it.name)}</div><div class="pset">${esc(it.set)}${it.number ? ` · ${esc(it.number)}` : ""}</div>
        <div class="small muted">${it.kind === "p" ? "Sealed product" : "Card"}${owned ? ` · you already have ${owned}` : ""}</div></div></div>
      <div class="form-grid" style="margin-top:12px">
        ${subs.length > 1 ? `<label class="field">Printing<select id="cf-sub">${subs.map(([s, p]) => `<option value="${esc(s)}" ${s === defSub ? "selected" : ""}>${esc(s)} — ${fmt$(p)}</option>`).join("")}</select></label>` : `<input type="hidden" id="cf-sub" value="${esc(defSub)}">`}
        <label class="field">Quantity<input type="number" id="cf-qty" min="1" step="1" value="${e.qty || 1}"></label>
        <label class="field">Price paid each <span class="muted small">(optional)</span><input type="number" id="cf-cost" min="0" step="0.01" value="${e.cost ?? ""}" placeholder="${it.kind === "p" ? "What you paid" : "Blank = pulled it"}"></label>
        ${it.kind === "s" ? `<label class="field">Condition<select id="cf-grade">${GRADES.map((g) => `<option value="${g}" ${g === (e.grade || "") ? "selected" : ""}>${g || "Raw"}</option>`).join("")}</select></label>
        <label class="field" id="cf-gv-wrap" ${e.grade ? "" : "hidden"}>Graded value each <span class="muted small">(optional)</span><input type="number" id="cf-gv" min="0" step="0.01" value="${e.gradedValue ?? ""}" placeholder="Leave blank for PSA 10 price"></label>` : ""}
        <label class="field">Date you got it<input type="date" id="cf-date" value="${e.added || C.today()}"></label>
        <label class="field" style="grid-column:1/-1">Note <span class="muted small">(optional)</span><input id="cf-note" value="${esc(e.note || "")}" maxlength="200"></label>
      </div>
      <p class="small muted" style="margin:8px 0 0">${it.kind === "p" ? "What you paid is subtracted from your profit. Leave it blank and this item stays out of the profit total until you add it." : "Leave the price blank if you pulled it — it counts as $0 cost."}</p>
      <div class="actions" style="margin-top:12px"><button class="btn primary" id="cf-save">${existing ? "Save changes" : "Add to collection"}</button>${existing ? '<button class="btn" id="cf-del">Remove from collection</button>' : '<button class="btn ghost" id="cf-back">Back to results</button>'}</div>`;
    const gsel = $("#cf-grade"); if (gsel) gsel.onchange = () => { $("#cf-gv-wrap").hidden = !gsel.value; };
    if ($("#cf-back")) $("#cf-back").onclick = () => openCollectionAdd();
    $("#cf-save").onclick = async () => {
      const qty = parseInt($("#cf-qty").value, 10);
      if (!(qty > 0)) { toast("Enter how many you have."); return; }
      const num = (id) => { const v = $(id)?.value; return v === "" || v == null ? null : Math.max(0, parseFloat(v)); };
      const rec = { uid: e.uid || C.uid(), id: it.id, lang: it.lang, kind: it.kind === "p" ? "sealed" : "single", groupId: it.gid, name: it.name, number: it.number || "", set: it.set,
        sub: $("#cf-sub")?.value || null, qty, cost: num("#cf-cost"), grade: $("#cf-grade")?.value || null, gradedValue: $("#cf-grade")?.value ? num("#cf-gv") : null,
        added: $("#cf-date").value || C.today(), note: $("#cf-note").value.trim() };
      $("#cf-save").disabled = true;
      const ok = await C.mutate((col) => { const i = col.items.findIndex((x) => x.uid === rec.uid); if (i >= 0) col.items[i] = rec; else col.items.push(rec); }, `${existing ? "Edit" : "Add"} ${rec.name}`);
      toast(ok ? (existing ? "Saved." : `Added ${rec.name}.`) : "Saved on this device; GitHub save failed — it'll retry.");
      if (existing) { hideSheet(); renderCollection(); } else { state.colAdd.q = ""; openCollectionAdd(); }
    };
    if ($("#cf-del")) $("#cf-del").onclick = async () => {
      await C.mutate((col) => { col.items = col.items.filter((x) => x.uid !== e.uid); }, `Remove ${e.name}`);
      toast("Removed."); hideSheet(); renderCollection();
    };
  }

  async function openCollectionEdit(u) {
    const e = (C.S.col?.items || []).find((x) => x.uid === u); if (!e) return;
    await C.loadCatalog(e.lang || "en");
    const it = C.catItem(e) || { id: e.id, lang: e.lang || "en", name: e.name, number: e.number, set: e.set, kind: e.kind === "sealed" ? "p" : "s", prices: {}, gid: e.groupId };
    const panel = showSheet(`<div class="sheet-head"><div><h2 id="sheet-title">Edit</h2></div><button class="btn ghost" id="ce-close" aria-label="Close">Close</button></div><div class="sheet-body" id="ce-body"></div>`);
    panel.querySelector("#ce-close").onclick = () => hideSheet();
    itemForm(panel.querySelector("#ce-body"), it, e);
  }

  /* ---------------------------------------------------------- settings --- */
  function renderSettings() {
    const s = settings();
    const types = Object.keys(state.config.retailReference).filter((k) => !k.startsWith("_"));
    $("#main").innerHTML = `
      <h1>Settings</h1>
      <p class="lede">Saved in this browser. To change which sets the daily sync tracks, edit <code>config.json</code> in your repository.</p>
      <div class="card" style="margin-top:16px"><h3>Chase Pokémon</h3>
        <p class="small muted">One per line as “Name, weight” (weight 0–1). Scores and signals update instantly. Sets are only pulled in by the sync if they match the list in config.json.</p>
        <label class="field"><span class="sr-only">Chase list</span><textarea id="chase">${esc(s.chasePokemon.map((c) => `${c.name}, ${c.weight ?? 1}`).join("\n"))}</textarea></label>
      </div>
      <div class="card" style="margin-top:16px"><h3>Singles budget</h3>
        <p class="small muted">What the Singles tab shows and calls buys. Cards slightly outside this range are still tracked so their history continues.</p>
        <div class="form-grid">
          <label class="field">Lowest price<input type="number" min="0" step="1" id="smin" value="${s.singles.budgetMin}"></label>
          <label class="field">Sweet spot up to<input type="number" min="0" step="1" id="ssweet" value="${s.singles.sweetSpotMax}"></label>
          <label class="field">Most you'd pay<input type="number" min="0" step="1" id="smax" value="${s.singles.budgetMax}"></label>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Risk profile</h3>
        <div class="seg" role="group" aria-label="Risk profile">${["conservative", "balanced", "aggressive"].map((k) => `<button data-risk="${k}" aria-pressed="${s.risk === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
        <p class="small muted">Conservative sets buy targets 5% lower; aggressive 5% higher.</p>
      </div>
      <div class="card" style="margin-top:16px"><h3>Retail reference prices</h3>
        <p class="small muted">Used for the “× retail” math and early-life targets. Only fill in formats with one fixed MSRP; leave the rest blank and set them per product in config.json → productOverrides. If unsure, a lower number is safer — a retail price that's too high creates fake buys.</p>
        <div class="form-grid">${types.map((t) => `<label class="field">${E.TYPE_LABEL[t] || t}<input type="number" step="0.01" min="0" data-retail="${t}" value="${s.retailReference[t] ?? ""}"></label>`).join("")}</div>
      </div>
      <div class="controls"><button class="btn primary" id="save">Save settings</button><button class="btn" id="reset">Reset to defaults</button></div>`;
    let risk = s.risk;
    document.querySelectorAll("[data-risk]").forEach((b) => b.onclick = () => { risk = b.dataset.risk; document.querySelectorAll("[data-risk]").forEach((x) => x.setAttribute("aria-pressed", x === b)); });
    $("#save").onclick = () => {
      const chasePokemon = $("#chase").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [n, w] = l.split(","); return { name: n.trim(), weight: Math.max(0, Math.min(1, parseFloat(w) || 1)) }; });
      // Only keep the retail prices you actually changed from config.json.
      const retailReference = {}; document.querySelectorAll("[data-retail]").forEach((i) => {
        const v = i.value === "" ? null : parseFloat(i.value); const d = state.config.retailReference[i.dataset.retail] ?? null;
        if (v !== d) retailReference[i.dataset.retail] = v;
      });
      const sv = (id, d) => { const v = parseFloat($(id).value); return v >= 0 ? v : d; };
      const sing = { budgetMin: sv("#smin", 30), sweetSpotMax: sv("#ssweet", 100), budgetMax: sv("#smax", 300) };
      store.set(LS.settings, { ...store.get(LS.settings, {}), v: SETTINGS_V, cfgRetail: JSON.stringify(state.config.retailReference), chasePokemon, retailReference, risk, singles: sing });
      recompute(); toast("Settings saved. Signals updated.");
    };
    $("#reset").onclick = () => { store.set(LS.settings, {}); recompute(); renderSettings(); toast("Settings reset."); };
  }

  /* ------------------------------------------------------------- about --- */
  function renderAbout() {
    $("#main").innerHTML = `<div class="prose">
      <h1>How the calls are made</h1>
      <p class="lede">Every number here is TCGplayer's market price, pulled once a day. The signals are rules long-time sealed investors use, written down so they're applied the same way every day. It's a second brain, not a crystal ball.</p>
      <h2>What gets tracked</h2>
      <p>The daily sync reads every English Pokémon set on TCGplayer, finds the top singles in each (including Trainer Gallery and Galarian Gallery subsets), and keeps sets where a card featuring one of your chase Pokémon sells for at least $${state.config.tracking.minChaseCardPrice}. Booster boxes, ETBs, Pokémon Center ETBs, bundles, UPCs, collections, blisters, tins and packs from those sets are recorded.</p>
      <h2>The five things the score looks at</h2>
      <ul class="reasons">
        <li><strong>Chase strength (30%).</strong> Sealed only appreciates if people keep wanting to open it. A $1,000 Umbreon keeps a set alive; a $40 chase doesn't.</li>
        <li><strong>Entry price (25%).</strong> How far the market price is from the buy-under target.</li>
        <li><strong>Life-cycle phase (15%).</strong> Modern sets usually spike at release, sag while still printing, then climb once print ends around 12–24 months in. The late print-run trough and the out-of-print climb are the best windows.</li>
        <li><strong>Momentum (15%).</strong> Rewards bottoming and dips inside uptrends; penalises 30-day spikes and in-print slides; adds a bonus when chase singles are rising faster than sealed.</li>
        <li><strong>Format (15%).</strong> Booster boxes and cases hold value best, then Pokémon Center ETBs and premium collections, then ETBs and bundles. Loose packs and tins trail.</li>
      </ul>
      <h2>How the buy-under target is set</h2>
      <p>A target is never worked out from today's price. It comes from a known retail price early in a product's life, or from real price history after that: at least ${E.MIN_HIST_POINTS} daily prices in the last ${E.MIN_HIST_DAYS} days. A few scattered older snapshots don't count. With neither, the product shows “Not enough data.”</p>
      <ul class="reasons">
        <li>Brand new (under 2 months): around retail — let the release premium bleed out.</li>
        <li>Still printing (2–12 months): retail to 15% over retail, depending on chase strength.</li>
        <li>Out-of-print climb (12–24 months): just under the 90-day average — only once the set is confirmed out of print. Sets confirmed still reprinting stay on the retail-based target above, whatever their age. Print status is set per set under <code>setOverrides</code> in config.json.</li>
        <li>Established (2–4 years): about 7% under the 6-month average.</li>
        <li>Older than 4 years: about 5% under the 6-month average.</li>
      </ul>
      <h2>What the signals mean</h2>
      <ul class="reasons">
        <li>${sigPill("strong_buy")} At or under target and a strong overall score.</li>
        <li>${sigPill("buy")} At or very near target with a good score.</li>
        <li>${sigPill("accumulate")} A strong chase set slightly above target. Buy a piece, not the whole position.</li>
        <li>${sigPill("wait")} Good product, wrong price. Watch it.</li>
        <li>${sigPill("overheated")} Jumped over 25% in a month. Spikes usually give some back.</li>
        <li>${sigPill("falling")} Sliding more than 10% a month while still in print, or still sliding after a 15%+ drop over 90 days.</li>
        <li>${sigPill("pass")} Weak chase or weak format for a 4+ year hold.</li>
        <li>${sigPill("no_call")} No known retail price and not enough price history, or no chase cards to judge it by. No call is better than a guess.</li>
      </ul>
      <h2>Confidence</h2>
      <p>Every call checks five things: enough price history, a real release date, a known retail price, chase cards from the product's own set, and — for second-year sets — confirmed print status. <strong>Strong buy</strong> needs all five, and a price that isn't still drifting down. A second-year product above 2× retail is never a buy until its set is confirmed out of print. With thin history, the only calls made are against a known retail price, and they top out at Buy. Products in TCGplayer's catch-all groups (Miscellaneous, promos, POP series) aren't treated as part of a set; add their MSRP and release date under <code>productOverrides</code> in config.json.</p>
      <h2>Singles</h2>
      <p><strong>The five-step framework.</strong> Every card is run through five steps: <strong>1. the ceiling</strong> — its highest sale, same card, language and version; the buy-under price stays at least 25% under it; <strong>2. distribution</strong> — event, winner and staff promos are scarcest, then pack pulls, prerelease and prize-pack stamps, box promos, mass giveaways and reprints; <strong>3. the top-6 characters</strong> — Charizard, Pikachu, Gengar, Umbreon, Mew and Mewtwo, which carry 40% of the score; <strong>4. Full Art / SIR</strong> — the card types that hold value; <strong>5. graded data</strong> — a big PSA 10 population is fine while the PSA 10 price holds, and a warning when it slides. A card needn't pass every step (a Buy needs three and must not fail the ceiling), but a Strong buy passes all five — and price is the final filter. Japanese promos are tracked too (only promo-type groups, for the top 6, and only Japan-exclusive art — any whose artwork matches an English card are hidden), and compared only with other Japanese cards; their prices are TCGplayer's US sales, not Japan's own market. Everything is re-run daily, so a play this month can be a pass next month. The settings live in <code>config.json</code> → <code>singles.framework</code>.</p>
      <p>The daily sync tracks singles of the top-6 characters only (Charizard, Pikachu, Gengar, Umbreon, Mew, Mewtwo — <code>singles.framework.top6</code>); your full chase list still drives sealed products. It covers every one priced roughly ${fmt$(settings().singles.budgetMin)}–${fmt$(settings().singles.budgetMax)} (a little wider, so cards drifting past your budget keep their history). Each card is scored on the checklist an experienced buyer runs through:</p>
      <ul class="reasons">
        <li><strong>Character (40%).</strong> Top-6 characters score 100; the rest score by their weight in your chase list.</li>
        <li><strong>Card type (12%).</strong> Full Art / SIR-class cards (SIRs, alt arts, illustration rares, gallery V/VMAX, full arts, rainbows, golds) score high; plain gallery holos (Trainer Gallery, Galarian Gallery, Radiant Collection), regular rares, promos and reprints don't.</li>
        <li><strong>Value against like-for-like cards (6%).</strong> The median of the same card type and era — a Trainer Gallery holo is compared with gallery holos, never with illustration rares or alt arts. Its <em>setmates</em> (the same card type in the same set, any Pokémon) show how much of the price is the Pokémon rather than the card.</li>
        <li><strong>Ceiling and long-run range (15%).</strong> How far today's price sits under the ceiling, and where it sits in the longest range known: daily history plus researched two-year lows and highs. A card that ran up from its low isn't a discount when it gives some back; its buy-under price stays within 30% of the pre-run-up low and no more than a third of the way back up.</li>
        <li><strong>Momentum and hype (7%).</strong> Spikes, slides and flattened pullbacks, the card against the whole singles market, and its Pokémon: when a Pokémon's cards are up 30%+ in six months and well ahead of the market, it's a hype cycle — targets drop 7% and nothing is a Strong buy. New chase cards of the same Pokémon are flagged.</li>
        <li><strong>Distribution and supply (8%).</strong> How the card entered the market, where the set is in its print life and its recorded print status, and reprints of the same art.</li>
        <li><strong>Graded data (7%).</strong> PSA 10 and PSA 9 against raw, the PSA 10 price trend and the population: whether demand is absorbing the graded supply, and whether raw or a slab is the better way in.</li>
        <li><strong>Liquidity and costs (5%).</strong> Budget fit, real sold prices against TCGplayer's market price, the gap to the lowest listing, and the ~19% a card has to rise just to cover selling fees.</li>
      </ul>
      <p><strong>What it takes to be a buy.</strong> The buy-under price is the lowest of every anchor that applies: the card's own recent history, its pre-run-up level, like-for-like cards' median, and recent sold prices. It's never worked out from today's price. ${sigPill("verify")} means a card looks like a buy on its recent prices, but its price history is under a year and nobody has looked up where it traded before — exactly the case where a run-up giving some back looks like a discount. Once its ceiling or two-year low and high are recorded in <code>data/card_facts.json</code> (Ask Claude lists them; a weekly task can fill them in), the call updates on its own. <strong>Strong buy</strong> needs the long-run range, like-for-like peers, no hype cycle on the Pokémon, and agreeing PSA 10 prices.</p>
      <p>PSA 10 prices come from a one-time Scrydex import plus researched sales; when the two disagree, the sales win. Raw cards carry condition risk; buy clean near-mint copies with photos.</p>
      <h2>Collection</h2>
      <p>The Collection tab keeps what you own, grouped by set and sorted oldest set first. It's saved in a private GitHub repo using a token stored only in your browser, so visitors to this site can't see it. Add items by searching (every word must match; numbers match the card number) or by scanning a card with your phone — the photo is read on your device, never uploaded, and you pick the right card from the matches. Price paid is optional: a card with none counts as pulled ($0 cost); sealed with none stays out of profit until you add it. Values use today's TCGplayer price for the exact printing you picked; graded cards use the PSA 10 price when known or a value you enter. With the <code>COLLECTION_TOKEN</code> secret set, the daily sync records your items' prices so the value chart builds over time; anything the tracker already follows has history from the start.</p>
      <h2>What it can't see</h2>
      <p>Reprint announcements, Pokémon Center restocks, print-run sizes, sales volume, and — for singles — anything older than about six months unless it's been researched. Use “Ask Claude” on any product for a second opinion that checks current news. This isn't financial advice; prices can and do fall.</p>
      <p class="small muted">Data: TCGplayer prices via the free tcgcsv.com daily mirror. Not affiliated with TCGplayer, Nintendo, or The Pokémon Company.</p>
    </div>`;
  }

  /* ------------------------------------------------------------ detail --- */
  function openDetail(id) {
    const r = state.byId.get(String(id));
    if (!r) { location.hash = "#products"; return; }
    const sheet = $("#sheet"), panel = $("#sheet-panel");
    const watched = state.watch.has(String(r.id));
    const st = r.stats;
    const lots = state.holdings[r.id] || [];
    panel.innerHTML = `
      <div class="sheet-head">
        <div><div class="pset">${esc(r.set.name)} · ${esc(E.TYPE_LABEL[r.type])}</div><h2 id="sheet-title">${esc(r.name)}</h2></div>
        <div style="display:flex;gap:4px"><button class="star" id="star" aria-pressed="${watched}" aria-label="Watch this product" title="Watch">★</button><button class="btn ghost" data-close aria-label="Close">Close</button></div>
      </div>
      <div class="sheet-body">
        <div class="card verdict">
          <div><span class="big grade g-${r.signal}" style="text-align:left"><b>${E.SIGNALS[r.signal].label}</b></span>
          <p style="margin-top:8px">${r.target != null
            ? `Buy under <strong>${fmt$(r.target)}</strong> — ${esc(r.targetWhy)}. Market is ${fmt$(r.price)} (${Math.abs(Math.round(r.gap)) === 0 ? "right at" : Math.abs(Math.round(r.gap)) + "% " + (r.gap > 0 ? "over" : "under")} target).`
            : `No buy-under price yet — ${esc(r.targetWhy)}. Market is ${fmt$(r.price)}.`}</p>
          <p class="small" style="margin:6px 0 0">${confPill(r)}</p></div>
          ${thumb(r)}
        </div>
        <div class="card">
          <div class="section-head" style="margin:0 0 8px"><h3 style="margin:0">Price history</h3>
            <div class="seg" role="group" aria-label="Range">${[["3m", 90], ["1y", 365], ["all", null]].map(([k]) => `<button data-range="${k}" aria-pressed="${state.range === k}">${k === "all" ? "All" : k.toUpperCase()}</button>`).join("")}</div></div>
          <div id="chart"></div>
          <div class="legend"><span>Market price</span><span class="l-target">Buy under</span>${r.retail ? '<span class="l-retail">Retail</span>' : ""}</div>
        </div>
        <div class="card"><h3>Data checks</h3><ul class="checks">${r.checks.map((c) => `<li class="${c.ok ? "ok" : "miss"}"><span aria-hidden="true">${c.ok ? "✓" : "✕"}</span> ${esc(c.label)}</li>`).join("")}</ul>
          ${r.checks.some((c) => !c.ok && (c.k === "retail" || c.k === "release")) ? `<p class="small muted" style="margin:10px 0 0">Know the MSRP or release date? Add it under <code>productOverrides</code> in config.json with id <code>${r.id}</code>.</p>` : ""}
        </div>
        <div class="card"><h3>Why</h3><ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          ${r.benchmark ? `<p class="small muted" style="margin:12px 0 0">For a 4+ year view: ${esc(E.TYPE_LABEL[r.type])}s from other ${r.chaseInfo.tier.toLowerCase()}-chase sets that are 4–6 years old now trade at a median ${r.benchmark.median.toFixed(1)}× retail (${r.benchmark.n} products). Past sets aren't a promise.</p>` : ""}
        </div>
        <div class="card"><h3>Numbers</h3><div class="kv">
          <div>Market<strong>${fmt$(r.price)}</strong></div><div>TCGplayer low<strong>${fmt$(r.low)}</strong></div>
          <div>× retail<strong>${r.mult ? r.mult.toFixed(2) + "×" : "—"}</strong></div>
          <div>30 days<strong>${pct(st.ch30)}</strong></div><div>90 days<strong>${pct(st.ch90)}</strong></div><div>1 year<strong>${pct(st.ch365)}</strong></div>
          <div>90-day low<strong>${fmt$(st.low90)}</strong></div><div>1-year high<strong>${fmt$(st.high365)}</strong></div>
          <div>Score<strong>${r.score}/100</strong></div><div>Chase score<strong>${r.chase.toFixed(0)} ${esc(r.chaseInfo.tier)}</strong></div>
          <div>Phase<strong>${esc(E.PHASES[r.phase].label)}</strong></div><div>Retail<strong>${fmt$(r.retail)}</strong></div>
        </div></div>
        ${r.chaseSrc === "set" ? `<div class="card"><h3>What's carrying the set</h3>
          <table><tbody>${r.set.topSingles.slice(0, 8).map((c) => `<tr><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)} <span class="muted small">${esc(c.number || "")}</span></td><td class="num">${fmt$(c.price)}</td></tr>`).join("")}</tbody></table>
        </div>` : ""}
        <div class="card"><h3>Your collection</h3>
          ${(() => { const own = (C.S.col?.items || []).filter((x) => String(x.id) === String(r.id)); return own.length ? `<p class="small" style="margin:0 0 8px">You have ${own.reduce((a, x) => a + x.qty, 0)} (${own.map((x) => `${x.qty}${x.grade ? " " + esc(x.grade) : ""}${x.cost != null ? " @ " + fmt$(x.cost) : ""}`).join(", ")}). Edit them on the <a href="#collection">Collection</a> tab.</p>` : ""; })()}
          <div class="actions"><button class="btn" id="addcol">Add to collection</button></div>
        </div>
        <div class="actions">
          <button class="btn primary" id="ask">Ask Claude for a second opinion</button>
          ${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open on TCGplayer</a>` : ""}
        </div>
      </div>`;
    const draw = () => {
      const days = { "3m": 90, "1y": 365, all: null }[state.range];
      const refs = r.target != null ? [{ value: r.target, label: "Buy " + fmt$(r.target), cls: "series-target" }] : [];
      if (r.retail) refs.push({ value: r.retail, label: "Retail", cls: "series-retail" });
      Charts.priceChart($("#chart"), seriesPts(r.id, days), refs);
    };
    const wasHidden = sheet.getAttribute("aria-hidden") !== "false";
    if (sheet.getAttribute("aria-hidden") !== "false") { sheet.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; panel.querySelector("[data-close]").focus(); }
    draw();
    panel.querySelectorAll("[data-range]").forEach((b) => b.onclick = () => { state.range = b.dataset.range; panel.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", x === b)); draw(); });
    $("#star").onclick = (e) => {
      const k = String(r.id); state.watch.has(k) ? state.watch.delete(k) : state.watch.add(k); store.set(LS.watch, [...state.watch]);
      e.currentTarget.setAttribute("aria-pressed", state.watch.has(k)); toast(state.watch.has(k) ? "Added to watchlist." : "Removed from watchlist.");
    };
    $("#addcol").onclick = () => openCollectionAdd({ pick: { lang: r.lang === "ja" ? "ja" : "en", id: r.id } });
    panel.querySelectorAll("[data-rmlot]").forEach((b) => b.onclick = () => { state.holdings[r.id].splice(+b.dataset.rmlot, 1); if (!state.holdings[r.id].length) delete state.holdings[r.id]; store.set(LS.hold, state.holdings); openDetail(r.id); });
    $("#ask").onclick = () => askClaude(E.claudePrompt(r, state.meta));

  }

  function closeDetail(updateHash = true) {
    const sheet = $("#sheet");
    if (sheet.getAttribute("aria-hidden") === "false") {
      sheet.setAttribute("aria-hidden", "true"); document.body.style.overflow = "";
      const v = $("#main").dataset.view || "picks";
      if (updateHash) location.hash = "#" + v; else if (v === "picks" || v === "portfolio" || v === "singles") renderView(v);
    }
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { e.preventDefault(); closeDetail(); return; }
    const so = e.target.closest("[data-open-single]");
    if (so && !e.target.closest("a")) { location.hash = "#s/" + so.dataset.openSingle; return; }
    const o = e.target.closest("[data-open]");
    if (o && !e.target.closest("a")) location.hash = "#p/" + o.dataset.open;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".list-item, tr[data-open]")) { e.preventDefault(); e.target.click(); }
  });

  load();
})();

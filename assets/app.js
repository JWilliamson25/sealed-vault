/* Sealed Vault — UI. Vanilla JS, no build step. */
(function () {
  "use strict";
  const E = window.Engine;
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
    watch: new Set(store.get(LS.watch, [])), holdings: store.get(LS.hold, {}),
    filters: { q: "", type: "", signal: "", pokemon: "", sort: "rank", dir: 1 },
    range: "1y",
  };

  function settings() {
    const s = store.get(LS.settings, {});
    const c = state.config;
    return {
      chasePokemon: s.chasePokemon || c.chasePokemon,
      retailReference: { ...c.retailReference, ...(s.retailReference || {}) },
      retailOverrides: { ...(c.retailOverrides || {}), ...(s.retailOverrides || {}) },
      formatScore: c.formatScore,
      risk: s.risk || "balanced",
    };
  }

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600); }
  const sigPill = (k) => `<span class="sig sig-${k}"><i aria-hidden="true">${E.SIGNALS[k].icon}</i>${E.SIGNALS[k].label}</span>`;
  const pct = (v) => (v == null ? '<span class="muted">—</span>' : `<span class="${v > 0.5 ? "up" : v < -0.5 ? "down" : ""}">${fmtPct(v)}</span>`);
  const thumb = (r) => (r.img ? `<img class="thumb" src="${esc(r.img)}" alt="" loading="lazy">` : `<div class="thumb">${esc(E.TYPE_LABEL[r.type] || "")}</div>`);
  const seriesPts = (id, sinceDays) => {
    const s = state.history.series[String(id)] || [];
    const last = state.history.lastDay ?? 0;
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
    } catch (e) {
      $("#main").innerHTML = `<div class="empty"><h2>No price data yet</h2><p>Run the “Daily price sync” workflow from your repository's Actions tab, then reload. If you opened index.html straight from disk, serve the folder instead (for example <code>python -m http.server</code>) — browsers block local data files.</p></div>`;
      $("#asof").textContent = "";
      return;
    }
    const d = new Date(state.meta.priceDate + "T00:00:00Z").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    $("#asof").textContent = `TCGplayer market prices as of ${d}`;
    if (state.meta.demo) $("#banner").innerHTML = `<div class="banner"><p><strong>Demo data.</strong> These are fictional sets with simulated prices so you can try the app. Real TCGplayer prices replace them after the first daily sync runs.</p></div>`;
    recompute();
    window.addEventListener("hashchange", route);
    route();
  }

  function recompute() {
    state.rows = E.analyse({ meta: state.meta, history: state.history, settings: settings() });
    state.byId = new Map(state.rows.map((r) => [String(r.id), r]));
  }

  /* ------------------------------------------------------------ router --- */
  function route() {
    const h = location.hash.slice(1) || "picks";
    const [view, arg] = h.split("/");
    if (view === "p" && arg) { if (!$("#main").dataset.view) renderView("picks"); openDetail(arg); return; }
    closeDetail(false);
    renderView(view);
  }
  function renderView(view) {
    const views = { picks: renderPicks, products: renderProducts, sets: renderSets, portfolio: renderPortfolio, settings: renderSettings, about: renderAbout };
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
      <div class="slab-foot"><span>${esc(E.PHASES[r.phase].label)}</span><span class="foot-trend">30d ${pct(r.stats.ch30)} ${Charts.sparkline(pts)}</span></div>
    </button>`;
  }

  function renderPicks() {
    const rows = state.rows.slice();
    const buys = rows.filter((r) => ["strong_buy", "buy"].includes(r.signal)).sort((a, b) => E.SIGNALS[a.signal].rank - E.SIGNALS[b.signal].rank || b.score - a.score);
    const acc = rows.filter((r) => r.signal === "accumulate").sort((a, b) => b.score - a.score).slice(0, 6);
    const hot = rows.filter((r) => r.signal === "overheated" || r.signal === "falling").sort((a, b) => b.score - a.score);
    const watched = rows.filter((r) => state.watch.has(String(r.id)));
    const near = watched.filter((r) => r.price <= r.target * 1.03);
    $("#main").innerHTML = `
      <h1>Today's desk</h1>
      <p class="lede">Sealed products from sets carried by ${esc(settings().chasePokemon.slice(0, 4).map((c) => c.name).join(", "))} and the rest of your chase list, scored for a 4+ year hold. “Buy under” is the price I'd be happy paying today.</p>
      <div class="controls"><button class="btn" id="brief">Ask Claude about today's picks</button></div>
      ${near.length ? `<section class="section"><div class="section-head"><h2>Your watchlist hit its targets</h2></div><div class="slabs">${near.map(slab).join("")}</div></section>` : ""}
      <section class="section">
        <div class="section-head"><h2>Buy now</h2><span class="muted small">${buys.length} products at or under target</span></div>
        ${buys.length ? `<div class="slabs">${buys.map(slab).join("")}</div>` : `<div class="empty">Nothing is under its target today. That's normal — patience is most of this game. Check the accumulate list below or your watchlist.</div>`}
      </section>
      ${acc.length ? `<section class="section"><div class="section-head"><h2>Worth accumulating slowly</h2><span class="muted small">Strong sets a little above target — buy a piece, not the position</span></div><div class="slabs">${acc.map(slab).join("")}</div></section>` : ""}
      ${hot.length ? `<section class="section"><div class="section-head"><h2>Hold off</h2><span class="muted small">Spiking or still sliding — wait for these to settle</span></div><div class="slabs">${hot.map(slab).join("")}</div></section>` : ""}`;
    $("#brief").onclick = () => askClaude(deskBrief(buys, acc, hot));
  }

  function deskBrief(buys, acc, hot) {
    const line = (r) => `- ${r.name} (${r.set.name}, ${Math.round(r.set.ageMonths)} mo): ${fmt$(r.price)}, target ${fmt$(r.target)}, 30d ${fmtPct(r.stats.ch30)}, 1y ${fmtPct(r.stats.ch365)}, ${E.SIGNALS[r.signal].label}`;
    return [
      `Act as a veteran sealed Pokémon TCG investor. I hold sealed product 4+ years. My tracker (TCGplayer market prices, ${state.meta.priceDate}) flagged the items below. Search the web for any recent reprint or restock news on these sets, then tell me which 3 you'd actually buy, which you'd skip, and why. Give a max price for each.`,
      "", "Buy now:", ...buys.slice(0, 12).map(line), "", "Accumulate slowly:", ...acc.map(line), "", "Hold off:", ...hot.slice(0, 6).map(line),
    ].join("\n");
  }

  function askClaude(prompt) {
    const done = () => toast("Prompt copied. Paste it into Claude if it isn't already filled in.");
    (navigator.clipboard?.writeText(prompt) || Promise.reject()).then(done, () => toast("Opening Claude with your prompt."));
    window.open("https://claude.ai/new?q=" + encodeURIComponent(prompt), "_blank", "noopener");
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
        <select id="fsig" aria-label="Signal"><option value="">All signals</option>${Object.entries(E.SIGNALS).map(([k, v]) => `<option value="${k}" ${f.signal === k ? "selected" : ""}>${v.label}</option>`).join("")}</select>
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
    { k: "gap", label: "vs target", num: true, get: (r) => r.gap },
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
      (!f.pokemon || r.set.chase.iconic.some((c) => c.pokemon === f.pokemon)));
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
        <td>${sigPill(r.signal)}</td><td class="num">${r.score}<span class="score-bar"><span style="width:${r.score}%"></span></span></td></tr>`).join("");
    const list = rows.map((r) => `<div class="list-item" data-open="${r.id}" role="button" tabindex="0">
        <div><div class="pname">${esc(r.name)}</div><div class="pset">${esc(r.set.name)}</div></div>
        <div style="text-align:right"><strong class="price">${fmt$(r.price)}</strong><div class="small muted">under ${fmt$(r.target)}</div></div>
        <div>${sigPill(r.signal)}</div><div class="small" style="text-align:right">30d ${pct(r.stats.ch30)}</div></div>`).join("");
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
          <td class="pname">${esc(s.name)}</td><td style="white-space:nowrap">${esc(s.release || "—")}</td><td>${esc(E.PHASES[s.phase].label)}</td>
          <td class="num">${s.chase.score.toFixed(0)} <span class="muted small">${s.chase.tier}</span></td>
          <td class="small">${s.chase.iconic.slice(0, 3).map((c) => `${esc(c.name)} <span class="muted">${fmt$(c.price)}</span>`).join("<br>") || '<span class="muted">none from your list</span>'}</td>
          <td class="num">${pct(s.singlesStats.ch90)}</td><td>${b ? `${sigPill(b.signal)}<div class="small muted">${esc(E.TYPE_LABEL[b.type])}</div>` : ""}</td></tr>`; }).join("")}</tbody>
      </table></div>`;
  }

  /* --------------------------------------------------------- portfolio --- */
  function renderPortfolio() {
    const ids = new Set([...state.watch, ...Object.keys(state.holdings)]);
    const rows = [...ids].map((id) => state.byId.get(id)).filter(Boolean);
    let cost = 0, value = 0;
    const holdRows = rows.filter((r) => (state.holdings[r.id] || []).length).map((r) => {
      const lots = state.holdings[r.id]; const qty = lots.reduce((a, l) => a + l.qty, 0); const c = lots.reduce((a, l) => a + l.qty * l.cost, 0);
      cost += c; value += qty * r.price; return { r, qty, c, v: qty * r.price };
    });
    const watchRows = rows.filter((r) => state.watch.has(String(r.id)));
    $("#main").innerHTML = `
      <h1>My vault</h1>
      <p class="lede">Holdings and watchlist live in this browser only. Export a backup now and then, or import it on another device.</p>
      <div class="controls"><button class="btn" id="exp">Export backup</button><label class="btn">Import backup<input type="file" id="imp" accept="application/json" hidden></label></div>
      <section class="section"><div class="section-head"><h2>Holdings</h2>${holdRows.length ? `<span class="small">Cost ${fmt$(cost)} · Value ${fmt$(value)} · ${pct((value / cost - 1) * 100)}</span>` : ""}</div>
        ${holdRows.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Avg cost</th><th class="num">Market</th><th class="num">Value</th><th class="num">Gain</th><th>Add more?</th></tr></thead><tbody>
          ${holdRows.map(({ r, qty, c, v }) => `<tr data-open="${r.id}"><td><div class="pname">${esc(r.name)}</div><div class="pset">${esc(r.set.name)}</div></td><td class="num">${qty}</td><td class="num">${fmt$(c / qty)}</td><td class="num">${fmt$(r.price)}</td><td class="num">${fmt$(v)}</td><td class="num">${pct((v / c - 1) * 100)}</td><td>${sigPill(r.signal)}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty">No holdings yet. Open any product and use “Add to holdings” to log what you paid.</div>`}
      </section>
      <section class="section"><div class="section-head"><h2>Watchlist</h2></div>
        ${watchRows.length ? `<div class="slabs">${watchRows.map(slab).join("")}</div>` : `<div class="empty">Star products from their detail view to watch them. Watched items that drop under target show at the top of Picks.</div>`}
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
      <div class="card" style="margin-top:16px"><h3>Risk profile</h3>
        <div class="seg" role="group" aria-label="Risk profile">${["conservative", "balanced", "aggressive"].map((k) => `<button data-risk="${k}" aria-pressed="${s.risk === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
        <p class="small muted">Conservative sets buy targets 5% lower; aggressive 5% higher.</p>
      </div>
      <div class="card" style="margin-top:16px"><h3>Retail reference prices</h3>
        <p class="small muted">Used for the “× retail” math and early-life targets. Leave blank if a format has no fixed retail.</p>
        <div class="form-grid">${types.map((t) => `<label class="field">${E.TYPE_LABEL[t] || t}<input type="number" step="0.01" min="0" data-retail="${t}" value="${s.retailReference[t] ?? ""}"></label>`).join("")}</div>
      </div>
      <div class="controls"><button class="btn primary" id="save">Save settings</button><button class="btn" id="reset">Reset to defaults</button></div>`;
    let risk = s.risk;
    document.querySelectorAll("[data-risk]").forEach((b) => b.onclick = () => { risk = b.dataset.risk; document.querySelectorAll("[data-risk]").forEach((x) => x.setAttribute("aria-pressed", x === b)); });
    $("#save").onclick = () => {
      const chasePokemon = $("#chase").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [n, w] = l.split(","); return { name: n.trim(), weight: Math.max(0, Math.min(1, parseFloat(w) || 1)) }; });
      const retailReference = {}; document.querySelectorAll("[data-retail]").forEach((i) => { retailReference[i.dataset.retail] = i.value === "" ? null : parseFloat(i.value); });
      store.set(LS.settings, { ...store.get(LS.settings, {}), chasePokemon, retailReference, risk });
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
      <ul class="reasons">
        <li>Brand new (under 2 months): around retail — let the release premium bleed out.</li>
        <li>Still printing (2–12 months): retail to 15% over retail, depending on chase strength.</li>
        <li>Out-of-print climb (12–24 months): just under the 90-day average.</li>
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
        <li>${sigPill("falling")} Sliding more than 10% a month while still in print.</li>
        <li>${sigPill("pass")} Weak chase or weak format for a 4+ year hold.</li>
      </ul>
      <h2>What it can't see</h2>
      <p>Reprint announcements, Pokémon Center restocks, print-run sizes, and sales volume. Use “Ask Claude” on any product for a second opinion that checks current news. This isn't financial advice; prices can and do fall.</p>
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
          <p style="margin-top:8px">Buy under <strong>${fmt$(r.target)}</strong> — ${esc(r.targetWhy)}. Market is ${fmt$(r.price)} (${Math.abs(Math.round(r.gap)) === 0 ? "right at" : Math.abs(Math.round(r.gap)) + "% " + (r.gap > 0 ? "over" : "under")} target).</p></div>
          ${thumb(r)}
        </div>
        <div class="card">
          <div class="section-head" style="margin:0 0 8px"><h3 style="margin:0">Price history</h3>
            <div class="seg" role="group" aria-label="Range">${[["3m", 90], ["1y", 365], ["all", null]].map(([k]) => `<button data-range="${k}" aria-pressed="${state.range === k}">${k === "all" ? "All" : k.toUpperCase()}</button>`).join("")}</div></div>
          <div id="chart"></div>
          <div class="legend"><span>Market price</span><span class="l-target">Buy under</span>${r.retail ? '<span class="l-retail">Retail</span>' : ""}</div>
        </div>
        <div class="card"><h3>Why</h3><ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          ${r.benchmark ? `<p class="small muted" style="margin:12px 0 0">For a 4+ year view: ${esc(E.TYPE_LABEL[r.type])}s from other ${r.set.chase.tier.toLowerCase()}-chase sets that are 4–6 years old now trade at a median ${r.benchmark.median.toFixed(1)}× retail (${r.benchmark.n} products). Past sets aren't a promise.</p>` : ""}
        </div>
        <div class="card"><h3>Numbers</h3><div class="kv">
          <div>Market<strong>${fmt$(r.price)}</strong></div><div>TCGplayer low<strong>${fmt$(r.low)}</strong></div>
          <div>× retail<strong>${r.mult ? r.mult.toFixed(2) + "×" : "—"}</strong></div>
          <div>30 days<strong>${pct(st.ch30)}</strong></div><div>90 days<strong>${pct(st.ch90)}</strong></div><div>1 year<strong>${pct(st.ch365)}</strong></div>
          <div>90-day low<strong>${fmt$(st.low90)}</strong></div><div>1-year high<strong>${fmt$(st.high365)}</strong></div>
          <div>Score<strong>${r.score}/100</strong></div><div>Chase score<strong>${r.set.chase.score.toFixed(0)} ${r.set.chase.tier}</strong></div>
          <div>Phase<strong>${esc(E.PHASES[r.phase].label)}</strong></div><div>Confidence<strong>${r.confidence}</strong></div>
        </div></div>
        <div class="card"><h3>What's carrying the set</h3>
          <table><tbody>${r.set.topSingles.slice(0, 8).map((c) => `<tr><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : esc(c.name)} <span class="muted small">${esc(c.number || "")}</span></td><td class="num">${fmt$(c.price)}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card"><h3>Holdings</h3>
          ${lots.length ? `<p class="small">${lots.map((l, i) => `${l.qty} × ${fmt$(l.cost)} <button class="btn ghost small" data-rmlot="${i}">Remove</button>`).join("<br>")}</p>` : ""}
          <div class="form-grid"><label class="field">Quantity<input type="number" id="hq" min="1" value="1"></label><label class="field">Paid each<input type="number" id="hc" min="0" step="0.01" value="${r.price.toFixed(2)}"></label></div>
          <div class="actions" style="margin-top:10px"><button class="btn" id="addlot">Add to holdings</button></div>
        </div>
        <div class="actions">
          <button class="btn primary" id="ask">Ask Claude for a second opinion</button>
          ${r.url ? `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Open on TCGplayer</a>` : ""}
        </div>
      </div>`;
    const draw = () => {
      const days = { "3m": 90, "1y": 365, all: null }[state.range];
      const refs = [{ value: r.target, label: "Buy " + fmt$(r.target), cls: "series-target" }];
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
    $("#addlot").onclick = () => {
      const qty = parseInt($("#hq").value, 10), cost = parseFloat($("#hc").value);
      if (!(qty > 0) || !(cost >= 0)) { toast("Enter a quantity and the price you paid."); return; }
      (state.holdings[r.id] ||= []).push({ qty, cost, date: state.meta.priceDate }); store.set(LS.hold, state.holdings); toast("Added to holdings."); openDetail(r.id);
    };
    panel.querySelectorAll("[data-rmlot]").forEach((b) => b.onclick = () => { state.holdings[r.id].splice(+b.dataset.rmlot, 1); if (!state.holdings[r.id].length) delete state.holdings[r.id]; store.set(LS.hold, state.holdings); openDetail(r.id); });
    $("#ask").onclick = () => askClaude(E.claudePrompt(r, state.meta));

  }

  function closeDetail(updateHash = true) {
    const sheet = $("#sheet");
    if (sheet.getAttribute("aria-hidden") === "false") {
      sheet.setAttribute("aria-hidden", "true"); document.body.style.overflow = "";
      const v = $("#main").dataset.view || "picks";
      if (updateHash) location.hash = "#" + v; else if (v === "picks" || v === "portfolio") renderView(v);
    }
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { e.preventDefault(); closeDetail(); return; }
    const o = e.target.closest("[data-open]");
    if (o && !e.target.closest("a")) location.hash = "#p/" + o.dataset.open;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".list-item, tr[data-open]")) { e.preventDefault(); e.target.click(); }
  });

  load();
})();

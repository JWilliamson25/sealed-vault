/* Minimal dependency-free SVG charts: a price line with target/retail reference lines,
 * crosshair + tooltip on hover/touch, and a sparkline. */
(function (global) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const money = (v) => "$" + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2));
  const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
  const longDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  function niceTicks(lo, hi, n = 4) {
    const span = hi - lo || 1;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const start = Math.floor(lo / step) * step;
    const out = [];
    for (let v = start; v <= hi + step * 0.001; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /** points: [[dateMs, value]], refs: [{value, label, cls}] */
  function priceChart(container, points, refs = []) {
    container.innerHTML = "";
    container.classList.add("chart");
    if (points.length < 2) { container.innerHTML = '<p class="muted small">Not enough history yet — the chart fills in as daily syncs run (or run the one-time backfill).</p>'; return; }
    const W = Math.max(300, Math.round(container.clientWidth || 640)), H = W < 500 ? 220 : 260, m = { t: 12, r: 84, b: 26, l: 48 };
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const refVals = refs.map((r) => r.value).filter((v) => v != null);
    let lo = Math.min(...ys, ...refVals), hi = Math.max(...ys, ...refVals);
    const pad = (hi - lo) * 0.08 || hi * 0.1; lo = Math.max(0, lo - pad); hi += pad;
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Price history chart" });

    const grid = el("g", { class: "grid" }), axis = el("g", { class: "axis" });
    for (const t of niceTicks(lo, hi)) {
      if (t < lo || t > hi) continue;
      grid.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      const tx = el("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end" }); tx.textContent = t >= 1000 ? "$" + (t / 1000).toFixed(1) + "k" : "$" + Math.round(t); axis.appendChild(tx);
    }
    const nX = Math.min(W < 500 ? 3 : 5, points.length);
    for (let i = 0; i < nX; i++) {
      const v = x0 + ((x1 - x0) * i) / (nX - 1);
      const tx = el("text", { x: X(v), y: H - 6, "text-anchor": i === 0 ? "start" : i === nX - 1 ? "end" : "middle" });
      tx.textContent = shortDate(new Date(v)); axis.appendChild(tx);
    }
    svg.append(grid, axis);

    const placed = [];
    for (const r of refs.filter((r) => r.value != null && r.value >= lo && r.value <= hi).sort((a, b) => b.value - a.value)) {
      svg.appendChild(el("line", { class: r.cls, x1: m.l, x2: W - m.r, y1: Y(r.value), y2: Y(r.value) }));
      let ly = Y(r.value) + 4;
      for (const py of placed) if (Math.abs(ly - py) < 13) ly = py + 13;  // nudge apart, never overlap
      placed.push(ly);
      const t = el("text", { class: "ref-label", x: W - m.r + 6, y: ly }); t.textContent = r.label; svg.appendChild(t);
    }
    const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    svg.appendChild(el("path", { class: "series-price", d }));
    const last = points[points.length - 1];
    svg.appendChild(el("circle", { class: "dot", cx: X(last[0]), cy: Y(last[1]), r: 4 }));

    const cross = el("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" });
    const hdot = el("circle", { class: "dot", r: 5, visibility: "hidden" });
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
    svg.append(cross, hdot, hit);
    container.appendChild(svg);
    const tip = document.createElement("div"); tip.className = "chart-tip"; container.appendChild(tip);

    const move = (clientX) => {
      const box = svg.getBoundingClientRect();
      const sx = ((clientX - box.left) / box.width) * W;
      const tv = x0 + ((sx - m.l) / (W - m.l - m.r)) * (x1 - x0);
      let best = points[0];
      for (const p of points) if (Math.abs(p[0] - tv) < Math.abs(best[0] - tv)) best = p;
      const cx = X(best[0]), cy = Y(best[1]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      hdot.setAttribute("cx", cx); hdot.setAttribute("cy", cy); hdot.setAttribute("visibility", "visible");
      tip.style.display = "block";
      tip.style.left = (cx / W) * box.width + "px"; tip.style.top = (cy / H) * box.height + "px";
      tip.textContent = `${longDate(new Date(best[0]))}  ${money(best[1])}`;
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); hdot.setAttribute("visibility", "hidden"); tip.style.display = "none"; };
    hit.addEventListener("pointermove", (e) => move(e.clientX));
    hit.addEventListener("pointerdown", (e) => move(e.clientX));
    hit.addEventListener("pointerleave", hide);
  }

  function sparkline(points, w = 96, h = 26) {
    if (!points || points.length < 2) return "";
    const ys = points.map((p) => p[1]); const lo = Math.min(...ys), hi = Math.max(...ys);
    const x0 = points[0][0], x1 = points[points.length - 1][0];
    const d = points.map((p, i) => `${i ? "L" : "M"}${(((p[0] - x0) / (x1 - x0 || 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((p[1] - lo) / (hi - lo || 1)) * (h - 6)).toFixed(1)}`).join("");
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--series)" stroke-width="1.75" stroke-linejoin="round"/></svg>`;
  }

  global.Charts = { priceChart, sparkline };
})(window);

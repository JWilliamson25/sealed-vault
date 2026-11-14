#!/usr/bin/env node
/* Run the app's singles engine outside the browser and print each card's call as JSON.
 *   node scripts/singles_calls.js            # all cards
 *   node scripts/singles_calls.js 284266     # one card, with reasons and checklist
 * Used by scripts/card_facts.py todo to find the cards worth researching. */
const fs = require("fs"), path = require("path"), vm = require("vm");
const repo = path.resolve(__dirname, "..");
const J = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(repo, f), "utf8")); } catch { return d; } };
const ctx = { console, Date, Math, JSON, Intl }; ctx.window = ctx; vm.createContext(ctx);
for (const f of ["assets/engine.js", "assets/singles.js"]) vm.runInContext(fs.readFileSync(path.join(repo, f), "utf8"), ctx, { filename: f });
const config = J("config.json", {});
const settings = { chasePokemon: config.chasePokemon, setOverrides: config.setOverrides || {}, risk: "balanced",
  singles: { budgetMin: 30, budgetMax: 300, sweetSpotMax: 100, ...(config.singles || {}) } };
const singles = J("data/singles.json", null);
if (!singles) { console.error("No data/singles.json yet."); process.exit(1); }
const rows = ctx.Singles.analyse({ singles, history: J("data/singles_history.json", { series: {} }), meta: J("data/meta.json", {}),
  sealedHistory: J("data/history.json", { series: {} }), settings, facts: J("data/card_facts.json", { cards: {} }) });
const one = process.argv[2];
const slim = (r) => ({ id: r.id, name: r.name, group: r.group || r.setName, number: r.number, tier: r.tierLabel, price: r.price, target: r.target,
  signal: r.signal, score: r.score, pillars: r.pillars, longKnown: r.longKnown, factsVerified: r.facts?.verified || null, missing: r.missing,
  ...(one ? { targetWhy: r.targetWhy, reasons: r.reasons } : {}) });
const out = one ? rows.filter((r) => String(r.id) === one).map(slim) : rows.map(slim);
process.stdout.write(JSON.stringify(out, null, one ? 1 : 0) + "\n");

# Sealed Vault

A personal sealed Pokémon TCG tracker for long holds (4+ years). It follows every sealed product from sets carried by your chase Pokémon (Charizard, Umbreon, Pikachu, Lugia, Rayquaza, Mew, Mewtwo, Gengar, Eevee, Sylveon by default), records TCGplayer market prices every day, and gives each product a buy-under price and a signal: Strong buy, Buy, Accumulate, Wait, Overheated, Still falling, or Pass.

It runs entirely free on GitHub: GitHub Pages hosts the site and a GitHub Action refreshes prices daily.

## How it works

```
tcgcsv.com (daily TCGplayer price mirror)
        │  once a day, 21:37 UTC
        ▼
GitHub Action  ──  scripts/sync.py  ──►  data/meta.json + data/history.json  (committed to the repo)
                                                   │
                                                   ▼
                                     GitHub Pages site (index.html) reads the JSON,
                                     scores everything in your browser
```

TCGplayer closed its API to new developers, and the free mirror (tcgcsv.com) blocks browser requests, so prices are pulled by the Action, not by the page. That also means the site loads instantly and never hammers anyone's servers.

## Setup (about 10 minutes)

1. **Create a repository.** On GitHub, click **New repository**, name it (for example `sealed-vault`), make it public (Pages is free for public repos), and create it.
2. **Upload these files.** On the new repo page choose **uploading an existing file**, drag in everything from this folder (including the hidden `.github` folder and `.nojekyll` — on a Mac press ⌘⇧. in Finder to show hidden files), and commit. Or with git:
   ```
   git init && git add . && git commit -m "Sealed Vault"
   git branch -M main && git remote add origin https://github.com/YOU/sealed-vault.git && git push -u origin main
   ```
3. **Let the Action write data.** Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
4. **Turn on Pages.** Settings → Pages → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → Save. Your site appears at `https://YOU.github.io/sealed-vault/` within a minute or two.
5. **Pull real prices now.** Actions tab → **Daily price sync** → **Run workflow** (tick “force”). Takes 2–4 minutes. This replaces the demo data.
6. **Backfill history (once).** Actions tab → **Backfill price history (run once)** → **Run workflow**. It downloads weekly price snapshots back to February 2024 so trends and targets work immediately. Takes 20–60 minutes. Don't run it repeatedly — it remembers what it already fetched.

After that the daily sync runs on its own. If a GitHub repo has no activity for 60 days, GitHub pauses scheduled workflows; the daily data commits count as activity, so this normally isn't an issue.

## Singles

The daily sync also tracks singles of your chase Pokémon (about $20–$450, a little wider than the default $30–$300 budget so cards drifting past it keep their history). The **Singles** tab scores each card for a long hold: value against similar cards (same Pokémon, rarity tier and era, using every TCGplayer price), demand, momentum, where its set is in its print life, and budget fit. Budget and sweet spot are in Settings and in `config.json` → `singles`.

PSA 10 prices and older raw history come from a one-time Scrydex import: **Actions → Import price history from Scrydex → mode `singles-dry-run`** (matches cards and saves today's PSA 10 prices, ~40 credits), then **mode `singles`** (daily raw + PSA 10 history, roughly 25–35 credits per card).

## Older price points from Scrydex (optional, one-time)

Scrydex's API doesn't offer price history for sealed products, but every sealed price it returns includes how much it changed over recent periods (7, 30, 90, 180 days…). `scripts/scrydex_import.py --trends` works back from today's price to rebuild one approximate past price per period, scaled to match TCGplayer, so trend-based calls work without waiting months. It never overwrites real TCGplayer days.

1. Repo **Settings → Secrets and variables → Actions**: add `SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` (the team **ID** from the Scrydex dashboard, not the team name). GitHub encrypts secrets and never shows them in logs or on the site.
2. **Actions → Import price history from Scrydex (one-time) → Run workflow**, mode **dry-run** to check product matching (results in `data/scrydex_report.json`), then mode **trends** (about 30 credits).
3. Cancel the Scrydex plan and delete the two secrets afterwards if you don't need them.

## Using it

- **Picks** — what's under target today, what's worth buying slowly, and what to hold off on. Watched items that hit their target appear first.
- **All products** — sortable, filterable table of everything tracked.
- **Sets** — every chase set with its chase score, top chase cards and the best sealed call.
- **My vault** — log what you own and what you paid; star products to watch them. Stored in your browser; use Export backup to move it between devices.
- **Settings** — change the chase list and weights, retail reference prices, and risk profile. Changes apply instantly in your browser.
- **Ask Claude** — on any product (or the whole desk), builds a prompt with the numbers and opens Claude for a second opinion that can check current news like reprints and restocks.

## Tuning what's tracked

Edit `config.json` in the repo:

| Setting | What it does |
|---|---|
| `chasePokemon` | Which Pokémon make a set worth tracking, with weights 0–1. |
| `tracking.minChaseCardPrice` | A set is tracked if a card of a chase Pokémon sells for at least this. Default $25. |
| `tracking.minSealedPrice` | Ignore sealed items cheaper than this (loose packs mostly). |
| `tracking.alwaysIncludeGroupIds` / `excludeGroupIds` | Force a TCGplayer set in or out by its group id. |
| `retailReference` | US retail prices per format for the “× retail” math. Update when MSRPs change. |
| `retailOverrides` | Per-product retail, keyed by TCGplayer product id. |
| `formatScore` | How much each format is trusted as a long hold (0–10). |

To track Japanese sets too, change `categoryId` to `85` (or run a second copy of the repo).

## Running locally

```
python3 -m http.server 8000        # then open http://localhost:8000
python3 scripts/sync.py --force    # pull live prices (needs internet)
python3 scripts/make_demo.py       # regenerate the demo data
```

The scripts use only the Python standard library. The backfill also needs `7z` (`p7zip-full`).

## The method, briefly

Score = chase strength 30% + entry price vs target 25% + life-cycle phase 15% + momentum 15% + format 15%.

Buy-under targets depend on the set's age: near retail in the first two months, retail to retail +15% while still printing, just under the 90-day average during the out-of-print climb (12–24 months), and 5–7% under the 6-month average after that. 30-day spikes over 25% are flagged Overheated; in-print slides over 10% a month are flagged Still falling. The full reasoning lives in `assets/engine.js` and on the site's How it works page.

## Caveats

- Prices are TCGplayer “market price”, which lags on thinly traded items and can be skewed by a single sale.
- It can't see reprint announcements or Pokémon Center restocks in the price data. A weekly scheduled Claude task searches that news and records each set's print status in `config.json` → `setOverrides` (see below). Use Ask Claude for anything newer.
- Not financial advice. Sealed product can and does fall in value.

Data: TCGplayer prices via [tcgcsv.com](https://tcgcsv.com) (please respect its usage guidelines — the scripts already sync once a day with a custom User-Agent and a delay between requests). Not affiliated with TCGplayer, Nintendo, or The Pokémon Company.

## Print status (weekly reprint check)

Whether a set is still being printed changes the call more than anything else: a set that's still reprinting stays in its print-run phase with a retail-based target, however old it is, and only a set that's out of print gets the out-of-print climb. The price data can't tell, so a scheduled Claude task runs every Monday morning:

1. `python scripts/print_status.py todo` lists every tracked set aged 9 months to 5 years with its status and last check date.
2. It searches recent reprint, restock and print-run news for each set.
3. It records each result with `python scripts/print_status.py set "<set>" <in_print|likely_out_of_print|out_of_print> "<evidence>"` (or `touch` when nothing changed), then commits and pushes.

`likely_out_of_print` is for inferred cases (no reprint news, rotated, old stock only) and earns part of the out-of-print bonus. A status unchecked for 30+ days goes stale: an out-of-print call stops counting and the product can't be a Strong buy; an in-print call stays in force, since that's the cautious direction.

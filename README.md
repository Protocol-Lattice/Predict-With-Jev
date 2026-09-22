# JEV Terminal

A local crypto market research dashboard using **TypeSafe JEV 1.13 through OpenRouter’s native System One API**. It discovers Kraken’s active cryptocurrency/USD spot markets automatically, loads prices in one bulk ticker request, and fetches hourly and longer-term observations on demand.

## Run

Requires Node.js 22.12 or newer.

```sh
npm install
cp .env.example .env
# Set OPENROUTER_API_KEY in .env (or provide it in your shell environment).
npm run dev
```

Open **http://localhost:5173**. The server binds to `127.0.0.1`; the API rejects external hosts and cross-origin requests. Do not expose this local, single-user application publicly without adding authentication and deployment controls.

An existing `OPENROUTER_API_KEY` environment variable takes precedence over `.env`. The key stays on the server and is never returned by the API or embedded in the client bundle. Forecasts use account credits at OpenRouter. Each new asset/horizon/hour/engine combination runs at most once concurrently, and subsequent requests reuse the recorded decision. No automatic paid forecasts run on page load or market refresh. New forecasts are capped at 12 per minute.

For an offline walkthrough, set `DEMO_MODE=true` in `.env` and restart. This uses six explicitly labeled synthetic markets, disables JEV, and writes to a separate demo journal. Without a key, live data and the technical baseline still work. Provider errors never silently become baseline or synthetic predictions.

## Features

- Full dynamic Kraken crypto/USD catalog, searchable market picker, paginated prices, favorites, and **Select all assets**. The catalog refreshes every six hours. Fiat currencies, offline pairs, and the separate tokenized-stock product are excluded. An unavailable ticker is disclosed instead of invented.
- **AI market chat** follows your requested stablecoin scope: ask to research stablecoins, exclude them, or include them alongside other assets. Every eligible asset with usable hourly evidence is analyzed by JEV before any shortlist is formed. Bounded comparisons then retain candidates for a final ranking. Prompts include quotes, asset classifications, hourly technical indicators, and the last 24 hourly closes. A live progress counter shows the chosen scope, hourly data checks, and markets analyzed.
- Bulk quotes refresh every 60 seconds. Price changes in the market table are **since midnight UTC** because that is the opening price supplied by Kraken’s ticker API; ticker volume/high/low cover the trailing 24 hours. Prices use enough decimal precision for small tokens.
- Line and candlestick charts with **24H / 7D / 30D** hourly views, **1Y** daily observations, and **5Y** weekly observations from Kraken. Long-term charts load on demand, show completed closes with UTC dates, and disclose shorter available histories for newer pairs. Kraken limits OHLC responses to the latest 720 entries, so multi-year views use coarser intervals. Long-term charts require live data and remain separate from the hourly RSI, EMA trend, relative volume, support/resistance, and forecast inputs. Kraken candles with no trades retain the exchange’s prices and zero volume/VWAP, so quiet hours do not invalidate otherwise usable history. New or inactive assets may lack the 200 contiguous completed hourly observations required to forecast; the app reports that limitation.
- JEV direction probabilities for **4-hour, 24-hour, and 7-day** horizons. The model receives 72 recent completed candles plus historical indicators. The latest unfinished candle is excluded from all model features and outcome scoring.
- A separate volatility envelope, explicitly distinguished from JEV’s direction probabilities.
- Drag across either chart style to measure a historical period: percentage and USD change, elapsed time, and the two completed closes at the selected interval. Dragging in either direction measures the chronological price change. Use Shift + arrow keys for keyboard selection, or Escape / Clear to remove it. Refreshing data preserves the selection while its endpoints remain available. Changing the asset or chart time window resets it; forecast shading is excluded.
- Durable forecast journal with individual record inspection and JSON export. Forecasts are evaluated against the **exact completed target candle**, never the current price or a substituted timestamp.
- **Chat rankings** saves each completed scan, its prompt context, original candidate order, and purchase/comparison decision. Every finalist is tracked after **4h, 24h, and 7 days**, with automatic outcome checks and JSON export. Summary returns cover selected purchase candidates only.
- Baseline walk-forward replay with non-overlapping outcomes, always-neutral and hindsight majority-class benchmarks, and JSON export. These are technical-rule results, not JEV’s historical performance.
- Responsive dark interface, keyboard-accessible controls, local fonts, and reduced-motion support.

## Evaluation and limitations

Market chat uses the same JEV model, not a separate text-generating LLM. A small initial planning request interprets the latest prompt and conversation context with two choice questions: the stablecoin scope (all assets, stablecoins only, or stablecoins excluded) and the ranking objective (general best fit or percentage upside). The latest request takes priority over conflicting earlier preferences. The chosen scope is enforced before hourly history is loaded and throughout every ranking round, so excluded assets cannot reappear as comparison candidates. Quotes and hourly evidence for eligible markets are included in model prompts. All eligible markets with fresh, contiguous hourly observations receive detailed AI analysis in batches of up to 20. Each request is capped at 28,000 UTF-8 bytes, leaving room for provider formatting within JEV’s 32K-token context; larger batches split before inference without dropping eligible markets or their hourly evidence. Batches retain up to three candidates (at most half, rounded up, for smaller batches). Further comparison rounds reduce the pool until the final request fits. Relative weights are compared only within the same batch. This remains a hierarchical selection heuristic, so the final winner is not proof of a global optimum.

The shared stablecoin list follows [Kraken's support list](https://support.kraken.com/articles/stablecoins-supported-on-kraken) and [stablecoin category](https://www.kraken.com/categories/stablecoins), reviewed on September 22, 2026. It also includes [Stable Mint's USDSM](https://www.stablemint.io/blog/usdsm-lists-on-kraken/) and legacy TerraUSD symbols. It is maintained in `shared/stablecoins.ts` and must be updated for new stablecoin listings. Classification uses ticker identity, so a depeg does not change an asset's category and ordinary assets trading near $1 are not classified as stablecoins. STABLE and the gold-backed PAXG are not fiat-pegged stablecoins. Chat counts, progress, and result labels use the chosen scope.

For around 600 markets, a cold scan requests around 600 Kraken hourly OHLC responses and can take several minutes. Requests run two pairs at a time, with a shared cache for up to 1,000 hourly markets. The progress endpoint is read-only and never starts inference. Paid model usage includes one planning call with both scope and objective questions followed by ranking calls whose count depends on available hourly history, prompt length, and request size; all completed calls contribute to the returned model cost. No paid scan starts automatically on page load.

Requests such as “Which coin will pump?” select the percentage-upside objective. Every analysis and comparison round then evaluates evidence for substantial positive percentage movement over the selected horizon, rather than treating high liquidity, familiarity, or low volatility as a reason to rank an asset first. Upside ranking compares assets directly, without mixing the waiting option into each batch. A separate question in the final request assesses whether any setup is clear or whether all are weak. Weak evidence keeps the leading comparison and its observed signals visible, but leaves the purchase winner unset. Its setup weight is independent of the relative candidate weights. The planning step uses semantic interpretation, including negation and token names, so “avoid chasing pumps” or the ticker PUMP does not by itself activate this objective.

Upside results show observed 1h, 4h, and 24h close-to-close returns, average volume in the last 4 hours relative to the preceding 20 hours, and the latest close relative to the preceding 24 candles’ highest high (excluding the latest candle). Missing or undefined ratios are disclosed. These metrics come from completed hourly candles already loaded by the scan and are included in every model round; they do not require additional market requests. Result prose reports those observations, not an invented explanation of the model’s internal reasoning. Selection weights remain relative preferences, not calibrated probabilities of a pump.

Chat scans do not fetch five-year history or show long-term coverage in results. Selection uses quotes and hourly evidence for the selected 4h/24h/7d research horizon. The dashboard’s 1Y and 5Y charts load separately on demand.

The app does not buy anything. Relative selection weights are **not** probabilities of profit. Evidence descriptions are assembled from observed metrics rather than presented as JEV-generated reasoning. No live news, fundamentals, or order-book depth are included. Missing quotes and hourly histories are disclosed, and unavailable assets are not counted as analyzed. HTTP 400/422 responses display the provider’s rejection reason instead of advising an unchanged retry; credentials are redacted.

Chat uses your selected horizon and the last four user prompts as context. If your time horizon changes, update the selector. The conversation view lives in the current page session; export it to retain the transcript. Completed rankings and their supplied prompt context are also saved automatically in the separate **Chat rankings** journal before the API returns success. The server deduplicates identical in-flight scans and keeps up to ten results for unchanged request/snapshot combinations. Repeated results with the same scan ID retain their original journal record and evaluation schedule. Only one full-market scan can run at once, with at least 15 seconds between starts. Chat rankings measure subsequent price returns; they remain separate from the three-class directional accuracy journal.

Forecast horizons start at the latest completed hourly close, not the moment you click. The neutral threshold is `max(0.25%, 0.35 × hourly log-return volatility × √horizon)`. The volatility envelope is `reference × exp(±1.645 × volatility × √horizon)`; it assumes independent, normally distributed log returns and stable volatility. Its coverage has not been empirically validated.

JEV returns three mutually exclusive probabilities. They are validated for finite values, plausible normalization, and agreement with its selected class. They are **not proven calibrated probabilities of future cryptocurrency prices**. The app provides experimental forecasts, not a demonstrated profitable trading strategy, and places no trades.

The baseline combines clipped normalized EMA spread (50%), 24-hour momentum (35%), and RSI (15%). Replays use only observations available at each forecast time. Kraken supplies roughly 30 days of hourly history, so long-horizon samples are especially small. Replays do not model execution, fees, slippage, or trading P&L.

Live JEV metrics include only resolved JEV forecasts using Kraken data. Accuracy is a three-class match rate. Multiclass Brier score is the sum of squared probability errors, from 0 (best) to 2 (worst). Forecasts with different start times or horizons can overlap; reported observations are not statistically independent.

The latest 2,000 records are stored atomically in `data/forecasts.json`. Demo records use `data/demo-forecasts.json`. Both paths are ignored by Git. Every read and write validates complete records, timestamps, probability totals, and outcome calculations. Invalid JSON, incomplete records, or duplicate IDs stop the operation without replacing the existing file; the interface reports the journal error. Restore a valid backup if that happens. Additional historical metadata is preserved. Back up or export the journal for longer retention. Scoring runs when the journal is refreshed and requires the exact target candle to remain in Kraken’s available history; missed history remains unresolved. This is a single-server file store, not a distributed database.

Chat rankings are stored separately in `data/chat-rankings.json` (`data/demo-chat-rankings.json` in demo mode), with atomic writes, record validation, and no automatic pruning. Each snapshot preserves all final candidates in their original order, the model decision, supplied conversation context, and timestamps. A corrupt journal blocks new scans before paid inference; existing records are not replaced. Earlier page-only conversations are not backfilled.

Ranking evaluation uses the first completed hourly close **strictly after the ranking is saved** as its reference, then the exact closes 4h, 24h, and 168h later. These times are shown in the journal; this avoids counting price moves that occurred before the saved ranking was available. Every finalist is measured at all three horizons, regardless of the horizon requested in the original prompt. Captured reference prices and completed outcomes are never rewritten. Missing exact observations are marked unavailable rather than replaced with a nearby candle, the current quote, or zero. Temporary feed failures remain pending and are retried.

The local server checks due ranking observations on startup and every minute, without calling JEV or starting new rankings. It continues with the browser closed, but the server must be running. After downtime it catches up while the exact reference and target candles remain in Kraken's available history; longer gaps can leave outcomes unavailable. The journal's **Check outcomes** button uses the same evaluator and is limited to one check per minute. Selected-candidate summaries show average observed returns, positive-outcome rates, and evaluated/pending/unavailable counts. Scans with no purchase candidate retain all comparisons but do not enter those summaries. Returns exclude fees and slippage; overlapping observations are not independent and do not establish strategy profitability. Back up this single-server journal to retain the original evidence.

## Commands

```sh
npm test          # Deterministic indicator, leakage, data, integration-contract, and persistence tests
npm run check     # TypeScript validation
npm run build     # Type-check and production client bundle
npm start         # Serve the production bundle and API on the same local port
npm run smoke     # Check an already-running server; does not request new paid inference
```

Set `PORT` in `.env` or the environment to change the default port. For `npm run smoke`, provide a non-default `PORT` in the shell environment.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Model ID, key-present flag, and demo flag; never the key |
| `GET /api/markets` | Discovered assets, bulk quotes, and unavailable tickers |
| `GET /api/markets/:symbol` | Completed hourly history and indicators for one asset |
| `GET /api/markets/:symbol/history?range=1y` | Completed daily (`1y`) or weekly (`5y`) Kraken history, actual coverage, and freshness; cached up to one hour, refreshed at the next candle close |
| `GET /api/replay/:symbol?horizon=24` | Technical-baseline walk-forward evaluation |
| `GET /api/forecasts` | Recorded forecasts; resolves due outcomes if data is available |
| `POST /api/forecasts` | `{ "symbol": "BTC", "horizon": 24, "engine": "jev" }` (or `baseline`) |
| `GET /api/chat/progress` | Current scan phase, data checks, analyzed markets, and completed model calls |
| `POST /api/chat` | `{ "message": "Find a liquid candidate", "horizon": 24, "history": [] }`; last four user prompts may be supplied |
| `GET /api/chat/rankings?offset=0&limit=20` | Saved rankings, summary over the complete journal, and evaluator status; read-only, maximum page size 50 |
| `POST /api/chat/rankings/evaluate` | Check due hourly outcomes; no model inference, concurrent requests share one check |

## Implementation

React + TypeScript + Vite, Express, Zod, and native `fetch`. Vite runs as middleware during development, so the interface and API share one port. `server/catalog.ts` handles market discovery; `market.ts` validates and caches observations; `analysis.ts` implements indicators and replay; `jev.ts` implements the typed System One contract; `store.ts` handles forecast persistence and outcomes; `chat-journal.ts` preserves chat rankings and returns; `chat-ranking-evaluator.ts` schedules their outcome checks.

References: [JEV model](https://openrouter.ai/typesafe/jev-1.13), [OpenRouter System One integration](https://openrouter.ai/docs/guides/community/typesafe-sdk), [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one), [Kraken pairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs), [Kraken tickers](https://docs.kraken.com/api-reference/market-data/get-ticker-information), [Kraken hourly candles](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

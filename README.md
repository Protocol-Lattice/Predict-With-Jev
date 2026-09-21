# JEV Terminal

A local crypto market research dashboard using **TypeSafe JEV 1.13 through OpenRouter’s native System One API**. It discovers Kraken’s active cryptocurrency/USD spot markets automatically, loads prices in one bulk ticker request, and fetches completed hourly candles only for the market being analyzed.

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
- **AI market chat** accepts natural-language research prompts and follow-up constraints. It screens every valid quoted asset in batches, then compares up to three nominees per batch using completed hourly technical evidence. It returns a best-fit candidate, comparison assets, or an explicit no-candidate decision, with inspectable coverage and costs.
- Bulk quotes refresh every 60 seconds. Price changes in the market table are **since midnight UTC** because that is the opening price supplied by Kraken’s ticker API; ticker volume/high/low cover the trailing 24 hours. Prices use enough decimal precision for small tokens.
- Hourly line and candlestick charts, 24-hour/7-day/30-day views, RSI, EMA trend, relative volume, and observed support/resistance. New or inactive assets may lack the 200 contiguous completed hourly observations required to forecast; the app reports that limitation.
- JEV direction probabilities for **4-hour, 24-hour, and 7-day** horizons. The model receives 72 recent completed candles plus historical indicators. The latest unfinished candle is excluded from all model features and outcome scoring.
- A separate volatility envelope, explicitly distinguished from JEV’s direction probabilities.
- Durable forecast journal with individual record inspection and JSON export. Forecasts are evaluated against the **exact completed target candle**, never the current price or a substituted timestamp.
- Baseline walk-forward replay with non-overlapping outcomes, always-neutral and hindsight majority-class benchmarks, and JSON export. These are technical-rule results, not JEV’s historical performance.
- Responsive dark interface, keyboard-accessible controls, local fonts, and reduced-motion support.

## Evaluation and limitations

Market chat uses the same JEV model, not a separate text-generating LLM. A TypeSafe Choice supports up to 255 options; screening batches contain at most 150 markets plus an abstention option. All quoted markets enter a first pass, balanced across batches by liquidity. The three highest-weight assets in each batch advance to a final comparison. Weights are not compared across batches. This is a hierarchical screening heuristic: a good asset can be missed during nomination, so the result does not prove a global optimum.

For around 600 markets, a chat turn typically makes five screening calls plus one final comparison, and fetches hourly history for at most 15 nominees. It does not buy anything. Relative selection weights are **not** probabilities of profit. Evidence descriptions are assembled from observed metrics rather than presented as JEV-generated reasoning. No live news, fundamentals, or order-book depth are included. Insufficient quotes and missing finalist histories are disclosed. An asset must have fresh, contiguous hourly history to reach the final decision.

Chat uses your selected horizon and the last four user prompts as context. If your time horizon changes, update the selector. Chat messages live in the current page session; export them to retain the conversation. The server deduplicates identical in-flight scans and keeps up to ten results for unchanged request/snapshot combinations. Only one full-market scan can run at once, with at least 15 seconds between starts. Unlike a single-asset forecast, a market-chat ranking is not entered into the directional accuracy journal. To track direction, open the candidate and run its forecast.

Forecast horizons start at the latest completed hourly close, not the moment you click. The neutral threshold is `max(0.25%, 0.35 × hourly log-return volatility × √horizon)`. The volatility envelope is `reference × exp(±1.645 × volatility × √horizon)`; it assumes independent, normally distributed log returns and stable volatility. Its coverage has not been empirically validated.

JEV returns three mutually exclusive probabilities. They are validated for finite values, plausible normalization, and agreement with its selected class. They are **not proven calibrated probabilities of future cryptocurrency prices**. The app provides experimental forecasts, not a demonstrated profitable trading strategy, and places no trades.

The baseline combines clipped normalized EMA spread (50%), 24-hour momentum (35%), and RSI (15%). Replays use only observations available at each forecast time. Kraken supplies roughly 30 days of hourly history, so long-horizon samples are especially small. Replays do not model execution, fees, slippage, or trading P&L.

Live JEV metrics include only resolved JEV forecasts using Kraken data. Accuracy is a three-class match rate. Multiclass Brier score is the sum of squared probability errors, from 0 (best) to 2 (worst). Forecasts with different start times or horizons can overlap; reported observations are not statistically independent.

The latest 2,000 records are stored atomically in `data/forecasts.json`. Demo records use `data/demo-forecasts.json`. Both paths are ignored by Git. Back up or export the journal for longer retention. Scoring runs when the journal is refreshed and requires the exact target candle to remain in Kraken’s available history; missed history remains unresolved. This is a single-server file store, not a distributed database.

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
| `GET /api/replay/:symbol?horizon=24` | Technical-baseline walk-forward evaluation |
| `GET /api/forecasts` | Recorded forecasts; resolves due outcomes if data is available |
| `POST /api/forecasts` | `{ "symbol": "BTC", "horizon": 24, "engine": "jev" }` (or `baseline`) |
| `POST /api/chat` | `{ "message": "Find a liquid candidate", "horizon": 24, "history": [] }`; last four user prompts may be supplied |

## Implementation

React + TypeScript + Vite, Express, Zod, and native `fetch`. Vite runs as middleware during development, so the interface and API share one port. `server/catalog.ts` handles market discovery; `market.ts` validates and caches observations; `analysis.ts` implements indicators and replay; `jev.ts` implements the typed System One contract; `store.ts` handles persistence and outcomes.

References: [JEV model](https://openrouter.ai/typesafe/jev-1.13), [OpenRouter System One integration](https://openrouter.ai/docs/guides/community/typesafe-sdk), [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one), [Kraken pairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs), [Kraken tickers](https://docs.kraken.com/api-reference/market-data/get-ticker-information), [Kraken hourly candles](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

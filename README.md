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

- **Wallet & trading:** connect MetaMask or Rabby, review live Base ETH/USDC quotes, and confirm each real swap in your wallet. An independent, persistent virtual account supports autonomous paper BUY/HOLD/SELL decisions, costs, limits, pause and journal export.
- Full dynamic Kraken crypto/USD catalog, searchable market picker, paginated prices, favorites, and **Select all assets**. The catalog refreshes every six hours. Fiat currencies, offline pairs, and the separate tokenized-stock product are excluded. An unavailable ticker is disclosed instead of invented.
- **Staged decisions:** `market regime → candidate filter → setup quality → risk gate → action`, with separate JEV questions, recorded inputs and probabilities, and an offline stage benchmark. The final action is a deterministic research policy.
- **AI market chat** follows your requested stablecoin scope: ask to research stablecoins, exclude them, or include them alongside other assets. Every eligible asset with usable hourly evidence is analyzed by JEV before any shortlist is formed. Bounded comparisons then retain candidates for a final ranking. Candidate-filter prompts include quotes, asset classifications, hourly technical indicators, and the last 24 hourly closes. A live progress counter shows the chosen scope, hourly data checks, and markets analyzed.
- Bulk quotes refresh every 60 seconds. Price changes in the market table are **since midnight UTC** because that is the opening price supplied by Kraken’s ticker API; ticker volume/high/low cover the trailing 24 hours. Prices use enough decimal precision for small tokens.
- Line and candlestick charts with **24H / 7D / 30D** hourly views, **1Y** daily observations, and **5Y** weekly observations from Kraken. Long-term charts load on demand, show completed closes with UTC dates, and disclose shorter available histories for newer pairs. Kraken limits OHLC responses to the latest 720 entries, so multi-year views use coarser intervals. Long-term charts require live data and remain separate from the hourly RSI, EMA trend, relative volume, support/resistance, and forecast inputs. Kraken candles with no trades retain the exchange’s prices and zero volume/VWAP, so quiet hours do not invalidate otherwise usable history. New or inactive assets may lack the 200 contiguous completed hourly observations required to forecast; the app reports that limitation.
- JEV direction probabilities for **4-hour, 24-hour, and 7-day** horizons. The model receives 72 recent completed candles plus historical indicators. The latest unfinished candle is excluded from all model features and outcome scoring.
- A separate volatility envelope, explicitly distinguished from JEV’s direction probabilities.
- Drag across either chart style to measure a historical period: percentage and USD change, elapsed time, and the two completed closes at the selected interval. Dragging in either direction measures the chronological price change. Use Shift + arrow keys for keyboard selection, or Escape / Clear to remove it. Refreshing data preserves the selection while its endpoints remain available. Changing the asset or chart time window resets it; forecast shading is excluded.
- Durable forecast journal with individual record inspection and JSON export. Forecasts are evaluated against the **exact completed target candle**, never the current price or a substituted timestamp.
- **Chat rankings** saves each completed scan, its prompt context, original candidate order, and purchase/comparison decision. Every finalist is tracked after **4h, 24h, and 7 days**, with automatic outcome checks and JSON export. Summary returns cover selected purchase candidates only.
- Baseline walk-forward replay with non-overlapping outcomes, always-neutral and hindsight majority-class benchmarks, and JSON export. These are technical-rule results, not JEV’s historical performance.
- Responsive dark interface, keyboard-accessible controls, local fonts, and reduced-motion support.

## EVM wallet and Base ETH/USDC swaps

Open **Wallet & trading** in the sidebar. In a browser with MetaMask or Rabby installed, select the extension and click **Connect wallet**, then approve account access in the extension. Discovery uses [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963); account/network events and reads use [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193). A legacy injected provider is supported when no discovery announcement is available. Multiple extensions remain individually selectable.

Connecting only grants account access and reads the chain ID and native balance. It does not sign or submit transactions. Account and network changes invalidate the displayed balance immediately. Addresses and balances remain in browser memory and are not sent to the app server. Disconnect clears the local connection; site permission can be revoked separately inside the extension. Ethereum Mainnet, Base Mainnet and Sepolia balances display exact ETH amounts. Unknown chains show their numeric ID and raw native base units instead of guessing the currency/decimals. The swap panel also reads Base USDC balance and allowance. General ERC-20 portfolio discovery and WalletConnect/mobile pairing are not implemented. The Codex in-app browser may not have your wallet extension; use your usual browser.

The **Base · ETH / USDC** panel supports real, manually confirmed swaps on Base Mainnet (chain 8453):

1. Connect your wallet and select Base. Enter your own amount and choose **BUY ETH — pay USDC** or **SELL ETH — receive USDC**. Keep ETH on Base for network fees in either direction.
2. Click **Get live quote**. This performs RPC reads and simulations only. Review the input, quoted output, minimum received, pool fee, gas estimate and recipient. Quotes expire within 60 seconds; editing an input or changing the account/network invalidates them.
3. When buying ETH without sufficient USDC allowance, first confirm a separate approval for **exactly the entered USDC amount**, addressed to the fixed Uniswap router. It costs gas and authorizes spending; it does not buy ETH. After inclusion, get a new quote and separately confirm the swap.
4. Click **Confirm swap in wallet** and review the final transaction in MetaMask or Rabby. Only your wallet can authorize it. Submission is never retried automatically. The panel shows the transaction hash and polls its Base receipt; an included receipt is not a finality guarantee. Check wallet activity before retrying an uncertain submission.

Routing compares the 0.01%, 0.05%, 0.3% and 1% direct Uniswap v3 WETH/USDC pools at the same block, choosing the largest available output. It does not search other DEXs or multihop routes, or claim the best market-wide price. ETH wrapping/unwrapping is part of the router multicall. The recipient is always the connected account. The contract call enforces minimum output and a deadline three minutes after the quote block. Quotes and pre-submission checks simulate the **current step**: the approval step does not establish that a later swap will succeed. The later swap requires a fresh quote and its own simulation. Balance, allowance, account and chain checks run again before the wallet request.

The displayed L2 gas estimate includes a 20% gas-limit buffer and **excludes Base L1 data fees**. It is not a fee cap. The wallet displays the final fee; insufficient funds or changed prices can still cause rejection or a reverted transaction. There are no automatic live trades, delegated signing keys, paid model calls, or links from paper decisions to the swap button. Live swaps are disabled in demo mode. No seed phrase or private key is requested by the app.

Fixed contracts follow the official [Uniswap Base deployment list](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments) and [Circle native USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses):

| Contract | Base address |
| --- | --- |
| SwapRouter02 | `0x2626664c2603336e57b271c5c0b26f421741e481` |
| QuoterV2 | `0x3d4e44eb1374240ce5f1b871ab261cd16335b76a` |
| WETH | `0x4200000000000000000000000000000000000006` |
| Native USDC (not USDbC) | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |

Wallet requests go directly through the selected extension; no wallet credentials or transaction requests pass through the app server. The browser stores only the last submitted transaction's hash, kind, time and status under `jev-base-last-transaction` so a reload can resume receipt checks. This hash links to public on-chain activity. It is not a complete trade journal. Disconnecting cannot cancel an already submitted transaction or revoke an allowance. Use your wallet to manage permissions, approvals and replaced/cancelled transactions.

`npm run check:base` checks deployment bytecode, native USDC decimals, direct-pool quotes and router/approval simulations against public Base RPC. A hypothetical account balance exists only inside `eth_call`; the command has a read-method allowlist, uses no wallet or keys, and never signs or broadcasts. Public RPC rate limits can make this optional integration check unavailable. Unit tests use mock providers and no real funds.

## Autonomous paper trading

The **paper account is separate from the wallet**. It starts with $10,000 virtual USD, with a configurable Kraken asset, horizon, buy-order size, position limit, fee and adverse slippage. The defaults ($100 orders, $500 position limit, 25 bps fee, 10 bps slippage) are example simulation settings, not a financial recommendation or estimates of real execution costs. One basis point is 0.01%.

- **Saved JEV forecasts** uses the latest saved, unexpired JEV forecast matching the asset, horizon and environment, whose reference observation is at most two hours old. Missing forecasts cause HOLD. Generate new forecasts from Overview; the simulator does not call JEV or spend OpenRouter credits automatically.
- **Technical baseline** uses the existing deterministic indicator rule. Demo mode defaults to this source and uses synthetic prices; live-price mode defaults to saved JEV forecasts.
- A bullish signal buys up to the configured order notional, cash available after fees, and remaining position headroom. A bearish signal sells the entire virtual position. Neutral signals and unavailable, stale, future, or mismatched observations produce HOLD. No leverage or shorting is modeled. The position limit caps new buys; subsequent price increases can lift the existing position above the limit.
- Click **Save paper settings**, then **Start paper trading**. Checks run every minute on the local server, including with the browser closed. No simulation starts merely by connecting a wallet or opening the page. At most one simulated trade is allowed for each asset/completed-hour observation, including across stop/start and server restarts. Repeated identical HOLD results are deduplicated.
- **Pause simulation** invalidates in-flight results and waits for already-committed journal writes. Settings can change while paused; the asset can change when its position is empty. A server restart always leaves the runner paused. Feed failures and unreadable/invalid journals stop the runner with an explicit error.

Fills use the observed Kraken price at the check, adjusted adversely for configured slippage and fees. These are virtual fills, not executable DEX quotes: chain-specific token contracts, gas, liquidity, routing and order-book depth are not modeled. Equity is marked at the latest usable observation, with its timestamp shown. Neither this rule nor JEV forecasts establish trading profitability.

The account and complete decision journal are atomically written to `data/paper-trading.json` (`data/demo-paper-trading.json` in demo mode). Reads validate records and replay their cash/position/fee arithmetic; corrupt data is not silently overwritten. The interface displays the latest 50 decisions; export includes the full journal. This is a local single-server store. It contains no wallet credentials or wallet addresses. Paper trading never requests a wallet transaction.

## Staged chat decisions

Scope and objective planning remain a prelude. The decision path then runs:

| Stage | Input and decision | Recorded output |
| --- | --- | --- |
| Market regime | Equal-weight breadth, median momentum, volatility and relative volume across eligible hourly histories in the requested universe | Weights for `trending_up`, `trending_down`, `ranging`, `volatile`, `uncertain` |
| Candidate filter | The existing bounded analysis/comparison rounds, with regime context and observed evidence | Relative weights within each batch; the final comparison leader |
| Setup quality | Only the leader’s evidence, requested objective/horizon, and regime | `supported` / `weak` |
| Risk gate | The same leader’s evidence, explicit user constraints, regime and setup assessment | `allow` / `block` for further research |
| Action | Recorded filter, setup and risk answers plus freshness checks | `research`, `watch`, or `wait`, with explicit reasons |

The gates assess the leading asset, not whether *some* finalist has a good setup. Both binary gates require a strict majority for their positive answer; ties abstain. A weak setup with risk clearance produces `watch`. A filter abstention, risk veto/tie, non-live evidence, future observations or evidence older than two hours at completion produces `wait`. `research` requires all gates to pass. A bearish or uncertain regime provides context and does not itself veto a candidate. No stage supplies order execution or position sizing.

Each model call has a stable ID within its scan, stage/version, exact credential-free request, normalized answers, model, completion time, latency and cost. The two planning questions count as one paid call. Unknown usage keeps total cost unknown. Probabilities are conditional assessments of different questions: do not multiply them into a supposed probability of profit. The action policy has no fabricated probability distribution. `server/decision-pipeline.ts` exposes request builders and `runStageDecision` so a captured request can be evaluated in isolation with an injected provider or fixture.

### Offline stage benchmark

Export an individual ranking from **Chat rankings**, or use the local journal. Generate a label template, fill `expected` using the exact criteria in each saved request, and delete entries you cannot label:

```sh
npm run --silent benchmark -- --template data/chat-rankings.json > labels.json
# Replace null expectations with independently assigned option labels.
npm run --silent benchmark -- data/chat-rankings.json labels.json
# An individual exported jev-ranking-<id>.json works in place of the journal.
```

The benchmark does not call JEV or load new market data. Labels identify `{ scanId, decisionId, question, expected }`; missing labels are disclosed and excluded. Duplicate, unknown and out-of-contract labels fail. Historical scans without a pipeline are counted as legacy, not scored. A template with `null` labels deliberately cannot be scored.

Reports group by stage, question, prompt version, model, ranking round, horizon, objective, scope and exact option set. Each group includes sample count, accuracy (0–1), multiclass Brier score (0–2; lower is better), natural-log loss (probabilities floored at `1e-15`), latency, ten calibration bins and expected calibration error. Total cost counts each labeled call once, even if both planning questions are labeled. No probabilities or selection weights are pooled across different candidate sets. These metrics measure agreement with supplied labels, not trading profitability or proven calibration. Define label rubrics before evaluating; keep later price returns out of descriptive regime/setup/risk labels. Use chronological held-out samples when comparing prompt versions. The separate ranking journal continues to measure subsequent realized returns.

## Evaluation and limitations

Market chat uses the same JEV model, not a separate text-generating LLM. A small initial planning request interprets the latest prompt and conversation context with two choice questions: the stablecoin scope (all assets, stablecoins only, or stablecoins excluded) and the ranking objective (general best fit or percentage upside). The latest request takes priority over conflicting earlier preferences. The chosen scope is enforced before hourly history is loaded and throughout every ranking round, so excluded assets cannot reappear as comparison candidates. Quotes and hourly evidence for eligible markets are included in model prompts. All eligible markets with fresh, contiguous hourly observations receive detailed AI analysis in batches of up to 20. Each request is capped at 28,000 UTF-8 bytes, leaving room for provider formatting within JEV’s 32K-token context; larger batches split before inference without dropping eligible markets or their hourly evidence. Batches retain up to three candidates (at most half, rounded up, for smaller batches). Further comparison rounds reduce the pool until the final request fits. Relative weights are compared only within the same batch. This remains a hierarchical selection heuristic, so the final winner is not proof of a global optimum.

The shared stablecoin list follows [Kraken's support list](https://support.kraken.com/articles/stablecoins-supported-on-kraken) and [stablecoin category](https://www.kraken.com/categories/stablecoins), reviewed on September 22, 2026. It also includes [Stable Mint's USDSM](https://www.stablemint.io/blog/usdsm-lists-on-kraken/) and legacy TerraUSD symbols. It is maintained in `shared/stablecoins.ts` and must be updated for new stablecoin listings. Classification uses ticker identity, so a depeg does not change an asset's category and ordinary assets trading near $1 are not classified as stablecoins. STABLE and the gold-backed PAXG are not fiat-pegged stablecoins. Chat counts, progress, and result labels use the chosen scope.

For around 600 markets, a cold scan requests around 600 Kraken hourly OHLC responses and can take several minutes. Requests run two pairs at a time, with a shared cache for up to 1,000 hourly markets. The progress endpoint is read-only and never starts inference. Paid model usage includes one planning call with both scope and objective questions, one market-regime call, ranking calls whose count depends on available hourly history, prompt length, and request size, then one setup-quality and one risk-gate call for the leader; all completed calls contribute to the returned model cost. No paid scan starts automatically on page load.

Requests such as “Which coin will pump?” select the percentage-upside objective. Every analysis and comparison round then evaluates evidence for substantial positive percentage movement over the selected horizon, rather than treating high liquidity, familiarity, or low volatility as a reason to rank an asset first. Upside ranking compares assets directly, without mixing the waiting option into each batch. After the final ranking, a separate request assesses the specific leader’s setup, followed by an independent risk assessment of that same leader. This applies to both ranking objectives. Weak evidence or a risk veto keeps the leading comparison and its observed signals visible, but leaves the purchase winner unset. The weak-setup weight is separate from the relative candidate weights and does not represent a risk-block probability. Other finalists are retained as comparisons; the system does not silently promote a runner-up if the leader fails a gate. The planning step uses semantic interpretation, including negation and token names, so “avoid chasing pumps” or the ticker PUMP does not by itself activate this objective.

Upside results show observed 1h, 4h, and 24h close-to-close returns, average volume in the last 4 hours relative to the preceding 20 hours, and the latest close relative to the preceding 24 candles’ highest high (excluding the latest candle). Missing or undefined ratios are disclosed. These metrics come from completed hourly candles already loaded by the scan and are included in every model round; they do not require additional market requests. Result prose reports those observations, not an invented explanation of the model’s internal reasoning. Selection weights remain relative preferences, not calibrated probabilities of a pump.

Chat scans do not fetch five-year history or show long-term coverage in results. Selection uses quotes and hourly evidence for the selected 4h/24h/7d research horizon. The dashboard’s 1Y and 5Y charts load separately on demand.

Market chat does not execute trades. Relative selection weights are **not** probabilities of profit. Evidence descriptions are assembled from observed metrics rather than presented as JEV-generated reasoning. No live news, fundamentals, or order-book depth are included. Missing quotes and hourly histories are disclosed, and unavailable assets are not counted as analyzed. HTTP 400/422 responses display the provider’s rejection reason instead of advising an unchanged retry; credentials are redacted.

Chat uses your selected horizon and the last four user prompts as context. If your time horizon changes, update the selector. The conversation view lives in the current page session; export it to retain the transcript. Completed rankings and their supplied prompt context are also saved automatically in the separate **Chat rankings** journal before the API returns success. The server deduplicates identical in-flight scans and keeps up to ten results for unchanged request/snapshot combinations. Repeated results with the same scan ID retain their original journal record and evaluation schedule. Only one full-market scan can run at once, with at least 15 seconds between starts. Chat rankings measure subsequent price returns; they remain separate from the three-class directional accuracy journal.

Forecast horizons start at the latest completed hourly close, not the moment you click. The neutral threshold is `max(0.25%, 0.35 × hourly log-return volatility × √horizon)`. The volatility envelope is `reference × exp(±1.645 × volatility × √horizon)`; it assumes independent, normally distributed log returns and stable volatility. Its coverage has not been empirically validated.

JEV returns three mutually exclusive probabilities. They are validated for finite values, plausible normalization, and agreement with its selected class. They are **not proven calibrated probabilities of future cryptocurrency prices**. The app provides experimental forecasts, not a demonstrated profitable trading strategy. Forecasts do not execute real trades; the separate Base swap panel requires manual wallet confirmation.

The baseline combines clipped normalized EMA spread (50%), 24-hour momentum (35%), and RSI (15%). Replays use only observations available at each forecast time. Kraken supplies roughly 30 days of hourly history, so long-horizon samples are especially small. Replays do not model execution, fees, slippage, or trading P&L.

Live JEV metrics include only resolved JEV forecasts using Kraken data. Accuracy is a three-class match rate. Multiclass Brier score is the sum of squared probability errors, from 0 (best) to 2 (worst). Forecasts with different start times or horizons can overlap; reported observations are not statistically independent.

The latest 2,000 records are stored atomically in `data/forecasts.json`. Demo records use `data/demo-forecasts.json`. Both paths are ignored by Git. Every read and write validates complete records, timestamps, probability totals, and outcome calculations. Invalid JSON, incomplete records, or duplicate IDs stop the operation without replacing the existing file; the interface reports the journal error. Restore a valid backup if that happens. Additional historical metadata is preserved. Back up or export the journal for longer retention. Scoring runs when the journal is refreshed and requires the exact target candle to remain in Kraken’s available history; missed history remains unresolved. This is a single-server file store, not a distributed database.

Chat rankings are stored separately in `data/chat-rankings.json` (`data/demo-chat-rankings.json` in demo mode), with atomic writes, record validation, and no automatic pruning. Each snapshot preserves all final candidates in their original order, the model decision, supplied conversation context, and timestamps. New snapshots also retain the versioned pipeline, including every request and normalized response from all batches, even for discarded candidates. This increases journal and export size. Old snapshots remain readable without inventing missing stage evidence. A corrupt journal blocks new scans before paid inference; existing records are not replaced. Earlier page-only conversations are not backfilled.

Ranking evaluation uses the first completed hourly close **strictly after the ranking is saved** as its reference, then the exact closes 4h, 24h, and 168h later. These times are shown in the journal; this avoids counting price moves that occurred before the saved ranking was available. Every finalist is measured at all three horizons, regardless of the horizon requested in the original prompt. Captured reference prices and completed outcomes are never rewritten. Missing exact observations are marked unavailable rather than replaced with a nearby candle, the current quote, or zero. Temporary feed failures remain pending and are retried.

The local server checks due ranking observations on startup and every minute, without calling JEV or starting new rankings. It continues with the browser closed, but the server must be running. After downtime it catches up while the exact reference and target candles remain in Kraken's available history; longer gaps can leave outcomes unavailable. The journal's **Check outcomes** button uses the same evaluator and is limited to one check per minute. Selected-candidate summaries show average observed returns, positive-outcome rates, and evaluated/pending/unavailable counts. Scans with no purchase candidate retain all comparisons but do not enter those summaries. Returns exclude fees and slippage; overlapping observations are not independent and do not establish strategy profitability. Back up this single-server journal to retain the original evidence.

## Commands

```sh
npm test          # Deterministic indicator, leakage, data, integration-contract, and persistence tests
npm run check     # TypeScript validation
npm run build     # Type-check and production client bundle
npm start         # Serve the production bundle and API on the same local port
npm run smoke     # Check an already-running server; does not request new paid inference
npm run check:base # Public Base RPC reads and eth_call simulations; no transactions broadcast
npm run benchmark -- <rankings.json> <labels.json> # Offline scores by decision stage
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
| `GET /api/paper` | Virtual account, full decision journal, runner status; read-only |
| `POST /api/paper/config` | Full `{ symbol, horizon, signal: "jev" \| "baseline", orderUsd, maxPositionUsd, feeBps, slippageBps }` configuration; paused only |
| `POST /api/paper/start` | `{}`; explicitly start the local paper runner; no wallet access or real trades |
| `POST /api/paper/stop` | `{}`; pause the runner and invalidate in-flight results |

## Implementation

React + TypeScript + Vite, Express, Zod, and native `fetch`. Vite runs as middleware during development, so the interface and API share one port. `server/catalog.ts` handles market discovery; `market.ts` validates and caches observations; `analysis.ts` implements indicators and replay; `jev.ts` implements the typed System One contract; `store.ts` handles forecast persistence and outcomes; `chat-journal.ts` preserves chat rankings and returns; `chat-ranking-evaluator.ts` schedules their outcome checks. `decision-pipeline.ts` defines the isolated JEV stages, `shared/decision-pipeline.ts` the deterministic action policy, `decision-schema.ts` validates saved traces, and `decision-benchmark.ts` scores labeled stage outputs.

References: [JEV model](https://openrouter.ai/typesafe/jev-1.13), [OpenRouter System One integration](https://openrouter.ai/docs/guides/community/typesafe-sdk), [TypeSafe System One](https://docs.typesafe.ai/concepts/system-one), [Kraken pairs](https://docs.kraken.com/api-reference/market-data/get-tradable-asset-pairs), [Kraken tickers](https://docs.kraken.com/api-reference/market-data/get-ticker-information), [Kraken hourly candles](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

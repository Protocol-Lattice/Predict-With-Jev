import assert from 'node:assert/strict';
import type { Forecast, Health, Market, MarketsResponse, Replay } from '../shared/types.js';

const base = `http://127.0.0.1:${process.env.PORT ?? 5173}`;
async function get<T>(route: string): Promise<T> {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(45_000) });
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return await response.json() as T;
}
const health = await get<Health>('/api/health');
assert.equal(health.model, 'typesafe/jev-1.13');
const overview = await get<MarketsResponse>('/api/markets');
assert(overview.assets.length > 0);
assert(overview.markets.length > 0);
assert(overview.assets.some(asset => asset.symbol === 'BTC'));
const market = await get<Market>('/api/markets/BTC');
assert(market.candles.length >= 200);
assert(market.candles.every(candle => candle.time <= Date.now() && candle.close > 0));
const replay = await get<Replay>('/api/replay/BTC?horizon=24');
assert(replay.sampleCount > 0);
const journal = await get<Forecast[]>('/api/forecasts');
assert(Array.isArray(journal));
const invalid = await fetch(`${base}/api/replay/BTC?horizon=0`);
assert.equal(invalid.status, 400);
const forbidden = await fetch(`${base}/api/health`, { headers: { Origin: 'https://example.com' } });
assert.equal(forbidden.status, 403);
console.log(`PASS: ${overview.assets.length} assets; ${overview.markets.length} quoted markets; ${market.candles.length} completed BTC candles; ${replay.sampleCount} replay windows; ${journal.length} recorded forecasts.`);
console.log(`JEV key ${health.configured ? 'configured' : 'not configured'}; ${health.demo ? 'demo' : 'live'} market mode. No new paid inference requested.`);

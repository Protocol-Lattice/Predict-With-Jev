import { describe, expect, it } from 'vitest';
import { baselineDirection, classifyReturn, HOUR, indicators, neutralThreshold, replay, rsi, scenarioRange } from '../server/analysis';
import { demoMarket, parseKraken } from '../server/market';
import { resolveForecast } from '../server/store';
import type { Forecast } from '../shared/types';

const NOW = Date.UTC(2026, 8, 21, 18);
const market = demoMarket('BTC', NOW);
function fixture(): Forecast {
  const reference = market.candles[400];
  const features = indicators(market.candles.slice(0, 401));
  return { id: 'test', symbol: 'BTC', horizon: 24, direction: 'bullish', probabilities: { bullish: 0.6, neutral: 0.3, bearish: 0.1 }, referencePrice: reference.close, referenceTime: reference.time, targetTime: reference.time + 24 * HOUR, createdAt: reference.time + 100, range: scenarioRange(reference.close, features, 24), neutralThreshold: neutralThreshold(features, 24), indicators: features, engine: 'jev', dataSource: 'demo', model: 'typesafe/jev-1.13', latencyMs: 100, cost: null, outcome: null };
}

describe('financial analysis', () => {
  it('keeps RSI finite for flat, increasing, and decreasing histories', () => {
    expect(rsi(Array(200).fill(100))).toBe(50);
    expect(rsi(Array.from({ length: 200 }, (_, index) => index + 1))).toBe(100);
    expect(rsi(Array.from({ length: 200 }, (_, index) => 201 - index))).toBe(0);
  });
  it('uses inclusive neutral boundaries and a positive minimum noise band', () => {
    expect(classifyReturn(0.01, 0.01)).toBe('neutral');
    expect(classifyReturn(-0.01, 0.01)).toBe('neutral');
    expect(classifyReturn(0.011, 0.01)).toBe('bullish');
    expect(classifyReturn(-0.011, 0.01)).toBe('bearish');
    const flat = market.candles.map(c => ({ ...c, open: 100, close: 100, low: 100, high: 100 }));
    const features = indicators(flat);
    expect(neutralThreshold(features, 24)).toBe(0.0025);
    expect(baselineDirection(features, 24)).toBe('neutral');
    expect(scenarioRange(100, features, 24)).toEqual({ low: 100, high: 100 });
  });
  it('compares adjacent volume windows without a gap', () => {
    const candles = market.candles.map(c => ({ ...c, volume: 1 }));
    candles.at(-25)!.volume = 25;
    expect(indicators(candles).volumeRatio).toBe(0.5);
  });
  it('never allows future data to change earlier replay predictions', () => {
    const first = replay(market, 24);
    const changed = { ...market, candles: market.candles.map((c, i) => i > 223 ? { ...c, open: c.open * 2, high: c.high * 2, low: c.low * 2, close: c.close * 2 } : c) };
    const second = replay(changed, 24);
    expect(second.points[0]).toEqual(first.points[0]);
    expect(first.points).toHaveLength(Math.floor((720 - 200) / 24));
    for (let i = 1; i < first.points.length; i++) expect(first.points[i].time - first.points[i - 1].time).toBe(24 * HOUR);
  });
  it('resolves only the exact target close and preserves past outcomes', () => {
    const forecast = fixture();
    const scored = resolveForecast(forecast, market, NOW);
    expect(scored.outcome?.price).toBe(market.candles[424].close);
    expect(scored.outcome?.brier).toBeGreaterThanOrEqual(0);
    expect(scored.outcome?.brier).toBeLessThanOrEqual(2);
    expect(resolveForecast(forecast, { ...market, candles: market.candles.filter(c => c.time !== forecast.targetTime) }, NOW).outcome).toBeNull();
    expect(resolveForecast(forecast, market, forecast.targetTime - 1).outcome).toBeNull();
    expect(resolveForecast(forecast, { ...market, stale: true }, NOW).outcome).toBeNull();
    expect(resolveForecast(forecast, { ...market, source: 'kraken' }, NOW).outcome).toBeNull();
    expect(resolveForecast(scored, market, NOW)).toBe(scored);
  });
});

describe('Kraken observations', () => {
  function payload() {
    const rows = market.candles.slice(-240).map(c => [(c.time - HOUR) / 1000, c.open.toString(), c.high.toString(), c.low.toString(), c.close.toString(), c.vwap.toString(), c.volume.toString(), 25]);
    rows.push([NOW / 1000, '100000', '100001', '99999', '100000', '100000', '1000', 1]);
    return { error: [], result: { XXBTZUSD: rows, last: NOW / 1000 } };
  }
  it('uses the final unfinished candle only as a displayed quote', () => {
    const parsed = parseKraken('BTC', payload(), NOW + 300_000);
    expect(parsed.price).toBe(100000);
    expect(parsed.candles).toHaveLength(240);
    expect(parsed.candles.at(-1)?.close).toBe(market.candles.at(-1)?.close);
    expect(parsed.indicators).toEqual(indicators(parsed.candles));
    expect(parsed.stale).toBe(false);
  });
  it('keeps hourly candles with no trades and a zero VWAP without inventing prices or volume', () => {
    const data = payload();
    const noTrades = data.result.XXBTZUSD.at(-2)!;
    const close = noTrades[4];
    noTrades.splice(1, 7, close, close, close, close, '0.00000', '0.00000', 0);
    const parsed = parseKraken('SODA', data, NOW + 300_000);
    expect(parsed.candles).toHaveLength(240);
    expect(parsed.candles.at(-1)).toMatchObject({ time: NOW, close: Number(close), vwap: 0, volume: 0 });
    expect(parsed.price).toBe(100000);
    expect(parsed.indicators).toEqual(indicators(parsed.candles));
    expect(parsed.volume24h).toBeCloseTo(parsed.candles.slice(-24).reduce((sum, candle) => sum + candle.volume * candle.vwap, 0));
    expect(parsed.stale).toBe(false);
  });
  it.each([
    ['0', '10', 1],
    ['0', '0', 1],
    ['0', '10', 0],
    ['-1', '0', 0],
    ['0', '0', -1],
    ['0', '0', 0.5],
    ['0', '0', NaN],
  ])('rejects inconsistent VWAP %s, volume %s, and trade count %s', (vwap, volume, trades) => {
    const data = payload();
    data.result.XXBTZUSD[50].splice(5, 3, vwap, volume, trades);
    expect(() => parseKraken('SODA', data, NOW)).toThrow(/Invalid/);
  });
  it('refuses gaps, malformed prices, and exchange errors', () => {
    const gap = payload(); gap.result.XXBTZUSD.splice(100, 1);
    expect(() => parseKraken('BTC', gap, NOW)).toThrow(/missing/);
    const bad = payload(); bad.result.XXBTZUSD[50][4] = 'NaN';
    expect(() => parseKraken('BTC', bad, NOW)).toThrow(/Invalid/);
    expect(() => parseKraken('BTC', { error: ['Rate limit'] }, NOW)).toThrow();
    expect(parseKraken('BTC', payload(), NOW + 3 * HOUR).stale).toBe(true);
  });
});

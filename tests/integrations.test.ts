import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCatalog, parseQuotes } from '../server/catalog';
import { askJev, decisionRequest, ENDPOINT, parseJev } from '../server/jev';
import { demoMarket, MarketService } from '../server/market';
import { ForecastStore } from '../server/store';
import type { Forecast } from '../shared/types';

const pair = (wsname: string, status = 'online') => ({ wsname, status, altname: wsname.replace('/', ''), aclass_base: 'currency', aclass_quote: 'currency' });

describe('dynamic crypto catalog', () => {
  it('discovers newly listed cryptocurrencies without an allowlist and normalizes Kraken aliases', () => {
    const assets = parseCatalog({ error: [], result: { XXBTZUSD: pair('XBT/USD'), XDGUSD: pair('XDG/USD'), NEWUSD: pair('NEW/USD'), EURUSD: pair('EUR/USD'), OLDEUR: pair('OLD/EUR'), DEADUSD: pair('DEAD/USD', 'cancel_only'), 'BTCUSD.d': pair('XBT/USD'), STOCKUSD: { ...pair('STOCK/USD'), asset_class: 'tokenized_asset' } } });
    expect(assets.map(asset => asset.symbol)).toEqual(['BTC', 'DOGE', 'NEW']);
    expect(assets[0].tickerKey).toBe('XXBTZUSD');
    expect(assets[2].pair).toBe('NEWUSD');
  });
  it('uses the UTC-day opening price and trailing 24h volume without inventing a 24h return', () => {
    const assets = parseCatalog({ error: [], result: { NEWUSD: pair('NEW/USD'), MISSINGUSD: pair('MISSING/USD') } });
    const data = parseQuotes({ error: [], result: { NEWUSD: { c: ['110', '1'], o: '100', v: ['2', '10'], p: ['105', '102'], h: ['110', '120'], l: ['100', '90'] } } }, assets, 123);
    expect(data.quotes[0].changeToday).toBeCloseTo(10);
    expect(data.quotes[0].volume24h).toBe(1020);
    expect(data.missing).toEqual(['MISSING']);
  });
  it('coalesces concurrent catalog/ticker loads into two requests for hundreds of markets', async () => {
    const pairs: Record<string, unknown> = {}, tickers: Record<string, unknown> = {};
    for (let i = 0; i < 650; i++) {
      pairs[`COIN${i}USD`] = pair(`COIN${i}/USD`);
      tickers[`COIN${i}USD`] = { c: ['1', '1'], o: '1', v: ['1', '5'], p: ['1', '1'], h: ['1', '2'], l: ['1', '0.5'] };
    }
    const request = vi.fn(async (url: string | URL | Request) => Response.json({ error: [], result: String(url).endsWith('AssetPairs') ? pairs : tickers }));
    const service = new MarketService(false, request as typeof fetch);
    const [one, two] = await Promise.all([service.all(), service.all()]);
    expect(one.markets).toHaveLength(650);
    expect(two).toEqual(one);
    await service.all();
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('TypeSafe System One integration', () => {
  const valid = { model: 'typesafe/jev-1.13-20260917', answers: { direction: { type: 'choice', choice: 'bullish', probabilities: { bullish: 0.6, neutral: 0.3, bearish: 0.1 } } }, usage: { cost: 0.0001 } };
  const live = { ...demoMarket('BTC'), source: 'kraken' as const };
  it('sends the native choice request to System One and keeps the key in the Authorization header', async () => {
    const request = vi.fn(async () => Response.json(valid));
    const result = await askJev(live, 24, 'test-key', request as typeof fetch);
    expect(request.mock.calls).toHaveLength(1);
    const args = (request as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(args[0]).toBe(ENDPOINT);
    expect(args[1].headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(args[1].body as string);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.questions.direction.type).toBe('choice');
    expect(body.state.completed_candles).toHaveLength(72);
    expect(args[1].body).not.toContain('test-key');
    expect(result.direction).toBe('bullish');
  });
  it('rejects invalid, non-finite, inconsistent, or wrong-model decisions', () => {
    expect(parseJev(valid).probabilities.bullish).toBeCloseTo(0.6);
    expect(() => parseJev({ ...valid, model: 'other-model' })).toThrow(/unexpected/);
    for (const probabilities of [{ bullish: 0.8, neutral: 0.7, bearish: 0.1 }, { bullish: 0.1, neutral: 0.8, bearish: 0.1 }, { bullish: NaN, neutral: 0, bearish: 0 }, { bullish: -0.1, neutral: 0.7, bearish: 0.4 }]) {
      expect(() => parseJev({ ...valid, answers: { direction: { ...valid.answers.direction, probabilities } } })).toThrow();
    }
  });
  it('does not call the paid endpoint on demo, stale data, or a missing key', async () => {
    const request = vi.fn();
    await expect(askJev(demoMarket('BTC'), 24, 'test-key', request)).rejects.toThrow(/fresh/);
    await expect(askJev({ ...live, stale: true }, 24, 'test-key', request)).rejects.toThrow(/fresh/);
    await expect(askJev(live, 24, '', request)).rejects.toThrow(/OPENROUTER/);
    expect(request).not.toHaveBeenCalled();
  });
  it('returns a clear credit error and never silently substitutes a baseline', async () => {
    await expect(askJev(live, 24, 'test-key', vi.fn(async () => Response.json({}, { status: 402 })))).rejects.toThrow(/credits/);
    const body = decisionRequest(live, 168);
    expect(body.state.forecast_horizon_hours).toBe(168);
    expect(body.state.reference_close_usd).toBe(live.candles.at(-1)!.close);
  });
});

describe('durable forecast journal', () => {
  it('serializes simultaneous writes and survives a new store instance', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jev-store-test-'));
    const file = path.join(directory, 'journal.json');
    try {
      const store = new ForecastStore(file);
      expect(await store.list()).toEqual([]);
      await Promise.all(Array.from({ length: 12 }, (_, index) => store.add({ id: `${index}`, referencePrice: 100, targetTime: Date.now() } as Forecast)));
      const loaded = await new ForecastStore(file).list();
      expect(loaded).toHaveLength(12);
      expect(new Set(loaded.map(item => item.id)).size).toBe(12);
      expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(12);
      await writeFile(file, '{"corrupt":true}');
      await expect(store.list()).rejects.toThrow(/invalid/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

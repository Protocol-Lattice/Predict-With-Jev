import { describe, expect, it, vi } from 'vitest';
import { parseCatalog, parseQuotes } from '../server/catalog';
import { askJev, decisionRequest, ENDPOINT, MAX_SYSTEM_ONE_REQUEST_BYTES, parseJev, requestSystemOne } from '../server/jev';
import { demoMarket, MarketService } from '../server/market';

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
  it('rejects oversized requests before sending paid inference', async () => {
    const request = vi.fn();
    await expect(requestSystemOne({ state: 'x'.repeat(MAX_SYSTEM_ONE_REQUEST_BYTES) }, 'test-key', request)).rejects.toThrow(/too large/);
    expect(request).not.toHaveBeenCalled();
  });
  it('reveals the provider’s HTTP 400 reason without leaking credentials or retrying the same request', async () => {
    const request = vi.fn(async () => Response.json({ error: { message: 'Provider returned error', metadata: { raw: 'Maximum context length exceeded; key=test-key' } } }, { status: 400 }));
    const failure = await requestSystemOne({ state: 'test' }, 'test-key', request).catch(error => error as Error);
    if (!(failure instanceof Error)) throw new Error('Expected a provider rejection.');
    expect(failure.message).toContain('JEV rejected the request (HTTP 400)');
    expect(failure.message).toContain('Maximum context length exceeded');
    expect(failure.message).not.toContain('test-key');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('handles non-JSON provider rejections without hiding the HTTP status', async () => {
    await expect(requestSystemOne({ state: 'test' }, 'test-key', vi.fn(async () => new Response('<html>Bad request</html>', { status: 400 })))).rejects.toThrow(/HTTP 400.*No further details/);
  });
});

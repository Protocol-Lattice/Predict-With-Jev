import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR } from '../server/analysis';
import { MarketService, parseKrakenHistory } from '../server/market';

const NOW = Date.UTC(2026, 8, 22, 12, 30);
const DAY = 24 * HOUR;

function payload(intervalMinutes: number, now = NOW, completed = 719) {
  const interval = intervalMinutes * 60_000;
  const end = Math.floor(now / interval) * interval;
  const rows = Array.from({ length: completed + 1 }, (_, index) => {
    const price = 100 + index;
    return [(end - (completed - index) * interval) / 1000, String(price), String(price + 2), String(price - 1), String(price + 1), String(price), '10', 5];
  });
  return { error: [], result: { XXBTZUSD: rows, last: end / 1000 } };
}

afterEach(() => { vi.useRealTimers(); });

describe('long-term Kraken observations', () => {
  it('uses completed daily closes within the previous calendar year', () => {
    const data = payload(1440);
    const history = parseKrakenHistory('BTC', '1y', data, NOW);
    expect(history).toMatchObject({ symbol: 'BTC', range: '1y', intervalMinutes: 1440, requestedFrom: Date.UTC(2025, 8, 22), source: 'kraken', stale: false, limited: false });
    expect(history.candles).toHaveLength(366);
    expect(history.candles[0].time).toBe(Date.UTC(2025, 8, 22));
    expect(history.candles.at(-1)?.time).toBe(Date.UTC(2026, 8, 22));
    expect(history.candles.at(-1)?.close).toBe(Number(data.result.XXBTZUSD.at(-2)![4]));
    expect(history.candles.some(candle => candle.close === Number(data.result.XXBTZUSD.at(-1)![4]))).toBe(false);
  });

  it('uses weekly intervals to cover five years without treating weeks as hours', () => {
    const history = parseKrakenHistory('BTC', '5y', payload(10080), NOW);
    expect(history.intervalMinutes).toBe(10080);
    expect(history.requestedFrom).toBe(Date.UTC(2021, 8, 22));
    expect(history.candles.length).toBeGreaterThanOrEqual(260);
    expect(history.candles.length).toBeLessThanOrEqual(262);
    expect(history.candles[0].time).toBeGreaterThanOrEqual(history.requestedFrom);
    expect(history.candles[0].time - history.requestedFrom).toBeLessThan(7 * DAY);
    expect(history.candles[1].time - history.candles[0].time).toBe(7 * DAY);
    expect(history.limited).toBe(false);
    expect(history.stale).toBe(false);
  });

  it('clamps a leap-day start to February 28 in the target year', () => {
    const now = Date.UTC(2028, 1, 29, 12);
    const history = parseKrakenHistory('BTC', '1y', payload(1440, now), now);
    expect(history.requestedFrom).toBe(Date.UTC(2027, 1, 28));
    expect(history.candles[0].time).toBe(history.requestedFrom);
  });

  it('discloses a newer pair’s actual history without requiring 200 observations or filling older prices', () => {
    const data = payload(10080, NOW, 12);
    const history = parseKrakenHistory('NEW', '5y', data, NOW);
    expect(history.candles).toHaveLength(12);
    expect(history.limited).toBe(true);
    expect(history.candles[0].time).toBe(Number(data.result.XXBTZUSD[0][0]) * 1000 + 7 * DAY);
    expect(() => parseKrakenHistory('NEW', '5y', payload(10080, NOW, 1), NOW)).toThrow(/Insufficient/);
  });

  it('retains valid no-trade periods and rejects malformed or unordered prices', () => {
    const data = payload(1440);
    const row = data.result.XXBTZUSD.at(-2)!;
    row.splice(1, 7, '2', '2', '2', '2', '0', '0', 0);
    expect(parseKrakenHistory('SODA', '1y', data, NOW).candles.at(-1)).toMatchObject({ close: 2, volume: 0, vwap: 0 });
    row[4] = 'NaN';
    expect(() => parseKrakenHistory('SODA', '1y', data, NOW)).toThrow(/Invalid/);
    const unordered = payload(10080);
    unordered.result.XXBTZUSD.reverse();
    expect(() => parseKrakenHistory('BTC', '5y', unordered, NOW)).toThrow(/unordered/);
  });

  it('keeps gaps in long-term observations instead of inventing missing prices', () => {
    const data = payload(10080, NOW, 12);
    data.result.XXBTZUSD.splice(5, 1);
    const history = parseKrakenHistory('NEW', '5y', data, NOW);
    expect(history.candles).toHaveLength(11);
    expect(history.candles[5].time - history.candles[4].time).toBe(14 * DAY);
  });

  it('marks freshness against the selected candle interval', () => {
    const history = parseKrakenHistory('BTC', '5y', payload(10080, NOW - 3 * 7 * DAY), NOW);
    expect(history.stale).toBe(true);
  });
});

describe('Kraken history service', () => {
  function provider() {
    return vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('AssetPairs')) return Response.json({ error: [], result: { XXBTZUSD: { wsname: 'XBT/USD', status: 'online', altname: 'XBTUSD', aclass_base: 'currency', aclass_quote: 'currency' } } });
      return Response.json(payload(Number(url.searchParams.get('interval')), Date.now()));
    });
  }

  it('deduplicates history loads, separates both ranges, and preserves hourly forecast data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const request = provider();
    const service = new MarketService(false, request as typeof fetch);
    const [one, two, five, hourly] = await Promise.all([service.history('BTC', '1y'), service.history('BTC', '1y'), service.history('BTC', '5y'), service.get('BTC')]);
    expect(one).toEqual(two);
    expect(one.intervalMinutes).toBe(1440);
    expect(five.intervalMinutes).toBe(10080);
    expect(hourly.candles[1].time - hourly.candles[0].time).toBe(HOUR);
    expect(hourly.indicators.hourlyVolatility).toBeGreaterThan(0);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('interval')).filter(Boolean).sort()).toEqual(['10080', '1440', '60']);
    expect(await service.history('BTC', '1y')).toEqual(one);
    expect(await service.history('BTC', '5y')).toEqual(five);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('reloads when a daily candle closes even if the hour-long cache has not expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2026, 8, 22, 23, 59));
    const request = provider();
    const service = new MarketService(false, request as typeof fetch);
    const before = await service.history('BTC', '1y');
    vi.setSystemTime(Date.UTC(2026, 8, 23, 0, 1));
    const after = await service.history('BTC', '1y');
    expect(after.candles.at(-1)!.time - before.candles.at(-1)!.time).toBe(DAY);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('serves an explicitly stale cache on failure and retries when the feed recovers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const request = provider();
    const service = new MarketService(false, request as typeof fetch);
    const first = await service.history('BTC', '5y');
    vi.setSystemTime(NOW + HOUR + 1);
    request.mockRejectedValueOnce(new Error('offline'));
    expect(await service.history('BTC', '5y')).toEqual({ ...first, stale: true });
    expect((await service.history('BTC', '5y')).stale).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not substitute synthetic prices for Kraken history', async () => {
    const request = provider();
    await expect(new MarketService(true, request as typeof fetch).history('BTC', '5y')).rejects.toThrow(/live Kraken data/);
    expect(request).not.toHaveBeenCalled();
  });
});

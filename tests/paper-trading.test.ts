import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PaperTrader, paperStep } from '../server/paper-trading';
import { demoMarket } from '../server/market';
import { HOUR } from '../server/analysis';
import type { Forecast, Market } from '../shared/types';
import type { PaperAccount } from '../shared/paper-trading';

const NOW = 1_790_208_000_000;
function market(time = NOW, direction: 'bullish' | 'neutral' | 'bearish' = 'bullish'): Market {
  const result = demoMarket('ETH', time);
  const sign = direction === 'bullish' ? 1 : direction === 'bearish' ? -1 : 0;
  return { ...result, price: 100, indicators: { ...result.indicators, hourlyVolatility: .01, trendStrength: 2 * sign, momentum24h: 10 * sign, rsi: 50 + 30 * sign } };
}

describe('paper accounting and runner', () => {
  let directory: string, file: string;
  let trader: PaperTrader;
  let account: PaperAccount;
  let feed: { get: ReturnType<typeof vi.fn<(symbol: string) => Promise<Market>>> };
  let forecasts: { list: ReturnType<typeof vi.fn<() => Promise<Forecast[]>>> };
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    directory = await mkdtemp(path.join(tmpdir(), 'jev-paper-test-')); file = path.join(directory, 'paper.json');
    feed = { get: vi.fn(async () => market()) };
    forecasts = { list: vi.fn(async () => []) };
    trader = new PaperTrader(file, true, feed, forecasts);
    const { running: _running, error: _error, intervalMs: _interval, ...initial } = await trader.snapshot();
    account = initial;
  });
  afterEach(async () => { await trader.stop().catch(() => {}); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });

  it('accounts for fees and adverse slippage on BUY and SELL without shorting', () => {
    const bought = paperStep(account, market(), [], NOW);
    expect(bought.decisions.at(-1)?.action).toBe('BUY');
    expect(bought.cashUsd).toBeCloseTo(9899.75, 8);
    expect(bought.quantity).toBeCloseTo(100 / 100.1, 10);
    const sold = paperStep(bought, market(NOW + HOUR, 'bearish'), [], NOW + HOUR);
    expect(sold.decisions.at(-1)?.action).toBe('SELL');
    expect(sold.quantity).toBe(0);
    expect(sold.cashUsd).toBeCloseTo(9899.75 + (100 / 100.1) * 99.9 * .9975, 8);
    const flat = paperStep(sold, market(NOW + 2 * HOUR, 'bearish'), [], NOW + 2 * HOUR);
    expect(flat.decisions.at(-1)?.action).toBe('HOLD');
    expect(flat.cashUsd).toBe(sold.cashUsd);
  });

  it('enforces cash and position caps across repeated bullish candles', () => {
    account.config.maxPositionUsd = 250;
    for (let hour = 0; hour < 8; hour++) {
      account = paperStep(account, market(NOW + hour * HOUR), [], NOW + hour * HOUR);
      expect(account.quantity * 100).toBeLessThanOrEqual(250);
      expect(account.cashUsd).toBeGreaterThanOrEqual(0);
    }
    expect(account.decisions.at(-1)?.action).toBe('HOLD');
    expect(account.quantity * 100).toBeGreaterThan(249);
    account.cashUsd = .005;
    expect(paperStep(account, market(NOW + 9 * HOUR), [], NOW + 9 * HOUR).decisions.at(-1)?.action).toBe('HOLD');
  });

  it.each([
    { stale: true }, { source: 'kraken' as const }, { symbol: 'BTC' }, { price: NaN }, { price: -1 },
    { fetchedAt: NOW + 1 }, { fetchedAt: NOW - 121_000 }, { candles: [] },
  ])('holds without changing cash on unusable observations: %j', change => {
    const result = paperStep(account, { ...market(), ...change }, [], NOW);
    expect(result.decisions.at(-1)?.action).toBe('HOLD');
    expect(result.cashUsd).toBe(account.cashUsd); expect(result.quantity).toBe(0);
    expect(result.markPrice).toBeNull();
  });

  it('rejects future or old candle evidence even if marked fresh', () => {
    for (const offset of [HOUR, -3 * HOUR]) {
      const invalid = market(NOW + offset); invalid.fetchedAt = NOW;
      expect(paperStep(account, invalid, [], NOW).decisions.at(-1)?.action).toBe('HOLD');
    }
  });

  it('uses only matching, fresh saved JEV forecasts and permits a new forecast after missing-signal HOLD', () => {
    account.config.signal = 'jev';
    const candle = market().candles.at(-1)!;
    const forecast: Forecast = { id: 'jev-1', symbol: 'ETH', horizon: 24, engine: 'jev', dataSource: 'demo', direction: 'bullish',
      referenceTime: candle.time, targetTime: candle.time + 24 * HOUR, createdAt: NOW, outcome: null,
      probabilities: { bullish: .7, neutral: .2, bearish: .1 }, referencePrice: 100, range: { low: 90, high: 110 }, neutralThreshold: .01,
      indicators: market().indicators, model: 'test', latencyMs: 1, cost: null };
    const waiting = paperStep(account, market(), [], NOW);
    expect(waiting.decisions.at(-1)?.action).toBe('HOLD');
    const bought = paperStep(waiting, market(), [forecast], NOW);
    expect(bought.decisions.at(-1)).toMatchObject({ action: 'BUY', forecastId: 'jev-1' });
    for (const change of [{ symbol: 'BTC' }, { horizon: 4 as const }, { dataSource: 'kraken' as const }, { engine: 'baseline' as const },
      { createdAt: NOW + 1 }, { referenceTime: NOW + 1 }, { referenceTime: NOW - 3 * HOUR }, { targetTime: NOW }]) {
      expect(paperStep(account, market(), [{ ...forecast, ...change }], NOW).decisions.at(-1)?.action).toBe('HOLD');
    }
  });

  it('deduplicates a candle across concurrent starts, polls, stops, and a restart', async () => {
    await Promise.all([trader.start(), trader.start(), trader.start()]); await trader.tick();
    await Promise.all([trader.tick(), trader.tick()]);
    const first = await trader.snapshot();
    expect(first.decisions.filter(item => item.action === 'BUY')).toHaveLength(1);
    expect(forecasts.list).not.toHaveBeenCalled();
    await trader.stop();
    trader = new PaperTrader(file, true, feed, forecasts);
    expect((await trader.snapshot()).running).toBe(false);
    expect((await trader.snapshot()).cashUsd).toBe(first.cashUsd);
    await trader.start(); await trader.tick();
    expect((await trader.snapshot()).decisions.filter(item => item.action === 'BUY')).toHaveLength(1);
  });

  it('pauses immediately and discards an in-flight market result', async () => {
    let finish!: (value: Market) => void;
    let requested!: () => void;
    const waiting = new Promise<void>(resolve => { requested = resolve; });
    feed.get.mockImplementation(() => { requested(); return new Promise(resolve => { finish = resolve; }); });
    await trader.start(); await waiting;
    const job = trader.tick();
    expect((await trader.stop()).running).toBe(false);
    finish(market()); await job;
    const state = await trader.snapshot();
    expect(state.decisions).toHaveLength(0); expect(state.cashUsd).toBe(10_000);
  });

  it('schedules ongoing decisions only after explicit start and clears the timer on stop', async () => {
    vi.useFakeTimers();
    await trader.start(); await trader.tick();
    feed.get.mockImplementation(async () => market(Date.now(), 'bearish'));
    vi.setSystemTime(NOW + HOUR);
    await vi.advanceTimersByTimeAsync(60_000); await trader.tick();
    expect((await trader.snapshot()).decisions.at(-1)?.action).toBe('SELL');
    await trader.stop(); const calls = feed.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(feed.get).toHaveBeenCalledTimes(calls);
  });

  it('stops and reports a feed failure without creating a fill', async () => {
    feed.get.mockRejectedValue(new Error('offline'));
    await trader.start(); await trader.tick();
    expect(await trader.snapshot()).toMatchObject({ running: false, error: expect.stringContaining('Simulation stopped'), quantity: 0 });
  });

  it('rejects invalid settings, active edits and asset changes with an open position', async () => {
    expect(() => trader.configure({ ...account.config, mode: 'live' })).toThrow('Invalid paper settings');
    expect(() => trader.configure({ ...account.config, orderUsd: 1000 })).toThrow('Invalid paper settings');
    await trader.start(); await trader.tick();
    await expect(trader.configure(account.config)).rejects.toThrow('Pause');
    await trader.stop();
    await expect(trader.configure({ ...account.config, symbol: 'BTC' })).rejects.toThrow('Close the current paper position');
  });

  it.each(['{"partial":', '{"mode":"live"}'])('preserves corrupt storage and refuses to start: %s', async content => {
    await writeFile(file, content);
    await expect(trader.start()).rejects.toThrow('paper journal');
    expect(feed.get).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('detects tampered balances and separates demo from live-price journals', async () => {
    await trader.start(); await trader.tick(); await trader.stop();
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.cashUsd += 10;
    await writeFile(file, JSON.stringify(stored));
    await expect(trader.snapshot()).rejects.toThrow('invalid');
    await writeFile(file, JSON.stringify(account));
    await expect(new PaperTrader(file, false, feed, forecasts).snapshot()).rejects.toThrow('invalid');
  });
});

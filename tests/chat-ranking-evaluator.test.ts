import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatRankingEvaluator } from '../server/chat-ranking-evaluator';
import { createRankingRecord, resolveRanking } from '../server/chat-journal';
import { HOUR } from '../server/analysis';
import { observedMarket, rankingScan, SCAN_TIME } from './fixtures/chat-ranking';

afterEach(() => { vi.useRealTimers(); });

describe('automatic chat ranking checks', () => {
  it('checks overdue results on startup and on the timer, resumes later horizons, and stops cleanly', async () => {
    vi.useFakeTimers();
    let record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    const ref = record.referenceTime;
    vi.setSystemTime(ref + 4 * HOUR);
    const markets = { forSymbols: vi.fn(async () => ['BTC', 'ETH'].map(symbol => observedMarket(symbol, [[ref, 100], [ref + 4 * HOUR, 110], [ref + 24 * HOUR, 120]]))) };
    const store = {
      list: vi.fn(async () => [record]),
      resolve: vi.fn(async (observations, now) => { record = resolveRanking(record, observations, now); }),
    };
    const evaluator = new ChatRankingEvaluator(store, markets);
    const stop = evaluator.start();
    await evaluator.refresh();
    expect(record.tracking[0].outcomes.map(item => item.status)).toEqual(['evaluated', 'pending', 'pending']);
    expect(markets.forSymbols).toHaveBeenCalledWith(['BTC', 'ETH']);
    vi.setSystemTime(ref + 24 * HOUR);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(record.tracking[0].outcomes[1].status).toBe('evaluated');
    expect(evaluator.status()).toMatchObject({ enabled: true, running: false, error: null });
    const calls = markets.forSymbols.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(markets.forSymbols).toHaveBeenCalledTimes(calls);
    expect(evaluator.status().enabled).toBe(false);
  });

  it('deduplicates concurrent checks and fetches nothing before any result is due', async () => {
    const record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    let now = record.referenceTime - 1;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = { list: vi.fn(async () => [record]), resolve: vi.fn(async () => {}) };
    const markets = { forSymbols: vi.fn(async () => { await gate; return []; }) };
    const evaluator = new ChatRankingEvaluator(store, markets, () => now);
    await evaluator.refresh();
    expect(markets.forSymbols).not.toHaveBeenCalled();
    now += 60_000;
    const first = evaluator.refresh(), second = evaluator.refresh();
    expect(second).toBe(first);
    release(); await first;
    expect(markets.forSymbols).toHaveBeenCalledTimes(1);
    expect(store.resolve).toHaveBeenCalledTimes(1);
    expect(evaluator.status().error).toContain('Waiting for live hourly data');
    await evaluator.refresh();
    expect(markets.forSymbols).toHaveBeenCalledTimes(1);
  });

  it('retries data failures without running inference or dropping saved records', async () => {
    const record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    let now = record.referenceTime;
    const store = { list: vi.fn(async () => [record]), resolve: vi.fn(async () => {}) };
    const markets = { forSymbols: vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(['BTC', 'ETH'].map(symbol => observedMarket(symbol, [[now, 100]]))) };
    const evaluator = new ChatRankingEvaluator(store, markets, () => now);
    await expect(evaluator.refresh()).rejects.toThrow('Offline');
    expect(evaluator.status()).toMatchObject({ running: false, error: 'Offline' });
    expect(store.resolve).not.toHaveBeenCalled();
    now += 60_000;
    await evaluator.refresh();
    expect(store.resolve).toHaveBeenCalledTimes(1);
    expect(evaluator.status()).toMatchObject({ running: false, error: null, lastCheckedAt: now });
  });
});

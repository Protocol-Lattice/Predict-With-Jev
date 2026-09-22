import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOUR } from '../server/analysis';
import { ForecastStore } from '../server/store';
import type { Forecast } from '../shared/types';

function forecast(id = 'forecast-1'): Forecast {
  const referenceTime = Date.UTC(2026, 8, 21, 12);
  return {
    id, symbol: 'BTC', horizon: 24, engine: 'jev', dataSource: 'kraken',
    direction: 'bullish', probabilities: { bullish: 0.6, neutral: 0.3, bearish: 0.1 },
    model: 'typesafe/jev-1.13', cost: null, latencyMs: 100,
    referencePrice: 100, referenceTime, targetTime: referenceTime + 24 * HOUR,
    createdAt: referenceTime + 1000, range: { low: 90, high: 110 }, neutralThreshold: 0.01,
    indicators: { rsi: 50, ema20: 100, ema50: 99, momentum24h: 1, momentum7d: 2, hourlyVolatility: 0.01, volumeRatio: 1, trendStrength: 0.2, support: 90, resistance: 110 },
    outcome: null,
  };
}

function scoredForecast(): Forecast {
  const record = forecast();
  return { ...record, outcome: { price: 105, change: 0.05, direction: 'bullish', correct: true, brier: 0.26, evaluatedAt: record.targetTime + 1000 } };
}

describe('forecast journal integrity', () => {
  let directory: string;
  let file: string;
  let store: ForecastStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'jev-journal-test-'));
    file = path.join(directory, 'forecasts.json');
    store = new ForecastStore(file);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('serializes simultaneous writes of complete records and survives a restart', async () => {
    expect(await store.list()).toEqual([]);
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.add(forecast(`forecast-${index}`))));
    const records = await new ForecastStore(file).list();
    expect(records).toHaveLength(12);
    expect(new Set(records.map(record => record.id)).size).toBe(12);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(records);
  });

  it('keeps valid scored JEV and baseline records, including additional metadata', async () => {
    const jev = { ...scoredForecast(), note: 'Keep this historical annotation.' };
    const baseline: Forecast = { ...scoredForecast(), id: 'baseline', engine: 'baseline', dataSource: 'demo', model: 'technical-baseline-v1', probabilities: null, outcome: { ...scoredForecast().outcome!, brier: null } };
    await writeFile(file, JSON.stringify([jev]));
    await store.add(baseline);
    expect(await new ForecastStore(file).list()).toEqual([baseline, jev]);
  });

  it.each([
    ['incomplete record', () => ({ id: 'old-checks-passed', referencePrice: 100, targetTime: Date.now() })],
    ['missing range', () => ({ ...forecast(), range: undefined })],
    ['missing indicators', () => ({ ...forecast(), indicators: undefined })],
    ['missing outcome', () => ({ ...forecast(), outcome: undefined })],
    ['invalid direction', () => ({ ...forecast(), direction: 'up' })],
    ['invalid horizon', () => ({ ...forecast(), horizon: 12 })],
    ['invalid engine', () => ({ ...forecast(), engine: 'unknown' })],
    ['invalid source', () => ({ ...forecast(), dataSource: 'unknown' })],
    ['zero reference price', () => ({ ...forecast(), referencePrice: 0 })],
    ['invalid timestamp', () => ({ ...forecast(), createdAt: 9e15 })],
    ['wrong target time', () => ({ ...forecast(), targetTime: forecast().targetTime + HOUR })],
    ['saved after outcome', () => ({ ...forecast(), createdAt: forecast().targetTime + 1 })],
    ['inverted range', () => ({ ...forecast(), range: { low: 110, high: 90 } })],
    ['invalid RSI', () => ({ ...forecast(), indicators: { ...forecast().indicators, rsi: 101 } })],
    ['negative volatility', () => ({ ...forecast(), indicators: { ...forecast().indicators, hourlyVolatility: -1 } })],
    ['missing probability', () => ({ ...forecast(), probabilities: { bullish: 0.6, bearish: 0.4 } })],
    ['unnormalized probabilities', () => ({ ...forecast(), probabilities: { bullish: 0.6, neutral: 0.6, bearish: 0.6 } })],
    ['missing JEV probabilities', () => ({ ...forecast(), probabilities: null })],
    ['incomplete outcome', () => ({ ...forecast(), outcome: { correct: true } })],
    ['wrong outcome return', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, change: 0.5 } })],
    ['wrong outcome direction', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, direction: 'bearish' } })],
    ['wrong match flag', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, correct: false } })],
    ['wrong Brier score', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, brier: 0 } })],
    ['missing JEV Brier score', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, brier: null } })],
    ['premature outcome', () => ({ ...scoredForecast(), outcome: { ...scoredForecast().outcome, evaluatedAt: forecast().targetTime - 1 } })],
  ])('rejects %s without replacing the existing file', async (_name, invalid) => {
    const original = JSON.stringify([invalid()]);
    await writeFile(file, original);
    await expect(store.list()).rejects.toThrow(/journal.*invalid/i);
    await expect(store.add(forecast('new'))).rejects.toThrow(/journal.*invalid/i);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it.each(['{"unfinished":', '{"corrupt":true}', JSON.stringify([forecast(), forecast()])])('preserves invalid JSON, invalid roots, and duplicate IDs', async original => {
    await writeFile(file, original);
    await expect(store.list()).rejects.toThrow(/journal.*invalid/i);
    await expect(store.add(forecast('new'))).rejects.toThrow(/journal.*invalid/i);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('rejects an invalid new record before changing the file and accepts the next valid write', async () => {
    await store.add(forecast());
    const original = await readFile(file, 'utf8');
    await expect(store.add({ ...forecast('bad'), referencePrice: NaN })).rejects.toThrow(/invalid/i);
    expect(await readFile(file, 'utf8')).toBe(original);
    await store.add(forecast('good'));
    expect((await store.list()).map(record => record.id)).toEqual(['good', 'forecast-1']);
  });
});

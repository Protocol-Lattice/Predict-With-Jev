import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HOUR } from '../server/analysis';
import { ChatRankingStore, createRankingRecord, dueRankingSymbols, resolveRanking, summarizeRankings } from '../server/chat-journal';
import { observedMarket, rankingScan, SCAN_TIME } from './fixtures/chat-ranking';

describe('chat ranking outcomes', () => {
  it('anchors all three horizons after saving, without using pre-decision prices or shifting the selected horizon', () => {
    const scan = rankingScan();
    const record = createRankingRecord(scan, ['Exclude stablecoins'], SCAN_TIME + 1000);
    expect(record.referenceTime).toBe(Date.UTC(2026, 8, 22, 11));
    expect(record.scan.horizon).toBe(4);
    expect(record.history).toEqual(['Exclude stablecoins']);
    expect(record.tracking[0].outcomes.map(item => item.horizon)).toEqual([4, 24, 168]);
    expect(record.tracking[0].outcomes.map(item => item.targetTime)).toEqual([4, 24, 168].map(hours => record.referenceTime + hours * HOUR));
    // Even an exact boundary waits for the next close, avoiding a pre-save entry.
    expect(createRankingRecord(scan, [], record.referenceTime).referenceTime).toBe(record.referenceTime + HOUR);
    expect(dueRankingSymbols([record], record.referenceTime - 1)).toEqual([]);
  });

  it('captures the exact reference and outcomes, ignoring live prices, future closes, and the old scan price', () => {
    const record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    const ref = record.referenceTime;
    const market = observedMarket('BTC', [[ref, 100], [ref + 4 * HOUR, 110], [ref + 24 * HOUR, 90], [ref + 168 * HOUR, 120]]);
    const first = resolveRanking(record, [market], ref + 4 * HOUR);
    expect(first.tracking[0].reference).toMatchObject({ status: 'captured', price: 100 });
    expect(first.tracking[0].outcomes[0]).toMatchObject({ status: 'evaluated', price: 110, returnPercent: expect.closeTo(10) });
    expect(first.tracking[0].outcomes.slice(1).map(item => item.status)).toEqual(['pending', 'pending']);
    expect(first.scan).toEqual(record.scan);
    expect(first.tracking[1].reference.status).toBe('pending');
    const completed = resolveRanking(first, [market], ref + 168 * HOUR);
    expect(completed.tracking[0].outcomes.map(item => item.status === 'evaluated' ? item.returnPercent : null)).toEqual([expect.closeTo(10), expect.closeTo(-10), expect.closeTo(20)]);
    // Later feed revisions must not rewrite previously scored observations.
    expect(resolveRanking(completed, [observedMarket('BTC', [[ref, 1], [ref + 168 * HOUR, 999]])], ref + 169 * HOUR).tracking[0]).toEqual(completed.tracking[0]);
  });

  it('does not use stale, synthetic, wrong-symbol, unfinished, or nearby observations', () => {
    const record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    const ref = record.referenceTime;
    const valid = observedMarket('BTC', [[ref, 100], [ref + 4 * HOUR, 110]]);
    for (const invalid of [{ ...valid, stale: true }, { ...valid, source: 'demo' as const }, { ...valid, symbol: 'SOL' }]) {
      expect(resolveRanking(record, [invalid], ref + 4 * HOUR)).toBe(record);
    }
    expect(resolveRanking(record, [valid], ref - 1)).toBe(record);
    const pending = resolveRanking(record, [observedMarket('BTC', [[ref - HOUR, 100]])], ref);
    expect(pending.tracking[0].reference.status).toBe('pending');
  });

  it('discloses missing reference or target closes instead of scoring a substitute', () => {
    const record = createRankingRecord(rankingScan(), [], SCAN_TIME + 1000);
    const ref = record.referenceTime;
    const missingReference = resolveRanking(record, [observedMarket('BTC', [[ref + HOUR, 100]])], ref + HOUR);
    expect(missingReference.tracking[0].reference.status).toBe('unavailable');
    expect(missingReference.tracking[0].outcomes.every(item => item.status === 'unavailable')).toBe(true);
    expect(dueRankingSymbols([{ ...missingReference, tracking: [missingReference.tracking[0]] }], ref + 200 * HOUR)).toEqual([]);
    const missingTarget = resolveRanking(record, [observedMarket('BTC', [[ref, 100], [ref + 3 * HOUR, 110], [ref + 5 * HOUR, 120]])], ref + 5 * HOUR);
    expect(missingTarget.tracking[0].outcomes[0].status).toBe('unavailable');
    expect(missingTarget.tracking[0].outcomes[1].status).toBe('pending');
  });

  it('keeps no-purchase comparisons visible but excludes them and unavailable outcomes from selected-candidate averages', () => {
    const selected = createRankingRecord(rankingScan('selected'), [], SCAN_TIME + 1000);
    const abstention = createRankingRecord(rankingScan('no-purchase', null), [], SCAN_TIME + 1000);
    const missing = createRankingRecord(rankingScan('missing-data'), [], SCAN_TIME + 1000);
    const market = observedMarket('BTC', [[selected.referenceTime, 100], [selected.referenceTime + 4 * HOUR, 110]]);
    const completed = [selected, abstention].map(record => resolveRanking(record, [market], selected.referenceTime + 4 * HOUR));
    completed.push(resolveRanking(missing, [observedMarket('BTC', [[missing.referenceTime + HOUR, 100]])], missing.referenceTime + HOUR));
    const summary = summarizeRankings(completed);
    expect(summary).toMatchObject({ total: 3, selected: 2, noSelection: 1 });
    expect(summary.horizons[0]).toMatchObject({ evaluated: 1, unavailable: 1, averageReturnPercent: expect.closeTo(10), positivePercent: 100 });
    expect(summary.horizons[1]).toMatchObject({ evaluated: 0, pending: 1, unavailable: 1, averageReturnPercent: null });
    expect(completed[1].scan.winner).toBeNull();
    expect(completed[1].tracking[0].outcomes[0].status).toBe('evaluated');
  });
});

describe('durable chat ranking journal', () => {
  let directory: string;
  let file: string;
  let store: ChatRankingStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'jev-chat-journal-test-'));
    file = path.join(directory, 'chat-rankings.json');
    store = new ChatRankingStore(file, () => SCAN_TIME + 1000);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('serializes concurrent saves, freezes original rankings, deduplicates scans, and survives restart', async () => {
    expect(await store.list()).toEqual([]);
    const scan = rankingScan();
    await Promise.all([store.add(scan, ['Keep the original context']), ...Array.from({ length: 5 }, (_, index) => store.add(rankingScan(`other-${index}`)))]);
    const original = (await store.list()).find(record => record.scan.id === scan.id)!;
    scan.candidates.reverse(); scan.prompt = 'Changed after saving';
    await store.add(scan, ['Changed context']);
    const records = await new ChatRankingStore(file).list();
    expect(records).toHaveLength(6);
    expect(records.find(record => record.scan.id === scan.id)).toEqual(original);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(records);
  });

  it('recovers overdue horizons after restart and preserves a concurrent new ranking', async () => {
    await store.add(rankingScan());
    const record = (await store.list())[0];
    const points: [number, number][] = [[record.referenceTime, 100], ...[4, 24, 168].map(hours => [record.referenceTime + hours * HOUR, 105] as [number, number])];
    await Promise.all([store.resolve([observedMarket('BTC', points)], record.referenceTime + 168 * HOUR), store.add(rankingScan('new'))]);
    const records = await new ChatRankingStore(file).list();
    expect(records).toHaveLength(2);
    expect(records.find(item => item.scan.id === 'ranking-1')!.tracking[0].outcomes.every(item => item.status === 'evaluated')).toBe(true);
    expect(records.find(item => item.scan.id === 'new')!.tracking[0].outcomes.every(item => item.status === 'pending')).toBe(true);
  });

  it.each(['{"unfinished":', '{"wrong":true}', JSON.stringify([createRankingRecord(rankingScan(), [], SCAN_TIME + 1000), createRankingRecord(rankingScan(), [], SCAN_TIME + 1000)])])('preserves invalid journals and refuses new writes', async original => {
    await writeFile(file, original);
    await expect(store.list()).rejects.toThrow(/journal is invalid/);
    await expect(store.add(rankingScan('new'))).rejects.toThrow(/journal is invalid/);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('rejects edited returns, target times, and ranking order without replacing the file', async () => {
    await store.add(rankingScan());
    const base = (await store.list())[0];
    const scored = resolveRanking(base, [observedMarket('BTC', [[base.referenceTime, 100], [base.referenceTime + 4 * HOUR, 110]])], base.referenceTime + 4 * HOUR);
    const mutations = [
      { ...scored, tracking: [...scored.tracking].reverse() },
      { ...scored, referenceTime: scored.referenceTime + HOUR },
      { ...scored, tracking: scored.tracking.map((item, index) => index ? item : { ...item, outcomes: item.outcomes.map((outcome, position) => position ? outcome : { ...outcome, returnPercent: 999 }) }) },
    ];
    for (const record of mutations) {
      const original = JSON.stringify([record]);
      await writeFile(file, original);
      await expect(store.list()).rejects.toThrow(/journal is invalid/);
      await expect(store.add(rankingScan('new'))).rejects.toThrow(/journal is invalid/);
      expect(await readFile(file, 'utf8')).toBe(original);
    }
  });
});

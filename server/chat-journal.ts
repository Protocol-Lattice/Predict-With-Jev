import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HORIZONS, type Market, type MarketChatResult } from '../shared/types.js';
import type { ChatRankingRecord, ChatRankingSummary, RankingReference } from '../shared/chat-journal.js';
import { HOUR } from './analysis.js';
import { chatRankingJournalSchema } from './chat-journal-schema.js';

export class ChatRankingStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'ChatRankingStoreError'; }
}

function validate(data: unknown): ChatRankingRecord[] {
  const parsed = chatRankingJournalSchema.safeParse(data);
  if (!parsed.success) throw new ChatRankingStoreError(`The chat ranking journal is invalid at ${parsed.error.issues[0].path.join('.') || 'root'}. Restore a valid backup before continuing. Existing records have not been changed.`);
  return parsed.data;
}

export function createRankingRecord(scan: MarketChatResult, history: string[], now = Date.now()): ChatRankingRecord {
  const referenceTime = (Math.floor(now / HOUR) + 1) * HOUR;
  return {
    version: 1, scan: structuredClone(scan), history: [...history], savedAt: now, referenceTime,
    tracking: scan.candidates.map(candidate => ({
      symbol: candidate.symbol, reference: { status: 'pending' },
      outcomes: HORIZONS.map(horizon => ({ horizon, targetTime: referenceTime + horizon * HOUR, status: 'pending' })),
    })),
  };
}

export function dueRankingSymbols(records: ChatRankingRecord[], now = Date.now()): string[] {
  return [...new Set(records.flatMap(record => record.tracking.filter(item =>
    item.reference.status === 'pending' && record.referenceTime <= now
    || item.reference.status === 'captured' && item.outcomes.some(outcome => outcome.status === 'pending' && outcome.targetTime <= now)
  ).map(item => item.symbol)))];
}

export function resolveRanking(record: ChatRankingRecord, markets: Market[], now = Date.now()): ChatRankingRecord {
  const observations = new Map(markets.filter(market => market.source === 'kraken' && !market.stale).map(market => [market.symbol, market]));
  let changed = false;
  const tracking = record.tracking.map(item => {
    const market = observations.get(item.symbol);
    if (!market) return item;
    const candles = market.candles.filter(candle => candle.time <= now && Number.isFinite(candle.close) && candle.close > 0);
    if (!candles.length) return item;
    const lastTime = Math.max(...candles.map(candle => candle.time));
    let reference: RankingReference = item.reference;
    if (reference.status === 'pending' && record.referenceTime <= now) {
      const close = candles.find(candle => candle.time === record.referenceTime);
      if (close) reference = { status: 'captured', price: close.close, capturedAt: now };
      else if (lastTime >= record.referenceTime) reference = { status: 'unavailable', reason: 'The exact reference hourly close is unavailable in Kraken history.', checkedAt: now };
    }
    const outcomes = item.outcomes.map(outcome => {
      if (outcome.status !== 'pending') return outcome;
      if (reference.status === 'unavailable') return { horizon: outcome.horizon, targetTime: outcome.targetTime, status: 'unavailable' as const, reason: 'Return cannot be measured because the reference close is unavailable.', checkedAt: now };
      if (reference.status !== 'captured' || outcome.targetTime > now) return outcome;
      const close = candles.find(candle => candle.time === outcome.targetTime);
      if (close) return { horizon: outcome.horizon, targetTime: outcome.targetTime, status: 'evaluated' as const, price: close.close, returnPercent: (close.close / reference.price - 1) * 100, evaluatedAt: now };
      if (lastTime >= outcome.targetTime) return { horizon: outcome.horizon, targetTime: outcome.targetTime, status: 'unavailable' as const, reason: 'The exact outcome hourly close is unavailable in Kraken history.', checkedAt: now };
      return outcome;
    });
    if (reference === item.reference && outcomes.every((outcome, index) => outcome === item.outcomes[index])) return item;
    changed = true;
    return { ...item, reference, outcomes };
  });
  return changed ? { ...record, tracking } : record;
}

export function summarizeRankings(records: ChatRankingRecord[]): ChatRankingSummary {
  const selected = records.filter(record => record.scan.winner !== null);
  return {
    total: records.length, selected: selected.length, noSelection: records.length - selected.length,
    horizons: HORIZONS.map(horizon => {
      const outcomes = selected.map(record => record.tracking.find(item => item.symbol === record.scan.winner)!.outcomes.find(outcome => outcome.horizon === horizon)!);
      const evaluated = outcomes.filter(outcome => outcome.status === 'evaluated');
      return {
        horizon, evaluated: evaluated.length,
        pending: outcomes.filter(outcome => outcome.status === 'pending').length,
        unavailable: outcomes.filter(outcome => outcome.status === 'unavailable').length,
        averageReturnPercent: evaluated.length ? evaluated.reduce((sum, outcome) => sum + outcome.returnPercent, 0) / evaluated.length : null,
        positivePercent: evaluated.length ? evaluated.filter(outcome => outcome.returnPercent > 0).length / evaluated.length * 100 : null,
      };
    }),
  };
}

export class ChatRankingStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private clock: () => number = Date.now) {}

  private async read(): Promise<ChatRankingRecord[]> {
    try { return validate(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (error instanceof SyntaxError) throw new ChatRankingStoreError('The chat ranking journal is invalid JSON. Restore a valid backup before continuing. Existing records have not been changed.');
      if (error instanceof ChatRankingStoreError) throw error;
      throw new ChatRankingStoreError('The chat ranking journal could not be read. Check the data directory and permissions.');
    }
  }

  async list(): Promise<ChatRankingRecord[]> { await this.queue; return this.read(); }

  private update(transform: (records: ChatRankingRecord[]) => ChatRankingRecord[]): Promise<ChatRankingRecord[]> {
    const job = this.queue.then(async () => {
      const previous = await this.read();
      const next = transform(previous);
      if (next === previous) return previous;
      const records = validate(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
        await rename(temporary, this.file);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new ChatRankingStoreError('The chat ranking could not be saved. Check the data directory and permissions, then retry. Existing records have not been changed.');
      }
      return records;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async add(scan: MarketChatResult, history: string[] = []): Promise<void> {
    const snapshot = structuredClone(scan), context = [...history];
    await this.update(records => records.some(record => record.scan.id === snapshot.id)
      ? records : [createRankingRecord(snapshot, context, this.clock()), ...records]);
  }

  async resolve(markets: Market[], now = this.clock()): Promise<void> {
    await this.update(records => {
      const next = records.map(record => resolveRanking(record, markets, now));
      return next.every((record, index) => record === records[index]) ? records : next;
    });
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Forecast, Market } from '../shared/types.js';
import { classifyReturn } from './analysis.js';
import { forecastJournalSchema } from './forecast-schema.js';

export class ForecastStoreError extends Error {
  constructor(message: string) { super(message); this.name = 'ForecastStoreError'; }
}

function validateJournal(data: unknown, writing = false): Forecast[] {
  const parsed = forecastJournalSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new ForecastStoreError(writing
      ? `The forecast could not be saved: invalid data${location}. Existing records have not been changed.`
      : `The forecast journal is invalid${location}. Restore a valid backup before continuing. Existing records have not been changed.`);
  }
  return parsed.data;
}

export function resolveForecast(forecast: Forecast, market: Market, now = Date.now()): Forecast {
  if (forecast.outcome || forecast.symbol !== market.symbol || market.source !== forecast.dataSource || market.stale || forecast.targetTime > now) return forecast;
  // Resolve against the exact completed hourly close, never the current price or a nearby candle.
  const candle = market.candles.find(item => item.time === forecast.targetTime);
  if (!candle) return forecast;
  const change = candle.close / forecast.referencePrice - 1;
  const direction = classifyReturn(change, forecast.neutralThreshold);
  const brier = forecast.probabilities ? (['bullish', 'neutral', 'bearish'] as const).reduce((sum, value) => sum + (forecast.probabilities![value] - Number(value === direction)) ** 2, 0) : null;
  return { ...forecast, outcome: { price: candle.close, change, direction, correct: direction === forecast.direction, brier, evaluatedAt: now } };
}

export class ForecastStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}

  private async read(): Promise<Forecast[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      return validateJournal(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (error instanceof SyntaxError) throw new ForecastStoreError('The forecast journal is invalid JSON. Restore a valid backup before continuing. Existing records have not been changed.');
      throw error;
    }
  }

  async list(): Promise<Forecast[]> {
    await this.queue;
    return this.read();
  }

  private update(transform: (items: Forecast[]) => Forecast[]): Promise<Forecast[]> {
    const next = this.queue.then(async () => {
      const items = validateJournal(transform(await this.read()).slice(0, 2000), true);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(items, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
      return items;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async add(forecast: Forecast): Promise<void> {
    await this.update(items => [forecast, ...items.filter(item => item.id !== forecast.id)]);
  }

  async resolve(markets: Market[]): Promise<Forecast[]> {
    const previous = await this.list();
    if (!previous.some(item => !item.outcome && item.targetTime <= Date.now())) return previous;
    return this.update(items => items.map(item => {
      const market = markets.find(value => value.symbol === item.symbol);
      return market ? resolveForecast(item, market) : item;
    }));
  }
}

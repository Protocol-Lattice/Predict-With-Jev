import { z } from 'zod';
import { HORIZONS, type Forecast } from '../shared/types.js';
import { classifyReturn, HOUR } from './analysis.js';

const direction = z.enum(['bullish', 'neutral', 'bearish']);
const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const timestamp = finite.int().min(0).max(8_640_000_000_000_000);
const probability = finite.min(0).max(1);
const directions = ['bullish', 'neutral', 'bearish'] as const;
const closeEnough = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));

// Preserve additional historical metadata while validating every field the app consumes.
const forecastSchema: z.ZodType<Forecast> = z.object({
  id: z.string().min(1).regex(/\S/),
  symbol: z.string().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/),
  horizon: z.literal(HORIZONS),
  direction,
  probabilities: z.object({ bullish: probability, neutral: probability, bearish: probability }).passthrough().nullable(),
  referencePrice: positive,
  referenceTime: timestamp.refine(value => value % HOUR === 0, 'Expected an hourly close.'),
  targetTime: timestamp,
  createdAt: timestamp,
  range: z.object({ low: positive, high: positive }).passthrough(),
  neutralThreshold: nonnegative,
  indicators: z.object({
    rsi: finite.min(0).max(100),
    ema20: positive,
    ema50: positive,
    momentum24h: finite,
    momentum7d: finite,
    hourlyVolatility: nonnegative,
    volumeRatio: nonnegative,
    trendStrength: finite,
    support: positive,
    resistance: positive,
  }).passthrough(),
  engine: z.enum(['jev', 'baseline']),
  dataSource: z.enum(['kraken', 'demo']),
  model: z.string().min(1).regex(/\S/),
  latencyMs: nonnegative,
  cost: nonnegative.nullable(),
  outcome: z.object({
    price: positive,
    change: finite,
    direction,
    correct: z.boolean(),
    evaluatedAt: timestamp,
    brier: finite.min(0).max(2).nullable(),
  }).passthrough().nullable(),
}).passthrough().superRefine((forecast, context) => {
  const invalid = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  if (forecast.targetTime !== forecast.referenceTime + forecast.horizon * HOUR) invalid(['targetTime'], 'Does not match the reference close and horizon.');
  if (forecast.createdAt < forecast.referenceTime || forecast.createdAt >= forecast.targetTime) invalid(['createdAt'], 'Must be saved between the reference close and outcome.');
  if (forecast.range.low > forecast.referencePrice || forecast.range.high < forecast.referencePrice) invalid(['range'], 'Must enclose the reference price.');
  if (forecast.indicators.support > forecast.indicators.resistance) invalid(['indicators'], 'Support exceeds resistance.');
  if ((forecast.engine === 'jev') !== (forecast.probabilities !== null)) invalid(['probabilities'], 'JEV requires probabilities; the technical baseline does not supply them.');
  if (forecast.probabilities) {
    const total = directions.reduce((sum, key) => sum + forecast.probabilities![key], 0);
    if (!closeEnough(total, 1)) invalid(['probabilities'], 'Probabilities must sum to one.');
  }
  if (forecast.outcome) {
    const outcome = forecast.outcome;
    const change = outcome.price / forecast.referencePrice - 1;
    const actualDirection = classifyReturn(change, forecast.neutralThreshold);
    if (outcome.evaluatedAt < forecast.targetTime) invalid(['outcome', 'evaluatedAt'], 'Cannot score an unfinished outcome.');
    if (!closeEnough(outcome.change, change)) invalid(['outcome', 'change'], 'Does not match the recorded prices.');
    if (outcome.direction !== actualDirection) invalid(['outcome', 'direction'], 'Does not match the return and neutral band.');
    if (outcome.correct !== (forecast.direction === actualDirection)) invalid(['outcome', 'correct'], 'Does not match the predicted and realized directions.');
    const brier = forecast.probabilities
      ? directions.reduce((sum, key) => sum + (forecast.probabilities![key] - Number(key === actualDirection)) ** 2, 0)
      : null;
    if (brier === null ? outcome.brier !== null : outcome.brier === null || !closeEnough(outcome.brier, brier)) invalid(['outcome', 'brier'], 'Does not match the probabilities and realized direction.');
  }
});

export const forecastJournalSchema = z.array(forecastSchema).superRefine((records, context) => {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    if (ids.has(record.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate forecast ID.' });
    ids.add(record.id);
  });
});

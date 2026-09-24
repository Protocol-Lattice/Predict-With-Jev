import { z } from 'zod';
import { CHAT_OBJECTIVES, HORIZONS, type MarketChatResult } from '../shared/types.js';
import { STABLECOIN_SCOPES } from '../shared/stablecoins.js';
import type { ChatRankingRecord } from '../shared/chat-journal.js';
import { HOUR } from './analysis.js';
import { decisionPipelineSchema } from './decision-schema.js';

const finite = z.number().finite();
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const timestamp = finite.int().min(0).max(8_640_000_000_000_000);
const count = nonnegative.int();
const weight = finite.min(0).max(1);
const symbol = z.string().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const horizon = z.literal(HORIZONS);
const text = z.string().min(1);
const closeEnough = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected));

const scanSchema: z.ZodType<MarketChatResult> = z.object({
  id: text, prompt: z.string().min(3).max(1200), reply: text, horizon,
  assetScope: z.enum(STABLECOIN_SCOPES), objective: z.enum(CHAT_OBJECTIVES),
  winner: symbol.nullable(), comparisonLeader: symbol.nullable(),
  candidates: z.array(z.object({
    symbol, name: text, price: positive, changeToday: finite, volume24h: nonnegative,
    selectionWeight: weight, rsi: finite.min(0).max(100), trend: z.enum(['bullish', 'bearish']),
    hourlyVolatility: nonnegative, referenceTime: timestamp,
    momentum: z.object({ return1hPercent: finite.nullable(), return4hPercent: finite.nullable(), return24hPercent: finite.nullable(), relativeVolume4h: nonnegative.nullable(), priceVsPrior24hHighPercent: finite.nullable() }).passthrough(),
    risks: z.array(z.string()),
  }).passthrough()).min(1).max(20),
  noCandidateWeight: weight, createdAt: timestamp, dataAsOf: timestamp,
  catalogCount: count, scannedCount: count, batches: count, comparisonBatches: count,
  modelCalls: count, finalistCount: count, shortlistCount: count, evaluatedCount: count,
  unavailableSymbols: z.array(symbol), historyUnavailable: z.array(symbol),
  model: text, cost: nonnegative.nullable(), latencyMs: nonnegative,
  pipeline: decisionPipelineSchema.optional(),
}).passthrough();

const reference = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('captured'), price: positive, capturedAt: timestamp }),
  z.object({ status: z.literal('unavailable'), reason: text, checkedAt: timestamp }),
]);
const outcome = z.intersection(z.object({ horizon, targetTime: timestamp }), z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('evaluated'), price: positive, returnPercent: finite, evaluatedAt: timestamp }),
  z.object({ status: z.literal('unavailable'), reason: text, checkedAt: timestamp }),
]));

export const chatRankingSchema: z.ZodType<ChatRankingRecord> = z.object({
  version: z.literal(1), scan: scanSchema, history: z.array(z.string().max(1200)).max(4),
  savedAt: timestamp, referenceTime: timestamp,
  tracking: z.array(z.object({ symbol, reference, outcomes: z.array(outcome).length(3) })).min(1).max(20),
}).passthrough().superRefine((record, context) => {
  const invalid = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  if (record.referenceTime !== (Math.floor(record.savedAt / HOUR) + 1) * HOUR) invalid(['referenceTime'], 'Must be the first hourly close after the ranking was saved.');
  if (record.savedAt < record.scan.createdAt || record.savedAt >= record.referenceTime) invalid(['savedAt'], 'The ranking must be saved before its reference close.');
  if (record.scan.dataAsOf > record.scan.createdAt) invalid(['scan', 'dataAsOf'], 'Scan data cannot come from the future.');
  const symbols = record.scan.candidates.map(candidate => candidate.symbol);
  if (new Set(symbols).size !== symbols.length || record.scan.finalistCount !== symbols.length) invalid(['scan', 'candidates'], 'Duplicate candidates or inconsistent finalist count.');
  if (record.scan.winner && !symbols.includes(record.scan.winner)) invalid(['scan', 'winner'], 'Winner is missing from the ranking.');
  if (record.scan.comparisonLeader && !symbols.includes(record.scan.comparisonLeader)) invalid(['scan', 'comparisonLeader'], 'Comparison leader is missing from the ranking.');
  const pipeline = record.scan.pipeline;
  if (pipeline && pipeline.decisions.length >= 6) {
    const records = pipeline.decisions;
    const final = records.at(-3)!.answers.selection;
    const setup = records.at(-2)!.answers.setup;
    const winner = pipeline.action.choice === 'research' ? pipeline.action.symbol : null;
    const cost = records.every(item => item.cost !== null) ? records.reduce((sum, item) => sum + item.cost!, 0) : null;
    if (!final || !setup || record.scan.winner !== winner || record.scan.modelCalls !== records.length || !closeEnough(record.scan.noCandidateWeight, setup.probabilities.weak)
      || !symbols.includes(pipeline.action.symbol) || records.some(item => item.completedAt > record.scan.createdAt)
      || (cost === null ? record.scan.cost !== null : record.scan.cost === null || !closeEnough(record.scan.cost, cost))
      || record.scan.candidates.some(item => !closeEnough(item.selectionWeight, final.probabilities[item.symbol]))) invalid(['scan', 'pipeline'], 'Scan must agree with its recorded decisions.');
  }
  if (record.tracking.length !== symbols.length || record.tracking.some((item, index) => item.symbol !== symbols[index])) invalid(['tracking'], 'Tracking must preserve the original ranking.');
  record.tracking.forEach((item, index) => {
    const base = ['tracking', index];
    if (item.reference.status === 'captured' && item.reference.capturedAt < record.referenceTime) invalid([...base, 'reference'], 'Cannot capture an unfinished reference close.');
    if (item.reference.status === 'unavailable' && item.reference.checkedAt < record.referenceTime) invalid([...base, 'reference'], 'Cannot mark a future reference as missing.');
    item.outcomes.forEach((result, position) => {
      const location = [...base, 'outcomes', position];
      if (result.horizon !== HORIZONS[position] || result.targetTime !== record.referenceTime + result.horizon * HOUR) invalid(location, 'Outcome must match its reference close and horizon.');
      if (result.status === 'evaluated') {
        if (result.evaluatedAt < result.targetTime) invalid(location, 'Cannot evaluate a future outcome.');
        if (item.reference.status !== 'captured' || !closeEnough(result.returnPercent, (result.price / item.reference.price - 1) * 100)) invalid(location, 'Return must match captured reference and outcome prices.');
      }
      if (result.status === 'unavailable' && result.checkedAt < result.targetTime && item.reference.status !== 'unavailable') invalid(location, 'A future outcome can only be unavailable when its reference is unavailable.');
    });
  });
});

export const chatRankingJournalSchema = z.array(chatRankingSchema).superRefine((records, context) => {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    if (ids.has(record.scan.id)) context.addIssue({ code: 'custom', path: [index, 'scan', 'id'], message: 'Duplicate ranking ID.' });
    ids.add(record.scan.id);
  });
});

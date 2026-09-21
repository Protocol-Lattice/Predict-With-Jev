import { z } from 'zod';
import type { Direction, Horizon, Market, Probabilities } from '../shared/types.js';
import { neutralThreshold } from './analysis.js';

export const MODEL = 'typesafe/jev-1.13';
export const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
export class JevError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.object({
    direction: z.object({
      type: z.literal('choice'),
      choice: z.enum(['bullish', 'neutral', 'bearish']),
      probabilities: z.object({ bullish: probability, neutral: probability, bearish: probability }),
    }),
  }),
  usage: z.object({ cost: z.number().finite().min(0).optional() }).optional(),
});

export function parseJev(payload: unknown): { direction: Direction; probabilities: Probabilities; model: string; cost: number | null } {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) throw new JevError('JEV returned an invalid structured decision. No forecast was saved.');
  const { choice, probabilities } = parsed.data.answers.direction;
  const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.025 || sum === 0 || probabilities[choice] + 0.001 < Math.max(...Object.values(probabilities))) {
    throw new JevError('JEV returned inconsistent probabilities. No forecast was saved.');
  }
  if (!parsed.data.model.startsWith('typesafe/jev-1.13')) throw new JevError('The provider returned an unexpected model. No forecast was saved.');
  return {
    direction: choice,
    probabilities: { bullish: probabilities.bullish / sum, neutral: probabilities.neutral / sum, bearish: probabilities.bearish / sum },
    model: parsed.data.model,
    cost: parsed.data.usage?.cost ?? null,
  };
}

export function decisionRequest(market: Market, horizon: Horizon) {
  const threshold = neutralThreshold(market.indicators, horizon) * 100;
  const last = market.candles.at(-1)!;
  return {
    model: MODEL,
    state: {
      purpose: 'Experimental crypto direction forecast. Use only the supplied observations; no future prices, external news, or assumed predictive performance are available.',
      asset: `${market.symbol}/USD`,
      exchange: 'Kraken spot',
      candle_interval_hours: 1,
      reference_close_usd: last.close,
      as_of: new Date(last.time).toISOString(),
      forecast_horizon_hours: horizon,
      neutral_band_percent: threshold,
      indicators: market.indicators,
      completed_candles: market.candles.slice(-72).map(candle => ({ time: new Date(candle.time).toISOString(), open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume })),
    },
    questions: {
      direction: {
        type: 'choice',
        instructions: `Estimate the most likely closing-price direction ${horizon} hours after as_of, relative to reference_close_usd. Account for weak evidence, noisy crypto prices, reversals, and the horizon. Do not interpret technical signals as guarantees. Return probabilities across all three mutually exclusive outcomes.`,
        criteria: {
          bullish: `The closing price increases by MORE than ${threshold.toFixed(6)} percent from the reference close.`,
          neutral: `The closing price remains within plus or minus ${threshold.toFixed(6)} percent of the reference close, including the boundaries.`,
          bearish: `The closing price decreases by MORE than ${threshold.toFixed(6)} percent from the reference close.`,
        },
      },
    },
  };
}

export async function askJev(market: Market, horizon: Horizon, apiKey: string, request: typeof fetch = fetch) {
  if (!apiKey.trim()) throw new JevError('Add OPENROUTER_API_KEY to .env and restart to enable JEV.', 503);
  if (market.source !== 'kraken' || market.stale) throw new JevError('JEV needs fresh Kraken market data.', 409);
  const { payload, latencyMs } = await requestSystemOne(decisionRequest(market, horizon), apiKey, request);
  return { ...parseJev(payload), latencyMs };
}

export async function requestSystemOne(body: unknown, apiKey: string, request: typeof fetch = fetch) {
  if (!apiKey.trim()) throw new JevError('Add OPENROUTER_API_KEY to .env and restart to enable JEV.', 503);
  const start = performance.now();
  let response: Response;
  try {
    response = await request(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'JEV Terminal' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new JevError('JEV could not be reached or timed out. Retry when the connection is available.'); }
  if (!response.ok) {
    const messages: Record<number, string> = {
      401: 'OpenRouter rejected the API key. Update OPENROUTER_API_KEY and restart.',
      402: 'The OpenRouter account needs credits to run JEV.',
      429: 'OpenRouter rate limit reached. Please retry shortly.',
    };
    throw new JevError(messages[response.status] ?? `JEV is unavailable (HTTP ${response.status}). Please retry.`, 502);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new JevError('JEV returned an unreadable response.'); }
  return { payload, latencyMs: Math.round(performance.now() - start) };
}

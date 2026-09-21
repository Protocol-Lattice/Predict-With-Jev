import type { Candle, Direction, Horizon, Indicators, Market, Replay } from '../shared/types.js';

export const HOUR = 3_600_000;
export const MIN_HISTORY = 200;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function ema(values: number[], period: number): number {
  const weight = 2 / (period + 1);
  return values.slice(1).reduce((previous, value) => value * weight + previous * (1 - weight), values[0]);
}

export function rsi(values: number[], period = 14): number {
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let gain = mean(changes.slice(0, period).map(value => Math.max(value, 0)));
  let loss = mean(changes.slice(0, period).map(value => Math.max(-value, 0)));
  for (const change of changes.slice(period)) {
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function indicators(candles: Candle[]): Indicators {
  if (candles.length < MIN_HISTORY) throw new Error(`At least ${MIN_HISTORY} completed hourly candles are required.`);
  const closes = candles.map(candle => candle.close);
  const price = closes.at(-1)!;
  const recent = closes.slice(-169);
  const returns = recent.slice(1).map((value, index) => Math.log(value / recent[index]));
  const average = mean(returns);
  const volatility = Math.sqrt(returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1));
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const previousVolume = mean(candles.slice(-48, -24).map(candle => candle.volume));
  return {
    rsi: rsi(closes),
    ema20: fast,
    ema50: slow,
    momentum24h: (price / closes.at(-25)! - 1) * 100,
    momentum7d: (price / closes.at(-169)! - 1) * 100,
    hourlyVolatility: volatility,
    volumeRatio: previousVolume > 0 ? mean(candles.slice(-24).map(candle => candle.volume)) / previousVolume : 1,
    trendStrength: volatility > 0 ? (fast / slow - 1) / (volatility * Math.sqrt(24)) : 0,
    support: Math.min(...candles.slice(-168).map(candle => candle.low)),
    resistance: Math.max(...candles.slice(-168).map(candle => candle.high)),
  };
}

/** Fixed before every forecast and reused unchanged when resolving its outcome. */
export function neutralThreshold(features: Indicators, horizon: Horizon): number {
  return Math.max(0.0025, features.hourlyVolatility * Math.sqrt(horizon) * 0.35);
}

export function classifyReturn(change: number, threshold: number): Direction {
  if (change > threshold) return 'bullish';
  if (change < -threshold) return 'bearish';
  return 'neutral';
}

export function baselineDirection(features: Indicators, horizon: Horizon): Direction {
  const sigma = features.hourlyVolatility;
  if (sigma < 1e-10) return 'neutral';
  const score = 0.5 * clamp(features.trendStrength, -2, 2)
    + 0.35 * clamp(features.momentum24h / 100 / (sigma * Math.sqrt(24)), -2, 2)
    + 0.15 * clamp((features.rsi - 50) / 25, -2, 2);
  return classifyReturn(score * sigma * Math.sqrt(horizon) * 0.5, neutralThreshold(features, horizon));
}

export function scenarioRange(price: number, features: Indicators, horizon: Horizon) {
  const width = 1.645 * features.hourlyVolatility * Math.sqrt(horizon);
  return { low: price * Math.exp(-width), high: price * Math.exp(width) };
}

/** Non-overlapping walk-forward windows; only the prefix available at prediction time is inspected. */
export function replay(market: Market, horizon: Horizon): Replay {
  const points: Replay['points'] = [];
  const candles = market.candles;
  for (let index = MIN_HISTORY - 1; index + horizon < candles.length; index += horizon) {
    const past = candles.slice(0, index + 1);
    const features = indicators(past);
    const target = candles[index + horizon];
    if (target.time !== candles[index].time + horizon * HOUR) continue;
    const change = target.close / candles[index].close - 1;
    const direction = baselineDirection(features, horizon);
    const actual = classifyReturn(change, neutralThreshold(features, horizon));
    points.push({ time: candles[index].time, referencePrice: candles[index].close, direction, actual, correct: direction === actual, change });
  }
  const counts = ['bullish', 'neutral', 'bearish'].map(direction => points.filter(point => point.actual === direction).length);
  return {
    symbol: market.symbol,
    horizon,
    points,
    accuracy: points.length ? points.filter(point => point.correct).length / points.length : null,
    neutralAccuracy: points.length ? counts[1] / points.length : null,
    majorityAccuracy: points.length ? Math.max(...counts) / points.length : null,
    sampleCount: points.length,
    from: points[0]?.time ?? null,
    to: points.at(-1) ? points.at(-1)!.time + horizon * HOUR : null,
    source: market.source,
  };
}

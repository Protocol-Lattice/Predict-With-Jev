import type { ChatMomentumEvidence, Market } from '../shared/types.js';

/** Use the same completed hourly candles as the rest of the chat evidence. */
export function chatMomentum(market: Market): ChatMomentumEvidence {
  const candles = market.candles;
  const close = candles.at(-1)?.close;
  const change = (reference: number | undefined) => {
    if (close === undefined || !Number.isFinite(close) || close <= 0 || reference === undefined || !Number.isFinite(reference) || reference <= 0) return null;
    const value = (close / reference - 1) * 100;
    return Number.isFinite(value) ? value : null;
  };
  const recentVolumes = candles.slice(-4).map(candle => candle.volume);
  const priorVolumes = candles.slice(-24, -4).map(candle => candle.volume);
  let relativeVolume4h: number | null = null;
  if (recentVolumes.length === 4 && priorVolumes.length === 20 && [...recentVolumes, ...priorVolumes].every(volume => Number.isFinite(volume) && volume >= 0)) {
    const priorAverage = priorVolumes.reduce((sum, volume) => sum + volume, 0) / 20;
    const ratio = (recentVolumes.reduce((sum, volume) => sum + volume, 0) / 4) / priorAverage;
    if (priorAverage > 0 && Number.isFinite(ratio)) relativeVolume4h = ratio;
  }
  const priorHighs = candles.slice(-25, -1).map(candle => candle.high);
  return {
    return1hPercent: change(candles.at(-2)?.close),
    return4hPercent: change(candles.at(-5)?.close),
    return24hPercent: change(candles.at(-25)?.close),
    relativeVolume4h,
    priceVsPrior24hHighPercent: priorHighs.length === 24 && priorHighs.every(high => Number.isFinite(high) && high > 0) ? change(Math.max(...priorHighs)) : null,
  };
}

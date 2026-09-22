import type { Candle } from '../shared/types';

export interface ChartSelection { anchorTime: number; endTime: number }

/** Snap to an observed close, including when a drag leaves the historical plot. */
export function nearestCandleIndex(candles: Candle[], time: number): number {
  if (!candles.length) return -1;
  let low = 0, high = candles.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low > 0 && time - candles[low - 1].time <= candles[low].time - time ? low - 1 : low;
}

export function measurePriceChange(candles: Candle[], selection: ChartSelection | null) {
  if (!selection || selection.anchorTime === selection.endTime) return null;
  const start = candles.find(candle => candle.time === Math.min(selection.anchorTime, selection.endTime));
  const end = candles.find(candle => candle.time === Math.max(selection.anchorTime, selection.endTime));
  if (!start || !end || !Number.isFinite(start.close) || !Number.isFinite(end.close) || start.close <= 0 || end.close <= 0) return null;
  return {
    start, end,
    change: end.close - start.close,
    changePercent: (end.close / start.close - 1) * 100,
    durationHours: (end.time - start.time) / 3_600_000,
  };
}

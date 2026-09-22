import { describe, expect, it } from 'vitest';
import type { Candle } from '../shared/types';
import { measurePriceChange, nearestCandleIndex } from '../src/chart-selection';

const HOUR = 3_600_000;
const first = Date.UTC(2026, 8, 22);
const candles: Candle[] = [100, 125, 80, 100].map((close, index) => ({ time: first + index * HOUR, open: close, high: close, low: close, close, volume: 1, vwap: close }));

describe('chart price measurement', () => {
  it('measures a rise using the initial close as the percentage base', () => {
    const result = measurePriceChange(candles, { anchorTime: first, endTime: first + HOUR });
    expect(result?.changePercent).toBe(25);
    expect(result?.change).toBe(25);
    expect(result?.durationHours).toBe(1);
  });
  it('measures a fall chronologically even when selecting right to left', () => {
    const forward = measurePriceChange(candles, { anchorTime: first + HOUR, endTime: first + 2 * HOUR });
    const backward = measurePriceChange(candles, { anchorTime: first + 2 * HOUR, endTime: first + HOUR });
    expect(backward).toEqual(forward);
    expect(backward?.changePercent).toBe(-36);
    expect(backward?.change).toBe(-45);
    expect(backward?.start.close).toBe(125);
    expect(backward?.end.close).toBe(80);
  });
  it('reports a flat period as zero and requires two available observations', () => {
    expect(measurePriceChange(candles, { anchorTime: first, endTime: first + 3 * HOUR })?.changePercent).toBe(0);
    expect(measurePriceChange(candles, { anchorTime: first, endTime: first })).toBeNull();
    expect(measurePriceChange(candles, null)).toBeNull();
    expect(measurePriceChange(candles.slice(1), { anchorTime: first, endTime: first + HOUR })).toBeNull();
    expect(measurePriceChange(candles, { anchorTime: first, endTime: first + 8 * HOUR })).toBeNull();
  });
  it('keeps the selected timestamps when the history window advances', () => {
    const selected = { anchorTime: first + HOUR, endTime: first + 2 * HOUR };
    expect(measurePriceChange(candles.slice(1), selected)).toEqual(measurePriceChange(candles, selected));
  });
  it('snaps to actual observations and clamps future projection times to the last close', () => {
    expect(nearestCandleIndex(candles, first - HOUR)).toBe(0);
    expect(nearestCandleIndex(candles, first + HOUR * 1.4)).toBe(1);
    expect(nearestCandleIndex(candles, first + HOUR * 1.6)).toBe(2);
    expect(nearestCandleIndex(candles, first + HOUR * 24)).toBe(3);
    expect(nearestCandleIndex([candles[0], candles[3]], first + 2 * HOUR)).toBe(1);
    expect(nearestCandleIndex([], first)).toBe(-1);
  });
  it('does not turn missing or invalid prices into a percentage', () => {
    for (const close of [0, -1, NaN, Infinity]) {
      const invalid = [{ ...candles[0], close }, candles[1]];
      expect(measurePriceChange(invalid, { anchorTime: first, endTime: first + HOUR })).toBeNull();
    }
  });
});

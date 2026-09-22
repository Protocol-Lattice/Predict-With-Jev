import { describe, expect, it } from 'vitest';
import { chatMomentum } from '../server/chat-signals';
import { demoMarket } from '../server/market';

function market() {
  const original = demoMarket('BTC');
  const candles = original.candles.slice(-25).map((candle, index) => ({
    ...candle, open: 100, close: index === 24 ? 110 : 100,
    low: 90, high: index === 24 ? 120 : 105,
    volume: index === 0 ? 10_000 : index >= 21 ? 300 : 100,
  }));
  return { ...original, candles };
}

describe('observed chat momentum', () => {
  it('computes close-to-close returns, non-overlapping volume windows, and a breakout against prior highs', () => {
    const result = chatMomentum(market());
    expect(result.return1hPercent).toBeCloseTo(10);
    expect(result.return4hPercent).toBeCloseTo(10);
    expect(result.return24hPercent).toBeCloseTo(10);
    expect(result.relativeVolume4h).toBeCloseTo(3);
    // The latest candle's high of 120 must not leak into the prior-high reference.
    expect(result.priceVsPrior24hHighPercent).toBeCloseTo((110 / 105 - 1) * 100);
  });
  it('preserves negative price action even when recent volume expands', () => {
    const data = market();
    data.candles.at(-1)!.close = 95;
    const result = chatMomentum(data);
    expect(result.return4hPercent).toBeCloseTo(-5);
    expect(result.relativeVolume4h).toBe(3);
    expect(result.priceVsPrior24hHighPercent).toBeLessThan(0);
  });
  it('reports an undefined volume baseline as missing, while zero recent volume remains zero', () => {
    const data = market();
    data.candles.slice(-24, -4).forEach(candle => { candle.volume = 0; });
    expect(chatMomentum(data).relativeVolume4h).toBeNull();
    data.candles.slice(-24, -4).forEach(candle => { candle.volume = 100; });
    data.candles.slice(-4).forEach(candle => { candle.volume = 0; });
    expect(chatMomentum(data).relativeVolume4h).toBe(0);
  });
  it('does not invent signals when the required observations are missing', () => {
    const data = market();
    data.candles = data.candles.slice(-4);
    expect(chatMomentum(data)).toMatchObject({ return4hPercent: null, return24hPercent: null, relativeVolume4h: null, priceVsPrior24hHighPercent: null });
    data.candles = [];
    expect(Object.values(chatMomentum(data))).toEqual([null, null, null, null, null]);
  });
});

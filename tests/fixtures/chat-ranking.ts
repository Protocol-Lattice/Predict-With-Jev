import type { Candle, Market, MarketChatResult } from '../../shared/types';
import { demoMarket } from '../../server/market';
import { HOUR } from '../../server/analysis';

export const SCAN_TIME = Date.UTC(2026, 8, 22, 10, 15);

export function rankingScan(id = 'ranking-1', winner: string | null = 'BTC'): MarketChatResult {
  return {
    id, prompt: 'Which coin will pump?', reply: 'Original ranking text.', horizon: 4, assetScope: 'all', objective: 'upside',
    winner, comparisonLeader: 'BTC', noCandidateWeight: winner ? 0.1 : 0.9,
    candidates: ['BTC', 'ETH'].map((symbol, index) => ({
      symbol, name: symbol === 'BTC' ? 'Bitcoin' : 'Ethereum', price: 999, changeToday: 1, volume24h: 2_000_000,
      selectionWeight: index === 0 ? 0.7 : 0.3, rsi: 55, trend: 'bullish', hourlyVolatility: 0.02,
      referenceTime: Math.floor(SCAN_TIME / HOUR) * HOUR,
      momentum: { return1hPercent: 1, return4hPercent: 2, return24hPercent: 3, relativeVolume4h: 2, priceVsPrior24hHighPercent: 0.1 },
      risks: ['Observed data only'],
    })),
    createdAt: SCAN_TIME, dataAsOf: SCAN_TIME - 60_000, catalogCount: 2, scannedCount: 2, batches: 1,
    comparisonBatches: 0, modelCalls: 3, finalistCount: 2, shortlistCount: 2, evaluatedCount: 2,
    unavailableSymbols: [], historyUnavailable: [], model: 'typesafe/jev-1.13', cost: 0.001, latencyMs: 100,
  };
}

export function observedMarket(symbol: string, points: [number, number][]): Market {
  const candles: Candle[] = points.map(([time, close]) => ({ time, close, open: close, high: close, low: close, vwap: close, volume: 100 }));
  return { ...demoMarket('BTC', SCAN_TIME), symbol, candles, price: 50_000, source: 'kraken', stale: false, fetchedAt: points.at(-1)?.[0] ?? SCAN_TIME };
}

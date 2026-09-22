import { describe, expect, it } from 'vitest';
import { isStablecoin, matchesStablecoinScope } from '../shared/stablecoins';

describe('stablecoin classification', () => {
  it('recognizes dollar and non-dollar stablecoins, including legacy depegged assets', () => {
    for (const symbol of ['USDT', 'USDC', 'DAI', 'USDG', 'USDE', 'USD1', 'USDSM', 'RLUSD', 'PYUSD', 'EURC', 'EURQ', 'QCAD', 'BRL1', 'TGBP', 'AUDX', 'MXNB', 'UST', 'USTC']) {
      expect(isStablecoin(symbol), symbol).toBe(true);
    }
  });
  it('handles casing, whitespace, and bridged USDC symbols', () => {
    for (const symbol of ['usdc', ' USDT ', 'USDe', 'USDC.e']) expect(isStablecoin(symbol), symbol).toBe(true);
  });
  it('keeps ordinary assets, governance tokens, and unrelated ticker names eligible', () => {
    for (const symbol of ['BTC', 'ETH', 'HBAR', 'SOL', 'XRP', 'MKR', 'SKY', 'ENA', 'PAXG', 'STABLE', 'USDCAT', 'NEW']) {
      expect(isStablecoin(symbol), symbol).toBe(false);
    }
  });
  it.each([
    { scope: 'only' as const, expected: ['USDSM', 'USDC'] },
    { scope: 'exclude' as const, expected: ['BTC', 'PAXG', 'STABLE'] },
    { scope: 'all' as const, expected: ['USDSM', 'USDC', 'BTC', 'PAXG', 'STABLE'] },
  ])('filters the requested $scope universe consistently', ({ scope, expected }) => {
    expect(['USDSM', 'USDC', 'BTC', 'PAXG', 'STABLE'].filter(symbol => matchesStablecoinScope(symbol, scope))).toEqual(expected);
  });
});

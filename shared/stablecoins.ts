// Kraken's fiat-pegged stablecoins, reviewed 2026-09-22:
// https://support.kraken.com/articles/stablecoins-supported-on-kraken
// https://www.kraken.com/categories/stablecoins
// https://www.stablemint.io/blog/usdsm-lists-on-kraken/
// Include legacy TerraUSD symbols even after a depeg. Classification must not
// depend on a token's current price or recent volatility.
const STABLECOIN_SYMBOLS = new Set([
  'APXUSD', 'AUDX', 'AUSD', 'BRL1', 'CASH', 'DAI', 'EURC', 'EUROP', 'EURQ',
  'EURR', 'EURT', 'FIDD', 'FRNT', 'MXNB', 'PYUSD', 'QCAD', 'RLUSD', 'SOFID',
  'TGBP', 'TUSD', 'USAT', 'USD1', 'USDC', 'USDD', 'USDE', 'USDG', 'USDGO',
  'USDPT', 'USDQ', 'USDR', 'USDS', 'USDSM', 'USDT', 'UST', 'USTABLES', 'USTC',
]);

export const STABLECOIN_SCOPES = ['all', 'only', 'exclude'] as const;
export type StablecoinScope = typeof STABLECOIN_SCOPES[number];

export const STABLECOIN_SCOPE_LABELS: Record<StablecoinScope, string> = {
  all: 'All assets, including stablecoins',
  only: 'Stablecoins only',
  exclude: 'Stablecoins excluded',
};

export function isStablecoin(symbol: string): boolean {
  // Kraken also supports bridged USDC.e; normalize that explicit suffix.
  return STABLECOIN_SYMBOLS.has(symbol.trim().toUpperCase().replace(/\.E$/, ''));
}

export function matchesStablecoinScope(symbol: string, scope: StablecoinScope): boolean {
  return scope === 'all' || isStablecoin(symbol) === (scope === 'only');
}

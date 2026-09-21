import { assetDetails, type Asset, type MarketQuote, type Symbol } from '../shared/types.js';

const FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'AED', 'ARS', 'BRL', 'MXN', 'TRY', 'PLN', 'KRW', 'CNY', 'CNH', 'NZD', 'SGD', 'HKD', 'ZAR', 'RUB', 'INR']);
const normalize = (symbol: string) => symbol === 'XBT' ? 'BTC' : symbol === 'XDG' ? 'DOGE' : symbol;

export function krakenResult(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid Kraken response.');
  const data = payload as { error?: unknown; result?: unknown };
  if (!Array.isArray(data.error) || data.error.length || !data.result || typeof data.result !== 'object' || Array.isArray(data.result)) throw new Error('Kraken could not return market data.');
  return data.result as Record<string, unknown>;
}

/** The standard spot catalog excludes the separate tokenized-asset product. */
export function parseCatalog(payload: unknown): Asset[] {
  const assets = new Map<Symbol, Asset>();
  for (const [tickerKey, entry] of Object.entries(krakenResult(payload))) {
    if (!entry || typeof entry !== 'object') continue;
    const pair = entry as Record<string, unknown>;
    if (pair.status !== 'online' || typeof pair.wsname !== 'string' || typeof pair.altname !== 'string') continue;
    if (pair.aclass_base !== 'currency' || pair.aclass_quote !== 'currency') continue;
    const [base, quote] = pair.wsname.split('/');
    if (quote !== 'USD' || !base || FIAT.has(base) || tickerKey.endsWith('.d') || pair.asset_class === 'tokenized_asset') continue;
    const symbol = normalize(base);
    assets.set(symbol, { ...assetDetails(symbol), pair: pair.altname, tickerKey });
  }
  if (!assets.size) throw new Error('Kraken returned no active cryptocurrency/USD markets.');
  return [...assets.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function parseQuotes(payload: unknown, assets: Asset[], now = Date.now()): { quotes: MarketQuote[]; missing: Symbol[] } {
  const tickers = krakenResult(payload);
  const missing: Symbol[] = [];
  const quotes: MarketQuote[] = [];
  for (const asset of assets) {
    const raw = tickers[asset.tickerKey] ?? tickers[asset.pair];
    if (!raw || typeof raw !== 'object') { missing.push(asset.symbol); continue; }
    const ticker = raw as Record<string, unknown>;
    const value = (key: string, index: number) => Array.isArray(ticker[key]) ? Number(ticker[key][index]) : NaN;
    const price = value('c', 0), open = Number(ticker.o), volume = value('v', 1), vwap = value('p', 1), high = value('h', 1), low = value('l', 1);
    if (![price, open, volume, vwap, high, low].every(Number.isFinite) || Math.min(price, open, high, low) <= 0 || volume < 0 || vwap < 0 || high < low) { missing.push(asset.symbol); continue; }
    quotes.push({ symbol: asset.symbol, name: asset.name, price, changeToday: (price / open - 1) * 100, volume24h: volume * vwap, high24h: high, low24h: low, fetchedAt: now, source: 'kraken', stale: false });
  }
  return { quotes: quotes.sort((a, b) => b.volume24h - a.volume24h), missing };
}

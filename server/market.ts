import { FEATURED_ASSETS, type Asset, type Candle, type Market, type MarketsResponse, type Symbol } from '../shared/types.js';
import { HOUR, MIN_HISTORY, indicators } from './analysis.js';
import { parseCatalog, parseQuotes } from './catalog.js';

export class MarketError extends Error {}

export function parseKraken(symbol: Symbol, payload: unknown, now = Date.now()): Market {
  if (!payload || typeof payload !== 'object') throw new MarketError('Invalid market-data response.');
  const data = payload as { error?: unknown; result?: Record<string, unknown> };
  if (!Array.isArray(data.error) || data.error.length || !data.result) throw new MarketError('Kraken could not return this market.');
  const rows = Object.entries(data.result).find(([key, value]) => key !== 'last' && Array.isArray(value))?.[1];
  if (!Array.isArray(rows) || rows.length < MIN_HISTORY + 1) throw new MarketError('Insufficient market history.');
  const parsed = rows.map((row): Candle => {
    if (!Array.isArray(row) || row.length < 8) throw new MarketError('Malformed candle.');
    const [time, open, high, low, close, vwap, volume] = row.slice(0, 7).map(Number);
    if (![time, open, high, low, close, vwap, volume].every(Number.isFinite)
      || Math.min(open, high, low, close, vwap) <= 0 || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close)) throw new MarketError('Invalid candle values.');
    return { time: time * 1000 + HOUR, open, high, low, close, volume, vwap };
  });
  // Kraken explicitly includes an unfinished final candle. Never use it as a feature or outcome.
  const candles = parsed.slice(0, -1).filter(candle => candle.time <= now);
  if (candles.length < MIN_HISTORY) throw new MarketError('Insufficient completed market history.');
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].time - candles[index - 1].time !== HOUR) throw new MarketError('Market history has missing or unordered hourly candles.');
  }
  const market = buildMarket(symbol, candles, parsed.at(-1)!.close, now, 'kraken');
  market.stale = now - candles.at(-1)!.time > 2 * HOUR;
  return market;
}

function buildMarket(symbol: Symbol, candles: Candle[], price: number, fetchedAt: number, source: Market['source']): Market {
  const day = candles.slice(-24);
  return {
    symbol, candles, price, fetchedAt, source, stale: false,
    change24h: (price / candles.at(-25)!.close - 1) * 100,
    volume24h: day.reduce((sum, candle) => sum + candle.volume * candle.vwap, 0),
    high24h: Math.max(...day.map(candle => candle.high), price),
    low24h: Math.min(...day.map(candle => candle.low), price),
    indicators: indicators(candles),
  };
}

export function demoMarket(symbol: Symbol, now = Date.now()): Market {
  const index = FEATURED_ASSETS.findIndex(asset => asset.symbol === symbol);
  if (index < 0) throw new MarketError('This asset is not included in the offline demo. Connect live data for the full catalog.');
  const bases = [86500, 3240, 148, 1.92, 0.145, 18.4];
  let seed = 71831 + index * 139;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let price = bases[index] * 0.96;
  const end = Math.floor(now / HOUR) * HOUR;
  const candles: Candle[] = Array.from({ length: 720 }, (_, position) => {
    const open = price;
    const drift = Math.sin(position / 40 + index) * 0.0008 + 0.00008;
    price *= Math.exp((random() - 0.5) * (0.007 + index * 0.001) + drift);
    return { time: end - (719 - position) * HOUR, open, close: price, high: Math.max(open, price) * (1 + random() * 0.002), low: Math.min(open, price) * (1 - random() * 0.002), volume: (500_000 + random() * 8_000_000) / price, vwap: (open + price) / 2 };
  });
  return buildMarket(symbol, candles, price, now, 'demo');
}

export class MarketService {
  private cache = new Map<Symbol, Market>();
  private pending = new Map<Symbol, Promise<Market>>();
  private assets: { value: Asset[]; time: number } | null = null;
  private catalogJob: Promise<Asset[]> | null = null;
  private overview: MarketsResponse | null = null;
  private overviewJob: Promise<MarketsResponse> | null = null;
  constructor(private demo = false, private request: typeof fetch = fetch) {}

  private async publicRequest(route: string): Promise<unknown> {
    try {
      const response = await this.request(`https://api.kraken.com/0/public/${route}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Provider unavailable.');
      return await response.json();
    } catch { throw new MarketError('Cannot reach Kraken. Check your connection and retry.'); }
  }

  async catalog(): Promise<Asset[]> {
    if (this.demo) return FEATURED_ASSETS.map(asset => ({ ...asset, tickerKey: asset.pair }));
    if (this.assets && Date.now() - this.assets.time < 6 * HOUR) return this.assets.value;
    if (!this.catalogJob) this.catalogJob = (async () => {
      let value: Asset[];
      try { value = parseCatalog(await this.publicRequest('AssetPairs')); }
      catch { throw new MarketError('Cannot load Kraken’s asset catalog. Please retry.'); }
      this.assets = { value, time: Date.now() };
      return value;
    })().finally(() => { this.catalogJob = null; });
    return this.catalogJob;
  }

  async get(symbol: Symbol): Promise<Market> {
    if (this.demo) return demoMarket(symbol);
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 60_000) return { ...cached };
    const running = this.pending.get(symbol);
    if (running) return running;
    const job = this.load(symbol).catch(error => {
      if (cached) return { ...cached, stale: true };
      throw error;
    }).finally(() => this.pending.delete(symbol));
    this.pending.set(symbol, job);
    return job;
  }

  private async load(symbol: Symbol): Promise<Market> {
    const asset = (await this.catalog()).find(asset => asset.symbol === symbol);
    if (!asset) throw new MarketError('This cryptocurrency does not have an active Kraken USD market.');
    let response: Response;
    try {
      response = await this.request(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(asset.pair)}&interval=60`, { signal: AbortSignal.timeout(12_000) });
    } catch { throw new MarketError('Cannot reach Kraken. Check your connection and retry.'); }
    if (!response.ok) throw new MarketError(`Kraken is unavailable (HTTP ${response.status}).`);
    const market = parseKraken(symbol, await response.json());
    // Bound memory when browsing hundreds of markets.
    if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(symbol, market);
    return market;
  }

  async all(): Promise<MarketsResponse> {
    if (this.overview && Date.now() - this.overview.fetchedAt < 60_000) return this.overview;
    if (this.overviewJob) return this.overviewJob;
    this.overviewJob = (async () => {
      const assets = await this.catalog();
      if (this.demo) {
        const markets = assets.map(asset => {
          const market = demoMarket(asset.symbol);
          return { symbol: asset.symbol, name: asset.name, price: market.price, changeToday: market.change24h, volume24h: market.volume24h, high24h: market.high24h, low24h: market.low24h, fetchedAt: market.fetchedAt, source: market.source, stale: false };
        });
        return { assets, markets, errors: [], fetchedAt: Date.now() };
      }
      const { quotes, missing } = parseQuotes(await this.publicRequest('Ticker'), assets);
      if (!quotes.length) throw new MarketError('Kraken returned no valid market quotes.');
      const result = { assets, markets: quotes, errors: missing.map(symbol => ({ symbol, message: 'Ticker unavailable.' })), fetchedAt: Date.now() };
      this.overview = result;
      return result;
    })().catch(error => {
      if (this.overview) return { ...this.overview, markets: this.overview.markets.map(market => ({ ...market, stale: true })) };
      throw error instanceof MarketError ? error : new MarketError('Cannot load Kraken market quotes.');
    }).finally(() => { this.overviewJob = null; });
    return this.overviewJob;
  }

  async forSymbols(symbols: Symbol[]): Promise<Market[]> {
    const result: Market[] = [];
    const unique = [...new Set(symbols)];
    for (let index = 0; index < unique.length; index += 2) {
      const batch = await Promise.allSettled(unique.slice(index, index + 2).map(symbol => this.get(symbol)));
      for (const item of batch) if (item.status === 'fulfilled') result.push(item.value);
    }
    return result;
  }
}

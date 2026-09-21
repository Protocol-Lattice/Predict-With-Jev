export const HORIZONS = [4, 24, 168] as const;
export type Horizon = (typeof HORIZONS)[number];
export type Direction = 'bullish' | 'neutral' | 'bearish';
export type Probabilities = Record<Direction, number>;

export const FEATURED_ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin', pair: 'XBTUSD', color: '#f7931a', glyph: '₿' },
  { symbol: 'ETH', name: 'Ethereum', pair: 'ETHUSD', color: '#8295ed', glyph: 'Ξ' },
  { symbol: 'SOL', name: 'Solana', pair: 'SOLUSD', color: '#a68cff', glyph: '≋' },
  { symbol: 'XRP', name: 'XRP', pair: 'XRPUSD', color: '#d1d7df', glyph: '×' },
  { symbol: 'DOGE', name: 'Dogecoin', pair: 'DOGEUSD', color: '#c6a756', glyph: 'Ð' },
  { symbol: 'LINK', name: 'Chainlink', pair: 'LINKUSD', color: '#668cfb', glyph: '⬡' },
] as const;
export type Symbol = string;
export interface Asset { symbol: string; name: string; pair: string; tickerKey: string; color: string; glyph: string }
const NAMES: Record<string, string> = { ADA: 'Cardano', DOT: 'Polkadot', AVAX: 'Avalanche', LTC: 'Litecoin', BCH: 'Bitcoin Cash', ATOM: 'Cosmos', XLM: 'Stellar', UNI: 'Uniswap', AAVE: 'Aave', SUI: 'Sui', NEAR: 'NEAR Protocol', PEPE: 'Pepe', SHIB: 'Shiba Inu', TRX: 'TRON', TON: 'Toncoin', HBAR: 'Hedera', ICP: 'Internet Computer', FIL: 'Filecoin', ALGO: 'Algorand', ARB: 'Arbitrum', OP: 'Optimism', POL: 'Polygon', USDT: 'Tether', USDC: 'USD Coin', DAI: 'Dai', ETC: 'Ethereum Classic', XMR: 'Monero', ZEC: 'Zcash', INJ: 'Injective', FET: 'Artificial Superintelligence Alliance', RENDER: 'Render', TAO: 'Bittensor', WIF: 'dogwifhat', BONK: 'Bonk', EURC: 'Euro Coin', PAXG: 'Pax Gold', DASH: 'Dash', EOS: 'EOS', STX: 'Stacks', IMX: 'Immutable', JUP: 'Jupiter', ONDO: 'Ondo', LDO: 'Lido DAO', CRV: 'Curve DAO', GRT: 'The Graph' };
export function assetDetails(symbol: Symbol) {
  const known = FEATURED_ASSETS.find(asset => asset.symbol === symbol);
  if (known) return { ...known, tickerKey: known.pair };
  const hue = [...symbol].reduce((sum, char) => sum + char.charCodeAt(0) * 7, 0) % 360;
  return { symbol, name: NAMES[symbol] ?? symbol, pair: `${symbol}USD`, tickerKey: `${symbol}USD`, color: `hsl(${hue} 55% 65%)`, glyph: symbol.slice(0, 2) };
}
export interface MarketQuote {
  symbol: Symbol;
  name: string;
  price: number;
  /** Ticker open is midnight UTC, not the trailing 24-hour open. */
  changeToday: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  fetchedAt: number;
  source: 'kraken' | 'demo';
  stale: boolean;
}
export interface Candle {
  /** Candle close time, milliseconds since Unix epoch. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}
export interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  momentum24h: number;
  momentum7d: number;
  hourlyVolatility: number;
  volumeRatio: number;
  trendStrength: number;
  support: number;
  resistance: number;
}
export interface Market {
  symbol: Symbol;
  candles: Candle[];
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  indicators: Indicators;
  fetchedAt: number;
  source: 'kraken' | 'demo';
  stale: boolean;
}
export interface MarketsResponse {
  assets: Asset[];
  markets: MarketQuote[];
  errors: { symbol: Symbol; message: string }[];
  fetchedAt: number;
}
export interface Forecast {
  id: string;
  symbol: Symbol;
  horizon: Horizon;
  direction: Direction;
  probabilities: Probabilities | null;
  referencePrice: number;
  referenceTime: number;
  targetTime: number;
  createdAt: number;
  /** Volatility-only scenario envelope, independent of JEV's directional decision. */
  range: { low: number; high: number };
  neutralThreshold: number;
  indicators: Indicators;
  engine: 'jev' | 'baseline';
  dataSource: 'kraken' | 'demo';
  model: string;
  latencyMs: number;
  cost: number | null;
  outcome: null | {
    price: number;
    change: number;
    direction: Direction;
    correct: boolean;
    evaluatedAt: number;
    brier: number | null;
  };
}
export interface ReplayPoint {
  time: number;
  direction: Direction;
  actual: Direction;
  correct: boolean;
  change: number;
  referencePrice: number;
}
export interface Replay {
  symbol: Symbol;
  horizon: Horizon;
  points: ReplayPoint[];
  accuracy: number | null;
  neutralAccuracy: number | null;
  majorityAccuracy: number | null;
  sampleCount: number;
  from: number | null;
  to: number | null;
  source: 'kraken' | 'demo';
}
export interface Health {
  model: string;
  configured: boolean;
  demo: boolean;
}

export interface ChatCandidate {
  symbol: Symbol;
  name: string;
  price: number;
  changeToday: number;
  volume24h: number;
  selectionWeight: number;
  rsi: number;
  trend: 'bullish' | 'bearish';
  hourlyVolatility: number;
  referenceTime: number;
  risks: string[];
}
export interface MarketChatResult {
  id: string;
  prompt: string;
  reply: string;
  horizon: Horizon;
  winner: Symbol | null;
  candidates: ChatCandidate[];
  noCandidateWeight: number;
  createdAt: number;
  dataAsOf: number;
  catalogCount: number;
  scannedCount: number;
  batches: number;
  shortlistCount: number;
  evaluatedCount: number;
  unavailableSymbols: Symbol[];
  historyUnavailable: Symbol[];
  model: string;
  cost: number | null;
  latencyMs: number;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  result?: MarketChatResult;
}

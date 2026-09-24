import type { Direction, Horizon } from './types.js';

export interface PaperConfig {
  symbol: string;
  horizon: Horizon;
  signal: 'jev' | 'baseline';
  orderUsd: number;
  maxPositionUsd: number;
  feeBps: number;
  slippageBps: number;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  symbol: 'ETH', horizon: 24, signal: 'jev', orderUsd: 100,
  maxPositionUsd: 500, feeBps: 25, slippageBps: 10,
};
export const PAPER_INITIAL_CASH = 10_000;

export interface PaperDecision {
  id: string;
  time: number;
  candleTime: number | null;
  config: PaperConfig;
  action: 'BUY' | 'HOLD' | 'SELL';
  direction: Direction | null;
  forecastId: string | null;
  reason: string;
  quote: number | null;
  fillPrice: number | null;
  quantity: number;
  feeUsd: number;
  cashAfter: number;
  positionAfter: number;
}

export interface PaperAccount {
  version: 1;
  mode: 'paper';
  source: 'kraken' | 'demo';
  initialCashUsd: number;
  config: PaperConfig;
  cashUsd: number;
  quantity: number;
  feesUsd: number;
  markPrice: number | null;
  markedAt: number | null;
  lastCheckedAt: number | null;
  decisions: PaperDecision[];
}

export interface PaperStatus extends PaperAccount {
  running: boolean;
  error: string | null;
  intervalMs: number;
}

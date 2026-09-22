import type { Horizon, MarketChatResult } from './types.js';

export type RankingReference = { status: 'pending' }
  | { status: 'captured'; price: number; capturedAt: number }
  | { status: 'unavailable'; reason: string; checkedAt: number };

export type RankingOutcome = { horizon: Horizon; targetTime: number } & (
  { status: 'pending' }
  | { status: 'evaluated'; price: number; returnPercent: number; evaluatedAt: number }
  | { status: 'unavailable'; reason: string; checkedAt: number }
);

export interface RankingCandidateTracking {
  symbol: string;
  reference: RankingReference;
  outcomes: RankingOutcome[];
}

export interface ChatRankingRecord {
  version: 1;
  /** Immutable original ranking, including candidates in their original order. */
  scan: MarketChatResult;
  history: string[];
  savedAt: number;
  /** First hourly close strictly after the ranking was saved. */
  referenceTime: number;
  tracking: RankingCandidateTracking[];
}

export interface ChatRankingSummary {
  total: number;
  selected: number;
  noSelection: number;
  horizons: {
    horizon: Horizon;
    evaluated: number;
    pending: number;
    unavailable: number;
    averageReturnPercent: number | null;
    positivePercent: number | null;
  }[];
}

export interface RankingEvaluatorStatus {
  enabled: boolean;
  running: boolean;
  lastCheckedAt: number | null;
  error: string | null;
}

export interface ChatRankingsResponse {
  records: ChatRankingRecord[];
  total: number;
  summary: ChatRankingSummary;
  evaluator: RankingEvaluatorStatus;
}

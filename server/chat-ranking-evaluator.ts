import type { RankingEvaluatorStatus } from '../shared/chat-journal.js';
import { ChatRankingStore, dueRankingSymbols } from './chat-journal.js';
import type { MarketService } from './market.js';

export const RANKING_CHECK_INTERVAL = 60_000;

export class ChatRankingEvaluator {
  private pending: Promise<void> | null = null;
  private lastAttempt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: RankingEvaluatorStatus = { enabled: false, running: false, lastCheckedAt: null, error: null };
  constructor(private store: Pick<ChatRankingStore, 'list' | 'resolve'>, private markets: Pick<MarketService, 'forSymbols'>, private clock: () => number = Date.now) {}

  status(): RankingEvaluatorStatus { return { ...this.state }; }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.lastAttempt !== null && this.clock() - this.lastAttempt < RANKING_CHECK_INTERVAL) return Promise.resolve();
    this.lastAttempt = this.clock();
    this.state.running = true;
    this.pending = (async () => {
      const records = await this.store.list();
      const symbols = dueRankingSymbols(records, this.clock());
      const markets = symbols.length ? await this.markets.forSymbols(symbols) : [];
      if (symbols.length) await this.store.resolve(markets, this.clock());
      const available = new Set(markets.filter(market => market.source === 'kraken' && !market.stale).map(market => market.symbol));
      const missing = symbols.filter(symbol => !available.has(symbol));
      this.state.error = missing.length ? `Waiting for live hourly data for ${missing.length} market${missing.length === 1 ? '' : 's'}. Checks will retry automatically.` : null;
      this.state.lastCheckedAt = this.clock();
    })().catch(error => {
      this.state.error = error instanceof Error ? error.message : 'Ranking outcome checks failed. They will retry automatically.';
      throw error;
    }).finally(() => { this.pending = null; this.state.running = false; });
    return this.pending;
  }

  start(): () => void {
    if (!this.timer) {
      this.state.enabled = true;
      void this.refresh().catch(() => {});
      this.timer = setInterval(() => void this.refresh().catch(() => {}), RANKING_CHECK_INTERVAL);
      this.timer.unref?.();
    }
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.state.enabled = false;
    };
  }
}

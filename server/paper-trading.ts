import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_PAPER_CONFIG, PAPER_INITIAL_CASH, type PaperAccount, type PaperConfig, type PaperDecision, type PaperStatus } from '../shared/paper-trading.js';
import type { Direction, Forecast, Market } from '../shared/types.js';
import { baselineDirection, HOUR } from './analysis.js';

const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const timestamp = z.number().int().positive();
export const paperConfigSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/),
  horizon: z.union([z.literal(4), z.literal(24), z.literal(168)]),
  signal: z.enum(['jev', 'baseline']),
  orderUsd: positive.min(1).max(PAPER_INITIAL_CASH),
  maxPositionUsd: positive.min(1).max(PAPER_INITIAL_CASH),
  feeBps: nonnegative.max(100),
  slippageBps: nonnegative.max(100),
}).strict().refine(value => value.orderUsd <= value.maxPositionUsd, 'Order size must not exceed the position limit.');

const decisionSchema = z.object({
  id: z.string().uuid(), time: timestamp, candleTime: timestamp.nullable(), config: paperConfigSchema,
  action: z.enum(['BUY', 'HOLD', 'SELL']), direction: z.enum(['bullish', 'neutral', 'bearish']).nullable(),
  forecastId: z.string().nullable(), reason: z.string().min(1), quote: positive.nullable(), fillPrice: positive.nullable(),
  quantity: nonnegative, feeUsd: nonnegative, cashAfter: nonnegative, positionAfter: nonnegative,
}).strict();
const accountSchema = z.object({
  version: z.literal(1), mode: z.literal('paper'), source: z.enum(['kraken', 'demo']),
  initialCashUsd: z.literal(PAPER_INITIAL_CASH), config: paperConfigSchema,
  cashUsd: nonnegative, quantity: nonnegative, feesUsd: nonnegative,
  markPrice: positive.nullable(), markedAt: timestamp.nullable(), lastCheckedAt: timestamp.nullable(),
  decisions: z.array(decisionSchema),
}).strict();

export class PaperTradingError extends Error {
  constructor(message: string, public status = 409) { super(message); this.name = 'PaperTradingError'; }
}

function freshAccount(demo: boolean): PaperAccount {
  return { version: 1, mode: 'paper', source: demo ? 'demo' : 'kraken', initialCashUsd: PAPER_INITIAL_CASH,
    config: { ...DEFAULT_PAPER_CONFIG, signal: demo ? 'baseline' : 'jev' }, cashUsd: PAPER_INITIAL_CASH,
    quantity: 0, feesUsd: 0, markPrice: null, markedAt: null, lastCheckedAt: null, decisions: [] };
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
function validateAccount(value: unknown, demo: boolean): PaperAccount {
  const parsed = accountSchema.safeParse(value);
  const invalid = () => new PaperTradingError('The paper journal is invalid. Restore a valid backup; existing data has not been replaced.', 500);
  if (!parsed.success || parsed.data.source !== (demo ? 'demo' : 'kraken')) throw invalid();
  const account = parsed.data;
  let cash = PAPER_INITIAL_CASH, quantity = 0, fees = 0, symbol = account.decisions[0]?.config.symbol, time = 0;
  const ids = new Set<string>();
  const traded = new Map<string, number>();
  for (const decision of account.decisions) {
    if (ids.has(decision.id) || decision.time < time) throw invalid();
    ids.add(decision.id); time = decision.time;
    if (quantity > 0 && decision.config.symbol !== symbol) throw invalid();
    symbol = decision.config.symbol;
    if (decision.action === 'HOLD') {
      if (decision.quantity !== 0 || decision.feeUsd !== 0 || decision.fillPrice !== null) throw invalid();
    } else {
      if (!decision.fillPrice || !decision.quote || !decision.candleTime || decision.candleTime > decision.time || decision.quantity <= 0
        || decision.candleTime <= (traded.get(symbol) ?? 0)) throw invalid();
      traded.set(symbol, decision.candleTime);
      const buy = decision.action === 'BUY';
      const notional = decision.quantity * decision.fillPrice;
      if (!close(decision.fillPrice, decision.quote * (1 + (buy ? 1 : -1) * decision.config.slippageBps / 10_000))
        || !close(decision.feeUsd, notional * decision.config.feeBps / 10_000)) throw invalid();
      cash += (buy ? -notional : notional) - decision.feeUsd;
      quantity += (buy ? 1 : -1) * decision.quantity;
      fees += decision.feeUsd;
      if (cash < -1e-7 || quantity < -1e-12) throw invalid();
    }
    if (!close(decision.cashAfter, cash) || !close(decision.positionAfter, quantity)) throw invalid();
  }
  if (!close(account.cashUsd, cash) || !close(account.quantity, quantity) || !close(account.feesUsd, fees)
    || (quantity > 0 && account.config.symbol !== symbol)) throw invalid();
  return account;
}

/** Pure paper accounting. No wallet, private key, exchange account, or transaction API. */
export function paperStep(account: PaperAccount, market: Market, forecasts: Forecast[], now = Date.now()): PaperAccount {
  const next = structuredClone(account);
  const config = next.config;
  const candleTime = market.candles.at(-1)?.time ?? null;
  let direction: Direction | null = null;
  let forecastId: string | null = null;
  let reason = '';
  let quote: number | null = null;
  if (market.symbol !== config.symbol || market.source !== account.source || market.stale || !candleTime
    || candleTime > now || now - candleTime > 2 * HOUR || market.fetchedAt > now || now - market.fetchedAt > 120_000
    || !Number.isFinite(market.price) || market.price <= 0 || !Object.values(market.indicators).every(Number.isFinite)) {
    reason = 'Market data is missing, stale, invalid, or from a different environment.';
  } else {
    quote = market.price;
    next.markPrice = quote; next.markedAt = market.fetchedAt;
    if (config.signal === 'baseline') direction = baselineDirection(market.indicators, config.horizon);
    else {
      const forecast = forecasts.filter(item => item.symbol === config.symbol && item.horizon === config.horizon && item.engine === 'jev'
        && item.dataSource === account.source && item.createdAt <= now && item.referenceTime <= now && now - item.referenceTime <= 2 * HOUR
        && item.targetTime > now && item.outcome === null).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (forecast) { direction = forecast.direction; forecastId = forecast.id; }
      else reason = 'No fresh saved JEV forecast. Run a forecast for this asset and horizon, or choose the technical baseline.';
    }
  }
  const decision: PaperDecision = { id: randomUUID(), time: now, candleTime, config: { ...config }, action: 'HOLD',
    direction, forecastId, reason, quote, fillPrice: null, quantity: 0, feeUsd: 0, cashAfter: next.cashUsd, positionAfter: next.quantity };
  const alreadyTraded = next.decisions.some(item => item.config.symbol === config.symbol && item.action !== 'HOLD' && item.candleTime! >= (candleTime ?? 0));
  if (direction && quote !== null) {
    if (alreadyTraded) decision.reason = 'This completed candle has already produced a paper trade.';
    else if (direction === 'neutral') decision.reason = 'Neutral signal; keep the current paper position.';
    else if (direction === 'bearish' && next.quantity === 0) decision.reason = 'Bearish signal, but there is no paper position to sell. Shorting is disabled.';
    else {
      const buy = direction === 'bullish';
      const fill = quote * (1 + (buy ? 1 : -1) * config.slippageBps / 10_000);
      const feeRate = config.feeBps / 10_000;
      const notional = buy
        ? Math.min(config.orderUsd, next.cashUsd / (1 + feeRate), Math.max(0, config.maxPositionUsd - next.quantity * quote))
        : next.quantity * fill;
      if (notional < 0.01) decision.reason = 'Paper cash or position limit reached.';
      else {
        decision.action = buy ? 'BUY' : 'SELL';
        decision.reason = buy ? 'Bullish signal within the paper cash and position limits.' : 'Bearish signal; close the paper position.';
        decision.fillPrice = fill;
        decision.quantity = buy ? notional / fill : next.quantity;
        decision.feeUsd = notional * feeRate;
        next.cashUsd = Math.max(0, next.cashUsd + (buy ? -notional : notional) - decision.feeUsd);
        next.quantity = buy ? next.quantity + decision.quantity : 0;
        next.feesUsd += decision.feeUsd;
        decision.cashAfter = next.cashUsd; decision.positionAfter = next.quantity;
      }
    }
  }
  next.lastCheckedAt = now;
  const last = next.decisions.at(-1);
  // Keep hourly HOLD evidence without repeating the same message every minute.
  if (!last || last.action !== decision.action || last.candleTime !== candleTime || last.reason !== decision.reason
    || last.forecastId !== forecastId || JSON.stringify(last.config) !== JSON.stringify(config)) next.decisions.push(decision);
  return next;
}

export class PaperTrader {
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private epoch = 0;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private job: Promise<void> | null = null;
  readonly intervalMs = 60_000;
  constructor(private file: string, private demo: boolean, private markets: { get(symbol: string): Promise<Market> }, private forecasts: { list(): Promise<Forecast[]> }) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async read(): Promise<PaperAccount> {
    try { return validateAccount(JSON.parse(await readFile(this.file, 'utf8')), this.demo); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return freshAccount(this.demo);
      if (error instanceof PaperTradingError) throw error;
      throw new PaperTradingError('The paper journal could not be read. Check the file and restore a valid backup before continuing.', 500);
    }
  }
  private async save(account: PaperAccount) {
    validateAccount(account, this.demo);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify(account), { mode: 0o600 });
      await rename(temporary, this.file);
    } catch { throw new PaperTradingError('The paper journal could not be saved. Simulation stopped; check disk space and permissions.', 500); }
  }
  private status(account: PaperAccount): PaperStatus {
    return { ...account, running: this.running, error: this.error, intervalMs: this.intervalMs };
  }
  snapshot(): Promise<PaperStatus> { return this.serial(async () => this.status(await this.read())); }
  configure(input: unknown): Promise<PaperStatus> {
    const config = paperConfigSchema.safeParse(input);
    if (!config.success) throw new PaperTradingError('Invalid paper settings. Use positive USD limits (order ≤ position ≤ 10,000), a supported horizon, and costs from 0 to 100 bps.', 400);
    return this.serial(async () => {
      if (this.running) throw new PaperTradingError('Pause the simulation before changing its settings.');
      const account = await this.read();
      if (account.quantity > 0 && config.data.symbol !== account.config.symbol) throw new PaperTradingError('Close the current paper position before changing its asset.');
      if (config.data.symbol !== account.config.symbol) { account.markPrice = null; account.markedAt = null; }
      account.config = config.data;
      await this.save(account);
      this.epoch++; this.error = null;
      return this.status(account);
    });
  }
  async start(): Promise<PaperStatus> {
    const status = await this.serial(async () => {
      const account = await this.read();
      if (!this.running) {
        await this.save(account);
        this.running = true; this.epoch++; this.error = null;
        this.timer = setInterval(() => void this.tick(), this.intervalMs);
        this.timer.unref();
      }
      return this.status(account);
    });
    void this.tick();
    return status;
  }
  async stop(): Promise<PaperStatus> {
    this.running = false; this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.serial(async () => {
      // Also stop a start request that was queued before this command.
      this.running = false; this.epoch++;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return this.status(await this.read());
    });
  }
  tick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.job) return this.job;
    const epoch = this.epoch;
    this.job = (async () => {
      try {
        const account = await this.serial(() => this.read());
        if (!this.running || epoch !== this.epoch) return;
        const [market, forecasts] = await Promise.all([this.markets.get(account.config.symbol), account.config.signal === 'jev' ? this.forecasts.list() : Promise.resolve([])]);
        await this.serial(async () => {
          if (!this.running || epoch !== this.epoch) return;
          await this.save(paperStep(account, market, forecasts));
        });
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.running = false; this.epoch++;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.error = error instanceof PaperTradingError ? error.message : 'Simulation stopped: market data or the forecast journal is unavailable. Refresh and start again.';
      }
    })().finally(() => { this.job = null; });
    return this.job;
  }
}

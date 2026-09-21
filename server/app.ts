import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HORIZONS, type Forecast, type Horizon } from '../shared/types.js';
import { baselineDirection, HOUR, neutralThreshold, replay, scenarioRange } from './analysis.js';
import { askJev, JevError, MODEL } from './jev.js';
import { MarketError, MarketService } from './market.js';
import { ForecastStore } from './store.js';
import { MarketChatService } from './chat.js';

const symbolSchema = z.string().min(1).max(30).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const horizonSchema = z.coerce.number().refine(value => HORIZONS.includes(value as Horizon), 'Choose 4, 24, or 168 hours.').transform(value => value as Horizon);
const forecastSchema = z.object({ symbol: symbolSchema, horizon: horizonSchema, engine: z.enum(['jev', 'baseline']) }).strict();

export function createApp(options: { apiKey: string; demo: boolean; dataFile: string; marketService?: MarketService }) {
  const app = express();
  const markets = options.marketService ?? new MarketService(options.demo);
  const store = new ForecastStore(options.dataFile);
  const chat = new MarketChatService(markets, options.apiKey, options.demo);
  const inFlight = new Map<string, Promise<Forecast>>();
  let requests = { start: Date.now(), count: 0 };
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'This research terminal accepts local requests only.' });
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '12kb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ model: MODEL, configured: Boolean(options.apiKey.trim()), demo: options.demo });
  });
  app.post('/api/chat', async (req, res) => {
    const input = z.object({ message: z.string().trim().min(3).max(1200), horizon: horizonSchema, history: z.array(z.string().max(1200)).max(4).default([]) }).strict().parse(req.body);
    res.json(await chat.scan(input.message, input.horizon, input.history));
  });
  app.get('/api/markets', async (_req, res) => {
    const result = await markets.all();
    res.status(result.markets.length ? 200 : 503).json(result.markets.length ? result : { ...result, error: 'Market data is unavailable. Retry, or start with DEMO_MODE=true to explore synthetic data.' });
  });
  app.get('/api/markets/:symbol', async (req, res) => {
    res.json(await markets.get(symbolSchema.parse(req.params.symbol)));
  });
  app.get('/api/replay/:symbol', async (req, res) => {
    const symbol = symbolSchema.parse(req.params.symbol);
    const horizon = horizonSchema.parse(req.query.horizon ?? 24);
    const market = await markets.get(symbol);
    if (market.stale) return res.status(409).json({ error: 'Refresh market data before running a replay.' });
    res.json(replay(market, horizon));
  });
  app.get('/api/forecasts', async (_req, res) => {
    const existing = await store.list();
    if (!existing.some(item => !item.outcome && item.targetTime <= Date.now())) return res.json(existing);
    const due = existing.filter(item => !item.outcome && item.targetTime <= Date.now() && item.targetTime > Date.now() - 720 * HOUR);
    const observations = await markets.forSymbols(due.map(item => item.symbol));
    res.json(await store.resolve(observations));
  });
  app.post('/api/forecasts', async (req, res) => {
    const { symbol, horizon, engine } = forecastSchema.parse(req.body);
    if (engine === 'jev' && options.demo) throw new JevError('Demo mode uses the baseline only. Disable DEMO_MODE to use JEV with real observations.', 409);
    if (engine === 'jev' && !options.apiKey.trim()) throw new JevError('Add OPENROUTER_API_KEY to .env and restart to enable JEV.', 503);
    const market = await markets.get(symbol);
    const reference = market.candles.at(-1)!;
    if (market.stale || Date.now() - reference.time > 2 * HOUR) return res.status(409).json({ error: 'The market feed is stale. A new forecast requires fresh completed candles.' });
    const key = `${symbol}:${horizon}:${engine}:${market.source}:${reference.time}`;
    const existing = (await store.list()).find(item => item.symbol === symbol && item.horizon === horizon && item.engine === engine && item.dataSource === market.source && item.referenceTime === reference.time);
    if (existing) return res.json(existing);
    let job = inFlight.get(key);
    if (!job) {
      if (Date.now() - requests.start > 60_000) requests = { start: Date.now(), count: 0 };
      if (requests.count >= 12) return res.status(429).json({ error: 'Twelve new forecasts per minute are allowed. Please wait a moment.' });
      requests.count++;
      job = (async () => {
        const prediction = engine === 'jev'
          ? await askJev(market, horizon, options.apiKey)
          : { direction: baselineDirection(market.indicators, horizon), probabilities: null, model: 'technical-baseline-v1', latencyMs: 0, cost: null };
        const forecast: Forecast = {
          id: randomUUID(), symbol, horizon, engine, ...prediction,
          referencePrice: reference.close,
          referenceTime: reference.time,
          targetTime: reference.time + horizon * HOUR,
          createdAt: Date.now(),
          range: scenarioRange(reference.close, market.indicators, horizon),
          neutralThreshold: neutralThreshold(market.indicators, horizon),
          indicators: market.indicators,
          dataSource: market.source,
          outcome: null,
        };
        await store.add(forecast);
        return forecast;
      })().finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    res.json(await job);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) return void res.status(400).json({ error: 'Invalid request. Check the asset, horizon, engine, or prompt length (3–1,200 characters).' });
    if (error instanceof JevError) return void res.status(error.status).json({ error: error.message });
    if (error instanceof MarketError) return void res.status(503).json({ error: error.message });
    if (error instanceof SyntaxError) return void res.status(400).json({ error: 'Invalid JSON request.' });
    if (error?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request is too large.' });
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
    res.status(500).json({ error: 'The request could not be completed. Check the server and forecast journal.' });
  };
  app.use(errorHandler);
  return app;
}

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildScreenRequest, MarketChatService, NONE, parseSelection, SCREEN_BATCH_SIZE } from '../server/chat';
import { demoMarket, MarketService } from '../server/market';
import { MAX_SYSTEM_ONE_REQUEST_BYTES } from '../server/jev';
import type { Asset, ChatObjective, MarketChatResult, MarketQuote, MarketsResponse } from '../shared/types';
import type { StablecoinScope } from '../shared/stablecoins';
import { chatMomentum } from '../server/chat-signals';
import MarketChat from '../src/MarketChat';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChoiceDecision } from '../shared/decision-pipeline';
import { ChatRankingStore, createRankingRecord } from '../server/chat-journal';
import { chatRankingJournalSchema } from '../server/chat-journal-schema';
import { benchmarkDecisions, decisionLabelTemplate } from '../server/decision-benchmark';
import { runStageDecision } from '../server/decision-pipeline';
import { HOUR } from '../server/analysis';

function universe(size = 619, symbols: string[] = []): MarketsResponse {
  const markets: MarketQuote[] = Array.from({ length: size }, (_, index) => ({ symbol: symbols[index] ?? `COIN${index}`, name: `Coin ${index}`, price: index + 1, changeToday: 1, volume24h: 2_000_000 + index, high24h: index + 2, low24h: index + 0.5, source: 'kraken', stale: false, fetchedAt: Date.now() }));
  const assets: Asset[] = markets.map(quote => ({ symbol: quote.symbol, name: quote.name, pair: `${quote.symbol}USD`, tickerKey: `${quote.symbol}USD`, color: '#abc', glyph: 'C' }));
  return { markets, assets, fetchedAt: Date.now(), errors: [] };
}
function service(overview: MarketsResponse) {
  return { all: vi.fn(async () => overview), history: vi.fn(async () => { throw new Error('Chat must not request long-term history'); }), forSymbols: vi.fn(async (symbols: string[]) => symbols.map(symbol => ({ ...demoMarket('BTC'), symbol, source: 'kraken' as const }))) } as unknown as MarketService;
}
function model(abstain = false, scope: StablecoinScope = 'all', objective: ChatObjective = 'best_fit', preferred?: string, overrides: Partial<Record<string, ChoiceDecision>> = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([question, definition]) => {
      const options = Object.keys((definition as { criteria: object }).criteria);
      const choice = question === 'regime' ? 'trending_up' : question === 'setup' ? abstain ? 'weak' : 'supported'
        : question === 'risk' ? 'allow' : question === 'objective' ? objective : body.state.stage === 'planning' ? scope
        : abstain && options.includes(NONE) ? NONE : preferred && options.includes(preferred) ? preferred : options[0];
      return [question, { type: 'choice', ...(overrides[question] ?? { choice, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) }) }];
    }));
    return Response.json({ model: 'typesafe/jev-1.13', answers, usage: { cost: 0.0001 } });
  });
}

function renderResult(result: MarketChatResult, data: MarketsResponse) {
  return renderToStaticMarkup(createElement(MarketChat, {
    messages: [{ id: result.id, role: 'assistant', text: result.reply, result }],
    setMessages: () => {}, send: async () => false, busy: false, error: '',
    horizon: result.horizon, setHorizon: () => {}, markets: data.markets, assets: data.assets,
    health: { configured: true, demo: false, model: result.model }, analyze: () => {},
  }));
}

describe('whole-market chat scanner', () => {
  it('carries a resolved pump objective through every ranking round and shows measured evidence for the selected coin', async () => {
    const data = universe(180, ['BTC', 'TAO']);
    data.markets[0].name = 'Bitcoin';
    data.markets[0].volume24h = 1_000_000_000;
    data.markets[1].name = 'Bittensor';
    const markets = service(data);
    // Mock only the provider decision: the application must preserve its
    // objective and winner instead of imposing a liquidity/BTC fallback.
    const request = model(false, 'all', 'upside', 'TAO');
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const result = await chat.scan('Which coin will pump?', 4, ['Find a stable coin']);
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(bodies[0].state).toMatchObject({ stage: 'planning', user_request: 'Which coin will pump?', earlier_user_requests: ['Find a stable coin'] });
    expect(Object.keys(bodies[0].questions.objective.criteria)).toEqual(['best_fit', 'upside']);
    const rankings = bodies.filter(body => body.state.decision_stage === 'candidate_filter');
    expect(new Set(rankings.map(body => body.state.stage))).toEqual(new Set(['analysis', 'comparison', 'final']));
    for (const body of rankings) {
      expect(body.state).toMatchObject({ objective: 'upside', ranking_goal: 'Short-term percentage upside', horizon_hours: 4 });
      expect(body.questions.selection.criteria).not.toHaveProperty(NONE);
      for (const [symbol, description] of Object.entries(body.questions.selection.criteria)) {
        if (symbol !== NONE) expect(description).toContain('positive percentage price movement over the next 4 hours');
      }
      for (const evidence of body.state.technical_evidence) expect(evidence.momentum).toEqual(chatMomentum(demoMarket('BTC')));
      expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(MAX_SYSTEM_ONE_REQUEST_BYTES);
    }
    expect(result).toMatchObject({ winner: 'TAO', objective: 'upside', assetScope: 'all', evaluatedCount: 180 });
    expect(result.candidates[0].momentum).toEqual(chatMomentum(demoMarket('BTC')));
    expect(result.reply).toContain('Bittensor (TAO) first for potential percentage upside over the next 4 hours');
    expect(result.reply).toContain('Observed from completed hourly candles');
    expect(result.reply).toContain('not a guarantee that it will pump');
    expect(result.modelCalls).toBe(bodies.length);
    expect(result.cost).toBeCloseTo(bodies.length * 0.0001);
    expect(chat.status()).toMatchObject({ stage: 'complete', objective: 'upside' });
    expect(markets.history).not.toHaveBeenCalled();
    const html = renderResult(result, data);
    expect(html).toContain('TOP UPSIDE CANDIDATE');
    expect(html).toContain('Observed momentum for TAO');
    expect(html).toContain('4h relative volume');
    expect(html).toContain('Vs prior 24h high');
    expect(html).toContain('not the chance of a pump');
  });
  it.each(['Avoid chasing pumps; find a lower-risk candidate', 'Compare PUMP and BTC'])('uses the resolved general objective rather than keyword matching for "%s"', async prompt => {
    const data = universe(3, ['BTC', 'PUMP', 'ETH']);
    const request = model();
    const result = await new MarketChatService(service(data), 'test-key', false, request).scan(prompt, 24);
    for (const call of request.mock.calls.slice(1)) {
      const body = JSON.parse(call[1]!.body as string);
      if (body.state.stage !== 'market_regime') expect(body.state.objective).toBe('best_fit');
    }
    expect(result.objective).toBe('best_fit');
    expect(result.reply).toContain('best fit for your 24-hour research request');
    expect(renderResult(result, data)).not.toContain('TOP UPSIDE CANDIDATE');
  });
  it('preserves the relative ranking when every upside setup is weak without promoting the leader to a buy', async () => {
    const data = universe(5, ['BTC', 'TAO', 'XRP']);
    const result = await new MarketChatService(service(data), 'test-key', false, model(true, 'all', 'upside', 'TAO')).scan('Which coin will pump?', 4);
    expect(result.winner).toBeNull();
    expect(result.noCandidateWeight).toBe(1);
    expect(result.comparisonLeader).toBe('TAO');
    expect(result.candidates[0].symbol).toBe('TAO');
    expect(result.candidates[0].selectionWeight).toBe(1);
    expect(result.reply).toContain('(TAO) leads JEV’s relative upside comparison');
    expect(result.reply).toContain('no clear upside setup');
    expect(result.reply).toContain('comparison candidate, not a buy signal');
    const html = renderResult(result, data);
    expect(html).toContain('Leading comparison:');
    expect(html).toContain('LEADING COMPARISON');
    expect(html).not.toContain('The model favors waiting');
    expect(html).not.toContain('TOP UPSIDE CANDIDATE');
    expect(html).not.toContain('BEST FIT FOR YOUR PROMPT');
    // Older results without a separately ranked leader must not acquire one
    // merely because an alternative happens to be first in the array.
    expect(renderResult({ ...result, comparisonLeader: null }, data)).not.toContain('LEADING COMPARISON');
  });
  it.each([undefined, { type: 'choice', choice: 'invented', probabilities: { best_fit: 0, upside: 0, invented: 1 } }])('rejects missing or unknown ranking objectives instead of silently changing the request', async objective => {
    const markets = service(universe(3));
    const request = vi.fn(async () => Response.json({ model: 'typesafe/jev-1.13', answers: {
      selection: { type: 'choice', choice: 'all', probabilities: { all: 1, only: 0, exclude: 0 } },
      ...(objective ? { objective } : {}),
    } }));
    const chat = new MarketChatService(markets, 'test-key', false, request);
    await expect(chat.scan('Which coin will pump?', 4)).rejects.toThrow(/invalid|inconsistent/);
    expect(markets.forSymbols).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(chat.status()).toMatchObject({ stage: 'failed', objective: null });
  });
  it.each(['Find a liquid candidate without stable coins', 'Exclude stablecoins and avoid chasing today’s biggest pumps.'])('enforces the resolved exclusion before data loading and every ranking stage for "%s"', async prompt => {
    const stablecoins = ['USDT', 'USDC', 'DAI', 'USDG', 'USDE', 'USD1', 'PYUSD', 'EURC', 'EURQ', 'QCAD', 'BRL1', 'TGBP', 'USDSM'];
    const data = universe(180 + stablecoins.length, stablecoins);
    // Price and freshness must not turn an excluded stablecoin into a candidate
    // or prevent the remaining markets from being researched.
    data.markets[0].price = 0.08;
    data.markets[1].stale = true;
    data.errors.push({ symbol: 'EURT', message: 'Ticker unavailable.' }, { symbol: 'MISSING', message: 'Ticker unavailable.' });
    const expectedSymbols = data.markets.slice(stablecoins.length).map(quote => quote.symbol);
    const markets = service(data);
    const request = model(false, 'exclude');
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const result = await chat.scan(prompt, 24);
    expect(markets.forSymbols).toHaveBeenCalledWith(expectedSymbols, expect.any(Function));
    expect(markets.history).not.toHaveBeenCalled();
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string)).filter(body => body.state.decision_stage === 'candidate_filter');
    expect(new Set(bodies.map(body => body.state.stage))).toEqual(new Set(['analysis', 'comparison', 'final']));
    for (const body of bodies) {
      const symbols = body.state.markets.map((row: unknown[]) => row[0]);
      expect(symbols.every((symbol: string) => expectedSymbols.includes(symbol))).toBe(true);
      expect(body.state.technical_evidence.map((item: { symbol: string }) => item.symbol)).toEqual(symbols);
      expect(Object.keys(body.questions.selection.criteria)).toEqual([...symbols, NONE]);
      expect(body.state.market_scope).toBe('Stablecoins excluded');
    }
    expect(result).toMatchObject({ assetScope: 'exclude', catalogCount: 180, scannedCount: 180, evaluatedCount: 180, unavailableSymbols: ['MISSING'] });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every(candidate => expectedSymbols.includes(candidate.symbol))).toBe(true);
    expect(expectedSymbols).toContain(result.winner);
    expect(result.reply).toContain('excluding stablecoins');
    expect(chat.status()).toMatchObject({ stage: 'complete', total: 180, hourlyChecked: 180, analyzed: 180 });
  });
  it('stops before hourly data loading and ranking when the chosen scope has no markets', async () => {
    const markets = service(universe(3, ['USDT', 'DAI', 'EURC']));
    const request = model(false, 'exclude');
    const chat = new MarketChatService(markets, 'test-key', false, request);
    await expect(chat.scan('Exclude stablecoins', 24)).rejects.toThrow(/No available markets match your request/);
    expect(markets.forSymbols).not.toHaveBeenCalled();
    expect(markets.history).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(chat.status()).toMatchObject({ stage: 'failed', assetScope: 'exclude', total: 0, modelCalls: 1 });
  });
  it('enforces a stablecoin-only scope for the screenshot request, including USDSM but not STABLE or PAXG', async () => {
    const symbols = ['USDSM', 'USDC', 'USDT', 'BTC', 'PAXG', 'STABLE'];
    const data = universe(symbols.length, symbols);
    data.errors.push({ symbol: 'DAI', message: 'Ticker unavailable.' }, { symbol: 'ETH', message: 'Ticker unavailable.' });
    const markets = service(data);
    const request = model(false, 'only');
    const prompt = 'I want to buy stable coins, which to buy?';
    const history = ['Exclude stablecoins and avoid chasing today’s biggest pumps.'];
    const result = await new MarketChatService(markets, 'test-key', false, request).scan(prompt, 4, history);
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(bodies[0].state).toMatchObject({ stage: 'planning', user_request: prompt, earlier_user_requests: history });
    expect(Object.keys(bodies[0].questions.selection.criteria)).toEqual(['all', 'only', 'exclude']);
    expect(markets.forSymbols).toHaveBeenCalledWith(['USDSM', 'USDC', 'USDT'], expect.any(Function));
    expect(markets.history).not.toHaveBeenCalled();
    for (const body of bodies.filter(body => body.state.decision_stage === 'candidate_filter')) {
      expect(body.state.market_scope).toBe('Stablecoins only');
      expect(body.state.markets.every((row: string[]) => ['USDSM', 'USDC', 'USDT'].includes(row[0]))).toBe(true);
      expect(body.state.markets.every((row: string[]) => row.at(-1) === 'fiat-pegged stablecoin')).toBe(true);
      expect(body.state.technical_evidence.map((item: { symbol: string }) => item.symbol)).toEqual(body.state.markets.map((row: string[]) => row[0]));
      expect(Object.keys(body.questions.selection.criteria)).toEqual([...body.state.markets.map((row: string[]) => row[0]), NONE]);
    }
    expect(result).toMatchObject({ assetScope: 'only', scannedCount: 3, catalogCount: 3, evaluatedCount: 3, unavailableSymbols: ['DAI'] });
    expect(['USDSM', 'USDC', 'USDT']).toContain(result.winner);
    expect(result.candidates.every(candidate => ['USDSM', 'USDC', 'USDT'].includes(candidate.symbol))).toBe(true);
    expect(result.reply).toContain('stablecoins only');
  });
  it('includes both stablecoins and ordinary assets when the resolved scope is all', async () => {
    const symbols = ['USDSM', 'BTC', 'USDC', 'PAXG', 'STABLE'];
    const markets = service(universe(symbols.length, symbols));
    const request = model(false, 'all');
    const history = ['Exclude stablecoins'];
    const prompt = 'Do not exclude stablecoins; compare them alongside other cryptocurrencies.';
    const result = await new MarketChatService(markets, 'test-key', false, request).scan(prompt, 24, history);
    expect(markets.forSymbols).toHaveBeenCalledWith(symbols, expect.any(Function));
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(bodies[0].state).toMatchObject({ stage: 'planning', user_request: prompt, earlier_user_requests: history });
    const analysis = bodies.find(body => body.state.stage === 'analysis');
    expect(analysis.state.markets.map((row: string[]) => row[0])).toEqual(symbols);
    expect(result).toMatchObject({ assetScope: 'all', scannedCount: 5, catalogCount: 5, evaluatedCount: 5 });
    expect(result.reply).toContain('including stablecoins');
  });
  it('rejects invalid scope decisions before loading hourly data or ranking candidates', async () => {
    const markets = service(universe(3));
    const request = vi.fn(async () => Response.json({ model: 'typesafe/jev-1.13', answers: { selection: { type: 'choice', choice: 'unknown', probabilities: { all: 0, only: 0, exclude: 0, unknown: 1 } } } }));
    const chat = new MarketChatService(markets, 'test-key', false, request);
    await expect(chat.scan('Find stable coins', 24)).rejects.toThrow(/inconsistent/);
    expect(markets.forSymbols).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(chat.status()).toMatchObject({ stage: 'failed', assetScope: null });
  });
  it('sends every quoted asset exactly once through bounded first-pass choices, then compares finalists', async () => {
    const data = universe();
    const request = model();
    const markets = service(data);
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const [result, duplicate] = await Promise.all([chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins']), chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins'])]);
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    const screening = bodies.filter(body => body.state.stage === 'analysis');
    const seen = screening.flatMap(body => body.state.markets.map((row: unknown[]) => row[0]));
    expect(seen).toHaveLength(619);
    expect(new Set(seen).size).toBe(619);
    expect(screening.length).toBeGreaterThanOrEqual(Math.ceil(619 / SCREEN_BATCH_SIZE));
    for (const body of screening) {
      expect(Object.keys(body.questions.selection.criteria).length).toBeLessThanOrEqual(SCREEN_BATCH_SIZE + 1);
      expect(body.state.technical_evidence.map((item: { symbol: string }) => item.symbol)).toEqual(body.state.markets.map((row: unknown[]) => row[0]));
      expect(body.state.earlier_user_requests).toEqual(['Avoid illiquid coins']);
      expect(body.questions.selection.criteria).toHaveProperty(NONE);
    }
    expect(result.scannedCount).toBe(619);
    expect(result.shortlistCount).toBeGreaterThan(20);
    expect(result.evaluatedCount).toBe(619);
    expect(markets.forSymbols).toHaveBeenCalledWith(data.markets.map(quote => quote.symbol), expect.any(Function));
    expect(markets.history).not.toHaveBeenCalled();
    const final = bodies.find(body => body.state.stage === 'final');
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_SYSTEM_ONE_REQUEST_BYTES);
      expect(serialized).not.toMatch(/five[-_ ]year|five calendar years|weekly_closes|long[-_ ]term|5y/i);
      for (const evidence of body.state.technical_evidence ?? []) {
        expect(evidence).not.toHaveProperty('five_year_history');
        expect(evidence.last_24_hourly_closes).toHaveLength(24);
      }
    }
    expect(final.state.horizon_hours).toBe(24);
    expect(result).not.toHaveProperty('longTermHistory');
    expect(result.winner).toBeTruthy();
    const finalSymbols = Object.keys(final.questions.selection.criteria).filter(symbol => symbol !== NONE);
    expect(finalSymbols.length).toBeGreaterThan(3);
    expect(result.candidates.map(item => item.symbol).sort()).toEqual([...finalSymbols].sort());
    expect(result.candidates).toHaveLength(result.finalistCount);
    expect(result.candidates[0].symbol).toBe(result.winner);
    for (const candidate of result.candidates) expect(candidate).not.toHaveProperty('longTermHistory');
    expect(result.modelCalls).toBe(bodies.length);
    expect(result.batches).toBe(screening.length);
    expect(result.comparisonBatches).toBe(bodies.filter(body => body.state.stage === 'comparison').length);
    expect(result.finalistCount).toBe(final.state.markets.length);
    expect(result.cost).toBeCloseTo(result.modelCalls * 0.0001);
    expect(chat.status()).toEqual({ stage: 'complete', assetScope: 'all', objective: 'best_fit', total: 619, hourlyChecked: 619, analyzed: 619, modelCalls: bodies.length });
    expect(duplicate.id).toBe(result.id);
    await chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins']);
    expect(request).toHaveBeenCalledTimes(bodies.length);
  });
  it('allows abstention and does not present alternatives as a purchase recommendation', async () => {
    const request = model(true);
    const chat = new MarketChatService(service(universe(20)), 'test-key', false, request);
    const result = await chat.scan('Find a guaranteed winner', 24);
    const final = request.mock.calls.map(call => JSON.parse(call[1]!.body as string)).find(body => body.state.stage === 'final');
    const finalSymbols = Object.keys(final.questions.selection.criteria).filter(symbol => symbol !== NONE);
    expect(result.winner).toBeNull();
    expect(result.noCandidateWeight).toBe(1);
    expect(finalSymbols.length).toBeGreaterThan(0);
    expect(result.candidates.map(item => item.symbol).sort()).toEqual([...finalSymbols].sort());
    expect(result.candidates).toHaveLength(result.finalistCount);
    expect(result.reply).toContain('no purchase candidate');
    expect(result.reply).toContain('first choice is to wait');
  });
  it('discloses missing ticker/history coverage and never replaces it with invented data', async () => {
    const data = universe(10);
    data.errors.push({ symbol: 'MISSING', message: 'Ticker unavailable.' });
    const markets = service(data);
    markets.forSymbols = vi.fn(async (symbols: string[]) => [{ ...demoMarket('BTC'), symbol: symbols[0], source: 'kraken' as const }]);
    const result = await new MarketChatService(markets, 'test-key', false, model()).scan('Strong trend', 4);
    expect(result.unavailableSymbols).toEqual(['MISSING']);
    expect(result.historyUnavailable).toHaveLength(9);
    expect(result.evaluatedCount).toBe(1);
    expect(markets.history).not.toHaveBeenCalled();
  });
  it('does not fetch or report five-year history even when it is mentioned in the user prompt', async () => {
    const markets = service(universe(20));
    const request = model();
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const prompt = 'Compare five years of price history';
    const result = await chat.scan(prompt, 168);
    expect(markets.history).not.toHaveBeenCalled();
    expect(result.evaluatedCount).toBe(20);
    for (const call of request.mock.calls) {
      const body = JSON.parse(call[1]!.body as string);
      if (body.state.stage !== 'market_regime') expect(body.state.user_request).toBe(prompt);
      for (const evidence of body.state.technical_evidence ?? []) expect(evidence).not.toHaveProperty('five_year_history');
    }
    expect(result).not.toHaveProperty('longTermHistory');
    expect(chat.status()).not.toHaveProperty('longTermChecked');
    expect(result.reply).toContain('Hourly history was checked for all 20 quoted markets');
    expect(result.reply).not.toMatch(/five[- ]years?|weekly|long[- ]term|5y/i);
    for (const candidate of result.candidates) {
      expect(candidate).not.toHaveProperty('longTermHistory');
      expect(candidate.risks.join(' ')).not.toMatch(/five[- ]years?|weekly|long[- ]term|5y/i);
    }
  });
  it.each(['analysis', 'comparison', 'final'] as const)('uses hourly evidence and request context in the %s prompt', stage => {
    const quote = universe(1).markets[0];
    const observations = { ...demoMarket('BTC'), symbol: quote.symbol, source: 'kraken' as const };
    const request = buildScreenRequest([quote], 'Study recent trends', 4, ['Avoid illiquid coins'], [observations], stage);
    expect(request.state).toMatchObject({ stage, user_request: 'Study recent trends', earlier_user_requests: ['Avoid illiquid coins'], horizon_hours: 4 });
    expect(request.state.technical_evidence).toEqual([{
      symbol: quote.symbol,
      as_of: new Date(observations.candles.at(-1)!.time).toISOString(),
      indicators: observations.indicators,
      momentum: chatMomentum(observations),
      last_24_hourly_closes: observations.candles.slice(-24).map(candle => candle.close),
    }]);
    expect(JSON.stringify(request)).not.toMatch(/five[-_ ]year|five calendar years|weekly_closes|long[-_ ]term|5y/i);
    expect(request.questions.selection.criteria).toHaveProperty(NONE);
  });
  it('refuses a stale universe before any paid call', async () => {
    const data = universe(10); data.markets.forEach(quote => { quote.stale = true; });
    const request = model();
    await expect(new MarketChatService(service(data), 'test-key', false, request).scan('Best buy', 24)).rejects.toThrow(/live feed/);
    expect(request).not.toHaveBeenCalled();
  });
  it('reports loading progress for the chosen universe before any ranking calls', async () => {
    const data = universe(20);
    const markets = service(data);
    const request = model();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    markets.forSymbols = vi.fn(async (symbols: string[], report?: (checked: number) => void) => {
      report?.(2); started?.(); await gate;
      return symbols.map(symbol => ({ ...demoMarket('BTC'), symbol, source: 'kraken' as const }));
    });
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const job = chat.scan('Analyze all markets', 24);
    await ready;
    expect(chat.status()).toEqual({ stage: 'loading', assetScope: 'all', objective: 'best_fit', total: 20, hourlyChecked: 2, analyzed: 0, modelCalls: 1 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).state.stage).toBe('planning');
    release?.(); await job;
    expect(chat.status()).toMatchObject({ stage: 'complete', total: 20, hourlyChecked: 20, analyzed: 20 });
    expect(markets.history).not.toHaveBeenCalled();
  });
  it('marks a rejected scan as failed and does not retry an unchanged HTTP 400 request', async () => {
    const request = vi.fn(async () => Response.json({ error: { message: 'Invalid request schema' } }, { status: 400 }));
    const chat = new MarketChatService(service(universe(1)), 'test-key', false, request);
    await expect(chat.scan('Analyze history', 24)).rejects.toThrow(/HTTP 400.*Invalid request schema/);
    expect(chat.status()?.stage).toBe('failed');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown or missing model options', () => {
    const payload = { model: 'typesafe/jev-1.13', answers: { selection: { type: 'choice', choice: 'FAKE', probabilities: { BTC: 0, FAKE: 1, [NONE]: 0 } } } };
    expect(() => parseSelection(payload, ['BTC'])).toThrow(/inconsistent/);
    payload.answers.selection.choice = 'BTC';
    payload.answers.selection.probabilities = { BTC: 1 } as typeof payload.answers.selection.probabilities;
    expect(() => parseSelection(payload, ['BTC'])).toThrow(/inconsistent/);
  });
});

describe('staged market decisions', () => {
  it('records separate bounded requests, conditions later stages on earlier answers, and replays a single stage', async () => {
    const request = model(false, 'all', 'upside');
    const data = universe(8);
    const result = await new MarketChatService(service(data), 'key', false, request).scan('Find percentage upside', 24);
    const pipeline = result.pipeline!;
    expect(pipeline.version).toBe('1');
    expect(pipeline.decisions.map(item => item.stage)).toEqual(['planning', 'market_regime', 'candidate_filter', 'candidate_filter', 'setup_quality', 'risk_gate']);
    const [plan, regime, filter, final, setup, risk] = pipeline.decisions;
    expect(Object.keys(plan.answers)).toEqual(['selection', 'objective']);
    expect(Object.keys(final.answers)).toEqual(['selection']);
    expect(Object.keys(setup.answers)).toEqual(['setup']);
    expect(Object.keys(risk.answers)).toEqual(['risk']);
    expect(filter.request.state.market_regime).toEqual(regime.answers.regime);
    expect(risk.request.state.setup_quality).toEqual(setup.answers.setup);
    expect(setup.request.state.subject).toBe(result.winner);
    expect(risk.request.state.subject).toBe(result.winner);
    expect(pipeline.action).toMatchObject({ choice: 'research', symbol: result.winner });
    expect(new Set(pipeline.decisions.map(item => item.id)).size).toBe(result.modelCalls);
    for (const item of pipeline.decisions) {
      expect(item.request.state.prompt_version).toBe('1');
      expect(item.request.state.decision_stage).toBe(item.stage);
      expect(Buffer.byteLength(JSON.stringify(item.request))).toBeLessThanOrEqual(MAX_SYSTEM_ONE_REQUEST_BYTES);
      expect(item.request).not.toHaveProperty('headers');
    }
    const before = request.mock.calls.length;
    const replay = await runStageDecision('replay', setup.stage, setup.request, 'key', request);
    expect(request).toHaveBeenCalledTimes(before + 1);
    expect(replay.request).toEqual(setup.request);
    expect(replay.answers).toEqual(setup.answers);
    expect(renderResult(result, data)).toContain('Decision stages');
  });

  it.each([
    { name: 'weak setup', overrides: { setup: { choice: 'weak', probabilities: { supported: 0.2, weak: 0.8 } } }, action: 'watch', reason: 'weak_setup' },
    { name: 'risk veto', overrides: { risk: { choice: 'block', probabilities: { allow: 0.1, block: 0.9 } } }, action: 'wait', reason: 'risk_not_cleared' },
    { name: 'tied setup', overrides: { setup: { choice: 'supported', probabilities: { supported: 0.5, weak: 0.5 } } }, action: 'watch', reason: 'weak_setup' },
    { name: 'tied risk', overrides: { risk: { choice: 'allow', probabilities: { allow: 0.5, block: 0.5 } } }, action: 'wait', reason: 'risk_not_cleared' },
  ])('keeps the comparison leader but withholds selection for $name', async ({ overrides, action, reason }) => {
    const data = universe(4);
    const result = await new MarketChatService(service(data), 'key', false, model(false, 'all', 'upside', undefined, overrides)).scan('Which coin will pump?', 4);
    expect(result.winner).toBeNull();
    expect(result.comparisonLeader).toBe(result.candidates[0].symbol);
    expect(result.pipeline!.action).toMatchObject({ choice: action, reasons: [reason] });
    if (reason === 'risk_not_cleared') {
      expect(result.noCandidateWeight).toBe(0);
      expect(result.reply).toContain('risk gate');
      expect(result.reply).not.toContain('no clear upside setup');
      expect(renderResult(result, data)).not.toContain('No clear upside setup was identified');
    }
  });

  it('honors a filter abstention even when the setup and risk gates approve', async () => {
    const request = model(true, 'all', 'best_fit', undefined, { setup: { choice: 'supported', probabilities: { supported: 1, weak: 0 } } });
    const result = await new MarketChatService(service(universe(3)), 'key', false, request).scan('Compare assets', 24);
    expect(result.pipeline!.action).toMatchObject({ choice: 'wait', reasons: ['filter_abstained'] });
    expect(result.winner).toBeNull();
  });

  it('does not let model approval bypass evidence that expired during inference', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const base = model();
      const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const result = await base(url, init);
        if (JSON.parse(init!.body as string).state.stage === 'risk_gate') clock.mockReturnValue(now + 3 * HOUR);
        return result;
      });
      const result = await new MarketChatService(service(universe(3)), 'key', false, request).scan('Find a liquid candidate', 24);
      expect(result.winner).toBeNull();
      expect(result.pipeline!.action).toMatchObject({ choice: 'wait', hardBlocks: ['expired_or_future_evidence'] });
    } finally { clock.mockRestore(); }
  });

  it.each(['market_regime', 'setup_quality', 'risk_gate'])('fails closed for a malformed %s response', async stage => {
    const base = model();
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (JSON.parse(init!.body as string).state.stage === stage) return Response.json({ model: 'typesafe/jev-1.13', answers: {} });
      return base(url, init);
    });
    const chat = new MarketChatService(service(universe(3)), 'key', false, request);
    await expect(chat.scan('Compare assets', 24)).rejects.toThrow(/invalid/);
    expect(chat.status()!.stage).toBe('failed');
    expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string).state.stage).toBe(stage);
  });

  it('round-trips complete evidence in the durable journal and rejects contradictory or malformed pipelines', async () => {
    const result = await new MarketChatService(service(universe(4)), 'key', false, model()).scan('Compare assets', 24);
    const record = createRankingRecord(result, ['Preserve this context']);
    expect(chatRankingJournalSchema.parse([record])).toEqual([record]);
    const directory = await mkdtemp(path.join(tmpdir(), 'jev-pipeline-test-'));
    try {
      const file = path.join(directory, 'journal.json');
      await new ChatRankingStore(file).add(result, ['Preserve this context']);
      expect((await new ChatRankingStore(file).list())[0].scan.pipeline).toEqual(result.pipeline);
    } finally { await rm(directory, { recursive: true, force: true }); }
    const mutations = [
      (scan: MarketChatResult) => { scan.winner = null; },
      (scan: MarketChatResult) => { scan.cost = 100; },
      (scan: MarketChatResult) => { scan.pipeline!.decisions = []; },
      (scan: MarketChatResult) => { scan.pipeline!.decisions.at(-1)!.answers = {}; },
      (scan: MarketChatResult) => { scan.pipeline!.action.choice = 'wait'; },
      (scan: MarketChatResult) => { scan.pipeline!.decisions.at(-1)!.answers.risk.probabilities.allow = 0.1; },
      (scan: MarketChatResult) => { scan.pipeline!.decisions.at(-1)!.request.state.subject = 'INVENTED'; },
      (scan: MarketChatResult) => { scan.pipeline!.decisions.at(-1)!.id = scan.pipeline!.decisions[0].id; },
    ];
    for (const mutate of mutations) {
      const edited = structuredClone(record); mutate(edited.scan);
      expect(chatRankingJournalSchema.safeParse([edited]).success).toBe(false);
    }
  });

  it('benchmarks explicit labels with proper scores and calibration, excluding unlabeled decisions', async () => {
    const request = model(false, 'all', 'best_fit', undefined, {
      setup: { choice: 'supported', probabilities: { supported: 0.8, weak: 0.2 } },
      risk: { choice: 'allow', probabilities: { allow: 0.7, block: 0.3 } },
    });
    const result = await new MarketChatService(service(universe(4)), 'key', false, request).scan('Compare assets', 24);
    const records = [createRankingRecord(result, [])];
    const template = decisionLabelTemplate(records);
    const labels = template.filter(label => ['setup', 'risk'].includes(label.question)).map(label => ({ ...label, expected: label.question === 'setup' ? 'supported' : 'block' }));
    const report = benchmarkDecisions(records, labels);
    expect(report).toMatchObject({ labeledQuestions: 2, availableQuestions: 7, unlabeledQuestions: 5, scoredCalls: 2, cost: expect.closeTo(0.0002) });
    expect(report.groups.find(group => group.stage === 'setup_quality')).toMatchObject({ samples: 1, accuracy: 1, brier: expect.closeTo(0.08), logLoss: expect.closeTo(-Math.log(0.8)), calibrationError: expect.closeTo(0.2) });
    expect(report.groups.find(group => group.stage === 'risk_gate')).toMatchObject({ samples: 1, accuracy: 0, brier: expect.closeTo(0.98), logLoss: expect.closeTo(-Math.log(0.3)), calibrationError: expect.closeTo(0.7) });
    expect(benchmarkDecisions(records, [])).toMatchObject({ groups: [], labeledQuestions: 0, unlabeledQuestions: 7 });
    expect(() => benchmarkDecisions(records, [labels[0], labels[0]])).toThrow(/Duplicate label/);
    expect(() => benchmarkDecisions(records, [{ ...labels[0], expected: 'profit' }])).toThrow(/outside/);
    expect(() => benchmarkDecisions(records, [{ ...labels[0], decisionId: 'unknown' }])).toThrow(/Unknown/);
    expect(() => benchmarkDecisions(records, template)).toThrow();
    const plan = template.filter(label => ['selection', 'objective'].includes(label.question) && label.decisionId.startsWith('planning')).map(label => ({ ...label, expected: label.question === 'selection' ? 'all' : 'best_fit' }));
    expect(benchmarkDecisions(records, plan)).toMatchObject({ labeledQuestions: 2, scoredCalls: 1, cost: 0.0001 });
  });
});

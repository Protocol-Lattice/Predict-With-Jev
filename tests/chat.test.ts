import { describe, expect, it, vi } from 'vitest';
import { MarketChatService, NONE, parseSelection, SCREEN_BATCH_SIZE } from '../server/chat';
import { demoMarket, MarketService } from '../server/market';
import type { Asset, MarketQuote, MarketsResponse } from '../shared/types';

function universe(size = 619): MarketsResponse {
  const markets: MarketQuote[] = Array.from({ length: size }, (_, index) => ({ symbol: `COIN${index}`, name: `Coin ${index}`, price: index + 1, changeToday: 1, volume24h: 2_000_000 + index, high24h: index + 2, low24h: index + 0.5, source: 'kraken', stale: false, fetchedAt: Date.now() }));
  const assets: Asset[] = markets.map(quote => ({ symbol: quote.symbol, name: quote.name, pair: `${quote.symbol}USD`, tickerKey: `${quote.symbol}USD`, color: '#abc', glyph: 'C' }));
  return { markets, assets, fetchedAt: Date.now(), errors: [] };
}
function service(overview: MarketsResponse) {
  return { all: vi.fn(async () => overview), forSymbols: vi.fn(async (symbols: string[]) => symbols.map(symbol => ({ ...demoMarket('BTC'), symbol, source: 'kraken' as const }))) } as unknown as MarketService;
}
function model(abstain = false) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    const options = Object.keys(body.questions.selection.criteria);
    const choice = abstain && body.state.technical_evidence ? NONE : options[0];
    return Response.json({ model: 'typesafe/jev-1.13', answers: { selection: { type: 'choice', choice, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 1 : 0])) } }, usage: { cost: 0.0001 } });
  });
}

describe('whole-market chat scanner', () => {
  it('sends every quoted asset exactly once through bounded first-pass choices, then compares finalists', async () => {
    const data = universe();
    const request = model();
    const markets = service(data);
    const chat = new MarketChatService(markets, 'test-key', false, request);
    const [result, duplicate] = await Promise.all([chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins']), chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins'])]);
    const bodies = request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    const screening = bodies.filter(body => !body.state.technical_evidence);
    const seen = screening.flatMap(body => body.state.markets.map((row: unknown[]) => row[0]));
    expect(seen).toHaveLength(619);
    expect(new Set(seen).size).toBe(619);
    expect(screening).toHaveLength(Math.ceil(619 / SCREEN_BATCH_SIZE));
    for (const body of screening) {
      expect(Object.keys(body.questions.selection.criteria).length).toBeLessThanOrEqual(255);
      expect(body.state.earlier_user_requests).toEqual(['Avoid illiquid coins']);
      expect(body.questions.selection.criteria).toHaveProperty(NONE);
    }
    expect(result.scannedCount).toBe(619);
    expect(result.shortlistCount).toBe(15);
    expect(result.evaluatedCount).toBe(15);
    expect(result.winner).toBeTruthy();
    expect(result.candidates).toHaveLength(3);
    expect(result.cost).toBeCloseTo(0.0006);
    expect(duplicate.id).toBe(result.id);
    await chat.scan('Find a liquid candidate', 24, ['Avoid illiquid coins']);
    expect(request).toHaveBeenCalledTimes(6);
  });
  it('allows abstention and does not present alternatives as a purchase recommendation', async () => {
    const chat = new MarketChatService(service(universe(20)), 'test-key', false, model(true));
    const result = await chat.scan('Find a guaranteed winner', 24);
    expect(result.winner).toBeNull();
    expect(result.noCandidateWeight).toBe(1);
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
    expect(result.historyUnavailable).toHaveLength(2);
    expect(result.evaluatedCount).toBe(1);
  });
  it('refuses a stale universe before any paid call', async () => {
    const data = universe(10); data.markets[0].stale = true;
    const request = model();
    await expect(new MarketChatService(service(data), 'test-key', false, request).scan('Best buy', 24)).rejects.toThrow(/live feed/);
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects unknown or missing model options', () => {
    const payload = { model: 'typesafe/jev-1.13', answers: { selection: { type: 'choice', choice: 'FAKE', probabilities: { BTC: 0, FAKE: 1, [NONE]: 0 } } } };
    expect(() => parseSelection(payload, ['BTC'])).toThrow(/inconsistent/);
    payload.answers.selection.choice = 'BTC';
    payload.answers.selection.probabilities = { BTC: 1 } as typeof payload.answers.selection.probabilities;
    expect(() => parseSelection(payload, ['BTC'])).toThrow(/inconsistent/);
  });
});

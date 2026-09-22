import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RankingRecord } from '../src/ChatRankings';
import { createRankingRecord, resolveRanking } from '../server/chat-journal';
import { HOUR } from '../server/analysis';
import { observedMarket, rankingScan, SCAN_TIME } from './fixtures/chat-ranking';

describe('saved ranking display', () => {
  it('shows exact-horizon results in the original order and preserves no-purchase labels', () => {
    const record = createRankingRecord(rankingScan('scan', null), [], SCAN_TIME + 1000);
    const resolved = resolveRanking(record, ['BTC', 'ETH'].map(symbol => observedMarket(symbol, [[record.referenceTime, 100], [record.referenceTime + 4 * HOUR, symbol === 'BTC' ? 90 : 110]])), record.referenceTime + 4 * HOUR);
    const html = renderToStaticMarkup(createElement(RankingRecord, { record: resolved, analyze: () => {} }));
    expect(html).toContain('No purchase selected');
    expect(html).toContain('Comparison leader · no purchase');
    expect(html).toContain('-10.00%');
    expect(html).toContain('+10.00%');
    expect(html.indexOf('Bitcoin')).toBeLessThan(html.indexOf('Ethereum'));
    expect(html).toContain('After 4h');
    expect(html).toContain('After 24h');
    expect(html).toContain('After 7 days');
    expect(html).toContain('Pending');
    expect(html).not.toContain('Selected candidate');
  });
});

import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Clock3, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ChatRankingRecord, ChatRankingsResponse, RankingOutcome } from '../shared/chat-journal';
import { CHAT_OBJECTIVE_LABELS } from '../shared/types';
import { STABLECOIN_SCOPE_LABELS } from '../shared/stablecoins';
import { api, exportJson, horizonLabel, money, percent, timeLabel } from './utils';
import './chat-rankings.css';

const PAGE_SIZE = 20;

export function RankingOutcomeCell({ outcome }: { outcome: RankingOutcome }) {
  return <div className="ranking-outcome" title={outcome.status === 'unavailable' ? outcome.reason : new Date(outcome.targetTime).toISOString()}>
    {outcome.status === 'evaluated' ? <strong className={outcome.returnPercent >= 0 ? 'positive' : 'negative'}>{percent(outcome.returnPercent)}</strong>
      : <span>{outcome.status === 'unavailable' ? 'Unavailable' : outcome.targetTime <= Date.now() ? 'Awaiting close data' : 'Pending'}</span>}
    <small>{timeLabel(outcome.targetTime)}</small>
  </div>;
}

export function RankingRecord({ record, analyze }: { record: ChatRankingRecord; analyze: (symbol: string) => void }) {
  const scan = record.scan;
  const selected = scan.winner ?? scan.comparisonLeader;
  const lead = record.tracking.find(item => item.symbol === selected);
  return <details className="panel ranking-record">
    <summary><div><span className="eyebrow">{timeLabel(scan.createdAt)} · {CHAT_OBJECTIVE_LABELS[scan.objective]}</span><h3>{scan.prompt}</h3><p>{scan.winner ? `Selected: ${scan.winner}` : scan.comparisonLeader ? `Comparison leader: ${scan.comparisonLeader} · No purchase selected` : 'No purchase selected'} · {scan.candidates.length} candidates recorded</p></div>
      <div className="ranking-preview">{lead?.outcomes.map(outcome => <div key={outcome.horizon}><span>{horizonLabel(outcome.horizon)}</span><RankingOutcomeCell outcome={outcome} /></div>)}</div>
    </summary>
    <div className="ranking-detail"><div className="ranking-metadata"><span>{STABLECOIN_SCOPE_LABELS[scan.assetScope]}</span><span>Requested horizon: {horizonLabel(scan.horizon)}</span><span>{scan.model}</span><button className="button secondary" onClick={() => exportJson(record, `jev-ranking-${scan.id}.json`)}><Download size={13} />Export ranking</button></div>
      <p className="ranking-reference">Measured from the first hourly close after saving: <b>{timeLabel(record.referenceTime)}</b>. All returns use the exact completed close at the listed target time. Fees and slippage are excluded.</p>
      <div className="ranking-table-scroll"><table className="ranking-table"><thead><tr><th>Rank</th><th>Asset / original role</th><th>Selection weight</th><th>Reference close</th><th>After 4h</th><th>After 24h</th><th>After 7 days</th></tr></thead><tbody>
        {scan.candidates.map((candidate, index) => {
          const tracking = record.tracking[index];
          return <tr key={candidate.symbol}><td>{String(index + 1).padStart(2, '0')}</td><td><button onClick={() => analyze(candidate.symbol)}>{candidate.name} <b>{candidate.symbol}</b><ArrowUpRight size={12} /></button><small>{candidate.symbol === scan.winner ? 'Selected candidate' : candidate.symbol === scan.comparisonLeader ? 'Comparison leader · no purchase' : 'Comparison candidate'}</small></td>
            <td>{(candidate.selectionWeight * 100).toFixed(1)}%</td><td title={tracking.reference.status === 'unavailable' ? tracking.reference.reason : undefined}>{tracking.reference.status === 'captured' ? money(tracking.reference.price) : tracking.reference.status === 'unavailable' ? 'Unavailable' : 'Pending'}</td>
            {tracking.outcomes.map(outcome => <td key={outcome.horizon}><RankingOutcomeCell outcome={outcome} /></td>)}
          </tr>;
        })}
      </tbody></table></div>
      <p className="ranking-reference">Original order and decisions are preserved. Selection weights are not probabilities of profit. Missing observations are marked unavailable, never scored as zero.</p>
    </div>
  </details>;
}

export default function ChatRankings({ analyze }: { analyze: (symbol: string) => void }) {
  const [data, setData] = useState<ChatRankingsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api<ChatRankingsResponse>(`/api/chat/rankings?offset=${offset}&limit=${PAGE_SIZE}`, { signal });
      if (!signal?.aborted) { setData(result); setError(''); }
    } catch (problem) { if (!signal?.aborted) setError(problem instanceof Error ? problem.message : 'Could not load saved rankings.'); }
  }, [offset]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  async function check() {
    setChecking(true);
    try { await api('/api/chat/rankings/evaluate', { method: 'POST' }); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not check outcomes.'); }
    finally { setChecking(false); }
  }
  return <div className="rankings-page"><section className="panel ranking-overview"><div className="panel-title"><div><Clock3 size={17} /><h2>Saved chat rankings</h2></div><button className="button secondary" disabled={checking || data?.evaluator.running} onClick={() => void check()}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Check outcomes</button></div>
    <p>Every completed chat scan is saved automatically, including comparisons and scans without a purchase candidate. Outcomes are checked after 4h, 24h, and 7 days from the reference close.</p>
    <p className="ranking-status">{data?.evaluator.enabled ? 'Automatic checks active while the local server runs.' : 'Automatic checks start with the local server.'} {data?.evaluator.lastCheckedAt ? `Last check: ${timeLabel(data.evaluator.lastCheckedAt)}.` : 'No completed check yet.'} {data?.evaluator.running ? 'Checking due observations…' : ''} Checking outcomes does not call JEV.</p>
    {data && <p className="ranking-status">{data.summary.total} saved scans · {data.summary.selected} selected a candidate · {data.summary.noSelection} selected no purchase. Summary below covers selected candidates only; comparisons remain in each saved ranking.</p>}
  </section>
    {(error || data?.evaluator.error) && <div className="notice error-notice" role="alert">{error || data?.evaluator.error}</div>}
    {!data && !error && <p role="status">Loading saved rankings…</p>}
    {data && <><div className="ranking-stats">{data.summary.horizons.map(item => <section className="panel" key={item.horizon}><span className="eyebrow">SELECTED CANDIDATES · {horizonLabel(item.horizon)}</span><strong className={item.averageReturnPercent === null ? '' : item.averageReturnPercent >= 0 ? 'positive' : 'negative'}>{item.averageReturnPercent === null ? '—' : percent(item.averageReturnPercent)}</strong><p>Average observed return · {item.evaluated} scored</p><small>{item.positivePercent === null ? 'Positive outcomes: —' : `${item.positivePercent.toFixed(1)}% positive outcomes`} · {item.pending} pending · {item.unavailable} unavailable</small></section>)}</div>
      {!data.total && <section className="panel ranking-empty"><Clock3 size={24} /><h3>Your next chat scan starts the journal.</h3><p>Existing page-only conversations are not backfilled. New rankings are recorded before their reference close and survive browser or server restarts.</p></section>}
      {data.records.map(record => <RankingRecord key={record.scan.id} record={record} analyze={analyze} />)}
      {data.total > PAGE_SIZE && <div className="ranking-pagination"><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}>Previous</button><span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}</span><button className="button secondary" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(value => value + PAGE_SIZE)}>Next</button></div>}
    </>}
  </div>;
}

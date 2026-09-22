import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Cpu, Download, Globe2, Layers3, LoaderCircle, MessageSquareText, Plus, Send, ShieldCheck, Sparkles, Waves } from 'lucide-react';
import { CHAT_OBJECTIVE_LABELS, HORIZONS, type Asset, type ChatCandidate, type ChatMessage, type ChatScanProgress, type Health, type Horizon, type MarketQuote, type Symbol } from '../shared/types';
import { matchesStablecoinScope, STABLECOIN_SCOPE_LABELS } from '../shared/stablecoins';
import { api, exportJson, horizonLabel, money, percent, timeLabel } from './utils';
import './market-chat-momentum.css';

function MomentumEvidence({ candidate }: { candidate: ChatCandidate }) {
  const values = candidate.momentum;
  const change = (value: number | null) => value === null ? 'Unavailable' : percent(value);
  return <section className="candidate-momentum" aria-label={`Observed momentum for ${candidate.symbol}`}><h4>Observed momentum</h4><dl>
    <div><dt>1h change</dt><dd>{change(values.return1hPercent)}</dd></div>
    <div><dt>4h change</dt><dd>{change(values.return4hPercent)}</dd></div>
    <div><dt>24h change</dt><dd>{change(values.return24hPercent)}</dd></div>
    <div><dt>4h relative volume</dt><dd>{values.relativeVolume4h === null ? 'Unavailable' : `${values.relativeVolume4h.toFixed(2)}×`}</dd></div>
    <div><dt>Vs prior 24h high</dt><dd>{change(values.priceVsPrior24hHighPercent)}</dd></div>
  </dl><p>Completed hourly data · {timeLabel(candidate.referenceTime)}. Relative volume compares the latest 4h average with the preceding 20h average.</p></section>;
}

export default function MarketChat({ messages, setMessages, send, busy, error, horizon, setHorizon, markets, assets, health, analyze }: {
  messages: ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  send: (message: string) => Promise<boolean>;
  busy: boolean;
  error: string;
  horizon: Horizon;
  setHorizon: (horizon: Horizon) => void;
  markets: MarketQuote[];
  assets: Asset[];
  health: Health | null;
  analyze: (symbol: Symbol) => void;
}) {
  const [draft, setDraft] = useState('');
  const [progress, setProgress] = useState<ChatScanProgress | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const available = Boolean(health?.configured && !health.demo && markets.some(market => !market.stale && market.source === 'kraken'));
  const latestResult = [...messages].reverse().find(message => message.result)?.result;
  const assetScope = busy ? progress?.assetScope ?? null : latestResult?.assetScope ?? 'all';
  const objective = busy ? progress?.objective : latestResult?.objective;
  const scopedMarkets = markets.filter(market => matchesStablecoinScope(market.symbol, assetScope ?? 'all'));
  const assetCount = assets.filter(asset => matchesStablecoinScope(asset.symbol, assetScope ?? 'all')).length;
  const scopeLabel = assetScope ? STABLECOIN_SCOPE_LABELS[assetScope] : 'Reading your market preferences';
  const scopeDescription = assetScope === 'only' ? 'Only fiat-pegged stablecoins are considered for this request, with no liquidity cutoff.'
    : assetScope === 'exclude' ? 'Stablecoins are excluded for this request. All other available USD markets are considered, with no liquidity cutoff.'
    : 'Your prompt determines whether stablecoins are included, excluded, or researched on their own. All available USD markets can be considered, with no liquidity cutoff.';
  useEffect(() => {
    if (!busy) { setProgress(null); return; }
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await api<ChatScanProgress | null>('/api/chat/progress', { signal: controller.signal });
        if (!controller.signal.aborted) setProgress(result);
      } catch { /* The main chat request reports connection errors. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [busy]);
  useEffect(() => { if (messages.length && transcript.current) transcript.current.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' }); }, [messages.length, busy]);
  async function submit() { if (draft.trim().length < 3 || busy || !available) return; const text = draft.trim(); setDraft(''); if (!(await send(text))) setDraft(text); }
  const prompts = ['Which crypto is the best buy right now?', 'Find liquid assets with a strong trend and less volatility.', 'Compare BTC, ETH, and SOL. Which setup looks strongest?', 'Exclude stablecoins and avoid chasing today’s biggest pumps.'];
  return <div className="chat-layout"><section className="panel chat-main"><div className="panel-title"><div><span className="lime-icon"><MessageSquareText size={17} /></span><h2>Ask the market</h2><span className="model-badge">JEV 1.13</span></div><div className="chat-toolbar"><button className="icon-button" aria-label="Export chat" disabled={!messages.length || busy} onClick={() => exportJson(messages, 'jev-market-chat.json')}><Download size={15} /></button><button className="icon-button" aria-label="New conversation" disabled={!messages.length || busy} onClick={() => { setMessages([]); setDraft(''); input.current?.focus(); }}><Plus size={18} /></button></div></div>
    <div ref={transcript} className="chat-transcript" role="log" aria-live="polite" aria-label="Market conversation">
      {!messages.length && <div className="chat-welcome"><span className="chat-orb"><Waves size={35} /></span><span className="eyebrow">THE ENTIRE MARKET. ONE CONVERSATION.</span><h2>Find your next research candidate.</h2><p>Tell JEV what you’re looking for. It will choose the market scope from your prompt, analyze hourly signals, then compare candidates against your criteria. Ask for stablecoins to research them, or ask to exclude them.</p><div className="chat-suggestions">{prompts.map(prompt => <button key={prompt} onClick={() => { setDraft(prompt); input.current?.focus(); }}><span>{prompt}</span><ArrowUpRight size={14} /></button>)}</div></div>}
      {messages.map(message => message.role === 'user' ? <div key={message.id} className="chat-user-message"><span>You</span><p>{message.text}</p></div> : <article key={message.id} className="chat-assistant-message"><div className="chat-assistant-label"><span><Sparkles size={13} /></span><strong>JEV market intelligence</strong><small>{message.result ? timeLabel(message.result.createdAt) : ''}</small></div><p>{message.text}</p>{message.result && <>
        <div className="scan-receipt"><span><Globe2 size={12} />{message.result.scannedCount} markets checked</span><span><Layers3 size={12} />{message.result.evaluatedCount} markets analyzed</span><span><Check size={12} />{horizonLabel(message.result.horizon)}</span>{message.result.assetScope && <span>{STABLECOIN_SCOPE_LABELS[message.result.assetScope]}</span>}{message.result.objective === 'upside' && <span>{CHAT_OBJECTIVE_LABELS.upside}</span>}</div>
        {!message.result.winner && <div className="abstain-card"><ShieldCheck size={19} /><div><strong>{message.result.objective === 'upside' && message.result.comparisonLeader ? `Leading comparison: ${message.result.candidates.find(candidate => candidate.symbol === message.result!.comparisonLeader)?.name ?? message.result.comparisonLeader} (${message.result.comparisonLeader})` : message.result.objective === 'upside' ? 'No upside candidate selected' : 'No purchase candidate selected'}</strong><span>{message.result.objective === 'upside' ? 'No clear upside setup was identified. The ranking below compares the available evidence.' : 'The model favors waiting. Alternatives are shown for comparison.'}</span></div></div>}
        <div className="chat-candidates">{message.result.candidates.map((candidate, index) => <div className={`candidate-card ${candidate.symbol === message.result!.winner ? 'top-candidate' : ''}`} key={candidate.symbol}><header><span className="candidate-rank">{String(index + 1).padStart(2, '0')}</span><div><strong>{candidate.name} <small>{candidate.symbol}</small></strong><span>{candidate.symbol === message.result!.winner ? message.result!.objective === 'upside' ? 'TOP UPSIDE CANDIDATE' : 'BEST FIT FOR YOUR PROMPT' : message.result!.objective === 'upside' && candidate.symbol === message.result!.comparisonLeader ? 'LEADING COMPARISON' : 'COMPARISON CANDIDATE'}</span></div><button className="icon-button" aria-label={`Analyze ${candidate.symbol}`} onClick={() => analyze(candidate.symbol)}><ArrowUpRight size={17} /></button></header><div className="candidate-price"><strong>{money(candidate.price)}</strong><span className={candidate.changeToday >= 0 ? 'positive' : 'negative'}>{candidate.changeToday >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}{percent(candidate.changeToday)}<small>today UTC</small></span></div><div className="candidate-metrics"><div><span>24h liquidity</span><b>{money(candidate.volume24h, true)}</b></div><div><span>RSI (14)</span><b>{candidate.rsi.toFixed(1)}</b></div><div><span>EMA trend</span><b className={candidate.trend === 'bullish' ? 'positive' : 'negative'}>{candidate.trend}</b></div></div>{message.result!.objective === 'upside' && candidate.momentum && <MomentumEvidence candidate={candidate} />}<div className="candidate-weight"><span>Relative selection weight</span><b>{(candidate.selectionWeight * 100).toFixed(1)}%</b></div><div className="candidate-weight-track"><span style={{ width: `${candidate.selectionWeight * 100}%` }} /></div><ul className="candidate-risks">{candidate.risks.map(risk => <li key={risk}>{risk}</li>)}</ul><button className="candidate-analyze" onClick={() => analyze(candidate.symbol)}>Inspect market & forecast <ArrowRight size={12} /></button></div>)}</div>{message.result.objective === 'upside' && <div className="chat-result-notes"><p>Selection weights are relative preferences, not the chance of a pump.</p></div>}
      </>}</article>)}
      {busy && <div className="chat-thinking"><span className="thinking-icon"><LoaderCircle size={18} className="spin" /></span><div><strong>{assetScope ? 'Scanning the market with JEV' : 'Reading your market preferences'}</strong><p>{assetScope ? `${scopeLabel}.${objective === 'upside' ? ' Ranking for short-term percentage upside.' : ''} Checking hourly signals for every eligible Kraken market. The first full scan can take several minutes.` : 'Reading your request to choose the market scope and ranking objective.'}</p>{progress?.assetScope && <p className="chat-progress" role="status">Hourly data checked: {progress.hourlyChecked}/{progress.total}<br />Markets analyzed by JEV: {progress.analyzed}/{progress.total} · {progress.modelCalls} model calls{progress.stage === 'comparing' ? ' · Comparing candidates' : ''}</p>}<div className="thinking-dots"><i /><i /><i /></div></div></div>}
      {error && <div className="chat-error" role="alert">{error}</div>}
    </div>
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void submit(); }}><div className="composer-controls"><span><span className={`status-dot ${available ? '' : 'warning'}`} />{available ? assetScope ? `${scopedMarkets.length} markets · ${scopeLabel}` : scopeLabel : health?.demo ? 'Live market data required' : !health?.configured ? 'OpenRouter key required' : 'Waiting for live market data'}</span><label>Horizon<select aria-label="Chat research horizon" value={horizon} disabled={busy} onChange={event => setHorizon(Number(event.target.value) as Horizon)}>{HORIZONS.map(value => <option value={value} key={value}>{horizonLabel(value)}</option>)}</select></label></div><div className="composer-input"><textarea ref={input} aria-label="Market research prompt" placeholder="What should I buy right now? Look across all Kraken cryptocurrencies…" maxLength={1200} rows={2} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><button className="chat-send" type="submit" disabled={busy || !available || draft.trim().length < 3} aria-label="Send market research prompt">{busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}</button></div><div className="composer-footer"><span>Enter to scan · Shift + Enter for a new line</span><span>Rankings saved automatically · On-demand OpenRouter usage</span></div></form>
  </section><aside className="chat-context"><section className="panel universe-card"><span className="settings-icon"><Globe2 size={24} /></span><span className="eyebrow">YOUR RESEARCH UNIVERSE</span><strong className="universe-number">{assetScope ? assetCount : '…'}</strong><h3>{assetScope === 'only' ? 'Kraken stablecoins' : 'Kraken cryptocurrencies'}</h3><p>{scopeDescription}</p><div><span>Market scope</span><b>{scopeLabel}</b></div>{objective && <div><span>Ranking goal</span><b>{CHAT_OBJECTIVE_LABELS[objective]}</b></div>}<div><span>Live quotes</span><b>{assetScope ? scopedMarkets.length : '…'}</b></div><div><span>Market data</span><b>Kraken spot</b></div><div><span>Decision model</span><b>TypeSafe JEV 1.13</b></div><div><span>Execution</span><b>Research only</b></div></section><section className="panel chat-how"><h3><Cpu size={15} />How JEV selects a candidate</h3><ol><li><span>01</span><div><strong>Read your criteria</strong><p>Your latest request sets the market scope and ranking goal. Pump requests focus on potential percentage upside over the selected horizon.</p></div></li><li><span>02</span><div><strong>Analyze every eligible market</strong><p>The requested stablecoin scope is applied before hourly signals are checked. Missing data is disclosed.</p></div></li><li><span>03</span><div><strong>Compare the candidates</strong><p>JEV analyzes all eligible markets in batches, then compares retained candidates in further rounds. It can select no candidate.</p></div></li></ol></section><div className="chat-context-note"><ShieldCheck size={15} /><p>Live news, order-book depth, and your financial circumstances are outside this scan. A top-ranked candidate is a starting point for research.</p></div></aside></div>;
}

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, ArrowDown, ArrowDownLeft, ArrowRight, ArrowUp, ArrowUpRight, Bell, BookOpen, Check, ChevronDown, ChevronRight, CircleHelp, Clock3, Cpu, Download, ExternalLink, Gauge, Layers3, LayoutDashboard, ListFilter, LoaderCircle, Menu, MessageSquareText, Radio, RefreshCw, ScanLine, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Star, TrendingUp, Waves, X, Zap, ChartNoAxesCombined, ChartCandlestick } from 'lucide-react';
import { FEATURED_ASSETS, assetDetails, HORIZONS, type Asset, type MarketQuote, type ChatMessage, type MarketChatResult, type Direction, type Forecast, type Health, type Horizon, type Market, type MarketsResponse, type Replay, type Symbol } from '../shared/types';
import Chart, { Sparkline } from './Chart';
import { AssetPicker, ForecastDetail } from './components';
import MarketChat from './MarketChat';
import { api, exportJson, horizonLabel, money, percent, shortTime, timeLabel } from './utils';

type View = 'chat' | 'overview' | 'journal' | 'replay' | 'watchlist' | 'settings' | 'methodology';
const directions: Direction[] = ['bullish', 'neutral', 'bearish'];
const titles: Record<View, string> = { chat: 'AI market chat', overview: 'Market overview', journal: 'Forecast journal', replay: 'Baseline replay', watchlist: 'Your watchlist', settings: 'Model & data', methodology: 'Behind the forecast' };
const subtitles: Record<View, string> = { chat: 'Your criteria. The entire market. A more informed next move.', overview: 'Read the market. Understand the possibilities.', journal: 'Every prediction, recorded before the outcome.', replay: 'A transparent benchmark against historical observations.', watchlist: 'A focused view of the markets you follow.', settings: 'Your intelligence engine and market connections.', methodology: 'Understand what the numbers can—and cannot—tell you.' };

function Logo({ small = false }: { small?: boolean }) { return <span className={`brand-symbol ${small ? 'small' : ''}`}><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M8 8h19L17 24H6l6-9h7l-3 4h-4l4-6H5z" fill="currentColor" /></svg></span>; }
function Coin({ symbol, small = false }: { symbol: Symbol; small?: boolean }) { const asset = assetDetails(symbol); return <span className={`coin ${small ? 'small' : ''} coin-${symbol}`} style={{ '--coin-color': asset.color } as CSSProperties}>{asset.glyph}</span>; }
function Change({ value }: { value: number }) { return <span className={`change ${value >= 0 ? 'positive' : 'negative'}`}>{value >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{percent(value)}</span>; }
function DirectionBadge({ direction }: { direction: Direction }) { return <span className={`direction-badge ${direction}`}>{direction === 'bullish' ? <ArrowUpRight size={12} /> : direction === 'bearish' ? <ArrowDownLeft size={12} /> : <ArrowRight size={12} />}{direction}</span>; }
function StatusDot({ warning = false }: { warning?: boolean }) { return <span className={`status-dot ${warning ? 'warning' : ''}`} />; }

export default function App() {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [view, setView] = useState<View>('overview');
  const [health, setHealth] = useState<Health | null>(null);
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<Market | undefined>();
  const [marketError, setMarketError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [inspected, setInspected] = useState<Forecast | null>(null);
  const [forecasts, setForecasts] = useState<Forecast[]>([]);
  const [symbol, setSymbol] = useState<Symbol>('BTC');
  const [horizon, setHorizon] = useState<Horizon>(24);
  const [range, setRange] = useState(168);
  const [chartKind, setChartKind] = useState<'line' | 'candles'>('line');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [menu, setMenu] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState('');
  const [favorites, setFavorites] = useState<Symbol[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem('jev-watchlist') ?? '["BTC","ETH","SOL"]'); return Array.isArray(value) ? value.filter((item): item is Symbol => typeof item === 'string' && /^[A-Z0-9][A-Z0-9._-]*$/.test(item)) : ['BTC', 'ETH', 'SOL']; }
    catch { return ['BTC', 'ETH', 'SOL']; }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const markets = data?.markets ?? [];
  const assets: Asset[] = data?.assets ?? FEATURED_ASSETS.map(asset => ({ ...asset, tickerKey: asset.pair }));
  const market = selectedMarket?.symbol === symbol ? selectedMarket : undefined;
  const latest = forecasts.find(item => item.symbol === symbol && item.horizon === horizon);
  const canJev = Boolean(health?.configured && !health.demo);

  const refresh = useCallback(async (quiet = false) => {
    if (busy.current) return;
    busy.current = true;
    if (!quiet) setRefreshing(true);
    const results = await Promise.allSettled([api<Health>('/api/health'), api<MarketsResponse>('/api/markets'), api<Forecast[]>('/api/forecasts')]);
    const problems: string[] = [];
    if (results[0].status === 'fulfilled') setHealth(results[0].value); else problems.push('Cannot connect to the local server.');
    if (results[1].status === 'fulfilled') setData(results[1].value); else problems.push(results[1].reason.message);
    if (results[2].status === 'fulfilled') setForecasts(results[2].value); else problems.push('Could not load the forecast journal.');
    setError(problems.join(' '));
    setLoading(false);
    setRefreshing(false);
    busy.current = false;
  }, []);
  useEffect(() => { void refresh(); const interval = setInterval(() => void refresh(true), 60_000); return () => clearInterval(interval); }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setSelectedMarket(undefined); setMarketError(''); setDetailLoading(true);
    api<Market>(`/api/markets/${encodeURIComponent(symbol)}`, { signal: controller.signal }).then(setSelectedMarket).catch(error => { if (error.name !== 'AbortError') setMarketError(error.message); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [symbol, data?.fetchedAt]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); setView('overview'); setTimeout(() => searchRef.current?.focus(), 0); } if (event.key === 'Escape') setMenu(false); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, []);
  useEffect(() => {
    if (view !== 'replay') return;
    const controller = new AbortController();
    setReplay(null); setReplayLoading(true); setReplayError('');
    api<Replay>(`/api/replay/${symbol}?horizon=${horizon}`, { signal: controller.signal }).then(setReplay).catch(error => { if (error.name !== 'AbortError') setReplayError(error.message); }).finally(() => { if (!controller.signal.aborted) setReplayLoading(false); });
    return () => controller.abort();
  }, [view, symbol, horizon]);

  function navigate(next: View) { setView(next); setMenu(false); setSearch(''); }
  function toggleFavorite(next: Symbol) {
    const items = favorites.includes(next) ? favorites.filter(item => item !== next) : [...favorites, next];
    setFavorites(items);
    try { localStorage.setItem('jev-watchlist', JSON.stringify(items)); } catch { setToast('Watchlist updated for this session. Browser storage is unavailable.'); }
  }
  async function runForecast() {
    if (!market || running || detailLoading) return;
    setRunning(true); setError('');
    try {
      const result = await api<Forecast>('/api/forecasts', { method: 'POST', body: JSON.stringify({ symbol, horizon, engine: canJev ? 'jev' : 'baseline' }) });
      setForecasts(items => [result, ...items.filter(item => item.id !== result.id)]);
      setToast(`${result.symbol} ${horizonLabel(result.horizon)} forecast saved to your journal.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Forecast failed.'); }
    finally { setRunning(false); }
  }

  async function sendChat(message: string): Promise<boolean> {
    if (chatBusy) return false;
    const history = chatMessages.filter(item => item.role === 'user').slice(-4).map(item => item.text);
    setChatMessages(items => [...items, { id: crypto.randomUUID(), role: 'user', text: message }]);
    setChatBusy(true); setChatError('');
    try {
      const result = await api<MarketChatResult>('/api/chat', { method: 'POST', body: JSON.stringify({ message, horizon, history }) });
      setChatMessages(items => [...items, { id: result.id, role: 'assistant', text: result.reply, result }]);
      return true;
    } catch (error) { setChatError(error instanceof Error ? error.message : 'Market scan failed.'); return false; }
    finally { setChatBusy(false); }
  }

  const navItems: { id: View; label: string; icon: typeof Activity; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'chat', label: 'AI market chat', icon: MessageSquareText },
    { id: 'journal', label: 'Forecast journal', icon: Layers3, count: forecasts.length },
    { id: 'replay', label: 'Baseline replay', icon: ChartNoAxesCombined },
  ];
  return <div className="app-shell">
    {menu && <button className="sidebar-overlay" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <aside className={`sidebar ${menu ? 'open' : ''}`}>
      <button className="brand" onClick={() => navigate('overview')} aria-label="JEV Terminal home"><Logo /><span>jev<span className="brand-period">.</span></span><span className="terminal-label">TERMINAL</span></button>
      <div className="workspace-label">INTELLIGENCE <span>01</span></div>
      <nav aria-label="Main navigation">{navItems.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={17} /><span>{item.label}</span>{item.count !== undefined && <span className="nav-count">{item.count}</span>}</button>)}</nav>
      <div className="workspace-label second">WORKSPACE</div>
      <nav aria-label="Workspace navigation"><button className={`nav-item ${view === 'watchlist' ? 'active' : ''}`} onClick={() => navigate('watchlist')}><Star size={17} /><span>Watchlist</span><span className="nav-count">{favorites.length}</span></button><button className={`nav-item ${view === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><SlidersHorizontal size={17} /><span>Model & data</span></button><button className={`nav-item ${view === 'methodology' ? 'active' : ''}`} onClick={() => navigate('methodology')}><BookOpen size={17} /><span>Methodology</span></button></nav>
      <div className="sidebar-bottom">
        <div className="engine-mini"><div className="engine-mini-top"><span className="engine-icon"><Cpu size={17} /></span><span>Intelligence, on demand</span></div><p>Structured decisions.<br />A more informed perspective.</p><button onClick={() => navigate('settings')}>Explore JEV 1.13 <ArrowUpRight size={14} /></button><span className="engine-decoration" aria-hidden="true">✳</span></div>
        <button className="help-link" onClick={() => navigate('methodology')}><CircleHelp size={16} />How it works<ArrowUpRight size={14} /></button>
        <button className="profile" onClick={() => navigate('settings')}><span className="avatar">R</span><span><strong>Research workspace</strong><small>Local session</small></span><Settings2 size={15} /></button>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu size={19} /></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><span>{titles[view]}</span></div><div className="topbar-right"><span className="connection"><StatusDot warning={Boolean(health?.demo || error || !data || markets.some(item => item.stale))} />{health?.demo ? 'Demo environment' : data && !error ? 'Market feed connected' : loading ? 'Connecting' : 'Connection interrupted'}</span><span className="topbar-divider" /><button className="icon-button" aria-label="Open forecast journal" onClick={() => navigate('journal')}><Bell size={17} />{forecasts.some(item => item.outcome) && <span className="notification-dot" />}</button><button className="topbar-avatar" aria-label="Workspace settings" onClick={() => navigate('settings')}>R</button></div></header>
      <main>
        <section className="page-heading"><div><div className="eyebrow"><span />YOUR MARKET EDGE</div><h1>{titles[view]}</h1><p>{subtitles[view]}</p></div><div className="heading-actions"><button className={`button secondary refresh-button ${refreshing ? 'is-refreshing' : ''}`} onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} /><span>Refresh data</span></button>{view !== 'chat' && <button className="button primary" onClick={() => void runForecast()} disabled={running || !market || market.stale || Boolean(error)}>{running ? <LoaderCircle size={16} className="spin" /> : <ScanLine size={16} />}{running ? 'Analyzing market…' : canJev ? 'Run JEV forecast' : 'Run baseline'}{!running && <span className="button-arrow">↗</span>}</button>}</div></section>
        {health?.demo && <div className="notice demo-notice"><Radio size={16} /><span><b>Demo environment.</b> Prices and outcomes are synthetic. JEV is disabled.</span><button onClick={() => navigate('settings')}>Connect live data <ArrowRight size={13} /></button></div>}
        {error && <div className="notice error-notice" role="alert"><Activity size={17} /><span>{error}</span><button onClick={() => void refresh()}>Retry <RefreshCw size={13} /></button></div>}
        {marketError && <div className="notice error-notice" role="alert"><Activity size={16} /><span>{symbol}: {marketError}</span></div>}
        {data?.errors.length ? <div className="notice"><Radio size={16} /><span>Some feeds are unavailable: {data.errors.slice(0, 20).map(item => item.symbol).join(', ') + (data.errors.length > 20 ? ` and ${data.errors.length - 20} more` : '')}. Available markets are shown below.</span></div> : null}
        {!health?.configured && health && !health.demo && <div className="notice"><Cpu size={16} /><span>Baseline mode is ready. Connect OpenRouter to enable JEV’s direction probabilities.</span><button onClick={() => navigate('settings')}>Set up JEV <ArrowRight size={13} /></button></div>}

        {view === 'chat' && <MarketChat messages={chatMessages} setMessages={messages => { setChatMessages(messages); if (!messages.length) setChatError(''); }} send={sendChat} busy={chatBusy} error={chatError} horizon={horizon} setHorizon={setHorizon} markets={markets} assetCount={assets.length} health={health} analyze={next => { setSymbol(next); navigate('overview'); }} />}
        {view === 'overview' && <>
          <Summary markets={markets} forecasts={forecasts} loading={loading} />
          <div className="analysis-grid">
            <section className="panel chart-panel"><div className="chart-heading"><div className="asset-heading"><Coin symbol={symbol} /><div><div className="pair-select"><AssetPicker assets={assets} value={symbol} onChange={setSymbol} /><span>{symbol}/USD</span></div><span className="muted tiny">Kraken spot · 1h observations</span></div></div><div className="chart-switch"><button aria-label="Line chart" aria-pressed={chartKind === 'line'} className={chartKind === 'line' ? 'selected' : ''} onClick={() => setChartKind('line')}><TrendingUp size={17} /></button><button aria-label="Candlestick chart" aria-pressed={chartKind === 'candles'} className={chartKind === 'candles' ? 'selected' : ''} onClick={() => setChartKind('candles')}><ChartCandlestick size={17} /></button></div></div>
              <div className="price-row"><div className="main-price">{market ? money(market.price) : '—'}{market && <Change value={market.change24h} />}<span className="tiny muted">24h</span></div><div className="segmented">{[{ value: 24, label: '24H' }, { value: 168, label: '7D' }, { value: 720, label: '30D' }].map(item => <button key={item.value} className={range === item.value ? 'selected' : ''} onClick={() => setRange(item.value)}>{item.label}</button>)}</div></div>
              {market ? <Chart candles={market.candles} forecast={latest} range={range} kind={chartKind} /> : <div className={`chart-empty ${detailLoading ? 'skeleton' : ''}`}>{detailLoading ? 'Connecting to market data…' : 'This market is unavailable. Refresh or choose another asset.'}</div>}
              <div className="chart-footer"><span><span className="legend-dot price" />Hourly close</span>{latest && <span><span className="legend-dot forecast" />Volatility scenario</span>}<span className="chart-timestamp">{market ? `${market.stale ? 'STALE · ' : ''}Updated ${shortTime(market.fetchedAt)}` : 'Awaiting data'}<StatusDot warning={!market || market.stale} /></span></div>
            </section>
            <ForecastPanel forecast={latest} market={market} horizon={horizon} setHorizon={setHorizon} running={running} runForecast={runForecast} canJev={canJev} navigate={navigate} />
          </div>
          <div className="lower-grid"><MarketTable markets={markets} favorites={favorites} toggleFavorite={toggleFavorite} search={search} setSearch={setSearch} searchRef={searchRef} symbol={symbol} select={setSymbol} loading={loading} /><Signals market={market} /></div>
          <div className="insight-banner"><span className="insight-icon"><Waves size={21} /></span><div><strong>Conviction is useful. Context is essential.</strong><p>Explore the evidence behind a signal and compare it with a simple historical baseline.</p></div><button onClick={() => navigate('replay')}>Explore baseline replay <ArrowUpRight size={16} /></button></div>
        </>}
        {view === 'watchlist' && <><MarketTable markets={markets.filter(item => favorites.includes(item.symbol))} favorites={favorites} toggleFavorite={toggleFavorite} search={search} setSearch={setSearch} searchRef={searchRef} symbol={symbol} select={item => { setSymbol(item); navigate('overview'); }} loading={loading} full /><div className="add-assets panel"><div><h3>Make it your market.</h3><p className="muted">Browse {assets.length} Kraken cryptocurrencies, or follow them all.</p></div><div className="asset-chips"><button onClick={() => { const all = assets.map(asset => asset.symbol); setFavorites(all); try { localStorage.setItem('jev-watchlist', JSON.stringify(all)); } catch {} }}>Select all {assets.length} assets <Star size={13} /></button><button onClick={() => navigate('overview')}>Browse all markets <ArrowRight size={14} /></button></div></div></>}
        {view === 'journal' && <Journal forecasts={forecasts} onSelect={setInspected} />}
        {view === 'replay' && <ReplayView assets={assets} replay={replay} loading={replayLoading} error={replayError} symbol={symbol} setSymbol={setSymbol} horizon={horizon} setHorizon={setHorizon} />}
        {view === 'settings' && <Settings health={health} markets={markets} />}
        {view === 'methodology' && <Methodology />}
        <footer className="page-footer"><span><Logo small />Built for perspective, not certainty.</span><span>Experimental research · No trade execution <span className="footer-dot">·</span> <button onClick={() => navigate('methodology')}>Methodology <ArrowUpRight size={11} /></button></span></footer>
      </main>
    </div>
    {inspected && <ForecastDetail forecast={inspected} close={() => setInspected(null)} />}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>;
}

function Summary({ markets, forecasts, loading }: { markets: MarketQuote[]; forecasts: Forecast[]; loading: boolean }) {
  const bitcoin = markets.find(item => item.symbol === 'BTC');
  const volume = markets.reduce((sum, item) => sum + item.volume24h, 0);
  const gainers = markets.filter(item => item.changeToday > 0).length;
  return <div className="summary-grid">
    <div className="summary-card"><div className="stat-label">Bitcoin price<Coin small symbol="BTC" /></div><div className="stat-value">{bitcoin ? money(bitcoin.price) : '—'}</div><div className="stat-bottom">{bitcoin ? <Change value={bitcoin.changeToday} /> : <span className="muted">{loading ? 'Loading…' : 'Unavailable'}</span>}<span className="muted">since 00:00 UTC</span></div></div>
    <div className="summary-card"><div className="stat-label">Tracked trading volume<ChartNoAxesCombined size={16} /></div><div className="stat-value">{markets.length ? money(volume, true) : '—'}<span>24h</span></div><div className="stat-bottom"><span className="subtle-dot" /><span className="muted">{markets.length} USD pairs</span><span className="stat-source">Kraken spot</span></div></div>
    <div className="summary-card"><div className="stat-label">Market breadth<Activity size={16} /></div><div className="stat-value">{markets.length ? `${Math.round(gainers / markets.length * 100)}%` : '—'}<span>up today</span></div><div className="stat-bottom"><div className="breadth-bars">{Array.from({ length: 12 }, (_, i) => <span key={i} className={i < (markets.length ? gainers / markets.length * 12 : 0) ? 'up' : 'down'} />)}</div><span className="muted">{gainers} of {markets.length} assets</span></div></div>
    <div className="summary-card"><div className="stat-label">Forecast journal<Layers3 size={16} /></div><div className="stat-value">{forecasts.length.toString().padStart(2, '0')}<span>recorded</span></div><div className="stat-bottom"><span className="mini-pill"><Clock3 size={11} />{forecasts.filter(item => !item.outcome).length} unresolved</span><span className="muted">{forecasts.filter(item => item.outcome).length} scored</span></div></div>
  </div>;
}

function ForecastPanel({ forecast, market, horizon, setHorizon, running, runForecast, canJev, navigate }: { forecast?: Forecast; market?: Market; horizon: Horizon; setHorizon: (value: Horizon) => void; running: boolean; runForecast: () => Promise<void>; canJev: boolean; navigate: (view: View) => void }) {
  const probability = forecast?.probabilities?.[forecast.direction];
  return <section className={`panel forecast-panel ${running ? 'analyzing' : ''}`}><div className="panel-title"><div><span className="lime-icon"><Sparkles size={16} /></span><h2>Market forecast</h2></div><span className="model-badge">{forecast?.engine === 'baseline' ? 'BASELINE' : 'JEV 1.13'}</span></div>
    <div className="horizon-control"><label htmlFor="forecast-horizon">Forecast horizon</label><select id="forecast-horizon" value={horizon} onChange={event => setHorizon(Number(event.target.value) as Horizon)}>{HORIZONS.map(value => <option key={value} value={value}>Next {horizonLabel(value)}</option>)}</select></div>
    <div className={`prediction-outlook ${forecast?.direction ?? 'ready'}`}><span className="outlook-icon">{running ? <ScanLine size={23} className="pulse" /> : forecast?.direction === 'bullish' ? <TrendingUp size={24} /> : forecast?.direction === 'bearish' ? <ArrowDownLeft size={25} /> : forecast ? <ArrowRight size={24} /> : <ScanLine size={25} />}</span><div><span className="outlook-label">{running ? 'READING THE SIGNALS' : forecast ? `${forecast.engine === 'jev' ? 'JEV' : 'BASELINE'} OUTLOOK` : 'NEXT MOVE, IN FOCUS'}</span><h3>{running ? 'Analyzing…' : forecast ? `${forecast.direction.charAt(0).toUpperCase() + forecast.direction.slice(1)} bias` : 'Ready when you are'}</h3></div>{probability !== undefined && <div className="outlook-confidence">{Math.round(probability * 100)}<span>%</span></div>}</div>
    <div className="probability-list">{directions.map(direction => <div className="probability-row" key={direction}><span>{direction.charAt(0).toUpperCase() + direction.slice(1)}</span><div className="probability-track"><span className={direction} style={{ width: forecast?.probabilities ? `${forecast.probabilities[direction] * 100}%` : '0%' }} /></div><b>{forecast?.probabilities ? `${Math.round(forecast.probabilities[direction] * 100)}%` : '—'}</b></div>)}</div>
    <p className="probability-note">{forecast?.probabilities ? 'Model probabilities · Not validated as market odds' : forecast ? 'The technical baseline does not assign probabilities.' : 'Run a forecast to reveal the model’s direction probabilities.'}</p>
    <div className="forecast-range"><div><span>Volatility scenario</span><button className="inline-info" aria-label="Explain the volatility scenario" onClick={() => navigate('methodology')}><CircleHelp size={12} /></button></div><strong>{forecast ? `${money(forecast.range.low)} — ${money(forecast.range.high)}` : 'Awaiting forecast'}</strong><small>{forecast ? `±1.65σ · Reference ${money(forecast.referencePrice)}` : 'Historical volatility, scaled to your horizon'}</small></div>
    <button className="forecast-run" onClick={() => void runForecast()} disabled={running || !market || market.stale}>{running ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}{running ? 'Evaluating observations' : forecast ? 'Refresh this forecast' : canJev ? 'Generate JEV forecast' : 'Generate baseline forecast'}<ArrowRight size={14} /></button>
    <div className="forecast-meta"><span><ShieldCheck size={12} />{forecast ? 'Saved before outcome' : 'Tracked from the first prediction'}</span><span>{forecast?.engine === 'jev' ? `${forecast.latencyMs} ms` : forecast ? 'Technical rules' : 'TypeSafe AI'}</span></div>
    {forecast && <div className="forecast-asof">As of {timeLabel(forecast.referenceTime)} · Due {timeLabel(forecast.targetTime)}</div>}
  </section>;
}

function MarketTable({ markets, favorites, toggleFavorite, search, setSearch, searchRef, symbol, select, loading, full = false }: { markets: MarketQuote[]; favorites: Symbol[]; toggleFavorite: (symbol: Symbol) => void; search: string; setSearch: (value: string) => void; searchRef: React.RefObject<HTMLInputElement | null>; symbol: Symbol; select: (value: Symbol) => void; loading: boolean; full?: boolean }) {
  const filtered = markets.filter(item => `${item.symbol} ${item.name}`.toLowerCase().includes(search.toLowerCase()));
  const [sort, setSort] = useState(false);
  const sorted = sort ? [...filtered].sort((a, b) => b.changeToday - a.changeToday) : filtered;
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [search, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / 10));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * 10, current * 10 + 10);
  return <section className={`panel markets-panel ${full ? 'full' : ''}`}><div className="panel-title"><div><h2>{full ? 'Watchlist' : 'Market watch'}</h2><span className="count-label">{markets.length}</span></div><div className="market-tools"><label className="search-input"><Search size={14} /><input ref={searchRef} placeholder="Find an asset…" aria-label="Search assets" value={search} onChange={event => setSearch(event.target.value)} /><kbd>⌘ K</kbd></label><button className={`icon-button filter-button ${sort ? 'selected' : ''}`} aria-label="Sort by performance since midnight UTC" aria-pressed={sort} onClick={() => setSort(!sort)}><ListFilter size={16} /></button></div></div>
    <div className="table-scroll"><table className="market-table"><thead><tr><th className="star-cell" /><th>Asset</th><th className="right">Price</th><th className="right" title="Change since midnight UTC">Today (UTC)</th><th className="right volume-cell">Volume (24h)</th><th className="right sparkline-cell">24h range</th><th /></tr></thead><tbody>{visible.map(item => <tr key={item.symbol} className={symbol === item.symbol ? 'active' : ''}><td className="star-cell"><button className={`star-button ${favorites.includes(item.symbol) ? 'starred' : ''}`} aria-label={`${favorites.includes(item.symbol) ? 'Remove' : 'Add'} ${item.symbol} ${favorites.includes(item.symbol) ? 'from' : 'to'} watchlist`} onClick={() => toggleFavorite(item.symbol)}><Star size={14} fill={favorites.includes(item.symbol) ? 'currentColor' : 'none'} /></button></td><td><button className="table-asset" onClick={() => select(item.symbol)}><Coin small symbol={item.symbol} /><span><strong>{item.name}</strong><small>{item.symbol} <span>/ USD</span>{item.stale && <b className="stale-label">STALE</b>}</small></span></button></td><td className="right mono">{money(item.price)}</td><td className="right"><Change value={item.changeToday} /></td><td className="right volume-cell muted mono">{money(item.volume24h, true)}</td><td className="right sparkline-cell"><span className="day-range" title={`${money(item.low24h)} – ${money(item.high24h)}`}><i style={{ left: `${Math.max(0, Math.min(100, (item.price - item.low24h) / (item.high24h - item.low24h || 1) * 100))}%` }} /></span></td><td className="row-action"><button className="icon-button" aria-label={`View ${item.symbol} forecast`} onClick={() => select(item.symbol)}><ArrowUpRight size={15} /></button></td></tr>)}</tbody></table>{!sorted.length && <div className="table-empty">{loading ? <><LoaderCircle size={20} className="spin" />Loading market observations…</> : search ? 'No assets match your search.' : full ? 'Star an asset below to start your watchlist.' : 'Market data is currently unavailable.'}</div>}</div><div className="table-footer"><span><StatusDot warning={markets.some(item => item.stale)} />{markets.some(item => item.source === 'demo') ? 'Synthetic demo data' : 'Public market data'}<span className="footer-dot">·</span> Refreshes every 60s</span><span className="pagination"><button aria-label="Previous market page" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>{current + 1} / {pages}<button aria-label="Next market page" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>›</button><span>{sorted.length} assets</span></span></div></section>;
}

function Signals({ market }: { market?: Market }) {
  const features = market?.indicators;
  const trend = features ? features.ema20 >= features.ema50 : false;
  return <section className="panel signals-panel"><div className="panel-title"><div><h2>Signal breakdown</h2></div><span className="subtle-tag">{market?.symbol ?? 'BTC'}</span></div><p className="signals-intro">The observations behind the outlook.</p>
    <div className="signal"><div className="signal-name"><Activity size={15} /><span>RSI <small>(14)</small></span><strong>{features ? features.rsi.toFixed(1) : '—'}</strong></div><div className="rsi-meter"><span style={{ left: `${features?.rsi ?? 50}%` }} /></div><div className="meter-labels"><span>Oversold</span><span>Overbought</span></div></div>
    <div className="signal"><div className="signal-name"><TrendingUp size={15} /><span>Trend <small>EMA 20 / 50</small></span>{features && <span className={`signal-tag ${trend ? 'positive' : 'negative'}`}>{trend ? 'Bullish' : 'Bearish'}</span>}</div><p>{features ? `Fast average is ${Math.abs(features.ema20 / features.ema50 * 100 - 100).toFixed(2)}% ${trend ? 'above' : 'below'} the slow average.` : 'Waiting for completed candles.'}</p></div>
    <div className="signal"><div className="signal-name"><ChartNoAxesCombined size={15} /><span>Volume <small>24h ratio</small></span><strong>{features ? `${features.volumeRatio.toFixed(2)}×` : '—'}</strong></div><div className="volume-meter">{Array.from({ length: 25 }, (_, index) => <span key={index} className={index < (features?.volumeRatio ?? 0) / 2 * 25 ? 'filled' : ''} />)}</div><p>Compared with the previous 24 hours</p></div>
    <div className="signal level-signal"><div><span>7D support</span><strong>{features ? money(features.support) : '—'}</strong></div><div><span>7D resistance</span><strong>{features ? money(features.resistance) : '—'}</strong></div></div>
    <div className="signals-footer"><CircleHelp size={12} />Technical observations, not model explanations.</div>
  </section>;
}

function Journal({ forecasts, onSelect }: { forecasts: Forecast[]; onSelect: (forecast: Forecast) => void }) {
  const [filter, setFilter] = useState('all');
  const jev = forecasts.filter(item => item.engine === 'jev' && item.dataSource === 'kraken' && item.outcome);
  const accuracy = jev.length ? jev.filter(item => item.outcome!.correct).length / jev.length : null;
  const brier = jev.length ? jev.reduce((sum, item) => sum + (item.outcome!.brier ?? 0), 0) / jev.length : null;
  const items = forecasts.filter(item => filter === 'all' || (filter === 'pending' ? !item.outcome : item.outcome));
  return <><div className="journal-stats"><Metric label="JEV outcomes scored" value={String(jev.length)} detail="Live observations only" /><Metric label="Observed directional accuracy" value={accuracy === null ? '—' : `${(accuracy * 100).toFixed(1)}%`} detail={jev.length < 30 ? 'Too few outcomes for a reliable estimate' : 'Overlapping forecasts are not independent'} /><Metric label="Multiclass Brier score" value={brier === null ? '—' : brier.toFixed(3)} detail="0 is best · 2 is worst" /></div><section className="panel journal-panel"><div className="panel-title"><div><h2>Prediction history</h2><span className="count-label">{forecasts.length}</span></div><div className="journal-controls"><select aria-label="Filter forecast history" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All forecasts</option><option value="pending">Unresolved</option><option value="scored">Scored</option></select><button className="button secondary small-button" disabled={!forecasts.length} onClick={() => exportJson(forecasts, 'jev-forecast-journal.json')}><Download size={14} />Export</button></div></div><div className="table-scroll"><table className="journal-table"><thead><tr><th>Market / horizon</th><th>Engine</th><th>Forecast</th><th>Reference close</th><th>Outcome due</th><th>Result</th><th /></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><div className="journal-asset"><Coin symbol={item.symbol} small /><span><strong>{item.symbol}/USD</strong><small>{horizonLabel(item.horizon)}</small></span></div></td><td><span className="subtle-tag">{item.engine === 'jev' ? 'JEV 1.13' : item.dataSource === 'demo' ? 'DEMO BASELINE' : 'BASELINE'}</span></td><td><DirectionBadge direction={item.direction} /></td><td className="mono">{money(item.referencePrice)}</td><td className="muted">{timeLabel(item.targetTime)}</td><td>{item.outcome ? <span className={item.outcome.correct ? 'positive result' : 'negative result'}>{item.outcome.correct ? <Check size={14} /> : <X size={14} />}{item.outcome.correct ? 'Correct' : 'Missed'}</span> : <span className="muted result"><Clock3 size={13} />{item.targetTime > Date.now() ? 'Pending' : 'Awaiting data'}</span>}</td><td><button className="icon-button" aria-label={`Inspect ${item.symbol} forecast`} onClick={() => onSelect(item)}><ArrowUpRight size={15} /></button></td></tr>)}</tbody></table></div>{!items.length && <div className="large-empty"><Layers3 size={32} /><h3>{forecasts.length ? 'No forecasts in this view' : 'Your first forecast starts here.'}</h3><p>Run a forecast from the overview. Its outcome is scored after the selected horizon closes.</p></div>}<div className="journal-note"><ShieldCheck size={14} /><p>Forecasts are saved locally before their outcomes. Repeated requests for the same asset, horizon, engine, and hourly close reuse the saved prediction. Baseline and synthetic results are excluded from JEV metrics.</p></div></section></>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="summary-card metric"><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong><span className="muted tiny">{detail}</span></div>; }

function ReplayView({ assets, replay, loading, error, symbol, setSymbol, horizon, setHorizon }: { assets: Asset[]; replay: Replay | null; loading: boolean; error: string; symbol: Symbol; setSymbol: (symbol: Symbol) => void; horizon: Horizon; setHorizon: (horizon: Horizon) => void }) {
  return <><div className="notice"><Gauge size={16} /><span>This replay evaluates fixed technical rules. It does not measure JEV’s historical performance.</span></div><section className="panel replay-panel"><div className="panel-title"><div><h2>Walk-forward evaluation</h2><span className="subtle-tag">TECHNICAL BASELINE V1</span></div><div className="replay-selects"><AssetPicker assets={assets} value={symbol} onChange={setSymbol} /><select aria-label="Replay horizon" value={horizon} onChange={event => setHorizon(Number(event.target.value) as Horizon)}>{HORIZONS.map(value => <option key={value} value={value}>{horizonLabel(value)}</option>)}</select></div></div>{loading ? <div className="large-empty"><LoaderCircle className="spin" size={28} /><p>Replaying completed observations…</p></div> : error ? <div className="large-empty negative" role="alert">{error}</div> : replay && <><div className="replay-metrics"><Metric label="Direction matches" value={replay.accuracy === null ? '—' : `${(replay.accuracy * 100).toFixed(1)}%`} detail={`${replay.sampleCount} non-overlapping windows`} /><Metric label="Always-neutral benchmark" value={replay.neutralAccuracy === null ? '—' : `${(replay.neutralAccuracy * 100).toFixed(1)}%`} detail="Predicting no material movement" /><Metric label="Majority-class benchmark" value={replay.majorityAccuracy === null ? '—' : `${(replay.majorityAccuracy * 100).toFixed(1)}%`} detail="Hindsight comparison, not a strategy" /></div><div className="replay-timeline"><div><h3>Every window, in order</h3><span><i className="up-block" />Correct<i className="down-block" />Missed</span></div><div className="outcome-grid">{replay.points.map(point => <span tabIndex={0} key={point.time} className={point.correct ? 'hit' : 'miss'} title={`${timeLabel(point.time)}: predicted ${point.direction}, actual ${point.actual}, return ${percent(point.change * 100)}`}><span className="outcome-tooltip">{timeLabel(point.time)}<br />{point.direction} → {point.actual}<br />{percent(point.change * 100)}</span></span>)}</div><div className="timeline-dates"><span>{replay.from ? timeLabel(replay.from) : '—'}</span><span>{replay.to ? timeLabel(replay.to) : '—'}</span></div></div><div className="replay-explainer"><ShieldCheck size={21} /><div><h3>Only information available at the time.</h3><p>Each window uses at least 200 prior completed hourly candles. The next {horizon} candles are held out, and windows do not overlap. The replay covers Kraken’s available history of roughly 30 days; {replay.sampleCount < 30 ? 'this sample is too small to establish predictive skill.' : 'results from this short period do not establish future performance.'} {replay.source === 'demo' && 'This run uses synthetic data.'}</p><p>No fees, execution, position sizing, or returns from a trading strategy are simulated.</p></div></div><button className="button secondary replay-export" onClick={() => exportJson(replay, `baseline-${symbol}-${horizon}h.json`)}><Download size={15} />Export replay observations</button></>}</section></>;
}

function Settings({ health, markets }: { health: Health | null; markets: MarketQuote[] }) {
  return <div className="settings-grid"><section className="panel settings-card"><div className="settings-icon"><Cpu size={25} /></div><div className="settings-card-heading"><h2>TypeSafe JEV 1.13</h2><span className="mini-pill"><StatusDot warning={!health?.configured} />{health?.configured ? 'Key configured' : 'Setup required'}</span></div><p>A System One model that returns a typed market direction and a probability for each possible outcome.</p><dl><div><dt>Provider</dt><dd>OpenRouter → TypeSafe</dd></div><div><dt>Model</dt><dd className="mono">typesafe/jev-1.13</dd></div><div><dt>Interface</dt><dd>System One · Choice primitive</dd></div><div><dt>Execution</dt><dd>On demand · Server only</dd></div></dl><div className="setup-box"><h3>{health?.configured ? 'Your connection is ready' : 'Connect your OpenRouter account'}</h3><p>{health?.configured ? 'Your server has an API key. Run a forecast to test the model connection. The key is never returned to the browser.' : 'Copy .env.example to .env in the project, add your key, then restart the server.'}</p><code>OPENROUTER_API_KEY=your_key_here</code><p className="tiny">Keys stay in the server environment. Requests for an unchanged hourly observation reuse the saved forecast.</p></div><a className="text-link" href="https://openrouter.ai/typesafe/jev-1.13" target="_blank" rel="noreferrer">Model details on OpenRouter <ExternalLink size={14} /></a></section>
    <section className="panel settings-card"><div className="settings-icon blue"><Radio size={25} /></div><div className="settings-card-heading"><h2>Kraken market feed</h2><span className="mini-pill"><StatusDot warning={Boolean(health?.demo || !markets.length || markets.some(item => item.stale))} />{health?.demo ? 'Demo mode' : markets.length ? 'Connected' : 'Awaiting data'}</span></div><p>Public spot-market observations. No exchange account, trading credentials, or wallet connection required.</p><dl><div><dt>Markets</dt><dd>{markets.length} active crypto/USD markets</dd></div><div><dt>Quote currency</dt><dd>US dollar (USD)</dd></div><div><dt>Analysis interval</dt><dd>Completed 1-hour candles</dd></div><div><dt>History / refresh</dt><dd>Up to 720 hours / every 60 seconds</dd></div></dl><div className="setup-box"><h3>{health?.demo ? 'Switch to real observations' : 'Try the offline demo'}</h3><p>{health?.demo ? 'Set this value in .env, then restart the server. Live forecasts use a separate journal.' : 'For an offline walkthrough, set this value in .env and restart. Synthetic prices are clearly marked throughout.'}</p><code>DEMO_MODE={health?.demo ? 'false' : 'true'}</code><p className="tiny">A failed data feed never silently switches to synthetic prices. Stale observations cannot generate new forecasts.</p></div><a className="text-link" href="https://docs.kraken.com/api-reference/market-data/get-ohlc-data" target="_blank" rel="noreferrer">Market data documentation <ExternalLink size={14} /></a></section>
    <section className="panel storage-card"><ShieldCheck size={23} /><div><h3>Local by design</h3><p>Forecasts are saved in <code>data/forecasts.json</code> (up to 2,000 records). Demo forecasts use a separate file. The terminal listens only on your computer. Keep a backup of the journal for long-term evaluation; outcome scoring needs the exact target candle within the exchange’s available history.</p></div></section></div>;
}

function Methodology() {
  const items = [
    ['01', 'Observe the market', 'Kraken provides hourly open, high, low, close, and volume observations. The latest unfinished candle supplies the displayed spot quote but is excluded from all indicators, model inputs, replay windows, and outcome scoring. Volume is an estimate in USD using hourly volume-weighted prices.'],
    ['02', 'Ask a specific question', 'JEV sees the latest 72 completed candles and indicators derived from at least 200 prior observations. It classifies the future close as bullish, neutral, or bearish, relative to the last completed close and your selected 4-hour, 24-hour, or 7-day horizon. Forecast horizons start at that reference close, not the instant the button is pressed.'],
    ['03', 'Make uncertainty visible', 'The neutral band is the greater of 0.25% and 0.35 × hourly log-return volatility × √horizon. JEV provides probabilities for these mutually exclusive outcomes. Those probabilities have not been calibrated or validated for crypto forecasting. The separate price envelope is reference price × exp(±1.645 × volatility × √horizon). It assumes stable volatility and independent normal log returns; it is an illustrative scenario, not an empirically validated coverage guarantee.'],
    ['04', 'Keep the baseline honest', 'The fixed baseline combines the normalized EMA 20/50 spread (50%), 24-hour momentum (35%), and centered Wilder RSI (15%). Signals are clipped to ±2, scaled by volatility and √horizon, and classified against the same neutral band. The walk-forward replay uses only past observations and non-overlapping test windows. It does not call JEV and is never presented as JEV’s track record.'],
    ['05', 'Evaluate after the fact', 'A forecast is saved with its timestamp, reference price, neutral band, model version, probabilities, and target time. On a later journal refresh, the exact completed target candle resolves it. Multiclass Brier score is the sum of squared probability errors (0–2). Unresolved or missing outcomes are not counted as successes. Aggregated forecasts can overlap and are not independent statistical samples.'],
    ['06', 'Know the limits', 'This is an experimental research tool, not a demonstrated profitable strategy. Crypto prices react to information absent from candle data. Short histories, changing regimes, correlated outcomes, and model overconfidence can all undermine predictions. The app places no trades. No profit, win rate, or loss protection is promised.'],
  ];
  return <section className="panel methodology-panel"><div className="methodology-intro"><div className="settings-icon"><BookOpen size={25} /></div><h2>A prediction should be inspectable.</h2><p>The complete path from market observation to measured outcome.</p></div>{items.map(([number, title, body]) => <article className="methodology-step" key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></article>)}<div className="methodology-sources"><a href="https://docs.typesafe.ai/concepts/system-one" target="_blank" rel="noreferrer">TypeSafe System One <ExternalLink size={13} /></a><a href="https://openrouter.ai/docs/guides/community/typesafe-sdk" target="_blank" rel="noreferrer">OpenRouter integration <ExternalLink size={13} /></a><a href="https://docs.kraken.com/api-reference/market-data/get-ohlc-data" target="_blank" rel="noreferrer">Kraken OHLC <ExternalLink size={13} /></a></div></section>;
}

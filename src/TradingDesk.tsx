import { useEffect, useRef, useState } from 'react';
import { Download, Pause, Play, RefreshCw, Unplug, Wallet } from 'lucide-react';
import { DEFAULT_PAPER_CONFIG, type PaperConfig, type PaperStatus } from '../shared/paper-trading';
import { HORIZONS, type Asset, type Horizon } from '../shared/types';
import { discoverWallets, nativeBalance, WalletConnection, type WalletOption, type WalletState } from './wallet';
import { api, exportJson, horizonLabel, money, timeLabel } from './utils';
import './trading.css';

function WalletPanel() {
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [selected, setSelected] = useState('');
  const [wallet, setWallet] = useState<WalletState>({ status: 'disconnected', name: null, account: null, chainId: null, balance: null, error: null, refreshing: false });
  const connection = useRef<WalletConnection | null>(null);
  useEffect(() => {
    const client = new WalletConnection(setWallet);
    connection.current = client;
    const stopDiscovery = discoverWallets(window, setWallets);
    return () => { stopDiscovery(); client.disconnect(); connection.current = null; };
  }, []);
  const selectedWallet = wallets.find(item => item.id === selected) ?? wallets[0];
  const balance = wallet.chainId && wallet.balance ? nativeBalance(wallet.chainId, wallet.balance) : null;
  return <section className="panel wallet-panel">
    <div className="panel-title"><div><Wallet size={17} /><h2>EVM wallet</h2></div><span className="mini-pill">Read only</span></div>
    <div className="trading-panel-body">
      <p>Connect MetaMask or Rabby to read your public address, network, and native balance. Your wallet remains separate from the virtual trading account.</p>
      {wallet.status === 'disconnected' ? <div className="wallet-connect">
        <label>Wallet extension<select value={selectedWallet?.id ?? ''} onChange={event => setSelected(event.target.value)} disabled={!wallets.length}>
          {!wallets.length && <option value="">No wallet detected</option>}
          {wallets.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>
        <button className="button primary" disabled={!selectedWallet} onClick={() => selectedWallet && void connection.current?.connect(selectedWallet)}><Wallet size={15} />Connect wallet</button>
      </div> : <>
        <div className="wallet-details" aria-live="polite">
          <div><span>Wallet</span><strong>{wallet.name}</strong></div>
          <div><span>Address</span><code>{wallet.account ?? (wallet.status === 'connecting' ? 'Approve the connection in your extension…' : 'Reading wallet…')}</code></div>
          <div><span>Network</span><strong>{balance?.network ?? '—'}</strong></div>
          <div><span>Native balance</span><strong className="mono">{balance ? `${balance.amount} ${balance.unit}` : '—'}</strong></div>
        </div>
        <div className="trading-actions"><button className="button secondary" disabled={wallet.refreshing || wallet.status === 'connecting'} onClick={() => void connection.current?.refresh()}><RefreshCw size={14} />Refresh balance</button><button className="button secondary" onClick={() => connection.current?.disconnect()}><Unplug size={14} />Disconnect locally</button></div>
      </>}
      {!wallets.length && <p className="trading-note">Open this app in a browser with the MetaMask or Rabby extension enabled, then reload. The in-app browser may not have extensions.</p>}
      {wallet.error && <p className="trading-error" role="alert">{wallet.error}</p>}
      <p className="trading-note">No seed phrase, private key, token approvals, signatures, or transaction requests. Local disconnect clears this app’s connection; revoke site access in the extension if needed. ERC-20 balances are not loaded.</p>
    </div>
  </section>;
}

export default function TradingDesk({ active, assets }: { active: boolean; assets: Asset[] }) {
  const [status, setStatus] = useState<PaperStatus | null>(null);
  const [config, setConfig] = useState<PaperConfig>({ ...DEFAULT_PAPER_CONFIG });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);
  const command = useRef(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || command.current % 2) return;
      loading = true;
      const revision = command.current;
      try {
        const result = await api<PaperStatus>('/api/paper', { signal: controller.signal });
        if (controller.signal.aborted || revision !== command.current) return;
        setStatus(result); setError('');
        if (!initialized.current) { setConfig(result.config); initialized.current = true; }
      } catch (error) {
        if (!controller.signal.aborted && revision === command.current) setError(error instanceof Error ? error.message : 'Could not load paper trading.');
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [active]);

  async function act(action: 'config' | 'start' | 'stop') {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); command.current++;
    try {
      const result = await api<PaperStatus>(`/api/paper/${action}`, { method: 'POST', body: JSON.stringify(action === 'config' ? config : {}) });
      setStatus(result);
      if (action === 'config') { setConfig(result.config); setNotice('Paper settings saved.'); }
      else setNotice(action === 'start' ? 'Paper simulation started on the local server.' : 'Paper simulation paused.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Paper command failed.'); }
    finally { setBusy(false); command.current++; }
  }
  const dirty = Boolean(status && JSON.stringify(config) !== JSON.stringify(status.config));
  const latest = status?.decisions.at(-1);
  const equity = status && (status.quantity === 0 || status.markPrice !== null) ? status.cashUsd + status.quantity * (status.markPrice ?? 0) : null;
  const setNumber = (key: 'orderUsd' | 'maxPositionUsd' | 'feeBps' | 'slippageBps', value: string) => setConfig(current => ({ ...current, [key]: value === '' ? NaN : Number(value) }));

  return <div className="trading-desk">
    <div className="notice"><Wallet size={17} /><span><b>Wallet access + paper trading.</b> BUY/HOLD/SELL affects virtual USD and virtual positions only. Kraken research prices are not executable DEX quotes.</span></div>
    <div className="trading-grid">
      <WalletPanel />
      <section className="panel">
        <div className="panel-title"><div><h2>Autonomous paper trading</h2></div><span className="mini-pill">{status?.running ? 'Running · PAPER' : 'Paused · PAPER'}</span></div>
        <div className="trading-panel-body">
          <p>Start with {money(10_000)} virtual USD. A bullish signal buys up to your order limit; a bearish signal sells the whole virtual position; a neutral or unavailable signal holds.</p>
          <form onSubmit={event => { event.preventDefault(); void act('config'); }}>
            <fieldset className="paper-fields" disabled={!status || status.running || busy}>
              <label>Paper asset<select value={config.symbol} disabled={Boolean(status?.quantity)} onChange={event => setConfig(current => ({ ...current, symbol: event.target.value }))}>
                {!assets.some(item => item.symbol === config.symbol) && <option value={config.symbol}>{config.symbol}/USD</option>}
                {assets.map(asset => <option value={asset.symbol} key={asset.symbol}>{asset.symbol}/USD</option>)}
              </select></label>
              <label>Signal source<select value={config.signal} onChange={event => setConfig(current => ({ ...current, signal: event.target.value as PaperConfig['signal'] }))}><option value="jev">Saved JEV forecasts</option><option value="baseline">Technical baseline</option></select></label>
              <label>Horizon<select value={config.horizon} onChange={event => setConfig(current => ({ ...current, horizon: Number(event.target.value) as Horizon }))}>{HORIZONS.map(value => <option key={value} value={value}>{horizonLabel(value)}</option>)}</select></label>
              <label>Buy order, USD<input type="number" min="1" max="10000" step="0.01" required value={Number.isFinite(config.orderUsd) ? config.orderUsd : ''} onChange={event => setNumber('orderUsd', event.target.value)} /></label>
              <label>Position limit, USD<input type="number" min="1" max="10000" step="0.01" required value={Number.isFinite(config.maxPositionUsd) ? config.maxPositionUsd : ''} onChange={event => setNumber('maxPositionUsd', event.target.value)} /></label>
              <label>Fee per trade, bps<input type="number" min="0" max="100" step="0.1" required value={Number.isFinite(config.feeBps) ? config.feeBps : ''} onChange={event => setNumber('feeBps', event.target.value)} /></label>
              <label>Adverse slippage, bps<input type="number" min="0" max="100" step="0.1" required value={Number.isFinite(config.slippageBps) ? config.slippageBps : ''} onChange={event => setNumber('slippageBps', event.target.value)} /></label>
              <button className="button secondary" type="submit" disabled={!dirty}>Save paper settings</button>
            </fieldset>
          </form>
          <p className="trading-note">JEV mode consumes saved forecasts for the selected asset and horizon, with observations no older than 2 hours. It makes no new paid model calls. Generate forecasts from Overview. The technical baseline runs without JEV.</p>
          <div className="trading-actions"><button className="button primary" disabled={!status || status.running || busy || dirty || Boolean(error)} onClick={() => void act('start')}><Play size={15} />Start paper trading</button><button className="button secondary" disabled={busy || !status} onClick={() => void act('stop')}><Pause size={15} />Pause simulation</button></div>
          <p className="trading-note">Checks every minute while the server runs, including with this page closed. At most one simulated trade per asset per completed hour. Server restarts leave it paused. The position limit blocks new buying; price changes may move an existing position above it. Assets can change when the position is empty.</p>
          {notice && <p className="trading-note positive" role="status">{notice}</p>}
          {(error || status?.error) && <p className="trading-error" role="alert">{error || status?.error}</p>}
        </div>
      </section>
    </div>
    {status && <>
      <div className="paper-stats">
        <div className="panel"><span>Virtual cash</span><strong>{money(status.cashUsd)}</strong></div>
        <div className="panel"><span>Virtual {status.config.symbol}</span><strong>{status.quantity.toLocaleString('en-US', { maximumSignificantDigits: 8 })}</strong></div>
        <div className="panel"><span>Paper equity · last valuation</span><strong>{equity === null ? '—' : money(equity)}</strong></div>
        <div className="panel"><span>Simulated fees paid</span><strong>{money(status.feesUsd)}</strong></div>
      </div>
      <section className="panel paper-journal">
        <div className="panel-title"><div><h2>Decision journal</h2><span className="mini-pill">{status.source === 'demo' ? 'Synthetic demo prices' : 'Kraken prices'}</span></div><button className="button secondary" onClick={() => exportJson(status, 'jev-paper-trading.json')}><Download size={14} />Export journal</button></div>
        <div className="paper-decision" role="status"><span className={`paper-action ${latest?.action.toLowerCase() ?? 'hold'}`}>{latest?.action ?? 'HOLD'}</span><p>{latest?.reason ?? 'Ready. Choose settings and start the paper simulation.'}</p></div>
        <p className="trading-note paper-timestamps">Last check: {status.lastCheckedAt ? timeLabel(status.lastCheckedAt) : 'not started'} · Last valuation: {status.markedAt ? timeLabel(status.markedAt) : 'not available'}. Costs are simulated; gas, order-book depth, liquidity and DEX routing are not modeled.</p>
        <div className="paper-table-wrap"><table className="paper-table"><thead><tr><th>Time</th><th>Action</th><th>Asset / signal</th><th>Quantity</th><th>Fill price</th><th>Fee</th><th>Reason</th></tr></thead><tbody>
          {status.decisions.slice(-50).reverse().map(item => <tr key={item.id}><td>{timeLabel(item.time)}</td><td><span className={`paper-action ${item.action.toLowerCase()}`}>{item.action}</span></td><td>{item.config.symbol} · {item.config.signal}</td><td>{item.quantity ? item.quantity.toLocaleString('en-US', { maximumSignificantDigits: 8 }) : '—'}</td><td>{item.fillPrice === null ? '—' : money(item.fillPrice)}</td><td>{money(item.feeUsd)}</td><td>{item.reason}</td></tr>)}
          {!status.decisions.length && <tr><td colSpan={7}>No simulated decisions yet.</td></tr>}
        </tbody></table></div>
        {status.decisions.length > 50 && <p className="trading-note paper-timestamps">Latest 50 decisions shown. Export includes the full journal.</p>}
      </section>
    </>}
  </div>;
}

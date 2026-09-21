import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Download, Search, X } from 'lucide-react';
import type { Asset, Direction, Forecast, Symbol } from '../shared/types';
import { exportJson, horizonLabel, money, percent, timeLabel } from './utils';

export function AssetPicker({ assets, value, onChange }: { assets: Asset[]; value: Symbol; onChange: (value: Symbol) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const selected = assets.find(asset => asset.symbol === value);
  const filtered = assets.filter(asset => `${asset.symbol} ${asset.name}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  return <div className="asset-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape') setOpen(false);
    if (event.key === 'Enter' && query && filtered.length === 1) { onChange(filtered[0].symbol); setOpen(false); }
  }}>
    <button className="asset-picker-trigger" aria-label={`Choose market, current ${value}`} aria-expanded={open} aria-haspopup="listbox" onClick={() => { setOpen(!open); setQuery(''); }}>{selected?.name ?? value}<ChevronDown size={13} /></button>
    {open && <div className="asset-picker-menu"><label><Search size={14} /><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search all Kraken assets…" aria-label="Search Kraken catalog" /></label><div className="asset-picker-list" role="listbox" aria-label="Kraken cryptocurrency markets">{filtered.slice(0, 60).map(asset => <button role="option" aria-selected={asset.symbol === value} key={asset.symbol} onClick={() => { onChange(asset.symbol); setOpen(false); }}><span><b>{asset.symbol}</b><small>{asset.name}</small></span><span>USD {asset.symbol === value && <Check size={12} />}</span></button>)}{!filtered.length && <p>No matching cryptocurrencies.</p>}</div><div className="asset-picker-footer">{filtered.length} markets{filtered.length > 60 ? ' · Type to narrow the list' : ' · Kraken spot'}</div></div>}
  </div>;
}

export function ForecastDetail({ forecast, close }: { forecast: Forecast; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const directions: Direction[] = ['bullish', 'neutral', 'bearish'];
  return <dialog ref={dialog} className="forecast-dialog" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="forecast-dialog-content"><header><div><span className="eyebrow">RECORDED FORECAST</span><h2>{forecast.symbol}/USD <span>· {horizonLabel(forecast.horizon)}</span></h2></div><button className="icon-button" aria-label="Close forecast details" onClick={close}><X size={19} /></button></header><div className={`detail-direction ${forecast.direction}`}>{forecast.direction === 'bullish' ? <ArrowUpRight size={22} /> : forecast.direction === 'bearish' ? <ArrowDownLeft size={22} /> : <ArrowRight size={22} />}{forecast.direction} bias<span>{forecast.engine === 'jev' ? 'JEV 1.13' : 'Technical baseline'}</span></div><dl><div><dt>Saved at</dt><dd>{timeLabel(forecast.createdAt)}</dd></div><div><dt>Reference close</dt><dd>{money(forecast.referencePrice)} · {timeLabel(forecast.referenceTime)}</dd></div><div><dt>Outcome due</dt><dd>{timeLabel(forecast.targetTime)}</dd></div><div><dt>Neutral band</dt><dd>±{(forecast.neutralThreshold * 100).toFixed(3)}%</dd></div><div><dt>Volatility envelope</dt><dd>{money(forecast.range.low)} – {money(forecast.range.high)}</dd></div><div><dt>Source</dt><dd>{forecast.dataSource === 'demo' ? 'Synthetic demo' : 'Kraken hourly candles'}</dd></div><div><dt>Model</dt><dd className="detail-model">{forecast.model}</dd></div></dl>{forecast.probabilities && <div className="detail-probabilities">{directions.map(direction => <div key={direction}><span>{direction}</span><strong>{(forecast.probabilities![direction] * 100).toFixed(1)}%</strong></div>)}</div>}<div className="detail-outcome"><h3>{forecast.outcome ? (forecast.outcome.correct ? 'Direction matched' : 'Direction missed') : 'Outcome unresolved'}</h3><p>{forecast.outcome ? `Actual close: ${money(forecast.outcome.price)} (${percent(forecast.outcome.change * 100)}). Realized direction: ${forecast.outcome.direction}.${forecast.outcome.brier !== null ? ` Brier score: ${forecast.outcome.brier.toFixed(3)}.` : ''}` : 'The journal scores the exact completed target candle when available. Unresolved forecasts do not count as successful predictions.'}</p></div><button className="button secondary" onClick={() => exportJson(forecast, `jev-${forecast.symbol}-${forecast.id}.json`)}><Download size={14} />Export this forecast</button></div></dialog>;
}

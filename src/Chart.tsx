import { useId, useState } from 'react';
import type { Candle, Forecast } from '../shared/types';
import { money, timeLabel } from './utils';

export function Sparkline({ values, positive = true, width = 104, height = 32 }: { values: number[]; positive?: boolean; width?: number; height?: number }) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const points = values.map((value, index) => `${index / Math.max(1, values.length - 1) * width},${height - 3 - (value - min) / range * (height - 6)}`).join(' ');
  return <svg className={`sparkline ${positive ? 'positive' : 'negative'}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}

export default function Chart({ candles, forecast, range, kind }: { candles: Candle[]; forecast?: Forecast; range: number; kind: 'line' | 'candles' }) {
  const id = useId().replaceAll(':', '');
  const [hover, setHover] = useState<number | null>(null);
  const visible = candles.slice(-range);
  if (visible.length < 2) return <div className="chart-empty">Waiting for market observations…</div>;
  const W = 900, H = 300, left = 8, right = 78, top = 26, bottom = 32;
  const latest = visible.at(-1)!;
  const projection = forecast && forecast.targetTime > latest.time && forecast.referenceTime >= visible[0].time ? forecast : undefined;
  const startTime = visible[0].time;
  const endTime = Math.max(latest.time, projection?.targetTime ?? 0);
  const low = Math.min(...visible.map(c => c.low), projection?.range.low ?? Infinity);
  const high = Math.max(...visible.map(c => c.high), projection?.range.high ?? -Infinity);
  const padding = Math.max((high - low) * 0.12, latest.close * 0.002);
  const min = low - padding, max = high + padding;
  const x = (time: number) => left + (time - startTime) / (endTime - startTime) * (W - left - right);
  const y = (price: number) => top + (max - price) / (max - min) * (H - top - bottom);
  const path = visible.map((c, i) => `${i ? 'L' : 'M'}${x(c.time).toFixed(2)},${y(c.close).toFixed(2)}`).join(' ');
  const active = hover === null ? null : visible[hover];
  const barWidth = Math.max(1, Math.min(6, (W - left - right) / ((endTime - startTime) / 3_600_000 + 1) * 0.65));
  return <div className="market-chart">
    <div className="chart-readout"><span>{active ? timeLabel(active.time) : 'COMPLETED HOURLY CANDLES'}</span>{active && <b>{money(active.close)}</b>}<span className="chart-source">{projection ? 'PRICE + VOLATILITY ENVELOPE' : 'PRICE / USD'}</span></div>
    <svg role="img" aria-label="Hourly market price chart. Forecast shading shows a volatility scenario, not a guaranteed price interval." viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)} onMouseMove={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const mouseX = (event.clientX - bounds.left) / bounds.width * W;
      const time = startTime + (mouseX - left) / (W - left - right) * (endTime - startTime);
      const index = Math.max(0, Math.min(visible.length - 1, Math.round((time - startTime) / 3_600_000)));
      setHover(index);
    }}>
      <defs>
        <linearGradient id={`area${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#b4f276" stopOpacity="0.14" /><stop offset="100%" stopColor="#b4f276" stopOpacity="0" /></linearGradient>
        <linearGradient id={`band${id}`}><stop stopColor="#b4f276" stopOpacity="0.03" /><stop offset="100%" stopColor="#b4f276" stopOpacity="0.13" /></linearGradient>
      </defs>
      {Array.from({ length: 5 }, (_, i) => {
        const price = min + (max - min) * i / 4;
        return <g key={i}><line className="chart-grid" x1={left} x2={W - right} y1={y(price)} y2={y(price)} /><text className="chart-axis" x={W - right + 14} y={y(price) + 4}>{money(price)}</text></g>;
      })}
      {Array.from({ length: 5 }, (_, i) => {
        const time = startTime + (endTime - startTime) * i / 4;
        return <text key={i} className="chart-axis" x={x(time)} y={H - 7} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{new Intl.DateTimeFormat('en-US', range <= 24 ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' }).format(time)}</text>;
      })}
      {projection && <g>
        <path d={`M${x(projection.referenceTime)},${y(projection.referencePrice)} Q${x(projection.referenceTime + (projection.targetTime - projection.referenceTime) / 3)},${y(projection.range.high)} ${x(projection.targetTime)},${y(projection.range.high)} L${x(projection.targetTime)},${y(projection.range.low)} Q${x(projection.referenceTime + (projection.targetTime - projection.referenceTime) / 3)},${y(projection.range.low)} ${x(projection.referenceTime)},${y(projection.referencePrice)} Z`} fill={`url(#band${id})`} />
        <line x1={x(projection.referenceTime)} x2={x(projection.referenceTime)} y1={top} y2={H - bottom} className="forecast-divider" />
        <line x1={x(projection.referenceTime)} x2={x(projection.targetTime)} y1={y(projection.referencePrice)} y2={y(projection.referencePrice)} stroke="#8dba67" strokeDasharray="4 5" opacity="0.5" />
        <text className="forecast-label" x={Math.min(x(projection.referenceTime) + 12, W - right - 130)} y={top - 8}>VOLATILITY SCENARIO</text>
      </g>}
      {kind === 'line' ? <>
        <path d={`${path} L${x(latest.time)},${H - bottom} L${left},${H - bottom} Z`} fill={`url(#area${id})`} />
        <path d={path} fill="none" stroke="#b5f277" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x(latest.time)} cy={y(latest.close)} r="4" fill="#b5f277" stroke="#192116" strokeWidth="3" />
      </> : visible.map(c => <g key={c.time} stroke={c.close >= c.open ? '#9fd575' : '#e78089'} fill={c.close >= c.open ? '#9fd575' : '#e78089'}><line x1={x(c.time)} x2={x(c.time)} y1={y(c.high)} y2={y(c.low)} strokeWidth="1" /><rect x={x(c.time) - barWidth / 2} y={y(Math.max(c.open, c.close))} width={barWidth} height={Math.max(1, Math.abs(y(c.open) - y(c.close)))} strokeWidth="0" /></g>)}
      {active && <g><line x1={x(active.time)} x2={x(active.time)} y1={top} y2={H - bottom} stroke="#87918f" strokeDasharray="3 5" /><circle cx={x(active.time)} cy={y(active.close)} r="4" fill="#d5f8b3" stroke="#090e12" strokeWidth="2" /></g>}
    </svg>
  </div>;
}

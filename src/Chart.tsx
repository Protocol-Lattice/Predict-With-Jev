import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Candle, Forecast } from '../shared/types';
import { money, percent, timeLabel } from './utils';
import { measurePriceChange, nearestCandleIndex, type ChartSelection } from './chart-selection';
import './chart-selection.css';

export function Sparkline({ values, positive = true, width = 104, height = 32 }: { values: number[]; positive?: boolean; width?: number; height?: number }) {
  if (!values.length) return null;
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const points = values.map((value, index) => `${index / Math.max(1, values.length - 1) * width},${height - 3 - (value - min) / range * (height - 6)}`).join(' ');
  return <svg className={`sparkline ${positive ? 'positive' : 'negative'}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>;
}

export default function Chart({ candles, forecast, range, kind, intervalMinutes = 60 }: { candles: Candle[]; forecast?: Forecast; range: number; kind: 'line' | 'candles'; intervalMinutes?: 60 | 1440 | 10080 }) {
  const id = useId().replaceAll(':', '');
  const [hover, setHover] = useState<number | null>(null);
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; anchorTime: number; previous: ChartSelection | null } | null>(null);
  const visible = candles.slice(-range);
  if (visible.length < 2) return <div className="chart-empty">Waiting for market observations…</div>;
  const candleLabel = intervalMinutes === 10080 ? 'weekly' : intervalMinutes === 1440 ? 'daily' : 'hourly';
  const closeTime = (time: number) => intervalMinutes === 60 ? timeLabel(time) : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(time);
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
  const barWidth = Math.max(1, Math.min(6, (W - left - right) / ((endTime - startTime) / (intervalMinutes * 60_000) + 1) * 0.65));
  const measurement = measurePriceChange(visible, selection);
  const measurementColor = measurement && measurement.change < 0 ? '#ed8590' : '#b6f478';
  const days = measurement ? Math.floor(measurement.durationHours / 24) : 0;
  const hours = measurement ? measurement.durationHours % 24 : 0;
  const duration = [days ? `${days}d` : '', hours ? `${hours}h` : ''].filter(Boolean).join(' ');

  function pointerIndex(event: PointerEvent<SVGSVGElement>, allowOutside = false) {
    // The SVG can be letterboxed by its minimum CSS height. Use its actual transform.
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return null;
    const point = event.currentTarget.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const position = point.matrixTransform(matrix.inverse());
    if (!allowOutside && (position.x < left || position.x > x(latest.time) || position.y < top || position.y > H - bottom)) return null;
    const time = startTime + (position.x - left) / (W - left - right) * (endTime - startTime);
    return nearestCandleIndex(visible, time);
  }

  function releaseDrag(element: SVGSVGElement) {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (current && element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
  }

  function cancelDrag(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const previous = drag.current.previous;
    releaseDrag(event.currentTarget);
    setSelection(previous);
    setHover(null);
  }

  function moveWithKeyboard(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      releaseDrag(event.currentTarget);
      setSelection(null);
      setHover(null);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.min(hover ?? visible.length - 1, visible.length - 1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
    setHover(next);
    setSelection(event.shiftKey ? { anchorTime: selection?.anchorTime ?? visible[current].time, endTime: visible[next].time } : null);
  }

  return <div className={`market-chart${dragging ? ' is-selecting' : ''}`}>
    <div className="chart-readout"><span>{active ? closeTime(active.time) : `COMPLETED ${candleLabel.toUpperCase()} CANDLES`}</span>{active && <b>{money(active.close)}</b>}<span className="chart-source">{projection ? 'PRICE + VOLATILITY ENVELOPE' : 'PRICE / USD'}</span></div>
    <svg ref={svg} role="group" tabIndex={0} aria-label={`${candleLabel[0].toUpperCase() + candleLabel.slice(1)} market price chart`} aria-describedby={`chart-help-${id}`} viewBox={`0 0 ${W} ${H}`}
      onFocus={() => setHover(current => current ?? visible.length - 1)}
      onBlur={() => { if (!drag.current) setHover(null); }}
      onKeyDown={moveWithKeyboard}
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        const index = pointerIndex(event);
        if (index === null) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, anchorTime: visible[index].time, previous: selection };
        setDragging(true);
        setHover(index);
        setSelection({ anchorTime: visible[index].time, endTime: visible[index].time });
      }}
      onPointerMove={event => {
        if (drag.current && drag.current.pointerId !== event.pointerId) return;
        const index = pointerIndex(event, Boolean(drag.current));
        setHover(index);
        if (drag.current && index !== null) setSelection({ anchorTime: drag.current.anchorTime, endTime: visible[index].time });
      }}
      onPointerUp={event => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        const index = pointerIndex(event, true);
        const anchorTime = drag.current.anchorTime;
        setSelection(index !== null && visible[index].time !== anchorTime ? { anchorTime, endTime: visible[index].time } : null);
        releaseDrag(event.currentTarget);
      }}
      onPointerLeave={() => { if (!drag.current) setHover(null); }}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}>
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
        const dateOptions: Intl.DateTimeFormatOptions = intervalMinutes > 60 ? { month: 'short', year: 'numeric', ...(endTime - startTime < 180 * 86_400_000 ? { day: 'numeric' as const } : {}), timeZone: 'UTC' } : range <= 24 ? { hour: '2-digit', minute: '2-digit', hour12: false } : { month: 'short', day: 'numeric' };
        return <text key={i} className="chart-axis" x={x(time)} y={H - 7} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}>{new Intl.DateTimeFormat('en-US', dateOptions).format(time)}</text>;
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
      {measurement && <g aria-hidden="true" className="chart-selection-overlay" stroke={measurementColor}>
        <rect x={x(measurement.start.time)} y={top} width={x(measurement.end.time) - x(measurement.start.time)} height={H - top - bottom} fill={measurementColor} fillOpacity="0.09" stroke="none" />
        {[measurement.start, measurement.end].map(candle => <g key={candle.time}>
          <line x1={x(candle.time)} x2={x(candle.time)} y1={top} y2={H - bottom} strokeDasharray="4 4" opacity="0.8" />
          <circle cx={x(candle.time)} cy={y(candle.close)} r="5" fill={measurementColor} stroke="#0d1217" strokeWidth="2" />
        </g>)}
        <line x1={x(measurement.start.time)} y1={y(measurement.start.close)} x2={x(measurement.end.time)} y2={y(measurement.end.close)} strokeDasharray="5 4" strokeWidth="1.5" />
      </g>}
      {active && !measurement && <g><line x1={x(active.time)} x2={x(active.time)} y1={top} y2={H - bottom} stroke="#87918f" strokeDasharray="3 5" /><circle cx={x(active.time)} cy={y(active.close)} r="4" fill="#d5f8b3" stroke="#090e12" strokeWidth="2" /></g>}
    </svg>
    {measurement && <div className={`chart-measurement ${measurement.change < 0 ? 'loss' : 'gain'}`}>
      <div className="measurement-heading"><span>SELECTED PERIOD <b>{duration}</b></span><button aria-label="Clear selected period" onClick={() => { setSelection(null); svg.current?.focus({ preventScroll: true }); }}>Clear <span aria-hidden="true">×</span></button></div>
      <div className="measurement-values" role="status" aria-live={dragging ? 'off' : 'polite'} aria-atomic="true">
        <div className="measurement-change"><strong>{percent(measurement.changePercent)}</strong><span>{measurement.change >= 0 ? '+' : ''}{money(measurement.change)} USD</span></div>
        <div className="measurement-endpoints"><div><span>From · {closeTime(measurement.start.time)}</span><b>{money(measurement.start.close)}</b></div><span className="measurement-arrow" aria-hidden="true">→</span><div><span>To · {closeTime(measurement.end.time)}</span><b>{money(measurement.end.close)}</b></div></div>
      </div>
      <p>Change between completed {candleLabel} closes{intervalMinutes > 60 ? ' · Dates in UTC' : ''}.</p>
    </div>}
    <p className="chart-selection-help" id={`chart-help-${id}`}>Drag across the chart to measure a period. <span>Shift + ← / → to select · Esc to clear.</span><span className="chart-accessibility-note">Use arrow keys to move between {candleLabel} closes. Forecast shading is a volatility scenario and is excluded from measurements.</span></p>
  </div>;
}

import React from 'react';

export default function Chart({ series = [], height = 154, min = 3.2, max = 4.4, xLabel = 'Time (min)', yLabel = 'Voltage (V)', compact = false, title = 'Voltage history' }) {
  const w = 630, h = 190, left = 47, right = 12, top = 10, bottom = 39;
  const plotW = w - left - right, plotH = h - top - bottom;
  const values = series.flatMap(s => s.points.map(p => p.x));
  const minX = values.length ? Math.min(...values) : 0;
  const maxX = values.length ? Math.max(...values) : 60;
  const x = value => left + (value - minX) / (maxX - minX || 1) * plotW;
  const y = value => top + (max - value) / (max - min) * plotH;
  const ticks = Array.from({ length: 4 }, (_, i) => min + (max - min) * i / 3);
  return <svg className={`chart ${compact ? 'compact-chart' : ''}`} viewBox={`0 0 ${w} ${h}`} style={{ height }} role="img" aria-label={title}>
    <title>{title}</title>
    {ticks.map(v => <g key={v}><line x1={left} y1={y(v)} x2={w-right} y2={y(v)} className="grid-line"/><text x={left-12} y={y(v)+4} textAnchor="end">{v.toFixed(1)}</text></g>)}
    {Array.from({ length: 7 }, (_, i) => {
      const value = minX + (maxX-minX) * i / 6;
      return <g key={i}><line x1={x(value)} y1={top} x2={x(value)} y2={h-bottom} className="grid-line"/><text x={x(value)} y={h-bottom+20} textAnchor="middle">{Math.round(value)}</text></g>;
    })}
    <path d={`M${left} ${top}V${h-bottom}H${w-right}`} className="axis-line"/>
    {series.map((s, n) => <path key={s.id || n} d={s.points.filter(p => Number.isFinite(p.y)).map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(2)} ${y(p.y).toFixed(2)}`).join(' ')} stroke={s.color || '#00bba5'} opacity={s.opacity || 1} strokeWidth={s.width || 1.65} fill="none"><title>{s.label || 'Cell voltage'}</title></path>)}
    <text transform={`translate(13 ${top+plotH/2}) rotate(-90)`} textAnchor="middle">{yLabel}</text>
    <text x={left+plotW/2} y={h-3} textAnchor="middle">{xLabel}</text>
    {!values.length && <text x={left+plotW/2} y={top+plotH/2} textAnchor="middle">Waiting for telemetry</text>}
  </svg>;
}

export function historySeries(history, weakCells, onlyCell) {
  if (!history.length) return [];
  const start = history[0].time;
  const numbers = onlyCell ? [onlyCell] : Array.from({ length: 14 }, (_, i) => i + 1);
  return numbers.map(number => ({
    id: number, label: `Cell ${String(number).padStart(2, '0')}`,
    color: weakCells.includes(number) ? '#ee9c00' : '#00bda4',
    opacity: onlyCell || weakCells.includes(number) ? 1 : 0.55,
    width: onlyCell ? 2.2 : 1.5,
    points: history.map(point => ({ x: (point.time-start) / 60000, y: point.cells[number-1] }))
  }));
}

export function cycleSeries() {
  return [
    { id: 'charge', color: '#00bda4', label: 'Charge', points: Array.from({ length: 61 }, (_, i) => ({ x: i, y: 3.6 + 0.62 * Math.min(i / 20, 1) })) },
    { id: 'discharge', color: '#2476ed', label: 'Discharge', points: Array.from({ length: 61 }, (_, i) => ({ x: i, y: 4.2 - 0.72 * i / 60 })) }
  ];
}

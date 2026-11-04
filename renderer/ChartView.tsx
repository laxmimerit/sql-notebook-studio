// Quick charts from a result: bar, line, area, scatter, pie.

import { useEffect, useMemo, useRef, useState } from 'react';
import Chart from 'chart.js/auto';
import type { Cell, ChartConfig, ChartType, Column, StatementResult } from '../shared/protocol';
import { full, toNumber } from './util';

const TYPES: { id: ChartType; icon: string; label: string }[] = [
  { id: 'bar', icon: 'graph', label: 'Bar' },
  { id: 'line', icon: 'graph-line', label: 'Line' },
  { id: 'area', icon: 'pulse', label: 'Area' },
  { id: 'scatter', icon: 'graph-scatter', label: 'Scatter' },
  { id: 'pie', icon: 'pie-chart', label: 'Pie' },
];
const PALETTE = ['--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green', '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];
const FALLBACK = ['#3794ff', '#d18616', '#89d185', '#b180d7', '#f14c4c', '#cca700'];
const MAX_POINTS = 5000;

export function autoChart(columns: Column[], rows: Cell[][]): ChartConfig | undefined {
  const numeric = columns.map((c, i) => ({ c, i })).filter(({ c, i }) => c.kind === 'number' || (c.kind !== 'date' && rows.slice(0, 20).every((r) => r[i] === null || toNumber(r[i]) !== null) && rows.length > 0));
  const x = columns.find((c) => c.kind === 'date') ?? columns.find((c) => c.kind === 'string') ?? columns[0];
  if (!x) return undefined;
  const y = numeric.filter(({ c }) => c.name !== x.name).slice(0, 3).map(({ c }) => c.name);
  if (!y.length) return undefined;
  return { type: x.kind === 'date' ? 'line' : 'bar', x: x.name, y };
}

function color(i: number, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(PALETTE[i % PALETTE.length]).trim() || FALLBACK[i % FALLBACK.length];
  if (alpha === 1) return v;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = v;
  const hex = ctx.fillStyle as string;
  if (!hex.startsWith('#')) return v;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface Props {
  result: StatementResult;
  rowOrder: number[];
  config: ChartConfig;
  onConfig: (c: ChartConfig) => void;
  height: number;
  onSavePng: (dataUrl: string) => void;
}

export function ChartView({ result, rowOrder, config, onConfig, height, onSavePng }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const chart = useRef<Chart | null>(null);
  const [yOpen, setYOpen] = useState(false);
  const ymenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!yOpen) return;
    const down = (e: PointerEvent) => !ymenu.current?.contains(e.target as Node) && setYOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setYOpen(false);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [yOpen]);
  const { columns, rows } = result;
  const xi = columns.findIndex((c) => c.name === config.x);
  const ys = config.y.map((n) => columns.findIndex((c) => c.name === n)).filter((i) => i >= 0);

  const data = useMemo(() => {
    const order = rowOrder.slice(0, config.type === 'pie' ? 60 : MAX_POINTS);
    const labels = order.map((r) => (xi >= 0 ? (rows[r][xi] === null ? 'NULL' : full(rows[r][xi])) : String(r + 1)));
    const datasets = ys.map((yi, k) => {
      const values = order.map((r) => toNumber(rows[r][yi]));
      if (config.type === 'scatter') {
        return {
          label: columns[yi].name,
          data: order.map((r, j) => ({ x: toNumber(rows[r][xi]) ?? j, y: values[j] })),
          backgroundColor: color(k, 0.75),
          borderColor: color(k),
          pointRadius: 3,
        };
      }
      if (config.type === 'pie') {
        return { label: columns[yi].name, data: values, backgroundColor: order.map((_, j) => color(j, 0.85)), borderColor: 'transparent' };
      }
      return {
        label: columns[yi].name,
        data: values,
        backgroundColor: color(k, config.type === 'area' ? 0.25 : 0.8),
        borderColor: color(k),
        borderWidth: config.type === 'bar' ? 0 : 2,
        fill: config.type === 'area' ? (config.stacked ? (k === 0 ? 'origin' : '-1') : 'origin') : false,
        tension: 0.25,
        pointRadius: order.length > 60 ? 0 : 2.5,
        borderRadius: config.type === 'bar' ? 3 : 0,
        maxBarThickness: 48,
      };
    });
    return { labels, datasets: config.type === 'pie' ? datasets.slice(0, 1) : datasets };
  }, [rows, rowOrder, xi, ys.join(','), config.type, config.stacked, columns]);

  useEffect(() => {
    if (!canvas.current) return;
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-descriptionForeground').trim() || '#888';
    const grid = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editorWidget-border').trim() || 'rgba(128,128,128,0.25)';
    const font = getComputedStyle(document.documentElement).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
    Chart.defaults.font.family = font;
    Chart.defaults.color = fg;
    const t = config.type;
    const horizontal = t === 'bar' && !!config.horizontal;
    const scales =
      t === 'pie'
        ? undefined
        : {
            x: { stacked: !!config.stacked && t !== 'scatter', grid: { color: grid, display: horizontal }, ticks: { maxRotation: 0, autoSkipPadding: 12 }, type: t === 'scatter' || horizontal ? 'linear' : 'category', title: { display: true, text: horizontal ? config.y.join(', ') : config.x } },
            y: { type: horizontal ? 'category' : 'linear', stacked: !!config.stacked && t !== 'scatter', grid: { color: grid, display: !horizontal }, beginAtZero: t !== 'scatter', title: { display: config.y.length === 1 || horizontal, text: horizontal ? config.x : config.y[0] } },
          };
    chart.current?.destroy();
    chart.current = new Chart(canvas.current, {
      type: t === 'area' ? 'line' : t === 'pie' ? 'doughnut' : t,
      data: data as any,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        indexAxis: horizontal ? 'y' : 'x',
        interaction: { mode: t === 'pie' || t === 'scatter' ? 'nearest' : 'index', intersect: false },
        plugins: {
          legend: { display: t === 'pie' || data.datasets.length > 1, position: t === 'pie' ? 'right' : 'top', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { padding: 8, cornerRadius: 4 },
        },
        scales: scales as any,
        ...(t === 'pie' ? { cutout: '55%' } : {}),
      },
    });
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
  }, [data, config.type, config.stacked, config.horizontal, config.x, config.y.join(',')]);

  const numericCols = columns.filter((c, i) => c.kind === 'number' || rows.slice(0, 20).some((r) => typeof r[i] === 'number'));
  const truncated = rowOrder.length > (config.type === 'pie' ? 60 : MAX_POINTS);

  return (
    <div className="chart">
      <div className="chart-bar">
        <div className="seg" role="radiogroup" aria-label="Chart type">
          {TYPES.map((t) => (
            <button key={t.id} role="radio" aria-checked={config.type === t.id} className={config.type === t.id ? 'on' : ''} title={t.label} onClick={() => onConfig({ ...config, type: t.id })}>
              <i className={`codicon codicon-${t.icon}`} />
            </button>
          ))}
        </div>
        <label className="pick">
          <span>X</span>
          <select value={config.x} onChange={(e) => onConfig({ ...config, x: e.target.value })}>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="pick ymenu" ref={ymenu}>
          <span>Y</span>
          <button className="ybtn" onClick={() => setYOpen(!yOpen)} aria-expanded={yOpen}>
            {config.y.length ? config.y.join(', ') : 'Choose'}
            <i className="codicon codicon-chevron-down" />
          </button>
          {yOpen && (
            <div className="menu">
              {numericCols.map((c) => (
                <label key={c.name} className="menu-item check">
                  <input
                    type="checkbox"
                    checked={config.y.includes(c.name)}
                    onChange={(e) => onConfig({ ...config, y: e.target.checked ? [...config.y, c.name] : config.y.filter((n) => n !== c.name) })}
                  />
                  {c.name}
                </label>
              ))}
              {!numericCols.length && <div className="menu-item muted">No number columns</div>}
            </div>
          )}
        </div>
        {(config.type === 'bar' || config.type === 'area') && (
          <button className={`tb ${config.stacked ? 'on' : ''}`} title="Stack series" onClick={() => onConfig({ ...config, stacked: !config.stacked })}>
            <i className="codicon codicon-layers" />
          </button>
        )}
        {config.type === 'bar' && (
          <button className={`tb ${config.horizontal ? 'on' : ''}`} title="Horizontal bars" onClick={() => onConfig({ ...config, horizontal: !config.horizontal })}>
            <i className="codicon codicon-list-flat" />
          </button>
        )}
        <span className="spacer" />
        {truncated && <span className="muted small">First {config.type === 'pie' ? 60 : MAX_POINTS.toLocaleString()} rows</span>}
        <button className="tb" title="Save as PNG" onClick={() => chart.current && onSavePng(chart.current.toBase64Image('image/png', 1))}>
          <i className="codicon codicon-device-camera" />
        </button>
      </div>
      <div className="chart-canvas" style={{ height: Math.max(220, Math.min(height, 420)) }}>
        {ys.length ? <canvas ref={canvas} role="img" aria-label={`${config.type} chart of ${config.y.join(', ')} by ${config.x}`} /> : <div className="g-empty">Pick at least one number column for Y.</div>}
      </div>
    </div>
  );
}

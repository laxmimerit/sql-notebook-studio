// A virtualized results grid: sort, filter, search, resize, pin, select, copy.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Cell, Column, StatementResult } from '../shared/protocol';
import { compare, copyText, display, full, isBin, makeFilter, toDelimited } from './util';

const ROW_H = 24;
const HEAD_H = 30;
const FILTER_H = 30;
const NUM_W_MIN = 44;

export interface GridState {
  sort: { col: number; dir: 1 | -1 }[];
  filters: Record<number, string>;
}

interface Props {
  result: StatementResult;
  search: string;
  showFilters: boolean;
  height: number;
  state: GridState;
  onState: (s: GridState) => void;
  onVisibleRows: (rows: number[]) => void;
  onOpenValue: (v: { column: Column; value: Cell; row: number }) => void;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string, font: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

export function Grid({ result, search, showFilters, height, state, onState, onVisibleRows, onOpenValue }: Props) {
  const { columns, rows } = result;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(height);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [pinned, setPinned] = useState<Set<number>>(new Set());
  const [widths, setWidths] = useState<number[]>([]);

  // Column widths from header and a sample of values.
  useLayoutEffect(() => {
    const el = scroller.current;
    const cs = el ? getComputedStyle(el) : undefined;
    const mono = `${cs?.getPropertyValue('--vscode-editor-font-size') || '12px'} ${cs?.getPropertyValue('--vscode-editor-font-family') || 'monospace'}`;
    const ui = `600 12px ${cs?.getPropertyValue('--vscode-font-family') || 'sans-serif'}`;
    const sample = rows.slice(0, 200);
    setWidths(
      columns.map((c, i) => {
        let w = textWidth(c.name, ui) + 42;
        for (const r of sample) w = Math.max(w, textWidth(display(r[i]).slice(0, 80), mono) + 22);
        return Math.round(Math.min(Math.max(w, 64), 380));
      }),
    );
  }, [columns, rows]);

  const filterFns = useMemo(
    () => Object.entries(state.filters).map(([k, expr]) => [Number(k), makeFilter(expr, columns[Number(k)]?.kind ?? 'string')] as const).filter(([, f]) => !!f),
    [state.filters, columns],
  );

  // Visible row order after search, filters and sort (indexes into rows).
  const order = useMemo(() => {
    let idx = rows.map((_, i) => i);
    const q = search.trim().toLowerCase();
    if (q) idx = idx.filter((i) => rows[i].some((v) => v !== null && full(v).toLowerCase().includes(q)));
    for (const [c, f] of filterFns) idx = idx.filter((i) => f!(rows[i][c]));
    if (state.sort.length) {
      const keys = state.sort.map((s) => ({ ...s, numeric: columns[s.col]?.kind === 'number' }));
      idx.sort((a, b) => {
        for (const k of keys) {
          const d = compare(rows[a][k.col], rows[b][k.col], k.numeric);
          if (d !== 0) return d * k.dir;
        }
        return a - b;
      });
    }
    return idx;
  }, [rows, search, filterFns, state.sort, columns]);

  useEffect(() => onVisibleRows(order), [order, onVisibleRows]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const headH = HEAD_H + (showFilters ? FILTER_H : 0);
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(order.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);

  const numW = Math.max(NUM_W_MIN, String(rows.length).length * 8 + 22);
  const lefts = useMemo(() => {
    const out: Record<number, number> = {};
    let x = numW;
    for (let i = 0; i < columns.length; i++) {
      if (pinned.has(i)) {
        out[i] = x;
        x += widths[i] ?? 120;
      }
    }
    return out;
  }, [pinned, widths, columns.length, numW]);
  const colOrder = useMemo(() => [...columns.keys()].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)) || a - b), [columns, pinned]);
  const totalW = numW + widths.reduce((a, b) => a + b, 0);

  const toggleSort = (col: number, add: boolean) => {
    const cur = state.sort.find((s) => s.col === col);
    let next = add ? state.sort.filter((s) => s.col !== col) : [];
    if (!cur) next = [...next, { col, dir: 1 }];
    else if (cur.dir === 1) next = [...next, { col, dir: -1 }];
    onState({ ...state, sort: next });
  };

  const startResize = (e: React.PointerEvent, col: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[col];
    const move = (ev: PointerEvent) => setWidths((w) => w.map((v, i) => (i === col ? Math.max(48, w0 + ev.clientX - x0) : v)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const scrollIntoView = useCallback(
    (r: number) => {
      const el = scroller.current;
      if (!el) return;
      const top = r * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight - headH) el.scrollTop = top + ROW_H - el.clientHeight + headH;
    },
    [headH],
  );

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      if (sel && sel.c >= 0) copyText(full(rows[order[sel.r]][sel.c]));
      else if (sel) copyText(toDelimited(columns, [rows[order[sel.r]]], '\t').split('\n')[1]);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      copyText(toDelimited(columns, order.map((i) => rows[i]), '\t'));
      return;
    }
    if (!sel) return;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const r = Math.min(Math.max(0, sel.r + dr), order.length - 1);
      const vis = colOrder.indexOf(sel.c);
      const c = sel.c < 0 ? (dc > 0 ? colOrder[0] : -1) : colOrder[Math.min(Math.max(0, vis + dc), colOrder.length - 1)];
      setSel({ r, c });
      scrollIntoView(r);
    };
    if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowRight') move(0, 1);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'PageDown') move(Math.floor(viewH / ROW_H) - 1, 0);
    else if (e.key === 'PageUp') move(-(Math.floor(viewH / ROW_H) - 1), 0);
    else if (e.key === 'Home' && mod) move(-order.length, 0);
    else if (e.key === 'End' && mod) move(order.length, 0);
    else if (e.key === 'Enter' && sel.c >= 0) {
      e.preventDefault();
      onOpenValue({ column: columns[sel.c], value: rows[order[sel.r]][sel.c], row: order[sel.r] });
    } else if (e.key === 'Escape') setSel(null);
  };

  const stickyStyle = (c: number): React.CSSProperties | undefined => (pinned.has(c) ? { position: 'sticky', left: lefts[c], zIndex: 2 } : undefined);

  return (
    <div className="grid-scroll" ref={scroller} style={{ maxHeight: height }} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} role="grid" aria-rowcount={order.length} aria-colcount={columns.length}>
      <div className="grid-inner" style={{ width: totalW, height: headH + order.length * ROW_H }}>
        <div className="g-head" style={{ width: totalW }}>
          <div className="g-row g-hrow" style={{ height: HEAD_H }}>
            <div className="g-cell g-num g-corner" style={{ width: numW }} title="Copy all (Ctrl+A)" onClick={() => copyText(toDelimited(columns, order.map((i) => rows[i]), '\t'))}>
              #
            </div>
            {colOrder.map((c) => {
              const col = columns[c];
              const s = state.sort.find((x) => x.col === c);
              const sortIdx = state.sort.length > 1 && s ? state.sort.indexOf(s) + 1 : 0;
              return (
                <div
                  key={c}
                  role="columnheader"
                  aria-sort={s ? (s.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  className={`g-cell g-h ${col.kind === 'number' ? 'num' : ''} ${pinned.has(c) ? 'pinned' : ''}`}
                  style={{ width: widths[c], ...stickyStyle(c) }}
                  title={`${col.name}${col.type ? ` · ${col.type}` : ''}\nClick to sort, Shift+click to add a sort`}
                  onClick={(e) => toggleSort(c, e.shiftKey)}
                >
                  <span className="g-hname">{col.name}</span>
                  {s && (
                    <span className="g-sort">
                      <i className={`codicon codicon-arrow-${s.dir === 1 ? 'up' : 'down'}`} />
                      {sortIdx > 0 && <sub>{sortIdx}</sub>}
                    </span>
                  )}
                  <button
                    className={`g-pin ${pinned.has(c) ? 'on' : ''}`}
                    title={pinned.has(c) ? 'Unpin column' : 'Pin column'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPinned((p) => {
                        const n = new Set(p);
                        n.has(c) ? n.delete(c) : n.add(c);
                        return n;
                      });
                    }}
                  >
                    <i className={`codicon codicon-${pinned.has(c) ? 'pinned' : 'pin'}`} />
                  </button>
                  <span className="g-resize" onPointerDown={(e) => startResize(e, c)} onClick={(e) => e.stopPropagation()} />
                </div>
              );
            })}
          </div>
          {showFilters && (
            <div className="g-row g-frow" style={{ height: FILTER_H }}>
              <div
                className="g-cell g-num g-corner"
                style={{ width: numW }}
                title="Clear column filters"
                onClick={() => onState({ ...state, filters: {} })}
              >
                <i className={`codicon ${Object.values(state.filters).some(Boolean) ? 'codicon-clear-all' : 'codicon-filter'}`} />
              </div>
              {colOrder.map((c) => (
                <div key={c} className={`g-cell g-f ${pinned.has(c) ? 'pinned' : ''}`} style={{ width: widths[c], ...stickyStyle(c) }}>
                  <input
                    value={state.filters[c] ?? ''}
                    placeholder={columns[c].kind === 'number' ? '>10, 1..5' : 'contains'}
                    aria-label={`Filter ${columns[c].name}`}
                    onChange={(e) => onState({ ...state, filters: { ...state.filters, [c]: e.target.value } })}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="g-body" style={{ transform: `translateY(${first * ROW_H}px)` }}>
          {order.slice(first, last).map((ri, k) => {
            const r = first + k;
            const row = rows[ri];
            const rowSel = sel?.r === r;
            return (
              <div key={ri} className={`g-row ${r % 2 ? 'odd' : ''} ${rowSel ? 'sel-row' : ''}`} style={{ height: ROW_H }} role="row">
                <div className="g-cell g-num" style={{ width: numW }} onClick={() => setSel({ r, c: -1 })}>
                  {ri + 1}
                </div>
                {colOrder.map((c) => {
                  const v = row[c];
                  const kind = columns[c].kind;
                  const cls =
                    v === null ? 'null' : isBin(v) ? 'bin' : typeof v === 'object' ? 'json' : typeof v === 'boolean' ? 'bool' : kind === 'number' || typeof v === 'number' ? 'num' : '';
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      className={`g-cell g-v ${cls} ${rowSel && sel?.c === c ? 'sel' : ''} ${pinned.has(c) ? 'pinned' : ''}`}
                      style={{ width: widths[c], ...stickyStyle(c) }}
                      onClick={() => setSel({ r, c })}
                      onDoubleClick={() => onOpenValue({ column: columns[c], value: v, row: ri })}
                    >
                      {display(v)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {order.length === 0 && <div className="g-empty">{rows.length ? 'No rows match the filters.' : 'No rows.'}</div>}
    </div>
  );
}

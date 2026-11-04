import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cell, ChartConfig, Column, ResultPayload, StatementResult } from '../shared/protocol';
import { Grid, type GridState } from './Grid';
import { ChartView, autoChart } from './ChartView';
import { copyText, fmtMs, full, plural, send, toDelimited, toJson, toMarkdown } from './util';

export function ResultView({ payload, outputId }: { payload: ResultPayload; outputId: string }) {
  const { results, running, error } = payload;
  const [tab, setTab] = useState(0);
  const lastLen = useRef(results.length);
  useEffect(() => {
    // Follow new results while running; keep the user's tab after.
    if (results.length !== lastLen.current) {
      if (running) setTab(Math.max(0, results.length - 1));
      lastLen.current = results.length;
    }
    if (tab >= results.length && results.length) setTab(results.length - 1);
  }, [results.length, running, tab]);

  const current = results[tab];
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);

  return (
    <div className="sqlnb">
      {results.length > 1 && (
        <div className="tabs" role="tablist">
          {results.map((r, i) => (
            <button key={i} role="tab" aria-selected={i === tab} className={i === tab ? 'tab on' : 'tab'} title={r.sql} onClick={() => setTab(i)}>
              <span className="tab-n">{i + 1}</span>
              <span className="tab-sql">{firstLine(r.sql)}</span>
              <span className="tab-meta">{r.hasRows ? r.rows.length.toLocaleString() + (r.truncated ? '+' : '') : r.affected !== undefined ? `${r.affected} ✓` : '✓'}</span>
            </button>
          ))}
          <span className="tabs-total">{fmtMs(totalMs)}</span>
        </div>
      )}
      {current &&
        (current.hasRows ? (
          <RowsView key={`${tab}:${current.sql}`} result={current} payload={payload} outputId={outputId} index={tab} />
        ) : (
          <CommandView result={current} />
        ))}
      {running && <Running running={running} hasResults={!!results.length} />}
      {error && <ErrorView error={error} payload={payload} outputId={outputId} />}
      {!running && !error && !results.length && <div className="muted pad">Done. Nothing to show.</div>}
    </div>
  );
}

function firstLine(sql: string): string {
  const s = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
  return s.length > 48 ? s.slice(0, 46) + '…' : s;
}

function Running({ running, hasResults }: { running: NonNullable<ResultPayload['running']>; hasResults: boolean }) {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const label = running.index < 0 ? 'Connecting…' : running.count > 1 ? `Running ${running.index + 1} of ${running.count}…` : 'Running…';
  return (
    <div className={`running ${hasResults ? 'below' : ''}`}>
      <i className="codicon codicon-loading codicon-modifier-spin" />
      <span>{label}</span>
      <span className="muted">{fmtMs(now - t0)}</span>
    </div>
  );
}

function CommandView({ result }: { result: StatementResult }) {
  return (
    <div className="command">
      <i className="codicon codicon-pass-filled ok" />
      <span>{result.affected !== undefined ? `${plural(result.affected, 'row')} affected` : 'Done'}</span>
      <span className="muted">{fmtMs(result.durationMs)}</span>
      {result.messages?.map((m, i) => (
        <div key={i} className="message">
          {m}
        </div>
      ))}
    </div>
  );
}

function ErrorView({ error, payload, outputId }: { error: NonNullable<ResultPayload['error']>; payload: ResultPayload; outputId: string }) {
  const stopped = /stopped|not run|cancel/i.test(error.message) && !error.code;
  return (
    <div className={`error ${stopped ? 'stopped' : ''}`} role="alert">
      <div className="error-head">
        <i className={`codicon codicon-${stopped ? 'debug-stop' : 'error'}`} />
        <span className="error-title">
          {stopped ? 'Stopped' : 'Error'}
          {error.statementCount > 1 && ` in statement ${error.statementIndex + 1} of ${error.statementCount}`}
          {error.line && error.statementCount > 1 ? ` (line ${error.line})` : ''}
          {error.code ? <span className="muted"> · {error.code}</span> : null}
        </span>
        <span className="spacer" />
        {!stopped && payload.aiEnabled && error.sql && (
          <button className="btn primary" onClick={() => send({ type: 'fix', outputId })} title="Ask AI to fix this query">
            <i className="codicon codicon-sparkle" /> Fix with AI
          </button>
        )}
        <button className="tb" title="Copy error" onClick={() => copyText(error.message)}>
          <i className="codicon codicon-copy" />
        </button>
      </div>
      <pre className="error-msg">{error.message}</pre>
      {error.statementCount > 1 && error.sql && <pre className="error-sql">{error.sql.length > 400 ? error.sql.slice(0, 400) + '…' : error.sql}</pre>}
    </div>
  );
}

function RowsView({ result, payload, outputId, index }: { result: StatementResult; payload: ResultPayload; outputId: string; index: number }) {
  const canChart = index === 0;
  const [view, setView] = useState<'table' | 'chart'>(canChart && payload.view === 'chart' ? 'chart' : 'table');
  const [chart, setChart] = useState<ChartConfig | undefined>(() => (canChart ? payload.chart : undefined) ?? autoChart(result.columns, result.rows));
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [state, setState] = useState<GridState>({ sort: [], filters: {} });
  const [order, setOrder] = useState<number[]>(() => result.rows.map((_, i) => i));
  const [tall, setTall] = useState(false);
  const [menu, setMenu] = useState<'copy' | 'export' | null>(null);
  const [viewer, setViewer] = useState<{ column: Column; value: Cell; row: number } | null>(null);
  const onVisibleRows = useCallback((rows: number[]) => setOrder(rows), []);
  const toolbar = useRef<HTMLDivElement>(null);

  // Menus close on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      const wrap = (e.target as HTMLElement).closest?.('.menu-wrap');
      if (!wrap || !toolbar.current?.contains(wrap)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [menu]);

  const persist = (v: 'table' | 'chart', c?: ChartConfig) => {
    if (canChart) send({ type: 'setChart', outputId, view: v, chart: c });
  };
  const changeView = (v: 'table' | 'chart') => {
    setView(v);
    persist(v, chart);
  };
  const changeChart = (c: ChartConfig) => {
    setChart(c);
    persist('chart', c);
  };

  const visibleRows = () => order.map((i) => result.rows[i]);
  const filtered = order.length !== result.rows.length;
  const height = tall ? 720 : 360;
  const name = result.sql.match(/\bfrom\s+[`"[]?([\w.$]+)/i)?.[1] ?? 'result';

  const doCopy = (fmt: 'tsv' | 'csv' | 'json' | 'md') => {
    const rows = visibleRows();
    copyText(fmt === 'json' ? toJson(result.columns, rows) : fmt === 'md' ? toMarkdown(result.columns, rows) : toDelimited(result.columns, rows, fmt === 'csv' ? ',' : '\t'));
    setMenu(null);
  };
  const doExport = (format: 'csv' | 'json') => {
    send({ type: 'export', format, name, columns: result.columns, rows: visibleRows() });
    setMenu(null);
  };

  return (
    <div className="rows">
      <div className="toolbar" ref={toolbar}>
        <div className="seg" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === 'table'} className={view === 'table' ? 'on' : ''} onClick={() => changeView('table')} title="Table">
            <i className="codicon codicon-table" />
            <span>Table</span>
          </button>
          <button role="radio" aria-checked={view === 'chart'} className={view === 'chart' ? 'on' : ''} onClick={() => changeView('chart')} title={chart ? 'Chart' : 'No number columns to chart'} disabled={!chart}>
            <i className="codicon codicon-graph" />
            <span>Chart</span>
          </button>
        </div>
        {view === 'table' && (
          <>
            <div className="search">
              <i className="codicon codicon-search" />
              <input value={search} placeholder="Search" aria-label="Search rows" onChange={(e) => setSearch(e.target.value)} />
              {search && (
                <button className="clear" title="Clear" onClick={() => setSearch('')}>
                  <i className="codicon codicon-close" />
                </button>
              )}
            </div>
            <button className={`tb ${showFilters ? 'on' : ''} ${Object.values(state.filters).some(Boolean) ? 'active' : ''}`} title="Filter columns" onClick={() => setShowFilters(!showFilters)}>
              <i className="codicon codicon-filter" />
            </button>
            {(state.sort.length > 0 || Object.values(state.filters).some(Boolean)) && (
              <button className="tb" title="Clear sort and filters" onClick={() => setState({ sort: [], filters: {} })}>
                <i className="codicon codicon-clear-all" />
              </button>
            )}
          </>
        )}
        <span className="spacer" />
        <span className="meta" title={result.truncated ? `Stopped at the row limit (sqlNotebook.results.maxRows = ${payload.maxRows.toLocaleString()})` : undefined}>
          {filtered ? `${order.length.toLocaleString()} of ` : ''}
          {plural(result.rows.length, 'row')}
          {result.truncated && (
            <button className="link" onClick={() => send({ type: 'openSetting', key: 'sqlNotebook.results.maxRows' })}>
              limit reached
            </button>
          )}
          <span className="dot">·</span>
          {fmtMs(result.durationMs)}
        </span>
        <div className="menu-wrap">
          <button className="tb" title="Copy" onClick={() => setMenu(menu === 'copy' ? null : 'copy')} aria-expanded={menu === 'copy'}>
            <i className="codicon codicon-copy" />
          </button>
          {menu === 'copy' && (
            <div className="menu right">
              <button className="menu-item" onClick={() => doCopy('tsv')}>Copy for Excel / Sheets</button>
              <button className="menu-item" onClick={() => doCopy('csv')}>Copy as CSV</button>
              <button className="menu-item" onClick={() => doCopy('json')}>Copy as JSON</button>
              <button className="menu-item" onClick={() => doCopy('md')}>Copy as Markdown table</button>
            </div>
          )}
        </div>
        <div className="menu-wrap">
          <button className="tb" title="Export" onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'}>
            <i className="codicon codicon-desktop-download" />
          </button>
          {menu === 'export' && (
            <div className="menu right">
              <button className="menu-item" onClick={() => doExport('csv')}>Save as CSV…</button>
              <button className="menu-item" onClick={() => doExport('json')}>Save as JSON…</button>
            </div>
          )}
        </div>
        {payload.aiEnabled && (
          <button className="tb" title="Explain this result with AI" onClick={() => send({ type: 'explainResult', outputId, resultIndex: index })}>
            <i className="codicon codicon-sparkle" />
          </button>
        )}
        <button className="tb" title={tall ? 'Shrink' : 'Expand'} onClick={() => setTall(!tall)}>
          <i className={`codicon codicon-${tall ? 'fold-up' : 'unfold'}`} />
        </button>
      </div>
      {view === 'chart' && chart ? (
        <ChartView result={result} rowOrder={order} config={chart} onConfig={changeChart} height={tall ? 640 : 320} onSavePng={(dataUrl) => send({ type: 'savePng', dataUrl })} />
      ) : (
        <Grid result={result} search={search} showFilters={showFilters} height={height} state={state} onState={setState} onVisibleRows={onVisibleRows} onOpenValue={setViewer} />
      )}
      {viewer && <ValueViewer {...viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function ValueViewer({ column, value, row, onClose }: { column: Column; value: Cell; row: number; onClose: () => void }) {
  const text = full(value, true);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="viewer" role="dialog" aria-label={`Value of ${column.name}`}>
      <div className="viewer-head">
        <strong>{column.name}</strong>
        <span className="muted">
          row {row + 1}
          {column.type ? ` · ${column.type}` : ''}
          {typeof value === 'string' ? ` · ${value.length.toLocaleString()} chars` : ''}
        </span>
        <span className="spacer" />
        <button className="tb" title="Copy value" onClick={() => copyText(full(value, true))}>
          <i className="codicon codicon-copy" />
        </button>
        <button className="tb" title="Close (Esc)" onClick={onClose}>
          <i className="codicon codicon-close" />
        </button>
      </div>
      <pre className={value === null ? 'null' : ''}>{value === null ? 'NULL' : text}</pre>
    </div>
  );
}

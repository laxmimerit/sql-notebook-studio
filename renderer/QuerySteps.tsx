import { useEffect, useMemo, useState } from 'react';
import type { QueryStep, QueryStepKind, StepRows, StepsPayload } from '../shared/protocol';
import { fmtLines } from './RunOrder';
import { display, full, send } from './util';

/** Step colours, shared with Query Flow (k-* classes in styles.css). */
const KIND_CLASS: Record<QueryStepKind, string> = {
  from: 'k-scan',
  join: 'k-join',
  where: 'k-filter',
  group: 'k-group',
  having: 'k-filter',
  select: 'k-select',
  distinct: 'k-distinct',
  order: 'k-sort',
  limit: 'k-limit',
};

const KIND_LABEL: Record<QueryStepKind, string> = {
  from: 'read',
  join: 'join',
  where: 'filter rows',
  group: 'group',
  having: 'filter groups',
  select: 'pick columns',
  distinct: 'remove duplicates',
  order: 'sort',
  limit: 'keep the first rows',
};

/** "8 rows", "1 group", "12,034 rows". */
export function fmtCount(n: number | undefined, unit: 'rows' | 'groups'): string {
  if (n === undefined) return '';
  const word = unit === 'groups' ? (n === 1 ? 'group' : 'groups') : n === 1 ? 'row' : 'rows';
  return `${n.toLocaleString()} ${word}`;
}

export function QueryStepsView({ payload, outputId }: { payload: StepsPayload; outputId: string }) {
  const steps = payload.steps;
  const [cur, setCur] = useState(steps.length ? 1 : 0);
  const [showRemoved, setShowRemoved] = useState(false);

  // Start at step 1 (it shows a spinner until it has run); keep the selection valid as steps arrive.
  useEffect(() => {
    if (steps.length && (cur < 1 || cur > steps.length)) setCur(Math.min(Math.max(1, cur), steps.length));
  }, [steps.length, cur]);

  const go = (n: number) => {
    setShowRemoved(false);
    setCur(Math.max(1, Math.min(steps.length, n)));
  };

  const step = steps[cur - 1] as QueryStep | undefined;
  const prev = cur > 1 ? steps[cur - 2] : undefined;
  const lines = payload.sql.split('\n');
  const current = new Set(step?.lines ?? []);
  const stepsOnLine = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const s of steps) for (const l of s.lines) m.set(l, [...(m.get(l) ?? []), s.n]);
    return m;
  }, [steps]);
  const done = steps.filter((s) => s.status === 'done' || s.status === 'error').length;

  const onKey = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (!steps.length || tag === 'SUMMARY' || (tag === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(cur - 1);
    else if (e.key === 'Home') go(1);
    else if (e.key === 'End') go(steps.length);
    else return;
    e.preventDefault();
  };

  return (
    <div className={`sqlnb ro qs${payload.error ? ' error' : ''}`} tabIndex={0} onKeyDown={onKey} aria-label="Query Steps">
      <div className="ro-head">
        <i className="codicon codicon-list-ordered" />
        <span className="ro-title">Query Steps</span>
        <span className="muted small">the rows after each clause, in the order {payload.connection} applies them</span>
        <span className="spacer" />
        {payload.running && steps.length > 0 && (
          <span className="muted small qs-progress">
            <i className="codicon codicon-loading codicon-modifier-spin" /> step {Math.min(done + 1, steps.length)} of {steps.length}
          </span>
        )}
        {steps.length > 0 && (
          <>
            <button className="tb" title="Previous step (←)" disabled={cur <= 1} onClick={() => go(cur - 1)}>
              <i className="codicon codicon-chevron-left" />
            </button>
            <button className="tb" title="Next step (→)" disabled={cur >= steps.length} onClick={() => go(cur + 1)}>
              <i className="codicon codicon-chevron-right" />
            </button>
          </>
        )}
        {!payload.running && (
          <button className="tb" title="Close" onClick={() => send({ type: 'dismissAi', outputId })}>
            <i className="codicon codicon-close" />
          </button>
        )}
      </div>

      {payload.error && (
        <div className="ro-error">
          <i className="codicon codicon-warning" /> {payload.error}
        </div>
      )}

      {steps.length > 0 && (
        <>
          <div className="qs-strip" role="tablist" aria-label="Steps">
            {steps.map((s, i) => (
              <span key={s.n} className="qs-strip-item">
                <button
                  role="tab"
                  aria-selected={s.n === cur}
                  className={`ro-chip step qs-chip ${KIND_CLASS[s.kind]}${s.n === cur ? ' on' : ''} ${s.status}`}
                  title={s.title}
                  onClick={() => go(s.n)}
                >
                  <span className="ro-chip-n">{s.n}</span>
                  <span className="qs-chip-clause">{s.clause}</span>
                  <StatusMark step={s} />
                </button>
                {i < steps.length - 1 && <i className="codicon codicon-arrow-right qs-arrow" aria-hidden />}
              </span>
            ))}
          </div>

          <div className="ro-main">
            <section className="ro-pane ro-sql qs-sql" aria-label="Your SQL">
              <div className="ro-pane-label">Your SQL</div>
              <div className="ro-code">
                {lines.map((text, i) => {
                  const ns = stepsOnLine.get(i) ?? [];
                  return (
                    <div
                      key={i}
                      className={`ro-line${current.has(i) ? ' on' : ''}${ns.length ? ' has' : ''}`}
                      onClick={() => ns.length && go(ns.includes(cur) ? ns[(ns.indexOf(cur) + 1) % ns.length] : ns[0])}
                    >
                      <span className="ro-ln">{payload.firstLine + i + 1}</span>
                      <span className="ro-text">{text || ' '}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            {step && (
              <StepDetail
                key={step.n}
                step={step}
                prev={prev}
                total={steps.length}
                firstLine={payload.firstLine}
                showRemoved={showRemoved}
                setShowRemoved={setShowRemoved}
              />
            )}
          </div>
        </>
      )}

      {payload.note && (
        <div className="ro-note muted small">
          <i className="codicon codicon-info" /> {payload.note}
        </div>
      )}
    </div>
  );
}

function StatusMark({ step }: { step: QueryStep }) {
  if (step.status === 'running') return <i className="codicon codicon-loading codicon-modifier-spin qs-chip-count" />;
  if (step.status === 'pending') return <span className="qs-chip-count muted">…</span>;
  if (step.status === 'error') return <i className="codicon codicon-error qs-chip-err" title={step.error} />;
  return <span className="qs-chip-count">{step.rows !== undefined ? fmtCount(step.rows, step.unit) : ''}</span>;
}

function StepDetail(props: {
  step: QueryStep;
  prev: QueryStep | undefined;
  total: number;
  firstLine: number;
  showRemoved: boolean;
  setShowRemoved: (v: boolean) => void;
}) {
  const { step, prev, total, firstLine, showRemoved, setShowRemoved } = props;
  const last = step.n === total;
  const k = KIND_CLASS[step.kind];
  return (
    <section className={`ro-pane ro-explain qs-detail ${k}`} aria-live="polite" aria-label="This step">
      <div className="ro-explain-top">
        <span className="ro-pane-label">
          Step {step.n} of {total}
          {step.lines.length > 0 && <span className="muted"> · {fmtLines(step.lines, firstLine)}</span>}
        </span>
        <span className="qs-tags">
          {last && step.status === 'done' && (
            <span className="qs-final">
              <i className="codicon codicon-pass" /> your result
            </span>
          )}
          <span className="ro-kind">{KIND_LABEL[step.kind]}</span>
        </span>
      </div>
      <div className="ro-explain-title">
        <span className="ro-explain-n">{step.n}</span>
        <code className="qs-title">{step.title}</code>
      </div>

      {step.status === 'pending' && <p className="ro-explain-detail muted">Waiting for the steps before it.</p>}
      {step.status === 'running' && (
        <p className="ro-explain-detail muted">
          <i className="codicon codicon-loading codicon-modifier-spin" /> Running this step…
        </p>
      )}
      {step.status === 'error' && (
        <div className="qs-step-error">
          <i className="codicon codicon-error" />
          <span>{step.error}</span>
        </div>
      )}

      {step.status === 'done' && (
        <>
          {step.detail && <p className="ro-explain-detail">{step.detail}</p>}
          <Change step={step} prev={prev} />
          {step.sample && <RowsTable rows={step.sample} total={step.rows} unit={step.unit} />}
          {step.removedRows && (step.removedRows.rows.length > 0 || step.removedRows.more) && (
            <div className="qs-removed">
              <button className="qs-toggle" aria-expanded={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
                <i className={`codicon codicon-chevron-${showRemoved ? 'down' : 'right'}`} />
                {step.removedLabel ?? 'Rows this step removed'}
                {step.removed !== undefined && step.removed > 0 && <span className="qs-removed-n">{step.removed.toLocaleString()}</span>}
              </button>
              {showRemoved && <RowsTable rows={step.removedRows} total={step.removed} unit={step.unit} removed />}
            </div>
          )}
        </>
      )}

      {step.sql && (
        <details className="qs-stepsql">
          <summary>SQL run for this step</summary>
          <pre>{step.sql}</pre>
        </details>
      )}
    </section>
  );
}

/** "12 rows → 8 rows  −4" */
function Change({ step, prev }: { step: QueryStep; prev: QueryStep | undefined }) {
  if (step.rows === undefined) return null;
  const before = prev?.status === 'done' ? prev.rows : undefined;
  const sameUnit = prev?.unit === step.unit;
  const diff = before !== undefined && sameUnit ? step.rows - before : undefined;
  return (
    <div className="qs-change">
      {before !== undefined && (
        <>
          <span className="muted">{fmtCount(before, prev!.unit)}</span>
          <i className="codicon codicon-arrow-right muted" />
        </>
      )}
      <b>{fmtCount(step.rows, step.unit)}</b>
      {diff !== undefined && diff !== 0 && <span className={diff < 0 ? 'qs-minus' : 'qs-plus'}>{diff < 0 ? `−${(-diff).toLocaleString()}` : `+${diff.toLocaleString()}`}</span>}
      {diff === 0 && <span className="muted small">no change</span>}
      {before !== undefined && !sameUnit && step.unit === 'groups' && <span className="muted small">rows became groups</span>}
    </div>
  );
}

function RowsTable({ rows, total, unit, removed }: { rows: StepRows; total?: number; unit: 'rows' | 'groups'; removed?: boolean }) {
  const shown = rows.rows.length;
  return (
    <div className={`qs-table-wrap${removed ? ' removed' : ''}`}>
      <div className="qs-table-scroll">
        <table className="qs-table">
          <thead>
            <tr>
              {rows.columns.map((c, i) => (
                <th key={i} className={c.kind === 'number' ? 'num' : ''} title={c.type}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={`${rows.columns[j]?.kind === 'number' ? 'num' : ''}${v === null ? ' null' : ''}`} title={full(v)}>
                    {display(v)}
                  </td>
                ))}
              </tr>
            ))}
            {shown === 0 && (
              <tr>
                <td className="muted qs-empty" colSpan={Math.max(1, rows.columns.length)}>
                  No {unit === 'groups' ? 'groups' : 'rows'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.more && (
        <div className="muted small qs-more">
          Showing the first {shown.toLocaleString()}
          {total !== undefined ? ` of ${fmtCount(total, unit)}` : ''}
        </div>
      )}
    </div>
  );
}

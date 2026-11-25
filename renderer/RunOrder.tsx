import { useEffect, useMemo, useState } from 'react';
import type { PlanPayload, PlanStep, StepKind } from '../shared/protocol';
import { send } from './util';
import { markOpen } from './openPanels';

const KIND_LABEL: Record<StepKind, string> = {
  scan: 'read',
  join: 'join',
  filter: 'filter',
  group: 'group',
  sort: 'sort',
  topn: 'top n',
  limit: 'limit',
  distinct: 'distinct',
  window: 'window',
  combine: 'combine',
  values: 'values',
  select: 'select',
  write: 'write',
  other: 'step',
};

const PLAY_MS = 1500;

/** Rows as a short estimate: 950, 12.3k, 1.2M. */
export function fmtRows(n: number | undefined): string {
  if (n === undefined) return '';
  const r = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e9) return `${r(n / 1e9)}B`;
  if (n >= 1e6) return `${r(n / 1e6)}M`;
  if (n >= 1e3) return `${r(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "line 2", "lines 3–4", "lines 2, 5–6" (1-based, as the editor shows them). */
export function fmtLines(lines: number[], first: number): string {
  const ns = [...new Set(lines)].sort((a, b) => a - b).map((l) => first + l + 1);
  if (!ns.length) return '';
  const parts: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    parts.push(i === j ? `${ns[i]}` : `${ns[i]}–${ns[j]}`);
    i = j;
  }
  return `${ns.length > 1 ? 'lines' : 'line'} ${parts.join(', ')}`;
}

export function RunOrderView({ payload, outputId }: { payload: PlanPayload; outputId: string }) {
  const steps = payload.steps;
  const [cur, setCur] = useState(steps.length ? 1 : 0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => markOpen(outputId, payload.resultId, 'flow', payload.sql), [outputId, payload.resultId, payload.sql]);

  useEffect(() => {
    if (!playing) return;
    if (cur >= steps.length) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCur((c) => Math.min(c + 1, steps.length)), PLAY_MS);
    return () => clearTimeout(t);
  }, [playing, cur, steps.length]);

  const go = (n: number) => {
    setPlaying(false);
    setCur(Math.max(1, Math.min(steps.length, n)));
  };
  const play = () => {
    if (playing) return setPlaying(false);
    if (cur >= steps.length) setCur(1);
    setPlaying(true);
  };

  const step = steps[cur - 1] as PlanStep | undefined;
  const lines = payload.sql.split('\n');
  const stepsOnLine = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const s of steps) for (const l of s.lines) m.set(l, [...(m.get(l) ?? []), s.n]);
    return m;
  }, [steps]);
  const current = new Set(step?.lines ?? []);
  const firstOn = step?.lines.length ? Math.min(...step.lines) : -1;

  const onKey = (e: React.KeyboardEvent) => {
    if (!steps.length || ((e.target as HTMLElement).tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(cur + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(cur - 1);
    else if (e.key === 'Home') go(1);
    else if (e.key === 'End') go(steps.length);
    else return;
    e.preventDefault();
  };

  return (
    <div className={`sqlnb ro${payload.error ? ' error' : ''}`} tabIndex={0} onKeyDown={onKey} aria-label="Query Flow">
      <div className="ro-head">
        <i className="codicon codicon-type-hierarchy-sub" />
        <span className="ro-title">Query Flow</span>
        <span className="muted small">the order {payload.connection} runs this query in</span>
        <span className="spacer" />
        {steps.length > 0 && (
          <>
            <button className="tb" title="Previous step (←)" disabled={cur <= 1} onClick={() => go(cur - 1)}>
              <i className="codicon codicon-chevron-left" />
            </button>
            <button className="tb ro-play" title={playing ? 'Pause' : 'Play the steps in order'} onClick={play}>
              <i className={`codicon codicon-${playing ? 'debug-pause' : 'play'}`} />
            </button>
            <button className="tb" title="Next step (→)" disabled={cur >= steps.length} onClick={() => go(cur + 1)}>
              <i className="codicon codicon-chevron-right" />
            </button>
          </>
        )}
        <button className="tb" title="Close" onClick={() => send({ type: 'dismissAi', outputId })}>
          <i className="codicon codicon-close" />
        </button>
      </div>

      {payload.error ? (
        <div className="ro-error">
          <i className="codicon codicon-warning" /> {payload.error}
        </div>
      ) : (
        <>
          <div className="ro-main">
            <section className="ro-pane ro-sql" aria-label="Your SQL">
              <div className="ro-pane-label">Your SQL</div>
              <div className="ro-code" role="list" aria-label="SQL with the steps each line belongs to">
                {lines.map((text, i) => {
                  const ns = stepsOnLine.get(i) ?? [];
                  return (
                    <div
                      key={i}
                      role="listitem"
                      className={`ro-line${current.has(i) ? ' on' : ''}${ns.length ? ' has' : ''}`}
                      onClick={() => ns.length && go(ns.includes(cur) ? ns[(ns.indexOf(cur) + 1) % ns.length] : ns[0])}
                    >
                      <span className="ro-ln">{payload.firstLine + i + 1}</span>
                      <span className="ro-badges">
                        {ns.map((n) => (
                          <span key={n} className={`ro-badge${n === cur ? ' on' : n < cur ? ' done' : ''}`} title={steps[n - 1].title}>
                            {n}
                          </span>
                        ))}
                      </span>
                      <span className="ro-text">{text || ' '}</span>
                      {i === firstOn && step && (
                        <span className={`ro-tag k-${step.kind}`}>
                          <i className="codicon codicon-arrow-left" />
                          step {step.n}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {step && <Explain step={step} steps={steps} firstLine={payload.firstLine} onPick={go} />}

            <section className="ro-pane ro-flow" aria-label="Flow">
              <div className="ro-pane-label">
                Flow <span className="muted">· rows move down</span>
              </div>
              <Graph steps={steps} cur={cur} onPick={go} />
            </section>
          </div>

          <div className="ro-strips">
            <div className="ro-strip">
              <span className="ro-strip-label">You write</span>
              {payload.written.map((w, i) => (
                <span key={i} className="ro-chip written">
                  {w}
                </span>
              ))}
            </div>
            <div className="ro-strip">
              <span className="ro-strip-label">It runs</span>
              {steps.map((s) => (
                <button key={s.n} className={`ro-chip step k-${s.kind}${s.n === cur ? ' on' : s.n < cur ? ' done' : ''}`} onClick={() => go(s.n)} title={s.title}>
                  <span className="ro-chip-n">{s.n}</span> {chipLabel(s)}
                </button>
              ))}
            </div>
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

/** The middle pane: what the current step does, in words, with where it sits in the flow. */
function Explain({ step, steps, firstLine, onPick }: { step: PlanStep; steps: PlanStep[]; firstLine: number; onPick: (n: number) => void }) {
  const from = step.inputs.map((n) => steps[n - 1]).filter(Boolean);
  const to = steps.filter((s) => s.inputs.includes(step.n));
  const link = (s: PlanStep) => (
    <button key={s.n} className={`ro-link k-${s.kind}`} onClick={() => onPick(s.n)}>
      <span className="ro-link-n">{s.n}</span>
      {s.title}
    </button>
  );
  return (
    <section className={`ro-pane ro-explain k-${step.kind}`} aria-live="polite" aria-label="What this step does">
      <div className="ro-explain-top">
        <span className="ro-pane-label">
          Step {step.n} of {steps.length}
        </span>
        <span className="ro-kind">{KIND_LABEL[step.kind]}</span>
      </div>
      <div className="ro-explain-title">
        <span className="ro-explain-n">{step.n}</span>
        <span>{step.title}</span>
      </div>
      {step.detail && <p className="ro-explain-detail">{step.detail}</p>}
      <dl className="ro-facts">
        {step.lines.length > 0 && (
          <>
            <dt>
              <i className="codicon codicon-code" /> From your SQL
            </dt>
            <dd>{fmtLines(step.lines, firstLine)}</dd>
          </>
        )}
        <dt>
          <i className="codicon codicon-arrow-down" /> Takes rows from
        </dt>
        <dd>{from.length ? from.map(link) : <span className="muted">{step.kind === 'scan' ? 'the table on disk' : 'nothing before it'}</span>}</dd>
        <dt>
          <i className="codicon codicon-arrow-right" /> Passes rows to
        </dt>
        <dd>{to.length ? to.map(link) : <span className="muted">your result</span>}</dd>
        {step.rows !== undefined && (
          <>
            <dt>
              <i className="codicon codicon-graph-line" /> Rows out
            </dt>
            <dd>
              about <b>{fmtRows(step.rows)}</b> <span className="muted">(planner's estimate)</span>
            </dd>
          </>
        )}
      </dl>
      {step.inferred && (
        <div className="ro-inferred">
          <i className="codicon codicon-info" /> The plan does not list this as its own step; the database does it as part of another step.
        </div>
      )}
      <div className="ro-progress" role="tablist" aria-label="Steps">
        {steps.map((s) => (
          <button
            key={s.n}
            role="tab"
            aria-selected={s.n === step.n}
            className={`k-${s.kind}${s.n === step.n ? ' on' : s.n < step.n ? ' done' : ''}`}
            title={`${s.n}. ${s.title}`}
            onClick={() => onPick(s.n)}
          />
        ))}
      </div>
    </section>
  );
}

function chipLabel(s: PlanStep): string {
  const t = s.title.replace(/^Read /, '').replace(/^Join (.+) \+ (.+)$/, '$1 ⋈ $2');
  return t.length > 26 ? `${t.slice(0, 25)}…` : t;
}

// ---------- Graph ----------

const NW = 214;
const NH = 44;
const GX = 16;
const GY = 30;

interface Pos {
  x: number;
  y: number;
}

/** Leaves on top, the final step at the bottom; each step sits under the steps it reads. */
export function layout(steps: PlanStep[]): { pos: Map<number, Pos>; width: number; height: number } {
  const level = new Map<number, number>();
  for (const s of steps) level.set(s.n, s.inputs.length ? Math.max(...s.inputs.map((i) => level.get(i) ?? 0)) + 1 : 0);
  const used = new Set(steps.flatMap((s) => s.inputs));
  const roots = steps.filter((s) => !used.has(s.n));
  const byN = new Map(steps.map((s) => [s.n, s]));
  const col = new Map<number, number>();
  let next = 0;
  const place = (n: number): number => {
    if (col.has(n)) return col.get(n)!;
    const s = byN.get(n)!;
    const xs = s.inputs.map(place);
    const c = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : next++;
    col.set(n, c);
    return c;
  };
  roots.forEach((r) => place(r.n));
  const maxLevel = Math.max(0, ...level.values());
  const pos = new Map<number, Pos>();
  for (const s of steps) pos.set(s.n, { x: 8 + (col.get(s.n) ?? 0) * (NW + GX), y: 8 + (level.get(s.n) ?? 0) * (NH + GY) });
  return { pos, width: 16 + Math.max(1, next) * (NW + GX) - GX, height: 16 + (maxLevel + 1) * (NH + GY) - GY };
}

function Graph({ steps, cur, onPick }: { steps: PlanStep[]; cur: number; onPick: (n: number) => void }) {
  const { pos, width, height } = useMemo(() => layout(steps), [steps]);
  const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  return (
    <div className="ro-graph">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="How the steps feed each other">
        <defs>
          <marker id="ro-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="ro-arrowhead" />
          </marker>
        </defs>
        {steps.flatMap((s) =>
          s.inputs.map((i) => {
            const a = pos.get(i)!;
            const b = pos.get(s.n)!;
            const x1 = a.x + NW / 2;
            const y1 = a.y + NH;
            const x2 = b.x + NW / 2;
            const y2 = b.y;
            const my = (y1 + y2) / 2;
            const src = steps[i - 1];
            const active = s.n === cur || i === cur;
            return (
              <g key={`${i}-${s.n}`} className={`ro-edge${active ? ' on' : i < cur ? ' done' : ''}`}>
                <path d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`} markerEnd="url(#ro-arrow)" />
                {src?.rows !== undefined && (
                  <text x={(x1 + x2) / 2 + 7} y={my + 4} className="ro-edge-label">
                    {fmtRows(src.rows)} rows
                  </text>
                )}
              </g>
            );
          }),
        )}
        {steps.map((s) => {
          const p = pos.get(s.n)!;
          const state = s.n === cur ? ' on' : s.n < cur ? ' done' : '';
          return (
            <g key={s.n} className={`ro-node k-${s.kind}${state}${s.inferred ? ' inferred' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => onPick(s.n)}>
              <title>{`${s.n}. ${s.title}${s.detail ? `\n${s.detail}` : ''}`}</title>
              <rect width={NW} height={NH} rx={7} />
              <rect className="ro-node-bar" width={4} height={NH} rx={2} />
              <circle cx={21} cy={NH / 2} r={10.5} className="ro-node-n" />
              <text x={21} y={NH / 2 + 4} textAnchor="middle" className="ro-node-num">
                {s.n}
              </text>
              <text x={38} y={19} className="ro-node-title">
                {fit(s.title, 25)}
              </text>
              <text x={38} y={34} className="ro-node-sub">
                {KIND_LABEL[s.kind]}
                {s.rows !== undefined ? ` · ~${fmtRows(s.rows)} rows` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { isSchemaChange, type AiPayload, type AiStep } from '../shared/protocol';
import { copyText, send } from './util';

const TITLES: Record<AiPayload['kind'], string> = {
  explain: 'Explanation',
  optimize: 'Optimization',
  fix: 'Suggested fix',
  result: 'About this result',
  generate: 'Generated SQL',
};

export function AiView({ payload, outputId }: { payload: AiPayload; outputId: string }) {
  const html = useMemo(() => {
    let md = payload.markdown;
    // The generated SQL goes into its own cell, so hide it here once known.
    if (payload.kind === 'generate' && payload.status === 'done' && payload.sql) md = md.replace(/```[\s\S]*?```/g, '').trim();
    return DOMPurify.sanitize(marked.parse(md || '', { async: false, gfm: true, breaks: false }) as string);
  }, [payload.markdown, payload.kind, payload.status, payload.sql]);

  const busy = payload.status === 'streaming';
  const setup = payload.status === 'error' && !payload.model;
  const canApply = payload.status === 'done' && !!payload.sql && (payload.kind === 'fix' || payload.kind === 'optimize');

  return (
    <div className={`sqlnb ai ${payload.status}${setup ? " setup" : ""}`} aria-busy={busy}>
      <div className="ai-head">
        <i className="codicon codicon-sparkle" />
        <span className="ai-title">{setup ? 'Set up AI' : TITLES[payload.kind]}</span>
        {busy && <i className="codicon codicon-loading codicon-modifier-spin muted" />}
        <span className="spacer" />
        <span className="muted small">{payload.model}</span>
        {payload.kind !== 'generate' && (
          <button className="tb" title="Dismiss" onClick={() => send({ type: 'dismissAi', outputId })}>
            <i className="codicon codicon-close" />
          </button>
        )}
      </div>
      <Trace payload={payload} />
      {busy && !payload.markdown ? (
        payload.steps?.length ? null : (
          <div className="ai-skeleton">
            <span />
            <span />
            <span />
          </div>
        )
      ) : (
        <div className="ai-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {payload.notice && (
        <div className="ai-notice muted">
          <i className="codicon codicon-info" /> {payload.notice}
        </div>
      )}
      {(canApply || payload.note || payload.status === 'error') && (
        <div className="ai-actions">
          {canApply && (
            <>
              <button className="btn primary" onClick={() => send({ type: 'applySql', outputId, sql: payload.sql! })}>
                {isSchemaChange(payload.sql!) ? (
                  <>
                    <i className="codicon codicon-add" /> Add as new cell
                  </>
                ) : (
                  <>
                    <i className="codicon codicon-check" /> Apply to cell
                  </>
                )}
              </button>
              <button className="btn" onClick={() => copyText(payload.sql!)}>
                <i className="codicon codicon-copy" /> Copy SQL
              </button>
            </>
          )}
          {payload.note && (
            <>
              <span className="muted">
                <i className="codicon codicon-arrow-down" /> {payload.note}
              </span>
              <button className="btn" onClick={() => send({ type: 'runCell', outputId })}>
                <i className="codicon codicon-play" /> Run it
              </button>
            </>
          )}
          {payload.status === 'error' && (
            <button className={setup ? 'btn primary' : 'btn'} onClick={() => send({ type: 'configureAi' })}>
              <i className="codicon codicon-settings-gear" /> Configure AI
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Agent mode: the plan and every step the model took. Open while it works,
 * folded into "How this answer was made" once the answer is in.
 */
function Trace({ payload }: { payload: AiPayload }) {
  const todos = payload.todos ?? [];
  const steps = (payload.steps ?? []).filter((s) => s.kind !== 'plan');
  if (!todos.length && !steps.length) return null;
  const busy = payload.status === 'streaming';
  const current = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  const checks = steps.filter((s) => s.kind === 'tool').length;
  return (
    <details className={`ai-trace${busy ? ' busy' : ''}`} open={busy || undefined}>
      <summary>
        <i className="codicon codicon-chevron-right chev" />
        <span className="ai-trace-title">{busy ? `${current?.title ?? 'Planning'}…` : 'How this answer was made'}</span>
        <span className="muted small">
          {todos.length ? `plan of ${todos.length} · ` : ''}
          {checks} {checks === 1 ? 'step' : 'steps'}
        </span>
      </summary>
      {todos.length > 0 && (
        <ul className="ai-todos" aria-label="Plan">
          {todos.map((t, i) => (
            <li key={i} className={t.status}>
              <i className={`codicon ${t.status === 'completed' ? 'codicon-pass-filled' : t.status === 'in_progress' ? 'codicon-circle-large-filled' : 'codicon-circle-large'}`} />
              <span>{t.content}</span>
            </li>
          ))}
        </ul>
      )}
      {steps.length > 0 && (
        <ol className="ai-steps">
          {steps.map((s) => (
            <Step key={s.id} step={s} />
          ))}
        </ol>
      )}
    </details>
  );
}

const STEP_ICON: Record<AiStep['status'], string> = {
  running: 'codicon-loading codicon-modifier-spin',
  done: 'codicon-check',
  error: 'codicon-warning',
};

function Step({ step }: { step: AiStep }) {
  const icon = step.kind === 'thought' && step.status !== 'running' ? 'codicon-comment' : STEP_ICON[step.status];
  const head = (
    <>
      <i className={`codicon ${icon}`} />
      <span>{step.title}</span>
    </>
  );
  if (!step.input && !step.output) return <li className={`ai-step ${step.status}`}>{head}</li>;
  return (
    <li className={`ai-step ${step.status}`}>
      <details>
        <summary>{head}</summary>
        {step.input && <pre className="ai-io in">{step.input}</pre>}
        {step.output && <pre className="ai-io">{step.output}</pre>}
      </details>
    </li>
  );
}

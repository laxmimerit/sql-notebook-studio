import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { isSchemaChange, type AiPayload } from '../shared/protocol';
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
      {busy && !payload.markdown ? (
        <div className="ai-skeleton">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="ai-body" dangerouslySetInnerHTML={{ __html: html }} />
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

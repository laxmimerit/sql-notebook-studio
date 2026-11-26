// Which Query Flow and Query Steps cards are open, so a result's buttons can
// show that theirs is open (a second click closes it). All outputs of a
// notebook share one webview, so a module-level map sees every card.

import { useSyncExternalStore } from 'react';
import { sameStatement } from '../shared/protocol';

export type PanelKind = 'flow' | 'steps';

interface Panel {
  resultId: string;
  kind: PanelKind;
  sql: string;
}

/** By the card's output id. */
const panels = new Map<string, Panel>();
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

/** Records a card as open; returns the function that records it as closed. */
export function markOpen(outputId: string, resultId: string | undefined, kind: PanelKind, sql: string): () => void {
  if (!resultId) return () => undefined;
  panels.set(outputId, { resultId, kind, sql });
  changed();
  return () => {
    if (panels.delete(outputId)) changed();
  };
}

export function isOpen(resultId: string, kind: PanelKind, sql: string): boolean {
  for (const p of panels.values()) if (p.resultId === resultId && p.kind === kind && sameStatement(p.sql, sql)) return true;
  return false;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while this result's Query Flow (or Query Steps) card is open. */
export function useOpen(resultId: string, kind: PanelKind, sql: string): boolean {
  return useSyncExternalStore(subscribe, () => isOpen(resultId, kind, sql));
}

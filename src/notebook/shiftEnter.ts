// Shift+Enter: run the cell, select the next one, and once the result is
// drawn put the cell that was run one third of the way down the window. Its
// result shows below it, and the top third keeps the end of the cell before
// it on screen (useful for recordings).
//
// VS Code has no API to scroll a notebook to a pixel position, so the results
// renderer does the scroll (see renderer/scroll.ts).

import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';
import { AI_MIME, RESULT_MIME, type HostMessage } from '../../shared/protocol';

/** How far down the window the cell that was run goes, for each `sqlNotebook.shiftEnterScroll` value. */
const RATIO: Record<string, number> = { top: 0, topThird: 1 / 3, middle: 1 / 2 };
/** `whenNeeded`: the next cell must start above the bottom quarter of the window. */
const FREE_BELOW = 1 / 4;

/** Our output on a cell (a query result or an AI answer), if it has one. */
function ourOutputId(cell: vscode.NotebookCell | undefined): string | undefined {
  const o = cell?.outputs.find((x) => x.metadata?.sqlnbId && x.items.some((i) => i.mime === RESULT_MIME || i.mime === AI_MIME));
  return o ? String(o.metadata!.sqlnbId) : undefined;
}

/** Resolves when the cell's run finishes (or right away if it already did). */
function runEnd(cell: vscode.NotebookCell, before: number | undefined, token: { cancelled: boolean }): Promise<boolean> {
  const done = () => {
    const end = cell.executionSummary?.timing?.endTime;
    return end !== undefined && end !== before;
  };
  if (done()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      sub.dispose();
      closed.dispose();
      clearInterval(poll);
      resolve(ok);
    };
    const sub = vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook === cell.notebook && done()) finish(true);
    });
    const closed = vscode.workspace.onDidCloseNotebookDocument((nb) => nb === cell.notebook && finish(false));
    // A newer Shift+Enter takes over.
    const poll = setInterval(() => token.cancelled && finish(false), 250);
  });
}

export function registerShiftEnter(messaging: vscode.NotebookRendererMessaging): vscode.Disposable {
  let current = { cancelled: false };

  return vscode.commands.registerCommand('sqlNotebook.runAndSelectBelow', async () => {
    const ed = vscode.window.activeNotebookEditor;
    const mode = vscode.workspace.getConfiguration('sqlNotebook').get<string>('shiftEnterScroll', 'topThird');
    const fit = mode === 'whenNeeded';
    const ratio = fit ? FREE_BELOW : (RATIO[mode] ?? RATIO.topThird);
    const cell = ed && ed.notebook.notebookType === NOTEBOOK_TYPE ? ed.notebook.cellAt(ed.selection.start) : undefined;
    const before = cell?.executionSummary?.timing?.endTime;

    await vscode.commands.executeCommand('notebook.cell.executeAndSelectBelow');
    if (!ed || !cell || cell.kind !== vscode.NotebookCellKind.Code || mode === 'off') return;

    current.cancelled = true;
    const token = (current = { cancelled: false });
    if (!(await runEnd(cell, before, token)) || token.cancelled) return;

    const post = (m: HostMessage) => messaging.postMessage(m, ed);
    const next = cell.index + 1 < ed.notebook.cellCount ? ed.notebook.cellAt(cell.index + 1) : undefined;
    if (fit && !next) return;
    const outputId = ourOutputId(cell);
    if (outputId) {
      await post({ type: 'placeAfterRun', outputId, nextOutputId: ourOutputId(next), ratio, fit });
      return;
    }
    // No result to measure from: with whenNeeded, VS Code has already shown
    // the next cell, which is all that mode asks for.
    if (fit) return;
    // No result to measure from (an empty cell): put the cell that was run at
    // the top, then let the renderer lower it.
    // This needs the renderer to be loaded, which it is once any cell shows a result.
    if (!(await post({ type: 'ping' }))) return;
    ed.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1), vscode.NotebookEditorRevealType.AtTop);
    setTimeout(() => !token.cancelled && void post({ type: 'lowerTop', ratio }), 60);
  });
}

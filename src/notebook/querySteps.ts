// Query Steps: runs a SELECT one clause at a time (FROM, JOIN, WHERE, GROUP BY,
// HAVING, SELECT, DISTINCT, ORDER BY, LIMIT) and shows the rows after each,
// with the rows each step dropped. See src/db/steps.ts.

import * as vscode from 'vscode';
import { STEPS_MIME, type StepsPayload } from '../../shared/protocol';
import { splitStatements, type Statement } from '../db/splitter';
import { SAMPLE_ROWS, linesIn, planQuerySteps, runQuerySteps, NOT_SELECT } from '../db/steps';
import { findVariables, substitute } from '../util/variables';
import { isSqlLanguage } from './serializer';
import { cursorOffset } from './runOrder';
import { outputId, type Kernels } from './kernels';

const SELECTS = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(select|with)\b/i;

export const STEPS_NOTE = 'Each step runs your query up to that clause, so you see real rows. Only SELECT queries are run.';

export class QuerySteps {
  constructor(private readonly kernels: Kernels) {}

  /** `sql`: the statement to step through (from a result's Steps button); else the one under the cursor. */
  async show(arg?: vscode.NotebookCell, sql?: string) {
    const editor = vscode.window.activeNotebookEditor;
    const cell = arg ?? (editor ? editor.notebook.cellAt(editor.selection.start) : undefined);
    if (!cell || cell.notebook.notebookType !== 'sqlnb' || !isSqlLanguage(cell.document.languageId)) return;
    const text = cell.document.getText().replace(/\r\n?/g, '\n');
    if (!text.trim()) return;
    const nb = cell.notebook;
    const conn = this.kernels.connectionFor(nb, cell);
    if (!conn) return;

    const statements = splitStatements(text, conn.driver);
    const wanted = sql?.trim().replace(/;\s*$/, '');
    const stmt = (wanted && statements.find((s) => s.sql.trim().replace(/;\s*$/, '') === wanted)) || pickSelect(statements, cursorOffset(cell));
    const shown = (stmt?.sql ?? text.trim()).replace(/;\s*$/, '');
    const payload: StepsPayload = {
      v: 1,
      id: outputId(),
      connection: conn.name,
      driver: conn.driver,
      sql: shown,
      firstLine: stmt?.line ?? 0,
      steps: [],
      sampleRows: SAMPLE_ROWS,
      note: STEPS_NOTE,
    };

    let plain = shown;
    if (stmt) {
      const names = findVariables(plain);
      if (names.length) {
        const values = await this.kernels.variablesFor(nb, names);
        if (!values) return;
        plain = substitute(plain, values);
      }
    }
    const plan = stmt ? planQuerySteps(plain, conn.driver) : { error: NOT_SELECT };
    // Lines come from the statement as written; variables can change offsets.
    const asWritten = plain === shown ? plan : planQuerySteps(shown, conn.driver);
    const sameShape = 'steps' in plan && 'steps' in asWritten && asWritten.steps.length === plan.steps.length;
    if ('error' in plan) payload.error = plan.error;
    else payload.running = true;

    await this.kernels.withExecution(nb, cell, async (exec) => {
      // Replace an earlier Query Steps; keep results, Query Flow and AI answers.
      const keep = cell.outputs.filter((o) => !o.items.some((i) => i.mime === STEPS_MIME));
      const item = () => vscode.NotebookCellOutputItem.json(payload, STEPS_MIME);
      const output = new vscode.NotebookCellOutput([item()], { sqlnbId: payload.id });
      await exec.replaceOutput([...keep, output]);
      if ('error' in plan) return;

      const cfg = vscode.workspace.getConfiguration('sqlNotebook');
      const timeoutSec = cfg.get<number>('queryTimeoutSeconds', 0);
      let stopped = false;
      let pushing = Promise.resolve();
      const push = () => {
        pushing = pushing.then(() => exec.replaceOutputItems(item(), output)).catch(() => undefined);
        return pushing;
      };
      try {
        const session = await this.kernels.session(nb, conn);
        const sub = exec.token.onCancellationRequested(() => {
          stopped = true;
          void session.cancel().catch(() => undefined);
        });
        try {
          payload.steps = await runQuerySteps(session, plan, conn.driver, {
            sampleRows: SAMPLE_ROWS,
            linesOf: (span) => (sameShape ? linesIn(shown, asWritten.steps[plan.steps.findIndex((s) => s.span === span)]?.span ?? span) : []),
            onUpdate: (steps) => {
              payload.steps = steps;
              void push();
            },
            stopped: () => stopped || exec.token.isCancellationRequested,
            timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : 0,
          });
        } finally {
          sub.dispose();
        }
      } catch (e) {
        payload.error = `Can't connect to "${conn.name}": ${e instanceof Error ? e.message : String(e)}`;
      }
      payload.running = false;
      await push();
    });
  }
}

/** The SELECT under the cursor, else the first SELECT in the cell. */
export function pickSelect(statements: Statement[], cursor?: number): Statement | undefined {
  const selects = statements.filter((s) => SELECTS.test(s.sql));
  if (cursor !== undefined) {
    const at = [...selects].reverse().find((s) => s.offset <= cursor);
    if (at && cursor <= at.offset + at.sql.length + 1) return at;
  }
  return selects[0];
}

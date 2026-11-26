// Query Flow: asks the database how it plans to run a statement (EXPLAIN,
// never the query itself) and shows the steps next to the SQL as written.

import * as vscode from 'vscode';
import { PLAN_MIME, RESULT_MIME, sameStatement, type PlanPayload } from '../../shared/protocol';
import { PLAN_DRIVERS, planSteps } from '../db/plan';
import { splitStatements, type Statement } from '../db/splitter';
import { DRIVERS } from '../db/types';
import { findVariables, substitute } from '../util/variables';
import { isSqlLanguage } from './serializer';
import { outputId, setOutputs, type Kernels } from './kernels';

/** Statements EXPLAIN can plan: queries and writes, not DDL or session commands. */
const PLANNABLE = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*\(?\s*(select|with|insert|update|delete|replace|values|table)\b/i;

export const NOTE = "Estimated by the database's planner. The query did not run.";

export class RunOrder {
  constructor(private readonly kernels: Kernels) {}

  /**
   * `sql`: the statement to explain (from a result's Query Flow button); else the one under the cursor.
   * `toggle`: from a button: if this statement's Query Flow is open already, close it.
   */
  async show(arg?: vscode.NotebookCell, sql?: string, toggle = false) {
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
    const stmt = (wanted && statements.find((s) => s.sql.trim().replace(/;\s*$/, '') === wanted)) || pickStatement(statements, cursorOffset(cell));
    const payload: PlanPayload = {
      v: 1,
      id: outputId(),
      connection: conn.name,
      driver: conn.driver,
      sql: stmt?.sql ?? text.trim(),
      firstLine: stmt?.line ?? 0,
      steps: [],
      written: [],
      note: NOTE,
      resultId: resultIdOf(cell),
    };
    if (toggle) {
      const open = payloadOf<PlanPayload>(cell, PLAN_MIME);
      if (open && sameStatement(open.sql, payload.sql)) {
        await closeOutput(this.kernels, nb, cell, PLAN_MIME);
        return;
      }
    }

    if (!PLAN_DRIVERS.has(conn.driver)) {
      payload.error = `Query Flow is not available for ${DRIVERS[conn.driver]?.label ?? conn.driver} yet. It works with PostgreSQL, SQLite and DuckDB.`;
    } else if (!stmt) {
      payload.error = 'Nothing to show: Query Flow works for SELECT, WITH, INSERT, UPDATE and DELETE statements.';
    } else {
      let plain = stmt.sql.replace(/;\s*$/, '');
      const names = findVariables(plain);
      if (names.length) {
        const values = await this.kernels.variablesFor(nb, names);
        if (!values) return;
        plain = substitute(plain, values);
      }
      try {
        const session = await this.kernels.session(nb, conn);
        const raw = await session.planJson!(plain);
        const built = planSteps(conn.driver, raw, stmt.sql);
        payload.steps = built.steps;
        payload.written = built.written;
        if (!built.steps.length) payload.error = 'The database returned an empty plan for this statement.';
      } catch (e) {
        payload.error = `The database could not plan this statement: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    await this.kernels.withExecution(nb, cell, async (exec) => {
      // Replace an earlier Query Flow where it is; keep results, Query Steps and AI answers.
      await setOutputs(exec, cell, withOutput(cell, PLAN_MIME, new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, PLAN_MIME)], { sqlnbId: payload.id })));
    });
  }
}

/** The cell's outputs with the one of this kind replaced where it is, or added at the end. */
export function withOutput(cell: vscode.NotebookCell, mime: string, output: vscode.NotebookCellOutput): vscode.NotebookCellOutput[] {
  const outputs = [...cell.outputs];
  const i = outputs.findIndex((o) => o.items.some((x) => x.mime === mime));
  if (i < 0) outputs.push(output);
  else outputs[i] = output;
  return outputs;
}

/** The payload of the cell's output of this kind, if it has one. */
export function payloadOf<T>(cell: vscode.NotebookCell, mime: string): T | undefined {
  for (const o of cell.outputs) {
    const item = o.items.find((i) => i.mime === mime);
    if (item) {
      try {
        return JSON.parse(new TextDecoder().decode(item.data)) as T;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The id of the cell's result output, so the result's buttons can show what is open. */
export function resultIdOf(cell: vscode.NotebookCell): string | undefined {
  const id = cell.outputs.find((o) => o.items.some((i) => i.mime === RESULT_MIME))?.metadata?.sqlnbId;
  return typeof id === 'string' ? id : undefined;
}

/** Closes the cell's output of this kind (Query Flow or Query Steps). */
export async function closeOutput(kernels: Kernels, nb: vscode.NotebookDocument, cell: vscode.NotebookCell, mime: string): Promise<void> {
  await kernels.withExecution(nb, cell, async (exec) => {
    const next = cell.outputs.filter((o) => !o.items.some((i) => i.mime === mime));
    if (next.length !== cell.outputs.length) await setOutputs(exec, cell, next);
  });
}

export function cursorOffset(cell: vscode.NotebookCell): number | undefined {
  const ed = vscode.window.visibleTextEditors.find((e) => e.document === cell.document);
  if (!ed) return undefined;
  // Count from normalized text: the splitter drops \r.
  return cell.document.getText(new vscode.Range(new vscode.Position(0, 0), ed.selection.active)).replace(/\r\n?/g, '\n').length;
}

/** The statement under the cursor if it can be planned, else the first one that can. */
export function pickStatement(statements: Statement[], cursor?: number): Statement | undefined {
  const plannable = statements.filter((s) => PLANNABLE.test(s.sql));
  if (cursor !== undefined) {
    const at = [...plannable].reverse().find((s) => s.offset <= cursor);
    if (at && cursor <= at.offset + at.sql.length + 1) return at;
  }
  return plannable[0];
}

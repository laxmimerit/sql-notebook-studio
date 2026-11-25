// Query Flow: asks the database how it plans to run a statement (EXPLAIN,
// never the query itself) and shows the steps next to the SQL as written.

import * as vscode from 'vscode';
import { PLAN_MIME, type PlanPayload } from '../../shared/protocol';
import { PLAN_DRIVERS, planSteps } from '../db/plan';
import { splitStatements, type Statement } from '../db/splitter';
import { DRIVERS } from '../db/types';
import { findVariables, substitute } from '../util/variables';
import { isSqlLanguage } from './serializer';
import { outputId, type Kernels } from './kernels';

/** Statements EXPLAIN can plan: queries and writes, not DDL or session commands. */
const PLANNABLE = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*\(?\s*(select|with|insert|update|delete|replace|values|table)\b/i;

export const NOTE = "Estimated by the database's planner. The query did not run.";

export class RunOrder {
  constructor(private readonly kernels: Kernels) {}

  /** `sql`: the statement to explain (from a result's Query Flow button); else the one under the cursor. */
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
    };

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
      // Replace an earlier Query Flow; keep results and AI answers.
      const keep = cell.outputs.filter((o) => !o.items.some((i) => i.mime === PLAN_MIME));
      await exec.replaceOutput([...keep, new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, PLAN_MIME)], { sqlnbId: payload.id })]);
    });
  }
}

function cursorOffset(cell: vscode.NotebookCell): number | undefined {
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

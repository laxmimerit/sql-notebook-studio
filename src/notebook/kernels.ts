// One notebook controller ("kernel") per connection, so VS Code's kernel
// picker is the connection picker. Cells run one at a time, in order.

import * as vscode from 'vscode';
import type { ConnectionConfig, Session } from '../db/types';
import { CancelledError, DRIVERS, QueryFailure } from '../db/types';
import { BUILTIN_SCRATCH, describe, type ConnectionStore } from '../connections/store';
import { isConnectionLost, ownerFor, type SessionManager } from '../db/manager';
import { splitStatements } from '../db/splitter';
import { classify } from '../db/safety';
import { findVariables, substitute } from '../util/variables';
import { AI_LANGUAGE, NOTEBOOK_TYPE, SQL_LANGUAGE } from './serializer';
import { RESULT_MIME, type ResultPayload } from '../../shared/protocol';
import type { AiService } from '../ai/service';
import type { SchemaCache } from '../schema/cache';

export class Kernels implements vscode.Disposable {
  private controllers = new Map<string, vscode.NotebookController>();
  private selected = new Map<string, string>();
  private running = new Map<string, Set<Session>>();
  private order = new Map<string, number>();
  private disposables: vscode.Disposable[] = [];
  private sessionValues = new Map<string, Record<string, string>>();
  private readonly ranOk = new vscode.EventEmitter<string>();
  /** Fires with a connection id after a cell ran on it without error, so the explorer can recheck it. */
  readonly onDidRunOk = this.ranOk.event;
  ai!: AiService;

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: SessionManager,
    private readonly schema: SchemaCache,
  ) {
    this.sync();
    this.disposables.push(
      store.onDidChange(() => this.sync()),
      vscode.workspace.onDidOpenNotebookDocument((nb) => this.setAffinity(nb)),
      vscode.workspace.onDidCloseNotebookDocument((nb) => {
        this.selected.delete(nb.uri.toString());
        void this.manager.dropOwner(nb.uri.toString());
      }),
    );
    vscode.workspace.notebookDocuments.forEach((nb) => this.setAffinity(nb));
    // VS Code only suggests a preferred kernel; pick the notebook's connection so Run works at once.
    this.disposables.push(vscode.window.onDidChangeVisibleNotebookEditors((eds) => this.autoSelect(eds)));
    this.autoSelect(vscode.window.visibleNotebookEditors);
  }

  private autoSelect(editors: readonly vscode.NotebookEditor[]) {
    for (const ed of editors) {
      if (ed.notebook.notebookType !== NOTEBOOK_TYPE) continue;
      setTimeout(() => {
        if (!this.selected.has(ed.notebook.uri.toString()) && !ed.notebook.isClosed) void this.ensureController(ed.notebook);
      }, 400);
    }
  }

  dispose() {
    this.controllers.forEach((c) => c.dispose());
    this.disposables.forEach((d) => d.dispose());
    this.ranOk.dispose();
  }

  private sync() {
    const conns = this.store.list();
    for (const [id, ctrl] of this.controllers) {
      if (!conns.some((c) => c.id === id)) {
        ctrl.dispose();
        this.controllers.delete(id);
      }
    }
    for (const conn of conns) {
      let ctrl = this.controllers.get(conn.id);
      if (!ctrl) {
        ctrl = vscode.notebooks.createNotebookController(`sqlnb-${conn.id}`, NOTEBOOK_TYPE, conn.name);
        ctrl.supportedLanguages = [SQL_LANGUAGE, AI_LANGUAGE];
        ctrl.supportsExecutionOrder = true;
        const id = conn.id;
        ctrl.executeHandler = (cells, nb) => this.execute(cells, nb, id);
        ctrl.interruptHandler = (nb) => this.interrupt(nb);
        ctrl.onDidChangeSelectedNotebooks(({ notebook, selected }) => this.onSelected(notebook, id, selected));
        this.controllers.set(conn.id, ctrl);
      }
      // The notebook toolbar shows the label, so it names the database type too: "Sample Shop · SQLite".
      const kind = DRIVERS[conn.driver].label.split(' / ')[0];
      ctrl.label = conn.name.toLowerCase().includes(kind.toLowerCase()) ? conn.name : `${conn.name} · ${kind}`;
      ctrl.description = DRIVERS[conn.driver].label;
      ctrl.detail = [describe(conn), conn.env && conn.env !== 'none' ? conn.env : '', conn.readOnly ? 'read-only' : ''].filter(Boolean).join(' · ');
    }
    vscode.workspace.notebookDocuments.forEach((nb) => this.setAffinity(nb));
  }

  private setAffinity(nb: vscode.NotebookDocument) {
    if (nb.notebookType !== NOTEBOOK_TYPE) return;
    const name = nb.metadata?.connection as string | undefined;
    const conn = (name && this.store.byName(name)) || this.store.get(BUILTIN_SCRATCH);
    if (!conn) return;
    this.controllers.get(conn.id)?.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
  }

  private onSelected(nb: vscode.NotebookDocument, connId: string, selected: boolean) {
    const key = nb.uri.toString();
    if (!selected) {
      if (this.selected.get(key) === connId) this.selected.delete(key);
      return;
    }
    this.selected.set(key, connId);
    const conn = this.store.get(connId);
    if (conn && nb.metadata?.connection !== conn.name) {
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...nb.metadata, connection: conn.name })]);
      void vscode.workspace.applyEdit(edit);
    }
  }

  controllerFor(nb: vscode.NotebookDocument): vscode.NotebookController | undefined {
    const id = this.selected.get(nb.uri.toString());
    return id ? this.controllers.get(id) : undefined;
  }

  /** Selects the controller for a connection, so cells can be executed. */
  async ensureController(nb: vscode.NotebookDocument, conn?: ConnectionConfig): Promise<vscode.NotebookController | undefined> {
    const current = this.controllerFor(nb);
    if (current && (!conn || this.selected.get(nb.uri.toString()) === conn.id)) return current;
    const target = conn ?? this.notebookConnection(nb);
    if (!target) return undefined;
    const editor = vscode.window.visibleNotebookEditors.find((e) => e.notebook === nb);
    if (editor) {
      await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: `sqlnb-${target.id}`, extension: 'kgptalkie.sql-notebook-studio' });
    }
    return this.controllerFor(nb) ?? this.controllers.get(target.id);
  }

  notebookConnection(nb: vscode.NotebookDocument): ConnectionConfig | undefined {
    const id = this.selected.get(nb.uri.toString());
    if (id) return this.store.get(id);
    const name = nb.metadata?.connection as string | undefined;
    return (name && this.store.byName(name)) || this.store.get(BUILTIN_SCRATCH);
  }

  /** The connection a cell runs on: its own override, else the notebook's. */
  connectionFor(nb: vscode.NotebookDocument, cell?: vscode.NotebookCell): ConnectionConfig | undefined {
    const name = cell?.metadata?.connection as string | undefined;
    if (name) {
      const c = this.store.byName(name);
      if (c) return c;
    }
    return this.notebookConnection(nb);
  }

  session(nb: vscode.NotebookDocument, conn: ConnectionConfig): Promise<Session> {
    return this.manager.get(ownerFor(conn, nb.uri.toString()), conn);
  }

  private async interrupt(nb: vscode.NotebookDocument) {
    for (const s of this.running.get(nb.uri.toString()) ?? []) await s.cancel().catch(() => undefined);
  }

  private nextOrder(nb: vscode.NotebookDocument): number {
    const k = nb.uri.toString();
    const n = (this.order.get(k) ?? 0) + 1;
    this.order.set(k, n);
    return n;
  }

  private async execute(cells: vscode.NotebookCell[], nb: vscode.NotebookDocument, controllerConnId: string) {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('SQL Notebook Studio runs queries only in trusted workspaces.');
      return;
    }
    const ctrl = this.controllers.get(controllerConnId)!;
    for (const cell of cells) {
      const exec = ctrl.createNotebookCellExecution(cell);
      exec.executionOrder = this.nextOrder(nb);
      exec.start(Date.now());
      let ok = false;
      try {
        const conn = this.connectionFor(nb, cell) ?? this.store.get(controllerConnId)!;
        if (cell.document.languageId === AI_LANGUAGE) ok = await this.ai.runAiCell(exec, nb, cell, conn);
        else ok = await this.runSql(exec, nb, cell, conn);
      } catch (e) {
        await exec.replaceOutput(errorOutput(e instanceof Error ? e.message : String(e)));
      } finally {
        exec.end(ok, Date.now());
      }
      if (!ok && exec.token.isCancellationRequested) break;
    }
  }

  private async variablesFor(nb: vscode.NotebookDocument, names: string[]): Promise<Record<string, string> | undefined> {
    const saved = { ...((nb.metadata?.variables as Record<string, string>) ?? {}) };
    const session = this.sessionValues.get(nb.uri.toString()) ?? {};
    const values: Record<string, string> = { ...session, ...saved };
    for (const n of names) {
      if (n in values) continue;
      if (n.startsWith('env.')) {
        values[n] = process.env[n.slice(4)] ?? '';
        continue;
      }
      const v = await vscode.window.showInputBox({ title: `Value for {{${n}}}`, prompt: 'Saved for this session. Use the Variables button to keep it in the notebook.', ignoreFocusOut: true });
      if (v === undefined) return undefined;
      values[n] = v;
      session[n] = v;
    }
    this.sessionValues.set(nb.uri.toString(), session);
    return values;
  }

  async runSql(exec: vscode.NotebookCellExecution, nb: vscode.NotebookDocument, cell: vscode.NotebookCell, conn: ConnectionConfig): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('sqlNotebook');
    const maxRows = Math.max(1, cfg.get<number>('results.maxRows', 10000));
    const timeoutSec = cfg.get<number>('queryTimeoutSeconds', 0);
    const payload: ResultPayload = {
      v: 1,
      connection: conn.name,
      driver: conn.driver,
      results: [],
      chart: cell.metadata?.chart as ResultPayload['chart'],
      view: cell.metadata?.view as ResultPayload['view'],
      aiEnabled: true,
      maxRows,
    };

    let text = cell.document.getText();
    const names = findVariables(text);
    if (names.length) {
      const values = await this.variablesFor(nb, names);
      if (!values) {
        await exec.replaceOutput(errorOutput('Cancelled: a variable has no value.'));
        return false;
      }
      text = substitute(text, values);
    }
    const statements = splitStatements(text, conn.driver);
    if (!statements.length) {
      await exec.clearOutput();
      return true;
    }

    // Safety: read-only connections and risky statements.
    const mode = cfg.get<string>('confirmDestructive', 'production');
    const risks: string[] = [];
    for (const s of statements) {
      const c = classify(s.sql);
      if (conn.readOnly && c.write) {
        await exec.replaceOutput(errorOutput(`"${conn.name}" is read-only. This statement changes data:\n${s.sql.slice(0, 200)}`));
        return false;
      }
      if (c.risk) risks.push(c.risk);
    }
    if (risks.length && (mode === 'always' || (mode === 'production' && conn.env === 'production'))) {
      const go = await vscode.window.showWarningMessage(
        `Run ${[...new Set(risks)].join(', ')} on "${conn.name}"?`,
        { modal: true, detail: conn.env === 'production' ? 'This connection is tagged Production.' : 'This statement cannot be undone.' },
        'Run',
      );
      if (go !== 'Run') {
        await exec.replaceOutput(errorOutput('Not run.'));
        return false;
      }
    }

    payload.id = outputId();
    const output = new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(payload, RESULT_MIME)], { sqlnbId: payload.id });
    await exec.replaceOutput(output);
    let pendingUpdate: NodeJS.Timeout | undefined;
    const update = (now = false) => {
      const push = () => {
        pendingUpdate = undefined;
        void exec.replaceOutputItems(vscode.NotebookCellOutputItem.json(payload, RESULT_MIME), output);
      };
      if (now) {
        if (pendingUpdate) clearTimeout(pendingUpdate);
        push();
      } else if (!pendingUpdate) pendingUpdate = setTimeout(push, 120);
    };

    const key = nb.uri.toString();
    let session: Session;
    payload.running = { index: -1, count: statements.length };
    update(true);
    try {
      session = await this.session(nb, conn);
    } catch (e) {
      payload.running = undefined;
      payload.error = { message: `Can't connect to "${conn.name}": ${e instanceof Error ? e.message : String(e)}`, statementIndex: 0, statementCount: statements.length, sql: '' };
      update(true);
      return false;
    }
    const set = this.running.get(key) ?? new Set();
    set.add(session);
    this.running.set(key, set);
    const cancelSub = exec.token.onCancellationRequested(() => void session.cancel().catch(() => undefined));
    let timedOut = false;
    const timer = timeoutSec > 0 ? setTimeout(() => {
      timedOut = true;
      void session.cancel().catch(() => undefined);
    }, timeoutSec * 1000) : undefined;

    const runOnce = (s: Session) =>
      s.run(
        statements.map((x) => x.sql),
        {
          maxRows,
          onStart: (i) => {
            payload.running = { index: i, count: statements.length };
            update();
          },
          onResult: (r) => {
            payload.results.push(r);
            update();
          },
        },
      );

    try {
      try {
        await runOnce(session);
      } catch (e) {
        if (!payload.results.length && isConnectionLost(e)) {
          await this.manager.drop(ownerFor(conn, key), conn.id);
          set.delete(session);
          session = await this.session(nb, conn);
          set.add(session);
          await runOnce(session);
        } else throw e;
      }
      if (/^\s*(use|create|drop|alter|attach|detach|set\s+search_path)\b/im.test(text)) this.schema.invalidate(conn.id);
      this.ranOk.fire(conn.id);
      return true;
    } catch (e) {
      const index = e instanceof QueryFailure ? e.statementIndex : payload.running?.index ?? 0;
      const st = statements[Math.max(0, index)];
      let message = e instanceof Error ? e.message : String(e);
      if (e instanceof CancelledError || exec.token.isCancellationRequested) message = timedOut ? `Stopped after ${timeoutSec} s (sqlNotebook.queryTimeoutSeconds).` : e instanceof CancelledError ? e.message : 'Query stopped.';
      payload.error = {
        message,
        code: e instanceof QueryFailure ? e.code : undefined,
        statementIndex: Math.max(0, index),
        statementCount: statements.length,
        sql: st?.sql ?? '',
        line: st ? st.line + 1 : undefined,
      };
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      cancelSub.dispose();
      set.delete(session!);
      payload.running = undefined;
      update(true);
    }
  }

  /** Starts an execution on a cell without running it, for AI output and dismissals. */
  async withExecution<T>(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, fn: (exec: vscode.NotebookCellExecution) => Promise<T>): Promise<T | undefined> {
    const ctrl = await this.ensureController(nb);
    if (!ctrl) return undefined;
    const exec = ctrl.createNotebookCellExecution(cell);
    exec.executionOrder = cell.executionSummary?.executionOrder;
    exec.start(Date.now());
    try {
      return await fn(exec);
    } finally {
      exec.end(cell.executionSummary?.success, Date.now());
    }
  }
}

export function outputId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Finds a cell by the id stored in its output metadata. */
export function findOutput(id: string) {
  for (const nb of vscode.workspace.notebookDocuments) {
    for (const cell of nb.getCells()) {
      const output = cell.outputs.find((o) => o.metadata?.sqlnbId === id);
      if (output) return { nb, cell, output };
    }
  }
  return undefined;
}

export function errorOutput(message: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name: 'SQL Notebook Studio', message })]);
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { format as formatSql } from 'sql-formatter';
import { ConnectionStore, BUILTIN_SAMPLE } from './connections/store';
import { SessionManager } from './db/manager';
import { SchemaCache } from './schema/cache';
import { ConnectionsTree, describeSql, selectTopSql, quoteIdent, type Node } from './schema/tree';
import { SqlCompletion } from './schema/completion';
import { AutoUppercase, toggleUppercase } from './notebook/autoUppercase';
import { Kernels, findOutput } from './notebook/kernels';
import { SqlNotebookSerializer, NOTEBOOK_TYPE, AI_LANGUAGE, SQL_LANGUAGE } from './notebook/serializer';
import { AiService } from './ai/service';
import { openConnectionForm, duplicateConnection, type FormDeps } from './connections/formPanel';
import { exportNotebook } from './export/exporter';
import { splitStatements } from './db/splitter';
import { cellsFromSqlFile } from './notebook/format';
import { findVariables } from './util/variables';
import { DRIVERS, type ConnectionConfig } from './db/types';
import { toCsv } from './ai/service';
import type { RendererMessage } from '../shared/protocol';

/** Earlier IDs of this extension. A leftover copy registers the same commands and views. */
const OLD_IDS = ['kgptalkie.sql-notebook'];

export function activate(ctx: vscode.ExtensionContext) {
  // With an old copy also installed, every button shows twice and the two
  // copies keep separate connection lists. Step aside and ask to remove it.
  const old = OLD_IDS.find((id) => vscode.extensions.getExtension(id));
  if (old) {
    void warnOldCopy(old);
    return;
  }

  const store = new ConnectionStore(ctx);
  const manager = new SessionManager(store, path.join(ctx.extensionPath, 'dist'));
  const schema = new SchemaCache(manager);
  const kernels = new Kernels(store, manager, schema);
  const ai = new AiService(ctx, kernels, schema);
  kernels.ai = ai;
  const tree = new ConnectionsTree(store, manager, schema, vscode.Uri.joinPath(ctx.extensionUri, 'media'));
  const formDeps: FormDeps = { ctx, store, manager, onSaved: (c) => void onSaved(c) };

  const onSaved = async (c: ConnectionConfig) => {
    schema.invalidate(c.id);
    tree.refresh();
    const pick = await vscode.window.showInformationMessage(`Saved "${c.name}".`, 'New Notebook');
    if (pick) await newNotebook(c);
  };

  ctx.subscriptions.push(
    store,
    manager,
    kernels,
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new SqlNotebookSerializer(), { transientOutputs: false }),
    vscode.window.createTreeView('sqlNotebook.connections', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.languages.registerCompletionItemProvider({ language: SQL_LANGUAGE, scheme: 'vscode-notebook-cell' }, new SqlCompletion(kernels, schema), '.', ' '),
    vscode.languages.registerDocumentFormattingEditProvider({ language: SQL_LANGUAGE, scheme: 'vscode-notebook-cell' }, { provideDocumentFormattingEdits: (doc) => formatCell(doc, kernels) }),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, new CellStatus()),
    manager.onDidChange((id) => schema.invalidate(id)),
    vscode.window.registerFileDecorationProvider(tree),
    kernels.onDidRunOk((id) => tree.recheck(id)),
    new AutoUppercase(kernels, schema),
  );

  // ---------- Notebooks ----------

  async function newNotebook(conn?: ConnectionConfig, sql = '') {
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, SQL_LANGUAGE);
    const data = new vscode.NotebookData([cell]);
    const active = vscode.window.activeNotebookEditor?.notebook;
    const target = conn ?? (active?.notebookType === NOTEBOOK_TYPE ? kernels.notebookConnection(active) : undefined) ?? store.get(BUILTIN_SAMPLE);
    data.metadata = target ? { connection: target.name } : {};
    const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
    await vscode.window.showNotebookDocument(doc);
    if (target) await kernels.ensureController(doc, target);
    return doc;
  }

  async function openSample() {
    const dir = ctx.globalStorageUri.fsPath;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'Getting Started.sqlnb');
    if (!existsSync(file)) copyFileSync(path.join(ctx.extensionPath, 'samples', 'Getting Started.sqlnb'), file);
    store.samplePath();
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    await vscode.window.showNotebookDocument(doc);
    await kernels.ensureController(doc, store.get(BUILTIN_SAMPLE));
  }

  async function runInNotebook(conn: ConnectionConfig, sql: string) {
    const editor = vscode.window.activeNotebookEditor;
    if (editor && editor.notebook.notebookType === NOTEBOOK_TYPE && kernels.notebookConnection(editor.notebook)?.id === conn.id) {
      const nb = editor.notebook;
      const last = nb.cellCount > 0 ? nb.cellAt(nb.cellCount - 1) : undefined;
      const reuse = last && last.kind === vscode.NotebookCellKind.Code && !last.document.getText().trim();
      const index = reuse ? last!.index : nb.cellCount;
      const edit = new vscode.WorkspaceEdit();
      if (reuse) edit.replace(last!.document.uri, new vscode.Range(0, 0, last!.document.lineCount, 0), sql);
      else edit.set(nb.uri, [vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, SQL_LANGUAGE)])]);
      await vscode.workspace.applyEdit(edit);
      editor.revealRange(new vscode.NotebookRange(index, index + 1), vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: nb.uri });
      return;
    }
    const doc = await newNotebook(conn, sql);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: doc.uri });
  }

  const connOf = (n?: Node): ConnectionConfig | undefined => (n && 'conn' in n ? n.conn : undefined);

  const pickConnection = async (title: string, extra: vscode.QuickPickItem[] = []) => {
    const items = [
      ...extra,
      ...store.list().map((c) => ({ label: `$(database) ${c.name}`, description: DRIVERS[c.driver].label, detail: c.builtin ? 'Built-in' : c.folder, conn: c })),
      { label: '$(add) Add connection…', conn: undefined as ConnectionConfig | undefined, add: true },
    ];
    const pick = await vscode.window.showQuickPick(items as any[], { title, matchOnDescription: true });
    if (pick?.add) {
      openConnectionForm(formDeps);
      return undefined;
    }
    return pick;
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('sqlNotebook.newNotebook', () => newNotebook());
  cmd('sqlNotebook.openSample', openSample);
  cmd('sqlNotebook.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'kgptalkie.sql-notebook-studio#sqlNotebook.start', false));
  cmd('sqlNotebook.addConnection', () => openConnectionForm(formDeps));
  cmd('sqlNotebook.editConnection', (n?: Node) => {
    const c = connOf(n);
    if (c && !c.builtin) openConnectionForm(formDeps, c);
  });
  cmd('sqlNotebook.duplicateConnection', (n?: Node) => {
    const c = connOf(n);
    if (c) void duplicateConnection(formDeps, c);
  });
  cmd('sqlNotebook.deleteConnection', async (n?: Node) => {
    const c = connOf(n);
    if (!c || c.builtin) return;
    const ok = await vscode.window.showWarningMessage(`Delete the connection "${c.name}"?`, { modal: true, detail: 'Its saved password is removed too. Notebooks are not changed.' }, 'Delete');
    if (ok !== 'Delete') return;
    await manager.dropConnection(c.id);
    await store.delete(c.id);
  });
  cmd('sqlNotebook.connect', async (n?: Node) => {
    const c = connOf(n);
    if (!c) return;
    try {
      await vscode.window.withProgress({ location: { viewId: 'sqlNotebook.connections' } }, () => schema.containers(c));
    } catch (e) {
      void vscode.window.showErrorMessage(`Can't connect to "${c.name}": ${e instanceof Error ? e.message : String(e)}`, 'Edit Connection').then((x) => x && !c.builtin && openConnectionForm(formDeps, c));
    }
    tree.refresh();
  });
  cmd('sqlNotebook.disconnect', async (n?: Node) => {
    const c = connOf(n);
    if (c) await manager.dropConnection(c.id);
  });
  cmd('sqlNotebook.refresh', (n?: Node) => {
    const c = connOf(n);
    if (c) tree.refresh(c.id);
    else {
      store.list().forEach((x) => schema.invalidate(x.id));
      tree.refresh();
    }
  });
  cmd('sqlNotebook.newNotebookFor', (n?: Node) => newNotebook(connOf(n)));
  cmd('sqlNotebook.selectTop', (n?: Node) => {
    if (n?.kind === 'table') void runInNotebook(n.conn, selectTopSql(n.conn.driver, n.table.name, n.container));
  });
  cmd('sqlNotebook.describeTable', (n?: Node) => {
    if (n?.kind === 'table') void runInNotebook(n.conn, describeSql(n.conn.driver, n.table.name, n.container));
  });
  cmd('sqlNotebook.copyName', (n?: Node) => {
    if (!n) return;
    const text = n.kind === 'table' ? quoteIdent(n.conn.driver, n.table.name) : n.kind === 'column' ? quoteIdent(n.conn.driver, n.column.name) : n.kind === 'container' ? n.name : '';
    if (text) void vscode.env.clipboard.writeText(text);
  });

  cmd('sqlNotebook.selectNotebookConnection', async () => {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    if (!nb || nb.notebookType !== NOTEBOOK_TYPE) return;
    const pick = await pickConnection('Connection for this notebook');
    if (pick?.conn) await kernels.ensureController(nb, pick.conn);
  });
  cmd('sqlNotebook.selectCellConnection', async (cellArg?: vscode.NotebookCell) => {
    const editor = vscode.window.activeNotebookEditor;
    const cell = cellArg ?? (editor ? editor.notebook.cellAt(editor.selection.start) : undefined);
    if (!cell) return;
    const nbConn = kernels.notebookConnection(cell.notebook);
    const pick = await pickConnection('Connection for this cell', [{ label: `$(notebook) Use the notebook's connection`, description: nbConn?.name, reset: true } as any]);
    if (!pick) return;
    const meta = { ...cell.metadata };
    if ((pick as any).reset) delete meta.connection;
    else meta.connection = pick.conn.name;
    const edit = new vscode.WorkspaceEdit();
    edit.set(cell.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, meta)]);
    await vscode.workspace.applyEdit(edit);
  });

  cmd('sqlNotebook.configureAI', () => ai.configure());
  cmd('sqlNotebook.explainCell', (cell?: vscode.NotebookCell) => ai.explainCell(cell));
  cmd('sqlNotebook.optimizeCell', (cell?: vscode.NotebookCell) => ai.optimizeCell(cell));
  /** Adds an empty AI prompt cell at `index` and puts the cursor in it. */
  const insertAiCell = async (editor: vscode.NotebookEditor, index: number) => {
    const edit = new vscode.WorkspaceEdit();
    edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', AI_LANGUAGE)])]);
    await vscode.workspace.applyEdit(edit);
    editor.selection = new vscode.NotebookRange(index, index + 1);
    await vscode.commands.executeCommand('notebook.cell.edit');
  };
  cmd('sqlNotebook.insertAiCell', async () => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return;
    await insertAiCell(editor, editor.selection ? editor.selection.end : editor.notebook.cellCount);
  });
  // The cell toolbar's button: VS Code keeps the "+ Code / + Markdown" row
  // between cells to itself, so this is the way to add a prompt below a cell.
  cmd('sqlNotebook.insertAiCellBelow', async (cell?: vscode.NotebookCell) => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return;
    const c = cell ?? editor.notebook.cellAt(editor.selection.start);
    const shown = vscode.window.visibleNotebookEditors.find((e) => e.notebook === c.notebook) ?? editor;
    await insertAiCell(shown, c.index + 1);
  });

  cmd('sqlNotebook.toggleUppercaseKeywords', () => toggleUppercase());

  cmd('sqlNotebook.variables', async () => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) return;
    const nb = editor.notebook;
    for (;;) {
      const saved = { ...((nb.metadata?.variables as Record<string, string>) ?? {}) };
      const used = new Set<string>();
      nb.getCells().forEach((c) => findVariables(c.document.getText()).forEach((v) => used.add(v)));
      const names = [...new Set([...Object.keys(saved), ...used])].filter((n) => !n.startsWith('env.')).sort();
      const items: (vscode.QuickPickItem & { name?: string; add?: boolean })[] = [
        ...names.map((name) => ({ label: `{{${name}}}`, description: name in saved ? saved[name] : 'not set', detail: used.has(name) ? undefined : 'not used in any cell', name })),
        { label: '$(add) Add variable', add: true },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'Notebook variables', placeHolder: 'Write {{name}} in SQL. Values are saved in this notebook.' });
      if (!pick) return;
      let name = pick.name;
      if (pick.add) {
        name = (await vscode.window.showInputBox({ title: 'Variable name', validateInput: (v) => (/^[A-Za-z_][\w.]*$/.test(v) ? undefined : 'Letters, digits, _ and . only') }))?.trim();
        if (!name) continue;
      }
      const value = await vscode.window.showInputBox({ title: `Value for {{${name}}}`, value: saved[name!] ?? '', prompt: 'Leave empty and press Enter to remove it.' });
      if (value === undefined) continue;
      if (value === '') delete saved[name!];
      else saved[name!] = value;
      const edit = new vscode.WorkspaceEdit();
      edit.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...nb.metadata, variables: saved })]);
      await vscode.workspace.applyEdit(edit);
    }
  });

  cmd('sqlNotebook.exportHtml', () => exportNotebook(ctx, 'html'));
  cmd('sqlNotebook.exportPdf', () => exportNotebook(ctx, 'pdf'));
  cmd('sqlNotebook.exportMarkdown', () => exportNotebook(ctx, 'md'));

  cmd('sqlNotebook.convertSqlFile', async (uri?: vscode.Uri) => {
    const src = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!src || !src.fsPath.toLowerCase().endsWith('.sql')) return;
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(src));
    const active = vscode.window.activeNotebookEditor?.notebook;
    const conn = active?.notebookType === NOTEBOOK_TYPE ? kernels.notebookConnection(active) : undefined;
    const cells = cellsFromSqlFile(text, (t) => splitStatements(t, conn?.driver ?? 'mysql').map((s) => s.sql)).map((c) =>
      c.kind === 'md'
        ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, c.source, 'markdown')
        : new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, SQL_LANGUAGE),
    );
    const target = vscode.Uri.file(src.fsPath.replace(/\.sql$/i, '.sqlnb'));
    if (existsSync(target.fsPath)) {
      const ok = await vscode.window.showWarningMessage(`${path.basename(target.fsPath)} already exists. Replace it?`, { modal: true }, 'Replace');
      if (ok !== 'Replace') return;
    }
    const data = new vscode.NotebookData(cells);
    data.metadata = conn ? { connection: conn.name } : {};
    const bytes = await new SqlNotebookSerializer().serializeNotebook(data);
    writeFileSync(target.fsPath, bytes);
    const doc = await vscode.workspace.openNotebookDocument(target);
    await vscode.window.showNotebookDocument(doc);
  });

  // ---------- Messages from the results renderer ----------

  const messaging = vscode.notebooks.createRendererMessaging('sqlnb.renderer');
  ctx.subscriptions.push(
    messaging.onDidReceiveMessage(async ({ message }) => {
      const m = message as RendererMessage;
      try {
        switch (m.type) {
          case 'copy':
            await vscode.env.clipboard.writeText(m.text);
            vscode.window.setStatusBarMessage('$(check) Copied', 1500);
            break;
          case 'export': {
            const ext = m.format;
            const target = await vscode.window.showSaveDialog({ defaultUri: defaultUri(`${m.name.replace(/[^\w.-]+/g, '_')}.${ext}`), filters: ext === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] } });
            if (!target) return;
            const body =
              ext === 'csv'
                ? '﻿' + toCsv(m.columns.map((c) => c.name), m.rows)
                : JSON.stringify(m.rows.map((r) => Object.fromEntries(m.columns.map((c, i) => [c.name, r[i]]))), null, 2);
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(body));
            const open = await vscode.window.showInformationMessage(`Saved ${m.rows.length.toLocaleString()} rows to ${path.basename(target.fsPath)}`, 'Open');
            if (open) await vscode.commands.executeCommand('vscode.open', target);
            break;
          }
          case 'savePng': {
            const target = await vscode.window.showSaveDialog({ defaultUri: defaultUri('chart.png'), filters: { PNG: ['png'] } });
            if (!target) return;
            await vscode.workspace.fs.writeFile(target, Buffer.from(m.dataUrl.split(',')[1], 'base64'));
            vscode.window.setStatusBarMessage(`$(check) Saved ${path.basename(target.fsPath)}`, 2500);
            break;
          }
          case 'setChart': {
            const f = findOutput(m.outputId);
            if (!f) return;
            const meta = { ...f.cell.metadata, view: m.view === 'chart' ? 'chart' : undefined, chart: m.chart };
            if (JSON.stringify(meta) === JSON.stringify({ ...f.cell.metadata })) return;
            const edit = new vscode.WorkspaceEdit();
            edit.set(f.nb.uri, [vscode.NotebookEdit.updateCellMetadata(f.cell.index, meta)]);
            await vscode.workspace.applyEdit(edit);
            break;
          }
          case 'fix':
            await ai.fix(m.outputId);
            break;
          case 'explainResult':
            await ai.explainResult(m.outputId, m.resultIndex);
            break;
          case 'applySql':
            await ai.applySql(m.outputId, m.sql);
            break;
          case 'dismissAi':
            await ai.dismiss(m.outputId);
            break;
          case 'runCell': {
            const f = findOutput(m.outputId);
            if (!f) return;
            const i = f.cell.document.languageId === AI_LANGUAGE ? f.cell.index + 1 : f.cell.index;
            if (i < f.nb.cellCount) await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: i, end: i + 1 }], document: f.nb.uri });
            break;
          }
          case 'configureAi':
            await ai.configure();
            break;
          case 'openSetting':
            await vscode.commands.executeCommand('workbench.action.openSettings', m.key);
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      }
    }),
  );

  // First run: point to the walkthrough once.
  if (!ctx.globalState.get('sqlNotebook.welcomed')) {
    void ctx.globalState.update('sqlNotebook.welcomed', true);
  }

  // Integration tests (VS Code's test runner only) add connections through this.
  if (ctx.extensionMode === vscode.ExtensionMode.Test) return { store, ai };
  return undefined;
}

export function deactivate() {}

async function warnOldCopy(id: string) {
  const pick = await vscode.window.showWarningMessage(
    `An old copy of SQL Notebook Studio (${id}) is also installed, so buttons show twice and connections are split between the two copies. Uninstall the old copy, then reload. Connections saved only in the old copy need to be added again.`,
    'Uninstall Old Copy',
  );
  if (!pick) return;
  await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
  const reload = await vscode.window.showInformationMessage('Old copy removed. Reload VS Code to finish.', 'Reload');
  if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function defaultUri(name: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, name) : undefined;
}


const FORMATTER_LANG: Record<string, string> = { mysql: 'mysql', postgres: 'postgresql', mssql: 'transactsql', sqlite: 'sqlite', duckdb: 'duckdb' };

function formatCell(doc: vscode.TextDocument, kernels: Kernels): vscode.TextEdit[] {
  let driver = 'mysql';
  for (const nb of vscode.workspace.notebookDocuments) {
    const cell = nb.getCells().find((c) => c.document === doc);
    if (cell) driver = kernels.connectionFor(nb, cell)?.driver ?? driver;
  }
  const opts = { keywordCase: 'upper' as const, tabWidth: 2, paramTypes: { custom: [{ regex: String.raw`\{\{\s*[A-Za-z_][\w.]*\s*\}\}` }] } };
  let out: string;
  try {
    out = formatSql(doc.getText(), { ...opts, language: FORMATTER_LANG[driver] as any });
  } catch {
    try {
      out = formatSql(doc.getText(), { ...opts, language: 'sql' });
    } catch {
      return [];
    }
  }
  return [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), out)];
}

class CellStatus implements vscode.NotebookCellStatusBarItemProvider {
  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    if (cell.kind !== vscode.NotebookCellKind.Code) return [];
    const items: vscode.NotebookCellStatusBarItem[] = [];
    if (cell.document.languageId === AI_LANGUAGE) {
      const c = vscode.workspace.getConfiguration('sqlNotebook.ai');
      const it = new vscode.NotebookCellStatusBarItem(`$(sparkle) Describe what you want, then run. SQL appears below.`, vscode.NotebookCellStatusBarAlignment.Left);
      it.tooltip = `AI: ${c.get('provider')} · ${c.get('model') || 'default model'}. Click to change.`;
      it.command = 'sqlNotebook.configureAI';
      items.push(it);
    }
    const conn = cell.metadata?.connection as string | undefined;
    if (conn) {
      const it = new vscode.NotebookCellStatusBarItem(`$(database) ${conn}`, vscode.NotebookCellStatusBarAlignment.Right);
      it.tooltip = 'This cell uses its own connection. Click to change.';
      it.command = { command: 'sqlNotebook.selectCellConnection', title: 'Change', arguments: [cell] };
      items.push(it);
    }
    if (cell.metadata?.generated) {
      const it = new vscode.NotebookCellStatusBarItem('$(sparkle) AI-written', vscode.NotebookCellStatusBarAlignment.Right);
      it.tooltip = 'Written by the AI cell above. Review before running on important data.';
      items.push(it);
    }
    return items;
  }
}

// Capitalises SQL keywords as you type in SQL cells: when a word is finished
// (space, comma, bracket, semicolon or Enter) and it is a keyword of the
// cell's database, it becomes capitals. One Ctrl+Z puts it back.
// Setting: sqlNotebook.editor.uppercaseKeywords (on by default).

import * as vscode from 'vscode';
import { ENDS_WORD, wordToCapitalise } from '../schema/autoCase';
import { parseAliases } from '../schema/completion';
import type { SchemaCache } from '../schema/cache';
import type { ConnectionConfig } from '../db/types';
import type { Kernels } from './kernels';
import { NOTEBOOK_TYPE, SQL_LANGUAGE } from './serializer';

const SETTING = 'editor.uppercaseKeywords';

export function uppercaseEnabled(): boolean {
  return vscode.workspace.getConfiguration('sqlNotebook').get<boolean>(SETTING, true);
}

export async function toggleUppercase(): Promise<void> {
  const on = !uppercaseEnabled();
  await vscode.workspace.getConfiguration('sqlNotebook').update(SETTING, on, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(on ? 'SQL keywords now turn into capitals as you type.' : 'SQL keywords are left as you type them.');
}

export class AutoUppercase implements vscode.Disposable {
  private readonly sub: vscode.Disposable;

  constructor(private readonly kernels: Kernels, private readonly cache: SchemaCache) {
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => void this.onChange(e).catch(() => undefined));
  }

  dispose() {
    this.sub.dispose();
  }

  private async onChange(e: vscode.TextDocumentChangeEvent) {
    const doc = e.document;
    if (doc.languageId !== SQL_LANGUAGE || doc.uri.scheme !== 'vscode-notebook-cell') return;
    // Only plain typing: no undo or redo, one cursor, nothing replaced, and a character that ends a word.
    if (e.reason !== undefined || e.contentChanges.length !== 1) return;
    const change = e.contentChanges[0];
    if (change.rangeLength !== 0 || !ENDS_WORD.test(change.text)) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc || !uppercaseEnabled()) return;

    const found = this.cellFor(doc);
    if (!found) return;
    const conn = this.kernels.connectionFor(found.nb, found.cell);
    if (!conn) return;

    const text = doc.getText();
    const offset = doc.offsetAt(change.range.start);
    // A cheap first check without names, so most keystrokes cost nothing.
    if (!wordToCapitalise(text, offset, conn.driver, change.text)) return;
    const names = await this.names(conn, text);
    const hit = wordToCapitalise(text, offset, conn.driver, change.text, names);
    if (!hit) return;

    const range = new vscode.Range(doc.positionAt(hit.start), doc.positionAt(hit.end));
    // The user may have kept typing; change the word only if it is still there.
    if (doc.getText(range) !== hit.word) return;
    await editor.edit((b) => b.replace(range, hit.upper), { undoStopBefore: true, undoStopAfter: true });
  }

  /** Lowercase names of tables, views, schemas, aliases and the columns of tables in the cell. */
  private async names(conn: ConnectionConfig, text: string): Promise<Set<string>> {
    const out = new Set<string>();
    const wait = <T>(p: Promise<T>) => Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 400))]);
    const aliases = parseAliases(text);
    for (const [alias, ref] of aliases) {
      out.add(alias);
      out.add(ref.table.toLowerCase());
      if (ref.container) out.add(ref.container.toLowerCase());
    }
    const container = await wait(this.cache.defaultContainer(conn));
    const [tables, containers] = await Promise.all([wait(this.cache.tables(conn, container)), wait(this.cache.containers(conn))]);
    for (const t of tables ?? []) out.add(t.name.toLowerCase());
    for (const c of containers ?? []) out.add(c.toLowerCase());
    // Columns of the tables in the cell, and of every table when the schema is small, so a
    // column such as "name" stays as it is even when typed before FROM. Lookups are cached.
    const refs = [...aliases.values()];
    if ((tables?.length ?? 0) <= 100) for (const t of tables ?? []) refs.push({ table: t.name, container });
    const cols = await Promise.all(refs.map((r) => wait(this.cache.columns(conn, r.table, r.container))));
    for (const list of cols) for (const c of list ?? []) out.add(c.name.toLowerCase());
    return out;
  }

  private cellFor(doc: vscode.TextDocument): { nb: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== NOTEBOOK_TYPE) continue;
      const cell = nb.getCells().find((c) => c.document === doc);
      if (cell) return { nb, cell };
    }
    return undefined;
  }
}

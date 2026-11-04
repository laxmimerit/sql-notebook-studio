// Autocomplete in SQL cells: keywords, tables and views from the live schema,
// columns of the tables in the query, and alias.column after a dot.
// VS Code's suggest widget filters the items: fuzzy and case-blind, so "slt"
// finds SELECT and "EMP" finds employees. Keywords are inserted in the case
// the user types (setting sqlNotebook.autocomplete.keywordCase).

import * as vscode from 'vscode';
import type { ConnectionConfig } from '../db/types';
import type { SchemaCache } from './cache';
import type { Kernels } from '../notebook/kernels';
import { EXTRA, KEYWORDS, applyCase, keywordCase, type KeywordCase } from './keywords';

const ALIAS = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:[`"[]?[\w$]+[`"\]]?\.)?[`"[]?[\w$]+[`"\]]?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi;
const NOT_ALIAS = new Set(['WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'GROUP', 'ORDER', 'LIMIT', 'USING', 'SET', 'VALUES', 'UNION', 'HAVING', 'AS', 'NATURAL', 'WINDOW', 'QUALIFY']);

export class SqlCompletion implements vscode.CompletionItemProvider {
  constructor(private readonly kernels: Kernels, private readonly cache: SchemaCache) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
    const found = this.cellFor(doc);
    if (!found) return [];
    const conn = this.kernels.connectionFor(found.nb, found.cell);
    if (!conn) return [];
    const text = doc.getText();
    const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), pos));
    const dot = /([`"[]?[\w$]+[`"\]]?)\.([\w$]*)$/.exec(before);

    const timeout = new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500));
    const run = <T>(p: Promise<T>) => Promise.race([p.catch(() => undefined), timeout]) as Promise<T | undefined>;

    if (dot) {
      const qual = unquote(dot[1]);
      const aliases = parseAliases(text);
      const target = aliases.get(qual.toLowerCase());
      const containers = (await run(this.cache.containers(conn))) ?? [];
      if (!target && containers.some((c) => c.toLowerCase() === qual.toLowerCase())) {
        const tables = (await run(this.cache.tables(conn, qual))) ?? [];
        return tables.map((t) => tableItem(t.name, t.type));
      }
      const ref = target ?? { table: qual };
      const cols = (await run(this.cache.columns(conn, ref.table, ref.container))) ?? [];
      return cols.map((c, i) => columnItem(c.name, c.type, c.pk, i));
    }
    if (token.isCancellationRequested) return [];

    const items: vscode.CompletionItem[] = [];
    const container = await run(this.cache.defaultContainer(conn));
    const tables = (await run(this.cache.tables(conn, container))) ?? [];
    for (const t of tables) items.push(tableItem(t.name, t.type));
    if (conn.driver === 'mysql' || ((await run(this.cache.containers(conn)))?.length ?? 0) > 1) {
      for (const c of (await run(this.cache.containers(conn))) ?? []) {
        const it = new vscode.CompletionItem({ label: c, description: conn.driver === 'mysql' ? 'database' : 'schema' }, vscode.CompletionItemKind.Module);
        it.sortText = '3' + c;
        items.push(it);
      }
    }
    const seen = new Set<string>();
    for (const ref of parseAliases(text).values()) {
      const key = `${ref.container ?? ''}.${ref.table}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cols = (await run(this.cache.columns(conn, ref.table, ref.container))) ?? [];
      cols.forEach((c, i) => {
        const it = columnItem(c.name, c.type, c.pk, i, ref.table);
        it.sortText = '0' + String(i).padStart(4, '0');
        items.push(it);
      });
    }
    const typed = /[\w$]*$/.exec(before)?.[0] ?? '';
    const setting = vscode.workspace.getConfiguration('sqlNotebook').get<KeywordCase>('autocomplete.keywordCase', 'auto');
    const keyCase = keywordCase(typed, setting);
    for (const k of [...KEYWORDS, ...(EXTRA[conn.driver] ?? [])]) {
      const it = new vscode.CompletionItem(applyCase(k, keyCase), vscode.CompletionItemKind.Keyword);
      it.sortText = '5' + k;
      items.push(it);
    }
    // Nothing typed yet: ask again on the first letter, so keywords follow its case.
    return new vscode.CompletionList(items, typed === '' && setting === 'auto');
  }

  private cellFor(doc: vscode.TextDocument): { nb: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined {
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== 'sqlnb') continue;
      const cell = nb.getCells().find((c) => c.document === doc);
      if (cell) return { nb, cell };
    }
    return undefined;
  }
}

function tableItem(name: string, type: string): vscode.CompletionItem {
  const it = new vscode.CompletionItem({ label: name, description: type }, type === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class);
  it.sortText = '1' + name;
  return it;
}

function columnItem(name: string, type: string, pk: boolean | undefined, i: number, table?: string): vscode.CompletionItem {
  const it = new vscode.CompletionItem({ label: name, detail: pk ? ' 🔑' : undefined, description: table ? `${table} · ${type.toLowerCase()}` : type.toLowerCase() }, vscode.CompletionItemKind.Field);
  it.sortText = '0' + String(i).padStart(4, '0');
  return it;
}

function unquote(s: string): string {
  return s.replace(/^[`"[]/, '').replace(/[`"\]]$/, '');
}

export function parseAliases(sql: string): Map<string, { table: string; container?: string }> {
  const map = new Map<string, { table: string; container?: string }>();
  for (const m of sql.matchAll(ALIAS)) {
    const parts = m[1].split('.').map(unquote);
    const ref = parts.length > 1 ? { container: parts[0], table: parts[1] } : { table: parts[0] };
    map.set(ref.table.toLowerCase(), ref);
    const alias = m[2];
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) map.set(alias.toLowerCase(), ref);
  }
  return map;
}

export type { ConnectionConfig };

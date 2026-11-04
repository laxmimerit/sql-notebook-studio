import * as vscode from 'vscode';
import { parseNotebook, serializeNotebook, type RawCell } from './format';
import { RESULT_MIME, type ResultPayload } from '../../shared/protocol';

export const NOTEBOOK_TYPE = 'sqlnb';
export const AI_LANGUAGE = 'sqlnb-ai';
/** Our own language id, shown as "SQL". The connection decides the dialect. */
export const SQL_LANGUAGE = 'sqlnb-sql';
export const isSqlLanguage = (id: string) => id === SQL_LANGUAGE || id === 'sql';
const SAVED_ROWS = 200;

export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  async deserializeNotebook(content: Uint8Array): Promise<vscode.NotebookData> {
    const nb = parseNotebook(new TextDecoder().decode(content));
    const cells = nb.cells.map((c) => {
      const cell =
        c.kind === 'md'
          ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, c.source, 'markdown')
          : new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, c.kind === 'ai' ? AI_LANGUAGE : SQL_LANGUAGE);
      cell.metadata = c.meta;
      if (c.output && typeof c.output === 'object' && (c.output as ResultPayload).v === 1) {
        const p = c.output as ResultPayload;
        p.id ??= Math.random().toString(36).slice(2);
        cell.outputs = [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(p, RESULT_MIME)], { sqlnbId: p.id })];
      }
      return cell;
    });
    const data = new vscode.NotebookData(cells);
    data.metadata = nb.meta;
    return data;
  }

  async serializeNotebook(data: vscode.NotebookData): Promise<Uint8Array> {
    const save = vscode.workspace.getConfiguration('sqlNotebook').get<boolean>('saveResults', false);
    const cells: RawCell[] = data.cells.map((c) => {
      const kind = c.kind === vscode.NotebookCellKind.Markup ? 'md' : c.languageId === AI_LANGUAGE ? 'ai' : 'sql';
      const raw: RawCell = { kind, source: c.value, meta: { ...(c.metadata ?? {}) } };
      if (save && kind === 'sql') raw.output = savedOutput(c.outputs);
      return raw;
    });
    return new TextEncoder().encode(serializeNotebook({ meta: { ...(data.metadata ?? {}) }, cells }));
  }
}

function savedOutput(outputs?: vscode.NotebookCellOutput[]): unknown {
  for (const o of outputs ?? []) {
    for (const item of o.items) {
      if (item.mime !== RESULT_MIME) continue;
      try {
        const p = JSON.parse(new TextDecoder().decode(item.data)) as ResultPayload;
        return {
          ...p,
          running: undefined,
          results: p.results.map((r) => ({ ...r, rows: r.rows.slice(0, SAVED_ROWS), truncated: r.truncated || r.rows.length > SAVED_ROWS })),
        };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

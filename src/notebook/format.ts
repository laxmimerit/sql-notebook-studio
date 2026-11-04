// The .sqlnb file format. Plain text, valid SQL, friendly to Git diffs:
//
//   -- sqlnb v1 {"connection":"Local MySQL"}
//   -- %% md
//   -- # Monthly report
//   -- %% sql {"connection":"Warehouse"}
//   SELECT ...
//   -- %% ai
//   -- top 5 customers by revenue
//
// Cell boundaries are explicit markers, so formatters, blank lines and
// Windows line endings can never merge or split cells.

export type CellKind = 'sql' | 'md' | 'ai';

export interface RawCell {
  kind: CellKind;
  source: string;
  meta: Record<string, unknown>;
  /** Saved results (only when sqlNotebook.saveResults is on). */
  output?: unknown;
}

export interface RawNotebook {
  meta: Record<string, unknown>;
  cells: RawCell[];
}

const HEADER = /^-- sqlnb v(\d+)(?:\s+(\{.*\}))?\s*$/;
const MARKER = /^-- %% (sql|md|ai)(?:\s+(\{.*\}))?\s*$/;
const OUTPUT = /^-- @output (\{.*\})\s*$/;

export function parseNotebook(text: string): RawNotebook {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const nb: RawNotebook = { meta: {}, cells: [] };
  let i = 0;
  const header = lines.length ? HEADER.exec(lines[0]) : null;
  if (header) {
    nb.meta = safeJson(header[2]) ?? {};
    i = 1;
  }
  if (!lines.slice(i).some((l) => MARKER.test(l))) {
    const source = lines.slice(i).join('\n').trim();
    if (source) nb.cells.push({ kind: 'sql', source, meta: {} });
    return nb;
  }
  let current: RawCell | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (!current) {
      // Text before the first marker becomes a SQL cell, never lost.
      const pre = buf.join('\n').trim();
      if (pre) nb.cells.push({ kind: 'sql', source: pre, meta: {} });
    } else {
      let body = buf;
      if (current.kind !== 'sql') body = body.map(uncomment);
      current.source = trimBlankLines(body).join('\n');
      nb.cells.push(current);
    }
    buf = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = MARKER.exec(line);
    if (m) {
      flush();
      current = { kind: m[1] as CellKind, source: '', meta: safeJson(m[2]) ?? {} };
      continue;
    }
    const o = current && OUTPUT.exec(line);
    if (o && current) {
      current.output = safeJson(o[1]);
      continue;
    }
    buf.push(line);
  }
  flush();
  return nb;
}

export function serializeNotebook(nb: RawNotebook): string {
  const out: string[] = [];
  const meta = compact(nb.meta);
  out.push(`-- sqlnb v1${meta ? ' ' + meta : ''}`);
  for (const cell of nb.cells) {
    const m = compact(cell.meta);
    out.push(`-- %% ${cell.kind}${m ? ' ' + m : ''}`);
    const src = cell.source.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (src) {
      for (const line of src.split('\n')) out.push(cell.kind === 'sql' ? line : line ? `-- ${line}` : '--');
    }
    if (cell.output !== undefined) out.push(`-- @output ${JSON.stringify(cell.output)}`);
    out.push('');
  }
  return out.join('\n');
}

function uncomment(line: string): string {
  if (line.startsWith('-- ')) return line.slice(3);
  if (line.startsWith('--')) return line.slice(2);
  return line;
}

function trimBlankLines(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
}

function safeJson(s?: string): Record<string, any> | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

function compact(o: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    clean[k] = v;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : '';
}

/**
 * Cells for a plain .sql file. Files from the older SQL Notebook extension keep
 * Markdown in `/*markdown ... *\/` blocks and separate cells with blank lines;
 * those keep their cells. Any other file gets one cell per statement.
 */
export function cellsFromSqlFile(text: string, splitSql: (sql: string) => string[]): { kind: 'sql' | 'md'; source: string }[] {
  const src = text.replace(/\r\n?/g, '\n');
  const md = /^\/\*markdown[ \t]*\n([\s\S]*?)\n?\*\/[ \t]*$/gm;
  if (!/^\/\*markdown\b/m.test(src)) {
    const stmts = splitSql(src);
    return (stmts.length ? stmts.map((s) => (s.endsWith(';') ? s : s + ';')) : [src]).map((source) => ({ kind: 'sql' as const, source }));
  }
  const out: { kind: 'sql' | 'md'; source: string }[] = [];
  const code = (chunk: string) => {
    for (const block of chunk.split(/\n[ \t]*\n/)) if (block.trim()) out.push({ kind: 'sql', source: block.trim() });
  };
  let last = 0;
  for (const m of src.matchAll(md)) {
    code(src.slice(last, m.index));
    out.push({ kind: 'md', source: m[1].trim() });
    last = m.index! + m[0].length;
  }
  code(src.slice(last));
  return out;
}

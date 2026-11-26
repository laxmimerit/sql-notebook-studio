// Run order: turns a database's query plan into numbered steps, in the order
// they run, and finds the SQL lines each step comes from.
//
// PostgreSQL and DuckDB give a JSON tree; SQLite gives EXPLAIN QUERY PLAN rows.
// Each is read into one small tree (PNode), then walked children-first: a
// step runs once the steps that feed it have run. Nodes that only move rows
// around (Hash, Materialize, Gather, projections) are skipped.

import type { PlanStep, StepKind } from '../../shared/protocol';

interface PNode {
  kind: StepKind | 'hidden';
  /** The plan's own name for the node, e.g. "Hash Join". */
  op: string;
  table?: string;
  alias?: string;
  index?: string;
  /** Index condition (the rows the index finds). */
  cond?: string;
  /** Rows kept by a test after reading. */
  filter?: string;
  /** Join condition. */
  join?: string;
  joinType?: string;
  keys?: string;
  /** For DuckDB TOP_N: the number of rows kept. */
  top?: number;
  rows?: number;
  children: PNode[];
}

// ---------- Reading the plans ----------

const PG_HIDDEN = new Set(['Hash', 'Materialize', 'Memoize', 'Gather', 'Gather Merge', 'Bitmap Index Scan', 'BitmapAnd', 'BitmapOr', 'LockRows', 'Subquery Scan']);
const PG_SCAN = new Set(['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan', 'Tid Scan', 'Tid Range Scan', 'Sample Scan', 'Parallel Seq Scan']);

function pgNode(p: any): PNode {
  const t: string = p['Node Type'];
  const children = ((p.Plans ?? []) as any[]).map(pgNode);
  const n: PNode = { kind: 'other', op: t, rows: num(p['Plan Rows']), children };
  if (PG_SCAN.has(t)) {
    n.kind = 'scan';
    n.table = p['Relation Name'];
    n.alias = p.Alias;
    n.index = p['Index Name'];
    n.cond = p['Index Cond'] ?? p['Recheck Cond'] ?? p['TID Cond'];
    if (t === 'Bitmap Heap Scan') n.index = findIndex(p);
  } else if (t === 'CTE Scan' || t === 'WorkTable Scan') {
    n.kind = 'scan';
    n.table = p['CTE Name'];
    n.alias = p.Alias;
  } else if (t === 'Function Scan' || t === 'Table Function Scan') {
    n.kind = 'scan';
    n.table = p['Function Name'];
    n.alias = p.Alias;
  } else if (t === 'Values Scan') n.kind = 'values';
  else if (t === 'Hash Join' || t === 'Merge Join' || t === 'Nested Loop') {
    n.kind = 'join';
    n.joinType = p['Join Type'];
    n.join = p['Hash Cond'] ?? p['Merge Cond'] ?? p['Join Filter'];
    // A hash join reads the hashed (inner) side first, then probes it.
    if (t === 'Hash Join' && children.length === 2) n.children = [children[1], children[0]];
  } else if (t === 'Aggregate' || t === 'GroupAggregate' || t === 'HashAggregate' || t === 'Group') {
    n.kind = 'group';
    n.keys = list(p['Group Key']);
  } else if (t === 'Sort' || t === 'Incremental Sort') {
    n.kind = 'sort';
    n.keys = list(p['Sort Key']);
  } else if (t === 'Limit') n.kind = 'limit';
  else if (t === 'Unique') n.kind = 'distinct';
  else if (t === 'WindowAgg') n.kind = 'window';
  else if (t === 'Append' || t === 'Merge Append' || t === 'SetOp' || t === 'HashSetOp' || t === 'Recursive Union') n.kind = 'combine';
  else if (t === 'ModifyTable') {
    n.kind = 'write';
    n.op = p.Operation ?? 'Write';
    n.table = p['Relation Name'];
  } else if (t === 'Result') n.kind = children.length ? 'hidden' : 'values';
  else if (PG_HIDDEN.has(t)) n.kind = 'hidden';
  if (p.Filter) n.filter = p.Filter;
  if (p.Alias && !n.alias) n.alias = p.Alias;
  return n;
}

function findIndex(p: any): string | undefined {
  for (const c of p.Plans ?? []) {
    if (c['Index Name']) return c['Index Name'];
    const x = findIndex(c);
    if (x) return x;
  }
  return undefined;
}

/** `EXPLAIN (FORMAT JSON)` output: `[{ Plan: {...} }]`, or that as text. */
export function fromPostgres(raw: unknown): PNode {
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const top = Array.isArray(j) ? j[0] : j;
  return pgNode(top.Plan ?? top);
}

const DUCK_HIDDEN = new Set(['PROJECTION', 'RESULT_COLLECTOR', 'EXPLAIN', 'CTE', 'DELIM_SCAN', 'DUMMY_SCAN', 'COLUMN_DATA_SCAN', 'CHUNK_SCAN']);

function duckNode(p: any): PNode {
  const name = String(p.name ?? '').trim();
  const x = p.extra_info ?? {};
  const children = ((p.children ?? []) as any[]).map(duckNode);
  const n: PNode = { kind: 'other', op: name, rows: num(x['Estimated Cardinality']), children };
  if (/^(SEQ_SCAN|TABLE_SCAN|INDEX_SCAN|READ_\w+)$/.test(name) || (name.endsWith('_SCAN') && x.Table)) {
    n.kind = 'scan';
    n.table = x.Table ? String(x.Table).split('.').pop() : x.Function ?? undefined;
    n.filter = text(x.Filters);
    if (name === 'INDEX_SCAN' || /Index/i.test(String(x.Type ?? ''))) n.index = 'index';
  } else if (name === 'CTE_SCAN') {
    n.kind = 'scan';
    n.table = x['CTE Name'] ?? x.Table;
  } else if (/JOIN$|^CROSS_PRODUCT$/.test(name)) {
    n.kind = 'join';
    n.joinType = String(x['Join Type'] ?? 'INNER').replace(/^(?:LEFT|RIGHT)_(SEMI|ANTI)$/, '$1');
    n.join = text(x.Conditions);
    // DuckDB builds its hash table from the right child, then probes with the left.
    if (name === 'HASH_JOIN' && children.length === 2) n.children = [children[1], children[0]];
  } else if (/GROUP_BY$|AGGREGATE$/.test(name)) {
    n.kind = 'group';
    n.keys = text(x.Groups);
  } else if (name === 'ORDER_BY') {
    n.kind = 'sort';
    n.keys = text(x['Order By'] ?? x.__order_by__);
  } else if (name === 'TOP_N') {
    n.kind = 'topn';
    n.keys = text(x['Order By']);
    n.top = num(x.Top);
  } else if (/LIMIT/.test(name)) n.kind = 'limit';
  else if (name === 'FILTER') {
    n.kind = 'filter';
    n.filter = text(x.Expressions ?? x.Expression);
  } else if (/WINDOW$/.test(name)) n.kind = 'window';
  else if (name === 'UNION' || name === 'UNION_ALL' || /^RECURSIVE_CTE$/.test(name)) n.kind = 'combine';
  else if (name === 'INSERT' || name === 'UPDATE' || name === 'DELETE') {
    n.kind = 'write';
    n.op = name[0] + name.slice(1).toLowerCase();
    n.table = x.Table ? String(x.Table).split('.').pop() : undefined;
  } else if (DUCK_HIDDEN.has(name)) n.kind = children.length || name !== 'DUMMY_SCAN' ? 'hidden' : 'values';
  return n;
}

/** `EXPLAIN (FORMAT JSON)` on DuckDB: an array of root nodes, or that as text. */
export function fromDuckdb(raw: unknown): PNode {
  const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const roots = (Array.isArray(j) ? j : [j]).map(duckNode);
  return roots.length === 1 ? roots[0] : { kind: 'hidden', op: 'roots', children: roots };
}

export interface SqliteRow {
  id: number;
  parent: number;
  detail: string;
}

/**
 * SQLite lists what it does in order. Scans in one list are nested loops: the
 * first table is read, and each later one is looked up for every row so far.
 */
export function fromSqlite(rows: SqliteRow[], tableOf: (alias: string) => string | undefined = () => undefined): PNode {
  const kids = new Map<number, SqliteRow[]>();
  for (const r of rows) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
  /** Results of CO-ROUTINE / MATERIALIZE blocks, read later by `SCAN name`. */
  const named = new Map<string, PNode>();

  const chain = (parent: number): PNode | undefined => {
    let cur: PNode | undefined;
    const pendingSubs: PNode[] = [];
    const add = (n: PNode) => {
      n.children = [...(cur ? [cur] : []), ...n.children, ...pendingSubs.splice(0)];
      cur = n;
    };
    for (const r of kids.get(parent) ?? []) {
      const d = r.detail.trim();
      let m: RegExpExecArray | null;
      if ((m = /^(SCAN|SEARCH)\s+(?:TABLE\s+)?(\S+)(?:\s+AS\s+(\S+))?(?:\s+USING\s+(.*))?$/i.exec(d))) {
        const [, how, name, alias, using] = m;
        if (/^CONSTANT ROW$/i.test(`${name}${using ?? ''}`) || /^CONSTANT$/i.test(name)) {
          add({ kind: 'values', op: d, children: [] });
          continue;
        }
        const bare = name.replace(/^\(|\)$/g, '');
        const src = named.get(bare) ?? named.get(tableOf(bare) ?? '');
        const node: PNode = { kind: 'scan', op: d, table: name, alias: alias ?? name, children: src ? [src] : [] };
        if (using) {
          const idx = /(?:COVERING\s+)?INDEX\s+(\S+)/i.exec(using);
          node.index = idx ? idx[1] : /PRIMARY KEY/i.test(using) ? 'primary key' : undefined;
          const c = /\((.*)\)\s*$/.exec(using);
          if (c) node.cond = c[1];
        }
        if (cur && cur.kind !== 'group' && cur.kind !== 'sort') {
          // A later table in a nested loop: looked up for each row so far.
          add({ kind: 'join', op: 'Nested Loop', joinType: 'Inner', children: [node] });
          continue;
        }
        void how;
        add(node);
      } else if ((m = /^(CO-ROUTINE|MATERIALIZE)\s+(.+)$/i.exec(d))) {
        const inner = chain(r.id);
        if (inner) named.set(m[2].replace(/^\(|\)$/g, '').trim(), inner);
      } else if (/SUBQUERY/i.test(d) && !/^(LEFT-MOST SUBQUERY)/i.test(d)) {
        const inner = chain(r.id);
        if (inner) pendingSubs.push(inner);
      } else if (/^COMPOUND QUERY$/i.test(d) || /^(LEFT-MOST SUBQUERY|UNION ALL|UNION|INTERSECT|EXCEPT)\b/i.test(d)) {
        if (/^COMPOUND QUERY$/i.test(d)) {
          const parts = (kids.get(r.id) ?? []).map((k) => chain(k.id)).filter((x): x is PNode => !!x);
          add({ kind: 'combine', op: 'Compound', children: parts });
        } else {
          const inner = chain(r.id);
          if (inner) add({ ...inner, children: inner.children });
        }
      } else if ((m = /^USE TEMP B-TREE FOR (.*)$/i.exec(d))) {
        const what = m[1].toUpperCase();
        add({ kind: what.includes('GROUP BY') ? 'group' : what.includes('DISTINCT') ? 'distinct' : 'sort', op: d, children: [] });
      } else if (/^BLOOM FILTER/i.test(d)) {
        continue;
      } else {
        const inner = chain(r.id);
        add({ kind: 'other', op: d, children: inner ? [inner] : [] });
      }
    }
    if (pendingSubs.length && cur) cur.children.push(...pendingSubs.splice(0));
    return cur;
  };
  return chain(0) ?? { kind: 'other', op: 'No plan', children: [] };
}

// ---------- The SQL text: clauses and table names ----------

interface Clause {
  kw: string;
  start: number;
  /** Length of the keyword itself. */
  len: number;
  /** The clause as written (comments and strings blanked). */
  text: string;
  /** Where the clause's text ends, trailing spaces left out. */
  end: number;
}

interface Block {
  start: number;
  end: number;
  depth: number;
  clauses: Clause[];
  /** `big` for `WITH big AS (...)` or `(...) AS big`. */
  name?: string;
}

interface Ref {
  name?: string;
  alias?: string;
  pos: number;
  /** The ON clause that goes with this JOIN, if any. */
  on?: Clause;
  used?: boolean;
}

export interface SqlShape {
  text: string;
  /** Comments and strings blanked out; same length as text. */
  masked: string;
  blocks: Block[];
  refs: Ref[];
  lineStarts: number[];
}

/** Blanks comments and strings (keeping newlines), so keywords inside them are not seen. */
export function mask(sql: string): string {
  const out = sql.split('');
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? sql.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "'") {
      const backslash = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (backslash && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m && !/\w/.test(sql[i - 1] ?? '')) {
        const e = sql.indexOf(m[0], i + m[0].length);
        const end = e < 0 ? sql.length : e + m[0].length;
        blank(i, end);
        i = end;
      } else i++;
    } else if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      i = e < 0 ? sql.length : e + 1;
    } else i++;
  }
  return out.join('');
}

const CLAUSE = /\b(select|from|(?:natural\s+|cross\s+|(?:left|right|full|inner)(?:\s+outer)?\s+)?join|on|where|group\s+by|having|window|order\s+by|limit|offset|fetch|union(?:\s+all)?|intersect|except|returning|set|values|update|delete|insert\s+into|into|using)\b/gi;

const NOT_ALIAS = new Set(['where', 'join', 'left', 'right', 'full', 'inner', 'outer', 'cross', 'natural', 'on', 'using', 'group', 'order', 'limit', 'offset', 'fetch', 'having', 'window', 'union', 'intersect', 'except', 'returning', 'set', 'values', 'select', 'lateral', 'tablesample', 'with', 'as', 'for']);

export function shape(sql: string): SqlShape {
  const masked = mask(sql);
  const lineStarts = [0];
  for (let k = 0; k < sql.length; k++) if (sql[k] === '\n') lineStarts.push(k + 1);

  // The innermost "(" around each position, and where it closes.
  const openAt: number[] = new Array(sql.length);
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === '(') {
      openAt[k] = stack.length ? stack[stack.length - 1] : -1;
      stack.push(k);
      continue;
    }
    if (masked[k] === ')' && stack.length) {
      closeOf.set(stack.pop()!, k);
      openAt[k] = stack.length ? stack[stack.length - 1] : -1;
      continue;
    }
    openAt[k] = stack.length ? stack[stack.length - 1] : -1;
  }
  const depthOf = (open: number) => {
    let d = 0;
    for (let o = open; o >= 0; o = openAt[o]) d++;
    return d;
  };

  // Clauses grouped by the parentheses they sit in.
  const groups = new Map<number, Clause[]>();
  for (const m of masked.matchAll(CLAUSE)) {
    const open = openAt[m.index!];
    const kw = m[1].toUpperCase().replace(/\s+/g, ' ');
    const norm = /JOIN$/.test(kw) ? 'JOIN' : kw.startsWith('UNION') ? 'UNION' : kw === 'INSERT INTO' ? 'INTO' : kw;
    const list = groups.get(open) ?? [];
    list.push({ kw: norm, start: m.index!, len: m[0].length, end: 0, text: '' });
    groups.set(open, list);
  }

  const blocks: Block[] = [];
  const refs: Ref[] = [];
  for (const [open, list] of groups) {
    const groupEnd = open < 0 ? sql.length : closeOf.get(open) ?? sql.length;
    const isTop = open < 0;
    if (!isTop && list[0].kw !== 'SELECT' && !list.some((c) => c.kw === 'SELECT')) continue; // OVER (...), extract(... from ...)
    for (let k = 0; k < list.length; k++) {
      let e = k + 1 < list.length ? list[k + 1].start : groupEnd;
      while (e > list[k].start && /\s/.test(sql[e - 1])) e--;
      list[k].end = e;
      list[k].text = masked.slice(list[k].start, e);
    }
    let cur: Block | undefined;
    for (const c of list) {
      if (!cur || (c.kw === 'SELECT' && cur.clauses.some((x) => x.kw === 'SELECT'))) {
        // A UNION branch ends where the next SELECT starts.
        if (cur) cur.end = c.start;
        cur = { start: cur ? c.start : open + 1, end: groupEnd, depth: depthOf(open), clauses: [], name: cur || isTop ? undefined : wrapperName(masked, open, groupEnd) };
        blocks.push(cur);
      }
      cur.clauses.push(c);
    }
    // Table names after FROM, JOIN, UPDATE, INTO, DELETE ... FROM.
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (!['FROM', 'JOIN', 'UPDATE', 'INTO', 'USING'].includes(c.kw)) continue;
      if (c.kw === 'USING' && list[k - 1]?.kw !== 'FROM' && list[k - 1]?.kw !== 'DELETE') continue;
      const body = c.start + c.len;
      const items = c.kw === 'FROM' || c.kw === 'USING' ? splitTop(masked, body, c.end) : [[body, c.end] as [number, number]];
      for (const [a, b] of items) {
        const r = readRef(sql, masked, a, b, closeOf);
        if (!r) continue;
        if (c.kw === 'JOIN' && list[k + 1]?.kw === 'ON') r.on = list[k + 1];
        refs.push(r);
      }
    }
  }
  if (!blocks.some((b) => b.depth === 0)) blocks.push({ start: 0, end: sql.length, depth: 0, clauses: [] });
  blocks.sort((a, b) => a.start - b.start);
  return { text: sql, masked, blocks, refs, lineStarts };
}

/** The name a parenthesised query goes by: the CTE name before it, or the alias after it. */
function wrapperName(masked: string, open: number, close: number): string | undefined {
  const before = /([A-Za-z_][\w$]*)\s*(?:\([^()]*\)\s*)?as\s*(?:not\s+)?(?:materialized\s*)?$/i.exec(masked.slice(Math.max(0, open - 120), open));
  if (before) return before[1];
  const after = /^\s*(?:as\s+)?([A-Za-z_][\w$]*)/i.exec(masked.slice(close + 1, close + 80));
  return after && !NOT_ALIAS.has(after[1].toLowerCase()) ? after[1] : undefined;
}

function splitTop(masked: string, a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let s = a;
  for (let k = a; k < b; k++) {
    if (masked[k] === '(') depth++;
    else if (masked[k] === ')') depth--;
    else if (masked[k] === ',' && depth === 0) {
      out.push([s, k]);
      s = k + 1;
    }
  }
  out.push([s, b]);
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
const NAME_RE = new RegExp(String.raw`^\s*(?:only\s+|lateral\s+)?(${IDENT}(?:\s*\.\s*${IDENT})*)`, 'i');
const ALIAS_RE = new RegExp(String.raw`^\s*(?:as\s+)?(${IDENT})`, 'i');

function readRef(sql: string, masked: string, a: number, b: number, closeOf: Map<number, number>): Ref | undefined {
  let k = a;
  while (k < b && /\s/.test(masked[k])) k++;
  if (k >= b) return undefined;
  let name: string | undefined;
  let after: number;
  let pos = k;
  if (masked[k] === '(') {
    after = (closeOf.get(k) ?? b - 1) + 1;
  } else {
    const m = NAME_RE.exec(masked.slice(k, b));
    if (!m) return undefined;
    name = unquote(sql.slice(k + m[0].length - m[1].length, k + m[0].length));
    pos = k + m[0].length - m[1].length;
    after = k + m[0].length;
    // A table function: generate_series(1, 10) g
    let p = after;
    while (p < b && /\s/.test(masked[p])) p++;
    if (masked[p] === '(') after = (closeOf.get(p) ?? b - 1) + 1;
  }
  let alias: string | undefined;
  const am = ALIAS_RE.exec(masked.slice(after, b));
  if (am && !NOT_ALIAS.has(am[1].toLowerCase())) {
    alias = unquote(sql.slice(after + am[0].length - am[1].length, after + am[0].length));
    if (!name) pos = after + am[0].length - am[1].length;
  }
  if (!name && !alias) return undefined;
  return { name, alias, pos };
}

function unquote(s: string): string {
  return s
    .split(/\s*\.\s*/)
    .map((p) => p.replace(/^["`[]|["`\]]$/g, ''))
    .join('.');
}

// ---------- Matching steps to lines ----------

function lineOf(sh: SqlShape, pos: number): number {
  let lo = 0;
  let hi = sh.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sh.lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function linesOf(sh: SqlShape, start: number, end: number): number[] {
  if (end <= start) return [lineOf(sh, start)];
  const a = lineOf(sh, start);
  const b = lineOf(sh, end - 1);
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const WORDS_SKIP = new Set(
  'and or not null is true false like ilike in any all some between exists case when then else end as date timestamp text integer int bigint numeric varchar interval cast desc asc nulls first last using index primary key rowid sum count avg min max'.split(' '),
);

/** Column-like words in a plan condition: `(o.created_at > '2025-12-01'::date)` gives created_at. */
export function columnsIn(cond: string | undefined): string[] {
  if (!cond) return [];
  const s = cond.replace(/'(?:[^']|'')*'/g, ' ').replace(/::\s*[\w ]+(\[\])?/g, ' ');
  const out = new Set<string>();
  for (const m of s.matchAll(/([A-Za-z_][\w$]*)(?:\.("?)([A-Za-z_][\w$]*)\2)?(\s*\()?/g)) {
    if (m[4]) continue; // a function call
    const w = (m[3] ?? m[1]).toLowerCase();
    if (!WORDS_SKIP.has(w) && !/^\d/.test(w)) out.add(w);
  }
  return [...out];
}

function linesWith(sh: SqlShape, clauses: Clause[], words: string[]): number[] {
  if (!words.length) return [];
  return linesMatching(sh, clauses, new RegExp(`(?<![\\w$])(${words.map(escapeRe).join('|')})(?![\\w$])`, 'i'));
}

function linesMatching(sh: SqlShape, clauses: Clause[], re: RegExp): number[] {
  const out: number[] = [];
  for (const c of clauses) {
    for (const l of linesOf(sh, c.start, c.end)) {
      const a = Math.max(sh.lineStarts[l], c.start);
      const b = Math.min(sh.lineStarts[l + 1] ?? sh.text.length, c.end);
      if (re.test(sh.masked.slice(a, b).replace(/"/g, ''))) out.push(l);
    }
  }
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockAt(sh: SqlShape, positions: number[]): Block {
  const top = sh.blocks.find((b) => b.depth === 0) ?? sh.blocks[0];
  if (!positions.length) return top;
  let best = top;
  for (const b of sh.blocks) {
    if (positions.every((p) => p >= b.start && p < b.end) && b.depth >= best.depth) best = b;
  }
  return best;
}

const clausesOf = (b: Block, ...kws: string[]) => b.clauses.filter((c) => kws.includes(c.kw));

function clauseLines(sh: SqlShape, cs: Clause[]): number[] {
  return cs.flatMap((c) => linesOf(sh, c.start, c.end));
}

function findRef(sh: SqlShape, table?: string, alias?: string): Ref | undefined {
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const last = (s?: string) => s?.split('.').pop();
  const tries: ((r: Ref) => boolean)[] = [
    (r) => eq(r.alias, alias) && (!table || eq(last(r.name), last(table)) || !r.name),
    (r) => eq(r.alias, alias),
    (r) => !r.alias && eq(last(r.name), last(alias)),
    (r) => eq(last(r.name), last(table)),
    (r) => eq(r.alias, table),
  ];
  for (const t of tries) {
    const r = sh.refs.find((x) => !x.used && t(x)) ?? sh.refs.find(t);
    if (r) return r;
  }
  return undefined;
}

function limitIn(sh: SqlShape, b: Block): number | undefined {
  for (const c of clausesOf(b, 'LIMIT', 'FETCH')) {
    const m = /(\d+)/.exec(sh.masked.slice(c.start, c.end));
    if (m) return Number(m[1]);
  }
  return undefined;
}

// ---------- Plan tree to steps ----------

interface Built {
  step: PlanStep;
  positions: number[];
  /** The first table read by this step or the ones before it. */
  firstTable?: string;
  /** What a join calls this side: the table, or the CTE or subquery it is part of. */
  label?: string;
}

export interface BuildResult {
  steps: PlanStep[];
  /** The clause keywords as written, in order (top-level query). */
  written: string[];
}

export function buildSteps(root: PNode, sql: string, driver = ''): BuildResult {
  const sh = shape(sql);
  const steps: PlanStep[] = [];
  const top = sh.blocks.find((b) => b.depth === 0) ?? sh.blocks[0];

  /** Clauses of a block; for a subquery the planner folded away, the outer query's. */
  const pick = (b: Block, ...kws: string[]) => {
    const own = clausesOf(b, ...kws);
    return own.length || b === top ? own : clausesOf(top, ...kws);
  };

  const emit = (n: PNode, inputs: Built[], parent?: PNode): Built => {
    const positions = inputs.flatMap((i) => i.positions);
    let firstTable = inputs.find((i) => i.firstTable)?.firstTable;
    const lines = new Set<number>();
    let title = n.op;
    let detail: string | undefined;
    const add = (ls: number[]) => ls.forEach((l) => lines.add(l));

    if (n.kind === 'scan') {
      const ref = findRef(sh, n.table, n.alias);
      if (ref) {
        ref.used = true;
        positions.push(ref.pos);
        add([lineOf(sh, ref.pos)]);
      }
      const name = ref?.name ?? n.table ?? n.alias ?? 'table';
      firstTable = firstTable ?? name;
      const b = blockAt(sh, ref ? [ref.pos] : []);
      const words = [...columnsIn(n.cond), ...columnsIn(n.filter)];
      add(linesWith(sh, clausesOf(b, 'WHERE'), words));
      // SQLite's plan never shows the WHERE test of a scan: take the WHERE lines that name this table.
      let sqliteTest = false;
      if (driver === 'sqlite' && !n.filter && ref) {
        const inBlock = sh.refs.filter((r) => blockAt(sh, [r.pos]) === b);
        const where = clausesOf(b, 'WHERE');
        const ls = inBlock.length === 1 ? clauseLines(sh, where) : linesMatching(sh, where, new RegExp(`(?<![\\w$])${escapeRe(ref.alias ?? ref.name ?? '')}\\s*\\.`, 'i'));
        const before = lines.size;
        add(ls);
        sqliteTest = lines.size > before || (!!ls.length && !n.cond);
      }
      title = `Read ${name}`;
      const by = n.index === 'index' ? 'an index' : n.index === 'primary key' ? 'the primary key' : `index ${n.index}`;
      const pkLookup = n.index === 'primary key' && /^\(?rowid\s*=\s*\?\)?$/i.test(n.cond ?? '');
      const how =
        pkLookup ? `Looks up each match by its primary key`
        : n.index ? `Uses ${by} to find the rows${n.cond ? ` where ${short(n.cond)}` : ''}`
        : `Reads every row of ${name}`;
      const test = n.filter ?? (n.index ? undefined : n.cond);
      detail = `${how}${test ? `, keeping rows where ${short(test)}` : sqliteTest ? ', keeping rows that pass the WHERE test' : ''}.`;
    } else if (n.kind === 'join') {
      const b = blockAt(sh, positions);
      const inner = inputs[inputs.length - 1];
      const withOn = sh.refs.filter((r) => r.on && positions.includes(r.pos));
      const innerOn = withOn.filter((r) => inner?.positions.includes(r.pos));
      const planCond = n.join ?? innerCond(n);
      const words = columnsIn(planCond);
      // Say the condition as written in ON, when this join has one; DuckDB's #0 means nothing to a reader.
      const on = innerOn.length === 1 ? innerOn[0].on! : withOn.length === 1 ? withOn[0].on! : undefined;
      const cond = on ? on.text.slice(on.len) : planCond && !/#\d/.test(planCond) ? planCond : undefined;
      let ls = linesWith(sh, withOn.map((r) => r.on!), words);
      if (!ls.length) ls = linesWith(sh, clausesOf(b, 'WHERE'), words);
      if (!ls.length) ls = clauseLines(sh, innerOn.map((r) => r.on!));
      if (!ls.length && withOn.length) ls = clauseLines(sh, [[...withOn].sort((x, y) => y.pos - x.pos)[0].on!]);
      add(ls);
      const names = inputs.map((i) => i.label ?? i.firstTable).filter(Boolean);
      const type = (n.joinType ?? 'Inner').toLowerCase();
      title =
        names.length < 2 ? 'Join'
        : type === 'semi' ? `Keep ${names[0]} found in ${names[1]}`
        : type === 'anti' ? `Keep ${names[0]} not in ${names[1]}`
        : `Join ${names[0]} + ${names[1]}`;
      const keep =
        type === 'left' ? `, keeping ${names[0] ?? 'left'} rows with no match`
        : type === 'right' ? `, keeping ${names[1] ?? 'right'} rows with no match`
        : type === 'full' ? ', keeping rows with no match on either side'
        : '';
      detail =
        type === 'semi' ? `Keeps each ${names[0] ?? ''} row that has a match in ${names[1] ?? 'the other rows'}${cond ? ` (${short(cond)})` : ''}.`.replace(/\s+/g, ' ')
        : type === 'anti' ? `Keeps each ${names[0] ?? ''} row that has no match in ${names[1] ?? 'the other rows'}${cond ? ` (${short(cond)})` : ''}.`.replace(/\s+/g, ' ')
        : `Matches each ${names[0] ?? 'row'} row with ${names[1] ?? 'the other'} rows${cond ? ` where ${short(cond)}` : ''}${keep}.`;
    } else if (n.kind === 'group') {
      const b = blockAt(sh, positions);
      const groupBy = pick(b, 'GROUP BY');
      add(clauseLines(sh, groupBy));
      if (!groupBy.length) add(selectAggLines(sh, b).length ? selectAggLines(sh, b) : selectAggLines(sh, top));
      if (n.filter) add(clauseLines(sh, pick(b, 'HAVING')));
      const keys = keysOf(groupBy, n.keys);
      title = keys ? `Group by ${keys}` : groupBy.length ? 'Group rows' : 'Total all rows';
      detail = keys || groupBy.length
        ? `Puts rows with the same ${keys ?? 'GROUP BY values'} together and works out the totals for each group${n.filter ? `, then keeps groups where ${short(n.filter)}` : ''}.`
        : 'Works out the totals (count, sum, ...) over all the rows.';
    } else if (n.kind === 'sort' || n.kind === 'topn') {
      const b = blockAt(sh, positions);
      const forGroup = parent?.kind === 'group' || n.op.includes('GROUP BY');
      const forJoin = parent?.kind === 'join';
      const order = pick(b, 'ORDER BY');
      if (forGroup) add(clauseLines(sh, pick(b, 'GROUP BY')));
      else if (!forJoin) add(clauseLines(sh, order));
      const keys = keysOf(forGroup ? pick(b, 'GROUP BY') : forJoin ? [] : order, n.keys);
      if (n.kind === 'topn') {
        add(clauseLines(sh, pick(b, 'LIMIT', 'FETCH')));
        const k = n.top ?? limitIn(sh, b) ?? limitIn(sh, top);
        title = `Top ${k ?? ''} by ${keys ?? 'order'}`.replace(/\s+/g, ' ');
        detail = `Sorts by ${keys ?? 'the ORDER BY'} and keeps only the first ${k ?? 'few'} rows.`;
      } else if (forGroup) {
        title = 'Sort for grouping';
        detail = `Sorts rows${keys ? ` by ${keys}` : ''} so equal values sit next to each other for GROUP BY.`;
      } else if (forJoin) {
        title = 'Sort for joining';
        detail = `Sorts rows${keys ? ` by ${keys}` : ''} so the join can walk both sides in order.`;
      } else {
        title = keys ? `Sort by ${keys}` : 'Sort';
        detail = `Puts the rows in order${keys ? ` of ${keys}` : ''}.`;
      }
    } else if (n.kind === 'limit') {
      const b = blockAt(sh, positions);
      const cs = pick(b, 'LIMIT', 'FETCH', 'OFFSET');
      add(clauseLines(sh, cs));
      const k = limitIn(sh, b) ?? limitIn(sh, top);
      title = k !== undefined ? `Keep first ${k}` : 'Keep first rows';
      detail = `Stops once it has ${k ?? 'enough'} rows${cs.some((c) => c.kw === 'OFFSET') ? ', after skipping the OFFSET rows' : ''}.`;
    } else if (n.kind === 'distinct') {
      const b = blockAt(sh, positions);
      add(clauseLines(sh, clausesOf(b, 'SELECT')).slice(0, 1));
      title = 'Remove duplicates';
      detail = 'Keeps one copy of each distinct row.';
    } else if (n.kind === 'window') {
      const b = blockAt(sh, positions);
      const sel = clausesOf(b, 'SELECT');
      const ls = clauseLines(sh, sel).filter((l) => /\bover\b/i.test(lineText(sh, l)));
      add(ls.length ? ls : clauseLines(sh, sel));
      title = 'Window functions';
      detail = 'Works out the OVER (...) values, looking at nearby rows for each row.';
    } else if (n.kind === 'filter') {
      const b = blockAt(sh, positions);
      const words = columnsIn(n.filter);
      let ls = linesWith(sh, clausesOf(b, 'WHERE'), words);
      if (!ls.length) ls = linesWith(sh, clausesOf(b, 'HAVING', 'ON'), words);
      if (!ls.length && b !== top) ls = linesWith(sh, clausesOf(top, 'WHERE', 'HAVING'), words);
      if (!ls.length) ls = clauseLines(sh, clausesOf(b, 'WHERE'));
      add(ls);
      title = 'Keep matching rows';
      detail = n.filter ? `Keeps rows where ${short(n.filter)}.` : 'Keeps only the rows that pass the test.';
    } else if (n.op === 'EMPTY_RESULT') {
      title = 'Skip: no row can match';
      detail = 'The planner can tell no row passes the test, so this part reads nothing.';
    } else if (n.kind === 'other') {
      title = n.op.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
    } else if (n.kind === 'combine') {
      add(sh.blocks.flatMap((b) => clauseLines(sh, clausesOf(b, 'UNION', 'INTERSECT', 'EXCEPT'))));
      title = /intersect/i.test(n.op) ? 'Intersect' : /except/i.test(n.op) ? 'Except' : 'Combine results';
      detail = 'Puts the results of the queries together.';
    } else if (n.kind === 'values') {
      add(clauseLines(sh, sh.blocks.flatMap((b) => clausesOf(b, 'VALUES'))));
      title = clausesOf(top, 'VALUES').length ? 'Read VALUES' : 'Compute values';
      detail = 'Makes rows from the values written in the query.';
    } else if (n.kind === 'write') {
      const op = n.op.toLowerCase();
      const kw = op === 'insert' ? ['INTO', 'VALUES'] : op === 'update' ? ['UPDATE', 'SET'] : ['DELETE', 'FROM'];
      add(clauseLines(sh, clausesOf(top, ...kw)).slice(0, op === 'update' ? undefined : 2));
      if (!lines.size) add([0]);
      const t = n.table ?? sh.refs[0]?.name ?? 'the table';
      title = op === 'insert' ? `Insert into ${t}` : op === 'update' ? `Update ${t}` : op === 'delete' ? `Delete from ${t}` : `${n.op} ${t}`;
      detail = op === 'insert' ? `Writes the new rows into ${t}.` : op === 'update' ? `Changes the matching rows of ${t}.` : `Removes the matching rows from ${t}.`;
    }
    const step: PlanStep = {
      n: steps.length + 1,
      kind: n.kind as StepKind,
      title,
      detail,
      rows: n.rows,
      inputs: inputs.map((i) => i.step.n),
      lines: [...lines].sort((a, b) => a - b),
    };
    steps.push(step);
    let label: string | undefined;
    if (n.kind === 'scan') label = title.slice('Read '.length);
    else if (n.kind !== 'join') {
      const named = positions.length ? sh.blocks.filter((b) => b.name && positions.every((p) => p >= b.start && p < b.end)) : [];
      label = named.sort((x, y) => y.depth - x.depth)[0]?.name ?? (inputs.length === 1 ? inputs[0].label : undefined);
    }
    return { step, positions, firstTable, label };
  };

  const walk = (n: PNode, parent?: PNode): Built[] => {
    const inputs = n.children.flatMap((c) => walk(c, n.kind === 'hidden' ? parent : n));
    if (n.kind === 'hidden') {
      // A subquery the plan reads by its alias: later steps belong to the outer query.
      const ref = n.alias ? findRef(sh, undefined, n.alias) : undefined;
      if (ref) inputs.forEach((i) => {
        i.positions.push(ref.pos);
        i.label = ref.name ?? n.alias;
      });
      // A pass-through node: hand its filter on as a separate step if it has one.
      if (n.filter && inputs.length) return [emit({ kind: 'filter', op: 'Filter', filter: n.filter, children: [] }, inputs, parent)];
      return inputs;
    }
    return [emit(n, inputs, parent)];
  };

  let outs = walk(root);
  if (!steps.length) return { steps, written: written(sh, top) };

  // SQLite leaves out steps that need no temporary storage.
  const has = (k: StepKind) => steps.some((s) => s.kind === k);
  const infer = (n: PNode) => {
    const b = emit(n, outs);
    b.step.inferred = true;
    outs = [b];
  };
  if (driver === 'sqlite') {
    if (!has('group') && !has('sort') && (clausesOf(top, 'GROUP BY').length || selectAggLines(sh, top).length)) {
      infer({ kind: 'group', op: 'Aggregate', children: [] });
    }
    const head = /^\s*(insert|update|delete|replace)\b/i.exec(sh.masked)?.[1]?.toLowerCase();
    if (limitIn(sh, top) !== undefined && !has('limit')) infer({ kind: 'limit', op: 'Limit', children: [] });
    if (head && !has('write')) infer({ kind: 'write', op: head === 'replace' ? 'Insert' : head[0].toUpperCase() + head.slice(1), children: [] });
  }

  // SELECT runs after the rows are found and grouped, before ORDER BY and LIMIT.
  addSelectStep(sh, top, steps);
  return { steps, written: written(sh, top) };
}

function lineText(sh: SqlShape, l: number): string {
  return sh.masked.slice(sh.lineStarts[l], sh.lineStarts[l + 1] ?? sh.text.length);
}

function selectAggLines(sh: SqlShape, b: Block): number[] {
  return clauseLines(sh, clausesOf(b, 'SELECT')).filter((l) => /\b(count|sum|avg|min|max|string_agg|array_agg|group_concat|listagg|median|any_value|bool_and|bool_or|stddev\w*|variance)\s*\(/i.test(lineText(sh, l)));
}

function addSelectStep(sh: SqlShape, top: Block, steps: PlanStep[]) {
  const sel = clausesOf(top, 'SELECT');
  if (sel.length !== 1 || clausesOf(top, 'UNION', 'INTERSECT', 'EXCEPT').length || steps.some((s) => s.kind === 'write')) return;
  const consumers = (n: number) => steps.filter((s) => s.inputs.includes(n));
  // The last step that is not a sort, limit or distinct makes the output rows.
  let at = steps[steps.length - 1];
  while (['limit', 'sort', 'topn', 'distinct'].includes(at.kind) && at.inputs.length === 1) at = steps[at.inputs[0] - 1];
  if (['limit', 'sort', 'topn', 'distinct'].includes(at.kind)) return;
  const lines = clauseLines(sh, sel);
  const list = sh.text.slice(sel[0].start, sel[0].end).replace(/^select\s+(distinct\s+)?/i, '').replace(/\s+/g, ' ').trim();
  const idx = at.n; // insert right after `at`
  const step: PlanStep = { n: idx + 1, kind: 'select', title: 'Pick columns', detail: `Builds each output row: ${short(list, 70)}.`, rows: at.rows, inputs: [at.n], lines, inferred: true };
  const after = consumers(at.n);
  // Renumber everything after `at` by one.
  for (const s of steps) {
    s.inputs = s.inputs.map((i) => (i > idx ? i + 1 : i));
    if (s.n > idx) s.n++;
  }
  for (const s of after) s.inputs = s.inputs.map((i) => (i === at.n ? idx + 1 : i));
  steps.splice(idx, 0, step);
}

function innerCond(n: PNode): string | undefined {
  // Nested loops often test the join inside the inner index scan.
  const inner = n.children[n.children.length - 1];
  let x: PNode | undefined = inner;
  while (x && x.kind !== 'scan') x = x.children[x.children.length - 1];
  return x?.cond;
}

function written(sh: SqlShape, top: Block): string[] {
  const seen: string[] = [];
  for (const c of top.clauses) {
    const kw = c.kw === 'INTO' ? 'INSERT INTO' : c.kw;
    if (['SELECT', 'FROM', 'JOIN', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'UPDATE', 'SET', 'DELETE', 'INSERT INTO', 'VALUES'].includes(kw) && seen[seen.length - 1] !== kw) seen.push(kw);
  }
  return seen;
}

/** Keys as written in the SQL (GROUP BY / ORDER BY text), else the plan's own. */
function keysOf(cs: Clause[], planKeys?: string): string | undefined {
  const c = cs[0];
  if (c) {
    const t = c.text.slice(c.len).replace(/\s+/g, ' ').trim();
    if (t) return short(t, 40);
  }
  if (!planKeys || /^#\d+(,\s*#\d+)*$/.test(planKeys)) return undefined;
  return short(planKeys.split(/,\s*/).map((x) => x.replace(/^\((.*)\)$/, '$1').replace(/\b\w+\.(\w+)/g, '$1')).join(', '), 40);
}

function short(s: string, max = 60): string {
  // SQLite writes "created_at>?" for a value it fills in later.
  let t = s
    .replace(/\s+/g, ' ')
    .replace(/\s*(<=|>=|<>|!=|=|<|>)\s*\?/g, ' $1 a value')
    .replace(/\?/g, 'a value')
    .trim();
  while (/^\(.*\)$/.test(t) && balanced(t.slice(1, -1))) t = t.slice(1, -1);
  t = t.replace(/::\s*[\w ]+?(?=[\s),]|$)/g, '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    else if (c === ')' && --d < 0) return false;
  }
  return d === 0;
}

function list(v: unknown): string | undefined {
  return Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : undefined;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return Array.isArray(v) ? v.join(' AND ') : String(v).replace(/\n/g, ' ');
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[~,]/g, '')) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export { PLAN_DRIVERS } from '../../shared/protocol';

export function planSteps(driver: string, raw: unknown, sql: string): BuildResult {
  const tableOf = (a: string) => shape(sql).refs.find((r) => r.alias?.toLowerCase() === a.toLowerCase())?.name;
  const root = driver === 'postgres' ? fromPostgres(raw) : driver === 'duckdb' ? fromDuckdb(raw) : fromSqlite(raw as SqliteRow[], tableOf);
  return buildSteps(root, sql, driver);
}

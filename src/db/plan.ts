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
    n.join = p['Hash Cond'] ?? p['Merge Cond'] ?? p['Join Filter'];
    const jt = String(p['Join Type'] ?? 'Inner');
    n.joinType = jt;
    if (children.length === 2) {
      const [outer, inner] = children;
      // A hash join reads the hashed (inner) side first, then probes it.
      if (t === 'Hash Join') n.children = [inner, outer];
      // Semi and anti joins keep rows of one side: put that side first ("Right Anti" keeps the inner side).
      const half = /^(Right )?(Semi|Anti)$/.exec(jt);
      if (half) {
        n.joinType = half[2];
        n.children = half[1] ? [inner, outer] : [outer, inner];
      } else if (jt === 'Left' || jt === 'Right') {
        // An outer join keeps the unmatched rows of one side, which may now be first or second.
        n.joinType = n.children[0] === (jt === 'Left' ? outer : inner) ? 'Left' : 'Right';
      }
    }
  } else if (t === 'Aggregate' || t === 'GroupAggregate' || t === 'HashAggregate' || t === 'Group') {
    n.kind = 'group';
    n.keys = list(p['Group Key']);
    // UNION removes duplicates by grouping on every column.
    if (n.keys && children.length === 1 && (children[0].kind === 'combine' || (children[0].kind === 'sort' && children[0].children[0]?.kind === 'combine'))) n.kind = 'distinct';
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
    // Without RETURNING the plan estimates 0 output rows, which says nothing about the rows written.
    if (!n.rows) n.rows = undefined;
  } else if (t === 'Result' && /^false$/i.test(String(p['One-Time Filter'] ?? ''))) {
    // WHERE 1 = 0 and the like: nothing below runs.
    return { kind: 'other', op: 'EMPTY_RESULT', rows: 0, children: [] };
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

// ---------- MySQL and MariaDB ----------

/** What the MySQL driver's planJson returns: the tree text (MySQL 8.0.16+), else classic JSON (MariaDB, older MySQL, writes). */
export type MysqlPlan = { format: 'tree'; text: string } | { format: 'json'; json: unknown };

interface TreeLine {
  op: string;
  rows?: number;
  children: TreeLine[];
}

/** `EXPLAIN FORMAT=TREE` text: one `-> operation  (cost=... rows=...)` per line, children indented under it. */
function treeLines(text: string): TreeLine[] {
  const roots: TreeLine[] = [];
  const stack: { indent: number; node: TreeLine }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\s*)->\s?(.*)$/.exec(raw);
    if (!m) continue;
    let op = m[2].trim();
    let rows: number | undefined;
    // Estimates come last, after two spaces: "Filter: (c.id > 2)  (cost=0.861 rows=3)".
    const est = /\s{2,}\((cost=[^)]*)\)\s*$/.exec(op) ?? /\s+\((rows=[^)]*)\)\s*$/.exec(op);
    if (est) {
      rows = num(/rows=([\d.e+-]+)/.exec(est[1])?.[1]);
      op = op.slice(0, est.index).trim();
    }
    const node: TreeLine = { op, rows, children: [] };
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

const bare = (s: string) => s.replace(/`/g, '');

/** A MySQL index name, as the step text uses it. */
function mysqlIndex(key: string | undefined): string | undefined {
  if (!key || /^<auto_key\d*>$/i.test(key)) return undefined;
  return /^primary$/i.test(key) ? 'primary key' : bare(key);
}

function mysqlTreeNode(t: TreeLine, firstTable?: string): PNode {
  const op = t.op;
  const children = t.children.map((c) => mysqlTreeNode(c, firstTable));
  const n: PNode = { kind: 'other', op, rows: t.rows, children };
  let m: RegExpExecArray | null;
  if ((m = /^([A-Za-z -]*?(?:scan|lookup|search)(?: \(Multi-Range Read\))?) on (<[^>]+>|\S+)(?: using (\S+))?(?: over \((.*)\)| \((.*)\))?$/i.exec(op))) {
    const [, how, name, index, range, cond] = m;
    if (name.startsWith('<')) n.kind = 'hidden'; // <temporary>, <subquery2>, <union temporary>
    else {
      n.kind = 'scan';
      n.table = n.alias = bare(name);
      if (!/^table scan$/i.test(how.trim())) n.index = mysqlIndex(index) ?? (index ? 'index' : undefined);
      n.cond = mysqlCond(range ?? cond);
    }
  } else if ((m = /^Filter: (.*)$/i.exec(op))) {
    n.kind = 'filter';
    n.filter = mysqlCond(m[1]);
    const having = foldHaving(children, n.filter);
    if (having) return having;
  } else if (/\b(?:join|semijoin|antijoin)\b/i.test(op)) {
    n.kind = 'join';
    n.joinType = /anti/i.test(op) ? 'Anti' : /semi/i.test(op) ? 'Semi' : /\bleft\b/i.test(op) ? 'Left' : /\bfull\b/i.test(op) ? 'Full' : 'Inner';
    const c = /join \((.*)\)$/i.exec(op);
    if (c) n.join = mysqlCond(c[1]);
    // A hash join builds its table from the "Hash" input first, then probes it with the other.
    const h = children.findIndex((x) => x.op === 'Hash');
    if (h > 0) n.children = [children[h], ...children.filter((_, i) => i !== h)];
  } else if ((m = /^Count rows in (\S+)$/i.exec(op))) {
    n.kind = 'group';
    n.children = [{ kind: 'scan', op: 'Table scan', table: bare(m[1]), alias: bare(m[1]), children: [] }];
  } else if (/^(?:Group aggregate|Aggregate|Stream aggregate)\b/i.test(op)) n.kind = 'group';
  else if ((m = /^Sort with duplicate removal/i.exec(op))) n.kind = 'distinct';
  else if ((m = /^Sort: (.*?)(?:, limit input to (\d+) row\(s\) per chunk)?$/i.exec(op))) {
    n.kind = m[2] ? 'topn' : 'sort';
    n.keys = mysqlCond(m[1]);
    if (m[2]) n.top = Number(m[2]);
  } else if (/^Sort row IDs/i.test(op)) n.kind = 'sort';
  else if (/^Limit\b/i.test(op)) n.kind = 'limit';
  else if (/^(?:Union|Intersect|Except)\b.*materialize|^Append\b/i.test(op)) n.kind = 'combine';
  else if (/^(?:Temporary table with deduplication|Remove duplicate)/i.test(op)) n.kind = 'distinct';
  else if (/^Window\b/i.test(op)) n.kind = 'window';
  else if (/^Zero rows\b/i.test(op)) n.op = 'EMPTY_RESULT';
  else if ((m = /^Constant row from (\S+)$/i.exec(op))) {
    n.kind = 'scan';
    n.table = n.alias = bare(m[1]);
    n.index = 'primary key';
  } else if (/^Rows fetched before execution$/i.test(op)) {
    // A row found by its primary or unique key while planning.
    if (firstTable) {
      n.kind = 'scan';
      n.table = firstTable;
      n.index = 'primary key';
    } else n.kind = 'values';
  } else if ((m = /^(Insert into|Replace into|Update|Delete from) (\S+)/i.exec(op))) {
    n.kind = 'write';
    n.op = /^delete/i.test(m[1]) ? 'Delete' : /^update/i.test(m[1]) ? 'Update' : 'Insert';
    n.table = bare(m[2]);
  } else if (/^(?:Hash|Stream results|Materialize|Temporary table|Select #\d|Buffer result|Covering index skip scan for deduplication)\b/i.test(op)) n.kind = 'hidden';
  return n;
}

/**
 * A filter right on top of an aggregate (through hidden nodes) is the HAVING: it goes on
 * the group step, which then points at the HAVING line. Returns the node to use instead.
 */
function foldHaving(children: PNode[], filter: string | undefined): PNode | undefined {
  let g = children[0];
  while (g && g.kind === 'hidden' && g.children.length === 1) g = g.children[0];
  if (children.length !== 1 || g?.kind !== 'group' || g.filter || !filter) return undefined;
  g.filter = filter;
  return children[0];
}

/** Strips schema names and backticks from a MySQL condition: `shop`.`c`.`id` > 2 gives c.id > 2. */
function mysqlCond(c: unknown): string | undefined {
  if (typeof c !== 'string' || !c) return undefined;
  // MySQL prints COUNT(*) as count(0); MariaDB writes EXISTS as <in_optimizer>(c.id,<exists>(subquery#2)).
  return c
    .replace(/`[^`]+`\.(`[^`]+`\.`[^`]+`)/g, '$1')
    .replace(/`/g, '')
    .replace(/\bcount\(0\)/gi, 'count(*)')
    .replace(/<in_optimizer>\([^,()]*,\s*<exists>\(subquery#(\d+)\)\)/g, 'EXISTS (subquery $1)')
    .replace(/!\s*EXISTS \(/g, 'NOT EXISTS (')
    .replace(/<cache>\(([^()]*)\)/g, '$1');
}

/** Classic `EXPLAIN FORMAT=JSON` (MySQL 5.6+, JSON format version 1, and MariaDB). */
function mysqlJsonNode(o: any, firstTable?: string): PNode | undefined {
  if (!o || typeof o !== 'object') return undefined;
  if (o.query_block) return mysqlJsonNode(o.query_block, firstTable);
  if (typeof o.message === 'string' && !o.table && !o.nested_loop) {
    if (/impossible/i.test(o.message)) return { kind: 'other', op: 'EMPTY_RESULT', children: [] };
    return firstTable && /const|before execution|optimized away/i.test(o.message) ? { kind: 'scan', op: o.message, table: firstTable, index: 'primary key', children: [] } : { kind: 'values', op: o.message, children: [] };
  }
  const wrap = (kind: PNode['kind'], op: string, inner: PNode | undefined, extra: Partial<PNode> = {}): PNode | undefined =>
    inner ? { kind, op, children: [inner], rows: inner.rows, ...extra } : undefined;
  // MariaDB writes HAVING next to the part it filters.
  if (typeof o.having_condition === 'string') {
    const { having_condition, ...rest } = o;
    return wrap('filter', 'Having', mysqlJsonNode(rest, firstTable), { filter: mysqlCond(having_condition) });
  }
  // MariaDB lists the subqueries a condition runs (EXISTS, IN) beside the query.
  if (Array.isArray(o.subqueries) && o.subqueries.length) {
    const { subqueries, ...rest } = o;
    const subs = (subqueries as any[]).map((q) => mysqlJsonNode(q, firstTable)).filter((x): x is PNode => !!x);
    const main = mysqlJsonNode(rest, firstTable);
    return main ? { kind: 'hidden', op: 'Subqueries', children: [...subs, main] } : undefined;
  }
  if (o.union_result) {
    const parts = ((o.union_result.query_specifications ?? []) as any[]).map((s) => mysqlJsonNode(s, firstTable)).filter((x): x is PNode => !!x);
    return { kind: 'combine', op: 'Union', children: parts };
  }
  if (o.ordering_operation) {
    const inner = mysqlJsonNode(o.ordering_operation, firstTable);
    return o.ordering_operation.using_filesort === false ? inner : wrap('sort', 'Sort', inner);
  }
  if (o.filesort) return wrap('sort', 'Sort', mysqlJsonNode(o.filesort, firstTable), { keys: mysqlCond(o.filesort.sort_key) });
  if (o.grouping_operation) return wrap('group', 'Aggregate', mysqlJsonNode(o.grouping_operation, firstTable));
  if (o.duplicates_removal) return wrap('distinct', 'Remove duplicates', mysqlJsonNode(o.duplicates_removal, firstTable));
  if (o.windowing) return wrap('window', 'Window', mysqlJsonNode(o.windowing, firstTable));
  if (o.window_functions_computation) return wrap('window', 'Window', mysqlJsonNode(o.window_functions_computation, firstTable));
  for (const k of ['temporary_table', 'buffer_result', 'read_sorted_file']) if (o[k]) return mysqlJsonNode(o[k], firstTable);
  if (Array.isArray(o.nested_loop)) {
    let cur: PNode | undefined;
    for (const item of o.nested_loop as any[]) {
      const t = item.table ?? item['block-nl-join']?.table ?? item['bka-join']?.table;
      const next = t ? mysqlTable(t, firstTable) : mysqlJsonNode(item, firstTable);
      if (!next) continue;
      const cond = mysqlCond(item['block-nl-join']?.attached_condition ?? item['bka-join']?.attached_condition);
      const right = cond ? { kind: 'filter' as const, op: 'Filter', filter: cond, children: [next] } : next;
      cur = cur ? { kind: 'join', op: 'Nested loop', joinType: t?.not_exists ? 'Anti' : 'Inner', rows: num(t?.rows_produced_per_join ?? t?.rows), children: [cur, right] } : right;
    }
    return cur;
  }
  if (o.table) {
    // MariaDB: {"table": {"message": "Impossible WHERE"}}.
    if (typeof o.table.message === 'string' && !o.table.table_name) return mysqlJsonNode({ message: o.table.message }, firstTable);
    // MariaDB's INSERT ... VALUES names only the target table.
    if (o.table.table_name && !o.table.access_type && !o.table.update && !o.table.delete && !o.table.insert && !o.insert_from) return { kind: 'values', op: 'Values', children: [] };
    const t = mysqlTable(o.table, firstTable);
    if (o.insert_from) t.children.push(...[mysqlJsonNode(o.insert_from, firstTable)].filter((x): x is PNode => !!x));
    return t;
  }
  return undefined;
}

function mysqlTable(t: any, firstTable?: string): PNode {
  const name = bare(String(t.table_name ?? ''));
  const rows = num(t.rows_produced_per_join ?? t.rows);
  const write = t.update ? 'Update' : t.delete ? 'Delete' : t.insert ? 'Insert' : undefined;
  const ref = Array.isArray(t.ref) && Array.isArray(t.used_key_parts) && !['const', 'func'].includes(t.ref[0]) ? `${t.used_key_parts[0]} = ${bare(String(t.ref[0])).split('.').slice(-2).join('.')}` : undefined;
  const from = t.materialized_from_subquery ?? t.materialized;
  const sub = from ? mysqlJsonNode(from, firstTable) : undefined;
  // MariaDB names a CTE or derived table <derived2>: read it back under its own name.
  const derived = /^<derived\d+>$/i.test(name) && sub ? mysqlDerived.shift() : undefined;
  const scan: PNode = derived
    ? { kind: 'scan', op: 'Derived', table: derived, alias: derived, cond: ref, rows, children: [sub!] }
    : name.startsWith('<')
    ? { kind: 'hidden', op: name, rows, children: sub ? [sub] : [] }
    : { kind: 'scan', op: String(t.access_type ?? 'scan'), table: name, alias: name, index: mysqlIndex(t.key), cond: ref, rows, children: sub ? [sub] : [] };
  const cond = mysqlCond(t.attached_condition);
  // The test MySQL writes for NOT EXISTS is internal bookkeeping, not the user's condition.
  const filtered = cond && !/found_match|is_not_null_compl/.test(cond) ? (scan.kind === 'scan' ? ((scan.filter = cond), scan) : { kind: 'filter' as const, op: 'Filter', filter: cond, children: [scan] }) : scan;
  if (write) return { kind: 'write', op: write, table: name, children: write === 'Insert' ? [] : [filtered] };
  return filtered;
}

/** CTE and derived table names, in the order the SQL has them (MariaDB's <derivedN>). */
let mysqlDerived: string[] = [];

/** MySQL's plan: the tree text when the server gives one, else classic JSON. */
export function fromMysql(raw: unknown, firstTable?: string, derived: string[] = []): PNode {
  mysqlDerived = [...derived];
  // A bare string is tree text, or JSON when it starts with {; a bare object is classic JSON.
  const p: MysqlPlan =
    typeof raw === 'string' ? (raw.trimStart().startsWith('{') ? { format: 'json', json: JSON.parse(raw) } : { format: 'tree', text: raw })
    : raw && typeof raw === 'object' && 'format' in raw ? (raw as MysqlPlan)
    : { format: 'json', json: raw };
  if (p.format === 'tree') {
    const roots = treeLines(p.text).map((t) => mysqlTreeNode(t, firstTable));
    return roots.length === 1 ? roots[0] : { kind: 'hidden', op: 'roots', children: roots };
  }
  const j = typeof p.json === 'string' ? JSON.parse(p.json) : p.json;
  return mysqlJsonNode(j, firstTable) ?? { kind: 'other', op: 'No plan', children: [] };
}

// ---------- SQL Server ----------

export interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** A small XML reader for showplan XML: elements and attributes only (text, comments and declarations are skipped). */
export function parseXml(xml: string): XmlEl | undefined {
  const root: XmlEl = { name: '#root', attrs: {}, children: [] };
  const stack: XmlEl[] = [root];
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    if (!m[2]) continue;
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]] = (a[2] ?? a[3]).replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (w, e: string) =>
        e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? w,
      );
    }
    const el: XmlEl = { name: m[2].replace(/^\w+:/, ''), attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  return root.children[0];
}

/** The first element named `name` under `el` (depth first), not looking inside nested RelOps. */
function xFind(el: XmlEl, name: string): XmlEl | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    if (c.name === 'RelOp') continue;
    const x = xFind(c, name);
    if (x) return x;
  }
  return undefined;
}

function xAll(el: XmlEl, name: string, out: XmlEl[] = []): XmlEl[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    else if (c.name !== 'RelOp') xAll(c, name, out);
  }
  return out;
}

/** What the plan's own names stand for: Expr1002 is COUNT(*). Set while one plan is read. */
let mssqlExprs = new Map<string, string>();

/** `[shop].[dbo].[orders].[status] as [o].[status]='paid'` gives `o.status='paid'`. */
function mssqlText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  for (let i = 0; i < 3 && /\bExpr\d+\b|@\d/.test(s); i++) s = s.replace(/\[?(\bExpr\d+\b|@\d+\b)\]?/g, (w, e: string) => mssqlExprs.get(e) ?? w);
  return s
    .replace(/(?<![\w\]])\((-?\d+(?:\.\d+)?)\)/g, '$1')
    .replace(/(?<![\w'])N'/g, "'")
    .replace(/CONVERT_IMPLICIT\([^,()]+(?:\(\d+(?:,\d+)?\))?,(.*?),\d+\)/g, '$1')
    .replace(/(?:\[[^\]]+\]\.)+\[[^\]]+\] as (\[[^\]]+\]\.\[[^\]]+\])/g, '$1')
    .replace(/(?:\[[^\]]+\]\.){2,}(\[[^\]]+\]\.\[[^\]]+\])/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1');
}

function mssqlColumn(c: XmlEl | undefined): string | undefined {
  if (!c) return undefined;
  const t = c.attrs.Alias ?? c.attrs.Table;
  return mssqlText(`${t ? `${t}.` : ''}${c.attrs.Column ?? ''}`);
}

function scalar(el: XmlEl | undefined): string | undefined {
  return el ? mssqlText(xFind(el, 'ScalarOperator')?.attrs.ScalarString) : undefined;
}

const SEEK_OP: Record<string, string> = { EQ: '=', LT: '<', LE: '<=', GT: '>', GE: '>=', NE: '<>' };

/** Seek predicates as a condition: `c.id > 2`. */
function seekCond(op: XmlEl): string | undefined {
  const parts: string[] = [];
  for (const k of xAll(op, 'SeekKeys')) {
    for (const side of k.children) {
      const type = side.attrs.ScanType;
      const cols = xAll(side, 'ColumnReference');
      const range = xFind(side, 'RangeColumns');
      const exprs = xFind(side, 'RangeExpressions');
      const col = mssqlColumn(range ? xFind(range, 'ColumnReference') : cols[0]);
      const val = exprs ? scalar(exprs) : undefined;
      if (col && val && type) parts.push(`${col} ${SEEK_OP[type] ?? type} ${val}`);
    }
  }
  return parts.length ? parts.join(' AND ') : undefined;
}

const MSSQL_HIDDEN = /^(Compute Scalar|Parallelism|Segment|Table Spool|Index Spool|Row Count Spool|Window Spool|Eager Spool|Lazy Spool|Bitmap|Assert|Split|Collapse|Adaptive Join)$/i;

function mssqlRelOp(r: XmlEl): PNode {
  const physical = r.attrs.PhysicalOp ?? '';
  const logical = r.attrs.LogicalOp ?? '';
  // The operator's own element (IndexScan, NestedLoops, Hash, ...) is the RelOp child after OutputList etc.
  const op = r.children.find((c) => !['OutputList', 'Warnings', 'MemoryFractions', 'RunTimeInformation', 'RunTimePartitionSummary', 'InternalInfo'].includes(c.name)) ?? r;
  const kids: XmlEl[] = [];
  const collect = (el: XmlEl) => {
    for (const c of el.children) {
      if (c.name === 'RelOp') kids.push(c);
      else collect(c);
    }
  };
  collect(op);
  const children = kids.map(mssqlRelOp);
  const n: PNode = { kind: 'other', op: physical, rows: num(r.attrs.EstimateRows), children };
  const obj = xFind(op, 'Object');
  const predicate = scalar(op.children.find((c) => c.name === 'Predicate'));
  if (/(Insert|Update|Delete|Merge)$/i.test(physical) && obj) {
    n.kind = 'write';
    n.op = /Insert/i.test(physical) ? 'Insert' : /Update/i.test(physical) ? 'Update' : /Delete/i.test(physical) ? 'Delete' : 'Merge';
    n.table = mssqlText(obj.attrs.Table);
    // A clustered index UPDATE or DELETE can find its rows itself, with no read below it.
    const cond = seekCond(op);
    if (!children.length && (cond || predicate)) {
      const idx = mssqlText(obj.attrs.Index);
      n.children = [{ kind: 'scan', op: 'Seek', table: n.table, alias: n.table, index: cond ? (/^PK_/i.test(idx ?? '') ? 'primary key' : idx) : undefined, cond, filter: predicate, rows: n.rows, children: [] }];
    }
  } else if (/Scan|Seek|Lookup/i.test(physical) && obj) {
    n.kind = 'scan';
    n.table = mssqlText(obj.attrs.Table);
    n.alias = mssqlText(obj.attrs.Alias) ?? n.table;
    // A key lookup is written as a Clustered Index Seek with Lookup="1".
    if (/^(1|true)$/i.test(op.attrs.Lookup ?? '')) n.op = 'Key Lookup';
    if (!/Table Scan|Heap/i.test(physical)) {
      const idx = mssqlText(obj.attrs.Index);
      n.index = /Clustered/i.test(physical) && /^PK_/i.test(idx ?? '') ? 'primary key' : idx;
    }
    if (/Seek/i.test(physical)) n.cond = seekCond(op);
    if (predicate) n.filter = predicate;
    // A clustered index scan reads the whole table.
    if (physical === 'Clustered Index Scan') n.index = undefined;
  } else if (physical === 'Constant Scan') n.kind = children.length ? 'hidden' : 'values';
  else if (/Join|Apply/i.test(logical) && /Nested Loops|Hash Match|Merge Join|Adaptive Join/i.test(physical)) {
    n.kind = 'join';
    n.joinType = /Anti/i.test(logical) ? 'Anti' : /Semi/i.test(logical) ? 'Semi' : /Left Outer/i.test(logical) ? 'Left' : /Right Outer/i.test(logical) ? 'Right' : /Full Outer/i.test(logical) ? 'Full' : 'Inner';
    const build = xFind(op, 'HashKeysBuild') ?? xFind(op, 'InnerSideJoinColumns');
    const probe = xFind(op, 'HashKeysProbe') ?? xFind(op, 'OuterSideJoinColumns');
    const keys = build && probe ? `${mssqlColumn(xFind(probe, 'ColumnReference'))} = ${mssqlColumn(xFind(build, 'ColumnReference'))}` : undefined;
    n.join = scalar(xFind(op, 'ProbeResidual') ?? xFind(op, 'Residual')) ?? keys ?? predicate;
    // A Key Lookup (or RID Lookup) fetches the other columns of rows an index found: one read, not a join.
    const lookup = children[1];
    if (/Nested Loops/i.test(physical) && children.length === 2 && /^(Key|RID) Lookup$/i.test(lookup.op) && children[0].table === lookup.table) {
      const first = children[0];
      if (lookup.filter) first.filter = first.filter ? `${first.filter} AND ${lookup.filter}` : lookup.filter;
      return first;
    }
    // Hash Match lists its build input first, which is the order it runs in.
  } else if (/Aggregate/i.test(logical) || physical === 'Stream Aggregate') {
    n.kind = 'group';
    // Grouping with no totals only removes duplicates (UNION, DISTINCT).
    const dv = xFind(op, 'DefinedValues');
    if (xFind(op, 'GroupBy') && (!dv || !dv.children.length)) {
      n.kind = 'distinct';
      return n;
    }
    const g = xFind(op, 'GroupBy') ?? xFind(op, 'HashKeysBuild');
    n.keys = g ? xAll(g, 'ColumnReference').map(mssqlColumn).filter(Boolean).join(', ') || undefined : undefined;
  } else if (/Distinct/i.test(logical)) n.kind = 'distinct';
  else if (physical === 'Sort' || /Sort/i.test(logical)) {
    const top = op.name === 'TopSort' ? num(op.attrs.Rows) : undefined;
    n.kind = top !== undefined || /TopN/i.test(logical) ? 'topn' : 'sort';
    n.top = top;
    const ob = xFind(op, 'OrderBy');
    n.keys = ob ? ob.children.map((c) => `${mssqlColumn(xFind(c, 'ColumnReference')) ?? ''}${c.attrs.Ascending === 'false' ? ' DESC' : ''}`).join(', ') || undefined : undefined;
  } else if (physical === 'Top') {
    n.kind = 'limit';
    const t = Number(scalar(xFind(op, 'TopExpression')));
    if (Number.isFinite(t)) n.top = t;
  }
  else if (physical === 'Filter') {
    n.kind = 'filter';
    n.filter = predicate;
    const having = foldHaving(children, predicate);
    if (having) return having;
  } else if (physical === 'Sequence Project' || /Window Aggregate/i.test(physical)) n.kind = 'window';
  else if (physical === 'Concatenation' || /Union|Concatenation/i.test(logical)) n.kind = 'combine';
  else if (MSSQL_HIDDEN.test(physical)) n.kind = 'hidden';
  return n;
}

/** `SET SHOWPLAN_XML ON` output: the estimated plan, as XML text. */
export function fromMssql(raw: unknown): PNode {
  const doc = typeof raw === 'string' ? parseXml(raw) : (raw as XmlEl | undefined);
  const plans: PNode[] = [];
  mssqlExprs = new Map();
  const names = (el: XmlEl) => {
    for (const c of el.children) {
      if (c.name === 'DefinedValue') {
        const col = c.children.find((x) => x.name === 'ColumnReference')?.attrs.Column;
        const def = c.children.find((x) => x.name === 'ScalarOperator')?.attrs.ScalarString;
        if (col && def && /^Expr\d+$/.test(col) && !mssqlExprs.has(col)) mssqlExprs.set(col, def);
      } else if (c.name === 'ColumnReference' && /^@\d+$/.test(c.attrs.Column ?? '') && c.attrs.ParameterCompiledValue) {
        // A value SQL Server turned into a parameter (auto-parameterization).
        mssqlExprs.set(c.attrs.Column, c.attrs.ParameterCompiledValue);
      }
      names(c);
    }
  };
  if (doc) names(doc);
  const walk = (el: XmlEl) => {
    for (const c of el.children) {
      if (c.name === 'QueryPlan') {
        const r = c.children.find((x) => x.name === 'RelOp');
        if (r) plans.push(mssqlRelOp(r));
      } else walk(c);
    }
  };
  if (doc) walk(doc);
  if (!plans.length) return { kind: 'other', op: 'No plan', children: [] };
  return plans.length === 1 ? plans[0] : { kind: 'hidden', op: 'roots', children: plans };
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

const CLAUSE = /\b(select|from|(?:natural\s+|cross\s+|(?:left|right|full|inner)(?:\s+outer)?\s+)?join|(?<!\bdistinct\s+)on|where|group\s+by|having|window|order\s+by|limit|offset|fetch|union(?:\s+all)?|intersect|except|returning|set|values|update|delete|insert\s+into|into|using)\b/gi;

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
    if (!isTop && !['SELECT', 'DELETE', 'UPDATE', 'INTO'].includes(list[0].kw) && !list.some((c) => c.kw === 'SELECT')) continue; // OVER (...), extract(... from ...); not a write inside WITH
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
      // SQL Server's TOP is part of the SELECT clause.
      const sel = clausesOf(b, 'SELECT');
      if (!cs.length && sel.some((c) => /^select\s+(?:all\s+|distinct\s+)?top\b/i.test(sh.masked.slice(c.start, c.end)))) add(clauseLines(sh, sel).slice(0, 1));
      const k = limitIn(sh, b) ?? limitIn(sh, top) ?? n.top;
      title = k !== undefined ? `Keep first ${k}` : 'Keep first rows';
      detail = `Stops once it has ${k ?? 'enough'} ${k === 1 ? 'row' : 'rows'}${cs.some((c) => c.kw === 'OFFSET') ? ', after skipping the OFFSET rows' : ''}.`;
    } else if (n.kind === 'distinct') {
      const b = blockAt(sh, positions);
      const sel = clausesOf(b, 'SELECT');
      add(clauseLines(sh, sel).slice(0, 1));
      const on = sel.length ? /^select\s+distinct\s+on\s*\(([^)]*)\)/i.exec(sh.text.slice(sel[0].start, sel[0].end)) : null;
      title = 'Remove duplicates';
      detail = on ? `Keeps the first row for each ${short(on[1].replace(/\s+/g, ' ').trim())}.` : 'Keeps one copy of each distinct row.';
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
      // The write may sit inside WITH (... RETURNING ...), not in the statement itself.
      const head = op === 'insert' ? 'INTO' : op === 'update' ? 'UPDATE' : 'DELETE';
      const wb = clausesOf(top, head).length ? top : sh.blocks.find((x) => clausesOf(x, head).length) ?? top;
      add(clauseLines(sh, clausesOf(wb, ...kw)).slice(0, op === 'update' ? undefined : 2));
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
  if (driver === 'sqlite' || driver === 'mysql') {
    // MySQL's classic JSON plan (MariaDB, writes) leaves out LIMIT as well.
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
  if (sel.length !== 1 || clausesOf(top, 'UNION', 'INTERSECT', 'EXCEPT').length || clausesOf(top, 'INSERT INTO', 'INTO', 'UPDATE', 'DELETE').length) return;
  const consumers = (n: number) => steps.filter((s) => s.inputs.includes(n));
  // The last step that is not a sort, limit or distinct makes the output rows.
  let at = steps[steps.length - 1];
  while (['limit', 'sort', 'topn', 'distinct'].includes(at.kind) && at.inputs.length === 1) at = steps[at.inputs[0] - 1];
  if (['limit', 'sort', 'topn', 'distinct'].includes(at.kind)) return;
  const lines = clauseLines(sh, sel);
  const list = sh.text.slice(sel[0].start, sel[0].end).replace(/^select\s+(distinct\s+(?:on\s*\([^)]*\)\s*)?|all\s+)?(top\s*(?:\(\s*[^)]*\)|\d+)(\s+percent)?(\s+with\s+ties)?\s+)?/i, '').replace(/\s+/g, ' ').trim();
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

/**
 * The table MySQL's "Rows fetched before execution" read (a row found by its key while
 * planning): the first table the query reads. For INSERT ... VALUES there is none.
 */
function mysqlFirstTable(sql: string): string | undefined {
  const m = mask(sql);
  if (/^\s*(?:insert|replace)\b/i.test(m)) {
    const at = /\bselect\b[\s\S]*?\bfrom\s+/i.exec(m);
    if (!at) return undefined;
    const name = /^[`\w.$]+/.exec(sql.slice(at.index + at[0].length))?.[0];
    return name ? name.replace(/`/g, '').split('.').pop() : undefined;
  }
  return shape(sql).refs[0]?.name;
}

function derivedNames(sql: string): string[] {
  return shape(sql)
    .blocks.filter((b) => b.name)
    .sort((a, b) => a.start - b.start)
    .map((b) => b.name!);
}

/**
 * PostgreSQL often removes the duplicates of SELECT DISTINCT by grouping on every column
 * (HashAggregate). With no GROUP BY written, that group step is the DISTINCT.
 */
function pgDistinct(root: PNode, sql: string): PNode {
  if (!topLevel(sql, /^select\s+distinct\b/i) || topLevel(sql, /^group\s+by\b/i) || hasOwn(root, 'distinct')) return root;
  let cur: PNode | undefined = root;
  while (cur && cur.kind !== 'group' && cur.children.length === 1 && ['sort', 'topn', 'limit', 'hidden'].includes(cur.kind)) cur = cur.children[0];
  if (cur?.kind === 'group' && cur.keys) cur.kind = 'distinct';
  return root;
}

/** A keyword at the statement's own level (not inside brackets: subqueries, CTEs). */
function topLevel(sql: string, re: RegExp): boolean {
  const m = mask(sql);
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === '(') depth++;
    else if (m[i] === ')') depth--;
    else if (depth === 0 && /\w/.test(m[i]) && !/\w/.test(m[i - 1] ?? '') && re.test(m.slice(i, i + 40))) return true;
  }
  return false;
}

/** Whether this part of the plan has a step of this kind, not counting CTEs and derived tables read back in it. */
function hasOwn(n: PNode, kind: StepKind): boolean {
  return n.kind === kind || (n.op !== 'Derived' && n.children.some((c) => hasOwn(c, kind)));
}

/** MariaDB removes duplicates in a temporary table, with no step of its own: put one back under ORDER BY and LIMIT. */
function mysqlAddDistinct(root: PNode, sql: string): PNode {
  if (hasOwn(root, 'distinct') || !topLevel(sql, /^select\s+distinct\b/i)) return root;
  let parent: PNode | undefined;
  let cur = root;
  while (cur.children.length === 1 && ['sort', 'topn', 'limit', 'hidden'].includes(cur.kind)) {
    parent = cur;
    cur = cur.children[0];
  }
  const d: PNode = { kind: 'distinct', op: 'Remove duplicates', children: [cur] };
  if (!parent) return d;
  parent.children = [d];
  return root;
}

/**
 * Puts a GROUP BY step under ORDER BY and LIMIT, carrying the HAVING. With no ORDER BY,
 * a sort there is MariaDB grouping by sorting, so it becomes the group step.
 */
function insertGroup(root: PNode, sortIsGroup: boolean): PNode {
  let parent: PNode | undefined;
  let having: PNode | undefined;
  let cur = root;
  const passes = (n: PNode) =>
    n.children.length === 1 && (['topn', 'limit', 'distinct', 'hidden'].includes(n.kind) || (n.kind === 'sort' && !sortIsGroup) || (n.kind === 'filter' && n.op === 'Having'));
  while (passes(cur)) {
    if (cur.op === 'Having') having = cur;
    parent = cur;
    cur = cur.children[0];
  }
  let group: PNode;
  if (sortIsGroup && cur.kind === 'sort') {
    group = cur;
    group.kind = 'group';
    group.op = 'Aggregate';
  } else {
    group = { kind: 'group', op: 'Aggregate', rows: cur.rows, children: [cur] };
    if (parent) parent.children = [group];
    else root = group;
  }
  if (having) {
    group.filter = having.filter;
    having.kind = 'hidden';
    having.filter = undefined;
  }
  return root;
}

/**
 * MariaDB's JSON plan groups in a temporary table (or by sorting) and has no grouping
 * step. Put one back, in the statement and in each CTE or derived table that has GROUP BY.
 */
function mysqlAddGroup(root: PNode, sql: string): PNode {
  const sh = shape(sql);
  const visit = (n: PNode) => {
    n.children.forEach(visit);
    if (n.op !== 'Derived' || n.children.length !== 1) return;
    const b = sh.blocks.find((x) => x.name === n.table);
    if (b && clausesOf(b, 'GROUP BY').length && !hasOwn(n.children[0], 'group')) n.children[0] = insertGroup(n.children[0], !clausesOf(b, 'ORDER BY').length);
  };
  visit(root);
  if (hasOwn(root, 'group') || !topLevel(sql, /^group\s+by\b/i)) return root;
  return insertGroup(root, !topLevel(sql, /^order\s+by\b/i));
}

/**
 * SQL Server plans a WHERE that can never be true as an empty Constant Scan. When the
 * statement reads a table but the plan reads none, say that no row can match.
 */
function mssqlEmpty(root: PNode, sql: string): PNode {
  const all: PNode[] = [];
  const walk = (n: PNode) => {
    all.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  if (all.some((n) => n.kind === 'scan' || n.kind === 'write') || !shape(sql).refs.length || /\bvalues\b/i.test(mask(sql))) return root;
  for (const n of all) {
    if (n.kind === 'values' && !n.children.length) {
      n.kind = 'other';
      n.op = 'EMPTY_RESULT';
      n.rows = 0;
    }
  }
  return root;
}

export function planSteps(driver: string, raw: unknown, sql: string): BuildResult {
  const tableOf = (a: string) => shape(sql).refs.find((r) => r.alias?.toLowerCase() === a.toLowerCase())?.name;
  const root =
    driver === 'postgres' ? pgDistinct(fromPostgres(raw), sql)
    : driver === 'duckdb' ? fromDuckdb(raw)
    : driver === 'mysql' ? mysqlAddDistinct(mysqlAddGroup(fromMysql(raw, mysqlFirstTable(sql), derivedNames(sql)), sql), sql)
    : driver === 'mssql' ? mssqlEmpty(fromMssql(raw), sql)
    : fromSqlite(raw as SqliteRow[], tableOf);
  return buildSteps(root, sql, driver);
}

// Query Steps: runs a SELECT one clause at a time, in the order a database
// applies the clauses (FROM, JOIN, WHERE, GROUP BY, HAVING, SELECT, DISTINCT,
// ORDER BY, LIMIT), and keeps a few of the rows after each one, plus the rows
// a step dropped. Only queries that read are run: anything that could write
// is refused before a query is sent.

import type { Column, QueryStep, QueryStepKind, StatementResult, StepRows } from '../../shared/protocol';
import type { DriverId, Session } from './types';

/** Rows shown per step. */
export const SAMPLE_ROWS = 50;

/** A SELECT in parts, so the row cap can go where each database wants it (LIMIT or TOP). */
export interface Select {
  distinct?: string;
  list: string;
  body: string;
}

export interface StepQuery {
  kind: QueryStepKind;
  clause: string;
  title: string;
  unit: 'rows' | 'groups';
  /** [start, end) of the clause in the statement. */
  span: [number, number];
  /** Queries that count this step's rows: the first that runs is used. */
  count?: string[];
  /** Queries for this step's rows: the first that runs is used. A row cap is added. */
  sample: Select[];
  /** The statement itself, run as written (it has its own LIMIT or TOP). */
  raw?: string;
  /** Rows this step drops, or for a LEFT JOIN the rows it keeps with no match. */
  removed?: { sample: Select[]; count?: string; label: string };
  info: StepInfo;
}

interface StepInfo {
  /** JOIN type: inner, left, right, full, cross, other. */
  join?: string;
  /** The table or join target, as written. */
  target?: string;
  /** The condition (WHERE, HAVING, ON), the keys (GROUP BY, ORDER BY) or the LIMIT text. */
  text?: string;
  aggregate?: boolean;
  window?: boolean;
  grouped?: boolean;
  /** GROUP BY rows show the group keys and rows_in_group (not the SELECT list). */
  keysForm?: boolean;
  /** The row count is the previous step's when it can't be counted (SELECT, ORDER BY). */
  inherits?: boolean;
}

export interface StepPlan {
  /** WITH ... put before every query. */
  prefix: string;
  steps: StepQuery[];
}

export const NOT_SELECT = 'Query Steps works on SELECT queries (a WITH ... SELECT is fine).';

const WRITES = /\b(insert|update|delete|merge|upsert|truncate|drop|alter|create|grant|revoke|call|exec|execute|copy|attach|detach|pragma|lock|updlock|xlock|tablockx|holdlock|into|nextval|setval)\b/i;
const KW = /\b(select|from|where|group\s+by|having|window|qualify|order\s+by|limit|offset|fetch|union|intersect|except|minus|into|for)\b/gi;
const JOIN = /\b(?:(?:natural|asof|positional)\s+)?(?:(?:inner|cross|left|right|full)\s+)?(?:(?:outer|semi|anti)\s+)?join\b|\bstraight_join\b|\b(?:cross|outer)\s+apply\b|,/gi;
const AGG = /\b(count|sum|avg|min|max|group_concat|string_agg|array_agg|listagg|median|stddev\w*|variance|var_pop|var_samp|bool_and|bool_or|any_value)\s*\(/i;

/**
 * Two copies of `sql`, the same length: `clean` has comments turned into
 * spaces (so clause text can be moved around safely); `m` also blanks the
 * insides of strings and quoted names, so keywords are only found in code.
 */
export function scan(sql: string, driver: string): { clean: string; m: string } {
  const clean = sql.split('');
  const m = sql.split('');
  const blank = (arr: string[], a: number, b: number) => {
    for (let k = a; k < b && k < arr.length; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if ((c === '-' && sql[i + 1] === '-') || (c === '#' && driver === 'mysql')) {
      const e = sql.indexOf('\n', i);
      const end = e < 0 ? sql.length : e;
      blank(clean, i, end);
      blank(m, i, end);
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      const end = e < 0 ? sql.length : e + 2;
      blank(clean, i, end);
      blank(m, i, end);
      i = end;
    } else if (c === "'") {
      const backslash = driver === 'mysql' || ((sql[i - 1] === 'E' || sql[i - 1] === 'e') && !/\w/.test(sql[i - 2] ?? ''));
      let j = i + 1;
      while (j < sql.length) {
        if (backslash && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(m, i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === '`' || (c === '[' && driver === 'mssql')) {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close && sql[j + 1] === close) j += 2;
        else if (sql[j] === close) break;
        else j++;
      }
      blank(m, i + 1, j);
      i = j + 1;
    } else if (c === '$' && (driver === 'postgres' || driver === 'duckdb')) {
      const q = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (q && !/\w/.test(sql[i - 1] ?? '')) {
        const e = sql.indexOf(q[0], i + q[0].length);
        const end = e < 0 ? sql.length : e + q[0].length;
        blank(m, i + q[0].length, Math.max(i + q[0].length, end - q[0].length));
        i = end;
      } else i++;
    } else i++;
  }
  return { clean: clean.join(''), m: m.join('') };
}

/** Bracket depth at each character; a bracket itself has the depth outside it. */
function depths(m: string): number[] {
  const out = new Array<number>(m.length);
  let d = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === ')') d = Math.max(0, d - 1);
    out[i] = d;
    if (m[i] === '(') d++;
  }
  return out;
}

interface Hit {
  at: number;
  end: number;
  word: string;
}

/** Matches of `re` that are not inside brackets, between a and b. */
function topLevel(m: string, depth: number[], re: RegExp, a = 0, b = m.length): Hit[] {
  const out: Hit[] = [];
  for (const x of m.slice(a, b).matchAll(re)) {
    const at = a + x.index!;
    if (depth[at] === 0) out.push({ at, end: at + x[0].length, word: x[0].toLowerCase().replace(/\s+/g, ' ') });
  }
  return out;
}

/** The index just after the bracket that closes the one at `open`. */
function closeOf(m: string, depth: number[], open: number): number {
  for (let k = open + 1; k < m.length; k++) if (m[k] === ')' && depth[k] === depth[open]) return k + 1;
  return m.length;
}

/** End of the text before `b`, without trailing spaces. */
function trimEnd(s: string, a: number, b: number): number {
  while (b > a && /\s/.test(s[b - 1])) b--;
  return b;
}

function trimStart(s: string, a: number, b: number): number {
  while (a < b && /\s/.test(s[a])) a++;
  return a;
}

/** Collapses white space and shortens, for titles. */
export function short(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

interface Ref {
  /** The table, subquery or table function, without its alias. */
  table: string;
  alias?: string;
  /** How the row is named in the query: the alias, else the table's last name part. */
  name?: string;
  /** Just a table (or subquery) and an alias, so it can be wrapped. */
  simple: boolean;
}

const IDENT = /^(?:[\w$#@]+|"[^"]*"|`[^`]*`|\[[^\]]*\])(?:\s*\.\s*(?:[\w$#@]+|"[^"]*"|`[^`]*`|\[[^\]]*\]))*/;

function readRef(clean: string, m: string, depth: number[], a: number, b: number): Ref {
  a = trimStart(m, a, b);
  b = trimEnd(m, a, b);
  let tableEnd: number;
  let named = false;
  if (m[a] === '(') tableEnd = Math.min(b, closeOf(m, depth, a));
  else {
    const id = IDENT.exec(m.slice(a, b));
    if (!id) return { table: clean.slice(a, b).trim(), simple: false };
    tableEnd = a + id[0].length;
    named = true;
    const k = trimStart(m, tableEnd, b);
    if (m[k] === '(') {
      tableEnd = Math.min(b, closeOf(m, depth, k));
      named = false;
    }
  }
  const table = clean.slice(a, tableEnd).trim();
  const rest = clean.slice(tableEnd, b).trim();
  const al = /^(?:as\s+)?([\w$#@]+|"[^"]*"|`[^`]*`|\[[^\]]*\])$/i.exec(rest);
  const alias = al?.[1];
  const lateral = /^lateral\b/i.test(table);
  const last = named ? table.split('.').pop()!.trim() : undefined;
  return { table, alias, name: alias ?? last, simple: !lateral && (rest === '' || !!al) };
}

function joinType(word: string): string {
  if (/semi|anti|asof|positional|apply|natural/.test(word)) return 'other';
  if (word === ',') return 'comma';
  if (/left/.test(word)) return 'left';
  if (/right/.test(word)) return 'right';
  if (/full/.test(word)) return 'full';
  if (/cross/.test(word)) return 'cross';
  return 'inner';
}

const notMatched = (cond: string) => `CASE WHEN (${cond}) THEN 0 ELSE 1 END = 1`;

/**
 * Splits one SELECT into the queries Query Steps runs. `sql` is a single
 * statement without its closing semicolon.
 */
export function planQuerySteps(sql: string, driver: string): StepPlan | { error: string } {
  const { clean, m } = scan(sql, driver);
  const depth = depths(m);
  const lead = /^\s*(\(|\w+)/.exec(m)?.[1]?.toLowerCase();
  if (lead === '(') return { error: 'Query Steps works on a plain SELECT. Remove the brackets around the query and try again.' };
  if (lead !== 'select' && lead !== 'with') return { error: NOT_SELECT };
  const write = WRITES.exec(m);
  if (write) return { error: `Query Steps only runs queries that read data. This statement uses ${write[1].toUpperCase()}, so nothing was run.` };

  const all = topLevel(m, depth, KW);
  const sel = all.find((h) => h.word === 'select');
  if (!sel) return { error: NOT_SELECT };
  const kws = all.filter((h) => h.at >= sel.at);
  const bad = kws.find((h) => ['union', 'intersect', 'except', 'minus'].includes(h.word));
  if (bad) return { error: `Query Steps works on one SELECT at a time. This query joins several with ${bad.word.toUpperCase()}: run each part on its own to see its steps.` };
  if (kws.some((h) => h.word === 'qualify')) return { error: 'Query Steps does not support QUALIFY yet.' };
  if (kws.some((h) => h.word === 'for')) return { error: 'Query Steps does not support FOR ... clauses.' };
  if (kws.filter((h) => h.word === 'select').length > 1) return { error: NOT_SELECT };
  const from = kws.find((h) => h.word === 'from');
  if (!from) return { error: 'This SELECT does not read from a table, so there are no steps to show.' };

  // Where each clause starts and ends. LIMIT, OFFSET and FETCH are one region.
  const at = (w: string) => kws.find((h) => h.word === w);
  const where = at('where');
  const group = at('group by');
  const having = at('having');
  const windowKw = at('window');
  const order = at('order by');
  const limit = kws.find((h) => h.word === 'limit' || h.word === 'offset' || h.word === 'fetch');
  const marks = [sel, from, where, group, having, windowKw, order, limit].filter((h): h is Hit => !!h);
  for (let i = 1; i < marks.length; i++) if (marks[i].at < marks[i - 1].at) return { error: 'Query Steps expects the clauses in the usual order: SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT.' };
  const endOf = (h: Hit) => {
    const next = marks.find((x) => x.at > h.at);
    return trimEnd(m, h.end, next ? next.at : m.length);
  };
  const body = (h: Hit | undefined) => (h ? clean.slice(h.end, endOf(h)).trim() : '');

  // SELECT [DISTINCT | DISTINCT ON (...) | ALL] [TOP (n)] list
  let p = trimStart(m, sel.end, from.at);
  let distinct: string | undefined;
  let distinctEnd = sel.end;
  const on = /^distinct\s+on\s*\(/i.exec(m.slice(p, from.at));
  if (on) {
    const close = closeOf(m, depth, p + on[0].length - 1);
    distinct = clean.slice(p, close).replace(/\s+/g, ' ');
    p = distinctEnd = close;
  } else if (/^distinct\b/i.test(m.slice(p, from.at))) {
    distinct = 'DISTINCT';
    p = distinctEnd = p + 8;
  } else if (/^all\b/i.test(m.slice(p, from.at))) p += 3;
  let top: [number, number] | undefined;
  if (driver === 'mssql') {
    const q = trimStart(m, p, from.at);
    const t = /^top\s*(?:\([^)]*\)|\d+)(?:\s+percent)?(?:\s+with\s+ties)?/i.exec(m.slice(q, from.at));
    if (t) {
      top = [q, q + t[0].length];
      p = q + t[0].length;
    }
  }
  const S = clean.slice(p, from.at).trim();
  if (!S) return { error: 'The SELECT list is empty.' };
  const listM = m.slice(p, from.at);
  const window = /\bover\b/i.test(listM);
  const aggregate = AGG.test(listM.replace(/\b\w+\s*\([^()]*\)\s*over\b/gi, ''));

  // FROM: the first table, then each JOIN (or comma).
  const fromEnd = endOf(from);
  const fromStart = trimStart(m, from.end, fromEnd);
  const joins = topLevel(m, depth, JOIN, fromStart, fromEnd);
  const items: { at: number; end: number; word?: string; ref: Ref; on?: string; cond?: string }[] = [];
  const firstEnd = trimEnd(m, fromStart, joins[0]?.at ?? fromEnd);
  items.push({ at: fromStart, end: firstEnd, ref: readRef(clean, m, depth, fromStart, firstEnd) });
  joins.forEach((j, k) => {
    const end = trimEnd(m, j.end, joins[k + 1]?.at ?? fromEnd);
    const onKw = topLevel(m, depth, /\b(on|using)\b/gi, j.end, end)[0];
    items.push({
      at: j.at,
      end,
      word: j.word,
      ref: readRef(clean, m, depth, j.end, onKw ? onKw.at : end),
      on: onKw?.word,
      cond: onKw ? clean.slice(onKw.end, end).trim() : undefined,
    });
  });
  const fromThrough = (k: number) => clean.slice(fromStart, items[k].end).trim();
  const F = fromThrough(items.length - 1);

  const prefix = clean.slice(0, sel.at);
  const steps: StepQuery[] = [];
  const first = items[0];
  steps.push({
    kind: 'from',
    clause: 'FROM',
    title: `FROM ${short(clean.slice(first.at, first.end))}`,
    unit: 'rows',
    span: [from.at, first.end],
    count: [`SELECT COUNT(*) FROM ${fromThrough(0)}`],
    sample: [{ list: '*', body: `FROM ${fromThrough(0)}` }],
    info: { target: short(clean.slice(first.at, first.end), 40) },
  });

  for (let k = 1; k < items.length; k++) {
    const it = items[k];
    const type = joinType(it.word!);
    const clause = type === 'comma' ? ', (comma join)' : it.word!.toUpperCase();
    let removed: StepQuery['removed'];
    const prev = items.slice(0, k);
    if ((type === 'inner' || type === 'left') && it.on && it.cond && it.ref.simple && it.ref.name && prev.every((x) => x.ref.name)) {
      const name = it.ref.name;
      const tail = `FROM ${fromThrough(k - 1)}\nLEFT JOIN (SELECT 1 AS sqlnb_match, sqlnb_j.* FROM ${it.ref.table} sqlnb_j) ${name} ${it.on.toUpperCase()} ${it.cond}\nWHERE ${name}.sqlnb_match IS NULL`;
      removed = {
        sample: [{ list: prev.map((x) => `${x.ref.name}.*`).join(', '), body: tail }],
        count: `SELECT COUNT(*) ${tail}`,
        label: type === 'inner' ? `Rows with no match in ${short(it.ref.table, 30)} (dropped)` : `Rows with no match in ${short(it.ref.table, 30)} (kept, with NULLs)`,
      };
    }
    steps.push({
      kind: 'join',
      clause,
      title: short(type === 'comma' ? `, ${clean.slice(trimStart(m, it.at + 1, it.end), it.end)}` : clean.slice(it.at, it.end)),
      unit: 'rows',
      span: [it.at, it.end],
      count: [`SELECT COUNT(*) FROM ${fromThrough(k)}`],
      sample: [{ list: '*', body: `FROM ${fromThrough(k)}` }],
      removed,
      info: { join: type, target: short(it.ref.table, 40), text: it.cond ? short(it.cond, 80) : undefined },
    });
  }

  const W = body(where);
  const wb = `FROM ${F}${W ? `\nWHERE ${W}` : ''}`;
  if (where) {
    steps.push({
      kind: 'where',
      clause: 'WHERE',
      title: `WHERE ${short(W)}`,
      unit: 'rows',
      span: [where.at, endOf(where)],
      count: [`SELECT COUNT(*) ${wb}`],
      sample: [{ list: '*', body: wb }],
      removed: { sample: [{ list: '*', body: `FROM ${F}\nWHERE ${notMatched(W)}` }], label: 'Rows WHERE removed' },
      info: { text: short(W, 80) },
    });
  }

  const G = body(group);
  const gb = `${wb}${G ? `\nGROUP BY ${G}` : ''}`;
  const gm = group ? m.slice(group.end, endOf(group)) : '';
  // Plain keys (no ROLLUP, no 1/2 positions) can be shown on their own with a row count.
  const plainKeys = !!G && !/\b(rollup|cube|grouping\s+sets|all|distinct)\b|\(\s*\)/i.test(gm) && !gm.split(',').some((x) => /^\s*\d+\s*$/.test(x));
  const groupCount = (b: string) => [...(plainKeys ? [`SELECT COUNT(*) FROM (SELECT 1 AS sqlnb_one ${b}) sqlnb_t`] : []), `SELECT COUNT(*) FROM (SELECT ${S} ${b}) sqlnb_t`];
  const groupRows = (b: string): Select[] => [...(plainKeys ? [{ list: `${G}, COUNT(*) AS rows_in_group`, body: b }] : []), { list: `${S}, COUNT(*) AS rows_in_group`, body: b }];
  if (group) {
    steps.push({
      kind: 'group',
      clause: 'GROUP BY',
      title: `GROUP BY ${short(G)}`,
      unit: 'groups',
      span: [group.at, endOf(group)],
      count: groupCount(gb),
      sample: groupRows(gb),
      info: { text: short(G, 80), keysForm: plainKeys },
    });
  }

  const H = body(having);
  const hb = `${gb}${H ? `\nHAVING ${H}` : ''}`;
  if (having) {
    steps.push({
      kind: 'having',
      clause: 'HAVING',
      title: `HAVING ${short(H)}`,
      unit: 'groups',
      span: [having.at, endOf(having)],
      count: groupCount(hb),
      sample: groupRows(hb),
      removed: { sample: groupRows(`${gb}\nHAVING ${notMatched(H)}`), label: 'Groups HAVING removed' },
      info: { text: short(H, 80), keysForm: plainKeys },
    });
  }

  const sb = `${hb}${windowKw ? `\n${clean.slice(windowKw.at, endOf(windowKw)).trim()}` : ''}`;
  steps.push({
    kind: 'select',
    clause: 'SELECT',
    title: `SELECT ${short(S)}`,
    unit: 'rows',
    span: [sel.at, trimEnd(m, sel.at, from.at)],
    sample: [{ list: S, body: sb }],
    info: { aggregate, window, grouped: !!group || !!having, inherits: !aggregate || !!group },
  });

  if (distinct) {
    steps.push({
      kind: 'distinct',
      clause: distinct.toUpperCase().startsWith('DISTINCT ON') ? 'DISTINCT ON' : 'DISTINCT',
      title: short(distinct),
      unit: 'rows',
      span: [sel.at, distinctEnd],
      count: [`SELECT COUNT(*) FROM (SELECT ${distinct} ${S} ${sb}) sqlnb_t`],
      sample: [{ distinct, list: S, body: sb }],
      info: {},
    });
  }

  const O = body(order);
  const ob = `${sb}${O ? `\nORDER BY ${O}` : ''}`;
  if (order) {
    steps.push({
      kind: 'order',
      clause: 'ORDER BY',
      title: `ORDER BY ${short(O)}`,
      unit: 'rows',
      span: [order.at, endOf(order)],
      sample: [{ distinct, list: S, body: ob }],
      info: { text: short(O, 80), inherits: true },
    });
  }

  if (limit || top) {
    const span: [number, number] = limit ? [limit.at, trimEnd(m, limit.at, m.length)] : top!;
    const text = clean.slice(span[0], span[1]).replace(/\s+/g, ' ').trim();
    steps.push({
      kind: 'limit',
      clause: text.split(' ')[0].toUpperCase(),
      title: short(text),
      unit: 'rows',
      span,
      sample: [],
      raw: clean.trim(),
      info: { text: short(text, 80) },
    });
  }

  return { prefix, steps };
}

/** The SQL for a Select, with an optional row cap in the database's own syntax. */
export function render(prefix: string, q: Select, driver: string, cap?: number): string {
  const top = cap !== undefined && driver === 'mssql' ? `TOP (${cap}) ` : '';
  const limit = cap !== undefined && driver !== 'mssql' ? `\nLIMIT ${cap}` : '';
  return `${prefix}SELECT ${q.distinct ? `${q.distinct} ` : ''}${top}${q.list}\n${q.body}${limit}`;
}

// ---------- Running ----------

export interface RunStepsOptions {
  sampleRows: number;
  /** Lines of the statement a step's clause covers. */
  linesOf: (span: [number, number]) => number[];
  /** Called whenever a step changes, with every step. */
  onUpdate: (steps: QueryStep[]) => void;
  /** True once the user stopped the run. */
  stopped: () => boolean;
  /** Stops a query that runs longer than this (0: no limit). */
  timeoutMs?: number;
}

class StepError extends Error {}

/** Runs each step's queries on `session` and fills in its rows. Never throws. */
export async function runQuerySteps(session: Session, plan: StepPlan, driver: string, opts: RunStepsOptions): Promise<QueryStep[]> {
  const cap = opts.sampleRows;
  const steps: QueryStep[] = plan.steps.map((q, i) => ({ n: i + 1, kind: q.kind, clause: q.clause, title: q.title, unit: q.unit, lines: opts.linesOf(q.span), status: 'pending' }));

  const one = async (sql: string, maxRows: number): Promise<StatementResult> => {
    if (opts.stopped()) throw new StepError('Stopped.');
    let out: StatementResult | undefined;
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      void session.cancel().catch(() => undefined);
    }, opts.timeoutMs) : undefined;
    try {
      await session.run([sql], { maxRows, onStart: () => undefined, onResult: (r) => (out ??= r) });
    } catch (e) {
      if (timedOut) throw new StepError(`Stopped after ${Math.round(opts.timeoutMs! / 1000)} s (sqlNotebook.queryTimeoutSeconds).`);
      if (opts.stopped()) throw new StepError('Stopped.');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!out?.hasRows) throw new Error('The query returned no rows.');
    return out;
  };
  /** The first query of `sqls` that runs. If none does, the first one's error. */
  const firstOf = async (sqls: string[], maxRows: number): Promise<{ result: StatementResult; index: number }> => {
    let firstError: unknown;
    for (let i = 0; i < sqls.length; i++) {
      try {
        return { result: await one(sqls[i], maxRows), index: i };
      } catch (e) {
        if (e instanceof StepError) throw e;
        firstError ??= e;
      }
    }
    throw firstError ?? new Error('Nothing to run.');
  };
  const rowsOf = (r: StatementResult): StepRows => ({ columns: r.columns as Column[], rows: r.rows.slice(0, cap), more: r.rows.length > cap });
  const countOf = async (sqls: string[] | undefined): Promise<number | undefined> => {
    if (!sqls?.length) return undefined;
    try {
      const { result } = await firstOf(sqls, 1);
      const n = Number(result.rows[0]?.[0]);
      return Number.isFinite(n) ? n : undefined;
    } catch (e) {
      if (e instanceof StepError) throw e;
      return undefined;
    }
  };

  let prev: number | undefined;
  for (let i = 0; i < plan.steps.length; i++) {
    const q = plan.steps[i];
    const s = steps[i];
    if (opts.stopped()) {
      s.status = 'error';
      s.error = 'Stopped.';
      continue;
    }
    s.status = 'running';
    opts.onUpdate(steps);
    try {
      if (q.raw) {
        const r = await one(q.raw, cap + 1);
        s.sample = rowsOf(r);
        s.sql = q.raw;
      } else {
        const { result, index } = await firstOf(
          q.sample.map((x) => render(plan.prefix, x, driver, cap + 1)),
          cap + 1,
        );
        s.sample = rowsOf(result);
        s.sql = render(plan.prefix, q.sample[index], driver);
        if (q.kind === 'group' || q.kind === 'having') q.info.keysForm = q.info.keysForm && index === 0;
      }
      s.rows = await countOf(q.count?.map((c) => plan.prefix + c));
      if (s.rows === undefined && !s.sample.more) s.rows = s.sample.rows.length;
      if (s.rows === undefined && q.info.inherits) s.rows = prev;

      if (q.removed) {
        try {
          const { result } = await firstOf(
            q.removed.sample.map((x) => render(plan.prefix, x, driver, cap + 1)),
            cap + 1,
          );
          s.removedRows = rowsOf(result);
          s.removedLabel = q.removed.label;
          s.removed = q.removed.count ? await countOf([plan.prefix + q.removed.count]) : undefined;
          if (s.removed === undefined && !s.removedRows.more) s.removed = s.removedRows.rows.length;
        } catch (e) {
          if (e instanceof StepError) throw e;
          // The rows dropped are a bonus: the step itself still ran.
        }
      }
      if (q.kind !== 'join' && s.removed === undefined && prev !== undefined && s.rows !== undefined && ['where', 'having', 'distinct', 'limit'].includes(q.kind)) {
        s.removed = Math.max(0, prev - s.rows);
      }
      s.detail = describe(q, s, prev, cap);
      s.status = 'done';
    } catch (e) {
      s.status = 'error';
      s.error = e instanceof Error ? e.message : String(e);
    }
    prev = s.rows;
    opts.onUpdate(steps);
  }
  return steps;
}

export function fmtCount(n: number | undefined, cap: number): string {
  return n === undefined ? `more than ${cap}` : n.toLocaleString('en-US');
}

const plural = (n: number | undefined, one: string, many: string) => (n === 1 ? one : many);

/** A plain-English sentence about what a step did. */
export function describe(q: StepQuery, s: QueryStep, prev: number | undefined, cap: number): string {
  const n = (x: number | undefined) => fmtCount(x, cap);
  const rows = s.rows;
  const from = prev !== undefined && rows !== undefined ? `${n(prev)} → ${n(rows)}` : n(rows);
  const info = q.info;
  switch (q.kind) {
    case 'from':
      return `Reads every row of ${info.target}: ${n(rows)} ${plural(rows, 'row', 'rows')}.`;
    case 'join': {
      const t = info.target;
      const cond = info.text ? ` where ${info.text}` : '';
      let text: string;
      if (info.join === 'inner') text = `Pairs each row with the rows of ${t}${cond}. Rows with no match are dropped.`;
      else if (info.join === 'left') text = `Keeps every row and adds the matching rows of ${t}${cond}. Rows with no match keep empty (NULL) ${t} columns.`;
      else if (info.join === 'right') text = `Keeps every row of ${t} and adds the matching rows from before${cond}.`;
      else if (info.join === 'full') text = `Keeps every row from both sides, matched where possible${cond}.`;
      else if (info.join === 'cross' || info.join === 'comma') text = `Pairs every row with every row of ${t}. A WHERE later usually keeps only the pairs that belong together.`;
      else text = `Joins ${t}${cond}.`;
      text += ` Rows: ${from}.`;
      if (s.removed !== undefined && s.removed > 0) {
        text += info.join === 'left' ? ` ${n(s.removed)} ${plural(s.removed, 'row had', 'rows had')} no match.` : ` ${n(s.removed)} ${plural(s.removed, 'row had', 'rows had')} no match and ${plural(s.removed, 'was', 'were')} dropped.`;
        if (info.join === 'inner' && prev !== undefined && rows !== undefined && rows > prev - s.removed) text += ' Some rows matched more than once, so they appear once per match.';
      } else if (info.join === 'inner' && prev !== undefined && rows !== undefined && rows > prev) text += ' Some rows matched more than once, so they appear once per match.';
      return text;
    }
    case 'where':
      return `Keeps only the rows where ${info.text}. Rows: ${from}${s.removed ? `, ${n(s.removed)} removed` : ', none removed'}.`;
    case 'group':
      return `Rows with the same ${info.text} become one group: ${n(prev)} ${plural(prev, 'row', 'rows')} → ${n(rows)} ${plural(rows, 'group', 'groups')}.${info.keysForm ? ' rows_in_group counts the rows in each group.' : ' Each row here is one group; rows_in_group counts the rows in it.'}`;
    case 'having':
      return `Keeps only the groups where ${info.text}. Groups: ${from}${s.removed ? `, ${n(s.removed)} removed` : ', none removed'}.`;
    case 'select': {
      const cols = s.sample?.columns.length ?? 0;
      const what = `${cols} ${plural(cols, 'column', 'columns')}`;
      if (info.aggregate && !info.grouped) return `There is no GROUP BY, so the aggregate functions fold all ${n(prev)} rows into ${n(rows)} ${plural(rows, 'row', 'rows')} with ${what}.`;
      const win = info.window ? ' Window functions (OVER) are worked out here, after WHERE and GROUP BY.' : '';
      if (info.grouped) return `Each group becomes one row with the ${what} you asked for: ${n(rows)} ${plural(rows, 'row', 'rows')}.${win}`;
      return `Picks the ${what} you asked for. The number of rows stays ${n(rows)}.${win}`;
    }
    case 'distinct':
      return `Removes duplicate rows. Rows: ${from}${s.removed ? `, ${n(s.removed)} duplicates removed` : ', no duplicates found'}.`;
    case 'order':
      return `Sorts the rows by ${info.text}. Nothing is removed; only the order changes.`;
    case 'limit':
      return `${info.text} keeps ${n(rows)} of the ${n(prev)} rows. This is your final result.`;
  }
}

/** 0-based lines that [a, b) of `text` covers. */
export function linesIn(text: string, span: [number, number]): number[] {
  const first = text.slice(0, span[0]).split('\n').length - 1;
  const last = text.slice(0, Math.max(span[0], span[1])).split('\n').length - 1;
  const out: number[] = [];
  for (let l = first; l <= last; l++) out.push(l);
  return out;
}

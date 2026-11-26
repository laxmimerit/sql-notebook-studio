// Classifies statements so read-only connections refuse writes and risky
// statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE) can be confirmed.

import { skipQuoted, stripComments } from './splitter';
import type { DriverId } from './types';

const WRITE = /^(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|CLUSTER|COPY|LOAD|IMPORT|ATTACH|DETACH|CALL|EXEC|EXECUTE|DO|SET\s+PASSWORD|LOCK|OPTIMIZE|REPAIR|INSTALL|UNINSTALL)\b/i;

const ROUTINE = /^\s*(?:CREATE|ALTER)\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:TEMP(?:ORARY)?\s+)?(?:PROCEDURE|PROC|FUNCTION|TRIGGER|EVENT)\b/i;

export interface Classification {
  write: boolean;
  /** A short reason when the statement is risky, else undefined. */
  risk?: string;
}

/**
 * Classifies a statement. `dialect` decides how strings and comments are read
 * (MySQL `#` comments and backslash escapes, PostgreSQL dollar quotes, ...);
 * without it the common ANSI rules apply.
 *
 * Only the statement's own top level counts: a WHERE inside a subquery, a
 * string, a quoted name or a comment does not stop "UPDATE without WHERE".
 */
export function classify(sql: string, dialect?: DriverId): Classification {
  const mask = maskNested(sql, dialect);
  // Defining a procedure, function or trigger runs none of its body.
  if (ROUTINE.test(mask)) return classifyOne(sql, mask, dialect);
  let write = false;
  let risk: string | undefined;
  // Statements a cell or batch keeps together (a SQL Server batch, for one).
  let start = 0;
  for (let i = 0; i <= mask.length; i++) {
    if (i < mask.length && mask[i] !== ';') continue;
    const c = classifyOne(sql.slice(start, i), mask.slice(start, i), dialect);
    write ||= c.write;
    risk ??= c.risk;
    start = i + 1;
  }
  return { write, risk };
}

function classifyOne(sql: string, mask: string, dialect?: DriverId): Classification {
  const at = mask.search(/\S/);
  if (at < 0) return { write: false, risk: undefined };
  let text = sql.slice(at);
  let top = mask.slice(at);
  let write = false;
  let risk: string | undefined;

  if (/^WITH\b/i.test(top)) {
    // A CTE can itself change data in PostgreSQL: WITH d AS (DELETE FROM t) SELECT ...
    for (const body of cteBodies(text, top)) {
      const c = classify(body, dialect);
      write ||= c.write;
      risk ??= c.risk;
    }
    // The main statement comes after the last CTE: WITH x AS (...) DELETE FROM t
    const m = /\)\s*(INSERT|UPDATE|DELETE|MERGE|SELECT)\b/i.exec(top);
    if (m) {
      const k = m.index + m[0].length - m[1].length;
      text = text.slice(k);
      top = top.slice(k);
    }
  }

  const head = top.trim().replace(/\s+/g, ' ');
  write ||= WRITE.test(head) || (/^SELECT\b/i.test(head) && /\bINTO\s+(?:\S+\s+)?FROM\b/i.test(head));

  const label = stripComments(text, dialect === 'mysql').trim().replace(/\s+/g, ' ');
  const drop = /^DROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX)\s+(?:IF\s+EXISTS\s+)?([^\s,;]+)/i.exec(label);
  if (drop) risk ??= `DROP ${drop[1].toUpperCase()} ${drop[2]}`;
  else if (/^TRUNCATE\b/i.test(head)) risk ??= 'TRUNCATE';
  else if (/^(DELETE|UPDATE)\b/i.test(head) && !/\bWHERE\b/i.test(head)) risk ??= `${head.split(' ')[0].toUpperCase()} without WHERE`;
  return { write, risk };
}

/**
 * True when `sql` holds more than one statement: a `;` outside strings, quoted
 * names and comments, other than a final one. Query Flow and Query Steps fill in
 * {{variables}} after the cell is split, so a value like `1; DROP TABLE t` would
 * otherwise reach the database as a second statement.
 */
export function hasSeveralStatements(sql: string, dialect?: DriverId): boolean {
  return maskNested(sql, dialect).replace(/;\s*$/, '').includes(';');
}

/** The bodies of the CTEs in a WITH statement: `name AS (body)`. */
function cteBodies(text: string, top: string): string[] {
  const out: string[] = [];
  const re = /\bAS\s*(?:(?:NOT\s+)?MATERIALIZED\s*)?\(/gi;
  for (let m = re.exec(top); m; m = re.exec(top)) {
    const open = m.index + m[0].length - 1;
    // The mask keeps nested brackets, so count them to find the one that closes this body.
    let close = -1;
    for (let k = open + 1, depth = 1; k < top.length; k++) {
      if (top[k] === '(') depth++;
      else if (top[k] === ')' && --depth === 0) {
        close = k;
        break;
      }
    }
    out.push(text.slice(open + 1, close === -1 ? text.length : close));
  }
  return out;
}

/**
 * The SQL with comments, strings, quoted names and everything between
 * parentheses turned into spaces. The parentheses themselves stay. The result
 * has the same length as the input, so an index in one is an index in the other.
 *
 *   UPDATE t SET a = (SELECT b FROM u WHERE id = 1) -- note
 *   UPDATE t SET a = (                            )
 */
export function maskNested(sql: string, dialect?: DriverId): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const mysql = dialect === 'mysql';
  const dollar = dialect === 'postgres' || dialect === 'duckdb';
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.substr(i, 2);
    let end = -1;
    if (two === '--' || (mysql && ch === '#')) {
      const nl = sql.indexOf('\n', i);
      end = nl === -1 ? sql.length : nl;
    } else if (two === '/*') {
      const e = sql.indexOf('*/', i + 2);
      end = e === -1 ? sql.length : e + 2;
    } else if (ch === "'" || ch === '"' || (ch === '`' && dialect !== 'postgres')) {
      const backslash = mysql || (ch === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? ''));
      end = skipQuoted(sql, i, ch, backslash);
    } else if (ch === '[' && (dialect === 'mssql' || dialect === 'sqlite')) {
      const e = sql.indexOf(']', i + 1);
      end = e === -1 ? sql.length : e + 1;
    } else if (dollar && ch === '$' && !/\w/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        end = e === -1 ? sql.length : e + m[0].length;
      }
    }
    if (end !== -1) {
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth > 0) out[i] = ' ';
    i++;
  }
  return out.join('');
}

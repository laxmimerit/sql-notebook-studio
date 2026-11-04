// Splits a cell into statements. Aware of strings, quoted names, comments,
// PostgreSQL/DuckDB dollar quotes, MySQL DELIMITER, SQL Server GO batches,
// and BEGIN ... END bodies of triggers, procedures and functions.

import type { DriverId } from './types';

export interface Statement {
  sql: string;
  /** Character offset of the statement in the cell. */
  offset: number;
  /** 0-based line of the statement's first character in the cell. */
  line: number;
}

const COMPOUND_HEAD =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TRIGGER|PROCEDURE|FUNCTION|EVENT)\b/i;

export function splitStatements(text: string, dialect: DriverId): Statement[] {
  const src = text.replace(/\r\n?/g, '\n');
  if (dialect === 'mssql') return splitBatches(src);

  const out: Statement[] = [];
  const mysql = dialect === 'mysql';
  const dollar = dialect === 'postgres' || dialect === 'duckdb';
  const compoundAllowed = dialect === 'mysql' || dialect === 'sqlite';
  let delimiter = ';';
  let start = 0;
  let i = 0;
  let depth = 0;
  let head = '';
  let prevWord = '';
  let pendingEnd = false;

  const emit = (end: number, next: number) => {
    pushStatement(out, src, start, end, mysql);
    start = next;
    depth = 0;
    head = '';
    prevWord = '';
    pendingEnd = false;
  };

  while (i < src.length) {
    const ch = src[i];
    const rest2 = src.substr(i, 2);

    // MySQL DELIMITER command: only at the start of a line, before any statement text.
    if (mysql && (i === 0 || src[i - 1] === '\n') && isBlank(src.slice(start, i))) {
      const m = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\n|$)/i.exec(src.slice(i));
      if (m) {
        delimiter = m[1];
        i += m[0].length;
        start = i;
        continue;
      }
    }

    if (rest2 === '--' || (mysql && ch === '#')) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (rest2 === '/*') {
      const endC = src.indexOf('*/', i + 2);
      i = endC === -1 ? src.length : endC + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '`' && dialect !== 'postgres')) {
      const backslash = mysql || (ch === "'" && /[eE]/.test(src[i - 1] ?? '') && !/\w/.test(src[i - 2] ?? ''));
      i = skipQuoted(src, i, ch, backslash);
      continue;
    }
    if (ch === '[' && dialect === 'sqlite') {
      const endB = src.indexOf(']', i + 1);
      i = endB === -1 ? src.length : endB + 1;
      continue;
    }
    if (dollar && ch === '$' && !/\w/.test(src[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        const endD = src.indexOf(m[0], i + m[0].length);
        i = endD === -1 ? src.length : endD + m[0].length;
        continue;
      }
    }

    // Words, for BEGIN ... END tracking inside compound statements.
    if (/[A-Za-z_]/.test(ch) && !/\w/.test(src[i - 1] ?? '')) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 128))!;
      const word = m[0].toUpperCase();
      if (head.length < 200) head += (head ? ' ' : '') + word;
      if (compoundAllowed && COMPOUND_HEAD.test(head)) {
        if (pendingEnd) {
          // "END IF", "END LOOP", ... close blocks we never counted; "END CASE" closes a CASE.
          pendingEnd = false;
          if (!['IF', 'LOOP', 'WHILE', 'REPEAT', 'CASE'].includes(word)) depth = Math.max(0, depth - 1);
          else if (word === 'CASE') depth = Math.max(0, depth - 1);
          if (word === 'CASE') {
            prevWord = word;
            i += m[0].length;
            continue;
          }
        }
        if (word === 'BEGIN' || (word === 'CASE' && prevWord !== 'END')) depth++;
        else if (word === 'END') pendingEnd = true;
      }
      prevWord = word;
      i += m[0].length;
      continue;
    }

    if (src.startsWith(delimiter, i)) {
      if (pendingEnd) {
        pendingEnd = false;
        depth = Math.max(0, depth - 1);
      }
      if (depth === 0) {
        emit(i, i + delimiter.length);
        i += delimiter.length;
        continue;
      }
    }
    i++;
  }
  emit(src.length, src.length);
  return out;
}

function splitBatches(src: string): Statement[] {
  // SQL Server: GO on its own line ends a batch. Each batch is sent as one request.
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest2 = src.substr(i, 2);
    if (rest2 === '--') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (rest2 === '/*') {
      const endC = src.indexOf('*/', i + 2);
      i = endC === -1 ? src.length : endC + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i, ch, false);
      continue;
    }
    if (ch === '[') {
      const endB = src.indexOf(']', i + 1);
      i = endB === -1 ? src.length : endB + 1;
      continue;
    }
    if ((i === 0 || src[i - 1] === '\n')) {
      const m = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:\n|$)/i.exec(src.slice(i));
      if (m) {
        const times = Math.min(Number(m[1] ?? 1), 1000);
        const before = out.length;
        pushStatement(out, src, start, i);
        if (out.length > before) for (let t = 1; t < times; t++) out.push({ ...out[out.length - 1] });
        i += m[0].length;
        start = i;
        continue;
      }
    }
    i++;
  }
  pushStatement(out, src, start, src.length);
  return out;
}

function skipQuoted(src: string, i: number, quote: string, backslash: boolean): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (backslash && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (src[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return src.length;
}

function pushStatement(out: Statement[], src: string, start: number, end: number, hash = false) {
  const raw = src.slice(start, end);
  if (isBlank(stripComments(raw, hash))) return;
  const lead = raw.length - raw.trimStart().length;
  const offset = start + lead;
  out.push({ sql: raw.trim(), offset, line: countLines(src, offset) });
}

function countLines(src: string, offset: number): number {
  let n = 0;
  for (let k = 0; k < offset; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
}

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/** Removes comments outside of strings. Used to test for empty statements and to classify. */
export function stripComments(sql: string, hashComments = false): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.substr(i, 2);
    if (two === '--' || (hashComments && ch === '#')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === '/*') {
      const e = sql.indexOf('*/', i + 2);
      i = e === -1 ? sql.length : e + 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const j = skipQuoted(sql, i, ch, false);
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

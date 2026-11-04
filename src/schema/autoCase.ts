// Decides whether the word just finished in a SQL cell is a SQL keyword of
// the connected database, and so should be turned into capitals.
// Kept free of the vscode module so unit tests can import it.
//
// The keyword lists are not ours: they come from sql-formatter's definition
// of each database (MySQL, PostgreSQL, SQL Server, SQLite, DuckDB), so an
// update of that package brings new keywords with it.

import { duckdb, expandPhrases, mysql, postgresql, sqlite, transactsql } from 'sql-formatter';
import type { DriverId } from '../db/types';

type Dialect = typeof mysql;

const DIALECTS: Record<DriverId, Dialect> = { mysql, postgres: postgresql, mssql: transactsql, sqlite, duckdb };

/** sql-formatter treats these as syntax in every dialect rather than listing them. */
const SYNTAX = ['CASE', 'WHEN', 'THEN', 'ELSE', 'END'];

/** Words after which the next word is a name the user chose. */
const NAME_AFTER = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'VIEW', 'INDEX', 'AS', 'DATABASE', 'SCHEMA', 'USE', 'EXISTS', 'TRIGGER', 'FUNCTION', 'PROCEDURE']);

/** Words that can start an item in a CREATE TABLE column list and are not column names. */
const TABLE_ITEM = new Set(['PRIMARY', 'FOREIGN', 'CONSTRAINT', 'UNIQUE', 'CHECK', 'INDEX', 'KEY', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'LIKE', 'EXCLUDE']);

export interface DialectWords {
  keywords: Set<string>;
  functions: Set<string>;
  dataTypes: Set<string>;
}

const cache = new Map<DriverId, DialectWords>();

/** The keyword, function and data type names sql-formatter knows for a database. */
export function dialectWords(driver: DriverId): DialectWords {
  let w = cache.get(driver);
  if (w) return w;
  const t = DIALECTS[driver].tokenizerOptions;
  const keywords = new Set<string>(SYNTAX);
  const phrases = [...t.reservedSelect, ...t.reservedClauses, ...t.reservedSetOperations, ...t.reservedJoins, ...(t.reservedKeywordPhrases ?? []), ...(t.reservedDataTypePhrases ?? [])];
  for (const p of expandPhrases(phrases)) for (const word of p.split(/\s+/)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) keywords.add(word.toUpperCase());
  for (const k of t.reservedKeywords) keywords.add(k.toUpperCase());
  const upper = (xs: readonly string[] | undefined) => new Set((xs ?? []).map((x) => x.toUpperCase()));
  w = { keywords, functions: upper(t.reservedFunctionNames), dataTypes: upper(t.reservedDataTypes) };
  cache.set(driver, w);
  return w;
}

export interface Hit {
  /** Character offsets of the word in the cell text. */
  start: number;
  end: number;
  word: string;
  upper: string;
}

interface Context {
  /** False inside strings, comments, quoted names, dollar quotes and {{variables}}. */
  code: boolean;
  /** First word of the current statement, in capitals. */
  head: string;
  /** The word before this one in the statement, in capitals ('' if none). */
  prev: string;
  /** This word starts an item of a column-name list (CREATE TABLE or INSERT column list). */
  nameItem: boolean;
}

/**
 * Scans the cell up to `at` (the start of the word) and reports where it is.
 * Knows the quoting and comment rules of each database.
 */
export function contextAt(text: string, at: number, driver: DriverId): Context {
  const mysqlLike = driver === 'mysql';
  const dollar = driver === 'postgres' || driver === 'duckdb';
  const nested = driver === 'postgres' || driver === 'duckdb' || driver === 'mssql';
  const backtick = driver === 'mysql' || driver === 'sqlite';
  const brackets = driver === 'mssql' || driver === 'sqlite';

  let head = '';
  let prev = '';
  let last = ''; // the last word seen, in capitals
  let lastToken = ''; // the last non-space token: a word in capitals, or a punctuation character
  // One entry per open parenthesis: whether it opens a column-name list.
  const parens: boolean[] = [];
  let sawTable = false;
  let sawInto = false;
  let i = 0;

  const outside = (): Context => ({ code: false, head, prev, nameItem: false });

  while (i < at) {
    const ch = text[i];
    const two = text.substr(i, 2);
    if (two === '--' || (mysqlLike && ch === '#')) {
      const nl = text.indexOf('\n', i);
      if (nl === -1 || nl >= at) return outside();
      i = nl + 1;
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (nested && text.startsWith('/*', j)) { depth++; j += 2; }
        else if (text.startsWith('*/', j)) { depth--; j += 2; }
        else j++;
      }
      if (depth > 0 || j > at) return outside();
      i = j;
      continue;
    }
    if (two === '{{') {
      const endV = text.indexOf('}}', i + 2);
      if (endV === -1 || endV + 2 > at) return outside();
      i = endV + 2;
      lastToken = 'x';
      continue;
    }
    if (ch === "'" || ch === '"' || (ch === '`' && backtick) || (ch === '[' && brackets)) {
      const close = ch === '[' ? ']' : ch;
      const backslash = ch === "'" && (mysqlLike || (/[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '')));
      let j = i + 1;
      for (;;) {
        if (j >= text.length) return outside();
        if (backslash && text[j] === '\\') { j += 2; continue; }
        if (text[j] === close) {
          if (close !== ']' && text[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      if (j + 1 > at) return outside();
      i = j + 1;
      lastToken = 'x';
      continue;
    }
    if (dollar && ch === '$' && !/\w/.test(text[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const endD = text.indexOf(m[0], i + m[0].length);
        if (endD === -1 || endD + m[0].length > at) return outside();
        i = endD + m[0].length;
        lastToken = 'x';
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(text[i - 1] ?? '')) {
      const m = /^[A-Za-z_][\w$]*/.exec(text.slice(i))!;
      const w = m[0].toUpperCase();
      if (!head) head = w;
      if (w === 'TABLE') sawTable = true;
      if (w === 'INTO') sawInto = true;
      last = w;
      lastToken = w;
      i += m[0].length;
      continue;
    }
    if (ch === ';') {
      head = prev = last = lastToken = '';
      parens.length = 0;
      sawTable = sawInto = false;
    } else if (ch === '(') {
      // CREATE TABLE t ( ... ) and INSERT INTO t ( ... ): the first parenthesis after the table name.
      const list = parens.length === 0 && /^[A-Z_]/.test(lastToken) && lastToken !== 'VALUES' && lastToken !== 'SELECT'
        && ((head === 'CREATE' && sawTable) || ((head === 'INSERT' || head === 'REPLACE') && sawInto));
      parens.push(list);
      lastToken = '(';
    } else if (ch === ')') {
      parens.pop();
      lastToken = ')';
    } else if (!/\s/.test(ch)) {
      lastToken = ch;
    }
    i++;
  }
  // A bracket or comma in between breaks the link: "FROM (SELECT" is not a name after FROM.
  prev = /^[A-Z_]/.test(lastToken) ? last : '';
  const inList = parens.length > 0 && parens[parens.length - 1];
  return { code: true, head, prev, nameItem: inList && (lastToken === '(' || lastToken === ',') };
}

/**
 * The word that ends at `offset` (where the user just typed `typed`), when it
 * is a keyword of the connected database that should be capitalised.
 * `names` holds lowercase table, column, schema and alias names to leave alone.
 */
export function wordToCapitalise(text: string, offset: number, driver: DriverId, typed: string, names: ReadonlySet<string> = new Set()): Hit | undefined {
  const m = /[A-Za-z_][\w$]*$/.exec(text.slice(Math.max(0, offset - 128), offset));
  if (!m) return undefined;
  const word = m[0];
  const start = offset - word.length;
  const before = text[start - 1] ?? '';
  if (/[\w$]/.test(before)) return undefined;
  const upper = word.toUpperCase();
  if (word === upper) return undefined;
  if (names.has(word.toLowerCase())) return undefined;

  const cast = before === ':' && text[start - 2] === ':';
  if ('.@#'.includes(before) && before !== '') return undefined;
  if (before === ':' && !cast) return undefined;

  const ctx = contextAt(text, start, driver);
  if (!ctx.code) return undefined;
  const w = dialectWords(driver);
  const hit = { start, end: offset, word, upper };
  const opensParen = typed.startsWith('(');

  if (cast) return w.dataTypes.has(upper) ? hit : undefined;
  if (ctx.nameItem) return ctx.head === 'CREATE' && TABLE_ITEM.has(upper) ? hit : undefined;
  if (NAME_AFTER.has(ctx.prev)) {
    // CAST(x AS int), CREATE TABLE IF NOT EXISTS, INSERT INTO ... SELECT: the few keywords that may follow.
    if (ctx.prev === 'AS' && w.dataTypes.has(upper) && (typed.startsWith(')') || opensParen)) return hit;
    if (ctx.prev === 'TABLE' && upper === 'IF') return hit;
    if (ctx.prev === 'EXISTS' && upper === 'SELECT') return hit;
    if (ctx.prev === 'AS' && (upper === 'SELECT' || upper === 'WITH')) return hit;
    return undefined;
  }
  if (w.keywords.has(upper)) return hit;
  if (opensParen && (w.functions.has(upper) || w.dataTypes.has(upper))) return hit;
  if (w.dataTypes.has(upper) && /^(CREATE|ALTER|DECLARE)$/.test(ctx.head)) return hit;
  return undefined;
}

/** Text the user typed that ends a word: a space, tab, comma, semicolon, bracket or Enter. */
export const ENDS_WORD = /^(?:[ \t,;)]|\(\)?|\r?\n[ \t]*)$/;

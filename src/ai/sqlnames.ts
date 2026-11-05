// Table names in SQL text, for the agent's tools: split "db.schema.table",
// quote a name for a dialect, and list the tables a SQL Server query uses.

import type { DriverId } from '../db/types';

export const quoter = (d: DriverId) => (n: string) =>
  d === 'mssql' ? `[${n.replace(/]/g, ']]')}]` : d === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`;

/** Splits "db.schema.table" (with [ ], ` ` or " " quoting) into its parts, unquoted. */
export function splitName(name: string): string[] {
  const parts: string[] = [];
  const re = /\s*(?:\[((?:[^\]]|\]\])*)\]|`((?:[^`]|``)*)`|"((?:[^"]|"")*)"|([^.\s[\]`"]+))\s*(\.|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) && m[0]) {
    parts.push(m[1] !== undefined ? m[1].replace(/]]/g, ']') : m[2] !== undefined ? m[2].replace(/``/g, '`') : m[3] !== undefined ? m[3].replace(/""/g, '"') : m[4]);
    if (!m[5]) break;
  }
  return parts.length ? parts : [name];
}

const NAME = String.raw`(?:\[(?:[^\]]|\]\])+\]|"[^"]+"|` + '`[^`]+`' + String.raw`|[\w@#$]+)`;
const FULL = `${NAME}(?:\\s*\\.\\s*${NAME}){0,2}`;
const last = (n: string) => splitName(n).pop()!.toLowerCase();
const strip = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ');

/** The tables and views the SQL creates, lowercased, without database or schema. */
export function createdTables(sql: string): string[] {
  const re = new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(${FULL})`, 'gi');
  return [...strip(sql).matchAll(re)].map((m) => last(m[1]));
}

/**
 * SQL Server: the tables a query reads or writes, as written, for OBJECT_ID.
 * Leaves out temp tables, table variables, CTEs, aliases (UPDATE p ... FROM
 * persons p), tables the SQL creates (or `created` lists), functions, and
 * sys / INFORMATION_SCHEMA views.
 */
export function tableRefs(sql: string, created: Iterable<string> = []): string[] {
  const code = strip(sql);
  const skip = new Set<string>([...createdTables(sql), ...created]);
  for (const m of code.matchAll(new RegExp(String.raw`\balter\s+(?:table|view)\s+(${FULL})`, 'gi'))) skip.add(last(m[1]));
  for (const m of code.matchAll(new RegExp(String.raw`(?:\bwith|,)\s*(${NAME})\s*(?:\([^)]*\)\s*)?as\s*\(`, 'gi'))) skip.add(last(m[1]));
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:from|join)\s+${FULL}\s+(?:as\s+)?(${NAME})`, 'gi'))) skip.add(last(m[1]));
  const out = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:from|join|into|update|merge)\s+(${FULL})(\s*\()?`, 'gi'))) {
    if (m[2]) continue; // a function, or INSERT INTO t (cols): handled below
    add(m[1]);
  }
  for (const m of code.matchAll(new RegExp(String.raw`\binsert\s+(?:into\s+)?(${FULL})\s*\(`, 'gi'))) add(m[1]);
  return [...out];

  function add(name: string) {
    const parts = splitName(name);
    const t = parts[parts.length - 1].toLowerCase();
    const schema = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
    if (/^[#@]/.test(t) || skip.has(t) || schema === 'sys' || schema === 'information_schema') return;
    if (/^(select|values|set|where|openjson|openrowset|openquery|string_split|exec|execute)$/i.test(t)) return;
    out.add(name.replace(/\s+/g, ''));
  }
}

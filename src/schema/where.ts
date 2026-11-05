// Where a notebook's unqualified table names resolve: the database it switched
// to with USE (SQL Server, MySQL) and the schema. Autocomplete and the AI look
// up tables there, not in the database saved in the connection.

import type { DriverId } from '../db/types';
import { splitStatements } from '../db/splitter';

export interface Where {
  /** SQL Server only: the database, when it may differ from the sidebar's. */
  database?: string;
  /** MySQL database, or PostgreSQL / SQL Server / DuckDB schema. */
  container?: string;
}

const LEAD = String.raw`^(?:\s|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|/\*[\s\S]*?\*/)*`;
const USE = new RegExp(LEAD + String.raw`use\s+(\[(?:[^\]]|\]\])+\]|` + '`(?:[^`]|``)+`' + String.raw`|"(?:[^"]|"")+"|[\w$@#.-]+)\s*;?\s*$`, 'i');

/** The database named by the last USE statement among `statements`, if any. */
export function lastUse(statements: string[]): string | undefined {
  for (let i = statements.length - 1; i >= 0; i--) {
    const m = USE.exec(statements[i]);
    if (m) return unquoteName(m[1]);
  }
  return undefined;
}

/**
 * Where the last USE in `sql` puts the notebook, if it has one. SQL Server
 * scripts are split on ";" here too (the runner splits them only on GO), using
 * the PostgreSQL rules for quotes and comments, which suit T-SQL text.
 */
export function useIn(sql: string, driver: DriverId): Where | undefined {
  const name = lastUse(splitStatements(sql, driver === 'mssql' ? 'postgres' : driver).map((s) => s.sql));
  return name ? whereFromUse(driver, name) : undefined;
}

/** Where a USE of `name` puts the notebook, for drivers where USE picks a database. */
export function whereFromUse(driver: DriverId, name: string): Where | undefined {
  // dbo, not the sidebar's default schema: that one belongs to the sidebar's
  // database (in master an ordinary login gets "guest"). Once the cell runs,
  // the notebook's session reports the real schema.
  if (driver === 'mssql') return { database: name, container: 'dbo' };
  if (driver === 'mysql') return { container: name };
  return undefined;
}

function unquoteName(s: string): string {
  if (s.startsWith('[')) return s.slice(1, -1).replace(/\]\]/g, ']');
  if (s.startsWith('`')) return s.slice(1, -1).replace(/``/g, '`');
  if (s.startsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  return s;
}

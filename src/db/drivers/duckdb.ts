import type { ColumnInfo, ResolvedConnection, RunOptions, Session, TableInfo } from '../types';
import { CancelledError, QueryFailure } from '../types';
import { inferKinds, kindFromType, toCell } from '../values';
import type { Cell, Column } from '../../../shared/protocol';

// Loaded at runtime: a native module shipped next to the extension.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const duck = require('@duckdb/node-api') as typeof import('@duckdb/node-api');

class DuckSession implements Session {
  readonly driver = 'duckdb' as const;
  private cancelled = false;

  constructor(
    private instance: import('@duckdb/node-api').DuckDBInstance,
    private conn: import('@duckdb/node-api').DuckDBConnection,
  ) {}

  async run(statements: string[], opts: RunOptions): Promise<void> {
    this.cancelled = false;
    for (let i = 0; i < statements.length; i++) {
      opts.onStart(i);
      const sql = statements[i];
      const t0 = performance.now();
      let reader: import('@duckdb/node-api').DuckDBResultReader | undefined;
      try {
        reader = await this.conn.streamAndReadUntil(sql, opts.maxRows + 1);
        const names = reader.columnNames();
        const types = reader.columnTypes().map((t) => t.toString());
        const changed = Number(reader.rowsChanged);
        const isQuery = reader.returnType === duck.ResultReturnType.QUERY_RESULT;
        if (!isQuery) {
          opts.onResult({ sql, columns: [], rows: [], hasRows: false, truncated: false, affected: changed, durationMs: performance.now() - t0 }, i);
          continue;
        }
        const raw = reader.getRowsJS() as unknown[][];
        // Dates and times as DuckDB prints them, never shifted into the local time zone.
        const timeCols = types.map((t, k) => (/^(DATE|TIME|TIMESTAMP|INTERVAL)/i.test(t) ? k : -1)).filter((k) => k >= 0);
        const plain = timeCols.length ? reader.getRows() : undefined;
        const truncated = raw.length > opts.maxRows;
        const rows: Cell[][] = raw.slice(0, opts.maxRows).map((r, ri) => {
          const out = r.map(toCell);
          for (const k of timeCols) {
            const v = plain![ri][k];
            out[k] = v === null || v === undefined ? null : String(v);
          }
          return out;
        });
        let columns: Column[] = names.map((n, k) => ({ name: n, type: types[k], kind: kindFromType(types[k]) }));
        columns = inferKinds(columns, rows);
        opts.onResult({ sql, columns, rows, hasRows: true, truncated, durationMs: performance.now() - t0 }, i);
      } catch (e) {
        if (this.cancelled) throw new CancelledError();
        throw new QueryFailure(e instanceof Error ? e.message : String(e), i);
      } finally {
        closeReader(reader);
      }
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.conn.interrupt();
  }

  async close(): Promise<void> {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const r = await this.conn.runAndReadAll(sql);
    try {
      return r.getRowObjectsJS() as Record<string, unknown>[];
    } finally {
      closeReader(r);
    }
  }

  async serverVersion(): Promise<string> {
    const r = await this.rows('select version() v');
    return `DuckDB ${r[0].v}`;
  }

  async listContainers() {
    const r = await this.rows(
      "select distinct schema_name s from information_schema.schemata where catalog_name = current_database() and schema_name not in ('information_schema','pg_catalog') order by 1",
    );
    const names = r.map((x) => String(x.s));
    return names.length <= 1 ? undefined : names;
  }

  async defaultContainer() {
    const r = await this.rows('select current_schema() s');
    return String(r[0].s);
  }

  async location() {
    return { container: await this.defaultContainer() };
  }

  async listTables(container?: string): Promise<TableInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const r = await this.rows(
      `select table_name n, table_type t from information_schema.tables where table_catalog = current_database() and table_schema = ${lit(schema!)} order by 1`,
    );
    return r.map((x) => ({ name: String(x.n), type: String(x.t).includes('VIEW') ? 'view' : 'table' }));
  }

  async listColumns(table: string, container?: string): Promise<ColumnInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const r = await this.rows(
      `select column_name n, data_type t, is_nullable nl from information_schema.columns where table_catalog = current_database() and table_schema = ${lit(schema!)} and table_name = ${lit(table)} order by ordinal_position`,
    );
    const pk = await this.rows(
      `select unnest(constraint_column_names) c from duckdb_constraints() where constraint_type = 'PRIMARY KEY' and database_name = current_database() and schema_name = ${lit(schema!)} and table_name = ${lit(table)}`,
    ).catch(() => []);
    const keys = new Set(pk.map((x) => String(x.c)));
    return r.map((x) => ({ name: String(x.n), type: String(x.t), pk: keys.has(String(x.n)), nullable: x.nl === 'YES' }));
  }

  async explain(sql: string): Promise<string | undefined> {
    const r = await this.conn.runAndReadAll(`explain ${sql}`);
    const rows = r.getRowsJS() as unknown[][];
    closeReader(r);
    return rows.map((row) => String(row[row.length - 1])).join('\n');
  }
}

function closeReader(r: { closeSync(): void } | undefined) {
  try {
    r?.closeSync();
  } catch {
    /* already closed */
  }
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function open(conn: ResolvedConnection): Promise<Session> {
  const file = conn.file?.trim() || ':memory:';
  const options: Record<string, string> = {};
  if (conn.readOnly && file !== ':memory:') options.access_mode = 'READ_ONLY';
  const instance = await duck.DuckDBInstance.create(file, options);
  const c = await instance.connect();
  return new DuckSession(instance, c);
}

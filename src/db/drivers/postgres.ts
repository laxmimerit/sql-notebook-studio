import pg from 'pg';
import type { ColumnInfo, ResolvedConnection, RunOptions, Session, TableInfo } from '../types';
import { CancelledError, QueryFailure } from '../types';
import { inferKinds, kindFromType, toCell } from '../values';
import type { Cell, Column, StatementResult } from '../../../shared/protocol';
import { errorCode, errorMessage, sslOptions } from './common';

const OID: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 790: 'money', 869: 'inet', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz', 1560: 'bit',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1000: 'bool[]', 1005: 'int2[]', 1007: 'int4[]', 1009: 'text[]',
  1015: 'varchar[]', 1016: 'int8[]', 1021: 'float4[]', 1022: 'float8[]', 1231: 'numeric[]', 2951: 'uuid[]', 3807: 'jsonb[]',
};

// Keep dates and times exactly as the server sends them (no time zone shifts).
const RAW_TEXT = new Set([1082, 1083, 1114, 1184, 1266, 1186]);
const types = {
  getTypeParser(oid: number, format?: any) {
    if (RAW_TEXT.has(oid)) return (v: string) => v;
    if (oid === 20) return (v: string) => (Number.isSafeInteger(Number(v)) ? Number(v) : v);
    return pg.types.getTypeParser(oid, format);
  },
};

class PgSession implements Session {
  readonly driver = 'postgres' as const;
  private cancelled = false;
  private notices: string[] = [];

  constructor(private c: pg.Client, private config: pg.ClientConfig) {
    c.on('notice', (n) => this.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`));
  }

  private async q<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
    const r = await this.c.query({ text, values, types } as any);
    return r.rows as T[];
  }

  async run(statements: string[], opts: RunOptions): Promise<void> {
    this.cancelled = false;
    for (let i = 0; i < statements.length; i++) {
      opts.onStart(i);
      this.notices = [];
      try {
        opts.onResult(await this.runOne(statements[i], opts.maxRows), i);
      } catch (e) {
        if (this.cancelled) throw new CancelledError();
        const pos = (e as any)?.position ? ` (at character ${(e as any).position})` : '';
        throw new QueryFailure(errorMessage(e) + pos, i, errorCode(e));
      }
    }
  }

  private runOne(sql: string, maxRows: number): Promise<StatementResult> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const rows: Cell[][] = [];
      let truncated = false;
      let columns: Column[] = [];
      const query = new pg.Query({ text: sql, rowMode: 'array', types } as any);
      query.on('row', (row: unknown[]) => {
        if (rows.length >= maxRows) truncated = true;
        else rows.push(row.map(toCell));
      });
      query.on('error', reject);
      query.on('end', (res: pg.QueryResult) => {
        const hasRows = (res.fields?.length ?? 0) > 0;
        columns = (res.fields ?? []).map((f) => {
          const type = OID[f.dataTypeID] ?? '';
          return { name: f.name, type, kind: kindFromType(type) };
        });
        resolve({
          sql,
          columns: hasRows ? inferKinds(columns, rows) : [],
          rows,
          hasRows,
          truncated,
          affected: hasRows ? undefined : res.rowCount ?? undefined,
          durationMs: performance.now() - t0,
          messages: this.notices.length ? [...this.notices] : undefined,
        });
      });
      this.c.query(query as any);
    });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const pid = (this.c as any).processID;
    const killer = new pg.Client(this.config);
    try {
      await killer.connect();
      await killer.query('select pg_cancel_backend($1)', [pid]);
    } finally {
      await killer.end().catch(() => undefined);
    }
  }

  async close() {
    await this.c.end();
  }

  async serverVersion() {
    const r = await this.q<{ v: string }>('show server_version');
    return `PostgreSQL ${(r[0] as any).server_version ?? r[0].v}`;
  }

  async listContainers() {
    const r = await this.q<{ s: string }>(
      "select schema_name as s from information_schema.schemata where schema_name not in ('pg_catalog','information_schema') and schema_name not like 'pg\\_toast%' and schema_name not like 'pg\\_temp%' order by 1",
    );
    return r.map((x) => x.s);
  }

  async defaultContainer() {
    const r = await this.q<{ s: string }>('select current_schema() as s');
    return r[0].s;
  }

  async listTables(container?: string): Promise<TableInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const r = await this.q<{ n: string; t: string }>(
      'select table_name as n, table_type as t from information_schema.tables where table_schema = $1 order by 1',
      [schema],
    );
    return r.map((x) => ({ name: x.n, type: /view/i.test(x.t) ? 'view' : 'table' }));
  }

  async listColumns(table: string, container?: string): Promise<ColumnInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const r = await this.q<{ n: string; t: string; nl: string; pk: boolean }>(
      `select c.column_name as n, c.data_type as t, c.is_nullable as nl,
        exists (select 1 from information_schema.table_constraints tc
          join information_schema.key_column_usage k on tc.constraint_name = k.constraint_name and tc.table_schema = k.table_schema
          where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema and tc.table_name = c.table_name and k.column_name = c.column_name) as pk
       from information_schema.columns c where c.table_schema = $1 and c.table_name = $2 order by c.ordinal_position`,
      [schema, table],
    );
    return r.map((x) => ({ name: x.n, type: x.t, pk: x.pk, nullable: x.nl === 'YES' }));
  }

  async explain(sql: string) {
    const r = await this.q<Record<string, string>>(`explain ${sql}`);
    return r.map((x) => x['QUERY PLAN']).join('\n');
  }
}

export async function open(conn: ResolvedConnection): Promise<Session> {
  const config: pg.ClientConfig = {
    host: conn.host || 'localhost',
    port: conn.port || 5432,
    user: conn.user,
    password: conn.secrets.password,
    database: conn.database || undefined,
    ssl: (sslOptions(conn) as any) ?? false,
    connectionTimeoutMillis: 15000,
    application_name: 'SQL Notebook Studio',
  };
  const c = new pg.Client(config);
  c.on('error', () => {
    /* connection lost: the next run reconnects */
  });
  await c.connect();
  if (conn.readOnly) await c.query('set default_transaction_read_only = on');
  return new PgSession(c, config);
}

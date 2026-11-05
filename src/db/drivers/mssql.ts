import sql from 'mssql';
import type { ColumnInfo, ResolvedConnection, RunOptions, Session, TableInfo } from '../types';
import { CancelledError, QueryFailure } from '../types';
import { inferKinds, kindFromType, toCell } from '../values';
import type { Cell, Column, StatementResult } from '../../../shared/protocol';
import { errorCode, errorMessage } from './common';

class MssqlSession implements Session {
  readonly driver = 'mssql' as const;
  private current?: sql.Request;
  private cancelled = false;

  constructor(private pool: sql.ConnectionPool) {}

  private async q<T = any>(text: string, params: Record<string, string> = {}): Promise<T[]> {
    const r = this.pool.request();
    for (const [k, v] of Object.entries(params)) r.input(k, sql.NVarChar, v);
    const res = await r.query(text);
    return res.recordset as unknown as T[];
  }

  async run(batches: string[], opts: RunOptions): Promise<void> {
    this.cancelled = false;
    for (let i = 0; i < batches.length; i++) {
      opts.onStart(i);
      try {
        for (const r of await this.runBatch(batches[i], opts.maxRows)) opts.onResult(r, i);
      } catch (e) {
        if (this.cancelled) throw new CancelledError();
        const line = (e as any)?.lineNumber ? ` (line ${(e as any).lineNumber})` : '';
        throw new QueryFailure(errorMessage(e) + line, i, errorCode(e));
      }
    }
  }

  private runBatch(text: string, maxRows: number): Promise<StatementResult[]> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const sets: { columns: Column[]; rows: Cell[][]; truncated: boolean }[] = [];
      const messages: string[] = [];
      let affected = 0;
      let sawAffected = false;
      const req = this.pool.request();
      this.current = req;
      (req as any).arrayRowMode = true;
      req.stream = true;
      req.on('recordset', (cols: any) => {
        const list: any[] = Array.isArray(cols) ? cols : Object.values(cols);
        sets.push({
          columns: list.map((c) => {
            const type = String(c.type?.declaration ?? c.type?.name ?? '');
            return { name: c.name ?? '', type, kind: kindFromType(type) };
          }),
          rows: [],
          truncated: false,
        });
      });
      req.on('row', (row: unknown[]) => {
        const set = sets[sets.length - 1];
        if (!set) return;
        if (set.rows.length >= maxRows) set.truncated = true;
        else set.rows.push((Array.isArray(row) ? row : Object.values(row as object)).map(toCell));
      });
      req.on('rowsaffected', (n: number) => {
        sawAffected = true;
        affected += n;
      });
      req.on('info', (m: any) => messages.push(m.message));
      req.on('error', reject);
      req.on('done', () => {
        this.current = undefined;
        const durationMs = performance.now() - t0;
        const msgs = messages.length ? messages : undefined;
        if (!sets.length) {
          resolve([{ sql: text, columns: [], rows: [], hasRows: false, truncated: false, affected: sawAffected ? affected : undefined, durationMs, messages: msgs }]);
          return;
        }
        resolve(
          sets.map((s, k) => ({
            sql: text,
            columns: inferKinds(s.columns, s.rows),
            rows: s.rows,
            hasRows: true,
            truncated: s.truncated,
            durationMs,
            messages: k === sets.length - 1 ? msgs : undefined,
          })),
        );
      });
      req.query(text);
    });
  }

  async cancel() {
    this.cancelled = true;
    this.current?.cancel();
  }

  async close() {
    await this.pool.close();
  }

  async serverVersion() {
    const r = await this.q<{ v: string; e: string }>("select cast(serverproperty('ProductVersion') as nvarchar(64)) as v, cast(serverproperty('Edition') as nvarchar(128)) as e");
    return `SQL Server ${r[0].v} (${r[0].e})`;
  }

  async listContainers(database?: string) {
    const p = dbPrefix(database);
    const r = await this.q<{ n: string }>(
      `select s.name as n from ${p}sys.schemas s where s.name = 'dbo' or exists (select 1 from ${p}sys.objects o where o.schema_id = s.schema_id and o.type in ('U','V')) order by 1`,
    );
    return r.map((x) => x.n);
  }

  async defaultContainer() {
    const r = await this.q<{ s: string }>('select schema_name() as s');
    return r[0].s;
  }

  async listDatabases() {
    const r = await this.q<{ n: string }>('select name as n from sys.databases where database_id > 4 and state = 0 and has_dbaccess(name) = 1 order by name');
    return r.map((x) => x.n);
  }

  async location() {
    const r = await this.q<{ d: string; s: string }>('select db_name() as d, schema_name() as s');
    return { database: r[0].d, container: r[0].s };
  }

  async listTables(container?: string, database?: string): Promise<TableInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const r = await this.q<{ n: string; t: string }>(
      `select table_name as n, table_type as t from ${dbPrefix(database)}information_schema.tables where table_schema = @s order by table_name`,
      { s: schema },
    );
    return r.map((x) => ({ name: x.n, type: /view/i.test(x.t) ? 'view' : 'table' }));
  }

  async listColumns(table: string, container?: string, database?: string): Promise<ColumnInfo[]> {
    const schema = container ?? (await this.defaultContainer());
    const p = dbPrefix(database);
    const r = await this.q<{ n: string; t: string; nl: string; pk: number }>(
      `select c.column_name as n, c.data_type as t, c.is_nullable as nl,
         case when exists (select 1 from ${p}information_schema.table_constraints tc
           join ${p}information_schema.key_column_usage k on tc.constraint_name = k.constraint_name and tc.table_schema = k.table_schema
           where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema and tc.table_name = c.table_name and k.column_name = c.column_name)
         then 1 else 0 end as pk
       from ${p}information_schema.columns c where c.table_schema = @s and c.table_name = @t order by c.ordinal_position`,
      { s: schema, t: table },
    );
    return r.map((x) => ({ name: x.n, type: x.t, pk: !!x.pk, nullable: x.nl === 'YES' }));
  }

  async explain() {
    return undefined;
  }
}

export async function open(conn: ResolvedConnection): Promise<Session> {
  const m = conn.mssql ?? { auth: 'sql' };
  const config: sql.config = {
    server: conn.host || 'localhost',
    port: m.instanceName ? undefined : conn.port || 1433,
    database: conn.database || undefined,
    connectionTimeout: 15000,
    requestTimeout: 0,
    pool: { max: 1, min: 0, idleTimeoutMillis: 600000 },
    options: {
      encrypt: m.encrypt ?? true,
      trustServerCertificate: m.trustServerCertificate ?? false,
      instanceName: m.instanceName || undefined,
      enableArithAbort: true,
      useUTC: false,
      appName: 'SQL Notebook Studio',
    } as any,
  };
  if (m.auth === 'ntlm') {
    config.authentication = { type: 'ntlm', options: { userName: conn.user ?? '', password: conn.secrets.password ?? '', domain: m.domain ?? '' } } as any;
  } else if (m.auth === 'azure-default') {
    config.authentication = { type: 'azure-active-directory-default', options: {} } as any;
  } else {
    config.user = conn.user;
    config.password = conn.secrets.password;
  }
  const pool = new sql.ConnectionPool(config);
  pool.on('error', () => undefined);
  await pool.connect();
  return new MssqlSession(pool);
}

/** "[db]." for a three-part name in another database, or "" for the current one. */
function dbPrefix(database?: string): string {
  return database ? `[${database.replace(/]/g, ']]')}].` : '';
}

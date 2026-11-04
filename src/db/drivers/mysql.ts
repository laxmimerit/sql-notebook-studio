import * as mysql from 'mysql2';
import type { ColumnInfo, ResolvedConnection, RunOptions, Session, TableInfo } from '../types';
import { CancelledError, QueryFailure } from '../types';
import { inferKinds, kindFromType, toCell } from '../values';
import type { Cell, Column, StatementResult } from '../../../shared/protocol';
import { errorCode, errorMessage, sslOptions } from './common';

const TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries((mysql as any).Types ?? {}).map(([name, num]) => [num as number, name]),
);
const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

class MysqlSession implements Session {
  readonly driver = 'mysql' as const;
  private cancelled = false;

  constructor(private c: mysql.Connection, private config: mysql.ConnectionOptions) {}

  private q<T = any>(sql: string, values: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.c.query({ sql, values }, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
    });
  }

  run(statements: string[], opts: RunOptions): Promise<void> {
    this.cancelled = false;
    return (async () => {
      for (let i = 0; i < statements.length; i++) {
        opts.onStart(i);
        try {
          const results = await this.runOne(statements[i], opts.maxRows);
          // KILL QUERY can end SLEEP() and similar calls without an error.
          if (this.cancelled) throw new CancelledError();
          for (const r of results) opts.onResult(r, i);
        } catch (e) {
          if (this.cancelled) throw new CancelledError();
          throw new QueryFailure(errorMessage(e), i, errorCode(e));
        }
      }
    })();
  }

  private runOne(sql: string, maxRows: number): Promise<StatementResult[]> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const sets: { columns: Column[]; rows: Cell[][]; truncated: boolean; affected?: number; hasRows: boolean }[] = [];
      const q = this.c.query({ sql, rowsAsArray: true });
      q.on('fields', (fields: mysql.FieldPacket[] | undefined, index = sets.length) => {
        // DDL and other commands send an empty fields event.
        if (!fields) return;
        sets[index] = {
          columns: fields.map((f) => {
            let type = TYPE_NAMES[f.columnType ?? -1] ?? '';
            // TEXT columns arrive as BLOB types; only charset 63 is really binary.
            if (/BLOB|STRING/.test(type) && f.characterSet !== 63) type = 'VARCHAR';
            return { name: f.name, type: type.toLowerCase(), kind: kindFromType(type) };
          }),
          rows: [],
          truncated: false,
          hasRows: true,
        };
      });
      q.on('result', (row: any, index?: number) => {
        if (Array.isArray(row)) {
          const set = sets[index ?? sets.length - 1];
          if (!set) return;
          if (set.rows.length >= maxRows) set.truncated = true;
          else set.rows.push(row.map(toCell));
        } else if (row && typeof row === 'object' && 'affectedRows' in row) {
          // CALL ends with an OK packet; only report it if nothing else came back.
          sets.push({ columns: [], rows: [], truncated: false, affected: row.affectedRows, hasRows: false });
        }
      });
      q.on('error', reject);
      q.on('end', () => {
        const durationMs = performance.now() - t0;
        const withRows = sets.filter((s) => s?.hasRows);
        const list = withRows.length ? withRows : sets.filter(Boolean).slice(-1);
        if (!list.length) list.push({ columns: [], rows: [], truncated: false, hasRows: false, affected: 0 });
        resolve(
          list.map((s) => ({
            sql,
            columns: s.hasRows ? inferKinds(s.columns, s.rows) : [],
            rows: s.rows,
            hasRows: s.hasRows,
            truncated: s.truncated,
            affected: s.affected,
            durationMs,
          })),
        );
      });
    });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const killer = mysql.createConnection(this.config);
    await new Promise<void>((resolve) => {
      killer.query(`KILL QUERY ${this.c.threadId}`, () => {
        killer.end();
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.c.end(() => resolve()));
  }

  async serverVersion() {
    const r = await this.q<{ v: string }>('select version() as v');
    return /mariadb/i.test(r[0].v) ? `MariaDB ${r[0].v}` : `MySQL ${r[0].v}`;
  }

  async listContainers() {
    const r = await this.q<{ Database: string }>('show databases');
    return r.map((x) => x.Database).filter((d) => !SYSTEM_DBS.has(d.toLowerCase()));
  }

  async defaultContainer() {
    const r = await this.q<{ d: string | null }>('select database() as d');
    return r[0].d ?? undefined;
  }

  async listTables(container?: string): Promise<TableInfo[]> {
    const db = container ?? (await this.defaultContainer());
    if (!db) return [];
    const r = await this.q<{ n: string; t: string }>(
      'select table_name as n, table_type as t from information_schema.tables where table_schema = ? order by table_name',
      [db],
    );
    return r.map((x) => ({ name: x.n, type: /view/i.test(x.t) ? 'view' : 'table' }));
  }

  async listColumns(table: string, container?: string): Promise<ColumnInfo[]> {
    const db = container ?? (await this.defaultContainer());
    const r = await this.q<{ n: string; t: string; k: string; nl: string }>(
      'select column_name as n, column_type as t, column_key as k, is_nullable as nl from information_schema.columns where table_schema = ? and table_name = ? order by ordinal_position',
      [db, table],
    );
    return r.map((x) => ({ name: x.n, type: x.t, pk: x.k === 'PRI', nullable: x.nl === 'YES' }));
  }

  async explain(sql: string) {
    try {
      const r = await this.q<Record<string, string>>(`explain format=tree ${sql}`);
      return Object.values(r[0] ?? {}).join('\n');
    } catch {
      const r = await this.q<Record<string, unknown>>(`explain ${sql}`);
      return r.map((row) => JSON.stringify(row)).join('\n');
    }
  }
}

export async function open(conn: ResolvedConnection): Promise<Session> {
  const config: mysql.ConnectionOptions = {
    host: conn.host || 'localhost',
    port: conn.port || 3306,
    user: conn.user,
    password: conn.secrets.password,
    database: conn.database || undefined,
    ssl: sslOptions(conn) as any,
    dateStrings: true,
    supportBigNumbers: true,
    multipleStatements: false,
    connectTimeout: 15000,
    charset: 'utf8mb4',
  };
  const c = mysql.createConnection(config);
  await new Promise<void>((resolve, reject) => c.connect((err) => (err ? reject(new Error(errorMessage(err))) : resolve())));
  c.on('error', () => {
    /* connection lost: the next run reconnects */
  });
  const s = new MysqlSession(c, config);
  if (conn.readOnly) await new Promise<void>((res, rej) => c.query('set session transaction read only', (e) => (e ? rej(e) : res())));
  return s;
}

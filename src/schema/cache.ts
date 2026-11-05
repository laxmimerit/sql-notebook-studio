// Caches schema lookups (containers, tables, columns) for the explorer,
// autocomplete and the AI. Entries expire after a few minutes.

import type { ColumnInfo, ConnectionConfig, Session, TableInfo } from '../db/types';
import { isConnectionLost, isMemory, ownerFor, type SessionManager } from '../db/manager';
import type { Where } from './where';

const TTL = 5 * 60_000;

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

export class SchemaCache {
  private map = new Map<string, Entry<unknown>>();

  constructor(private readonly manager: SessionManager) {}

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const e = this.map.get(key) as Entry<T> | undefined;
    if (e && Date.now() - e.at < TTL) return e.value;
    const value = load();
    this.map.set(key, { at: Date.now(), value });
    value.catch(() => this.map.delete(key));
    return value;
  }

  invalidate(connId: string) {
    for (const k of [...this.map.keys()]) if (k.startsWith(connId + '|')) this.map.delete(k);
  }

  /**
   * Runs a lookup on the explorer's own session. If that session has died (the
   * server restarted, the PC slept, the network dropped), it is closed and
   * opened again once, the same way notebook cells recover.
   */
  private async withSession<T>(conn: ConnectionConfig, fn: (s: Session) => Promise<T>): Promise<T> {
    const owner = ownerFor(conn);
    try {
      return await fn(await this.manager.get(owner, conn));
    } catch (e) {
      // In-memory databases live in their session; never drop those.
      if (isMemory(conn) || !isConnectionLost(e)) throw e;
      await this.manager.drop(owner, conn.id);
      return fn(await this.manager.get(owner, conn));
    }
  }

  // `database` (SQL Server only) looks in the database a notebook switched to
  // with USE, through three-part names on the sidebar's own connection.

  containers(conn: ConnectionConfig, database?: string): Promise<string[] | undefined> {
    return this.cached(`${conn.id}|containers|${database ?? ''}`, () => this.withSession(conn, (s) => s.listContainers(database)));
  }

  defaultContainer(conn: ConnectionConfig): Promise<string | undefined> {
    return this.cached(`${conn.id}|default`, () => this.withSession(conn, (s) => s.defaultContainer()));
  }

  tables(conn: ConnectionConfig, container?: string, database?: string): Promise<TableInfo[]> {
    return this.cached(`${conn.id}|tables|${database ?? ''}|${container ?? ''}`, () => this.withSession(conn, (s) => s.listTables(container, database)));
  }

  columns(conn: ConnectionConfig, table: string, container?: string, database?: string): Promise<ColumnInfo[]> {
    return this.cached(`${conn.id}|cols|${database ?? ''}|${container ?? ''}|${table}`, () => this.withSession(conn, (s) => s.listColumns(table, container, database)));
  }

  /** Where the sidebar's own session is (its database on SQL Server). */
  location(conn: ConnectionConfig): Promise<{ database?: string; container?: string }> {
    return this.cached(`${conn.id}|location`, () => this.withSession(conn, (s) => s.location()));
  }

  /** SQL Server: the user databases this login can open. Empty for other drivers. */
  databases(conn: ConnectionConfig): Promise<string[]> {
    return this.cached(`${conn.id}|databases`, () => this.withSession(conn, async (s) => (await s.listDatabases?.()) ?? []));
  }

  /**
   * Compact schema text for AI prompts: the tables where the notebook is, plus
   * any database the request names ("the persons table of MyDatabase"). When a
   * SQL Server notebook is still in master, or a MySQL one has no database, the
   * user databases are described instead. Tables named in `focus` come first.
   */
  async describeForAi(conn: ConnectionConfig, focus: string, where: Where = {}, budget = 12000): Promise<string> {
    const lower = focus.toLowerCase();
    const notes: string[] = [];
    const scopes: Scope[] = [];

    if (conn.driver === 'mssql') {
      const here = where.database ?? (await this.location(conn).catch(() => undefined))?.database;
      const all = await this.databases(conn).catch(() => [] as string[]);
      const asked = all.filter((d) => mentions(lower, d) && !same(d, here));
      const inSystem = !here || SYSTEM_DBS.has(here.toLowerCase());
      const dbs: (string | undefined)[] = inSystem ? [] : [where.database];
      dbs.push(...asked);
      if (inSystem && !asked.length) dbs.push(...all.slice(0, 5));
      if (!dbs.length) dbs.push(undefined);
      if (here) notes.push(`The notebook is in database ${here}.`);
      if (dbs.some((d) => d && !same(d, here))) notes.push(`Tables in another database need a three-part name (Database.schema.table), or USE Database first.`);
      for (const db of dbs) {
        const schemas = (await this.containers(conn, db).catch(() => undefined)) ?? ['dbo'];
        const other = db && !same(db, here);
        for (const s of schemas.slice(0, 10)) {
          const prefix = other ? `${db}.${s}.` : s.toLowerCase() !== 'dbo' ? `${s}.` : '';
          scopes.push({ database: db, container: s, prefix, named: !!db && mentions(lower, db) });
        }
      }
    } else if (conn.driver === 'mysql') {
      const here = where.container ?? (await this.defaultContainer(conn).catch(() => undefined));
      const all = (await this.containers(conn).catch(() => undefined)) ?? [];
      const asked = all.filter((d) => mentions(lower, d) && !same(d, here));
      const dbs = [...(here ? [here] : []), ...asked];
      if (!dbs.length) dbs.push(...all.slice(0, 5));
      notes.push(here ? `Current database: ${here}.` : 'No database is selected: write database.table, or USE database first.');
      for (const d of dbs) scopes.push({ container: d, prefix: same(d, here) ? '' : `${d}.`, named: mentions(lower, d) });
    } else {
      const here = where.container ?? (await this.defaultContainer(conn).catch(() => undefined));
      if (here) notes.push(`Current schema: ${here}.`);
      scopes.push({ container: here, prefix: '', named: false });
    }

    // Every table in scope, the ones the request names first.
    const found: { scope: Scope; table: TableInfo; score: number }[] = [];
    for (const scope of scopes) {
      const tables = await this.tables(conn, scope.container, scope.database).catch(() => [] as TableInfo[]);
      for (const table of tables.slice(0, 300)) found.push({ scope, table, score: (mentions(lower, table.name) ? 2 : 0) + (scope.named ? 1 : 0) });
    }
    found.sort((a, b) => b.score - a.score);

    const parts: string[] = [];
    let used = 0;
    for (const { scope, table } of found.slice(0, 150)) {
      if (used > budget) break;
      const cols = await this.columns(conn, table.name, scope.container, scope.database).catch(() => [] as ColumnInfo[]);
      const line = `${table.type === 'view' ? 'view ' : ''}${scope.prefix}${table.name}(${cols.map((x) => `${x.name} ${x.type}${x.pk ? ' pk' : ''}`).join(', ')})`;
      parts.push(line);
      used += line.length;
    }
    return [...notes, parts.length ? parts.join('\n') : '(no tables found)'].join('\n');
  }
}

interface Scope {
  database?: string;
  container?: string;
  /** Written before each table name in the prompt. */
  prefix: string;
  /** The request names this database. */
  named: boolean;
}

const SYSTEM_DBS = new Set(['master', 'tempdb', 'model', 'msdb']);

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Whether `text` (lowercased) names `name` as a word, or its singular ("person" for persons). */
export function mentions(text: string, name: string): boolean {
  const n = name.toLowerCase();
  const forms = n.length > 3 && n.endsWith('s') ? [n, n.slice(0, -1)] : [n];
  return forms.some((f) => new RegExp(`(^|[^\\w$])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`).test(text));
}

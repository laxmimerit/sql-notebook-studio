// Caches schema lookups (containers, tables, columns) for the explorer,
// autocomplete and the AI. Entries expire after a few minutes.

import type { ColumnInfo, ConnectionConfig, TableInfo } from '../db/types';
import { ownerFor, type SessionManager } from '../db/manager';

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

  private session(conn: ConnectionConfig) {
    return this.manager.get(ownerFor(conn), conn);
  }

  containers(conn: ConnectionConfig): Promise<string[] | undefined> {
    return this.cached(`${conn.id}|containers`, async () => (await this.session(conn)).listContainers());
  }

  defaultContainer(conn: ConnectionConfig): Promise<string | undefined> {
    return this.cached(`${conn.id}|default`, async () => (await this.session(conn)).defaultContainer());
  }

  tables(conn: ConnectionConfig, container?: string): Promise<TableInfo[]> {
    return this.cached(`${conn.id}|tables|${container ?? ''}`, async () => (await this.session(conn)).listTables(container));
  }

  columns(conn: ConnectionConfig, table: string, container?: string): Promise<ColumnInfo[]> {
    return this.cached(`${conn.id}|cols|${container ?? ''}|${table}`, async () => (await this.session(conn)).listColumns(table, container));
  }

  /** Compact schema text for AI prompts. Tables named in `focus` come first. */
  async describeForAi(conn: ConnectionConfig, focus: string, budget = 12000): Promise<string> {
    const container = await this.defaultContainer(conn).catch(() => undefined);
    let containers: (string | undefined)[] = [container];
    if (!container && conn.driver === 'mysql') containers = ((await this.containers(conn).catch(() => [])) ?? []).slice(0, 5);
    const lower = focus.toLowerCase();
    const parts: string[] = [];
    let used = 0;
    for (const c of containers) {
      const tables = await this.tables(conn, c).catch(() => [] as TableInfo[]);
      const ranked = [...tables].sort((a, b) => Number(lower.includes(b.name.toLowerCase())) - Number(lower.includes(a.name.toLowerCase())));
      for (const t of ranked.slice(0, 80)) {
        if (used > budget) break;
        const cols = await this.columns(conn, t.name, c).catch(() => [] as ColumnInfo[]);
        const name = c && containers.length > 1 ? `${c}.${t.name}` : t.name;
        const line = `${t.type === 'view' ? 'view ' : ''}${name}(${cols.map((x) => `${x.name} ${x.type}${x.pk ? ' pk' : ''}`).join(', ')})`;
        parts.push(line);
        used += line.length;
      }
    }
    if (!parts.length) return '(no tables found)';
    return (container ? `Current ${conn.driver === 'mysql' ? 'database' : 'schema'}: ${container}\n` : '') + parts.join('\n');
  }
}

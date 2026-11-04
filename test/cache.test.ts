import { describe, expect, it } from 'vitest';
import { SchemaCache } from '../src/schema/cache';
import type { ConnectionConfig, Session } from '../src/db/types';

/** A session manager whose first session dies with "Connection lost", like a SQL Server connection after a restart. */
function fakeManager(firstError: string) {
  const log: string[] = [];
  let opened = 0;
  const live = new Map<string, Promise<Session>>();
  const manager = {
    get(owner: string, conn: ConnectionConfig) {
      const key = `${owner}|${conn.id}`;
      if (!live.has(key)) {
        const n = ++opened;
        log.push(`open ${n}`);
        live.set(key, Promise.resolve({
          listTables: async () => {
            if (n === 1) throw new Error(firstError);
            return [{ name: 'customers', type: 'table' }];
          },
        } as unknown as Session));
      }
      return live.get(key)!;
    },
    async drop(owner: string, connId: string) {
      log.push('drop');
      live.delete(`${owner}|${connId}`);
    },
  };
  return { manager, log };
}

const server = { id: 'c1', name: 'SQL Server', driver: 'mssql', host: 'localhost' } as ConnectionConfig;
const memory = { id: 'c2', name: 'Scratch DuckDB', driver: 'duckdb' } as ConnectionConfig;

describe('schema cache reconnects', () => {
  it('reopens a lost explorer session once and succeeds', async () => {
    const { manager, log } = fakeManager('Connection lost - read ECONNRESET');
    const cache = new SchemaCache(manager as any);
    expect(await cache.tables(server)).toEqual([{ name: 'customers', type: 'table' }]);
    expect(log).toEqual(['open 1', 'drop', 'open 2']);
  });
  it('does not retry other errors', async () => {
    const { manager, log } = fakeManager('Login failed for user sa');
    const cache = new SchemaCache(manager as any);
    await expect(cache.tables(server)).rejects.toThrow('Login failed');
    expect(log).toEqual(['open 1']);
  });
  it('never drops an in-memory database', async () => {
    const { manager, log } = fakeManager('Connection lost');
    const cache = new SchemaCache(manager as any);
    await expect(cache.tables(memory)).rejects.toThrow('Connection lost');
    expect(log).toEqual(['open 1']);
  });
});

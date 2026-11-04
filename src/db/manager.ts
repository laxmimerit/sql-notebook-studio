// Opens and caches sessions. Each notebook keeps its own session per
// connection, so USE, SET, temp tables and transactions carry across cells.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ConnectionConfig, ResolvedConnection, Secrets, Session } from './types';
import { DRIVERS } from './types';
import type { ConnectionStore } from '../connections/store';
import { resolveEnv } from '../util/variables';

type DriverModule = { open(conn: ResolvedConnection): Promise<Session> };
type TunnelModule = typeof import('./tunnel');

export const META_OWNER = 'explorer';
const SHARED_OWNER = 'shared';

/** In-memory databases are shared by all notebooks and the explorer, so everyone sees the same tables. */
export function isMemory(conn: ConnectionConfig): boolean {
  return (conn.driver === 'sqlite' || conn.driver === 'duckdb') && (!conn.file?.trim() || conn.file.trim() === ':memory:');
}

export function ownerFor(conn: ConnectionConfig, notebookUri?: string): string {
  if (isMemory(conn)) return SHARED_OWNER;
  return notebookUri ?? META_OWNER;
}

export class SessionManager implements vscode.Disposable {
  private sessions = new Map<string, Promise<Session>>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with a connection id when it connects or disconnects. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly store: ConnectionStore, private readonly distDir: string) {}

  private load<T>(name: string): T {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path.join(this.distDir, name));
  }

  isConnected(connId: string): boolean {
    for (const k of this.sessions.keys()) if (k.endsWith('|' + connId)) return true;
    return false;
  }

  get(owner: string, conn: ConnectionConfig): Promise<Session> {
    const key = `${owner}|${conn.id}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = this.open(conn);
      this.sessions.set(key, s);
      s.then(
        () => this.emitter.fire(conn.id),
        () => this.sessions.delete(key),
      );
    }
    return s;
  }

  /** Opens a fresh session, outside the cache. Used by Test Connection. */
  async open(conn: ConnectionConfig, secrets?: Secrets): Promise<Session> {
    const resolved: ResolvedConnection = {
      ...conn,
      host: resolveEnv(conn.host),
      user: resolveEnv(conn.user),
      database: resolveEnv(conn.database),
      file: resolveEnv(conn.file),
      port: conn.port || DRIVERS[conn.driver].defaultPort,
      secrets: {},
    };
    const raw = secrets ?? (await this.store.secrets(conn.id));
    for (const [k, v] of Object.entries(raw)) (resolved.secrets as any)[k] = resolveEnv(v as string);

    let closeTunnel: (() => void) | undefined;
    if (conn.ssh?.enabled && !DRIVERS[conn.driver].fileBased) {
      const t = await this.load<TunnelModule>('tunnel.js').openTunnel(resolved);
      closeTunnel = t.close;
      resolved.host = '127.0.0.1';
      resolved.port = t.localPort;
      if (resolved.mssql) resolved.mssql = { ...resolved.mssql, instanceName: undefined };
    }
    try {
      const session = await this.load<DriverModule>(`drivers/${conn.driver}.js`).open(resolved);
      if (!closeTunnel) return session;
      const close = session.close.bind(session);
      session.close = async () => {
        try {
          await close();
        } finally {
          closeTunnel!();
        }
      };
      return session;
    } catch (e) {
      closeTunnel?.();
      throw e;
    }
  }

  async drop(owner: string, connId: string): Promise<void> {
    const key = `${owner}|${connId}`;
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    await s.then((x) => x.close()).catch(() => undefined);
    this.emitter.fire(connId);
  }

  async dropConnection(connId: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter((k) => k.endsWith('|' + connId));
    await Promise.all(keys.map((k) => this.drop(k.slice(0, k.lastIndexOf('|')), connId)));
  }

  async dropOwner(owner: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(owner + '|'));
    await Promise.all(keys.map((k) => this.drop(owner, k.slice(owner.length + 1))));
  }

  dispose() {
    for (const s of this.sessions.values()) s.then((x) => x.close()).catch(() => undefined);
    this.sessions.clear();
    this.emitter.dispose();
  }
}

const LOST = /closed state|connection (is )?(lost|terminated|closed)|not connected|ECONNRESET|EPIPE|socket hang up|Connection is closed|Cannot enqueue|server has gone away/i;

export function isConnectionLost(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as any)?.code;
  return LOST.test(msg) || ['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ESOCKET', 'ECONNCLOSED'].includes(code);
}

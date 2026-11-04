import * as vscode from 'vscode';
import * as path from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import type { ConnectionConfig, Secrets } from '../db/types';

const KEY = 'sqlNotebook.connections.v1';
const SECRET_FIELDS: (keyof Secrets)[] = ['password', 'sshPassword', 'sshPassphrase'];

export const BUILTIN_SCRATCH = 'builtin-sqlite-memory';
export const BUILTIN_SAMPLE = 'builtin-sample-shop';
export const BUILTIN_DUCK = 'builtin-duckdb-memory';

export class ConnectionStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private builtins: ConnectionConfig[];

  constructor(private readonly ctx: vscode.ExtensionContext) {
    ctx.globalState.setKeysForSync([KEY]);
    this.builtins = [
      { id: BUILTIN_SAMPLE, name: 'Sample Shop', driver: 'sqlite', file: this.samplePath(), folder: 'Built-in', builtin: true },
      { id: BUILTIN_SCRATCH, name: 'Scratch SQLite', driver: 'sqlite', file: ':memory:', folder: 'Built-in', builtin: true },
      { id: BUILTIN_DUCK, name: 'Scratch DuckDB', driver: 'duckdb', file: ':memory:', folder: 'Built-in', builtin: true },
    ];
  }

  /** The sample database lives in global storage so it can be changed and reset. */
  samplePath(reset = false): string {
    const dir = this.ctx.globalStorageUri.fsPath;
    const target = path.join(dir, 'sample-shop.sqlite');
    if (reset || !existsSync(target)) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(path.join(this.ctx.extensionPath, 'samples', 'shop.sqlite'), target);
    }
    return target;
  }

  dispose() {
    this.emitter.dispose();
  }

  private user(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(KEY, []);
  }

  list(): ConnectionConfig[] {
    return [...this.user(), ...this.builtins];
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  byName(name: string): ConnectionConfig | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((c) => c.name.toLowerCase() === n);
  }

  nameTaken(name: string, exceptId?: string): boolean {
    const n = name.trim().toLowerCase();
    return this.list().some((c) => c.id !== exceptId && c.name.toLowerCase() === n);
  }

  /** Saves a connection. Secrets left undefined keep their saved value; '' clears them. */
  async save(conn: ConnectionConfig, secrets: Partial<Secrets> = {}): Promise<void> {
    if (conn.builtin) throw new Error('Built-in connections cannot be changed.');
    if (this.nameTaken(conn.name, conn.id)) throw new Error(`A connection named "${conn.name}" already exists.`);
    const list = this.user().filter((c) => c.id !== conn.id);
    const existingIndex = this.user().findIndex((c) => c.id === conn.id);
    if (existingIndex >= 0) list.splice(existingIndex, 0, conn);
    else list.push(conn);
    for (const f of SECRET_FIELDS) {
      const v = secrets[f];
      if (v === undefined) continue;
      if (v === '') await this.ctx.secrets.delete(secretKey(conn.id, f));
      else await this.ctx.secrets.store(secretKey(conn.id, f), v);
    }
    await this.ctx.globalState.update(KEY, list);
    this.emitter.fire();
  }

  async delete(id: string): Promise<void> {
    await this.ctx.globalState.update(KEY, this.user().filter((c) => c.id !== id));
    for (const f of SECRET_FIELDS) await this.ctx.secrets.delete(secretKey(id, f));
    this.emitter.fire();
  }

  async secrets(id: string): Promise<Secrets> {
    const out: Secrets = {};
    for (const f of SECRET_FIELDS) {
      const v = await this.ctx.secrets.get(secretKey(id, f));
      if (v !== undefined) out[f] = v;
    }
    return out;
  }

  async copySecrets(fromId: string, toId: string): Promise<void> {
    const s = await this.secrets(fromId);
    for (const f of SECRET_FIELDS) if (s[f]) await this.ctx.secrets.store(secretKey(toId, f), s[f]!);
  }

  uniqueName(base: string): string {
    if (!this.nameTaken(base)) return base;
    for (let n = 2; ; n++) if (!this.nameTaken(`${base} (${n})`)) return `${base} (${n})`;
  }
}

function secretKey(id: string, field: keyof Secrets) {
  return `sqlNotebook.conn.${id}.${field}`;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function describe(c: ConnectionConfig): string {
  if (c.driver === 'sqlite' || c.driver === 'duckdb') return c.file === ':memory:' ? 'in memory' : path.basename(c.file ?? '');
  const host = `${c.host || 'localhost'}${c.port ? ':' + c.port : ''}`;
  return [c.user ? `${c.user}@${host}` : host, c.database].filter(Boolean).join(' / ');
}

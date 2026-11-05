import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { ColumnInfo, ResolvedConnection, RunOptions, Session, TableInfo } from '../types';
import { CancelledError, QueryFailure } from '../types';

type Pending = { onEvent: (msg: any) => void };

class SqliteSession implements Session {
  readonly driver = 'sqlite' as const;
  private child!: ChildProcess;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private cancelled = false;
  private closed = false;

  constructor(private file: string, private readOnly: boolean) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, '..', 'sqliteWorker.js'), [this.file, this.readOnly ? '1' : '0'], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('message', (msg: any) => {
        if (msg.event === 'ready') resolve();
        else this.pending.get(msg.id)?.onEvent(msg);
      });
      child.on('exit', () => {
        if (child !== this.child) return;
        reject(new Error(stderr.trim().split('\n').pop() || 'SQLite could not open the file.'));
        for (const p of this.pending.values()) p.onEvent({ event: 'exit' });
        this.pending.clear();
      });
      child.on('error', reject);
    });
  }

  private request(msg: Record<string, unknown>, onEvent: (m: any, done: (v?: any) => void, fail: (e: Error) => void) => void): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Connection is closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        onEvent: (m) => {
          const done = (v?: any) => {
            this.pending.delete(id);
            resolve(v);
          };
          const fail = (e: Error) => {
            this.pending.delete(id);
            reject(e);
          };
          if (m.event === 'exit') return fail(this.cancelled ? new CancelledError('Query stopped.') : new Error('SQLite stopped unexpectedly.'));
          onEvent(m, done, fail);
        },
      });
      this.child.send({ id, ...msg });
    });
  }

  private query(sql: string, params: unknown[] = []): Promise<any[]> {
    return this.request({ op: 'query', sql, params }, (m, done, fail) => {
      if (m.event === 'done') done(m.rows);
      else if (m.event === 'error') fail(new Error(m.message));
    });
  }

  async run(statements: string[], opts: RunOptions): Promise<void> {
    this.cancelled = false;
    await this.request({ op: 'run', statements, maxRows: opts.maxRows }, (m, done, fail) => {
      if (m.event === 'start') opts.onStart(m.index);
      else if (m.event === 'result') opts.onResult(m.result, m.index);
      else if (m.event === 'done') done();
      else if (m.event === 'error') fail(new QueryFailure(m.message, m.index, m.code !== undefined ? String(m.code) : undefined));
    });
  }

  async cancel(): Promise<void> {
    // node:sqlite has no interrupt, so Stop ends the process and opens the file again.
    // A file database keeps its data; an in-memory one starts empty.
    this.cancelled = true;
    const old = this.child;
    await new Promise<void>((resolve) => {
      if (old.exitCode !== null) return resolve();
      old.once('exit', () => resolve());
      old.kill();
    });
    for (const p of this.pending.values()) p.onEvent({ event: 'exit' });
    this.pending.clear();
    await this.start();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.child.kill();
  }

  async serverVersion(): Promise<string> {
    const r = await this.query('select sqlite_version() v');
    return `SQLite ${r[0].v}`;
  }

  async listContainers() {
    return undefined;
  }

  async defaultContainer() {
    return undefined;
  }

  async location() {
    return {};
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.query(
      "select name, type from sqlite_schema where type in ('table','view') and name not like 'sqlite_%' order by name",
    );
    return rows.map((r) => ({ name: r.name, type: r.type === 'view' ? 'view' : 'table' }));
  }

  async listColumns(table: string): Promise<ColumnInfo[]> {
    const rows = await this.query('select name, type, "notnull" as nn, pk from pragma_table_info(?)', [table]);
    return rows.map((r) => ({ name: r.name, type: r.type || '', pk: r.pk > 0, nullable: !r.nn }));
  }

  async explain(sql: string): Promise<string | undefined> {
    const rows = await this.query(`explain query plan ${sql}`);
    const depth = new Map<number, number>();
    return rows
      .map((r) => {
        const d = (depth.get(r.parent) ?? -1) + 1;
        depth.set(r.id, d);
        return `${'  '.repeat(d)}${r.detail}`;
      })
      .join('\n');
  }
}

export async function open(conn: ResolvedConnection): Promise<Session> {
  const file = conn.file?.trim() || ':memory:';
  const s = new SqliteSession(file, !!conn.readOnly);
  await s.start();
  return s;
}

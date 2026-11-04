// Runs SQLite (node:sqlite, built into VS Code's runtime) in a child process,
// so long queries never freeze VS Code and Stop ends them at once.

import { DatabaseSync } from 'node:sqlite';
import { toCell, kindFromType, inferKinds } from '../values';
import type { Cell, Column, StatementResult } from '../../../shared/protocol';

const [file, readOnlyFlag] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: readOnlyFlag === '1', timeout: 5000 } as any);
const send = (m: unknown) => process.send!(m);

type Req =
  | { id: number; op: 'run'; statements: string[]; maxRows: number }
  | { id: number; op: 'query'; sql: string; params?: unknown[] }
  | { id: number; op: 'close' };

process.on('message', (req: Req) => {
  try {
    if (req.op === 'run') {
      for (let i = 0; i < req.statements.length; i++) {
        send({ id: req.id, event: 'start', index: i });
        try {
          const result = runOne(req.statements[i], req.maxRows);
          send({ id: req.id, event: 'result', index: i, result });
        } catch (e) {
          send({ id: req.id, event: 'error', index: i, message: errMsg(e), code: (e as any)?.errcode ?? (e as any)?.code });
          return;
        }
      }
      send({ id: req.id, event: 'done' });
    } else if (req.op === 'query') {
      const st = db.prepare(req.sql);
      const rows = (st.all(...((req.params ?? []) as any[])) as Record<string, unknown>[]).map((r) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
        return o;
      });
      send({ id: req.id, event: 'done', rows });
    } else if (req.op === 'close') {
      db.close();
      send({ id: req.id, event: 'done' });
      process.exit(0);
    }
  } catch (e) {
    send({ id: req.id, event: 'error', index: 0, message: errMsg(e) });
  }
});

process.on('disconnect', () => process.exit(0));
send({ event: 'ready' });

function runOne(sql: string, maxRows: number): StatementResult {
  const t0 = performance.now();
  const st = db.prepare(sql);
  const meta = st.columns();
  if (meta.length === 0) {
    const r = st.run();
    return { sql, columns: [], rows: [], hasRows: false, truncated: false, affected: Number(r.changes), durationMs: performance.now() - t0 };
  }
  st.setReturnArrays(true);
  const rows: Cell[][] = [];
  let truncated = false;
  for (const row of st.iterate() as Iterable<unknown[]>) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row.map(toCell));
  }
  let columns: Column[] = meta.map((c) => ({ name: c.name, type: c.type ?? '', kind: kindFromType(c.type ?? '') }));
  columns = inferKinds(columns, rows);
  return { sql, columns, rows, hasRows: true, truncated, durationMs: performance.now() - t0 };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

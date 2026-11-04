import { readFileSync } from 'node:fs';
import type { ResolvedConnection } from '../types';

/** Reads SSL files from disk. Returns undefined when SSL is off. */
export function sslOptions(conn: ResolvedConnection) {
  const s = conn.ssl;
  if (!s?.enabled) return undefined;
  const read = (p?: string) => (p?.trim() ? readFileSync(p.trim(), 'utf8') : undefined);
  return {
    rejectUnauthorized: s.rejectUnauthorized ?? true,
    ca: read(s.ca),
    cert: read(s.cert),
    key: read(s.key),
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof AggregateError && e.errors?.length) return e.errors.map(errorMessage).join('\n');
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

export function errorCode(e: unknown): string | undefined {
  const c = (e as any)?.code ?? (e as any)?.number;
  return c === undefined ? undefined : String(c);
}

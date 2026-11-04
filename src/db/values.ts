// Turns driver values into plain JSON the renderer can show correctly:
// dates as readable text, binary as hex, JSON as objects, big numbers as text.

import type { Cell, Column, ColumnKind } from '../../shared/protocol';

const BIN_PREVIEW = 48;

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  }
  if (v instanceof Date) return formatDate(v);
  if (v instanceof Uint8Array) return toBinary(v);
  if (v instanceof ArrayBuffer) return toBinary(new Uint8Array(v));
  if (Array.isArray(v)) return v.map(toJsonSafe) as unknown[];
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.toJSON === 'function') {
      const j = (o.toJSON as () => unknown)();
      if (typeof j === 'string' || typeof j === 'number') return j;
    }
    return toJsonSafe(v) as Record<string, unknown>;
  }
  return String(v);
}

function toJsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return formatDate(v);
  if (v instanceof Uint8Array) return toBinary(v);
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toJsonSafe(val);
    return out;
  }
  return v;
}

function toBinary(b: Uint8Array): Cell {
  let hex = '';
  const n = Math.min(b.length, BIN_PREVIEW);
  for (let i = 0; i < n; i++) hex += b[i].toString(16).padStart(2, '0');
  return { $bin: hex, len: b.length };
}

/** Local, readable, sortable: 2026-11-04 14:03:22.120. Midnight dates show as just the date. */
export function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid date';
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const h = d.getHours(), m = d.getMinutes(), s = d.getSeconds(), ms = d.getMilliseconds();
  if (h === 0 && m === 0 && s === 0 && ms === 0) return date;
  return `${date} ${p(h)}:${p(m)}:${p(s)}${ms ? '.' + p(ms, 3) : ''}`;
}

const NUM = /^(tiny|small|medium|big)?int|^int|integer|serial|decimal|numeric|number|real|float|double|money|hugeint|ubigint|uinteger|usmallint|utinyint|^bit$|^(longlong|long|short|tiny|int24|newdecimal|year)$/i;
const DATE = /date|time|interval/i;
const BOOL = /^bool/i;
const JSON_T = /json|struct|map|list|\[\]|array|union|variant/i;
const BIN = /blob|binary|bytea|image|varbinary|^bit\(/i;

export function kindFromType(type: string): ColumnKind {
  const t = type.trim();
  if (!t) return 'other';
  if (BOOL.test(t)) return 'bool';
  if (JSON_T.test(t)) return 'json';
  if (BIN.test(t)) return 'binary';
  if (DATE.test(t)) return 'date';
  if (NUM.test(t)) return 'number';
  return 'string';
}

/** Fills in column kinds from the values when the driver gave no useful type. */
export function inferKinds(columns: Column[], rows: Cell[][]): Column[] {
  return columns.map((c, i) => {
    if (c.kind !== 'other') return c;
    for (let r = 0; r < Math.min(rows.length, 50); r++) {
      const v = rows[r][i];
      if (v === null) continue;
      if (typeof v === 'number') return { ...c, kind: 'number' };
      if (typeof v === 'boolean') return { ...c, kind: 'bool' };
      if (typeof v === 'object') return { ...c, kind: '$bin' in (v as object) ? 'binary' : 'json' };
      return { ...c, kind: 'string' };
    }
    return { ...c, kind: 'string' };
  });
}

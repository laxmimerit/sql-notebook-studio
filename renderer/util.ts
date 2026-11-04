import type { BinaryValue, Cell, Column, RendererMessage } from '../shared/protocol';

let post: ((m: RendererMessage) => void) | undefined;
export function setPoster(fn: ((m: RendererMessage) => void) | undefined) {
  post = fn;
}
export function send(m: RendererMessage): boolean {
  if (!post) return false;
  post(m);
  return true;
}

export function isBin(v: Cell): v is BinaryValue {
  return !!v && typeof v === 'object' && !Array.isArray(v) && '$bin' in v;
}

/** Text for display in a grid cell (one line). */
export function display(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isBin(v)) return `0x${v.$bin.toUpperCase()}${v.len > v.$bin.length / 2 ? '…' : ''}`;
  const s = JSON.stringify(v);
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}

/** Full text for copying and the value viewer. */
export function full(v: Cell, pretty = false): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isBin(v)) return `0x${v.$bin.toUpperCase()}${v.len > v.$bin.length / 2 ? `… (${v.len.toLocaleString()} bytes)` : ''}`;
  return JSON.stringify(v, null, pretty ? 2 : undefined);
}

export function toNumber(v: Cell): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

export function compare(a: Cell, b: Cell, numeric: boolean): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (numeric) {
    const x = toNumber(a), y = toNumber(b);
    if (x !== null && y !== null) return x - y;
  }
  return collator.compare(full(a), full(b));
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Column filter: text contains, =exact, !not, >5, <=10, 1..9, null, !null. */
export function makeFilter(expr: string, kind: Column['kind']): ((v: Cell) => boolean) | undefined {
  const e = expr.trim();
  if (!e) return undefined;
  const low = e.toLowerCase();
  if (low === 'null') return (v) => v === null;
  if (low === '!null' || low === 'not null') return (v) => v !== null;
  const cmp = /^(>=|<=|!=|<>|>|<|=)\s*(.+)$/.exec(e);
  const range = /^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/.exec(e);
  if (range) {
    const lo = Number(range[1]), hi = Number(range[2]);
    return (v) => {
      const n = toNumber(v);
      return n !== null && n >= lo && n <= hi;
    };
  }
  if (cmp) {
    const [, op, rhs] = cmp;
    const num = Number(rhs);
    const useNum = !Number.isNaN(num) && (kind === 'number' || kind === 'bool' || /^-?[\d.]+$/.test(rhs));
    return (v) => {
      if (v === null) return op === '!=' || op === '<>';
      const c = useNum ? (toNumber(v) ?? NaN) - num : collator.compare(full(v), rhs);
      if (Number.isNaN(c)) return false;
      switch (op) {
        case '>': return c > 0;
        case '<': return c < 0;
        case '>=': return c >= 0;
        case '<=': return c <= 0;
        case '=': return c === 0;
        default: return c !== 0;
      }
    };
  }
  if (e.startsWith('!')) {
    const s = low.slice(1);
    return (v) => !full(v).toLowerCase().includes(s);
  }
  return (v) => v !== null && full(v).toLowerCase().includes(low);
}

export function toDelimited(columns: Column[], rows: Cell[][], sep: ',' | '\t'): string {
  const esc = (s: string) => (sep === ',' ? (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s) : s.replace(/[\t\n\r]/g, ' '));
  return [columns.map((c) => esc(c.name)).join(sep), ...rows.map((r) => r.map((v) => esc(full(v))).join(sep))].join('\n');
}

export function toMarkdown(columns: Column[], rows: Cell[][]): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [
    `| ${columns.map((c) => esc(c.name)).join(' | ')} |`,
    `| ${columns.map((c) => (c.kind === 'number' ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((v) => esc(v === null ? 'NULL' : full(v))).join(' | ')} |`),
  ].join('\n');
}

export function toJson(columns: Column[], rows: Cell[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))), null, 2);
}

export function copyText(text: string) {
  if (!send({ type: 'copy', text })) void navigator.clipboard?.writeText(text);
}

export function fmtMs(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m} m ${Math.round((ms % 60000) / 1000)} s`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

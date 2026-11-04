// {{name}} variables inside SQL, and ${env:NAME} inside connection fields.

const VAR = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

export function findVariables(sql: string): string[] {
  const names = new Set<string>();
  for (const m of sql.matchAll(VAR)) names.add(m[1]);
  return [...names];
}

export function substitute(sql: string, values: Record<string, string>): string {
  return sql.replace(VAR, (whole, name: string) => (name in values ? values[name] : whole));
}

/** Resolves ${env:NAME} anywhere in a value. Missing variables become empty. */
export function resolveEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\$\{env:([A-Za-z_]\w*)\}/g, (_w, n: string) => process.env[n] ?? '');
}

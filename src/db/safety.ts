// Classifies statements so read-only connections refuse writes and risky
// statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE) can be confirmed.

import { stripComments } from './splitter';

const WRITE = /^(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|CLUSTER|COPY|LOAD|IMPORT|ATTACH|DETACH|CALL|EXEC|EXECUTE|DO|SET\s+PASSWORD|LOCK|OPTIMIZE|REPAIR|INSTALL|UNINSTALL)\b/i;

export interface Classification {
  write: boolean;
  /** A short reason when the statement is risky, else undefined. */
  risk?: string;
}

export function classify(sql: string): Classification {
  const s = stripComments(sql).trim().replace(/\s+/g, ' ');
  let head = s;
  // WITH ... a CTE can wrap DELETE/UPDATE/INSERT in PostgreSQL.
  if (/^WITH\b/i.test(s)) {
    const m = /\)\s*(INSERT|UPDATE|DELETE|MERGE|SELECT)\b/i.exec(s);
    head = m ? s.slice(m.index + m[0].length - m[1].length) : s;
  }
  const write = WRITE.test(head) || /\bINTO\s+\S+\s+FROM\b/i.test(head) && /^SELECT\b/i.test(head);
  let risk: string | undefined;
  if (/^DROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX)\b/i.test(head)) risk = head.split(' ').slice(0, 3).join(' ');
  else if (/^TRUNCATE\b/i.test(head)) risk = 'TRUNCATE';
  else if (/^(DELETE|UPDATE)\b/i.test(head) && !/\bWHERE\b/i.test(head)) risk = `${head.split(' ')[0].toUpperCase()} without WHERE`;
  return { write, risk };
}

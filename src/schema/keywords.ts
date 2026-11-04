// SQL keywords for autocomplete, and the letter case they are inserted in.
// Kept free of the vscode module so unit tests can import it.

import type { DriverId } from '../db/types';

export const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL',
  'DISTINCT', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'INSERT INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'ALTER TABLE', 'DROP TABLE', 'PRIMARY KEY',
  'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'NULL', 'ASC', 'DESC', 'OVER', 'PARTITION BY', 'ROWS', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'ROUND', 'LOWER', 'UPPER', 'TRIM', 'LENGTH', 'SUBSTRING', 'NOW',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'EXPLAIN',
];

export const EXTRA: Partial<Record<DriverId, string[]>> = {
  mysql: ['SHOW TABLES', 'SHOW DATABASES', 'DESCRIBE', 'USE', 'AUTO_INCREMENT', 'IFNULL', 'GROUP_CONCAT', 'DATE_FORMAT', 'STR_TO_DATE'],
  postgres: ['RETURNING', 'ILIKE', 'SERIAL', 'JSONB', 'STRING_AGG', 'GENERATE_SERIES', 'DATE_TRUNC', 'TO_CHAR', 'ON CONFLICT'],
  mssql: ['TOP', 'GO', 'NVARCHAR', 'ISNULL', 'GETDATE', 'DATEADD', 'DATEDIFF', 'STRING_AGG', 'OUTPUT', 'IDENTITY'],
  sqlite: ['PRAGMA', 'AUTOINCREMENT', 'IFNULL', 'STRFTIME', 'DATE', 'DATETIME', 'GROUP_CONCAT', 'WITHOUT ROWID'],
  duckdb: ['DESCRIBE', 'SUMMARIZE', 'PIVOT', 'UNPIVOT', 'QUALIFY', 'read_csv', 'read_parquet', 'read_json', 'EXCLUDE', 'COPY'],
};

export type KeywordCase = 'auto' | 'upper' | 'lower';

/**
 * The case to insert keywords in. Uppercase unless the setting says otherwise.
 * "auto" follows what the user is typing:
 * all lowercase letters give lowercase, anything else (or nothing typed yet)
 * gives uppercase.
 */
export function keywordCase(typed: string, setting: KeywordCase = 'upper'): 'upper' | 'lower' {
  if (setting !== 'auto') return setting;
  return /[a-z]/.test(typed) && !/[A-Z]/.test(typed) ? 'lower' : 'upper';
}

/** A keyword in the given case. Mixed-case entries such as read_csv stay as they are. */
export function applyCase(keyword: string, c: 'upper' | 'lower'): string {
  if (keyword !== keyword.toUpperCase()) return keyword;
  return c === 'lower' ? keyword.toLowerCase() : keyword;
}

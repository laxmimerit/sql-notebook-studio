import type { StatementResult } from '../../shared/protocol';

export type DriverId = 'mysql' | 'postgres' | 'mssql' | 'sqlite' | 'duckdb';

export const DRIVERS: Record<DriverId, { label: string; defaultPort?: number; fileBased: boolean; icon: string }> = {
  mysql: { label: 'MySQL / MariaDB', defaultPort: 3306, fileBased: false, icon: 'mysql' },
  postgres: { label: 'PostgreSQL', defaultPort: 5432, fileBased: false, icon: 'postgres' },
  mssql: { label: 'SQL Server', defaultPort: 1433, fileBased: false, icon: 'mssql' },
  sqlite: { label: 'SQLite', fileBased: true, icon: 'sqlite' },
  duckdb: { label: 'DuckDB', fileBased: true, icon: 'duckdb' },
};

export type EnvTag = 'none' | 'dev' | 'staging' | 'production';

export interface SslConfig {
  enabled: boolean;
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface SshConfig {
  enabled: boolean;
  host: string;
  port?: number;
  user: string;
  auth: 'password' | 'key' | 'agent';
  keyFile?: string;
}

export interface MssqlConfig {
  auth: 'sql' | 'ntlm' | 'azure-default';
  domain?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  instanceName?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverId;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  /** SQLite / DuckDB file path, or ':memory:'. */
  file?: string;
  folder?: string;
  env?: EnvTag;
  readOnly?: boolean;
  ssl?: SslConfig;
  ssh?: SshConfig;
  mssql?: MssqlConfig;
  builtin?: boolean;
}

export interface Secrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

/** Everything a driver needs to open a session. Tunnel already applied. */
export interface ResolvedConnection extends ConnectionConfig {
  secrets: Secrets;
}

export interface RunOptions {
  maxRows: number;
  onResult: (result: StatementResult, index: number) => void;
  onStart: (index: number) => void;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view';
}

export interface ColumnInfo {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
}

export interface Session {
  readonly driver: DriverId;
  /** Runs statements one at a time, on one connection, in order. */
  run(statements: string[], options: RunOptions): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  serverVersion(): Promise<string>;
  /** Databases (MySQL) or schemas (PostgreSQL, SQL Server). Undefined for flat drivers. */
  listContainers(): Promise<string[] | undefined>;
  defaultContainer(): Promise<string | undefined>;
  listTables(container?: string): Promise<TableInfo[]>;
  listColumns(table: string, container?: string): Promise<ColumnInfo[]>;
  /** A plan for the query, used by Optimize with AI. */
  explain(sql: string): Promise<string | undefined>;
}

export class QueryFailure extends Error {
  constructor(
    message: string,
    public readonly statementIndex: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export class CancelledError extends Error {
  constructor(message = 'Query stopped.') {
    super(message);
  }
}

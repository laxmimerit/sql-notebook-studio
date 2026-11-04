// Parses connection strings into form fields:
//   mysql://user:pass@host:3306/db?ssl=true
//   postgres://user:pass@host/db?sslmode=require
//   sqlserver://host:1433;database=db  or  Server=host,1433;Database=db;User Id=u;Password=p;Encrypt=true
//   sqlite:///path/to/file.db   duckdb:///path/file.duckdb   or a bare file path

import type { ConnectionConfig, DriverId } from '../db/types';

export interface Parsed {
  config: Partial<ConnectionConfig>;
  password?: string;
}

const SCHEMES: Record<string, DriverId> = {
  mysql: 'mysql', mariadb: 'mysql', 'mysql+ssl': 'mysql',
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres',
  sqlserver: 'mssql', mssql: 'mssql',
  sqlite: 'sqlite', sqlite3: 'sqlite', file: 'sqlite',
  duckdb: 'duckdb',
};

export function parseConnectionString(input: string): Parsed {
  const s = input.trim();
  if (!s) throw new Error('Paste a connection string.');

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return parseUrl(s);
  if (/(^|;)\s*(server|data source|host)\s*=/i.test(s)) return parseAdo(s);
  if (/\.(duckdb|ddb)$/i.test(s)) return { config: { driver: 'duckdb', file: s } };
  if (/\.(sqlite3?|db|db3)$/i.test(s)) return { config: { driver: 'sqlite', file: s } };
  throw new Error('Unrecognized connection string.');
}

function parseUrl(s: string): Parsed {
  const scheme = s.slice(0, s.indexOf(':')).toLowerCase();
  const driver = SCHEMES[scheme];
  if (!driver) throw new Error(`Unsupported scheme "${scheme}".`);
  if (driver === 'sqlite' || driver === 'duckdb') {
    let file = decodeURIComponent(s.replace(/^[^:]+:\/\//, ''));
    if (/^\/[A-Za-z]:/.test(file)) file = file.slice(1);
    return { config: { driver, file: file || ':memory:' } };
  }
  if (driver === 'mssql' && s.includes(';')) {
    const [head, ...rest] = s.replace(/^[^:]+:\/\//, '').split(';');
    const parsed = parseAdo(`Server=${head.replace(':', ',')};${rest.join(';')}`);
    return parsed;
  }
  const u = new URL(s.replace(/^[^:]+:/, 'http:'));
  const q = u.searchParams;
  const config: Partial<ConnectionConfig> = {
    driver,
    host: decodeURIComponent(u.hostname) || 'localhost',
    port: u.port ? Number(u.port) : undefined,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || undefined,
  };
  const sslmode = (q.get('sslmode') ?? q.get('ssl-mode') ?? '').toLowerCase();
  const ssl = q.get('ssl') ?? q.get('tls');
  if (scheme === 'mysql+ssl' || /^(require|verify-ca|verify-full|required|verify_identity|verify_ca)$/.test(sslmode) || ssl === 'true' || ssl === '1') {
    config.ssl = { enabled: true, rejectUnauthorized: /verify/.test(sslmode) || ssl === 'true' };
  }
  return { config, password: u.password ? decodeURIComponent(u.password) : undefined };
}

function parseAdo(s: string): Parsed {
  const kv = new Map<string, string>();
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  const get = (...keys: string[]) => keys.map((k) => kv.get(k)).find((v) => v !== undefined && v !== '');
  let server = get('server', 'data source', 'host', 'address') ?? 'localhost';
  server = server.replace(/^tcp:/i, '');
  let port: number | undefined;
  let instanceName: string | undefined;
  const comma = server.split(',');
  if (comma.length > 1) {
    server = comma[0];
    port = Number(comma[1]);
  }
  const slash = server.split('\\');
  if (slash.length > 1) {
    server = slash[0];
    instanceName = slash[1];
  }
  const bool = (v?: string) => (v === undefined ? undefined : /^(true|yes|1|mandatory|strict)$/i.test(v));
  const integrated = bool(get('integrated security', 'trusted_connection'));
  const user = get('user id', 'uid', 'user', 'username');
  return {
    config: {
      driver: 'mssql',
      host: server === '.' || server === '(local)' ? 'localhost' : server,
      port,
      database: get('database', 'initial catalog'),
      user: user ?? undefined,
      mssql: {
        auth: integrated ? 'ntlm' : /active directory/i.test(get('authentication') ?? '') ? 'azure-default' : 'sql',
        encrypt: bool(get('encrypt')) ?? true,
        trustServerCertificate: bool(get('trustservercertificate', 'trust server certificate')) ?? false,
        instanceName,
      },
    },
    password: get('password', 'pwd'),
  };
}

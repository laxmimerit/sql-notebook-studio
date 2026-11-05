// What schema the AI is shown. With SQLNB_MSSQL set (host:port:user:password),
// the last test runs against a real SQL Server with the built driver in dist/.

import { describe, expect, it, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { SchemaCache, mentions } from '../src/schema/cache';
import type { ConnectionConfig, ResolvedConnection, Session, TableInfo } from '../src/db/types';

const conn = { id: 'ms', name: 'SQL Server · localhost', driver: 'mssql', host: 'localhost' } as ConnectionConfig;

/** A SQL Server login sitting in master, with two user databases. */
function fakeServer(): Session {
  const tables: Record<string, TableInfo[]> = {
    master: [{ name: 'spt_values', type: 'table' }],
    MyDatabase: [{ name: 'persons', type: 'table' }],
    SalesDB: [{ name: 'orders', type: 'table' }],
  };
  return {
    driver: 'mssql',
    location: async () => ({ database: 'master', container: 'dbo' }),
    listDatabases: async () => ['MyDatabase', 'SalesDB'],
    listContainers: async () => ['dbo'],
    defaultContainer: async () => 'dbo',
    listTables: async (_c?: string, db?: string) => tables[db ?? 'master'],
    listColumns: async (t: string) =>
      t === 'persons'
        ? [{ name: 'id', type: 'int', pk: true }, { name: 'person_name', type: 'nvarchar' }, { name: 'birth_date', type: 'date' }, { name: 'email', type: 'nvarchar' }]
        : [{ name: 'id', type: 'int', pk: true }],
  } as unknown as Session;
}

const managerFor = (session: Session) => ({ get: async () => session, drop: async () => undefined }) as any;

describe('schema for the AI', () => {
  const request = 'go to the persons tabel of MyDatabase and insert 10 records into it';

  it('describes a database the request names, from master', async () => {
    const text = await new SchemaCache(managerFor(fakeServer())).describeForAi(conn, request);
    expect(text).toContain('The notebook is in database master.');
    expect(text).toContain('three-part name');
    expect(text).toContain('MyDatabase.dbo.persons(id int pk, person_name nvarchar, birth_date date, email nvarchar)');
    expect(text).not.toContain('spt_values');
    expect(text).not.toContain('orders');
  });

  it('uses plain names after USE MyDatabase', async () => {
    const text = await new SchemaCache(managerFor(fakeServer())).describeForAi(conn, 'insert 10 persons', { database: 'MyDatabase', container: 'dbo' });
    expect(text).toContain('The notebook is in database MyDatabase.');
    expect(text).toContain('\npersons(id int pk');
    expect(text).not.toContain('three-part name');
  });

  it('lists the user databases when the notebook is in master and names none', async () => {
    const text = await new SchemaCache(managerFor(fakeServer())).describeForAi(conn, 'how many orders per day');
    expect(text).toContain('MyDatabase.dbo.persons(');
    expect(text).toContain('SalesDB.dbo.orders(');
    expect(text.indexOf('SalesDB.dbo.orders')).toBeLessThan(text.indexOf('MyDatabase.dbo.persons'));
  });
});

describe('mentions', () => {
  it('matches whole words and singulars', () => {
    expect(mentions('add a person', 'persons')).toBe(true);
    expect(mentions('the persons table', 'persons')).toBe(true);
    expect(mentions('of mydatabase and', 'MyDatabase')).toBe(true);
    expect(mentions('customer_name', 'customers')).toBe(false);
    expect(mentions('sales', 'salesdb')).toBe(false);
  });
});

const env = process.env.SQLNB_MSSQL;
describe.skipIf(!env)('schema for the AI on a real SQL Server', () => {
  const [host, port, user, ...pw] = (env ?? '').split(':');
  const require = createRequire(import.meta.url);
  const driver = require(path.resolve(__dirname, '..', 'dist', 'drivers', 'mssql.js')) as { open(c: ResolvedConnection): Promise<Session> };
  let session: Session | undefined;
  afterAll(() => session?.close());

  it('finds MyDatabase.dbo.persons from a login in master', async () => {
    session = await driver.open({ ...conn, host, port: Number(port), user, secrets: { password: pw.join(':') }, mssql: { auth: 'sql', encrypt: true, trustServerCertificate: true } } as ResolvedConnection);
    const text = await new SchemaCache(managerFor(session)).describeForAi(conn, 'go to the persons tabel of MyDatabase and insert 10 records into it');
    expect(text).toContain('The notebook is in database master.');
    expect(text).toMatch(/MyDatabase\.dbo\.persons\(id int pk, person_name nvarchar, birth_date date, email nvarchar\)/);
  });
});

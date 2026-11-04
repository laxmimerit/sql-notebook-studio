// Integration tests against real databases, using the built drivers in dist/.
// SQLite and DuckDB always run. MySQL, PostgreSQL and SQL Server run when
// SQLNB_MYSQL / SQLNB_PG / SQLNB_MSSQL point at a test server (host:port:user:password).

import { describe, expect, it, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ResolvedConnection, Session, DriverId } from '../src/db/types';
import type { StatementResult } from '../shared/protocol';
import { splitStatements } from '../src/db/splitter';

const require = createRequire(import.meta.url);
const dist = path.resolve(__dirname, '..', 'dist');
const load = (d: DriverId) => require(path.join(dist, 'drivers', `${d}.js`)) as { open(c: ResolvedConnection): Promise<Session> };

async function run(s: Session, sql: string, driver: DriverId, maxRows = 1000) {
  const out: StatementResult[] = [];
  await s.run(splitStatements(sql, driver).map((x) => x.sql), { maxRows, onStart: () => undefined, onResult: (r) => out.push(r) });
  return out;
}

function parse(env: string | undefined) {
  if (!env) return undefined;
  const [host, port, user, ...pw] = env.split(':');
  return { host, port: Number(port), user, password: pw.join(':') };
}

interface Case {
  driver: DriverId;
  conn?: Partial<ResolvedConnection>;
  setup: string;
  slow: string;
  typesSql: string;
}

const cases: Case[] = [
  {
    driver: 'sqlite',
    conn: { file: ':memory:' },
    setup: `create table t (id integer primary key, name text, price real, data blob, js text); insert into t values (1,'a',1.5,x'DEAD','{"k":1}'),(2,'b',null,null,null)`,
    slow: `with recursive c(x) as (select 1 union all select x+1 from c) select count(*) from c`,
    typesSql: `select id, id, name, price, data from t order by 1`,
  },
  {
    driver: 'duckdb',
    conn: { file: ':memory:' },
    setup: `create table t (id integer primary key, name varchar, price decimal(10,2), data blob, js json); insert into t values (1,'a',1.5,'\\xDE\\xAD'::blob,'{"k":1}'),(2,'b',null,null,null)`,
    slow: `select sum(a.range * b.range) from range(200000) a, range(200000) b`,
    typesSql: `select id, id, name, price, data, [1,2] as l, {'x': 1} as s, timestamp '2026-01-02 03:04:05' as ts from t order by 1`,
  },
];
const my = parse(process.env.SQLNB_MYSQL);
if (my)
  cases.push({
    driver: 'mysql',
    conn: { ...my, secrets: { password: my.password }, database: undefined },
    setup: `create database if not exists sqlnb_test; use sqlnb_test; drop table if exists t; create table t (id int primary key, name varchar(20), price decimal(10,2), data varbinary(10), js json, created datetime); insert into t values (1,'a',1.5,x'DEAD','{"k":1}','2026-01-02 03:04:05'),(2,'b',null,null,null,null)`,
    slow: `select sleep(30)`,
    typesSql: `select id, id, name, price, data, js, created from t order by 1`,
  });
const pg = parse(process.env.SQLNB_PG);
if (pg)
  cases.push({
    driver: 'postgres',
    conn: { ...pg, secrets: { password: pg.password }, database: 'postgres' },
    setup: `drop table if exists t; create table t (id int primary key, name text, price numeric(10,2), data bytea, js jsonb, created timestamptz, big bigint); insert into t values (1,'a',1.5,'\\xdead','{"k":1}','2026-01-02 03:04:05+00', 9007199254740993),(2,'b',null,null,null,null,1)`,
    slow: `select pg_sleep(30)`,
    typesSql: `select id, id, name, price, data, js, created, big from t order by 1`,
  });
const ms = parse(process.env.SQLNB_MSSQL);
if (ms)
  cases.push({
    driver: 'mssql',
    conn: { ...ms, secrets: { password: ms.password }, database: 'master', mssql: { auth: 'sql', encrypt: true, trustServerCertificate: true } },
    setup: `if object_id('dbo.t') is not null drop table dbo.t;\ncreate table dbo.t (id int primary key, name nvarchar(20), price decimal(10,2), data varbinary(10), created datetime2);\ninsert into dbo.t values (1,N'a',1.5,0xDEAD,'2026-01-02 03:04:05'),(2,N'b',null,null,null)`,
    slow: `waitfor delay '00:00:30'`,
    typesSql: `select id, id, name, price, data, created from dbo.t order by 1`,
  });

const sessions: Session[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
});

for (const c of cases) {
  describe(`driver: ${c.driver}`, () => {
    let s: Session;
    it('connects and reports a version', async () => {
      s = await load(c.driver).open({ id: 't', name: 't', driver: c.driver, secrets: {}, ...(c.conn as any) });
      sessions.push(s);
      expect(await s.serverVersion()).toMatch(/\d/);
    });
    it('runs several statements in order, with affected rows', async () => {
      const r = await run(s, c.setup, c.driver);
      expect(r.length).toBeGreaterThan(0);
      const last = r[r.length - 1];
      expect(last.hasRows).toBe(false);
      if (c.driver !== 'duckdb') expect(last.affected).toBe(2);
    });
    it('returns typed rows, duplicate column names and nulls', async () => {
      const [r] = await run(s, c.typesSql, c.driver);
      expect(r.hasRows).toBe(true);
      expect(r.columns[0].name).toBe(r.columns[1].name);
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0][0]).toBe(1);
      expect(r.rows[0][2]).toBe('a');
      expect(r.columns[3].kind).toBe('number');
      expect(r.rows[1][3]).toBeNull();
      expect(r.rows[0][4]).toEqual({ $bin: 'dead', len: 2 });
      const all = JSON.stringify(r.rows[0]);
      if (c.driver === 'mysql' || c.driver === 'postgres') expect(r.rows[0][5]).toEqual({ k: 1 });
      if (c.driver === 'mysql' || c.driver === 'mssql') expect(all).toContain('2026-01-02 03:04:05');
      if (c.driver === 'postgres') expect(r.rows[0][7]).toBe('9007199254740993');
      if (c.driver === 'duckdb') {
        expect(r.rows[0][5]).toEqual([1, 2]);
        expect(r.rows[0][6]).toEqual({ x: 1 });
        expect(String(r.rows[0][7])).toContain('2026-01-02 03:04:05');
      }
    });
    it('stops at the row limit', async () => {
      const [r] = await run(s, c.typesSql, c.driver, 1);
      expect(r.rows).toHaveLength(1);
      expect(r.truncated).toBe(true);
    });
    it('reports which statement failed', async () => {
      await expect(run(s, `select 1; select * from no_such_table_x;`, c.driver)).rejects.toMatchObject({ statementIndex: c.driver === 'mssql' ? 0 : 1 });
    });
    it('lists schema', async () => {
      const containers = await s.listContainers();
      const def = await s.defaultContainer();
      const container = c.driver === 'mysql' ? 'sqlnb_test' : def;
      if (c.driver === 'mysql') expect(containers).toContain('sqlnb_test');
      const tables = await s.listTables(container);
      expect(tables.map((t) => t.name)).toContain('t');
      const cols = await s.listColumns('t', container);
      expect(cols[0]).toMatchObject({ name: 'id', pk: true });
    });
    it('explains a query', async () => {
      const plan = await s.explain(c.driver === 'mssql' ? 'select 1' : 'select * from t where id = 1');
      if (c.driver !== 'mssql') expect(plan && plan.length).toBeGreaterThan(0);
    });
    it('can be stopped and keeps working', async () => {
      const t0 = Date.now();
      const p = run(s, c.slow, c.driver).then(
        () => undefined,
        (e) => e,
      );
      await new Promise((r) => setTimeout(r, 800));
      await s.cancel();
      expect(await p).toBeInstanceOf(Error);
      expect(Date.now() - t0).toBeLessThan(15000);
      const [r] = await run(s, 'select 1 as one', c.driver);
      expect(r.rows[0][0]).toBe(1);
    });
  });
}

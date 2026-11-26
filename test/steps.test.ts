// Query Steps: planning (no database) and running on SQLite and DuckDB (built drivers in dist/).

import { describe, expect, it, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DriverId, ResolvedConnection, Session } from '../src/db/types';
import type { QueryStep } from '../shared/protocol';
import { isSelect } from '../shared/protocol';
import { linesIn, planQuerySteps, render, runQuerySteps, scan, type StepPlan } from '../src/db/steps';
import { splitStatements } from '../src/db/splitter';
import { pickSelect } from '../src/notebook/querySteps';

const plan = (sql: string, driver = 'sqlite') => planQuerySteps(sql, driver);
const kinds = (sql: string, driver = 'sqlite') => {
  const p = plan(sql, driver);
  if ('error' in p) throw new Error(p.error);
  return p.steps.map((s) => `${s.kind}:${s.clause}`);
};
const error = (sql: string, driver = 'sqlite') => {
  const p = plan(sql, driver);
  return 'error' in p ? p.error : undefined;
};

const DEMO = `SELECT c.name, COUNT(*) AS orders
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 'paid'
GROUP BY c.name
HAVING COUNT(*) >= 2
ORDER BY orders DESC
LIMIT 3`;

describe('planQuerySteps', () => {
  it('lists the clauses in the order the database applies them', () => {
    expect(kinds(DEMO)).toEqual(['from:FROM', 'join:JOIN', 'where:WHERE', 'group:GROUP BY', 'having:HAVING', 'select:SELECT', 'order:ORDER BY', 'limit:LIMIT']);
  });

  it('keeps the join type and adds DISTINCT as its own step', () => {
    expect(kinds('select distinct o.status from orders o left join customers c on c.id = o.customer_id')).toEqual([
      'from:FROM',
      'join:LEFT JOIN',
      'select:SELECT',
      'distinct:DISTINCT',
    ]);
  });

  it('treats SQL Server TOP as the last step', () => {
    expect(kinds('select top 5 id from orders where amount > 10 order by amount desc', 'mssql')).toEqual(['from:FROM', 'where:WHERE', 'select:SELECT', 'order:ORDER BY', 'limit:TOP']);
  });

  it('reads SQL Server OFFSET ... FETCH, TOP WITH TIES and CROSS APPLY', () => {
    expect(kinds('select name from customers order by name offset 1 rows fetch next 2 rows only', 'mssql').at(-1)).toBe('limit:OFFSET');
    expect(kinds('select top 2 with ties name from customers order by city', 'mssql').at(-1)).toBe('limit:TOP');
    expect(kinds('select c.name, x.amount from customers c cross apply (select top 1 amount from orders o where o.customer_id = c.id) x', 'mssql')).toEqual([
      'from:FROM',
      'join:CROSS APPLY',
      'select:SELECT',
    ]);
  });

  it('refuses SELECT ... INTO, FOR UPDATE and SQL Server lock hints', () => {
    expect(error('select * into customers_copy from customers', 'mssql')).toMatch(/uses INTO/);
    expect(error('select name from customers for update', 'postgres')).toMatch(/uses UPDATE/);
    expect(error('select name from customers with (updlock) where id = 1', 'mssql')).toMatch(/uses UPDLOCK/);
    expect(error('select name from customers with (tablockx, holdlock)', 'mssql')).toMatch(/uses TABLOCKX/);
    expect(error('select name from customers with (nolock)', 'mssql')).toBeUndefined();
  });

  it('handles a WITH before the SELECT', () => {
    const p = plan(`with paid as (select * from orders where status = 'paid') select customer_id from paid where amount > 5`);
    if ('error' in p) throw new Error(p.error);
    expect(p.prefix).toMatch(/^with paid as/i);
    expect(p.steps.map((s) => s.kind)).toEqual(['from', 'where', 'select']);
  });

  it('ignores keywords inside strings, quoted names and comments', () => {
    expect(kinds(`select "where", 'from x where y' as s -- group by\nfrom orders /* order by */ where note <> 'limit 1'`)).toEqual([
      'from:FROM',
      'where:WHERE',
      'select:SELECT',
    ]);
  });

  it('reads MySQL # comments as comments', () => {
    expect(kinds('select a, count(*) from t # drop old ones\nwhere a > 1 # keep big\ngroup by a', 'mysql')).toEqual(['from:FROM', 'where:WHERE', 'group:GROUP BY', 'select:SELECT']);
    const p = planQuerySteps('select * from t\nwhere a > 1 # keep big', 'mysql') as StepPlan;
    const removed = p.steps.find((x) => x.kind === 'where')!.removed!.sample[0];
    expect(render(p.prefix, removed, 'mysql', 51)).not.toContain('#');
  });

  it('turns a comma join into a join step', () => {
    expect(kinds('select * from orders o, customers c where c.id = o.customer_id')).toEqual(['from:FROM', 'join:, (comma join)', 'where:WHERE', 'select:SELECT']);
  });

  it('refuses anything that is not a single read-only SELECT', () => {
    expect(error('update orders set amount = 0')).toMatch(/SELECT/);
    expect(error('select * into backup from orders')).toMatch(/only runs queries that read data/);
    expect(error('select 1 union select 2')).toMatch(/UNION/);
    expect(error('select 1')).toMatch(/does not read from a table/);
    expect(error('(select * from orders)')).toMatch(/brackets/);
    expect(error('select * from orders where id in (select nextval(\'s\'))', 'postgres')).toMatch(/NEXTVAL/);
  });

  it('caps rows with LIMIT, or TOP on SQL Server', () => {
    const q = { list: '*', body: 'FROM t' };
    expect(render('', q, 'sqlite', 51)).toBe('SELECT *\nFROM t\nLIMIT 51');
    expect(render('', q, 'mssql', 51)).toBe('SELECT TOP (51) *\nFROM t');
  });

  it('maps each clause back to its lines', () => {
    const p = plan(DEMO) as StepPlan;
    expect(p.steps.map((s) => linesIn(DEMO, s.span))).toEqual([[1], [2], [3], [4], [5], [0], [6], [7]]);
  });

  it('keeps comments out of the code it copies, at the same length', () => {
    const sql = "select 1 -- x\nfrom t where a = 'b'";
    const { clean, m } = scan(sql, 'sqlite');
    expect(clean.length).toBe(sql.length);
    expect(m.length).toBe(sql.length);
    expect(clean).not.toContain('-- x');
    expect(m).not.toContain("'b'");
  });
});

describe('picking the statement', () => {
  it('finds the SELECT under the cursor, else the first', () => {
    const text = 'create table t(x int);\nselect 1 from t;\nselect 2 from t;';
    const st = splitStatements(text, 'sqlite');
    expect(pickSelect(st)?.sql).toMatch(/select 1/);
    expect(pickSelect(st, text.indexOf('select 2') + 3)?.sql).toMatch(/select 2/);
    expect(isSelect('-- note\nWITH x AS (select 1) select * from x')).toBe(true);
    expect(isSelect('insert into t values (1)')).toBe(false);
  });
});

// ---------- Running on real databases ----------

const require = createRequire(import.meta.url);
const dist = path.resolve(__dirname, '..', 'dist');
const load = (d: DriverId) => require(path.join(dist, 'drivers', `${d}.js`)) as { open(c: ResolvedConnection): Promise<Session> };
const sessions: Session[] = [];
afterAll(async () => {
  for (const s of sessions) await s.close().catch(() => undefined);
});

const SETUP = [
  'create table customers (id integer primary key, name varchar(20), city varchar(20))',
  "insert into customers values (1,'Asha','Pune'),(2,'Ben','Leeds'),(3,'Chen','Pune'),(4,'Dara','Oslo')",
  'create table orders (id integer primary key, customer_id integer, amount decimal(10,2), status varchar(10))',
  "insert into orders values (1,1,20,'paid'),(2,1,35,'paid'),(3,2,12,'refunded'),(4,3,50,'paid'),(5,3,8,'paid'),(6,3,15,'paid'),(7,9,99,'paid'),(8,2,40,'paid')",
];

async function steps(s: Session, driver: DriverId, sql: string, sampleRows = 50) {
  const p = planQuerySteps(sql, driver);
  if ('error' in p) throw new Error(p.error);
  const updates: number[] = [];
  const out = await runQuerySteps(s, p, driver, {
    sampleRows,
    linesOf: (span) => linesIn(sql, span),
    onUpdate: (st) => updates.push(st.filter((x) => x.status === 'done').length),
    stopped: () => false,
  });
  return { out, updates };
}
const counts = (st: QueryStep[]) => st.map((s) => `${s.clause}=${s.rows}${s.removed !== undefined ? `(-${s.removed})` : ''}`);

// MySQL, PostgreSQL and SQL Server run too when SQLNB_MYSQL / SQLNB_PG / SQLNB_MSSQL point at a test server (host:port:user:password).
function server(env: string | undefined) {
  if (!env) return undefined;
  const [host, port, user, ...pw] = env.split(':');
  return { host, port: Number(port), user, secrets: { password: pw.join(':') } };
}
const targets: { driver: DriverId; conn: Partial<ResolvedConnection>; before?: string[] }[] = [
  { driver: 'sqlite', conn: { file: ':memory:' } },
  { driver: 'duckdb', conn: { file: ':memory:' } },
];
const my = server(process.env.SQLNB_MYSQL);
if (my) targets.push({ driver: 'mysql', conn: { ...my, database: 'sqlnb_steps' }, before: ['create database if not exists sqlnb_steps'] });
const pgc = server(process.env.SQLNB_PG);
if (pgc) targets.push({ driver: 'postgres', conn: { ...pgc, database: 'postgres' } });
const ms = server(process.env.SQLNB_MSSQL);
if (ms) targets.push({ driver: 'mssql', conn: { ...ms, database: 'master', mssql: { auth: 'sql', encrypt: true, trustServerCertificate: true } } as Partial<ResolvedConnection> });

const exec = (s: Session, sql: string) => s.run([sql], { maxRows: 10, onStart: () => undefined, onResult: () => undefined });

for (const { driver, conn, before } of targets) {
  // SQL Server has TOP, not LIMIT.
  const demo = driver === 'mssql' ? DEMO.replace(/^SELECT /, 'SELECT TOP 3 ').replace(/\nLIMIT 3$/, '') : DEMO;
  describe(`Query Steps on ${driver}`, () => {
    let s: Session;
    it('sets up', async () => {
      const open = (c: Partial<ResolvedConnection>) => load(driver).open({ id: 't', name: 't', driver, secrets: {}, ...c } as ResolvedConnection);
      if (before) {
        const first = await open({ ...conn, database: undefined });
        for (const sql of before) await exec(first, sql);
        await first.close();
      }
      s = await open(conn);
      sessions.push(s);
      if (driver !== 'sqlite' && driver !== 'duckdb') for (const t of ['orders', 'customers']) await exec(s, `drop table if exists ${t}`);
      for (const sql of SETUP) await exec(s, sql);
    });

    it('shows the rows after each clause, and the rows each one removed', async () => {
      const { out, updates } = await steps(s, driver, demo);
      expect(out.every((x) => x.status === 'done')).toBe(true);
      expect(counts(out)).toEqual(['FROM=8', 'JOIN=7(-1)', 'WHERE=6(-1)', 'GROUP BY=3', 'HAVING=2(-1)', 'SELECT=2', 'ORDER BY=2', `${driver === 'mssql' ? 'TOP' : 'LIMIT'}=2(-0)`]);
      // The order with no customer is the row the JOIN dropped; the refund is the one WHERE dropped.
      expect(out[1].removedRows!.rows).toHaveLength(1);
      expect(out[1].removedRows!.rows[0]).toContain(99);
      expect(out[2].removedRows!.rows[0]).toContain('refunded');
      expect(out[3].unit).toBe('groups');
      expect(out[4].removedRows!.rows[0]).toContain('Ben');
      // The last step is the query's own result, best first.
      expect(out.at(-1)!.sample!.rows.map((r) => r[0])).toEqual(['Chen', 'Asha']);
      expect(out.every((x) => x.detail && x.sql)).toBe(true);
      expect(updates.at(-1)).toBe(out.length);
    });

    it('keeps unmatched rows on a LEFT JOIN and shows them', async () => {
      const { out } = await steps(s, driver, 'select c.name, o.amount from customers c left join orders o on o.customer_id = c.id');
      expect(out[1].rows).toBe(8);
      expect(out[1].removedLabel).toMatch(/kept, with NULLs/);
      expect(out[1].removedRows!.rows.map((r) => r[1])).toEqual(['Dara']);
    });

    it('marks more rows than it shows', async () => {
      const { out } = await steps(s, driver, 'select * from orders', 3);
      expect(out[0].rows).toBe(8);
      expect(out[0].sample!.rows).toHaveLength(3);
      expect(out[0].sample!.more).toBe(true);
    });

    it('removes duplicates as its own step', async () => {
      const { out } = await steps(s, driver, 'select distinct city from customers');
      expect(counts(out)).toEqual(['FROM=4', 'SELECT=4', 'DISTINCT=3(-1)']);
    });

    it('shows an error on the step that failed and keeps going', async () => {
      const { out } = await steps(s, driver, 'select * from orders where no_such_column = 1');
      expect(out[0].status).toBe('done');
      expect(out[1].status).toBe('error');
      expect(out[1].error).toBeTruthy();
    });

    it('stops when asked', async () => {
      const p = planQuerySteps(demo, driver) as StepPlan;
      const out = await runQuerySteps(s, p, driver, { sampleRows: 50, linesOf: () => [], onUpdate: () => undefined, stopped: () => true });
      expect(out.every((x) => x.status === 'error' && x.error === 'Stopped.')).toBe(true);
    });

    it('does not change the data', async () => {
      const [r] = await new Promise<any[]>((res) => {
        const got: any[] = [];
        void s.run(['select count(*) from orders'], { maxRows: 1, onStart: () => undefined, onResult: (x) => got.push(x) }).then(() => res(got));
      });
      expect(Number(r.rows[0][0])).toBe(8);
    });
  });
}

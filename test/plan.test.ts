import { describe, expect, it } from 'vitest';
import { columnsIn, mask, planSteps, shape, PLAN_DRIVERS } from '../src/db/plan';
import { pickStatement } from '../src/notebook/runOrder';
import { splitStatements } from '../src/db/splitter';
import fx from './fixtures/plans.json';

type Fx = Record<'sqlite' | 'duckdb', Record<string, unknown>> & { sql: Record<string, string> };
const F = fx as unknown as Fx;

/** "kind:title@lines(1-based)" per step, which is what the user sees. */
function summary(driver: string, raw: unknown, sql: string) {
  return planSteps(driver, raw, sql).steps.map((s) => `${s.kind}:${s.title}@${s.lines.map((l) => l + 1).join(',')}`);
}

const DEMO = F.sql.demo;

describe('SQLite plans', () => {
  it('demo: reads, joins, then groups, sorts and limits, in that order', () => {
    expect(summary('sqlite', F.sqlite.demo, DEMO)).toEqual([
      'scan:Read orders@3,4',
      'scan:Read customers@2',
      'join:Join orders + customers@3',
      'group:Group by c.name@5',
      'select:Pick columns@1',
      'sort:Sort by orders DESC@6',
      'limit:Keep first 10@7',
    ]);
    const { steps, written } = planSteps('sqlite', F.sqlite.demo, DEMO);
    expect(written).toEqual(['SELECT', 'FROM', 'JOIN', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT']);
    expect(steps[2].inputs).toEqual([1, 2]);
    expect(steps[2].detail).toContain('o.customer_id = c.id');
    // SELECT and LIMIT are not rows in SQLite's plan, so they are marked.
    expect(steps.filter((s) => s.inferred).map((s) => s.kind)).toEqual(['select', 'limit']);
  });

  it('cte: the CTE runs first and is read back under its own name', () => {
    expect(summary('sqlite', F.sqlite.cte, F.sql.cte)).toEqual([
      'scan:Read orders@3',
      'group:Group by customer_id@4',
      'scan:Read big@7,9',
      'scan:Read customers@8',
      'join:Join big + customers@8',
      'select:Pick columns@6',
      'sort:Sort by b.total DESC@10',
    ]);
    expect(planSteps('sqlite', F.sqlite.cte, F.sql.cte).steps[2].inputs).toEqual([2]);
  });

  it('union: the subquery feeds the first branch, then both branches combine', () => {
    const { steps } = planSteps('sqlite', F.sqlite.union, F.sql.union);
    expect(steps.map((s) => s.kind)).toEqual(['scan', 'scan', 'scan', 'combine']);
    expect(steps[3].inputs).toEqual([2, 3]);
    expect(steps[3].lines).toEqual([2]);
  });

  it('delete: reads the rows, then deletes them', () => {
    expect(summary('sqlite', F.sqlite.del, F.sql.del)).toEqual(['scan:Read orders@1,2', 'write:Delete from orders@1']);
  });
});

describe('DuckDB plans', () => {
  it('demo: carries row estimates and folds ORDER BY + LIMIT into Top N', () => {
    const { steps } = planSteps('duckdb', F.duckdb.demo, DEMO);
    expect(steps.map((s) => s.title)).toEqual([
      'Read customers',
      'Read orders',
      'Join customers + orders',
      'Group by c.name',
      'Pick columns',
      'Top 10 by orders DESC',
    ]);
    expect(steps.map((s) => s.rows)).toEqual([50000, 240000, 240000, 33166, 33166, 10]);
    expect(steps[5].lines).toEqual([5, 6]);
    expect(steps.some((s) => s.inferred && s.kind !== 'select')).toBe(false);
  });

  it('cte: the outer WHERE on the CTE becomes its own filter step', () => {
    expect(summary('duckdb', F.duckdb.cte, F.sql.cte)).toEqual([
      'scan:Read orders@3',
      'group:Group by customer_id@4',
      'filter:Keep matching rows@9',
      'scan:Read customers@8',
      'join:Join big + customers@8',
      'select:Pick columns@6',
      'sort:Sort by b.total DESC@10',
    ]);
  });

  it('union: IN (subquery) is a semi join named in plain words', () => {
    const { steps } = planSteps('duckdb', F.duckdb.union, F.sql.union);
    expect(steps[2].title).toBe('Keep customers found in orders');
    expect(steps[2].detail).toMatch(/has a match in orders/);
    expect(steps.at(-1)!.kind).toBe('combine');
  });

  it('EMPTY_RESULT says no row can match', () => {
    const raw = [
      {
        name: 'PROJECTION',
        children: [{ name: 'EMPTY_RESULT', children: [], extra_info: {} }],
        extra_info: { Projections: ['name'], 'Estimated Cardinality': '0' },
      },
    ];
    const { steps } = planSteps('duckdb', raw, "SELECT name FROM customers WHERE 1 = 0");
    expect(steps[0].title).toBe('Skip: no row can match');
  });

  it('accepts the plan as a JSON string', () => {
    expect(planSteps('duckdb', JSON.stringify(F.duckdb.del), F.sql.del).steps.length).toBe(2);
  });
});

describe('PostgreSQL plans', () => {
  const scan = (table: string, alias: string, rows: number, extra: Record<string, unknown> = {}) => ({
    'Node Type': 'Seq Scan',
    'Relation Name': table,
    Alias: alias,
    'Plan Rows': rows,
    ...extra,
  });

  it('hash join: the hashed side is read first, Hash and Limit nodes map right', () => {
    const raw = [
      {
        Plan: {
          'Node Type': 'Limit',
          'Plan Rows': 10,
          Plans: [
            {
              'Node Type': 'Sort',
              'Plan Rows': 950,
              'Sort Key': ['(count(*)) DESC'],
              Plans: [
                {
                  'Node Type': 'HashAggregate',
                  'Plan Rows': 950,
                  'Group Key': ['c.name'],
                  Plans: [
                    {
                      'Node Type': 'Hash Join',
                      'Join Type': 'Inner',
                      'Plan Rows': 4000,
                      'Hash Cond': '(o.customer_id = c.id)',
                      Plans: [
                        scan('orders', 'o', 4000, { Filter: "(created_at > '2025-12-01'::date)" }),
                        { 'Node Type': 'Hash', 'Plan Rows': 1000, Plans: [scan('customers', 'c', 1000)] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ];
    const { steps } = planSteps('postgres', raw, DEMO);
    expect(steps.map((s) => s.kind)).toEqual(['scan', 'scan', 'join', 'group', 'select', 'sort', 'limit']);
    expect(steps[0].title).toBe('Read customers');
    expect(steps[1].title).toBe('Read orders');
    expect(steps[1].lines).toEqual([2, 3]); // FROM-JOIN line and the WHERE that filters it
    expect(steps[2].inputs).toEqual([1, 2]);
    expect(steps.map((s) => s.rows)).toEqual([1000, 4000, 4000, 950, 950, 950, 10]);
    expect(steps.find((s) => s.kind === 'limit')!.inferred).toBeFalsy();
    expect(steps.find((s) => s.kind === 'limit')!.lines).toEqual([6]);
  });

  it('bitmap heap scan: names the index found under it', () => {
    const raw = [
      {
        Plan: {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'customers',
          Alias: 'customers',
          'Plan Rows': 120,
          'Recheck Cond': "(city = 'Pune'::text)",
          Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'customers_city_idx', 'Plan Rows': 120 }],
        },
      },
    ];
    const { steps } = planSteps('postgres', raw, F.sql.filter);
    expect(steps[0].title).toBe('Read customers');
    expect(steps[0].detail).toContain('customers_city_idx');
    expect(steps[0].lines).toContain(2); // the WHERE city = 'Pune' line
  });

  it('nested loop with an index scan on the inner side', () => {
    const raw = {
      Plan: {
        'Node Type': 'Nested Loop',
        'Join Type': 'Inner',
        'Plan Rows': 50,
        Plans: [
          scan('orders', 'o', 50, { Filter: "(created_at > '2025-12-01'::date)" }),
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'customers',
            Alias: 'c',
            'Index Name': 'customers_pkey',
            'Index Cond': '(id = o.customer_id)',
            'Plan Rows': 1,
          },
        ],
      },
    };
    const sql = "SELECT c.name\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nWHERE o.created_at > '2025-12-01'";
    const { steps } = planSteps('postgres', raw, sql);
    expect(steps.map((s) => s.title)).toEqual(['Read orders', 'Read customers', 'Join orders + customers', 'Pick columns']);
    expect(steps[1].detail).toContain('customers_pkey');
    expect(steps[2].detail).toContain('c.id = o.customer_id');
  });
});

describe('Reading the SQL', () => {
  it('mask blanks strings and comments but keeps length and newlines', () => {
    const sql = "select 'a -- b' -- where\nfrom t /* join */ where x = $$ order by $$";
    const m = mask(sql);
    expect(m.length).toBe(sql.length);
    expect(m.split('\n').length).toBe(2);
    expect(m).not.toMatch(/where\n|join|order by/);
    expect(m).toMatch(/where x =/);
  });

  it('shape finds the CTE as its own named block', () => {
    const sh = shape(F.sql.cte);
    expect(sh.blocks.some((b) => b.name === 'big')).toBe(true);
    expect(sh.refs.map((r) => r.name)).toEqual(expect.arrayContaining(['orders', 'big', 'customers']));
  });

  it('columnsIn ignores literals, casts, keywords and function calls', () => {
    expect(columnsIn("(o.created_at > '2025-12-01'::date)")).toEqual(['created_at']);
    expect(columnsIn('((count(*)) > 5) AND (city IS NOT NULL)')).toEqual(['city']);
  });

  it('only PostgreSQL, SQLite and DuckDB are planned', () => {
    expect([...PLAN_DRIVERS].sort()).toEqual(['duckdb', 'postgres', 'sqlite']);
  });
});

describe('pickStatement', () => {
  const cell = 'create table t(a int);\nselect * from t;\n-- a note\nupdate t set a = 1;\nvacuum;';
  const stmts = splitStatements(cell, 'sqlite');

  it('takes the statement under the cursor', () => {
    expect(pickStatement(stmts, cell.indexOf('update') + 3)?.sql).toMatch(/^(-- a note\n)?update/);
  });

  it('skips DDL and session commands and falls back to the first query', () => {
    expect(pickStatement(stmts, 3)?.sql).toMatch(/^select/);
    expect(pickStatement(stmts, cell.indexOf('vacuum') + 2)?.sql).toMatch(/^select/);
    expect(pickStatement(stmts)?.sql).toMatch(/^select/);
  });

  it('returns nothing when no statement can be planned', () => {
    expect(pickStatement(splitStatements('vacuum;\ncreate index i on t(a);', 'sqlite'))).toBeUndefined();
  });
});

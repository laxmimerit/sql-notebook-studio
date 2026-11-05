import { describe, expect, it } from 'vitest';
import { useIn, whereFromUse } from '../src/schema/where';

const use = (sql: string, driver: 'mssql' | 'mysql' = 'mssql') => { const w = useIn(sql, driver); return w?.database ?? w?.container; };

describe('lastUse', () => {
  it('finds the database of a USE statement', () => {
    expect(use('USE MyDatabase;\nSELECT * FROM cu')).toBe('MyDatabase');
    expect(use('use salesdb')).toBe('salesdb');
  });
  it('takes the last USE', () => {
    expect(use('USE a;\nSELECT 1;\nUSE b;\nSELECT * FROM t')).toBe('b');
  });
  it('unquotes [x], `x` and "x"', () => {
    expect(use('USE [My Data]]x];')).toBe('My Data]x');
    expect(use('USE `shop db`;', 'mysql')).toBe('shop db');
    expect(use('USE "x";')).toBe('x');
  });
  it('skips comments before USE', () => {
    expect(use('-- switch\n/* now */ USE Reports;')).toBe('Reports');
  });
  it('sees a USE after a #temp table on SQL Server', () => {
    expect(use('SELECT * INTO #t FROM a; USE Other;')).toBe('Other');
  });
  it('ignores USE inside other statements and strings', () => {
    expect(use("SELECT 'USE x' AS s;")).toBeUndefined();
    expect(use('SELECT * FROM users;')).toBeUndefined();
  });
});

describe('whereFromUse', () => {
  it('maps USE to a database on SQL Server and a container on MySQL', () => {
    expect(whereFromUse('mssql', 'MyDatabase')).toEqual({ database: 'MyDatabase', container: 'dbo' });
    expect(whereFromUse('mysql', 'shop')).toEqual({ container: 'shop' });
    expect(whereFromUse('postgres', 'x')).toBeUndefined();
  });
});

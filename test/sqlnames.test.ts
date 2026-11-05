import { describe, expect, it } from 'vitest';
import { createdTables, quoter, splitName, tableRefs } from '../src/ai/sqlnames';

describe('splitName', () => {
  it('splits and unquotes', () => {
    expect(splitName('persons')).toEqual(['persons']);
    expect(splitName('MyDatabase.dbo.persons')).toEqual(['MyDatabase', 'dbo', 'persons']);
    expect(splitName('[My Data].[dbo].[a]]b]')).toEqual(['My Data', 'dbo', 'a]b']);
    expect(splitName('`shop`.`order items`')).toEqual(['shop', 'order items']);
    expect(splitName('"public"."Persons"')).toEqual(['public', 'Persons']);
  });
});

describe('quoter', () => {
  it('quotes per dialect', () => {
    expect(quoter('mssql')('a]b')).toBe('[a]]b]');
    expect(quoter('mysql')('a`b')).toBe('`a``b`');
    expect(quoter('postgres')('a"b')).toBe('"a""b"');
  });
});

describe('tableRefs', () => {
  it('finds the tables a query uses', () => {
    expect(tableRefs("INSERT INTO MyDatabase.dbo.persons (id, person_name) VALUES (1, 'from x')")).toEqual(['MyDatabase.dbo.persons']);
    expect(tableRefs('SELECT * FROM persons p JOIN [dbo].[orders] o ON o.pid = p.id')).toEqual(['persons', '[dbo].[orders]']);
  });
  it('leaves out aliases, CTEs, temp tables, created tables, functions and system views', () => {
    expect(tableRefs('UPDATE p SET name = 1 FROM persons p')).toEqual(['persons']);
    expect(tableRefs('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent')).toEqual(['orders']);
    expect(tableRefs('SELECT * INTO #t FROM persons; SELECT * FROM #t')).toEqual(['persons']);
    expect(tableRefs('CREATE TABLE t1 (id int); INSERT INTO t1 VALUES (1)')).toEqual([]);
    expect(tableRefs('SELECT * FROM sys.tables; SELECT * FROM INFORMATION_SCHEMA.COLUMNS')).toEqual([]);
    expect(tableRefs("SELECT value FROM STRING_SPLIT('a,b', ',')")).toEqual([]);
    expect(tableRefs('SELECT * FROM dbo.fnRows(3)')).toEqual([]);
  });
  it('leaves out tables created by SQL checked before', () => {
    expect(tableRefs('SELECT * FROM MyDatabase.dbo.orders o JOIN persons p ON 1=1', ['orders'])).toEqual(['persons']);
  });
});

describe('createdTables', () => {
  it('finds created tables and views', () => {
    expect(createdTables('CREATE TABLE MyDatabase.dbo.Orders (id int); CREATE OR REPLACE VIEW v AS SELECT 1; create temp table if not exists `t`(x int)')).toEqual(['orders', 'v', 't']);
  });
});

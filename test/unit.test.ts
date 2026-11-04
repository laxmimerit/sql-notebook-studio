import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/db/splitter';
import { parseNotebook, serializeNotebook, cellsFromSqlFile } from '../src/notebook/format';
import { parseConnectionString } from '../src/connections/connString';
import { classify } from '../src/db/safety';
import { formatDate, kindFromType, toCell } from '../src/db/values';
import { findVariables, substitute, resolveEnv } from '../src/util/variables';
import { extractSql, stripThinking } from '../src/ai/prompts';
import { EXTRA, KEYWORDS, applyCase, keywordCase } from '../src/schema/keywords';
import { ENDS_WORD, dialectWords, wordToCapitalise } from '../src/schema/autoCase';

const sqls = (text: string, d: Parameters<typeof splitStatements>[1]) => splitStatements(text, d).map((s) => s.sql);

describe('splitter', () => {
  it('splits simple statements and keeps lines', () => {
    const r = splitStatements('select 1;\n\nselect 2;\n-- trailing comment', 'mysql');
    expect(r.map((s) => s.sql)).toEqual(['select 1', 'select 2']);
    expect(r[1].line).toBe(2);
  });
  it('ignores semicolons in strings, identifiers and comments', () => {
    expect(sqls(`select 'a;b', "c;d", \`e;f\` -- x;y\n; /* ; */ select 2`, 'mysql')).toEqual([`select 'a;b', "c;d", \`e;f\` -- x;y`, '/* ; */ select 2']);
  });
  it('handles escaped quotes', () => {
    expect(sqls(`select 'it''s; fine'; select 'a\\';b'`, 'mysql')).toEqual([`select 'it''s; fine'`, `select 'a\\';b'`]);
  });
  it('handles PostgreSQL dollar quotes', () => {
    const fn = `create function f() returns int as $$ begin return 1; end; $$ language plpgsql`;
    expect(sqls(`${fn}; select $1::int;`, 'postgres')).toEqual([fn, 'select $1::int']);
    expect(sqls(`do $body$ begin perform 1; end $body$; select 2`, 'postgres')).toHaveLength(2);
  });
  it('handles MySQL DELIMITER', () => {
    const text = `DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();`;
    expect(sqls(text, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
  });
  it('handles MySQL compound statements without DELIMITER', () => {
    const text = `CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END; SELECT 3;`;
    expect(sqls(text, 'mysql')).toEqual([`CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; SELECT CASE WHEN 1 THEN 2 END; END`, 'SELECT 3']);
  });
  it('keeps SQLite triggers whole', () => {
    const trg = `CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET n = n + 1; INSERT INTO c VALUES (1); END`;
    expect(sqls(`${trg}; SELECT 1;`, 'sqlite')).toEqual([trg, 'SELECT 1']);
  });
  it('splits SQL Server on GO', () => {
    expect(sqls(`select 1; select 2\nGO\nselect 3\ngo 2\n`, 'mssql')).toEqual(['select 1; select 2', 'select 3', 'select 3']);
  });
  it('treats # as a comment only in MySQL', () => {
    expect(sqls(`select 1 # note; x\n;`, 'mysql')).toEqual(['select 1 # note; x']);
    expect(sqls(`select '{"a":1}'::jsonb #> '{a}'; select 2`, 'postgres')).toHaveLength(2);
  });
  it('drops comment-only statements and handles CRLF', () => {
    expect(sqls('-- only a comment\r\n;\r\nselect 1;\r\n', 'sqlite')).toEqual(['select 1']);
  });
});

describe('notebook format', () => {
  it('round-trips cells, metadata and markdown', () => {
    const nb = {
      meta: { connection: 'Local', variables: { x: '1' } },
      cells: [
        { kind: 'md' as const, source: '# Title\n\nSome *text*', meta: {} },
        { kind: 'sql' as const, source: 'SELECT 1;\n\n\nSELECT 2;', meta: { connection: 'Other', chart: { type: 'bar', x: 'a', y: ['b'] } } },
        { kind: 'ai' as const, source: 'top customers', meta: {} },
      ],
    };
    const text = serializeNotebook(nb);
    expect(text.startsWith('-- sqlnb v1 {"connection":"Local"')).toBe(true);
    const back = parseNotebook(text);
    expect(back).toEqual(nb);
    expect(serializeNotebook(back)).toBe(text);
  });
  it('blank lines inside SQL never split a cell', () => {
    const back = parseNotebook('-- sqlnb v1\n-- %% sql\nselect 1\n\n\n\nfrom t\n-- %% sql\nselect 2\n');
    expect(back.cells.map((c) => c.source)).toEqual(['select 1\n\n\n\nfrom t', 'select 2']);
  });
  it('reads CRLF files and plain SQL files', () => {
    expect(parseNotebook('-- sqlnb v1\r\n-- %% sql\r\nselect 1\r\n').cells[0].source).toBe('select 1');
    expect(parseNotebook('select 1;\nselect 2;').cells).toHaveLength(1);
  });
  it('keeps saved outputs', () => {
    const text = serializeNotebook({ meta: {}, cells: [{ kind: 'sql', source: 'select 1', meta: {}, output: { v: 1, results: [] } }] });
    expect(parseNotebook(text).cells[0].output).toEqual({ v: 1, results: [] });
  });
});

describe('connection strings', () => {
  it('parses MySQL and PostgreSQL URLs', () => {
    const m = parseConnectionString('mysql://root:p%40ss@db.example.com:3307/shop?ssl=true');
    expect(m.config).toMatchObject({ driver: 'mysql', host: 'db.example.com', port: 3307, user: 'root', database: 'shop', ssl: { enabled: true } });
    expect(m.password).toBe('p@ss');
    const p = parseConnectionString('postgresql://u@localhost/app?sslmode=require');
    expect(p.config).toMatchObject({ driver: 'postgres', host: 'localhost', database: 'app', ssl: { enabled: true, rejectUnauthorized: false } });
  });
  it('parses SQL Server ADO strings', () => {
    const r = parseConnectionString('Server=tcp:srv.database.windows.net,1433;Initial Catalog=sales;User ID=me;Password=secret;Encrypt=True;TrustServerCertificate=False');
    expect(r.config).toMatchObject({ driver: 'mssql', host: 'srv.database.windows.net', port: 1433, database: 'sales', user: 'me', mssql: { auth: 'sql', encrypt: true, trustServerCertificate: false } });
    expect(r.password).toBe('secret');
    expect(parseConnectionString('Data Source=.\\SQLEXPRESS;Integrated Security=true').config).toMatchObject({ host: 'localhost', mssql: { auth: 'ntlm', instanceName: 'SQLEXPRESS' } });
  });
  it('parses file databases', () => {
    expect(parseConnectionString('sqlite:///C:/data/app.db').config).toEqual({ driver: 'sqlite', file: 'C:/data/app.db' });
    expect(parseConnectionString('D:\\x\\warehouse.duckdb').config).toEqual({ driver: 'duckdb', file: 'D:\\x\\warehouse.duckdb' });
  });
  it('rejects junk', () => {
    expect(() => parseConnectionString('hello')).toThrow();
  });
});

describe('safety', () => {
  it('flags writes and risky statements', () => {
    expect(classify('select * from t')).toEqual({ write: false, risk: undefined });
    expect(classify('insert into t values (1)').write).toBe(true);
    expect(classify('DELETE FROM t').risk).toBe('DELETE without WHERE');
    expect(classify('delete from t where id = 1').risk).toBeUndefined();
    expect(classify('update t set a = 1').risk).toBe('UPDATE without WHERE');
    expect(classify('-- x\nDROP TABLE users').risk).toBe('DROP TABLE users');
    expect(classify('truncate table t').risk).toBe('TRUNCATE');
    expect(classify('with x as (select 1) delete from t').risk).toBe('DELETE without WHERE');
  });
});

describe('values', () => {
  it('normalizes driver values', () => {
    expect(toCell(10n)).toBe(10);
    expect(toCell(9007199254740993n)).toBe('9007199254740993');
    expect(toCell(new Uint8Array([0xde, 0xad]))).toEqual({ $bin: 'dead', len: 2 });
    expect(toCell({ a: [1, 2n] })).toEqual({ a: [1, 2] });
    expect(toCell(undefined)).toBeNull();
    expect(formatDate(new Date(2026, 0, 2))).toBe('2026-01-02');
    expect(formatDate(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006');
  });
  it('maps types to kinds', () => {
    expect(kindFromType('BIGINT')).toBe('number');
    expect(kindFromType('decimal(10,2)')).toBe('number');
    expect(kindFromType('timestamptz')).toBe('date');
    expect(kindFromType('jsonb')).toBe('json');
    expect(kindFromType('INTEGER[]')).toBe('json');
    expect(kindFromType('varbinary')).toBe('binary');
    expect(kindFromType('varchar(20)')).toBe('string');
    expect(kindFromType('boolean')).toBe('bool');
  });
});

describe('variables and AI helpers', () => {
  it('finds and substitutes variables', () => {
    expect(findVariables("select {{a}}, {{ b.c }}, {{a}}")).toEqual(['a', 'b.c']);
    expect(substitute("x = '{{a}}' and {{missing}}", { a: '1' })).toBe("x = '1' and {{missing}}");
    process.env.SQLNB_TEST = 'v';
    expect(resolveEnv('p-${env:SQLNB_TEST}-${env:NOPE_X}')).toBe('p-v-');
  });
  it('extracts SQL and strips thinking', () => {
    expect(extractSql('Cause: x\n```sql\nselect 1;\n```\nand\n```sql\nselect 2;\n```')).toBe('select 2;');
    expect(extractSql('no code')).toBeUndefined();
    expect(stripThinking('<think>hmm</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('<think>still going')).toBe('');
  });
});

describe('opening .sql files', () => {
  const split = (t: string) => splitStatements(t, 'mysql').map((s) => s.sql);
  it('keeps cells and Markdown from the older SQL Notebook format', () => {
    const text = '/*markdown\n# Report\nSales by month\n*/\r\n\r\nselect 1;\nselect 2;\n\nselect 3\n\n/*markdown\nEnd\n*/';
    expect(cellsFromSqlFile(text, split)).toEqual([
      { kind: 'md', source: '# Report\nSales by month' },
      { kind: 'sql', source: 'select 1;\nselect 2;' },
      { kind: 'sql', source: 'select 3' },
      { kind: 'md', source: 'End' },
    ]);
  });
  it('makes one cell per statement for plain SQL', () => {
    expect(cellsFromSqlFile('select 1;\n\nselect 2', split)).toEqual([
      { kind: 'sql', source: 'select 1;' },
      { kind: 'sql', source: 'select 2;' },
    ]);
  });
});

describe('AI suggestions', () => {
  it('sends schema changes to a new cell', async () => {
    const { isSchemaChange } = await import('../shared/protocol');
    expect(isSchemaChange('CREATE INDEX i ON t(a);')).toBe(true);
    expect(isSchemaChange('-- add an index\nCREATE INDEX i ON t(a);')).toBe(true);
    expect(isSchemaChange('SELECT * FROM t WHERE a = 1')).toBe(false);
    expect(isSchemaChange('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
  });
});

describe('autocomplete keyword case', () => {
  it('is uppercase by default, whatever is typed', () => {
    expect(keywordCase('sel')).toBe('upper');
    expect(keywordCase('slt')).toBe('upper');
    expect(keywordCase('SEL')).toBe('upper');
  });
  it('follows what is typed in auto mode', () => {
    expect(keywordCase('sel', 'auto')).toBe('lower');
    expect(keywordCase('slt', 'auto')).toBe('lower');
    expect(keywordCase('SEL', 'auto')).toBe('upper');
    expect(keywordCase('Sel', 'auto')).toBe('upper');
    expect(keywordCase('', 'auto')).toBe('upper');
    expect(keywordCase('_', 'auto')).toBe('upper');
  });
  it('honours a fixed setting', () => {
    expect(keywordCase('sel', 'upper')).toBe('upper');
    expect(keywordCase('SEL', 'lower')).toBe('lower');
  });
  it('changes keywords but leaves mixed-case names alone', () => {
    expect(applyCase('GROUP BY', 'lower')).toBe('group by');
    expect(applyCase('SELECT', 'upper')).toBe('SELECT');
    expect(applyCase('read_csv', 'upper')).toBe('read_csv');
  });
  it('lists SELECT for every driver', () => {
    expect(KEYWORDS).toContain('SELECT');
    expect(Object.keys(EXTRA)).toEqual(['mysql', 'postgres', 'mssql', 'sqlite', 'duckdb']);
  });
});

describe('capitalise keywords as you type', () => {
  // The word that ends where the text ends, after typing `typed` there.
  const cap = (text: string, driver: Parameters<typeof wordToCapitalise>[2], typed = ' ', names: string[] = []) =>
    wordToCapitalise(text, text.length, driver, typed, new Set(names))?.upper;

  it('uses each database keyword list from sql-formatter', () => {
    expect(dialectWords('mssql').keywords.has('TOP')).toBe(true);
    expect(dialectWords('mysql').keywords.has('TOP')).toBe(false);
    expect(dialectWords('postgres').keywords.has('RETURNING')).toBe(true);
    expect(dialectWords('duckdb').keywords.has('QUALIFY')).toBe(true);
    for (const d of ['mysql', 'postgres', 'mssql', 'sqlite', 'duckdb'] as const) {
      expect(dialectWords(d).keywords.has('SELECT')).toBe(true);
      expect(dialectWords(d).keywords.has('CASE')).toBe(true);
    }
  });
  it('capitalises keywords of the connected database only', () => {
    expect(cap('select', 'mysql')).toBe('SELECT');
    expect(cap('select * from employees where', 'postgres')).toBe('WHERE');
    expect(cap('select top', 'mssql')).toBe('TOP');
    expect(cap('select top', 'mysql')).toBeUndefined();
    expect(cap('select * from t limit', 'sqlite')).toBe('LIMIT');
    expect(cap('select * from t limit', 'mssql')).toBeUndefined();
    expect(cap('insert into t values (1) returning', 'postgres')).toBe('RETURNING');
    expect(cap('select a from t qualify', 'duckdb')).toBe('QUALIFY');
    expect(cap('select * from t order by', 'mysql', '\n')).toBe('BY');
    expect(cap('select * from (select', 'mysql')).toBe('SELECT');
    expect(cap('select case when a then 1 else', 'mssql')).toBe('ELSE');
    expect(cap('drop table if', 'mysql')).toBe('IF');
    expect(cap('create view v as select', 'postgres')).toBe('SELECT');
  });
  it('capitalises functions and types only where they are used as such', () => {
    expect(cap('select count', 'mysql', '(')).toBe('COUNT');
    expect(cap('select count', 'mysql', '()')).toBe('COUNT');
    expect(cap('select count', 'mysql', ' ')).toBeUndefined();
    expect(cap('create table t (id int', 'mysql', ',')).toBe('INT');
    expect(cap('create table t (name varchar', 'postgres', '(')).toBe('VARCHAR');
  });
  it('never touches names the user chose', () => {
    expect(cap('select * from status', 'mysql')).toBeUndefined();
    expect(cap('select a as name', 'duckdb')).toBeUndefined();
    expect(cap('create table status', 'mysql')).toBeUndefined();
    expect(cap('create table t (status', 'mysql')).toBeUndefined();
    expect(cap('create table t (id int, type', 'postgres')).toBeUndefined();
    expect(cap('create table t (price decimal(10, 2), name', 'duckdb')).toBeUndefined();
    expect(cap('create table t (id int, primary', 'mysql')).toBe('PRIMARY');
    expect(cap('insert into t (name', 'duckdb', ',')).toBeUndefined();
    expect(cap('insert into t values (null', 'mysql', ',')).toBe('NULL');
    expect(cap('select e.order', 'mysql')).toBeUndefined();
    expect(cap('select @limit', 'mssql')).toBeUndefined();
    expect(cap('select * from t where :limit', 'postgres')).toBeUndefined();
    expect(cap('select * from #temp', 'mssql')).toBeUndefined();
    expect(cap('select key', 'postgres', ',', ['key', 'value'])).toBeUndefined();
    expect(cap('select my_select', 'mysql')).toBeUndefined();
  });
  it('leaves strings, comments, quoted names and variables alone', () => {
    expect(cap("select 'a select", 'mysql')).toBeUndefined();
    expect(cap("select 'it''s' from", 'sqlite')).toBe('FROM');
    expect(cap("select 'a\\' select", 'mysql')).toBeUndefined();
    expect(cap("select 'a\\' select", 'postgres')).toBe('SELECT');
    expect(cap('-- select', 'postgres')).toBeUndefined();
    expect(cap('# select', 'mysql')).toBeUndefined();
    expect(cap('/* select', 'mssql')).toBeUndefined();
    expect(cap('/* a */ select', 'mssql')).toBe('SELECT');
    expect(cap('/* a /* b */ select', 'postgres')).toBeUndefined();
    expect(cap('select "order', 'postgres')).toBeUndefined();
    expect(cap('select `order', 'mysql')).toBeUndefined();
    expect(cap('select [order', 'mssql')).toBeUndefined();
    expect(cap('select $$ begin select', 'postgres')).toBeUndefined();
    expect(cap('select $f$ x $f$ from', 'duckdb')).toBe('FROM');
    expect(cap('select {{ from', 'mysql')).toBeUndefined();
    expect(cap('SELECT', 'mysql')).toBeUndefined();
  });
  it('acts only on characters that end a word', () => {
    for (const t of [' ', '\t', ',', ';', ')', '(', '()', '\n', '\r\n', '\n    ']) expect(ENDS_WORD.test(t)).toBe(true);
    for (const t of ['a', '.', 'select ', '  ', "'", '=']) expect(ENDS_WORD.test(t)).toBe(false);
  });
});

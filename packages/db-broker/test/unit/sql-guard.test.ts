import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect, SqlGuardError } from '../../src/sql-guard.js';
import type { Engine } from '../../src/types.js';

const ENGINES: Engine[] = ['postgres', 'mysql', 'oracle'];

const accepts = (engine: Engine, sql: string) => expect(() => assertReadOnlySelect(sql, engine)).not.toThrow();
const rejects = (engine: Engine, sql: string, match?: RegExp) => {
  const run = () => assertReadOnlySelect(sql, engine);
  expect(run).toThrow(SqlGuardError);
  if (match) expect(run).toThrow(match);
};

describe.each(ENGINES)('sql-guard (%s): accepted queries', (engine) => {
  it('plain select', () => accepts(engine, 'SELECT id, name FROM customers WHERE id = 1'));
  it('trailing semicolon', () => accepts(engine, 'select 1 from dual;'));
  it('CTE', () => accepts(engine, 'WITH a AS (SELECT 1 x FROM t) SELECT x FROM a'));
  it('keywords inside string literals', () => accepts(engine, "SELECT * FROM t WHERE note = 'please DROP TABLE x; DELETE'"));
  it('keywords inside quoted identifiers', () => accepts(engine, 'SELECT "update", "delete" FROM t'));
  it('semicolon inside a string', () => accepts(engine, "SELECT 'a;b' FROM t"));
  it('escaped quote inside a string', () => accepts(engine, "SELECT 'it''s fine' FROM t"));
  it('block comment', () => accepts(engine, 'SELECT /* hello */ 1 FROM t'));
  it('line comment on its own line', () => accepts(engine, 'SELECT 1 FROM t -- trailing\n'));
  it('column names that merely contain keywords', () => accepts(engine, 'SELECT created_at, updated_by, deleted FROM t'));
});

describe.each(ENGINES)('sql-guard (%s): rejected queries', (engine) => {
  it.each([
    ['DROP TABLE t'],
    ['DELETE FROM t'],
    ['UPDATE t SET a = 1'],
    ['INSERT INTO t VALUES (1)'],
    ['TRUNCATE TABLE t'],
    ['GRANT ALL ON t TO u'],
    ['CREATE TABLE x (a int)'],
    ['   '],
    [''],
  ])('statement %s', (sql) => rejects(engine, sql));

  it('stacked statements', () => rejects(engine, 'SELECT 1 FROM t; DROP TABLE t', /single statement/));
  it('stacked statements after a double semicolon', () => rejects(engine, 'SELECT 1 FROM t;;'));
  it('SELECT INTO', () => rejects(engine, 'SELECT * INTO backup FROM t', /INTO/));
  it('FOR UPDATE', () => rejects(engine, 'SELECT * FROM t FOR UPDATE'));
  it('FOR SHARE', () => rejects(engine, 'SELECT * FROM t FOR SHARE', /locking/));
  it('write hidden in a CTE', () => rejects(engine, 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
  it('unterminated string', () => rejects(engine, "SELECT 'abc FROM t"));
  it('unterminated block comment', () => rejects(engine, 'SELECT 1 /* oops'));
  it('NUL byte', () => rejects(engine, 'SELECT 1\0; DROP TABLE t'));
  it('absurdly long query', () => rejects(engine, 'SELECT ' + '1,'.repeat(20_000) + '1'));
});

describe('sql-guard (postgres)', () => {
  it('rejects server file functions', () => rejects('postgres', "SELECT pg_read_file('/etc/passwd')", /not allowed/));
  it('rejects schema-qualified file functions', () => rejects('postgres', "SELECT pg_catalog.pg_read_file('/etc/passwd')"));
  it('rejects quoted-identifier function calls', () => rejects('postgres', `SELECT "pg_read_file"('/etc/passwd')`));
  it('rejects dblink', () => rejects('postgres', "SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)"));
  it('rejects dynamic SQL via query_to_xml', () => rejects('postgres', "SELECT query_to_xml('delete from t', true, true, '')"));
  it('rejects pg_sleep and nextval', () => {
    rejects('postgres', 'SELECT pg_sleep(60)');
    rejects('postgres', "SELECT nextval('s')");
  });
  it('does not treat a backslash as an escape in a plain string', () => {
    // In standard-conforming Postgres the string ends at the second quote, so DELETE is real code.
    rejects('postgres', "SELECT 'a\\' ; DELETE FROM t; --'");
  });
  it('honours backslash escapes in E strings', () => accepts('postgres', "SELECT E'it\\'s ; DROP' FROM t"));
  it('skips dollar-quoted bodies', () => accepts('postgres', 'SELECT $$ DROP TABLE t; $$ FROM t'));
  it('skips tagged dollar-quoted bodies', () => accepts('postgres', 'SELECT $tag$ DELETE ; $tag$ FROM t'));
  it('accepts positional parameters', () => accepts('postgres', 'SELECT * FROM t WHERE id = $1'));
  it('handles nested block comments', () => accepts('postgres', 'SELECT /* a /* b */ c */ 1 FROM t'));
  it('does not let nested comments hide code', () =>
    rejects('postgres', 'SELECT 1 /* a /* b */ */ ; DELETE FROM t'));
});

describe('sql-guard (mysql)', () => {
  it('rejects executable comments', () => rejects('mysql', 'SELECT 1 /*! ; DROP TABLE t */', /executable comments/));
  it('rejects MariaDB executable comments', () => rejects('mysql', 'SELECT 1 /*M! ; DROP TABLE t */'));
  it('treats "--x" as operators, not a comment', () => rejects('mysql', 'SELECT 1 --1; DROP TABLE t'));
  it('accepts "-- " comments', () => accepts('mysql', 'SELECT 1 -- note\n FROM t'));
  it('treats # as a comment', () => accepts('mysql', 'SELECT 1 # note\n FROM t'));
  it('honours backslash escapes in strings', () => accepts('mysql', "SELECT 'it\\'s ; DROP' FROM t"));
  it('does not let a backslash-escaped quote hide code', () =>
    rejects('mysql', "SELECT 'a\\\\' ; DELETE FROM t; -- '"));
  it('rejects INTO OUTFILE', () => rejects('mysql', "SELECT * FROM t INTO OUTFILE '/tmp/x'"));
  it('rejects LOCK IN SHARE MODE', () => rejects('mysql', 'SELECT * FROM t LOCK IN SHARE MODE'));
  it('rejects load_file and sleep', () => {
    rejects('mysql', "SELECT load_file('/etc/passwd')");
    rejects('mysql', 'SELECT sleep(30)');
  });
  it('accepts backtick identifiers', () => accepts('mysql', 'SELECT `update` FROM `delete`'));
});

describe('sql-guard (oracle)', () => {
  it('accepts common built-in functions', () =>
    accepts('oracle', "SELECT NVL(a, 0), TO_CHAR(d, 'YYYY'), COUNT(*) FROM t GROUP BY a, d"));
  it('accepts window functions', () =>
    accepts('oracle', 'SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) FROM t'));
  it('accepts CAST to sized types', () => accepts('oracle', 'SELECT CAST(a AS NUMBER(10,2)) FROM t'));
  it('accepts IN and EXISTS subqueries', () =>
    accepts('oracle', 'SELECT * FROM t WHERE a IN (SELECT a FROM u) AND EXISTS (SELECT 1 FROM v)'));
  it('accepts FETCH FIRST', () => accepts('oracle', 'SELECT * FROM t FETCH FIRST 10 ROWS ONLY'));
  it('rejects user-defined functions', () => rejects('oracle', 'SELECT my_pkg.do_things(1) FROM dual', /allowlist/));
  it('rejects quoted function names', () => rejects('oracle', 'SELECT "MY_FUNC"(1) FROM dual', /allowlist/));
  it('rejects DBMS_ and UTL_ packages', () => {
    rejects('oracle', "SELECT DBMS_XMLGEN.getxml('delete from t') FROM dual");
    rejects('oracle', "SELECT UTL_HTTP.request('http://evil') FROM dual");
  });
  it('honours q-quoted strings', () => accepts('oracle', "SELECT q'[it's ; DROP]' FROM dual"));
  it('does not let a q-quote hide code', () => rejects('oracle', "SELECT q'[abc]' ; DELETE FROM t"));
  it('lets a profile extend the function allowlist', () => {
    expect(() => assertReadOnlySelect('SELECT my_fn(1) FROM dual', 'oracle', { allowedFunctions: ['my_fn'] })).not.toThrow();
  });
});

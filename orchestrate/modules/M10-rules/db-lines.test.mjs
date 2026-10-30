// db-lines.test.mjs — the deny-by-default line check (lead call L32). The sweep: every way of writing a database change
// that an earlier audit round found a pattern missed is caught by the line check ALONE, and so are commands no list
// names. Then the allow-list: only blank lines, comments, plain SELECT reads and test fixtures pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineRisk, firstRiskyLine, wordsOf } from './db-lines.mjs';

const CODE = { path: 'lib/x.ts' };

// Audit rounds 3 to 11: each line here was once let through by the pattern list.
const PAST_MISSES = [
  'U&"d\\0072op" table users',                              // round 3: an escaped name
  'await sql`create table users (id int)`',                 // round 7: a table change in a code file
  'CREATE UNLOGGED TABLE t (a int)', 'create constraint trigger t after insert on x', 'CREATE/**/TABLE t (a int)',
  "await knex.schema.createTable('t', f)",                  // round 8
  'CREATE -- x', 'TABLE users (a int)', 'CREATE /* a /* b */ c */ TABLE t', 'knex.schema.dropTableIfExists("t")',
  'createTableIfNotExists("t")', 'grant select(id) on users', 'GRANT anon TO authenticator', 'await sql`TRUNCATE users`',   // round 9
  'TRUNCATE "users"', 'CREATE USER evil WITH SUPERUSER', 'ALTER USER app WITH SUPERUSER', 'DROP USER app', 'DROP OWNED BY app_user CASCADE',
  'GRANT "app-reader" TO "svc-api"', 'CREATE PUBLICATION p FOR ALL TABLES', 'ALTER SYSTEM SET x = 1', 'CREATE AGGREGATE a (int)',
  'CREATE OPERATOR === (x)', 'CREATE CAST (a AS b)', 'CREATE TABLESPACE t LOCATION 1', 'CREATE OR REPLACE TEMP RECURSIVE VIEW v AS SELECT 1',
  "op.drop_table('users')", 'create_table :users do |t|', 'await queryInterface.addColumn("t", "c")',                       // round 10
  'change_column_default :users, :x, 1', 'change_column_null :users, :x, false', "op.drop_constraint('fk', 'users')",
  'op.create_unique_constraint("u", "t", ["a"])', 'TRUNCATE `users`', 'migrationBuilder.CreateTable(name: "t")',             // round 11
  '\\u0064rop table users', 'ＤＲＯＰ ＴＡＢＬＥ users', 'DrOp TaBlE users',                                                 // escapes, look-alikes, case
];

// Commands no word list in this module names: caught only because the default is deny.
const UNLISTED = ['OPTIMIZE TABLE users', 'FROBNICATE everything', '  users;'];

test('the sweep: every past miss and every unlisted command counts, by the line check alone (lead call L32)', () => {
  for (const line of [...PAST_MISSES, ...UNLISTED]) assert.ok(lineRisk(line, CODE), line);
  for (const line of PAST_MISSES) assert.ok(lineRisk(line, { path: 'db/migrations/1.sql', migration: true }), `migration: ${line}`);
});

test('harmless lines: blank, a comment by itself in its own language, a plain SELECT read, a test fixture', () => {
  for (const line of ['', '   ', '// create table users here', '/* drop table users */', '/* a */   ']) assert.equal(lineRisk(line, CODE), null, line);
  assert.equal(lineRisk('-- drop table users', { path: 'db/x.sql' }), null);
  assert.equal(lineRisk('# drop table users', { path: 'tools/x.py' }), null);
  for (const line of ['const rows = await sql`select id from users where id = ${id}`', ".from('users').select('id').eq('id', 1)",
    'SELECT count(*) FROM users WHERE lower(email) = $1']) assert.equal(lineRisk(line, CODE), null, line);
  assert.equal(lineRisk("expect(parse('drop table users')).toBe(true)", { path: 'lib/__tests__/parse.test.ts' }), null);
});

test('look-alike harmless lines still count', () => {
  const counts = [
    ['--i; db.query("drop table x")', CODE, '-- is not a comment in a .ts file'],
    ['// drop table users', { path: 'db/x.sql' }, '// is not a comment in a .sql file'],
    ['# drop table users', CODE, '# is not a comment in a .ts file'],
    ['/* x */ drop table y', CODE, 'code after a closed comment'],
    ['* from x; drop table y', CODE, 'a line starting with * may be inside SQL text'],
    ['select * into backup from users', CODE, 'select into makes a table'],
    ['select * from users for update', CODE, 'a row lock'],
    ['select pg_terminate_backend(1)', CODE, 'a select that calls a function with an effect'],
    ["select set_config('x', '1', false)", CODE, 'set_config'],
    ['select id from users', { path: 'db/migrations/1.sql', migration: true }, 'no select allowance in a migration'],
    ["db.query('dr' + 'op table x')", CODE, 'text built at run time'],
    ["sql(String.fromCharCode(100, 114))", CODE, 'text built from codes'],
    ["await db.query('drop table x')", { path: 'lib/__tests__/x.test.ts' }, 'a test that runs SQL'],
    ["const q = `drop ${t}`", { path: 'test/x.test.ts' }, 'a template with a hole is not a fixture'],
    ['x'.repeat(20_001), CODE, 'too long to read'],
    [42, CODE, 'not text'],
  ];
  for (const [line, opts, why] of counts) assert.ok(lineRisk(line, opts), why);
});

test('words are read through escapes and every naming style', () => {
  assert.deepEqual(wordsOf('dropTable CreateTable drop_table "DROP" XMLHttp'), ['drop', 'table', 'create', 'table', 'drop', 'table', 'drop', 'xml', 'http']);
  assert.deepEqual(wordsOf('\\u{64}rop'), ['drop']);
  assert.deepEqual(firstRiskyLine(['// a', '', 'drop table x'], CODE), { n: 3, why: '"drop"' });
  assert.equal(firstRiskyLine(['// a', ''], CODE), null);
});

test('the line check is fast on long and many lines', () => {
  const t0 = Date.now();
  firstRiskyLine(Array(3000).fill('// ' + 'a '.repeat(3000)), CODE);
  lineRisk('/* '.repeat(5000) + ' */'.repeat(5000), CODE);
  lineRisk('\\u0064'.repeat(3000), CODE);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('the sweep through the classifier: each line, added or removed, in a code file is a database change; a doc is prose', async () => {
  const { readFileSync } = await import('node:fs');
  const { parsePolicy } = await import('./policy.mjs');
  const { classifyChange } = await import('./classify.mjs');
  const policy = parsePolicy(readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8')).policy;
  for (const line of [...PAST_MISSES, ...UNLISTED]) {
    for (const side of ['added_lines', 'removed_lines']) {
      const c = classifyChange(policy, { files: [{ path: 'lib/x.ts', status: 'modified', added_lines: [], removed_lines: [], [side]: [line] }], declared_tier: 2 });
      assert.ok(c.risky.includes('schema') && c.tier === 1, `${side}: ${line}`);
    }
  }
  const doc = classifyChange(policy, { files: [{ path: 'docs/research/x.md', status: 'modified', added_lines: ['drop table users'] }], declared_tier: 2 });
  assert.ok(!doc.risky.includes('schema'));
});

test('a plain SELECT or a fixture can\'t hide a change behind escapes, look-alike letters, built text or length', () => {
  for (const line of ["select 1; \\u0064rop table x", 'SELECT 1; ＤＲＯＰ TABLE users', "select 'dr' || 'op table x'"]) assert.ok(lineRisk(line, CODE), line);
  assert.equal(lineRisk("const q = 'dr' + 'op';", { path: 'test/x.test.ts' }), 'text built at run time');
  assert.equal(lineRisk('// ' + 'a'.repeat(20_001), CODE), 'too long to read');
});

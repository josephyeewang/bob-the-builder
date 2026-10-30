// db-lines.test.mjs — the deny-by-default line check (lead call L32). The sweep: every way of writing a database change
// that an earlier audit round found a pattern missed is caught by the line check ALONE, and so are commands no list
// names. Then the allow-list: only a blank line passes (audit rounds 12 and 13 removed reads, comments and fixtures).
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
  for (const line of PAST_MISSES) assert.ok(lineRisk(line, { path: 'db/migrations/1.sql' }), `migration: ${line}`);
});

test('only a blank line is harmless; every comment and every string counts (audit round 13)', () => {
  for (const line of ['', '   ', '\t', ' \t ']) assert.equal(lineRisk(line), null, JSON.stringify(line));
  const ROUND_13 = ['// a', '/* a */', '-- a', '# a', "'drop table users',", "query: 'x',", '],', '\r', '  ', '\u0085',
    '// x\rawait db.query("update users set is_admin = true")', '-- x\rupdate users set is_admin = true;', '# x\rdb.execute(q)',
    '# -*- coding: utf-7 -*-', '//go:generate psql -c "x"', '/*!50000 update users set is_admin = 1 */', '/*! or 1 */', '// */', '/* /* */',
    "'psql' \"$DATABASE_URL\" '-c' 'x'", '"$(psql -c x)"', '`psql -c x`', '"#{DB.run(q)}"', "command: 'psql -c x'", '#!/usr/bin/env -S psql -f', '/// db.run()'];
  for (const line of ROUND_13) assert.ok(lineRisk(line), JSON.stringify(line));
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
    ['select id from users', CODE, 'a plain read is not proven harmless (audit round 12)'],
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
  assert.deepEqual(firstRiskyLine(['', '  ', 'drop table x']), { n: 3, why: '"drop"' });
  assert.equal(firstRiskyLine(['', '\t']), null);
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

// Audit round 12: each line here was called harmless by the first deny-by-default version.
const ROUND_12 = [
  ['await db.query(cfg.Q) // select', 'lib/x.ts'], ['const rows = await pool.query(req.body.sql) // select rows', 'lib/x.ts'],
  ['await c[k](stmt) // select', 'lib/x.ts'], ['await db.raw?.(q) // select', 'lib/x.ts'], ['select; await users.zap?.()', 'lib/x.ts'],
  ["await db.from('users').select('id').then(nukeTables)", 'lib/x.ts'], ['await db.query`select 1`; await zap``', 'lib/x.ts'],
  ['select "pg_terminate_backend"(pid) from pg_stat_activity', 'lib/x.sql'], ['select zap_users/**/()', 'lib/x.sql'],
  ['select u.nuke from users u', 'lib/x.sql'], ['select 1; optimize table users', 'lib/x.sql'], ['select cmd from admin.pending \\gexec', 'lib/x.sql'],
  ['select 1 \\! dropdb prod', 'lib/x.sql'], ["await db.query('\\144elete from users') // select", 'lib/x.js'],
  ['select * from users for share', 'lib/x.ts'], ['select count_and_zap(1)', 'lib/x.sql'], ["await db.query('\\x64elete from users') // select", 'lib/x.ts'],
  ['select 1; vacuum full', 'lib/x.sql'], ['select 1; U&"\\0064rop" table x', 'lib/x.sql'],
  ["await c[`query`]('UPDATE users SET role = 1')", 'lib/__tests__/x.test.ts'], ["/* don't */ await db.query(q) /* won't */", 'lib/__tests__/x.test.ts'],
  ["const a = /'/; await db.query(\"UPDATE users SET role='admin'\"); const b = /'/;", 'lib/__tests__/x.test.ts'],
  ["const { Client } = require('pg')", 'lib/__tests__/x.test.ts'], ['await nukeUsers()', 'lib/__tests__/x.test.ts'],
  ["const q = String.fromCharCode(100, 114)", 'test/x.test.ts'], ['const q = `drop ${t}`', 'test/x.test.ts'], ["const q = 'unclosed", 'test/x.test.ts'],
  ['SELECT zap_users();', 'supabase/tests/x.test.sql'], ["'drop table x'", 'supabase/tests/x.test.sql'], ['await run(text)', 'scripts/fixtures/load.mjs'],
  ["await zap('x')", 'lib/latest.ts'], ["'drop table x',", 'scripts/fixtures/seed.mjs'],
  ['//usr/bin/psql "$DATABASE_URL" -c "UPDATE users SET role=\'admin\'"', 'scripts/reset.sh'], ['//; User.delete_all', 'lib/tasks/x.rb'],
  ['//; $dbh->do($q)', 'lib/x.pl'], ['/* x */', 'lib/tasks/x.rb'], ['#init = this.db.nukeAll()', 'lib/x.ts'], ['--n; await zapAll()', 'lib/x.ts'],
];

test('audit round 12: no allowance can hide a call, a command or a run of SQL', () => {
  for (const [line, path] of ROUND_12) assert.ok(lineRisk(line, { path }), `${path}: ${line}`);
});

test('the line check stays fast on long identifiers, capital runs, unclosed strings and large files (audit round 12)', () => {
  const t0 = Date.now();
  for (const line of ['select ' + 'A'.repeat(19_990), 'x' + 'AB'.repeat(9_000), "'\\'".repeat(6_000), '`'.repeat(19_000), "'a', ".repeat(3_900)]) {
    lineRisk(line, CODE); lineRisk(line, { path: 'test/x.test.ts' });
  }
  assert.deepEqual(firstRiskyLine(Array(60).fill('// ' + 'a'.repeat(19_000)), CODE), { n: 60, why: 'too much text to read' });
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('a long run of capitals is read in one pass (audit round 12)', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) lineRisk('A'.repeat(19_990) + '1', CODE);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

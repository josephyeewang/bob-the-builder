// repair-plain.test.mjs — R-0b-97 / 0b-9 M8, r2-m4: one planted file for each refused form, and plain files that
// pass. Run: node --test orchestrate/modules/M10-rules/repair-plain.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRepairSql, checkRepairFiles, repairOptions, BANNED_WORDS, DEFAULT_ALLOWED_FUNCTIONS } from './repair-plain.mjs';
import { parsePolicy } from './policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const POLICY = parsePolicy(readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8')).policy;
const OPTS = repairOptions(POLICY);
const ok = (sql) => checkRepairSql(sql, OPTS);

const PLAIN = `-- Fix the misspelt plan names from the import on 14 Oct.
/* Two statements; the job wraps them in one transaction. */
UPDATE accounts SET plan = lower(trim(plan)), updated_at = now() WHERE plan <> lower(trim(plan));
INSERT INTO audit_notes (account_id, note) VALUES (42, 'it''s fixed; DROP TABLE stays inside the quotes');
WITH gone AS (SELECT id FROM accounts WHERE closed_at < '2026-01-01') DELETE FROM sessions s USING gone WHERE s.account_id = gone.id;
INSERT INTO totals (day, n) SELECT day, count(*) FROM events GROUP BY day ON CONFLICT (day) DO UPDATE SET n = excluded.n;
SELECT coalesce(max(id), 0) AS top FROM accounts;
`;

test('plain repair files pass', () => {
  assert.deepEqual(ok(PLAIN), { ok: true, statements: 5 });
  assert.equal(ok('insert into "set" ("begin") values (1)').ok, true, 'quoted names are names, not words');
  assert.equal(ok('INSERT INTO app.t (a) VALUES (round(1.5))').ok, true);
  assert.equal(ok('UPDATE t SET (a, b) = (1, 2) FROM (VALUES (1, 2)) AS v(x, y) WHERE t.id = v.x').ok, true);
  assert.equal(ok('WITH RECURSIVE w(n) AS (SELECT 1) INSERT INTO t SELECT n FROM w').ok, true);
  assert.equal(ok('INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING').ok, true);
  assert.equal(ok("SELECT count(*) FILTER (WHERE a = 'U&x') FROM t").ok, true, 'FILTER after a call, and & inside a value');
  assert.equal(ok('WITH g AS MATERIALIZED (SELECT 1) DELETE FROM t USING g').ok, true);
});

// One planted form per refused rule: [name, sql, reason pattern].
const PLANTED = [
  ['psql command line', 'SELECT 1;\n\\i other.sql', /psql command/],
  ['psql command after spaces', 'SELECT 1;\n   \\copy t from program \'x\'', /psql command/],
  ['$$ dollar-quoting', 'SELECT $$ hidden $$', /a \$ outside/],
  ['$tag$ dollar-quoting', 'SELECT $x$ hidden $x$', /a \$ outside/],
  ['positional parameter', 'DELETE FROM t WHERE id = $1', /a \$ outside/],
  ['wrong first word', 'VACUUM t', /starts with "VACUUM"/],
  ['MERGE', 'MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE', /starts with "MERGE"/],
  ['WITH … SELECT only', 'WITH a AS (SELECT 1) SELECT * FROM a', /WITH must lead/],
  ['WITH with no main statement', 'WITH a AS (SELECT 1)', /WITH without/],
  ['SELECT … INTO', 'SELECT * INTO copy_t FROM t', /INTO is allowed only/],
  ['SET outside UPDATE', 'SELECT 1 FROM t SET x', /SET is not allowed/],
  ['two SETs for one UPDATE', 'UPDATE t SET a = 1 SET role', /SET is not allowed/],
  ['DO outside ON CONFLICT', 'SELECT 1 DO', /DO is not allowed/],
  ['ON CONFLICT DO something else', 'INSERT INTO t VALUES (1) ON CONFLICT DO EXECUTE', /DO is not allowed|EXECUTE/],
  ['too many statements', Array.from({ length: 21 }, () => 'SELECT 1;').join('\n'), /more than repairs\.max_statements/],
  ['unlisted function', 'SELECT evil_sleep(10)', /evil_sleep\(…\) is not in repairs\.allowed_functions/],
  ['unlisted function inside UPDATE', 'UPDATE t SET a = evil(a)', /evil\(…\)/],
  ['unlisted function with a space', 'INSERT INTO t VALUES (evil (1))', /evil\(…\)/],
  ['schema-qualified call', 'SELECT app.now()', /schema-qualified/],
  ['a pg_ name (audit round 4)', 'SELECT pg_sleep(10)', /system tables/],
  ['quoted function name', 'SELECT "now"()', /quoted name/],
  ['alias column list without AS', 'SELECT * FROM (VALUES (1)) v(x)', /v\(…\)/],
  ['backslash in a quoted value', "UPDATE t SET a = 'x\\'; DROP TABLE t; --'", /backslash/],
  ['unclosed quoted value', "SELECT 'x", /unparseable/],
  ['unclosed comment', 'SELECT 1 /* /* */', /unparseable/],
  ['unbalanced bracket', 'SELECT (1', /unparseable/],
  ['psql variable', 'DELETE FROM t WHERE id = :victim', /psql variable/],
  ['unexpected character', 'SELECT 1 # 2', /unparseable/],
  ['empty file', '-- nothing here\n', /no statements/],
  ['U& escaped function name (audit round 3)', `SELECT U&"pg_sleep" UESCAPE '!' (5)`, /an & outside/],
  ['U& escaped call inside UPDATE', `UPDATE t SET a = U&"pg_read_file" UESCAPE '!' ('x') WHERE id = 1`, /an & outside/],
  ['a ( after a quoted value', `SELECT 'x' (5)`, /a \( after a value/],
  ['a ( after a number', 'SELECT 1 (5)', /a \( after a value/],
  ['settings changed by UPDATE (audit round 4)', "UPDATE pg_settings SET setting = 'off' WHERE name = 'row_security'", /system tables/],
  ['a quoted system table', 'UPDATE "pg_settings" SET setting = 1', /system tables/],
  ['information_schema', 'SELECT 1 FROM information_schema.tables', /system tables/],
  ['a no-break space hides a call (audit round 4)', 'UPDATE t SET a = 1 WHERE b IN (1, \u00a0(2))', /unparseable/],
  ['a byte-order mark', '\ufeffSELECT 1', /unparseable/],
  ['filter as a function name', 'SELECT filter(1)', /filter\(…\)/],
  ['over as a function name', 'SELECT over(1)', /over\(…\)/],
  ['conflict as a function name', 'SELECT conflict(1)', /conflict\(…\)/],
  ['materialized as a function name', 'SELECT materialized(1)', /materialized\(…\)/],
];

test('every planted form is refused, with its reason', () => {
  for (const [name, sql, why] of PLANTED) {
    const r = ok(sql);
    assert.equal(r.ok, false, name);
    assert.match(r.reason, why, name);
  }
});

test('every banned word is refused outside a literal, and allowed inside one', () => {
  for (const w of BANNED_WORDS) {
    const r = ok(`SELECT 1 FROM t WHERE a = 1 ${w.toUpperCase()} x`);
    assert.equal(r.ok, false, w);
    assert.match(r.reason, new RegExp(`${w.toUpperCase()} is not allowed`), w);
    assert.equal(ok(`SELECT '${w} table x'`).ok, true, `${w} inside quotes`);
    assert.equal(ok(`-- ${w} in a comment\nSELECT 1`).ok, true, `${w} in a comment`);
    assert.equal(ok(`${w.toUpperCase()} TABLE x`).ok, false, `${w} as the first word`);
  }
});

test('a nested comment hides nothing: Postgres and this reader agree on where it ends', () => {
  assert.equal(ok('SELECT 1 /* outer /* inner */ still a comment DROP */').ok, true);
  assert.equal(ok('SELECT 1 /* outer /* inner */ */ DROP TABLE t').ok, false);
});

test('the function allow-list is the rules key, and the default when it is missing', () => {
  for (const f of DEFAULT_ALLOWED_FUNCTIONS) assert.equal(ok(`SELECT ${f}(1)`).ok, true, f);
  assert.equal(checkRepairSql('SELECT now()', { maxStatements: 5, allowedFunctions: ['lower'] }).ok, false);
  assert.equal(checkRepairSql('SELECT now()', { maxStatements: 5 }).ok, true);
});

test('no declared statement limit means nothing passes (fail closed)', () => {
  assert.match(checkRepairSql('SELECT 1', {}).reason, /max_statements is not declared/);
  assert.equal(repairOptions({}).maxStatements, null);
  assert.equal(repairOptions({ repairs: { max_statements: '5' } }).maxStatements, null, 'only a parsed number counts');
});

test('the rules file reads both keys strictly', () => {
  const text = readFileSync(join(here, 'fixtures/policy.yaml'), 'utf8');
  assert.equal(POLICY.repairs.max_statements, 20);
  assert.match(parsePolicy(text.replace('max_statements: 20', 'max_statements: lots')).reason, /repairs\.max_statements/);
  assert.match(parsePolicy(text.replace('[now, coalesce', '[Now, coalesce')).reason, /lower-case function name/);
  assert.match(parsePolicy(text.replace('[now, coalesce', '[pg_catalog.now, coalesce')).reason, /lower-case function name/);
});

test('files: only added .sql files in the repair folder run; others are refused; files elsewhere are not judged', () => {
  const files = [
    { path: 'db/repairs/2026-10-14-plans.sql', status: 'added', text: PLAIN },
    { path: 'db/repairs/fix.js', status: 'added', text: 'console.log(1)' },
    { path: 'db/repairs/fix.ts', status: 'added', text: '' },
    { path: 'db/repairs/old.sql', status: 'modified', text: 'SELECT 1' },
    { path: 'db/repairs/moved.sql', previous_path: 'db/x.sql', status: 'renamed', text: 'SELECT 1' },
    { path: 'db/elsewhere.sql', previous_path: 'db/repairs/a.sql', status: 'renamed', text: 'SELECT 1' },
    { path: 'db/repairs/notext.sql', status: 'added' },
    { path: 'db/repairs/UPPER.SQL', status: 'added', text: 'SELECT 1' },
    { path: 'db/repairs/bad.sql', status: 'added', text: 'DO $$ BEGIN PERFORM 1; END $$' },
    { path: 'db/repairs/gone.sql', status: 'removed' },
    { path: 'app/page.ts', status: 'added', text: 'DROP TABLE x' },
    { path: 'docs/notes.md', status: 'modified', text: 'CREATE TABLE' },
  ];
  const r = checkRepairFiles(files, POLICY);
  assert.equal(r.ok, false);
  const why = Object.fromEntries(r.refused.map((x) => [x.path, x.reason]));
  assert.deepEqual(Object.keys(why).sort(), ['db/elsewhere.sql', 'db/repairs/UPPER.SQL', 'db/repairs/bad.sql', 'db/repairs/fix.js',
    'db/repairs/fix.ts', 'db/repairs/moved.sql', 'db/repairs/notext.sql', 'db/repairs/old.sql']);
  assert.match(why['db/repairs/fix.js'], /not a \.sql file/);
  assert.match(why['db/repairs/old.sql'], /modified, not added/);
  assert.match(why['db/repairs/moved.sql'], /renamed, not added/);
  assert.match(why['db/repairs/notext.sql'], /text not given/);
  assert.match(why['db/repairs/bad.sql'], /\$|DO/);
  assert.deepEqual(checkRepairFiles(files.slice(0, 1), POLICY), { ok: true, refused: [] });
  assert.equal(checkRepairFiles(null, POLICY).ok, false);
  assert.equal(checkRepairFiles(files.slice(0, 1), {}).ok, true, 'no repair folder: nothing is a repair file');
  assert.equal(checkRepairFiles([{ path: 'db/repairs/a.sql', status: 'added', text: 'SELECT 1' }], { effect_paths: POLICY.effect_paths }).ok, false, 'no limit declared');
});

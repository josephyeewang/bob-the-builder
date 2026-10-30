// classify.test.mjs — the tier and risky classes come from the files a change touches (MAT-6, MAT-7, MIN-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyChange, classifyWithRulesText, MAX_FILES } from './classify.mjs';
import { parsePolicy } from './policy.mjs';

const fixture = readFileSync(new URL('./fixtures/policy.yaml', import.meta.url), 'utf8');
const policy = parsePolicy(fixture).policy;
const mod = (path, extra = {}) => ({ path, status: 'modified', ...extra });
const run = (files, extra = {}) => classifyChange(policy, { files, declared_tier: 2, ...extra });

test('the fixture policy is valid', () => assert.ok(policy));

test('a research note is Tier 2 with no risky class', () => {
  const r = run([mod('docs/research/x.md')]);
  assert.deepEqual([r.tier, r.risky, r.protected], [2, [], []]);
});

test('hidden edits to the rules, Claude settings and deploy config are protected and Tier 1', () => {
  for (const p of ['orchestrate/policy.yaml', '.claude/settings.json', '.CLAUDE/settings.json', 'vercel.json',
    'sub/dir/vercel.ts', 'docs/blueprint/decided.yaml', 'apps/web/AGENTS.md']) {
    const r = run([mod(p)]);
    assert.equal(r.tier, 1, p);
    assert.ok(r.risky.includes('protected'), p);
    assert.deepEqual(r.protected, [p]);
  }
});

test('a rename counts both names: moving a workflow out of .github is still protected', () => {
  const r = run([{ path: 'docs/a.yml', previous_path: '.github/workflows/a.yml', status: 'renamed' }]);
  assert.ok(r.risky.includes('protected'));
  assert.deepEqual(r.protected, ['.github/workflows/a.yml']);
});

test('truncated or labels of the wrong type are unclassifiable (audit round 3)', () => {
  for (const extra of [{ truncated: 'true' }, { truncated: 1 }, { labels: 'needs-joe' }, { labels: [null] }]) {
    assert.ok(run([mod('docs/research/x.md')], extra).risky.includes('unclassifiable'), JSON.stringify(extra));
  }
});

test('a rename or copy with no old name is unclassifiable, never a plain doc (audit round 2, MAT-7)', () => {
  for (const status of ['renamed', 'copied']) {
    const r = run([{ path: 'docs/research/a.md', status }]);
    assert.ok(r.risky.includes('unclassifiable'), status);
    assert.match(r.reasons.unclassifiable.join(), /no old name/);
  }
});

test('a near-miss folder name is not the lead lane, and outside docs/ is unclassifiable', () => {
  assert.equal(run([mod('docs/blueprintx/a.md')]).tier, 2);
  const r = run([mod('lib/util.ts')]);
  assert.equal(r.tier, 1);
  assert.deepEqual(r.risky, ['unclassifiable']);
  assert.match(r.reasons.unclassifiable[0], /scan_not_built/);
});

test('a missing or unknown declared tier counts as Tier 1; a Tier-1 path forces Tier 1', () => {
  assert.equal(classifyChange(policy, { files: [mod('docs/research/x.md')] }).tier, 1);
  assert.equal(classifyChange(policy, { files: [mod('docs/research/x.md')], declared_tier: '2' }).tier, 1);
  assert.equal(run([mod('tests/exit/a.test.mjs')]).tier, 1);
});

test('effect paths add their class', () => {
  const cases = [
    [mod('db/migrations/001.sql'), 'schema'],
    [{ path: 'db/repairs/fix.sql', status: 'added' }, 'production_data'],
    [mod('next.config.mjs'), 'secrets_settings'],
    [mod('lib/mail/send.ts'), 'messages_people'],
    [mod('lib/flags.ts'), 'first_customer_visible'],
    [{ path: 'app/new/page.tsx', status: 'added' }, 'first_customer_visible'],
    [{ path: 'docs/research/old.md', status: 'removed' }, 'deletes'],
  ];
  for (const [f, cls] of cases) assert.ok(run([f]).risky.includes(cls), `${f.path} → ${cls}`);
  assert.ok(!run([mod('app/page.tsx')]).risky.includes('first_customer_visible'), 'only new files under app/');
});

test('a repair file is judged by the plain-statement allow-list before the merge (0b-9 M8)', () => {
  const reasons = (f) => run([f]).reasons.unclassifiable ?? [];
  const plain = { path: 'db/repairs/fix.sql', status: 'added', added_lines: ['UPDATE t SET a = lower(a);'] };
  assert.ok(run([plain]).risky.includes('production_data'));
  assert.ok(!reasons(plain).some((r) => /repair file not plain/.test(r)), 'a plain added repair file passes the allow-list');
  assert.match(reasons({ ...plain, added_lines: ['SELECT pg_sleep(1);'] }).join(), /repair file not plain: .*pg_sleep/);
  assert.match(reasons({ ...plain, status: 'modified' }).join(), /not added/);
  assert.match(reasons({ path: 'db/repairs/run.js', status: 'added', added_lines: ['x'] }).join(), /not a \.sql file/);
  assert.match(reasons({ path: 'db/repairs/fix.sql', status: 'added' }).join(), /text not given/);
  assert.match(reasons({ path: 'db/other.sql', previous_path: 'db/repairs/a.sql', status: 'renamed' }).join(), /repair file not plain/);
});

test('text scans of added lines add classes outside docs, never inside', () => {
  const code = (lines) => run([mod('lib/x.ts', { added_lines: lines })]).risky;
  assert.ok(code(['await sql`ALTER TABLE users ADD COLUMN x int`']).includes('schema'));
  assert.ok(code(['DELETE FROM sessions WHERE 1=1']).includes('deletes'));
  assert.ok(code(["import nodemailer from 'nodemailer'"]).includes('messages_people'));
  assert.ok(code(["const t = require('twilio/lib/rest')"]).includes('messages_people'));
  assert.ok(!code(["import x from 'nodemailer-mock'"]).includes('messages_people'));
  assert.ok(code(["const t = require(/* mail */ 'nodemailer')"]).includes('messages_people'), 'a comment inside the call is blanked');
  assert.deepEqual(run([mod('docs/research/x.md', { added_lines: ['DROP TABLE users;'] })]).risky, []);
});

test('links and submodules are protected wherever they are', () => {
  assert.ok(run([mod('docs/research/link', { mode: '120000' })]).risky.includes('protected'));
  assert.ok(run([mod('docs/research/sub', { mode: 160000 })]).risky.includes('protected'));
  // Any other spelling of a mode is unknown, never a plain doc (audit round 4).
  for (const mode of [0o120000, '0120000', 120000.5, null, '644']) {
    assert.ok(run([mod('docs/research/x.md', { mode })]).risky.includes('unclassifiable'), String(mode));
  }
  assert.deepEqual(run([mod('docs/research/x.md', { mode: '100644' })]).risky, []);
});

test('a truncated or oversized file list, a bad entry or a bad path is unclassifiable', () => {
  assert.ok(run([mod('docs/a.md')], { truncated: true }).risky.includes('unclassifiable'));
  const many = Array.from({ length: MAX_FILES }, (_, i) => mod(`docs/research/${i}.md`));
  assert.ok(run(many).risky.includes('unclassifiable'), 'exactly the limit may be cut off');
  assert.deepEqual(run(many.slice(1)).risky, [], 'one under the limit is fine');
  assert.ok(run([]).risky.includes('unclassifiable'), 'an empty file list is never Tier 2');
  assert.ok(run([{ path: 'docs/a.md', status: 'exploded' }]).risky.includes('unclassifiable'));
  assert.match(run([mod('docs/../orchestrate/policy.yaml')]).reasons.unclassifiable.join(), /dot segment/);
  assert.match(run([mod('docs/blueprint/x.md', { status: 'renamed', previous_path: 'doc\u017f/blueprint/x.md' })]).reasons.unclassifiable.join(), /non-ASCII/);
  assert.ok(classifyChange(policy, {}).risky.includes('unclassifiable'));
  assert.ok(classifyChange(null, { files: [] }).risky.includes('unclassifiable'));
});

test('a rules file missing an effect key makes every change unclassifiable', () => {
  const p = structuredClone(policy); delete p.effect_paths.schema;
  assert.ok(classifyChange(p, { files: [mod('docs/research/x.md')], declared_tier: 2 }).risky.includes('unclassifiable'));
});

test('needs-joe labels only add a class (MIN-3)', () => {
  assert.deepEqual(run([mod('docs/research/x.md')], { labels: ['needs-joe'] }).risky, ['unclassifiable']);
  assert.deepEqual(run([mod('docs/research/x.md')], { labels: ['needs-joe:schema'] }).risky, ['schema']);
  assert.deepEqual(run([mod('docs/research/x.md')], { labels: ['needs-joe:bogus'] }).risky, ['unclassifiable']);
  assert.ok(run([mod('db/migrations/1.sql')], { labels: ['no-joe', 'needs-joe:none'] }).risky.includes('schema'));
});

test('under docs/, only plain files are ordinary; runnable ones are unclassifiable (R2-M4)', () => {
  assert.deepEqual(run([mod('docs/research/x.md', { added_lines: ['We should drop the feature and truncate the list.'] })]).risky, []);
  assert.deepEqual(run([mod('docs/research/chart.PNG')]).risky, []);
  for (const p of ['docs/x.mjs', 'docs/page.mdx', 'docs/run.sh', 'docs/README']) {
    assert.deepEqual(run([mod(p)]).risky, ['unclassifiable'], p);
  }
  const sql = run([{ path: 'docs/x.sql', status: 'added', added_lines: ['DROP TABLE t;'] }]).risky;
  assert.deepEqual(sql, ['schema', 'deletes', 'unclassifiable']);
});

test('a docs folder elsewhere in the repository is never an ordinary doc (audit round 5)', () => {
  assert.ok(run([mod('src/docs/config.json')]).risky.includes('unclassifiable'));
  assert.ok(run([mod('lib/docs/payments/settings.yaml')]).risky.includes('unclassifiable'));
});

test('ordinary docs follow the product\'s docs_paths (R3-m5)', () => {
  const narrow = parsePolicy(fixture.replace(/^product:/m, 'docs_paths: [docs/research/**]\nproduct:')).policy;
  assert.deepEqual(narrow.docs_paths, ['docs/research/**']);
  assert.deepEqual(classifyChange(narrow, { files: [mod('docs/research/x.md')], declared_tier: 2 }).risky, []);
  assert.deepEqual(classifyChange(narrow, { files: [mod('docs/notes.md')], declared_tier: 2 }).risky, ['unclassifiable']);
});

test('the SQL scans match whole statements only', () => {
  const code = (line) => run([mod('lib/x.ts', { added_lines: [line] })]).risky;
  assert.ok(code('TRUNCATE sessions').includes('deletes'));
  assert.ok(code('alter table users drop column age').includes('schema'));
  assert.ok(!code('// we will drop support later').includes('deletes'));
  assert.ok(!code('const deleteFrom = 1').includes('deletes'));
});

test('rules given as text go through the same checker; corrupt text makes every file unclassifiable (R2-M10)', () => {
  assert.deepEqual(classifyWithRulesText(fixture, { files: [mod('docs/research/x.md')], declared_tier: 2 }).risky, []);
  const r = classifyWithRulesText(`${fixture}\n__proto__:\n  tiers: loose\n`, { files: [mod('docs/research/x.md')], declared_tier: 2 });
  assert.deepEqual([r.tier, r.risky], [1, ['unclassifiable']]);
  assert.match(r.reasons.unclassifiable[0], /corrupt/);
});

test('with unreadable rules the protected floor still applies (audit round 4, R3-M3)', () => {
  const files = [mod('orchestrate/policy.yaml'), { path: 'docs/a.yml', previous_path: '.github/workflows/a.yml', status: 'renamed' }];
  const corrupt = classifyWithRulesText('not: [valid', { files, declared_tier: 2 });
  assert.deepEqual(corrupt.protected, ['.github/workflows/a.yml', 'orchestrate/policy.yaml']);
  const bad = classifyChange({ ...policy, effect_paths: { ...policy.effect_paths, production_data: { ...policy.effect_paths.production_data, repair_folder: '{bad' } } }, { files, declared_tier: 2 });
  assert.match(bad.reasons.unclassifiable.join(), /patterns unreadable/);
  assert.deepEqual(bad.protected, ['.github/workflows/a.yml', 'orchestrate/policy.yaml']);
  assert.deepEqual(classifyChange(null, { files }).protected, ['.github/workflows/a.yml', 'orchestrate/policy.yaml']);
});

test('removed lines are scanned for table changes too: removing one undoes a database change (audit round 7)', () => {
  assert.ok(run([mod('lib/db/setup.ts', { removed_lines: ['await sql`CREATE TABLE users (id int)`'] })]).risky.includes('schema'));
  // Deny by default (lead call L32): any code line counts unless proven harmless; a comment by itself is.
  assert.ok(run([mod('lib/db/setup.ts', { removed_lines: ['const created = table;'] })]).risky.includes('schema'));
  assert.ok(!run([mod('lib/db/setup.ts', { removed_lines: ['// the old helper lived here'] })]).risky.includes('schema'));
  assert.ok(!run([mod('docs/research/x.md', { removed_lines: ['CREATE TABLE in prose'] })]).risky.includes('schema'), 'docs are prose');
  assert.match(run([mod('lib/a.ts', { removed_lines: 'CREATE TABLE x' })]).reasons.unclassifiable.join(), /removed_lines is not a list/);
});

test('a mode that is not a string or number is unclassifiable; a rename out of a delete-watched folder is a delete (audit round 9 gaps)', () => {
  assert.deepEqual(run([{ path: 'app/x.ts', status: 'modified', mode: ['100644'] }]).risky, ['unclassifiable']);
  const moved = run([{ path: 'docs/notes/x.md', previous_path: 'docs/research/x.md', status: 'renamed' }]);
  assert.ok(moved.risky.includes('deletes'), JSON.stringify(moved));
});

test('deeply nested comments can\'t make the classifier slow (audit round 11)', () => {
  const t0 = Date.now();
  const c = run([mod('lib/x.ts', { added_lines: ['/* '.repeat(16000) + ' */'.repeat(16000)], removed_lines: [] })]);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok(c.risky.includes('schema'), 'a line that long is not read, so it counts');
});

test('a renamed file\'s lines must be harmless under both its names (lead call L32, audit round 12)', () => {
  const ren = (from, to, removed, added = []) => mod(to, { status: 'renamed', previous_path: from, added_lines: added, removed_lines: removed });
  const hit = (c, p) => (c.reasons.schema ?? []).some((r) => r.startsWith(`${p} (`) && r.includes('may change the database'));
  assert.ok(!hit(run([mod('test/x.test.ts', { added_lines: ["const q = 'optimize everything';"], removed_lines: [] })]), 'test/x.test.ts'), 'a fixture in a test file');
  assert.ok(hit(run([ren('test/x.test.ts', 'lib/x.ts', [], ["const q = 'optimize everything';"])]), 'lib/x.ts'), 'a test file renamed into code');
  assert.ok(hit(run([ren('lib/a.ts', 'lib/a.sql', ['--n; await zapAll()'], ['-- a'])]), 'lib/a.sql'), 'code renamed to .sql keeps the code reading');
  assert.ok(hit(run([ren('lib/a.ts', 'lib/a.py', ['#init = this.db.nukeAll()'], ['# a'])]), 'lib/a.py'), 'code renamed to .py keeps the code reading');
  assert.ok(!hit(run([ren('lib/a.ts', 'lib/b.ts', ['// a'], ['// b'])]), 'lib/b.ts'), 'comments under both names');
});

// checker-entry.test.mjs — the GitHub-side checker, on planted repositories (R-0b-93).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../shared/test-tmp.mjs';
import { classifyWithRulesText } from '../M10-rules/classify.mjs';
import { runChecker, main } from './checker-entry.mjs';
import { plantedRepo, POLICY } from './fixtures/checker-repo.mjs';

const has = (r, re) => r.flags.some((f) => re.test(f));

test('a plain docs change with the mark (and the robot\'s needs-joe false, tier 2) passes', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'docs/research/a.md': 'two' });
  const r = await runChecker(p.args(m));
  assert.deepEqual(r, { ok: true, flags: [], judged: true });
});

test('no mark (a hand push with no pull request) is flagged', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'docs/research/a.md': 'two' }, { marked: false });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /no robot mark/) && has(r, /no pull request/), r.flags.join('|'));
});

test('a missing needs-joe status counts as true: the owner is needed', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'docs/research/a.md': 'two' }, { needsJoe: null });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /needs the owner's Approve/), r.flags.join('|'));
});

test('a policy.yaml change with only the robot\'s mark is flagged; the owner\'s Approve at the head clears it', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'orchestrate/policy.yaml': `${POLICY}\n# note\n` });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /protected/), r.flags.join('|'));
  const q = plantedRepo();
  const head = q.r.commit([q.root], { 'orchestrate/policy.yaml': `${POLICY}\n# note\n` });
  const approved = q.merge({ 'orchestrate/policy.yaml': `${POLICY}\n# note\n` }, { reviews: q.approve(head) });
  // The review must name the merged head itself; a review of another commit doesn't count.
  assert.equal((await runChecker(q.args(approved.m))).ok, false);
  const s = plantedRepo();
  const merged = s.merge({ 'orchestrate/policy.yaml': `${POLICY}\n# note\n` });
  s.routes[`/repos/sample-org/sample-app/pulls/7/reviews?per_page=100`] = s.approve(merged.head);
  assert.deepEqual(await runChecker(s.args(merged.m)), { ok: true, flags: [], judged: true });
});

test('an approval by a robot, via an app, or followed by a change request does not count', async () => {
  for (const reviews of [
    (h) => [{ user: { id: 4242, type: 'Bot' }, state: 'APPROVED', commit_id: h }],
    (h) => [{ user: { id: 1000001, type: 'User' }, state: 'APPROVED', commit_id: h, performed_via_github_app: { id: 3 } }],
    (h) => [{ user: { id: 1000001, type: 'User' }, state: 'APPROVED', commit_id: h }, { user: { id: 1000001, type: 'User' }, state: 'CHANGES_REQUESTED', commit_id: h }]]) {
    const p = plantedRepo();
    const merged = p.merge({ 'orchestrate/policy.yaml': `${POLICY}\n# note\n` });
    p.routes[`/repos/sample-org/sample-app/pulls/7/reviews?per_page=100`] = reviews(merged.head);
    assert.equal((await runChecker(p.args(merged.m))).ok, false);
  }
});

test('a protected-file change is flagged', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ '.claude/settings.json': '{}' });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /protected/), r.flags.join('|'));
});

test('a messages-to-people change through a declared sender path is flagged', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'lib/mail/send.ts': 'export const send = () => 1;' });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /messages_people/), r.flags.join('|'));
});

test('a change loosening policy.yaml is judged by the parent\'s rules', async () => {
  const loosened = POLICY.replace('removed_file_paths: [docs/research/**, ', 'removed_file_paths: [');
  assert.notEqual(loosened, POLICY);
  const change = { files: [{ path: 'docs/research/a.md', status: 'removed' }], declared_tier: 2 };
  // Under its own (loosened) rules the deletion would carry no deletes class; under the parent's it does.
  assert.ok(!classifyWithRulesText(loosened, change).risky.includes('deletes'));
  assert.ok(classifyWithRulesText(POLICY, change).risky.includes('deletes'));
  const p = plantedRepo();
  const { m } = p.merge({ 'orchestrate/policy.yaml': loosened, 'docs/research/a.md': null });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /deletes/), r.flags.join('|'));
});

test('a parent with no policy.yaml makes every file need the owner', async () => {
  const p = plantedRepo({ withRules: false });
  const { m } = p.merge({ 'docs/research/a.md': 'two' });
  const r = await runChecker(p.args(m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /no readable orchestrate\/policy.yaml/) && has(r, /unclassifiable/), r.flags.join('|'));
});

test('the exact reverse of a flagged merge passes with no owner review; of a passed merge it needs one', async () => {
  for (const [result, ok] of [['flagged', true], ['passed', false]]) {
    const p = plantedRepo();
    const a = p.merge({ 'lib/x.ts': 'y' }, { pr: 7 });
    p.auditRun(a.m, result);
    const rev = p.merge({ 'lib/x.ts': 'x' }, { pr: 8, body: `Undo.\nreverses: ${a.m}\n` });
    const r = await runChecker(p.args(rev.m));
    assert.equal(r.ok, ok, `${result}: ${r.flags.join('|')}`);
  }
});

test('a "reverse" that is not exact still needs the owner', async () => {
  const p = plantedRepo();
  const a = p.merge({ 'lib/x.ts': 'y' }, { pr: 7 });
  p.auditRun(a.m, 'flagged');
  const rev = p.merge({ 'lib/x.ts': 'x', 'lib/other.ts': 'z' }, { pr: 8, body: `reverses: ${a.m}` });
  const r = await runChecker(p.args(rev.m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /not an exact reverse/), r.flags.join('|'));
});

test('the reverse of an owner-approved policy.yaml change with no owner review is flagged', async () => {
  const p = plantedRepo();
  const a = p.merge({ 'orchestrate/policy.yaml': `${POLICY}\n# note\n` }, { pr: 7 });
  p.routes[`/repos/sample-org/sample-app/pulls/7/reviews?per_page=100`] = p.approve(a.head);
  assert.equal((await runChecker(p.args(a.m))).ok, true);
  p.auditRun(a.m, 'flagged');
  const rev = p.merge({ 'orchestrate/policy.yaml': POLICY }, { pr: 8, body: `reverses: ${a.m}` });
  const r = await runChecker(p.args(rev.m));
  assert.equal(r.ok, false);
  assert.ok(has(r, /policy.yaml or a protected file/), r.flags.join('|'));
});

test('GitHub down: not judged (never a verdict)', async () => {
  const p = plantedRepo();
  const { m } = p.merge({ 'docs/research/a.md': 'two' });
  p.r.down = true;
  const r = await runChecker(p.args(m));
  assert.deepEqual([r.ok, r.judged], [false, false]);
  assert.deepEqual([(await runChecker({ ...p.args(m), ownerId: undefined })).judged], [false]);
});

test('main: audit-read writes the result, verdict exits 1 only on a flag; a read failure is exit 2 with no file', async () => {
  const dir = tempDir('m6-checker-entry-');
  const file = join(dir, 'result.json');
  const p = plantedRepo();
  const { m } = p.merge({ '.claude/settings.json': '{}' });
  const env = { GITHUB_REPOSITORY: 'sample-org/sample-app', GITHUB_SHA: m, ORCHESTRATE_ROBOT_BOT_ID: '4242', ORCHESTRATE_OWNER_ID: '1000001',
    ORCHESTRATE_AUDIT_WORKFLOW: '.github/workflows/audit.yml' };
  const out = () => {};
  assert.equal(await main(['audit-read', file], env, { gh: p.r.gh, out }), 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ok, false);
  assert.equal(await main(['verdict', file], {}, { out }), 1);
  writeFileSync(file, JSON.stringify({ ok: true, flags: [] }));
  assert.equal(await main(['verdict', file], {}, { out }), 0);
  writeFileSync(file, '{');
  assert.equal(await main(['verdict', file], {}, { out }), 2);
  p.r.down = true;
  const other = join(dir, 'none.json');
  assert.equal(await main(['audit-read', other], env, { gh: p.r.gh, out }), 2);
  assert.throws(() => readFileSync(other));
  assert.equal(await main(['nonsense', file], env, { out }), 2);
  assert.equal(await main(['first'], { VERCEL_ENV: 'preview' }, { out }), 0);
});

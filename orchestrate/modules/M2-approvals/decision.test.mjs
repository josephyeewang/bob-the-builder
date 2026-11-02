// decision.test.mjs — R-0b-50: decisions go out as small decision pull requests; Approve = the recommended choice, a
// letter picks another, another account's review is ignored. Also the Tier-1 go as a decision pull request (L17/N20).

import { planFingerprint } from '../../shared/plan-fingerprint.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, OWNER_ID } from './fixtures.test-helper.mjs';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { createAsk } from './binding.mjs';
import { openDecision, readDecision, choiceOf } from './decision.mjs';
import { GO_EMPTY_LINE, LETTER_LINE, readConfig } from './kinds.mjs';

const MIN = 60_000;
function world({ kind = 'decision', ...over } = {}) {
  const t = env();
  const g = fakeGitHub({ ownerId: OWNER_ID, now: () => t.clock.t });
  g.repo.main = g.repo.commit([], { 'README.md': 'hi' });
  Object.assign(t.ctx, { gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const fp = planFingerprint({ product: t.ctx.product, card_id: 'C-1', tier: 1, files: ['src/a.mjs'], done_when: 'the export matches the ledger', plan_sha256: 'e'.repeat(64), main_commit: 'a'.repeat(40) });
  const fields = kind === 'go_t1'
    ? { id: 'G-1', kind, card: 'C-1', title: 'Billing export', tier: 1, fingerprint: fp.sha256, files: ['src/a.mjs'], extra: {
      fingerprint_inputs: fp.inputs,
      plan_check: { pass: true, material: 0, card: 'C-1', fingerprint: fp.sha256, plan_sha256: 'e'.repeat(64), reviewer_session: 'S-review', author_session: 'S-lead' } } }
    : { id: 'D-1', kind, card: 'C-1', title: 'Which export format', choices: ['CSV', 'JSON', 'Parquet'], recommended: 'CSV' };
  const r = createAsk(t.ctx, { ...fields, ...over });
  assert.equal(r.ok, true, r.reason);
  return { t, g, id: fields.id };
}
const ask = (t, id) => t.record.read('ask', id).doc;
const head = (g, pr) => g.pulls.get(pr).head;

test('the robot opens a decision pull request holding the question, and raised time comes from GitHub', async () => {
  const { t, g, id } = world();
  const o = await openDecision(t.ctx, id);
  assert.equal(o.ok, true, o.reason);
  const a = ask(t, id);
  assert.equal(a.state, 'pushed');
  assert.equal(a.pr, o.pr);
  assert.equal(a.file, 'decisions/D-1.md');
  assert.equal(a.raised_at, new Date(t.clock.t).toISOString());
  assert.equal(g.pulls.get(o.pr).title, 'Decision: Which export format');
  assert.match(g.repo.files(head(g, o.pr)).get('decisions/D-1.md').text, /\*\*A\*\* CSV \(recommended\)/);
  assert.equal((await openDecision(t.ctx, id)).ok, false, 'never opened twice');
});

test('Approve with no text records the recommended choice', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN });
  const r = await readDecision(t.ctx, id);
  assert.deepEqual([r.counted, r.choice], [true, 'CSV']);
  assert.equal(ask(t, id).state, 'answered');
  assert.equal(ask(t, id).answer.binding.kind, 'github_review');
  assert.equal(g.pulls.get(pr).state, 'closed', 'closed unmerged after the choice is recorded');
});

test('M10 must allow the GitHub channel: a deny counts nothing and alerts', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN });
  const alerts = [];
  t.ctx.alert = (a) => alerts.push(a);
  const may = t.ctx.rules.may;
  t.ctx.rules = { ...t.ctx.rules, may: (action, s) => action === 'count_approval' ? { decision: 'deny', reason: 'test deny' } : may(action, s) };
  assert.equal((await readDecision(t.ctx, id)).counted, false);
  assert.equal(ask(t, id).state, 'pushed');
  assert.equal(alerts[0]?.type, 'approval_not_counted');
});

test('Approve with "C" records choice C; "c." too; anything else counts nothing and says how', async () => {
  for (const [body, want] of [['C', 'Parquet'], ['  c. ', 'Parquet'], ['b!', 'JSON']]) {
    const { t, g, id } = world();
    const { pr } = await openDecision(t.ctx, id);
    g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN, body });
    assert.equal((await readDecision(t.ctx, id)).choice, want, body);
  }
  for (const body of ['D', 'C please', 'AB', 'go with C']) {
    const { t, g, id } = world();
    const { pr } = await openDecision(t.ctx, id);
    g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN, body });
    const r = await readDecision(t.ctx, id);
    assert.deepEqual([r.counted, r.line], [false, LETTER_LINE], body);
    assert.equal(ask(t, id).state, 'pushed');
  }
  assert.equal(choiceOf('', ['x', 'y'], 'y'), 'y');
});

test('a review from another account is ignored', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { user: g.robotId, state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN, body: 'C' });
  g.review(pr, { user: 777, state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN, body: 'B' });
  assert.equal((await readDecision(t.ctx, id)).counted, false);
  assert.equal(ask(t, id).state, 'pushed');
});

test('"Request changes" records declined and closes the pull request unmerged; the answer is final', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { state: 'CHANGES_REQUESTED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN });
  const r = await readDecision(t.ctx, id);
  assert.equal(r.counted, true);
  assert.equal(ask(t, id).answer.declined, true);
  assert.equal(g.pulls.get(pr).state, 'closed');
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + 2 * MIN });
  assert.equal((await readDecision(t.ctx, id)).counted, false);
  assert.equal(ask(t, id).answer.declined, true);
});

test('a Tier-1 go is a decision pull request: go-<card>.json, "Go: <card> — <what>", only an empty Approve', async () => {
  const { t, g, id } = world({ kind: 'go_t1' });
  const { pr } = await openDecision(t.ctx, id);
  assert.equal(g.pulls.get(pr).title, 'Go: C-1 — Billing export');
  assert.ok(g.repo.files(head(g, pr)).has('decisions/go-C-1.json'));
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN, body: 'A' });
  assert.deepEqual(await readDecision(t.ctx, id), { ok: true, counted: false, line: GO_EMPTY_LINE });
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + 2 * MIN, body: ' ' });
  const r = await readDecision(t.ctx, id);
  assert.deepEqual([r.counted, r.choice], [true, 'go']);
  const b = ask(t, id).answer.binding;
  assert.deepEqual(Object.keys(b).sort(), ['commit_id', 'kind', 'pr', 'review_id', 'submitted_at']);
});

test('a Tier-1 go: "Request changes" is "not now"', async () => {
  const { t, g, id } = world({ kind: 'go_t1' });
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { state: 'CHANGES_REQUESTED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN });
  assert.equal((await readDecision(t.ctx, id)).choice, 'Not now');
  assert.equal(ask(t, id).answer.approves, false);
});

test('an Approve on an older version of the decision pull request counts nothing', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  const old = head(g, pr);
  g.pulls.get(pr).head = g.repo.commit([old], { 'decisions/D-1.md': 'edited' });
  g.review(pr, { state: 'APPROVED', commit_id: old, submitted_at: t.clock.t + MIN });
  assert.equal((await readDecision(t.ctx, id)).counted, false);
});

test('missing owner settings: no pull request is opened, nothing counts', async () => {
  const { t, id } = world();
  t.ctx.rules = env({ values: { 'approvals.decisions_dir': '../x' } }).ctx.rules;
  assert.equal((await openDecision(t.ctx, id)).ok, false);
});

test('no owner GitHub id, or a bad one, in the settings: no decision pull request is opened', async () => {
  // L96 step 2: the id reads through num(), so the text '4242' (what the settings reader hands back) is a good id;
  // '0', a sign, a decimal or a word is not.
  for (const bad of [undefined, 0, '0', -1, '-1', '42.5', '0420', 'joe', true]) {
    const { t, id } = world();
    t.ctx.rules = env({ values: { 'accounts.joe.github_id': bad } }).ctx.rules;
    assert.equal((await openDecision(t.ctx, id)).ok, false, String(bad));
    assert.match(readConfig(t.ctx.rules, t.ctx.product).reason ?? '', /github_id/, String(bad));
  }
  const { t } = world();
  t.ctx.rules = env({ values: { 'accounts.joe.github_id': '4242' } }).ctx.rules;
  assert.doesNotMatch(readConfig(t.ctx.rules, t.ctx.product).reason ?? '', /github_id/, 'the text 4242 is a good id');
});

test('another account asks for changes after the owner\'s Approve: nothing is recorded, nothing is declined, the PR stays open', async () => {
  const { t, g, id } = world();
  const { pr } = await openDecision(t.ctx, id);
  g.review(pr, { state: 'APPROVED', commit_id: head(g, pr), submitted_at: t.clock.t + MIN });
  g.review(pr, { user: 777, state: 'CHANGES_REQUESTED', commit_id: head(g, pr), submitted_at: t.clock.t + 2 * MIN });
  const r = await readDecision(t.ctx, id);
  assert.equal(r.counted, false);
  assert.match(r.reason, /changes were requested/);
  assert.deepEqual([ask(t, id).state, ask(t, id).answer, g.pulls.get(pr).state], ['pushed', undefined, 'open']);
});

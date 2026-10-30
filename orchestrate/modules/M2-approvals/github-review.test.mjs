// github-review.test.mjs — R-0b-49: a risky-act approval counts only as the owner's own Approve on GitHub, on that
// exact change (or one it carries over to). The ten test asks of the done_when are the first ten tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGitHub } from './fixtures/fake-github.mjs';
import { makeGitView } from '../M10-rules/git-view.mjs';
import { countApprove, ownerVerdict, requestReview } from './github-review.mjs';
import { APPROVE_AGAIN_LINE } from './kinds.mjs';

const OWNER = 4242;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const MIN = 60_000;

// main M0 → M1 (touches docs/other.md); the change H0 (src/a.mjs) on M0; H1 = the robot's catch-up merge of M1 into H0.
function world() {
  let now = T0;
  const g = fakeGitHub({ ownerId: OWNER, now: () => now });
  const r = g.repo;
  const M0 = r.commit([], { 'src/a.mjs': 'one', 'docs/other.md': 'old' });
  const H0 = r.commit([M0], { 'src/a.mjs': 'two' });
  const M1 = r.commit([M0], { 'docs/other.md': 'new' });
  const H1 = r.commit([H0, M1], { 'docs/other.md': 'new' }, { from: H0 });
  r.main = M1;
  g.openPull({ number: 7, head: H0 });
  const view = makeGitView({ gh: g.gh, owner: 'sample-org', repo: 'sample-app' });
  const w = { g, r, view, M0, M1, H0, H1, setNow: (t) => { now = t; } };
  w.raise = async () => { const x = await requestReview({ gh: g.gh, owner: 'sample-org', repo: 'sample-app', pr: 7, githubId: OWNER }); assert.equal(x.ok, true, x.reason); return x.raised_at; };
  w.count = (raisedAt, catchUps = []) => countApprove({ gh: g.gh, view, owner: 'sample-org', repo: 'sample-app', pr: 7, githubId: OWNER, raisedAt, catchUps });
  w.moveHead = (sha) => { g.pulls.get(7).head = sha; };
  return w;
}

test('1. the owner\'s Approve on the head counts, for that exact head', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  const c = await w.count(raised);
  assert.equal(c.ok, true, c.reason);
  assert.equal(c.head, w.H0);
  assert.equal(c.carried, false);
});

test('2. an Approve on an earlier head carries over a recorded catch-up that touched none of its files', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.moveHead(w.H1);
  const c = await w.count(raised, [{ pr: 7, before_sha: w.H0, after_sha: w.H1 }]);
  assert.equal(c.ok, true, c.reason);
  assert.equal(c.head, w.H1);
  assert.equal(c.carried, true);
});

test('3. an Approve on an older commit whose diff differs is refused', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  const H2 = w.r.commit([w.H0], { 'src/a.mjs': 'three' });
  w.moveHead(H2);
  const c = await w.count(raised, [{ pr: 7, before_sha: w.H0, after_sha: H2 }]);
  assert.equal(c.ok, false);
});

test('4. a review by the robot is not the owner\'s', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { user: w.g.robotId, state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  assert.equal((await w.count(raised)).ok, false);
});

test('5. a review by GitHub\'s Actions robot is not the owner\'s, and nothing of type Bot under the owner\'s id counts', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  assert.equal((await w.count(raised)).ok, false);
  w.g.review(7, { type: 'Bot', state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  assert.equal((await w.count(raised)).ok, false);
});

test('6. a later "changes requested" refuses', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.g.review(7, { state: 'CHANGES_REQUESTED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  const c = await w.count(raised);
  assert.equal(c.ok, false);
  assert.match(c.reason, /changes/);
});

test('7. an Approve given before the ask was raised counts nothing, and the owner is told to Approve again', async () => {
  const w = world();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 - MIN });
  const raised = await w.raise();
  const c = await w.count(raised);
  assert.equal(c.ok, false);
  assert.equal(c.line, APPROVE_AGAIN_LINE);
});

test('8. a reply typed into the Lead\'s terminal never reaches GitHub: nothing counts', async () => {
  const w = world(); const raised = await w.raise();
  // The only "answer" is text in a terminal; GitHub holds no review.
  assert.equal((await w.count(raised)).ok, false);
});

test('9. a dismissed Approve counts nothing; a comment after an Approve does not undo it', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'DISMISSED', commit_id: w.H0, submitted_at: T0 + MIN });
  assert.equal((await w.count(raised)).ok, false);
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  w.g.review(7, { state: 'COMMENTED', commit_id: w.H0, submitted_at: T0 + 3 * MIN });
  assert.equal((await w.count(raised)).ok, true);
});

test('10. a review made through an app under the owner\'s account refuses', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN, app: { id: 1, slug: 'some-app' } });
  assert.equal((await w.count(raised)).ok, false);
});

test('a catch-up that touched the change\'s own file does not carry the Approve over', async () => {
  const w = world();
  const M2 = w.r.commit([w.M1], { 'src/a.mjs': 'main-edit' });
  const H2 = w.r.commit([w.H0, M2], { 'src/a.mjs': 'two', 'docs/other.md': 'new' }, { from: w.H0 });
  w.r.main = M2;
  const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.moveHead(H2);
  assert.equal((await w.count(raised, [{ pr: 7, before_sha: w.H0, after_sha: H2 }])).ok, false);
});

test('a push that is not a recorded catch-up does not carry the Approve over, even with the same files', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.moveHead(w.H1);
  assert.equal((await w.count(raised, [])).ok, false);
});

test('raised time is GitHub\'s record of the review request, not the Mac clock', async () => {
  const w = world();
  w.setNow(T0 + 5 * MIN);
  const raised = await w.raise();
  assert.equal(raised, new Date(T0 + 5 * MIN).toISOString());
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + 4 * MIN });
  assert.equal((await w.count(raised)).ok, false);
});

test('GitHub errors, a closed pull request or a bad raised time count nothing', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  assert.equal((await w.count('not a time')).ok, false);
  w.g.down = true;
  assert.equal((await w.count(raised)).ok, false);
  w.g.down = false;
  w.g.pulls.get(7).state = 'closed';
  assert.equal((await w.count(raised)).ok, false);
});

test('a decision reads "changes requested" as a verdict, not an error', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'CHANGES_REQUESTED', commit_id: w.H0, submitted_at: T0 + MIN, body: 'no' });
  const v = await ownerVerdict({ gh: w.g.gh, owner: 'sample-org', repo: 'sample-app', pr: 7, githubId: OWNER, raisedAt: raised });
  assert.equal(v.verdict, 'changes_requested');
});

test('a dismissed review after an Approve leaves no Approve standing (round 2 m2-4)', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.g.review(7, { state: 'DISMISSED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  assert.equal((await w.count(raised)).ok, false);
});

test('a "Request changes" from any account after the owner\'s Approve refuses; one before it does not (round 1 M4 item 5)', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { user: 777, state: 'CHANGES_REQUESTED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  assert.equal((await w.count(raised)).ok, true);
  w.g.review(7, { user: 777, state: 'CHANGES_REQUESTED', commit_id: w.H0, submitted_at: T0 + 3 * MIN });
  const c = await w.count(raised);
  assert.equal(c.ok, false);
  assert.match(c.reason, /changes were requested after/);
});

test('another account\'s "Request changes", dismissed after the owner\'s Approve, still refuses (audit round 2 m-1)', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.g.review(7, { user: 777, state: 'DISMISSED', commit_id: w.H0, submitted_at: T0 + 2 * MIN });
  assert.equal((await w.count(raised)).ok, false);
});

test('another account\'s "Request changes" in the same second as the owner\'s Approve refuses', async () => {
  const w = world(); const raised = await w.raise();
  w.g.review(7, { state: 'APPROVED', commit_id: w.H0, submitted_at: T0 + MIN });
  w.g.review(7, { user: 777, state: 'CHANGES_REQUESTED', commit_id: w.H0, submitted_at: T0 + MIN });
  assert.equal((await w.count(raised)).ok, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLimits, PR_FACT } from './merges.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, T0, MIN, iso } from './fixtures.test-helper.mjs';

const R = rulesWith();
const ports = (over = {}) => {
  const alerts = [];
  return { alerts, p: { hasSession: () => false, gateAlive: () => true, hasReviewer: () => true, startReviewer: () => ({ ok: true }), alert: (t) => alerts.push(t), ...over } };
};
const at = (min) => iso(T0 + min * MIN);
const pass = (rec, minutesLater, over) => { const { alerts, p } = ports(over); return { moves: timeLimits({ rec, rules: R, now: T0 + minutesLater * MIN, ...p }), alerts }; };

test('v3 §2.4: claimed with no session after 10 min goes back to ready', () => {
  const rec = recWith([['card', 'C-1', { state: 'claimed', changed_at: at(0) }]]);
  pass(rec, 9);
  assert.equal(rec.read('card', 'C-1').doc.state, 'claimed');
  pass(rec, 10, { hasSession: () => true });
  assert.equal(rec.read('card', 'C-1').doc.state, 'claimed');
  pass(rec, 10);
  assert.equal(rec.read('card', 'C-1').doc.state, 'ready');
});

test('v3 §2.4: checking over 30 min is refused{timeout}; the card goes back to verified', () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { head_sha: 'aaa' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(0) }],
  ]);
  pass(rec, 29);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'checking');
  pass(rec, 30);
  assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reason], ['refused', 'timeout']);
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
});

test('a refusal with a stale verdict goes back to in_review; the same reason twice goes to Joe', () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { head_sha: 'old' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(0) }],
    ['merge', 'M-2', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(40) }],
  ]);
  pass(rec, 31);
  assert.equal(rec.read('card', 'C-1').doc.state, 'in_review');
  const { alerts } = pass(rec, 71);
  const c = rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'waiting');
  assert.equal(c.waiting.who, 'joe');
  for (const f of ['who', 'what', 'since', 'next_check']) assert.ok(c.waiting[f], f);
  assert.equal(alerts.length, 1);
});

test('R-0b-57: the Merge Gate killed mid-merge — the next pass records the real outcome from the PR fact', () => {
  const mk = (pr) => recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { head_sha: 'aaa' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'aaa', changed_at: at(0) }],
    ...(pr ? [['fact', PR_FACT(7), pr]] : []),
  ]);
  const dead = { gateAlive: () => false };
  // merged on GitHub
  const a = mk({ state: 'closed', merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(1) });
  pass(a, 2, dead);
  assert.equal(a.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(a.read('merge', 'M-1').doc.merge_commit_sha, 'mmm');
  assert.equal(a.read('card', 'C-1').doc.state, 'merged');
  // not merged
  const b = mk({ state: 'open', merged: false, head_sha: 'aaa', observed_at: at(1) });
  pass(b, 2, dead);
  assert.deepEqual([b.read('merge', 'M-1').doc.state, b.read('merge', 'M-1').doc.reason], ['refused', 'interrupted']);
  assert.equal(b.read('card', 'C-1').doc.state, 'verified');
  // a PR reading older than the attempt's last change: wait a pass
  const c = mk({ state: 'closed', merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(-1) });
  assert.deepEqual(pass(c, 2, dead).moves, [['M-1', 'waiting for a fresh PR reading']]);
  assert.equal(c.read('merge', 'M-1').doc.state, 'merging');
  // no reading at all: wait
  const d = mk(null);
  pass(d, 2, dead);
  assert.equal(d.read('merge', 'M-1').doc.state, 'merging');
  // the Merge Gate alive: leave it alone
  const e = mk({ state: 'open', merged: false, observed_at: at(1) });
  pass(e, 2);
  assert.equal(e.read('merge', 'M-1').doc.state, 'merging');
});

test('m16: merged at a head other than the checked one is recorded merged, with an alert', () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'aaa', changed_at: at(0) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: 'mmm', head_sha: 'bbb', observed_at: at(1) }],
  ]);
  const { alerts } = pass(rec, 2, { gateAlive: () => false });
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /bbb/);
});

test('M11: reconcile both ways — an interrupted attempt whose PR later shows merged becomes merged', () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'verified' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reason: 'interrupted', head_sha: 'aaa', changed_at: at(5) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(4) }],
  ]);
  pass(rec, 6);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused'); // the reading predates the refusal
  rec.write({ actor: 'sensors', entity: 'fact', id: PR_FACT(7), expectRev: 1, doc: { merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(7) } });
  pass(rec, 8);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(rec.read('card', 'C-1').doc.state, 'merged');
  assert.ok(rec.read('fact', 'reconciled-M-1'));
  // a refused{timeout} attempt is not reconciled this way
  const r2 = recWith([['merge', 'M-2', { pr: 8, state: 'refused', reason: 'timeout', changed_at: at(0) }], ['fact', PR_FACT(8), { merged: true, observed_at: at(1) }]]);
  pass(r2, 2);
  assert.equal(r2.read('merge', 'M-2').doc.state, 'refused');
});

test('v3 §2.4: reporting over 10 min fails the card with no_report', () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: at(0) }]]);
  pass(rec, 9);
  assert.equal(rec.read('card', 'C-1').doc.state, 'running');
  pass(rec, 10);
  assert.deepEqual([rec.read('card', 'C-1').doc.state, rec.read('card', 'C-1').doc.reason], ['failed', 'no_report']);
  assert.equal(rec.read('session', 'S-1').doc.state, 'ended');
});

test('v3 §2.4: in_review with no reviewer after 15 min starts one; 2 failed starts go to Joe', () => {
  const rec = recWith([['card', 'C-1', { state: 'in_review', changed_at: at(0) }]]);
  let starts = 0;
  const failing = { hasReviewer: () => false, startReviewer: () => { starts += 1; return { ok: false }; } };
  pass(rec, 14, failing);
  assert.equal(starts, 0);
  pass(rec, 15, failing);
  pass(rec, 31, failing);
  assert.equal(starts, 2);
  const { alerts } = pass(rec, 47, failing);
  assert.equal(starts, 2);
  assert.equal(rec.read('card', 'C-1').doc.state, 'waiting');
  assert.equal(rec.read('card', 'C-1').doc.waiting.who, 'joe');
  assert.equal(alerts.length, 1);
  // a successful start resets the count
  const ok = recWith([['card', 'C-2', { state: 'in_review', changed_at: at(0) }]]);
  pass(ok, 15, { hasReviewer: () => false, startReviewer: () => ({ ok: true }) });
  assert.equal(ok.read('card', 'C-2').doc.reviewer_start_failures, 0);
});

test('every time limit comes from the rules', () => {
  const rec = recWith([['card', 'C-1', { state: 'claimed', changed_at: at(0) }]]);
  timeLimits({ rec, rules: rulesWith({ [K.claimedNoSessionMin]: 2 }), now: T0 + 2 * MIN, ...ports().p });
  assert.equal(rec.read('card', 'C-1').doc.state, 'ready');
  for (const key of [K.claimedNoSessionMin, K.checkingMaxMin, K.reportingMaxMin, K.inReviewNoReviewerMin]) {
    assert.throws(() => timeLimits({ rec: recWith(), rules: rulesWith({ [key]: undefined }), now: T0, ...ports().p }), key);
  }
});

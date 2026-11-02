import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLimits, requestMerges, MERGE_REQUEST, PR_FACT, RECONCILED_FACT, RECONCILE_TELL_FACT } from './merges.mjs';
import { KEYS as K } from './keys.mjs';
import { settleMerge, reconcileMerge, openTooLong, prReadingAfter } from '../M6-merge-gate/merge-outcome.mjs';
import { rulesWith, recWith, change, seed, setClock, undoEntries, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';
import { makeRules } from '../../shared/rules.mjs';

const R = rulesWith();
// Rules with one reading replaced, built on makeRules (L148 item 1): num(), dec() and flag() read through the same
// override, so a test never answers `get` alone while the code reads numbers through num().
const overGet = (base, get) => makeRules({ get rev() { return base.rev; }, may: (a, s) => base.may(a, s), get, classify: (c) => base.classify(c) });
const ports = (over = {}) => {
  const alerts = [];
  return { alerts, p: { gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert: (t) => alerts.push(t), ...over } };
};
const at = (min) => iso(T0 + min * MIN);
const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
// The Record's clock reads the pass's time, as the real one does: its writes in the pass are stamped then.
// Alerts go through the real outbox and are delivered at the end of the pass, as the tick does (L130): `alerts` is
// what was delivered, and a told mark is written only for those. A test that hands its own `alert` keeps it.
const pass = async (rec, minutesLater, over, b = GREEN) => {
  const { alerts, p } = ports(over);
  const now = T0 + minutesLater * MIN;
  setClock(rec.base ?? rec, now);
  if (over?.alert) return { moves: await timeLimits({ rec, rules: R, now, b, ...p }), alerts };
  const moves = await withAlerts(rec.base ?? rec, now, (t) => { alerts.push(t); return true; }, (alert) => timeLimits({ rec, rules: R, now, b, ...p, alert }));
  return { moves, alerts };
};

const HA = 'a'.repeat(40); // the head the gate judged
const HB = 'b'.repeat(40);
const MC = 'c'.repeat(40); // the merge commit
const dead = { gateAlive: () => false };
// Every write the record takes, as [actor, entity, id, state]: a merge's outcome is the Merge Gate's (L74 b3).
function spied(rec) {
  const writes = [];
  const p = { ...rec, base: rec, write: (w) => { const r = rec.write(w); if (r.ok) writes.push([w.actor, w.entity, w.id, w.doc?.state]); return r; } };
  return { rec: p, writes };
}
// M9 lets a card into verified only with a passing verdict for its head now (verdictFor); the stand-in does not count
// verdicts, so this stands in for a head the review no longer covers (the real path is in the contract test).
function noPassingVerdict(rec) {
  return { ...rec, base: rec, write: (w) => (w.entity === 'card' && w.doc?.state === 'verified' && rec.read('card', w.id)?.doc.state !== 'verified'
    ? { ok: false, reason: 'no passing verdict for the head the card has now' } : rec.write(w)) };
}
const merging = (over = {}) => ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', judged_head: HA, changed_at: at(0), ...over }];
const checking = (id = 'M-1', min = 0) => ['merge', id, { card: 'C-1', pr: 7, state: 'checking', judged_head: HA, changed_at: at(min) }];
const cardMerging = ['card', 'C-1', { state: 'merging', head: HA }];

test('v3 §2.4, L74 b3: checking over 30 min is refused (timeout) by the Merge Gate; the card goes back to verified', async () => {
  const { rec, writes } = spied(recWith([cardMerging, checking()]));
  await pass(rec, 29);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'checking');
  const { moves } = await pass(rec, 30);
  assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reasons], ['refused', ['timeout']]);
  const c = rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'verified');
  assert.deepEqual(c.attempts.merge_refusals, ['timeout']);
  assert.deepEqual(moves, [['M-1', 'refused:timeout'], ['C-1', '->verified']]);
  // PLANT (L74 Tier 1, an M11 merge write): the merge and the card's put-back are written as merge_gate, never the Dispatcher.
  assert.deepEqual(writes, [['merge_gate', 'merge', 'M-1', 'refused'], ['merge_gate', 'card', 'C-1', 'verified']]);
});

test('the same refusal reason twice goes to Joe (the gate counts it in attempts.merge_refusals)', async () => {
  const rec = recWith([cardMerging, checking('M-1', 0), checking('M-2', 40)]);
  await pass(rec, 31);
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
  assert.equal(rec.read('merge', 'M-2').doc.state, 'checking');
  change(rec, 'card', 'C-1', { state: 'merging' }); // the gate takes it again
  const { alerts, moves } = await pass(rec, 71);
  const c = rec.read('card', 'C-1').doc;
  assert.deepEqual(c.attempts.merge_refusals, ['timeout', 'timeout']);
  assert.equal(c.state, 'waiting');
  assert.equal(c.wait.who, 'joe');
  for (const f of ['who', 'what', 'since', 'next_check', 'resume', 'return_to']) assert.ok(c.wait[f], f);
  assert.equal(c.wait.return_to, 'verified');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /refused twice for the same reason \(timeout\)/);
  assert.deepEqual(moves.at(-1), ['C-1', 'waiting on joe']);
});

test('a refusal on a head the review no longer covers goes back to in_review (the Record refuses verified)', async () => {
  const rec = noPassingVerdict(recWith([cardMerging, checking()]));
  const { moves } = await pass(rec, 30);
  assert.equal(rec.read('card', 'C-1').doc.state, 'in_review');
  assert.deepEqual(rec.read('card', 'C-1').doc.attempts.merge_refusals, ['timeout']);
  assert.deepEqual(moves, [['M-1', 'refused:timeout'], ['C-1', '->in_review']]);
});

test('R-0b-57: the Merge Gate killed mid-merge: the next pass hands the PR reading to the gate, which records the outcome', async () => {
  const mk = (pr) => spied(recWith([cardMerging, merging(), ...(pr ? [['fact', PR_FACT(7), pr]] : [])]));
  // merged on GitHub, at the judged head
  const a = mk({ state: 'closed', merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(1) });
  await pass(a.rec, 2, dead);
  assert.deepEqual([a.rec.read('merge', 'M-1').doc.state, a.rec.read('merge', 'M-1').doc.merge_commit], ['merged', MC]);
  assert.deepEqual([a.rec.read('card', 'C-1').doc.state, a.rec.read('card', 'C-1').doc.merge_commit], ['merged', MC]);
  assert.deepEqual(a.writes.map(([who]) => who), ['merge_gate', 'merge_gate']);
  // closed and not merged: a final answer, so refused
  const b = mk({ state: 'closed', merged: false, head_sha: HA, observed_at: at(1) });
  const bp = await pass(b.rec, 2, dead);
  assert.deepEqual([b.rec.read('merge', 'M-1').doc.state, b.rec.read('merge', 'M-1').doc.reasons], ['refused', ['interrupted']]);
  assert.equal(b.rec.read('card', 'C-1').doc.state, 'verified');
  assert.deepEqual(bp.alerts, [], 'a closed PR is no news to Joe');
  // a PR reading older than the merge's last write (the Record's clock): wait a pass
  const c = mk({ state: 'closed', merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(-1) });
  assert.deepEqual((await pass(c.rec, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
  assert.equal(c.rec.read('merge', 'M-1').doc.state, 'merging');
  // no reading at all: wait
  const d = mk(null);
  await pass(d.rec, 2, dead);
  assert.equal(d.rec.read('merge', 'M-1').doc.state, 'merging');
  // the Merge Gate alive: leave it alone
  const e = mk({ state: 'open', merged: false, head_sha: HA, observed_at: at(1) });
  await pass(e.rec, 2);
  assert.equal(e.rec.read('merge', 'M-1').doc.state, 'merging');
  assert.deepEqual([c.writes, d.writes, e.writes], [[], [], []]);
});

test('m16, L74 b3: merged at a head the gate did not judge is refused by the gate, told, and the card put back', async () => {
  const rec = recWith([cardMerging, merging(), ['fact', PR_FACT(7), { merged: true, merge_commit_sha: MC, head_sha: HB, observed_at: at(1) }]]);
  const { alerts } = await pass(rec, 2, dead);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
  assert.match(rec.read('merge', 'M-1').doc.reasons[0], /merged outside the gate/);
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^merge gate: .*bbbbbbb.*\(merge M-1\)$/);
});

// L85 M-1: an interrupted merge is never recorded refused while its outcome is unknown, and one GitHub later shows
// merged at the judged head is reconciled to merged by the Merge Gate (M6 reconcileMerge).
const gone = () => spied(recWith([cardMerging, merging()]));
const reading = (rec, min, f) => { setClock(rec.base ?? rec, T0 + min * MIN); seedOrChange(rec.base ?? rec, { head_sha: HA, observed_at: at(min), ...f }); };
function seedOrChange(rec, f) { if (rec.read('fact', PR_FACT(7))) change(rec, 'fact', PR_FACT(7), f); else seed(rec, 'fact', PR_FACT(7), f); }
const states = (rec) => [rec.read('merge', 'M-1').doc.state, rec.read('card', 'C-1').doc.state];

test('L85 M-1 (a): open, then merged: it waits while the PR is open, then ends merged with the audit queued', async () => {
  const { rec, writes } = gone();
  reading(rec, 0.1, { state: 'open', merged: false });
  const p1 = await pass(rec, 1, dead);
  assert.deepEqual(p1.moves, [['M-1', 'merge outcome not known yet: the PR is still open']]);
  assert.deepEqual([states(rec), writes, p1.alerts], [['merging', 'merging'], [], []]);
  reading(rec, 2, { state: 'closed', merged: true, merge_commit_sha: MC });
  await pass(rec, 3, dead);
  assert.deepEqual(states(rec), ['merged', 'merged']);
  // the audit is queued: the gate's audit pass takes every merged merge with its merge commit (M6 gate.mjs)
  assert.equal(rec.read('merge', 'M-1').doc.merge_commit, MC);
  assert.equal(rec.read('card', 'C-1').doc.merge_commit, MC);
});

test('L85 M-1 (a): still open past timeouts.merging_open_max_min after the merging write: refused-interrupted, Joe told', async () => {
  const { rec } = gone();
  reading(rec, 14, { state: 'open', merged: false });
  await pass(rec, 14.5, dead);
  assert.deepEqual(states(rec), ['merging', 'merging'], 'under the limit');
  reading(rec, 15, { state: 'open', merged: false });
  const { alerts } = await pass(rec, 15.5, dead);
  assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reasons], ['refused', ['interrupted']]);
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /merge M-1: the Merge Gate stopped mid-merge and PR 7 is still open after 15 min/);
  // a reading with no state is no final answer either
  const u = gone();
  reading(u.rec, 1, { merged: false });
  await pass(u.rec, 2, dead);
  assert.deepEqual(states(u.rec), ['merging', 'merging']);
});

test('L89: no fresh PR reading past timeouts.merging_open_max_min: still merging, Joe told once', async () => {
  // The Merge Gate stopped mid-merge and the Sensors never read the PR again (the limit is 15 min).
  const { rec } = gone();
  const p1 = await pass(rec, 14, dead);
  assert.deepEqual([p1.moves, p1.alerts], [[['M-1', 'waiting for a fresh PR reading']], []], 'under the limit: wait, no alert');
  const p2 = await pass(rec, 20, dead);
  assert.deepEqual(states(rec), ['merging', 'merging'], 'the outcome is unknown, so the merge stays merging');
  assert.equal(p2.alerts.length, 1);
  assert.match(p2.alerts[0], /merge M-1: the Merge Gate stopped mid-merge and PR 7 has had no fresh reading for 20 min/);
  const p3 = await pass(rec, 40, dead);
  assert.deepEqual([states(rec), p3.alerts], [['merging', 'merging'], []], 'told once');
  // A reading that comes after all settles it as before.
  reading(rec, 41, { state: 'closed', merged: true, merge_commit_sha: MC });
  await pass(rec, 42, dead);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
});

test('L85 M-1: M6 itself never records refused on an open reading unless the Dispatcher says it is open too long', () => {
  const rec = recWith([cardMerging, merging()]);
  const open = { state: 'open', merged: false, head_sha: HA };
  const r = settleMerge({ record: rec, now: T0 }, 'M-1', { pr: open, reason: 'interrupted' });
  assert.deepEqual([r.ok, rec.read('merge', 'M-1').doc.state], [false, 'merging']);
  assert.match(r.reason, /outcome is not known yet: PR 7 is still open/);
  assert.equal(settleMerge({ record: rec, now: T0 }, 'M-1', { pr: { merged: false }, reason: 'interrupted' }).ok, false, 'no state is no answer');
  assert.equal(settleMerge({ record: rec, now: T0 }, 'M-1', { pr: open, reason: 'interrupted', openTooLong: true }).outcome, 'refused');
  // reconcile acts only on an interrupted merge
  const t = recWith([['merge', 'M-2', { pr: 8, state: 'refused', reasons: ['timeout'], judged_head: HA }]]);
  assert.match(reconcileMerge({ record: t, now: T0 }, 'M-2', { pr: { merged: true, merge_commit_sha: MC, head_sha: HA } }).reason, /not an interrupted merge/);
});

test('L85 M-1 (b): open past the limit, then merged: refused-interrupted is reconciled to merged', async () => {
  const { rec, writes } = gone();
  reading(rec, 15, { state: 'open', merged: false });
  await pass(rec, 16, dead);
  assert.deepEqual(states(rec), ['refused', 'verified']);
  reading(rec, 17, { state: 'closed', merged: true, merge_commit_sha: MC });
  const { moves, alerts } = await pass(rec, 18);
  assert.deepEqual(moves, [['M-1', 'interrupted, then merged: reconciled'], ['C-1', '->merged']]);
  assert.deepEqual(states(rec), ['merged', 'merged']);
  assert.deepEqual([rec.read('merge', 'M-1').doc.merge_commit, rec.read('card', 'C-1').doc.merge_commit], [MC, MC]);
  assert.deepEqual(alerts, []);
  // only the Merge Gate writes it
  assert.deepEqual(writes.slice(-2), [['merge_gate', 'merge', 'M-1', 'merged'], ['merge_gate', 'card', 'C-1', 'merged']]);
  assert.equal(rec.read('fact', RECONCILED_FACT('M-1')), null);
});

test('L85 M-1 (b): an interrupted merge GitHub shows merged at an unjudged head stays refused; the owner is told once', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'verified', head: HA }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reasons: ['interrupted'], judged_head: HA, changed_at: at(5) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: MC, head_sha: HB, observed_at: at(4) }],
  ]);
  assert.deepEqual((await pass(rec, 6)).alerts, [], 'the reading predates the refusal');
  change(rec, 'fact', PR_FACT(7), { observed_at: at(7) });
  const { alerts } = await pass(rec, 8);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /merge gate: .*bbbbbbb.*not the judged aaaaaaa.*merge M-1 stays refused/);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
  assert.ok(rec.read('fact', RECONCILED_FACT('M-1')));
  assert.deepEqual((await pass(rec, 9)).alerts, [], 'told once');
  // no merge commit in the reading: the same
  const r3 = recWith([['card', 'C-3', { state: 'verified', head: HA }], ['merge', 'M-3', { card: 'C-3', pr: 9, state: 'refused', reasons: ['interrupted'], judged_head: HA, changed_at: at(0) }], ['fact', PR_FACT(9), { merged: true, head_sha: HA, observed_at: at(1) }]]);
  assert.equal((await pass(r3, 2)).alerts.length, 1);
  assert.equal(r3.read('merge', 'M-3').doc.state, 'refused');
  // a refused{timeout} merge is not reconciled, but no refusal wording is silent (L94 point 3): the owner is told once
  const r2 = recWith([['merge', 'M-2', { pr: 8, state: 'refused', reasons: ['timeout'], changed_at: at(0) }], ['fact', PR_FACT(8), { merged: true, observed_at: at(1) }]]);
  const told = (await pass(r2, 2)).alerts;
  assert.deepEqual(told, ['merge M-2 was refused (timeout) but PR 8 shows merged; check the card and its audit']);
  assert.equal(r2.read('merge', 'M-2').doc.state, 'refused');
  assert.ok(r2.read('fact', RECONCILED_FACT('M-2')));
  assert.deepEqual((await pass(r2, 3)).alerts, [], 'told once');
});

test('L94 point 3: a refused merge whose PR another merge already landed is neither reconciled nor told; the gate\'s own "merged outside" refusal is not told twice', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merged', head: HA, merge_commit: MC }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reasons: ['interrupted'], judged_head: HA, changed_at: at(0) }],
    ['merge', 'M-2', { card: 'C-1', pr: 7, state: 'merged', judged_head: HA, merge_commit: MC, changed_at: at(2) }],
    ['fact', PR_FACT(7), { state: 'closed', merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(3) }],
    ['merge', 'M-3', { card: 'C-3', pr: 9, state: 'refused', reasons: ['merged outside the gate, at a head the gate did not judge'], judged_head: HA, changed_at: at(0) }],
    ['fact', PR_FACT(9), { state: 'closed', merged: true, merge_commit_sha: MC, head_sha: HB, observed_at: at(3) }],
  ]);
  const { moves, alerts } = await pass(rec, 4);
  assert.deepEqual(alerts, []);
  assert.deepEqual(moves.filter(([id]) => id === 'M-1' || id === 'M-3'), []);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
});

test('v3 §2.4: reporting over 10 min fails the card with no_report', async () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: at(0) }]]);
  await pass(rec, 9);
  assert.equal(rec.read('card', 'C-1').doc.state, 'running');
  await pass(rec, 10);
  assert.deepEqual([rec.read('card', 'C-1').doc.state, rec.read('card', 'C-1').doc.failure], ['failed', 'no_report']);
  assert.equal(rec.read('session', 'S-1').doc.state, 'ended');
});

test('v3 §2.4, L65: in_review with no reviewer after 15 min asks for one; 2 failed requests go to Joe', async () => {
  const rec = recWith([['card', 'C-1', { state: 'in_review', head: HA, changed_at: at(0) }]]);
  let starts = 0;
  const failing = { hasReviewer: () => false, requestReview: () => { starts += 1; return { ok: false, reason: 'the folder is full' }; } };
  await pass(rec, 14, failing);
  assert.equal(starts, 0);
  await pass(rec, 15, failing);
  assert.equal(rec.read('card', 'C-1').doc.attempts.reviewer_starts, 1);
  await pass(rec, 29, failing);
  assert.equal(starts, 1, 'the request resets the clock (the Record\'s own time of the last write)');
  await pass(rec, 31, failing);
  assert.equal(starts, 2);
  const { alerts } = await pass(rec, 47, failing);
  assert.equal(starts, 2);
  assert.equal(rec.read('card', 'C-1').doc.state, 'waiting');
  assert.equal(rec.read('card', 'C-1').doc.wait.who, 'joe');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /card C-1: no reviewer could be asked for twice/);
  // a request written resets the count
  const ok = recWith([['card', 'C-2', { state: 'in_review', head: HA, changed_at: at(0), attempts: { reviewer_starts: 1 } }]]);
  const { moves } = await pass(ok, 15, { hasReviewer: () => false, requestReview: () => ({ ok: true }) });
  assert.deepEqual(moves.find(([id]) => id === 'C-2'), ['C-2', 'reviewer requested']);
  assert.equal(ok.read('card', 'C-2').doc.attempts.reviewer_starts, 0);
});

test('L85 m-1: a reviewer that never shows up is asked for once per time limit, also after the second request', async () => {
  const rec = recWith([['card', 'C-1', { state: 'in_review', head: HA, changed_at: at(0) }]]);
  let starts = 0;
  const quiet = { hasReviewer: () => false, requestReview: () => { starts += 1; return { ok: true }; } };
  for (let m = 15; m <= 50; m += 1) await pass(rec, m, quiet);
  // requests at 15, 30 and 45: three passes' worth, one a limit apart
  assert.equal(starts, 3);
  assert.deepEqual(rec.read('card', 'C-1').doc.attempts, { reviewer_starts: 0, review_requests: 3 });
});

// Each limit's world: what it times, made past every default limit, and how to tell it was left alone.
const LIMIT_WORLDS = {
  [K.checkingMaxMin]: { rows: (pr) => [['card', 'C-1', { state: 'merging', head: HA, ...pr }], checking()], id: 'M-1',
    untouched: (rec) => rec.read('merge', 'M-1').doc.state === 'checking', timed: (rec) => rec.read('merge', 'M-1').doc.state === 'refused' },
  [K.reportingMaxMin]: { rows: (pr) => [['card', 'C-1', { state: 'running', ...pr }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: at(0) }]], id: 'S-1',
    untouched: (rec) => rec.read('session', 'S-1').doc.state === 'reporting', timed: (rec) => rec.read('card', 'C-1').doc.failure === 'no_report' },
  [K.inReviewNoReviewerMin]: { rows: (pr) => [...(pr.product ? [['product', pr.product, { state: 'active' }]] : []), ['card', 'C-1', { state: 'in_review', head: HA, tier: 2, changed_at: at(0), ...pr }]], id: 'C-1',
    untouched: (rec) => !rec.read('card', 'C-1').doc.attempts, timed: (rec) => rec.read('card', 'C-1').doc.attempts?.review_requests === 1 },
  [K.mergingOpenMaxMin]: { rows: (pr) => [['card', 'C-1', { state: 'merging', head: HA, ...pr }], merging(), ['fact', PR_FACT(7), { state: 'open', merged: false, head_sha: HA, observed_at: at(59) }]], id: 'M-1',
    untouched: (rec) => rec.read('merge', 'M-1').doc.state === 'merging', timed: (rec) => rec.read('merge', 'M-1').doc.state === 'refused' },
};
const LIMITS = Object.keys(LIMIT_WORLDS);
const timeAt60 = async (rec, rules, missing = []) => {
  setClock(rec, T0 + 60 * MIN);
  const moves = await timeLimits({ rec, rules, now: T0 + 60 * MIN, b: GREEN, ...ports({ hasReviewer: () => false, ...dead }).p, missing });
  return { moves, missing };
};

test('every time limit comes from the rules, for the product of the card it times, read where it is used (L110, L116 m2, m3, c1)', async () => {
  for (const key of LIMITS) {
    const w = LIMIT_WORLDS[key];
    // A limit the rules lack: nothing it would time is touched, and the key goes back, with the product, for the tick
    // to tell Joe once.
    for (const [pr, named] of [[{}, key], [{ product: 'P-1' }, `${key} for P-1`]]) {
      const rec = recWith(w.rows(pr));
      const { moves, missing } = await timeAt60(rec, rulesWith({ [key]: undefined }));
      assert.deepEqual(missing, [named], key);
      assert.equal(w.untouched(rec), true, `${key}: no limit, so nothing is timed out`);
      const none = `no time limit: the rules have no ${key} for ${pr.product ?? 'its product'}`;
      assert.equal(moves.length, 1, `${key}: ${JSON.stringify(moves)}`);
      assert.deepEqual(moves[0][0], w.id);
      assert.ok(moves[0][1].endsWith(none), `${key}: ${moves[0][1]}`);
    }
    // Only the step that needs a missing key is skipped: every other limit still times its own entry (L116 m2).
    for (const other of LIMITS.filter((k) => k !== key)) {
      const o = LIMIT_WORLDS[other];
      const rec = recWith(o.rows({}));
      const { missing } = await timeAt60(rec, rulesWith({ [key]: undefined }));
      assert.equal(o.timed(rec), true, `${other} times its entry though the rules lack ${key}`);
      assert.deepEqual(missing, [], `${other}: ${key} is never read`);
    }
    // The limits are per-product keys, which M10's engine answers only for a named product: an entry is timed by its
    // card's product's limit, and rules that answer only another product's time nothing (L116 m3: every loop).
    const onlyFor = (who) => overGet(R, (k, opts) => (LIMITS.includes(k) && opts?.product !== who ? undefined : R.get(k, opts)));
    for (const [who, timed, lacks] of [['P-2', false, [`${key} for P-1`]], ['P-1', true, []]]) {
      const rec = recWith(w.rows({ product: 'P-1' }));
      const { missing } = await timeAt60(rec, onlyFor(who));
      assert.equal(w.timed(rec), timed, `${key}: rules for ${who}`);
      assert.deepEqual(missing, lacks, `${key}: rules for ${who}`);
    }
  }
  const rec = recWith([cardMerging, checking()]);
  await timeLimits({ rec, rules: rulesWith({ [K.checkingMaxMin]: 2 }), now: T0 + 2 * MIN, b: GREEN, ...ports().p });
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
});

test('L116 m2: a merge GitHub has finished is settled with no limit read; L116 m7: a reporting session with no card is its own note', async () => {
  const none = overGet(R, (k, o) => (LIMITS.includes(k) ? undefined : R.get(k, o)));
  for (const [f, want] of [[{ state: 'closed', merged: true, merge_commit_sha: MC }, 'merged'], [{ state: 'closed', merged: false }, 'refused']]) {
    const rec = recWith([['card', 'C-1', { state: 'merging', head: HA, product: 'P-1' }], merging(), ['fact', PR_FACT(7), { head_sha: HA, observed_at: at(59), ...f }]]);
    const { missing } = await timeAt60(rec, none);
    assert.equal(rec.read('merge', 'M-1').doc.state, want, JSON.stringify(f));
    assert.deepEqual(missing, [], 'no limit is read to settle a final answer');
  }
  // A session in reporting that names no card has no product: no product's limit applies, and no value is missing.
  const rec = recWith([['session', 'S-1', { state: 'reporting', changed_at: at(0) }]]);
  const { moves, missing } = await timeAt60(rec, none);
  assert.deepEqual(moves, [['S-1', 'no time limit: the session names no card, so no product\'s limit applies']]);
  assert.deepEqual(missing, []);
  assert.equal(rec.read('session', 'S-1').doc.state, 'reporting');
});

test('audit MAT-5: a reviewer start goes through the start gate: red holds it unless red_runs lists reviews', async () => {
  const RED = { band: 'red', own_building: 'open', prodBlocked: false };
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'in_review', product: 'p1', tier: 2, head: HA, changed_at: at(0) }]]);
  let starts = 0;
  const p = { ...ports({ hasReviewer: () => false, requestReview: () => { starts += 1; return { ok: true }; } }).p };
  const held = await timeLimits({ rec, rules: rulesWith({ [K.redRuns]: ['merges'] }), now: T0 + 15 * MIN, b: RED, ...p });
  assert.equal(starts, 0);
  assert.match(held.find(([id]) => id === 'C-1')[1], /reviewer held/);
  await timeLimits({ rec, rules: rulesWith({ [K.redRuns]: ['reviews'] }), now: T0 + 15 * MIN, b: RED, ...p });
  assert.equal(starts, 1);
});

// ---- merge requests: the card's pull request is Sensors' reading for its head, its session its newest worker launch ----

const launch = (card, sid, min = -60, head = HA) => ['launch', `L-${sid}`, { session_id: sid, role: 'worker', card, head, rev: 1, launched_at: at(min) }];
const prSeen = (n, head = HA) => ['fact', PR_FACT(n), { state: 'open', merged: false, head_sha: head, observed_at: at(-1) }];
const readyRec = (extra = {}, more = [launch('C-1', 'S-9'), prSeen(7)]) => recWith([['product', 'p1', { state: 'active' }],
  ['card', 'C-1', { state: 'verified', product: 'p1', tier: 2, head: HA, ...extra }], ...more]);
const requests = (rec) => rec.list('merge_request').map((q) => q.doc);
const RISKY = (risky) => ({ classify: () => ({ tier: 1, risky, reasons: {} }) });
// requestMerges has no quiet alert default (L116 m4): a test that expects no alert fails on one.
const noAlert = (t) => assert.fail(`unexpected alert: ${t}`);
// The gate ends the merge it made from the newest request (L138 MAT-2): every put-back, refused or not, ends one.
const endMerge = (rec, reasons = ['refused']) => {
  const q = rec.list('merge_request').map((x) => x.id).sort().at(-1);
  seed(rec, 'merge', `merge-${q}`, { state: 'refused', card: rec.read('merge_request', q).doc.card, pr: 7, request: q, reasons, catch_ups: [] });
};

test('audit MAT-5: a merge request is held in red without merges, and for Tier-1 production work above 90%; otherwise written once', () => {
  const RED = { band: 'red', own_building: 'open', prodBlocked: false };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  const a = readyRec();
  assert.match(requestMerges({ alert: noAlert, rec: a, rules: rulesWith({ [K.redRuns]: ['reviews'] }), now: T0, b: RED })[0][1], /merge request held/);
  assert.deepEqual(requests(a), []);
  const b = readyRec({ tier: 1 });
  assert.match(requestMerges({ alert: noAlert, rec: b, rules: rulesWith({}, {}, RISKY(['production_data'])), now: T0, b: OVER90 })[0][1], /merge request held/);
  assert.deepEqual(requests(b), []);
  const c = readyRec();
  assert.deepEqual(requestMerges({ alert: noAlert, rec: c, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  const rev = c.read('card', 'C-1').rev;
  const mr = c.read('merge_request', MERGE_REQUEST('C-1', HA, 0)).doc;
  assert.deepEqual([mr.card, mr.pr, mr.session_id, mr.head, mr.rev], ['C-1', 7, 'S-9', HA, rev]);
  assert.equal(c.meta('merge_request', MERGE_REQUEST('C-1', HA, 0)).createdBy, 'dispatcher');
  assert.deepEqual(requestMerges({ alert: noAlert, rec: c, rules: R, now: T0, b: GREEN }), []);
});

test('L129: an edit to the card at the same head makes no second request; a refusal the gate records does', () => {
  const rec = readyRec();
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  assert.ok(rec.read('merge_request', 'mr-C-1-' + HA.slice(0, 12) + '-r0'), 'the id names the head and the refusal count');
  // An edit that is not a refusal: a new rev, the same head (the Dispatcher's own ask count).
  const rev0 = rec.read('card', 'C-1').rev;
  change(rec, 'card', 'C-1', { attempts: { merge_asks: 0 } });
  assert.ok(rec.read('card', 'C-1').rev > rev0, 'the card has a new rev');
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0 + MIN, b: GREEN }), []);
  assert.equal(requests(rec).length, 1, 'no second request for an edit');
  endMerge(rec, ['GitHub did not merge the judged head']);
  change(rec, 'card', 'C-1', { attempts: { merge_asks: 0, merge_refusals: ['GitHub did not merge the judged head'] } });
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0 + 2 * MIN, b: GREEN }), [['C-1', 'merge requested again']]);
  assert.ok(rec.read('merge_request', MERGE_REQUEST('C-1', HA, 1)));
  assert.equal(requests(rec).length, 2);
});

test('L72: the session is the newest worker launch for the card, and the pull request the one Sensors reading at its head', () => {
  // the newest of two launches; another card's and a reviewer's launch don't count
  const rec = readyRec({}, [launch('C-1', 'S-8', -90), launch('C-1', 'S-9', -30), launch('C-2', 'S-7', -10),
    ['launch', 'L-R-1', { session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HA, rev: 1, launched_at: at(-5) }], prSeen(7), prSeen(8, HB)]);
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  assert.deepEqual(requests(rec).map((q) => [q.session_id, q.pr]), [['S-9', 7]]);
  // no reading at the head, or no worker launch: not ready
  assert.match(requestMerges({ alert: noAlert, rec: readyRec({}, [launch('C-1', 'S-9'), prSeen(7, HB)]), rules: R, now: T0, b: GREEN })[0][1], /needs a pull request and its session/);
  assert.match(requestMerges({ alert: noAlert, rec: readyRec({}, [prSeen(7)]), rules: R, now: T0, b: GREEN })[0][1], /needs a pull request and its session/);
  // two readings at the head: not guessed
  assert.match(requestMerges({ alert: noAlert, rec: readyRec({}, [launch('C-1', 'S-9'), prSeen(7), prSeen(9)]), rules: R, now: T0, b: GREEN })[0][1], /2 pull requests show head aaaaaaa/);
});

test('audit MIN-18 / MIN-19: after a gate crash only merged === true counts, and only a reading newer than the last write', async () => {
  const mk = (pr) => recWith([cardMerging, merging(), ['fact', PR_FACT(7), pr]]);
  for (const merged of [undefined, 'true', 1]) {
    const rec = mk({ state: 'closed', ...(merged === undefined ? {} : { merged }), merge_commit_sha: MC, head_sha: HA, observed_at: at(1) });
    await pass(rec, 2, dead);
    assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reasons], ['refused', ['interrupted']], String(merged));
    assert.notEqual(rec.read('card', 'C-1').doc.state, 'merged');
  }
  // a reading at the same moment as the last write is not fresh
  const same = mk({ merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(0) });
  assert.deepEqual((await pass(same, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
  // a reading with no time is never fresh
  const none = mk({ merged: true, merge_commit_sha: MC, head_sha: HA });
  assert.deepEqual((await pass(none, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
});

test('audit 0b-6 r2 MAT-4 / MAT-6 / MIN-9: an undo is requested in red, unknown and above 90%; a refused request is asked again at the new rev; no head, no request', () => {
  const RED = { band: 'red', own_building: 'open', prodBlocked: true };
  const UNKNOWN = { band: 'unknown', own_building: 'unknown', prodBlocked: true };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  const risky = rulesWith({ [K.redRuns]: [] }, {}, RISKY(['schema']));
  for (const b of [RED, UNKNOWN, OVER90]) {
    const rec = recWith([['product', 'p1', { state: 'active' }], ...undoEntries('U-1', { state: 'verified', tier: 1, head: HA }), launch('U-1', 'S-9'), prSeen(7)]);
    assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: risky, now: T0, b }).filter(([id]) => id === 'U-1'), [['U-1', 'merge requested']], b.band);
    // the same card, not an undo, is held
    assert.match(requestMerges({ alert: noAlert, rec: readyRec({ tier: 1 }), rules: risky, now: T0, b })[0][1], /merge request held/, b.band);
  }
  // MAT-6: the card changes (a new rev) -> a new request at that rev, once.
  const rec = readyRec();
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  endMerge(rec, ['stale']);
  change(rec, 'card', 'C-1', { attempts: { merge_refusals: ['stale'] } });
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0 + MIN, b: GREEN }), [['C-1', 'merge requested again']]);
  assert.ok(rec.read('merge_request', MERGE_REQUEST('C-1', HA, 1)));
  assert.equal(requests(rec).length, 2, 'the first request is kept as it was (create-only)');
  assert.deepEqual(requestMerges({ alert: noAlert, rec, rules: R, now: T0 + 2 * MIN, b: GREEN }), [], 'once per refusal');
  // MIN-9: a card that names no head of its own is not requested.
  const nohead = readyRec({ head: undefined });
  assert.match(requestMerges({ alert: noAlert, rec: nohead, rules: R, now: T0, b: GREEN })[0][1], /names no head/);
  assert.deepEqual(requests(nohead), []);
});

test('L110 m-1: the gate refusing the same merge twice in a row (here GitHub\'s 405) goes to Joe once, never requested again in a loop', () => {
  const NO = 'GitHub refused the merge (405: Base branch was modified)';
  const rec = readyRec();
  const alerts = [];
  const go = (min) => requestMerges({ rec, rules: R, now: T0 + min * MIN, b: GREEN, alert: (t) => alerts.push(t) });
  assert.deepEqual(go(0), [['C-1', 'merge requested']]);
  // The gate refuses it (land(): settleMerge puts the card back to verified with the reason): it is asked again once.
  endMerge(rec, [NO]);
  change(rec, 'card', 'C-1', { attempts: { merge_refusals: [NO] } });
  assert.deepEqual(go(1), [['C-1', 'merge requested again']]);
  // Refused again for the same reason: Joe is asked, and no third request is written.
  endMerge(rec, [NO]);
  change(rec, 'card', 'C-1', { attempts: { merge_refusals: [NO, NO] } });
  assert.deepEqual(go(2), [['C-1', 'waiting on joe']]);
  const c = rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'waiting');
  assert.equal(c.wait.who, 'joe');
  assert.equal(c.wait.what, `merge refused twice: ${NO}`);
  assert.equal(c.wait.link, 'PR 7');
  assert.equal(c.attempts.merge_asks, 2);
  assert.equal(requests(rec).length, 2);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /refused twice for the same reason \(GitHub refused the merge \(405/);
  // Later passes while he decides: nothing more, no new alert.
  assert.deepEqual(go(3), []);
  assert.equal(alerts.length, 1);
  // He answers (the card back to verified): it is requested again, and not sent straight back to him.
  change(rec, 'card', 'C-1', { state: 'verified', wait: undefined });
  assert.deepEqual(go(4), [['C-1', 'merge requested again']]);
  assert.equal(alerts.length, 1);
  // A third refusal for the same reason is a new repeat: asked once more.
  change(rec, 'card', 'C-1', { attempts: { ...rec.read('card', 'C-1').doc.attempts, merge_refusals: [NO, NO, NO] } });
  assert.deepEqual(go(5), [['C-1', 'waiting on joe']]);
  assert.equal(rec.read('card', 'C-1').doc.attempts.merge_asks, 3);
  assert.equal(alerts.length, 2);
  // Not in a row (a, b, a): requested again, no ask.
  const mixed = readyRec();
  change(mixed, 'card', 'C-1', { attempts: { merge_refusals: [NO, 'timeout', NO] } });
  assert.deepEqual(requestMerges({ alert: noAlert, rec: mixed, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
});

// The shared decision functions both the gate and this file use (L94), each case alone (L110 m-6).
test('L110 m-6 (G11): an age the Record can\'t give counts as too long; an unknown limit never fires', () => {
  const LIMIT = 30 * MIN;
  const young = { meta: () => ({ ts: iso(T0) }) };
  assert.equal(openTooLong(young, 'M-1', T0 + LIMIT - 1, LIMIT), false);
  assert.equal(openTooLong(young, 'M-1', T0 + LIMIT, LIMIT), true);
  for (const [name, rec] of [['no entry', { meta: () => null }], ['an unreadable time', { meta: () => ({ ts: 'not a time' }) }], ['no meta at all', {}]]) {
    assert.equal(openTooLong(rec, 'M-1', T0, LIMIT), true, name);
  }
  assert.equal(openTooLong({ meta: () => null }, 'M-1', T0, NaN), false, 'no limit: it waits, never fires');
});

test('L110 m-6 (G13): a pull request reading counts only when Sensors made it, and after the merge\'s last write', () => {
  const reading = { state: 'open', merged: false, head_sha: HA, observed_at: at(5) };
  const recBy = (createdBy, mergeTs = at(0)) => ({
    read: (e, id) => (e === 'fact' && id === PR_FACT(7) ? { id, rev: 1, doc: reading } : null),
    meta: (e) => (e === 'fact' ? { createdBy } : { ts: mergeTs }),
  });
  assert.deepEqual(prReadingAfter(recBy('sensors'), 7, 'M-1'), reading);
  assert.equal(prReadingAfter(recBy('dispatcher'), 7, 'M-1'), null, 'another role\'s pr- reading is not Sensors\'');
  assert.equal(prReadingAfter(recBy(null), 7, 'M-1'), null, 'a maker the Record can\'t name is not Sensors');
  assert.equal(prReadingAfter(recBy('sensors', at(6)), 7, 'M-1'), null, 'a reading from before the merge\'s last write');
  assert.equal(prReadingAfter(recBy('sensors'), null, 'M-1'), null, 'no pull request number');
});

test('audit 0b-6 r3 MAT-3: a rules value the gate lacks is handed back to the tick, by the time limits and by the merge requests', async () => {
  const rules = rulesWith({ [K.redRuns]: undefined });
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'in_review', product: 'p1', tier: 2, head: HA, changed_at: at(0) }]]);
  const missing = [];
  const moves = await timeLimits({ rec, rules, now: T0 + 15 * MIN, b: GREEN, ...ports({ hasReviewer: () => false }).p, missing });
  assert.match(moves[0][1], /reviewer held/);
  assert.deepEqual(missing, [K.redRuns]);
  const missing2 = [];
  assert.match(requestMerges({ alert: noAlert, rec: readyRec(), rules, now: T0, b: GREEN, missing: missing2 })[0][1], /merge request held/);
  assert.deepEqual(missing2, [K.redRuns]);
});

// ---- L65: the Dispatcher only asks; the review runner (as `review`) starts ----

const HEAD = '0123456789abcdef'.repeat(3).slice(0, 40);

test('L65: a card in review is asked a reviewer for, at its head; a Tier-1 card an auditor too (m-6)', async () => {
  const asked = [];
  const requestReview = (x) => { asked.push(x); return { ok: true }; };
  const rec = recWith([
    ['card', 'C-1', { state: 'in_review', head: HEAD, tier: 2, changed_at: at(0) }],
    ['card', 'C-2', { state: 'in_review', head: HEAD, tier: 1, changed_at: at(0) }],
  ]);
  const seen = [];
  const { moves } = await pass(rec, 15, { hasReviewer: (card, role, head) => { seen.push([card, role, head]); return false; }, requestReview });
  assert.deepEqual(asked, [{ card: 'C-1', head: HEAD, role: 'reviewer' }, { card: 'C-2', head: HEAD, role: 'reviewer' }, { card: 'C-2', head: HEAD, role: 'auditor' }]);
  assert.deepEqual(seen, [['C-1', 'reviewer', HEAD], ['C-2', 'reviewer', HEAD], ['C-2', 'auditor', HEAD]]);
  assert.deepEqual(moves.filter(([id]) => id.startsWith('C-')), [['C-1', 'reviewer requested'], ['C-2', 'reviewer requested, auditor requested']]);
  // The request resets the clock: nothing is asked again until a full limit later.
  asked.length = 0;
  await pass(rec, 29, { hasReviewer: () => false, requestReview });
  assert.deepEqual(asked, []);
  // A Tier-1 card with its reviewer running asks only for the auditor; with both running, nothing.
  const r2 = recWith([['card', 'C-3', { state: 'in_review', head: HEAD, tier: 1, changed_at: at(0) }]]);
  await pass(r2, 15, { hasReviewer: (c, role) => role === 'reviewer', requestReview });
  assert.deepEqual(asked, [{ card: 'C-3', head: HEAD, role: 'auditor' }]);
  asked.length = 0;
  const r3 = recWith([['card', 'C-4', { state: 'in_review', head: HEAD, tier: 1, changed_at: at(0) }]]);
  await pass(r3, 15, { hasReviewer: () => true, requestReview });
  assert.deepEqual(asked, []);
  // One role's request failing counts as a failed request.
  const r4 = recWith([['card', 'C-5', { state: 'in_review', head: HEAD, tier: 1, changed_at: at(0) }]]);
  const m4 = await pass(r4, 15, { hasReviewer: () => false, requestReview: ({ role }) => (role === 'auditor' ? { ok: false, reason: 'full' } : { ok: true }) });
  assert.deepEqual(m4.moves.find(([id]) => id === 'C-5'), ['C-5', 'reviewer requested, auditor request failed: full']);
  assert.equal(r4.read('card', 'C-5').doc.attempts.reviewer_starts, 1);
});

test('L65: a status that can\'t be trusted asks for nothing, and the pass ends with that error after the other limits', async () => {
  for (const hasReviewer of [() => { throw new Error('the review runner\'s status is 4 minutes old'); }, () => undefined, () => 'no']) {
    let asked = 0;
    const rec = recWith([['card', 'C-1', { state: 'in_review', head: HEAD, changed_at: at(0) }], ['card', 'C-2', { state: 'running' }], ['session', 'S-2', { card: 'C-2', state: 'reporting', changed_at: at(0) }]]);
    const { p } = ports({ hasReviewer, requestReview: () => { asked += 1; return { ok: true }; } });
    await assert.rejects(() => timeLimits({ rec, rules: R, now: T0 + 15 * MIN, b: GREEN, ...p }), /no review was asked for: (the review runner's status is 4 minutes old|hasReviewer gave no yes or no for card C-1)/);
    assert.equal(asked, 0, String(hasReviewer));
    // The other limits still ran, and the card's count did not go up.
    assert.equal(rec.read('card', 'C-2').doc.state, 'failed');
    assert.equal(rec.read('card', 'C-1').doc.attempts?.reviewer_starts ?? 0, 0);
  }
  // The alerts read failing is the same error.
  const rec = recWith();
  await assert.rejects(() => timeLimits({ rec, rules: R, now: T0, b: GREEN, ...ports({ reviewAlerts: () => { throw new Error('the status is missing'); } }).p }), /no review was asked for: the status is missing/);
});

test('L65: the runner\'s alerts are told to Joe once each; the same trouble at a later time is told again', async () => {
  const { REVIEW_ALERT_FACT } = await import('./review-requests.mjs');
  const rec = recWith();
  const a1 = { id: 'gave-up-x', at: at(1), text: 'card C-1: 3 starts failed' };
  const a2 = { id: 'review-admin', at: at(2), text: 'review is an admin' };
  // As the tick runs it: queued, then sent, and the told mark written only once a copy is delivered.
  const run = async (list, min, deliver = true) => {
    const got = [];
    const now = T0 + min * MIN;
    await withAlerts(rec, now, (t) => { got.push(t); return deliver; }, (alert) => timeLimits({ rec, rules: R, now, b: GREEN, ...ports({ reviewAlerts: () => list }).p, alert }));
    return got;
  };
  // Not delivered: not marked, so it is sent again.
  assert.deepEqual(await run([a1], 2, false), ['review runner: card C-1: 3 starts failed']);
  assert.equal(rec.read('fact', REVIEW_ALERT_FACT(a1))?.doc?.told_at, undefined);
  assert.deepEqual(await run([a1, a2], 3), ['review runner: card C-1: 3 starts failed', 'review runner: review is an admin']);
  assert.equal(rec.read('fact', REVIEW_ALERT_FACT(a1)).doc.told_at, at(3));
  assert.deepEqual(await run([a1, a2], 4), []);
  assert.deepEqual(await run([a1, { ...a2, at: at(5) }, { id: 7 }, null], 6), ['review runner: review is an admin']);
  // L66: the Dispatcher's own alerts from the status are told once per cause, however often the status says it.
  const { statusAlerts } = await import('./review-requests.mjs');
  const failed = statusAlerts({ ok: false, error: 'the review folders: requests is a link' });
  assert.deepEqual(await run(failed, 7), ['review runner: Its last pass failed: the review folders: requests is a link.']);
  assert.deepEqual(await run(statusAlerts({ ok: false, error: 'the review folders: requests is a link' }), 8), []);
  assert.deepEqual(await run(statusAlerts({ ok: false, error: 'another cause' }), 9), ['review runner: Its last pass failed: another cause.']);
});

// Audit r5 N5: limits are read per product and per key; two limits of one product in one pass share no value.
test('N5: an in_review card read first (15 min) does not lend its limit to a checking merge of the same product (30 min)', async () => {
  const rec = recWith([['product', 'p1', { state: 'active' }],
    ['card', 'C-2', { state: 'in_review', head: HA, tier: 2, product: 'p1', changed_at: at(0) }],
    ['card', 'C-1', { state: 'merging', head: HA, product: 'p1' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'checking', judged_head: HA, changed_at: at(0) }]]);
  const rules = rulesWith();
  assert.ok(rules.get(K.inReviewNoReviewerMin, { product: 'p1' }) < 20 && rules.get(K.checkingMaxMin, { product: 'p1' }) > 20, 'the two limits sit either side of 20 min');
  await pass(rec, 20);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'checking', '20 min is under checking_max_min (30)');
});

// L138 MAT-3 (and m1): what M6 says while reconciling is told until a copy is delivered. The merge is merged by then,
// so nothing else would ask again. The real outbox; the Record's clock runs ahead of the tick's.
// Two ways the first copy is lost: the port refuses the send (the entry stays queued and goes out next pass), or the
// outbox refuses the entry (nothing is queued, so the next pass queues it again from the recorded text).
for (const lost of ['send refused', 'queue refused']) {
  test(`L138 MAT-3: a reconcile whose card moved on is told on a later pass (${lost}), exactly once`, async () => {
    const rec = recWith([
      ['card', 'C-1', { state: 'running', head: HB }],
      ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reasons: ['interrupted'], judged_head: HA, changed_at: at(5) }],
      ['fact', PR_FACT(7), { state: 'closed', merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(6) }],
    ]);
    let answer = lost !== 'send refused';
    let queueOk = lost !== 'queue refused';
    const got = [];
    const port = (t) => { got.push(typeof t === 'string' ? t : t.text); return answer; };
    const tickAt = async (min) => {
      const now = T0 + min * MIN;
      setClock(rec.base ?? rec, now + 1500);
      const { p } = ports();
      return withAlerts(rec.base ?? rec, now, port, (real) => {
        const alert = Object.assign((t, o) => (queueOk ? real(t, o) : false), { queues: true });
        return timeLimits({ rec, rules: R, now, b: GREEN, ...p, alert });
      });
    };
    const moves = await tickAt(7);
    assert.deepEqual(moves, [['M-1', 'interrupted, then merged: reconciled'], ['M-1', 'reconciled: told until delivered']]);
    assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
    assert.equal(rec.read('card', 'C-1').doc.state, 'running', 'a card that moved on is not moved');
    assert.equal(got.length, lost === 'send refused' ? 1 : 0);
    assert.match(rec.read('fact', RECONCILE_TELL_FACT('M-1')).doc.text, /merge M-1 is recorded merged, but card C-1 is running/);
    assert.equal(rec.read('fact', RECONCILE_TELL_FACT('M-1')).doc.told_at, undefined, 'a lost copy marks nothing');
    answer = true;
    queueOk = true;
    const again = await tickAt(8);
    assert.deepEqual(again, lost === 'queue refused' ? [['M-1', 'reconciled: told again']] : [], 'a queued entry is not queued twice');
    const told = got.filter((t) => /merge M-1 is recorded merged, but card C-1 is running/.test(t));
    assert.equal(told.length, lost === 'send refused' ? 2 : 1, 'delivered on the next pass');
    assert.ok(rec.read('fact', RECONCILE_TELL_FACT('M-1')).doc.told_at, 'marked once delivered');
    const n = got.length;
    for (const min of [9, 10, 11]) assert.deepEqual(await tickAt(min), []);
    assert.equal(got.length, n, 'told exactly once once delivered (P20)');
  });
}

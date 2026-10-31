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
const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
const pass = async (rec, minutesLater, over, b = GREEN) => { const { alerts, p } = ports(over); return { moves: await timeLimits({ rec, rules: R, now: T0 + minutesLater * MIN, b, ...p }), alerts }; };

test('v3 §2.4: claimed with no session after 10 min goes back to ready', async () => {
  const rec = recWith([['card', 'C-1', { state: 'claimed', changed_at: at(0) }]]);
  await pass(rec, 9);
  assert.equal(rec.read('card', 'C-1').doc.state, 'claimed');
  await pass(rec, 10, { hasSession: () => true });
  assert.equal(rec.read('card', 'C-1').doc.state, 'claimed');
  await pass(rec, 10);
  assert.equal(rec.read('card', 'C-1').doc.state, 'ready');
});

test('v3 §2.4: checking over 30 min is refused{timeout}; the card goes back to verified', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { session_id: 'S-1', head: 'aaa' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(0) }],
  ]);
  await pass(rec, 29);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'checking');
  await pass(rec, 30);
  assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reason], ['refused', 'timeout']);
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
});

test('a refusal with a stale verdict goes back to in_review; the same reason twice goes to Joe', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { session_id: 'S-1', head: 'old' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(0) }],
    ['merge', 'M-2', { card: 'C-1', pr: 7, state: 'checking', head_sha: 'aaa', changed_at: at(40) }],
  ]);
  await pass(rec, 31);
  assert.equal(rec.read('card', 'C-1').doc.state, 'in_review');
  const { alerts } = await pass(rec, 71);
  const c = rec.read('card', 'C-1').doc;
  assert.equal(c.state, 'waiting');
  assert.equal(c.waiting.who, 'joe');
  for (const f of ['who', 'what', 'since', 'next_check']) assert.ok(c.waiting[f], f);
  assert.equal(alerts.length, 1);
});

test('R-0b-57: the Merge Gate killed mid-merge — the next pass records the real outcome from the PR fact', async () => {
  const mk = (pr) => recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { session_id: 'S-1', head: 'aaa' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'aaa', changed_at: at(0) }],
    ...(pr ? [['fact', PR_FACT(7), pr]] : []),
  ]);
  const dead = { gateAlive: () => false };
  // merged on GitHub
  const a = mk({ state: 'closed', merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(1) });
  await pass(a, 2, dead);
  assert.equal(a.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(a.read('merge', 'M-1').doc.merge_commit_sha, 'mmm');
  assert.equal(a.read('card', 'C-1').doc.state, 'merged');
  // not merged
  const b = mk({ state: 'open', merged: false, head_sha: 'aaa', observed_at: at(1) });
  await pass(b, 2, dead);
  assert.deepEqual([b.read('merge', 'M-1').doc.state, b.read('merge', 'M-1').doc.reason], ['refused', 'interrupted']);
  assert.equal(b.read('card', 'C-1').doc.state, 'verified');
  // a PR reading older than the attempt's last change: wait a pass
  const c = mk({ state: 'closed', merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(-1) });
  assert.deepEqual((await pass(c, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
  assert.equal(c.read('merge', 'M-1').doc.state, 'merging');
  // no reading at all: wait
  const d = mk(null);
  await pass(d, 2, dead);
  assert.equal(d.read('merge', 'M-1').doc.state, 'merging');
  // the Merge Gate alive: leave it alone
  const e = mk({ state: 'open', merged: false, observed_at: at(1) });
  await pass(e, 2);
  assert.equal(e.read('merge', 'M-1').doc.state, 'merging');
});

test('m16: merged at a head other than the checked one is recorded merged, with an alert', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'merging' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'aaa', changed_at: at(0) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: 'mmm', head_sha: 'bbb', observed_at: at(1) }],
  ]);
  const { alerts } = await pass(rec, 2, { gateAlive: () => false });
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /bbb/);
});

test('M11: reconcile both ways — an interrupted attempt whose PR later shows merged becomes merged', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'verified' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reason: 'interrupted', head_sha: 'aaa', changed_at: at(5) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(4) }],
  ]);
  await pass(rec, 6);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused'); // the reading predates the refusal
  rec.write({ actor: 'sensors', entity: 'fact', id: PR_FACT(7), expectRev: 1, doc: { merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(7) } });
  await pass(rec, 8);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'merged');
  assert.equal(rec.read('card', 'C-1').doc.state, 'merged');
  assert.ok(rec.read('fact', 'reconciled-M-1'));
  // a refused{timeout} attempt is not reconciled this way
  const r2 = recWith([['merge', 'M-2', { pr: 8, state: 'refused', reason: 'timeout', changed_at: at(0) }], ['fact', PR_FACT(8), { merged: true, observed_at: at(1) }]]);
  await pass(r2, 2);
  assert.equal(r2.read('merge', 'M-2').doc.state, 'refused');
});

test('v3 §2.4: reporting over 10 min fails the card with no_report', async () => {
  const rec = recWith([['card', 'C-1', { state: 'running' }], ['session', 'S-1', { card: 'C-1', state: 'reporting', changed_at: at(0) }]]);
  await pass(rec, 9);
  assert.equal(rec.read('card', 'C-1').doc.state, 'running');
  await pass(rec, 10);
  assert.deepEqual([rec.read('card', 'C-1').doc.state, rec.read('card', 'C-1').doc.reason], ['failed', 'no_report']);
  assert.equal(rec.read('session', 'S-1').doc.state, 'ended');
});

test('v3 §2.4: in_review with no reviewer after 15 min starts one; 2 failed starts go to Joe', async () => {
  const rec = recWith([['card', 'C-1', { state: 'in_review', changed_at: at(0) }]]);
  let starts = 0;
  const failing = { hasReviewer: () => false, startReviewer: () => { starts += 1; return { ok: false }; } };
  await pass(rec, 14, failing);
  assert.equal(starts, 0);
  await pass(rec, 15, failing);
  await pass(rec, 31, failing);
  assert.equal(starts, 2);
  const { alerts } = await pass(rec, 47, failing);
  assert.equal(starts, 2);
  assert.equal(rec.read('card', 'C-1').doc.state, 'waiting');
  assert.equal(rec.read('card', 'C-1').doc.waiting.who, 'joe');
  assert.equal(alerts.length, 1);
  // a successful start resets the count
  const ok = recWith([['card', 'C-2', { state: 'in_review', changed_at: at(0) }]]);
  await pass(ok, 15, { hasReviewer: () => false, startReviewer: () => ({ ok: true, sessionId: 'R-1', head: 'a'.repeat(40) }) });
  assert.equal(ok.read('card', 'C-2').doc.reviewer_start_failures, 0);
});

test('every time limit comes from the rules', async () => {
  const rec = recWith([['card', 'C-1', { state: 'claimed', changed_at: at(0) }]]);
  await timeLimits({ rec, rules: rulesWith({ [K.claimedNoSessionMin]: 2 }), now: T0 + 2 * MIN, b: GREEN, ...ports().p });
  assert.equal(rec.read('card', 'C-1').doc.state, 'ready');
  for (const key of [K.claimedNoSessionMin, K.checkingMaxMin, K.reportingMaxMin, K.inReviewNoReviewerMin]) {
    await assert.rejects(() => timeLimits({ rec: recWith(), rules: rulesWith({ [key]: undefined }), now: T0, b: GREEN, ...ports().p }), new RegExp(key.replace(/\./g, '\\.')));
  }
});

test('audit MAT-5: a reviewer start goes through the start gate: red holds it unless red_runs lists reviews', async () => {
  const RED = { band: 'red', own_building: 'open', prodBlocked: false };
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'in_review', product: 'p1', tier: 2, changed_at: at(0) }]]);
  let starts = 0;
  const p = { ...ports({ hasReviewer: () => false, startReviewer: () => { starts += 1; return { ok: true }; } }).p };
  const held = await timeLimits({ rec, rules: rulesWith({ [K.redRuns]: ['merges'] }), now: T0 + 15 * MIN, b: RED, ...p });
  assert.equal(starts, 0);
  assert.match(held.find(([id]) => id === 'C-1')[1], /reviewer held/);
  await timeLimits({ rec, rules: rulesWith({ [K.redRuns]: ['reviews'] }), now: T0 + 15 * MIN, b: RED, ...p });
  assert.equal(starts, 1);
});

test('audit MAT-5: a merge request is held in red without merges, and for Tier-1 production work above 90%; otherwise written once', async () => {
  const { requestMerges, MERGE_REQUEST } = await import('./merges.mjs');
  const mk = (extra = {}) => recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'verified', product: 'p1', tier: 2, pr: 7, session: 'S-9', head: 'aaa', ...extra }],
    ['verdict', 'C-1', { session_id: 'S-9', head: 'aaa' }]]);
  const RED = { band: 'red', own_building: 'open', prodBlocked: false };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  const a = mk();
  assert.match(requestMerges({ rec: a, rules: rulesWith({ [K.redRuns]: ['reviews'] }), now: T0, b: RED })[0][1], /merge request held/);
  assert.equal(a.read('merge_request', MERGE_REQUEST('C-1', 'aaa')), null);
  const b = mk({ tier: 1, risky: ['production_data'] });
  assert.match(requestMerges({ rec: b, rules: R, now: T0, b: OVER90 })[0][1], /merge request held/);
  const c = mk();
  assert.deepEqual(requestMerges({ rec: c, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  const mr = c.read('merge_request', MERGE_REQUEST('C-1', 'aaa')).doc;
  assert.deepEqual([mr.card, mr.pr, mr.session_id, mr.head, mr.rev], ['C-1', 7, 'S-9', 'aaa', c.read('card', 'C-1').rev]);
  assert.deepEqual(requestMerges({ rec: c, rules: R, now: T0, b: GREEN }), []);
});

test('audit MIN-18 / MIN-19: after a gate crash only merged === true counts, and only a reading newer than the last change', async () => {
  const mk = (pr) => recWith([
    ['card', 'C-1', { state: 'merging' }], ['verdict', 'C-1', { session_id: 'S-1', head: 'aaa' }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'merging', head_sha: 'aaa', changed_at: at(0) }],
    ['fact', PR_FACT(7), pr],
  ]);
  const dead = { gateAlive: () => false };
  for (const merged of [undefined, 'true', 1]) {
    const rec = mk({ state: 'closed', ...(merged === undefined ? {} : { merged }), merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(1) });
    await pass(rec, 2, dead);
    assert.deepEqual([rec.read('merge', 'M-1').doc.state, rec.read('merge', 'M-1').doc.reason], ['refused', 'interrupted'], String(merged));
    assert.notEqual(rec.read('card', 'C-1').doc.state, 'merged');
  }
  // a reading at the same moment as the last change is not fresh
  const same = mk({ merged: true, merge_commit_sha: 'mmm', head_sha: 'aaa', observed_at: at(0) });
  assert.deepEqual((await pass(same, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
  // an attempt with no changed_at is never fresh
  const none = recWith([['merge', 'M-1', { pr: 7, state: 'merging' }], ['fact', PR_FACT(7), { merged: true, observed_at: at(1) }]]);
  assert.deepEqual((await pass(none, 2, dead)).moves, [['M-1', 'waiting for a fresh PR reading']]);
});

test('audit 0b-6 r2 MAT-4 / MAT-6 / MIN-9: an undo is requested in red, unknown and above 90%; a refused request is asked again at the new rev; no head, no request', async () => {
  const { requestMerges, MERGE_REQUEST } = await import('./merges.mjs');
  const mk = (extra = {}) => recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'verified', product: 'p1', tier: 1, pr: 7, session: 'S-9', head: 'aaa', files: ['db/schema.sql'], risky: ['schema'], ...extra }],
    ['verdict', 'C-1', { session_id: 'S-9', head: 'aaa' }]]);
  const RED = { band: 'red', own_building: 'open', prodBlocked: true };
  const UNKNOWN = { band: 'unknown', own_building: 'unknown', prodBlocked: true };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  for (const b of [RED, UNKNOWN, OVER90]) {
    const rec = mk({ kind: 'undo' });
    assert.deepEqual(requestMerges({ rec, rules: rulesWith({ [K.redRuns]: [] }), now: T0, b }), [['C-1', 'merge requested']], b.band);
    // the same card, not an undo, is held
    assert.match(requestMerges({ rec: mk(), rules: rulesWith({ [K.redRuns]: [] }), now: T0, b })[0][1], /merge request held/, b.band);
  }
  // MAT-6: refused, the card back to verified at a new rev -> a new request at that rev.
  const rec = mk({ tier: 2, risky: [], files: ['src/a.js'] });
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  const c = rec.read('card', 'C-1');
  rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-1', expectRev: c.rev, doc: { ...c.doc, merge_refusals: ['stale'] } });
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0 + MIN, b: GREEN }), [['C-1', 'merge requested again']]);
  assert.equal(rec.read('merge_request', MERGE_REQUEST('C-1', 'aaa')).doc.rev, rec.read('card', 'C-1').rev);
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0 + 2 * MIN, b: GREEN }), [], 'once per rev');
  // MIN-9: a card that names no head of its own is not requested.
  const nohead = mk({ tier: 2, risky: [], files: ['src/a.js'], head: undefined });
  assert.match(requestMerges({ rec: nohead, rules: R, now: T0, b: GREEN })[0][1], /names no head/);
  assert.equal(nohead.read('merge_request', MERGE_REQUEST('C-1', 'aaa')), null);
  // r2 M3: a card head that is not the verdict's head is not requested.
  assert.match(requestMerges({ rec: mk({ tier: 2, risky: [], files: ['src/a.js'], head: 'bbb' }), rules: R, now: T0, b: GREEN })[0][1], /another head/);
});

test('audit 0b-6 r3 MAT-3: a rules value the gate lacks is handed back to the tick, by the time limits and by the merge requests', async () => {
  const { requestMerges } = await import('./merges.mjs');
  const rules = rulesWith({ [K.redRuns]: undefined });
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'in_review', product: 'p1', tier: 2, changed_at: at(0) }]]);
  const missing = [];
  const moves = await timeLimits({ rec, rules, now: T0 + 15 * MIN, b: GREEN, ...ports({ hasReviewer: () => false }).p, missing });
  assert.match(moves[0][1], /reviewer held/);
  assert.deepEqual(missing, [K.redRuns]);
  const rec2 = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-2', { state: 'verified', product: 'p1', tier: 2, pr: 7, session: 'S-9', head: 'aaa' }],
    ['verdict', 'C-2', { session_id: 'S-9', head: 'aaa' }]]);
  const missing2 = [];
  assert.match(requestMerges({ rec: rec2, rules, now: T0, b: GREEN, missing: missing2 })[0][1], /merge request held/);
  assert.deepEqual(missing2, [K.redRuns]);
});

// ---- L44: the reviewer's launch is recorded, so its verdict can count ----

test('L44: a started reviewer is recorded as a launch on that card at the head its copy was made from', async () => {
  const { recordReviewerLaunch } = await import('./merges.mjs');
  const HEAD = '0123456789abcdef'.repeat(3).slice(0, 40);
  const rec = recWith([['card', 'C-1', { state: 'in_review', product: 'p1', changed_at: at(0) }]]);
  const { moves } = await pass(rec, 15, { hasReviewer: () => false, startReviewer: () => ({ ok: true, sessionId: 'R-1', head: HEAD }) });
  assert.deepEqual(moves.find(([id]) => id === 'C-1'), ['C-1', 'reviewer started']);
  const l = rec.read('launch', 'R-1').doc;
  assert.deepEqual([l.session_id, l.role, l.card, l.head, l.product, l.rev], ['R-1', 'reviewer', 'C-1', HEAD, 'p1', rec.read('card', 'C-1').rev - 1]);
  assert.equal(l.launched_at, iso(T0 + 15 * MIN));
  // An auditor is recorded as an auditor.
  const a = recWith([['card', 'C-2', { state: 'in_review' }]]);
  assert.equal(recordReviewerLaunch({ rec: a, card: 'C-2', started: { sessionId: 'A-1', head: HEAD, role: 'auditor' }, now: T0 }).ok, true);
  assert.equal(a.read('launch', 'A-1').doc.role, 'auditor');
});

test('L44: a launch that can\'t be recorded is a failed start: Joe is told, its verdict will not count, and the count goes up', async () => {
  const { recordReviewerLaunch } = await import('./merges.mjs');
  const HEAD = 'a'.repeat(40);
  const bad = [
    [{ ok: true }, /no session id/],
    [{ ok: true, sessionId: '../W-1', head: HEAD }, /no session id/],
    [{ ok: true, sessionId: 'x'.repeat(129), head: HEAD }, /no session id/],
    [{ ok: true, sessionId: 'R-1' }, /which head/],
    [{ ok: true, sessionId: 'R-1', head: 'h'.repeat(40) }, /which head/],
    [{ ok: true, sessionId: 'R-1', head: HEAD.slice(1) }, /which head/],
    [{ ok: true, sessionId: 'R-1', head: HEAD, role: 'worker' }, /not a review role/],
  ];
  for (const [started, re] of bad) {
    const rec = recWith([['card', 'C-1', { state: 'in_review', changed_at: at(0) }]]);
    const { moves, alerts } = await pass(rec, 15, { hasReviewer: () => false, startReviewer: () => started });
    assert.deepEqual(moves.find(([id]) => id === 'C-1'), ['C-1', 'reviewer started, not recorded'], JSON.stringify(started));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], re);
    assert.match(alerts[0], /its verdict will not count/);
    assert.equal(rec.read('card', 'C-1').doc.reviewer_start_failures, 1);
    assert.equal(rec.list('launch').length, 0);
    assert.equal(recordReviewerLaunch({ rec, card: 'C-1', started, now: T0 }).ok, false);
  }
});

test('L44: a session id is never reused: a second launch under it is refused and the first is kept', async () => {
  const { recordReviewerLaunch } = await import('./merges.mjs');
  const HEAD = 'a'.repeat(40);
  const rec = recWith([['card', 'C-1', { state: 'in_review' }], ['card', 'C-2', { state: 'in_review' }]]);
  assert.equal(recordReviewerLaunch({ rec, card: 'C-1', started: { sessionId: 'R-1', head: HEAD }, now: T0 }).ok, true);
  const again = recordReviewerLaunch({ rec, card: 'C-2', started: { sessionId: 'R-1', head: 'b'.repeat(40) }, now: T0 + MIN });
  assert.equal(again.ok, false);
  assert.match(again.reason, /session id R-1 was used before; a session id is never reused/);
  assert.deepEqual([rec.read('launch', 'R-1').doc.card, rec.read('launch', 'R-1').doc.head], ['C-1', HEAD]);
  // Through the pass: the second start counts as failed.
  const { moves, alerts } = await pass(rec, 15, { hasReviewer: () => false, startReviewer: () => ({ ok: true, sessionId: 'R-1', head: HEAD }) });
  assert.ok(moves.some(([, what]) => what === 'reviewer started, not recorded'));
  assert.ok(alerts.some((t) => /never reused/.test(t)));
});

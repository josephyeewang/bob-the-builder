import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLimits, PR_FACT } from './merges.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';

const R = rulesWith();
const ports = (over = {}) => {
  const alerts = [];
  return { alerts, p: { hasSession: () => false, gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert: (t) => alerts.push(t), ...over } };
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

test('v3 §2.4, L65: in_review with no reviewer after 15 min asks for one; 2 failed requests go to Joe', async () => {
  const rec = recWith([['card', 'C-1', { state: 'in_review', head: 'a'.repeat(40), changed_at: at(0) }]]);
  let starts = 0;
  const failing = { hasReviewer: () => false, requestReview: () => { starts += 1; return { ok: false, reason: 'the folder is full' }; } };
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
  assert.match(alerts[0], /card C-1: no reviewer could be asked for twice/);
  // a request written resets the count
  const ok = recWith([['card', 'C-2', { state: 'in_review', head: 'a'.repeat(40), changed_at: at(0), reviewer_start_failures: 1 }]]);
  const { moves } = await pass(ok, 15, { hasReviewer: () => false, requestReview: () => ({ ok: true }) });
  assert.deepEqual(moves.find(([id]) => id === 'C-2'), ['C-2', 'reviewer requested']);
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
  const p = { ...ports({ hasReviewer: () => false, requestReview: () => { starts += 1; return { ok: true }; } }).p };
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
  assert.equal(r4.read('card', 'C-5').doc.reviewer_start_failures, 1);
});

test('L65: a status that can\'t be trusted asks for nothing, and the pass ends with that error after the other limits', async () => {
  for (const hasReviewer of [() => { throw new Error('the review runner\'s status is 4 minutes old'); }, () => undefined, () => 'no']) {
    let asked = 0;
    const rec = recWith([['card', 'C-1', { state: 'in_review', head: HEAD, changed_at: at(0) }], ['card', 'C-2', { state: 'claimed', changed_at: at(0) }]]);
    const { p } = ports({ hasReviewer, requestReview: () => { asked += 1; return { ok: true }; } });
    await assert.rejects(() => timeLimits({ rec, rules: R, now: T0 + 15 * MIN, b: GREEN, ...p }), /no review was asked for: (the review runner's status is 4 minutes old|hasReviewer gave no yes or no for card C-1)/);
    assert.equal(asked, 0, String(hasReviewer));
    // The other limits still ran, and the card's count did not go up.
    assert.equal(rec.read('card', 'C-2').doc.state, 'ready');
    assert.equal(rec.read('card', 'C-1').doc.reviewer_start_failures ?? 0, 0);
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
});

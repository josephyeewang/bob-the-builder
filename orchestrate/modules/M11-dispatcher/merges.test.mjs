import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeLimits, requestMerges, MERGE_REQUEST, PR_FACT, RECONCILED_FACT } from './merges.mjs';
import { KEYS as K } from './keys.mjs';
import { rulesWith, recWith, change, setClock, undoEntries, T0, MIN, iso, withAlerts } from './fixtures.test-helper.mjs';

const R = rulesWith();
const ports = (over = {}) => {
  const alerts = [];
  return { alerts, p: { gateAlive: () => true, hasReviewer: () => true, requestReview: () => ({ ok: true }), alert: (t) => alerts.push(t), ...over } };
};
const at = (min) => iso(T0 + min * MIN);
const GREEN = { band: 'green', own_building: 'open', prodBlocked: false };
// The Record's clock reads the pass's time, as the real one does: its writes in the pass are stamped then.
const pass = async (rec, minutesLater, over, b = GREEN) => {
  const { alerts, p } = ports(over);
  setClock(rec.base ?? rec, T0 + minutesLater * MIN);
  return { moves: await timeLimits({ rec, rules: R, now: T0 + minutesLater * MIN, b, ...p }), alerts };
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
  // not merged
  const b = mk({ state: 'open', merged: false, head_sha: HA, observed_at: at(1) });
  await pass(b.rec, 2, dead);
  assert.deepEqual([b.rec.read('merge', 'M-1').doc.state, b.rec.read('merge', 'M-1').doc.reasons], ['refused', ['interrupted']]);
  assert.equal(b.rec.read('card', 'C-1').doc.state, 'verified');
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

test('M11: an interrupted merge whose PR later shows merged stays refused; the owner is told once', async () => {
  const rec = recWith([
    ['card', 'C-1', { state: 'verified', head: HA }],
    ['merge', 'M-1', { card: 'C-1', pr: 7, state: 'refused', reasons: ['interrupted'], judged_head: HA, changed_at: at(5) }],
    ['fact', PR_FACT(7), { merged: true, merge_commit_sha: MC, head_sha: HA, observed_at: at(4) }],
  ]);
  assert.deepEqual((await pass(rec, 6)).alerts, [], 'the reading predates the refusal');
  change(rec, 'fact', PR_FACT(7), { observed_at: at(7) });
  const { alerts } = await pass(rec, 8);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /merge M-1 was recorded as interrupted but PR 7 shows merged/);
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
  assert.equal(rec.read('card', 'C-1').doc.state, 'verified');
  assert.ok(rec.read('fact', RECONCILED_FACT('M-1')));
  assert.deepEqual((await pass(rec, 9)).alerts, [], 'told once');
  // a refused{timeout} merge is not reconciled this way
  const r2 = recWith([['merge', 'M-2', { pr: 8, state: 'refused', reasons: ['timeout'], changed_at: at(0) }], ['fact', PR_FACT(8), { merged: true, observed_at: at(1) }]]);
  assert.deepEqual((await pass(r2, 2)).alerts, []);
  assert.equal(r2.read('fact', RECONCILED_FACT('M-2')), null);
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

test('every time limit comes from the rules', async () => {
  for (const key of [K.checkingMaxMin, K.reportingMaxMin, K.inReviewNoReviewerMin]) {
    await assert.rejects(() => timeLimits({ rec: recWith(), rules: rulesWith({ [key]: undefined }), now: T0, b: GREEN, ...ports().p }), new RegExp(key.replace(/\./g, '\\.')));
  }
  const rec = recWith([cardMerging, checking()]);
  await timeLimits({ rec, rules: rulesWith({ [K.checkingMaxMin]: 2 }), now: T0 + 2 * MIN, b: GREEN, ...ports().p });
  assert.equal(rec.read('merge', 'M-1').doc.state, 'refused');
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

test('audit MAT-5: a merge request is held in red without merges, and for Tier-1 production work above 90%; otherwise written once', () => {
  const RED = { band: 'red', own_building: 'open', prodBlocked: false };
  const OVER90 = { band: 'green', own_building: 'open', prodBlocked: true };
  const a = readyRec();
  assert.match(requestMerges({ rec: a, rules: rulesWith({ [K.redRuns]: ['reviews'] }), now: T0, b: RED })[0][1], /merge request held/);
  assert.deepEqual(requests(a), []);
  const b = readyRec({ tier: 1 });
  assert.match(requestMerges({ rec: b, rules: rulesWith({}, {}, RISKY(['production_data'])), now: T0, b: OVER90 })[0][1], /merge request held/);
  assert.deepEqual(requests(b), []);
  const c = readyRec();
  assert.deepEqual(requestMerges({ rec: c, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  const rev = c.read('card', 'C-1').rev;
  const mr = c.read('merge_request', MERGE_REQUEST('C-1', HA, rev)).doc;
  assert.deepEqual([mr.card, mr.pr, mr.session_id, mr.head, mr.rev], ['C-1', 7, 'S-9', HA, rev]);
  assert.equal(c.meta('merge_request', MERGE_REQUEST('C-1', HA, rev)).createdBy, 'dispatcher');
  assert.deepEqual(requestMerges({ rec: c, rules: R, now: T0, b: GREEN }), []);
});

test('L72: the session is the newest worker launch for the card, and the pull request the one Sensors reading at its head', () => {
  // the newest of two launches; another card's and a reviewer's launch don't count
  const rec = readyRec({}, [launch('C-1', 'S-8', -90), launch('C-1', 'S-9', -30), launch('C-2', 'S-7', -10),
    ['launch', 'L-R-1', { session_id: 'R-1', role: 'reviewer', card: 'C-1', head: HA, rev: 1, launched_at: at(-5) }], prSeen(7), prSeen(8, HB)]);
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  assert.deepEqual(requests(rec).map((q) => [q.session_id, q.pr]), [['S-9', 7]]);
  // no reading at the head, or no worker launch: not ready
  assert.match(requestMerges({ rec: readyRec({}, [launch('C-1', 'S-9'), prSeen(7, HB)]), rules: R, now: T0, b: GREEN })[0][1], /needs a pull request and its session/);
  assert.match(requestMerges({ rec: readyRec({}, [prSeen(7)]), rules: R, now: T0, b: GREEN })[0][1], /needs a pull request and its session/);
  // two readings at the head: not guessed
  assert.match(requestMerges({ rec: readyRec({}, [launch('C-1', 'S-9'), prSeen(7), prSeen(9)]), rules: R, now: T0, b: GREEN })[0][1], /2 pull requests show head aaaaaaa/);
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
    assert.deepEqual(requestMerges({ rec, rules: risky, now: T0, b }).filter(([id]) => id === 'U-1'), [['U-1', 'merge requested']], b.band);
    // the same card, not an undo, is held
    assert.match(requestMerges({ rec: readyRec({ tier: 1 }), rules: risky, now: T0, b })[0][1], /merge request held/, b.band);
  }
  // MAT-6: the card changes (a new rev) -> a new request at that rev, once.
  const rec = readyRec();
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0, b: GREEN }), [['C-1', 'merge requested']]);
  change(rec, 'card', 'C-1', { attempts: { merge_refusals: ['stale'] } });
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0 + MIN, b: GREEN }), [['C-1', 'merge requested again']]);
  assert.ok(rec.read('merge_request', MERGE_REQUEST('C-1', HA, rec.read('card', 'C-1').rev)));
  assert.equal(requests(rec).length, 2, 'the first request is kept as it was (create-only)');
  assert.deepEqual(requestMerges({ rec, rules: R, now: T0 + 2 * MIN, b: GREEN }), [], 'once per rev');
  // MIN-9: a card that names no head of its own is not requested.
  const nohead = readyRec({ head: undefined });
  assert.match(requestMerges({ rec: nohead, rules: R, now: T0, b: GREEN })[0][1], /names no head/);
  assert.deepEqual(requests(nohead), []);
});

test('audit 0b-6 r3 MAT-3: a rules value the gate lacks is handed back to the tick, by the time limits and by the merge requests', async () => {
  const rules = rulesWith({ [K.redRuns]: undefined });
  const rec = recWith([['product', 'p1', { state: 'active' }], ['card', 'C-1', { state: 'in_review', product: 'p1', tier: 2, head: HA, changed_at: at(0) }]]);
  const missing = [];
  const moves = await timeLimits({ rec, rules, now: T0 + 15 * MIN, b: GREEN, ...ports({ hasReviewer: () => false }).p, missing });
  assert.match(moves[0][1], /reviewer held/);
  assert.deepEqual(missing, [K.redRuns]);
  const missing2 = [];
  assert.match(requestMerges({ rec: readyRec(), rules, now: T0, b: GREEN, missing: missing2 })[0][1], /merge request held/);
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

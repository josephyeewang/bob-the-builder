// refusals.test.mjs — every refusal planted alone: a clean change merges, and each planted fault refuses it for exactly
// that one reason (R-0b-87 to R-0b-90, R-0b-97; L44's planted verdicts; L68's worst verdict). Which sessions and files
// count is M9 headReviews' job (outbox.test.mjs); here the gate judges what it was handed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, verdictProblem, NOT_BUILT_LINE, FIRST_LANE_LINE, DAILY_CARD_LINE } from './refusals.mjs';

const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const CLEAN = { correct: 'clean', well_built: 'minor', works_for_user: 'cosmetic', holds_up: 'clean' };

// One session the review runner launched at H0, as M9 headReviews hands it over (L68, L69): ended, with its verdict,
// unless the test says otherwise.
function session(role, sid, verdict, { ended = true, problem = null, silent = !verdict && ended === true, aside = false, head = H0 } = {}) {
  return { role, session_id: sid, head, tree: null, aside, ended, silent, verdict: verdict ? { card: 'C-1', head, notes: null, checklist: null, material: null, ...verdict } : null, problem };
}

function clean(over = {}) {
  const f = {
    cutoverStage: 'second',
    card: { id: 'C-1', doc: { state: 'verified', head: H0, kind: 'ordinary', module: 'M-x' } },
    request: { id: 'mr-C-1', doc: { card: 'C-1', pr: 7, session_id: 'S-1', head: H0, rev: 3 }, createdBy: 'dispatcher' },
    movesSinceRequest: [],
    pr: { number: 7, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: H0 }, mergeable: true, mergeable_state: 'clean' },
    main: { sha: MAIN, green: true },
    checks: [{ name: 'test', app_id: 15368, head_sha: H0, status: 'completed', conclusion: 'success' }],
    statuses: [],
    requiredChecks: ['test'],
    checksIgnored: [],
    compareStatus: 'ahead',
    carried: null,
    reviews: [session('reviewer', 'R-1', { pass: true, checklist: CLEAN })],
    tier: 2,
    exactReverse: false,
    reversesGateMerge: false,
    lane: { decision: 'allow', reason: 'ok' },
    approve: { needed: false, why: [], stands: false },
    go: { ok: true, reasons: [] },
    threads: { ok: true, unresolved: 0 },
    rulesAdopted: true,
    files: [{ path: 'src/a.js', status: 'modified' }],
    firstCustomerNewFiles: ['app/pages/'],
  };
  return over(f) ?? f;
}
// The pull request moved past H0 (a catch-up), and the review carries over.
const pastH0 = (f) => { f.pr.head.sha = H1; f.checks[0].head_sha = H1; f.carried = { review: true, audit: true, reasons: [] }; f.prReviews = []; };
const only = (f) => { const r = judge(f); assert.equal(r.decision, 'refuse', JSON.stringify(r)); return r.refusals.map((x) => x.n); };

test('a clean change merges', () => {
  const r = judge(clean(() => {}));
  assert.equal(r.decision, 'merge', JSON.stringify(r.refusals));
});

const PLANTED = [
  [1, 'a required check red', (f) => { f.checks[0].conclusion = 'failure'; }],
  [1, 'a required check missing', (f) => { f.requiredChecks = ['test', 'lint']; }],
  [1, 'another check red', (f) => { f.checks.push({ name: 'extra', app_id: 1, head_sha: H0, status: 'completed', conclusion: 'failure' }); }],
  [1, 'a status in error', (f) => { f.statuses = [{ context: 'ci/x', state: 'error' }]; }],
  [2, 'main red', (f) => { f.main.green = false; }],
  [2, 'main unreadable', (f) => { f.main.green = null; }],
  [3, 'a draft', (f) => { f.pr.draft = true; }],
  [3, 'not mergeable', (f) => { f.pr.mergeable_state = 'dirty'; }],
  [3, 'closed', (f) => { f.pr.state = 'closed'; }],
  [4, 'stacked', (f) => { f.pr.base.ref = 'feature-x'; }],
  [5, 'no verdict', (f) => { f.reviews = []; }],
  [5, 'a material checklist line', (f) => { f.reviews[0].verdict.checklist = { ...CLEAN, holds_up: 'material' }; }],
  [5, 'a checklist line missing', (f) => { f.reviews[0].verdict.checklist = { correct: 'clean', well_built: 'clean', works_for_user: 'clean' }; }],
  [5, 'L68: try 1 failed and try 2 passed on one head', (f) => { f.reviews.unshift(session('reviewer', 'R-0', { pass: false, checklist: CLEAN })); }],
  [5, 'L68: a later reviewer passed, an earlier one\'s checklist was material', (f) => { f.reviews.unshift(session('reviewer', 'R-0', { pass: true, checklist: { ...CLEAN, correct: 'material' } })); }],
  [5, 'L68: a launched reviewer with no verdict file, not marked ended', (f) => { f.reviews.push(session('reviewer', 'R-2', null, { ended: false })); }],
  [5, 'L68: a launched reviewer whose verdict file can\'t be counted', (f) => { f.reviews.push(session('reviewer', 'R-2', null, { problem: 'more than one verdict file was left, so none counts' })); }],
  [5, 'L68: only a reviewer that ended with no verdict', (f) => { f.reviews = [session('reviewer', 'R-2', null, { ended: true })]; }],
  [5, 'L69: a passing reviewer whose session has not ended', (f) => { f.reviews[0].ended = false; }],
  [5, 'L69: a reviewer that ended silent beside a pass', (f) => { f.reviews.push(session('reviewer', 'R-2', null)); }],
  [5, 'L69: a fail at the pull request\'s head, with a review that carries over', (f) => { pastH0(f); f.prReviews = [session('reviewer', 'R-9', { pass: false, checklist: CLEAN }, { head: H1 })]; }],
  [5, 'L69: an unsettled session at the pull request\'s head', (f) => { pastH0(f); f.prReviews = [session('reviewer', 'R-9', null, { ended: false, head: H1 })]; }],
  [5, 'L69: the pull request\'s head could not be read', (f) => { pastH0(f); f.prReviews = null; f.prReviewsProblem = 'the tree of bbbbbbb could not be read'; }],
  [5, 'L68: a Tier-2 change with a failing auditor', (f) => { f.reviews.push(session('auditor', 'A-1', { pass: false, material: 2 })); }],
  [5, 'Tier 1 without an auditor verdict', (f) => { f.tier = 1; f.approve.needed = false; }],
  [5, 'a head that moved, review not carried', (f) => { f.pr.head.sha = H1; f.checks[0].head_sha = H1; f.carried = { review: false, audit: false, reasons: ['x'] }; f.prReviews = []; }],
  [6, 'a check for another commit', (f) => { f.checks.push({ name: 'other', app_id: 2, head_sha: H1, status: 'completed', conclusion: 'success' }); }],
  [7, 'an unresolved thread', (f) => { f.threads.unresolved = 2; }],
  [7, 'threads unreadable', (f) => { f.threads = { ok: false }; }],
  [8, 'needs the owner, no Approve', (f) => { f.approve = { needed: true, why: ['risky: schema'], stands: false }; }],
  [8, 'the rules ask, no Approve', (f) => { f.lane = { decision: 'ask', tier: 1, reason: 'risky' }; }],
  [8, 'the Approve check could not run', (f) => { f.approve = null; }],
  [9, 'out of lane', (f) => { f.lane = { decision: 'deny', reason: 'protected file' }; }],
  [10, 'go mismatch', (f) => { f.go = { ok: false, reasons: ['src/b.js is outside the go\'s file list'] }; }],
  [10, 'go not checked', (f) => { f.go = null; }],
  [11, 'no request', (f) => { f.request = null; }],
  [11, 'a request for another head', (f) => { f.request.doc.head = H1; }],
  [11, 'a request not from the Dispatcher', (f) => { f.request.createdBy = 'lead'; }],
  [11, 'a move since the request', (f) => { f.movesSinceRequest = [{ actor: 'workshop', entity: 'card', id: 'C-1' }]; }],
  [11, 'a tab claim that is not the live claim', (f) => { f.request.doc.session_id = 'tab:old'; f.card.doc.claim = { claim_id: 'new' }; }],
  [12, 'behind main', (f) => { f.compareStatus = 'diverged'; }],
  [13, 'a fix card with no Approve', (f) => { f.card.doc.kind = 'fix'; }],
  [14, 'a new customer-visible file with no Approve', (f) => { f.files.push({ path: 'app/pages/new.tsx', status: 'added' }); }],
];

for (const [n, name, plant] of PLANTED) {
  test(`refusal ${n} alone: ${name}`, () => assert.deepEqual(only(clean(plant)), [n]));
}

test('Tier 1 passes with a launched auditor at 0 Material and a proven live check', () => {
  const f = clean((f) => { f.tier = 1; f.reviews.push(session('auditor', 'A-1', { pass: true, material: 0 })); });
  assert.equal(judge(f).decision, 'merge');
  f.reviews[1].verdict.material = 1;
  assert.deepEqual(only(f), [5]);
});

test('L68 planted: an auditor with Material > 0 and a later auditor with 0 on one head → refused', () => {
  const f = clean((f) => { f.tier = 1; f.reviews.push(session('auditor', 'A-1', { pass: false, material: 2 }), session('auditor', 'A-2', { pass: true, material: 0 })); });
  assert.deepEqual(only(f), [5]);
  assert.match(judge(f).refusals[0].reason, /Tier 1: the auditor session A-1 did not pass/);
  // Without the failing one, the same head merges.
  f.reviews.splice(1, 1);
  assert.equal(judge(f).decision, 'merge');
});

test('L68 planted: try 1 fails and try 2 passes on one head → refused, and says which session failed', () => {
  const f = clean((f) => { f.reviews.unshift(session('reviewer', 'R-0', { pass: false, checklist: CLEAN })); });
  assert.match(verdictProblem(f), /the reviewer session R-0 did not pass/);
});

// L69 point 1 reverses L68's "no say": a session that ran and ended with no file is a failure, beside any pass. Only
// Joe's "review again" sets it aside, and then it has no say.
test('L69 planted: a session that ended with no verdict is a failure; one not ended blocks, file or not; Joe\'s set-aside has no say', () => {
  const f = clean((f) => { f.reviews.push(session('reviewer', 'R-2', null, { ended: true })); });
  assert.deepEqual(only(f), [5]);
  assert.match(verdictProblem(f), /the reviewer session R-2 ended without handing in a verdict, which counts as a failure/);
  f.reviews[1].aside = true;
  assert.equal(judge(f).decision, 'merge', 'set aside by Joe: no say');
  f.reviews[1] = session('reviewer', 'R-2', { pass: true, checklist: CLEAN }, { ended: false });
  assert.match(verdictProblem(f), /R-2 has not ended yet/, 'a passing file of a session not yet ended blocks');
  f.reviews[1].ended = null;
  assert.match(verdictProblem(f), /R-2 has not ended yet/);
  // Set aside, and nothing else: no pass is left.
  f.reviews = [session('reviewer', 'R-2', null, { aside: true })];
  assert.match(verdictProblem(f), /no reviewer session handed in a pass/);
});

// L69 point 5: the pull request's head has its own say, even when the review carries over to it.
test('L69 planted: a fail at the pull request\'s head with a passing carry-over is refused; a pass there merges', () => {
  const f = clean((f) => { pastH0(f); f.prReviews = []; });
  assert.equal(judge(f).decision, 'merge', 'no session at the new head: the carry-over decides');
  f.prReviews = [session('reviewer', 'R-9', { pass: false, checklist: CLEAN }, { head: H1 })];
  assert.deepEqual(only(f), [5]);
  assert.match(verdictProblem(f), /the reviewer session R-9 did not pass at the pull request's head bbbbbbb/);
  f.prReviews = [session('auditor', 'A-9', { pass: true, material: 1 }, { head: H1 })];
  assert.match(verdictProblem(f), /the auditor session A-9 did not pass at the pull request's head/, 'a Tier-2 change\'s auditor there has its say too');
  f.prReviews = [session('reviewer', 'R-9', { pass: true, checklist: CLEAN }, { head: H1 })];
  assert.equal(judge(f).decision, 'merge');
});

test('a caught-up head whose review (and Tier-1 audit) carried over merges', () => {
  const f = clean((f) => { f.pr.head.sha = H1; f.checks[0].head_sha = H1; f.carried = { review: true, audit: true, reasons: [] }; f.prReviews = []; });
  assert.equal(judge(f).decision, 'merge');
});

test('holds keep the place: held_tier1_hours from the rules, rules_not_adopted from the gate', () => {
  assert.deepEqual(judge(clean((f) => { f.lane = { decision: 'deny', reason: 'held_tier1_hours' }; })).hold, 'held_tier1_hours');
  const r = judge(clean((f) => { f.rulesAdopted = false; }));
  assert.equal(r.decision, 'hold');
  assert.equal(r.hold, 'rules_not_adopted');
  // A refusal wins over a hold.
  assert.equal(judge(clean((f) => { f.rulesAdopted = false; f.main.green = false; })).decision, 'refuse');
});

test('first cutover: an out-of-lane change is refused as docs lane only', () => {
  const r = judge(clean((f) => { f.cutoverStage = undefined; f.lane = { decision: 'deny', reason: 'not this lane\'s change; MAIN merges it as today: src/a.js' }; }));
  assert.equal(r.decision, 'refuse');
  assert.match(r.refusals[0].reason, new RegExp(`^${FIRST_LANE_LINE}`));
});

test('the daily card is refused, pending the lead\'s call', () => {
  const r = judge(clean((f) => { f.card.doc.kind = 'lead_daily_card'; }));
  assert.deepEqual(r.refusals, [{ n: 9, reason: DAILY_CARD_LINE }]);
});

const reverse = (f) => {
  f.card.doc.kind = 'exact_reverse';
  f.exactReverse = true;
  f.reversesGateMerge = true;
  f.reviews = [];
  f.request = null;
  f.checks[0].conclusion = 'failure';
  f.approve = { needed: true, why: ['the card needs the owner'], stands: false };
};

test('an exact reverse is exempt from refusals 1, 5, 8 and 11', () => {
  assert.equal(judge(clean(reverse)).decision, 'merge');
});

test('…but M10\'s own ask for a reverse still needs the Approve (R2-M3), and 6 still applies', () => {
  assert.deepEqual(only(clean((f) => { reverse(f); f.lane = { decision: 'ask', tier: 1, reason: 'exact reverse of a merge whose audit passed' }; })), [8]);
  assert.deepEqual(only(clean((f) => { reverse(f); f.checks[0].head_sha = H1; })), [6]);
});

test('an undo card whose change is not an exact reverse loses every exemption', () => {
  const ns = only(clean((f) => { reverse(f); f.exactReverse = false; }));
  assert.ok(ns.includes(9) && ns.includes(1) && ns.includes(5) && ns.includes(11));
});

test('first cutover: an undo merges only when it reverses a merge the gate made', () => {
  assert.equal(judge(clean((f) => { reverse(f); f.cutoverStage = 'first'; })).decision, 'merge');
  assert.deepEqual(only(clean((f) => { reverse(f); f.cutoverStage = 'first'; f.reversesGateMerge = false; })), [9]);
});

test('refusals 13 and 14 stand in with the owner\'s Approve, and log that they did', () => {
  for (const plant of [(f) => { f.card.doc.kind = 'fix'; }, (f) => { f.files.push({ path: 'app/pages/x.tsx', status: 'added' }); }]) {
    const r = judge(clean((f) => { plant(f); f.approve = { needed: false, why: [], stands: true }; }));
    assert.equal(r.decision, 'merge');
    assert.deepEqual(r.notes, [NOT_BUILT_LINE]);
  }
  assert.deepEqual(only(clean((f) => { f.firstCustomerNewFiles = null; })), [14]);
  // The list is read as M10 reads it: patterns, at any depth for a plain folder.
  for (const pats of [['app/**'], ['app/pages/*.tsx'], ['app/']]) {
    for (const path of ['app/pages/new.tsx', 'web/app/pages/new.tsx']) {
      if (path.startsWith('web/') && pats[0] !== 'app/') continue;
      assert.deepEqual(only(clean((f) => { f.firstCustomerNewFiles = pats; f.files.push({ path, status: 'added' }); })), [14], `${pats} ${path}`);
    }
  }
});

test('odd input refuses, never throws', () => {
  assert.equal(judge(null).decision, 'refuse');
  assert.equal(judge({ card: { id: 'C-1', doc: {} } }).decision, 'refuse');
  const f = clean(() => {});
  Object.defineProperty(f, 'pr', { get() { throw new Error('boom'); } });
  const r = judge(f);
  assert.equal(r.decision, 'refuse');
  assert.ok(r.refusals.some((x) => x.n === 0));
  assert.match(verdictProblem({ card: { id: 'C-1', doc: { head: 'nope' } } }), /no head/);
});

test('L65: review records that could not be read refuse 5 with the reason', () => {
  const f = clean((x) => { x.reviews = null; x.reviewsProblem = 'the review launches folder is missing'; });
  assert.match(verdictProblem(f), /records could not be read: the review launches folder is missing/);
});

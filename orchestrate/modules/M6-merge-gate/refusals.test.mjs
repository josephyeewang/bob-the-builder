// refusals.test.mjs — every refusal planted alone: a clean change merges, and each planted fault refuses it for exactly
// that one reason (R-0b-87 to R-0b-90, R-0b-97; L44's planted verdicts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, verdictProblem, NOT_BUILT_LINE, FIRST_LANE_LINE, DAILY_CARD_LINE } from './refusals.mjs';

const H0 = 'a'.repeat(40);
const H1 = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const CLEAN = { correct: 'clean', well_built: 'minor', works_for_user: 'cosmetic', holds_up: 'clean' };

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
    verdicts: [{ doc: { card: 'C-1', head: H0, session_id: 'R-1', pass: true, checklist: CLEAN, material: 0, outbox_uid: 501 }, createdBy: 'reviewer:R-1' }],
    launches: [{ doc: { card: 'C-1', role: 'reviewer', head: H0, session_id: 'R-1' } }],
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
  [5, 'no verdict', (f) => { f.verdicts = []; }],
  [5, 'a material checklist line', (f) => { f.verdicts[0].doc.checklist = { ...CLEAN, holds_up: 'material' }; }],
  [5, 'a checklist line missing', (f) => { f.verdicts[0].doc.checklist = { correct: 'clean', well_built: 'clean', works_for_user: 'clean' }; }],
  [5, 'L44: a verdict handed in through a worker outbox', (f) => { f.verdicts[0].createdBy = 'worker:R-1'; }],
  [5, 'L44: a verdict naming the wrong head', (f) => { f.verdicts[0].doc.head = H1; }],
  [5, 'L44: a verdict from an unrecorded session', (f) => { f.verdicts[0].doc.session_id = 'R-9'; f.verdicts[0].createdBy = 'reviewer:R-9'; }],
  [5, 'L44: a verdict with no outbox uid (not from a review outbox)', (f) => { delete f.verdicts[0].doc.outbox_uid; }],
  [5, 'L44: the reviewer launched on another head', (f) => { f.launches[0].doc.head = H1; }],
  [5, 'Tier 1 without an auditor verdict', (f) => { f.tier = 1; f.approve.needed = false; }],
  [5, 'a head that moved, review not carried', (f) => { f.pr.head.sha = H1; f.checks[0].head_sha = H1; f.carried = { review: false, audit: false, reasons: ['x'] }; }],
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
  const f = clean((f) => {
    f.tier = 1;
    f.verdicts.push({ doc: { card: 'C-1', head: H0, session_id: 'A-1', pass: true, material: 0, outbox_uid: 501 }, createdBy: 'auditor:A-1' });
    f.launches.push({ doc: { card: 'C-1', role: 'auditor', head: H0, session_id: 'A-1' } });
  });
  assert.equal(judge(f).decision, 'merge');
  f.verdicts[1].doc.material = 1;
  assert.deepEqual(only(f), [5]);
});

test('a caught-up head whose review (and Tier-1 audit) carried over merges', () => {
  const f = clean((f) => { f.pr.head.sha = H1; f.checks[0].head_sha = H1; f.carried = { review: true, audit: true, reasons: [] }; });
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
  f.verdicts = [];
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

test('L65: launches that could not be read refuse 5 with the reason', () => {
  const f = clean((x) => { x.launches = null; x.launchesProblem = 'the review launches folder is missing'; });
  assert.match(verdictProblem(f), /launch records could not be read: the review launches folder is missing/);
});

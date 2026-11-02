// writer.test.mjs — the Store Writer's conditions on top of the move table: waits (R-0b-27), the round cap and fix
// cards (R-0b-24, M-8, R3-m2), card-kind evidence (R3-M3), ask re-asks (R3-M1), sessions (G2), products, verdicts
// (R2-M7), the audit result, merge requests, and overdue (R-0b-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, HEAD2, PRODUCT, iso, leadCard, must, outboxFile, plan, product, put, readyCard, runCard, runnerLaunch, runnerEndedRecord, CLEAN_CHECKLIST, seed, setup } from './fixtures.test-helper.mjs';

const MIN = 60000;
const wait = (env, over = {}) => ({ who: 'dependency', what: 'the API key', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN), resume: 'retry', return_to: 'ready', ...over });
const refused = (r, pattern, where) => { assert.equal(r.ok, false, where ?? JSON.stringify(r)); assert.match(r.reason, pattern, where); };
const fixCard = (env, id, of, over = {}) => env.record.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0,
  doc: { state: 'draft', product: PRODUCT, kind: 'fix', fix_of: of, ...plan(), ...over } });
// Set-up only: put a card in failed, the one state a fix card may name.
const fail = (env, id) => seed(env, 'card', id, { ...env.record.read('card', id).doc, state: 'failed' });
// A Lead roadmap file that edits an existing card.
const roadmapEdit = (env, id, fields) => env.record.applyOutbox({ role: 'lead', sessionId: 'L-1' }, outboxFile(env, 'lead', 'L-1', `roadmap-edit-${id}.md`,
  `${JSON.stringify({ entity: 'card', id, expectRev: env.record.read('card', id).rev, fields })}\n`));

// ---------------- waits ----------------

test('waits: each of the four fields is required, and a date wait needs a reason', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  for (const f of ['who', 'what', 'since', 'next_check']) {
    const w = wait(env); delete w[f];
    refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: w }), new RegExp(`wait is missing ${f}`), f);
  }
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting' }), /needs a wait/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { who: 'someone' }) }), /wait.who must be one of/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { who: 'date' }) }), /a wait on a date needs a reason/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { since: iso(env.clock.t - 2 * MIN) }) }), /since must be now/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { next_check: iso(env.clock.t) }) }), /next_check must be in the future/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { next_check: iso(env.clock.t + 1441 * MIN) }) }), /later than 1440 minutes/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { resume: 'continue', return_to: 'running' }) }), /running card waits only with resume: retry/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { return_to: 'in_review' }) }), /retry returns to ready/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { who: 'date', reason: 'the vendor opens Monday' }) }), 'date wait');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.claim, undefined, 'the claim ends when a running card waits');
  assert.equal(c.wait.since, iso(env.clock.t), 'the writer stamps since');
  // A wait returns only to its return_to, and the return clears it.
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'in_review' }), /returns only to ready/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'ready' }), 'back to ready');
  assert.equal(env.record.read('card', 'C-1').doc.wait, undefined);
  // A wait field on a card that isn't waiting is refused.
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { wait: wait(env) }), /only a waiting card has a wait/);
});

test('waits: a re-check moves next_check but keeps resume and return_to; a continue wait returns where it came from', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD }));
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, outboxFile(env, 'worker', 'S-1', 'handin-w.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)));
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { resume: 'continue', return_to: 'in_review' }) }), 'continue wait');
  env.clock.t += 10 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: wait(env, { resume: 'continue', return_to: 'in_review' }) }), 're-check');
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { wait: wait(env, { resume: 'retry', return_to: 'ready' }) }), /keeps the wait's resume and return_to/);
  refused(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'ready' }), /returns only to in_review/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'in_review' }), 'return');
});

test('session waits: waiting_input and waiting_limit need a full wait; other states have none', () => {
  const env = setup({ prefix: 'm9-wr-' });
  seed(env, 'session', 'S-1', { state: 'running', role: 'worker' });
  refused(put(env.record, 'workshop', 'session', 'S-1', { state: 'waiting_limit' }), /needs a wait/);
  must(put(env.record, 'workshop', 'session', 'S-1', { state: 'waiting_limit', wait: { who: 'usage', what: 'the 5-hour limit', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) } }));
  // Leaving a waiting state clears the wait; setting one on another state is refused.
  must(put(env.record, 'dispatcher', 'session', 'S-1', { state: 'running' }));
  assert.equal(env.record.read('session', 'S-1').doc.wait, undefined);
  refused(put(env.record, 'workshop', 'session', 'S-1', { wait: { who: 'usage', what: 'x', since: iso(env.clock.t), next_check: iso(env.clock.t + MIN) } }), /a running session has no wait/);
});

// ---------------- the round cap and fix cards ----------------

test('round cap 2: round 3 goes to the owner; a supplied round is ignored (M-8)', () => {
  const env = setup({ prefix: 'm9-wr-', values: { 'caps.rounds': 2 } });
  product(env);
  leadCard(env, 'C-1');
  refused(fixCard(env, 'F-1', 'C-1'), /fixes a failed card; C-1 is draft/);
  fail(env, 'C-1');
  must(fixCard(env, 'F-1', 'C-1', { round: 1 }), 'fix 1');
  assert.equal(env.record.read('card', 'F-1').doc.round, 2, 'round comes from the chain');
  assert.equal(env.record.read('card', 'F-1').doc.state, 'draft');
  // Naming the root again doesn't reset the round (0b-2 audit MAT-2).
  refused(fixCard(env, 'F-9', 'C-1'), /C-1 already has a fix card/);
  refused(fixCard(env, 'F-2', 'F-1'), /fixes a failed card; F-1 is draft/);
  fail(env, 'F-1');
  must(fixCard(env, 'F-2', 'F-1', { round: 1 }), 'fix 2');
  refused(fixCard(env, 'F-3', 'F-1'), /F-1 already has a fix card/);
  const f2 = env.record.read('card', 'F-2').doc;
  assert.equal(f2.round, 3);
  assert.equal(f2.state, 'waiting', 'over the cap: created waiting on the owner');
  assert.equal(f2.wait.who, 'joe');
  assert.equal(f2.wait.return_to, null);
  refused(put(env.record, 'dispatcher', 'card', 'F-2', { state: 'ready' }), /no way back/);
  refused(put(env.record, 'dispatcher', 'card', 'F-2', { wait: { ...f2.wait, next_check: iso(env.clock.t + 60 * MIN) } }), /round-cap wait changes only by cancel/);
  must(put(env.record, 'approvals', 'card', 'F-2', { state: 'cancelled', cancel_reason: 'the owner: start over' }), 'the owner cancels');
  // The Lead may not supply a round at all; its card is round 1.
  refused(env.record.applyOutbox({ role: 'lead', sessionId: 'L-1' }, outboxFile(env, 'lead', 'L-1', 'roadmap-r7.md', `${JSON.stringify({ entity: 'card', id: 'C-2', expectRev: 0, fields: { product: PRODUCT, kind: 'ordinary', round: 7, ...plan() } })}\n`)), /may not set round/);
  leadCard(env, 'C-2');
  assert.equal(env.record.read('card', 'C-2').doc.round, 1);
});

test('a fix card\'s plan is its root\'s, unchanged, and needs no new go (R2-M5, R3-m2)', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  readyCard(env, 'C-1');
  refused(fixCard(env, 'F-0', 'C-9'), /names the card it fixes/);
  refused(fixCard(env, 'F-0', 'C-1'), /fixes a failed card; C-1 is ready/);
  fail(env, 'C-1');
  refused(fixCard(env, 'F-0', 'C-1', { files: ['src/other.mjs'] }), /files must equal its root card's/);
  refused(env.record.write({ actor: 'dispatcher', entity: 'card', id: 'X-1', expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'ordinary', fix_of: 'C-1', ...plan() } }), /may not create a ordinary card|only a fix card names fix_of/);
  must(fixCard(env, 'F-1', 'C-1'), 'fix');
  must(put(env.record, 'dispatcher', 'card', 'F-1', { state: 'ready' }), 'fix ready on the root go');
  refused(put(env.record, 'dispatcher', 'card', 'F-1', { done_when: 'easier' }), /may not change done_when|fix card's plan/);
});

test('merged needs its merge document; the dispatcher\'s report fields go with their move (0b-2 audit MIN-3, MIN-4)', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  seed(env, 'card', 'C-1', { state: 'merging', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, head: HEAD });
  refused(put(env.record, 'merge_gate', 'card', 'C-1', { state: 'merged' }), /names its merge commit/);
  refused(put(env.record, 'merge_gate', 'card', 'C-1', { state: 'merged', merge_commit: HEAD }), /no merged merge document for C-1/);
  seed(env, 'merge', 'M-1', { state: 'merged', card: 'C-1', merge_commit: HEAD2 });
  refused(put(env.record, 'merge_gate', 'card', 'C-1', { state: 'merged', merge_commit: HEAD }), /no merged merge document/, 'another commit');
  seed(env, 'merge', 'M-2', { state: 'merged', card: 'C-1', merge_commit: HEAD });
  must(put(env.record, 'merge_gate', 'card', 'C-1', { state: 'merged', merge_commit: HEAD }), 'merged with evidence');
  // A merge already audited after merging is still the evidence (round 2 m4).
  seed(env, 'card', 'C-3', { state: 'merging', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, head: HEAD });
  seed(env, 'merge', 'M-3', { state: 'audited_ok', card: 'C-3', merge_commit: HEAD2 });
  must(put(env.record, 'merge_gate', 'card', 'C-3', { state: 'merged', merge_commit: HEAD2 }), 'merged, audit already in');
  readyCard(env, 'C-2');
  runCard(env, 'C-2');
  // A session's hand-in comes only through its own outbox, never a dispatcher write (round 2 m1).
  refused(put(env.record, 'dispatcher', 'card', 'C-2', { state: 'in_review' }), /hand-in comes from its own outbox/);
  refused(put(env.record, 'dispatcher', 'card', 'C-2', { failure: 'x' }), /failure only on a move into failed/);
  refused(put(env.record, 'dispatcher', 'card', 'C-2', { summary: 'x' }), /summary and report_ref only on a tab's hand-in/);
  refused(put(env.record, 'dispatcher', 'card', 'C-2', { state: 'waiting', wait: wait(env), summary: 'x' }), /only on a tab's hand-in/);
  must(put(env.record, 'dispatcher', 'card', 'C-2', { state: 'failed', failure: 'tests fail' }), 'failure with its move');
});

// ---------------- card kinds and their evidence (R3-M3) ----------------

test('exact_reverse needs an answered Undo ask or an authenticated audit issue, then is ready with no go', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  const er = (id, source) => env.record.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'exact_reverse', source, ...plan() } });
  refused(er('U-0', undefined), /needs an answered Undo ask/);
  must(env.record.write({ actor: 'approvals', entity: 'ask', id: 'A-1', expectRev: 0, doc: { state: 'open', kind: 'undo' } }));
  refused(er('U-0', { ask: 'A-1' }), /needs an answered Undo ask/, 'an open ask is not an answer');
  // L85 m-2: answered with no answer, or with Keep, or Undo not approving, is no go for a reverse.
  const A1 = { state: 'answered', kind: 'undo', reask_count: 0, choices: ['Undo', 'Keep'] };
  seed(env, 'ask', 'A-1', A1);
  refused(er('U-0', { ask: 'A-1' }), /needs an answered Undo ask/, 'answered with no answer');
  seed(env, 'ask', 'A-1', { ...A1, answer: { channel: 'tap', choice: 'Keep', approves: false, at: iso(env.clock.t) } });
  refused(er('U-0', { ask: 'A-1' }), /needs an answered Undo ask/, 'Keep');
  seed(env, 'ask', 'A-1', { ...A1, answer: { channel: 'tap', choice: 'Keep', approves: true, at: iso(env.clock.t) } });
  refused(er('U-0', { ask: 'A-1' }), /needs an answered Undo ask/, 'Keep, even marked approving');
  seed(env, 'ask', 'A-1', { ...A1, answer: { channel: 'tap', choice: 'Undo', approves: false, at: iso(env.clock.t) } });
  refused(er('U-0', { ask: 'A-1' }), /needs an answered Undo ask/, 'Undo, not approving');
  seed(env, 'ask', 'A-1', { ...A1, answer: { channel: 'tap', choice: 'Undo', approves: true, at: iso(env.clock.t) } });
  seed(env, 'ask', 'A-2', { state: 'answered', kind: 'question', reask_count: 0 });
  refused(er('U-0', { ask: 'A-2' }), /needs an answered Undo ask/, 'another kind of ask');
  // Look-alikes (L74 addendum): the workshop's own fact of the same type, a Sensors fact outside undo-issue-, and a fact
  // in Sensors' family not written by Sensors (put straight into the store) are never the evidence.
  must(env.record.write({ actor: 'workshop', entity: 'fact', id: 'push.F-w', expectRev: 0, doc: { type: 'undo_issue', authenticated: true } }));
  refused(er('U-0', { fact: 'push.F-w' }), /needs an answered Undo ask/, 'a fact not from Sensors');
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-77', expectRev: 0, doc: { type: 'undo_issue', authenticated: true } }));
  refused(er('U-0', { fact: 'pr-77' }), /needs an answered Undo ask/, 'a Sensors fact outside undo-issue-');
  env.store.transaction((tx) => tx.commit([{ entity: 'fact', id: 'undo-issue-planted', doc: { type: 'undo_issue', authenticated: true } }], { actor: 'dispatcher', kind: 'seed' }));
  refused(er('U-0', { fact: 'undo-issue-planted' }), /needs an answered Undo ask/, 'in the family but not written by Sensors');
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'undo-issue-u', expectRev: 0, doc: { type: 'undo_issue', authenticated: false } }));
  refused(er('U-0', { fact: 'undo-issue-u' }), /needs an answered Undo ask/, 'an unauthenticated issue');
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'undo-issue-a', expectRev: 0, doc: { type: 'undo_issue', authenticated: true } }));
  must(er('U-1', { ask: 'A-1' }), 'from the ask');
  must(er('U-2', { fact: 'undo-issue-a' }), 'from the fact, the look-alikes before it blocking nothing');
  // One reverse per piece of evidence (0b-2 audit MAT-2).
  refused(er('U-3', { ask: 'A-1' }), /ask A-1 already has its exact_reverse card/);
  refused(er('U-3', { fact: 'undo-issue-a' }), /fact undo-issue-a already has its exact_reverse card/);
  // The Lead may not rewrite a go-free card's plan, which would then go to ready with no go (0b-2 audit MAT-1).
  refused(roadmapEdit(env, 'U-2', { files: ['src/anything-else.mjs', 'src/other.mjs'] }), /lead may not change the plan of a exact_reverse card/);
  assert.deepEqual(env.record.read('card', 'U-2').doc.files, plan().files);
  refused(roadmapEdit(env, 'U-2', { brief: 'now also do something else' }), /may not change a exact_reverse card's brief/, 'round 2 m5');
  must(put(env.record, 'dispatcher', 'card', 'U-1', { state: 'ready' }), 'ready with no go');
});

test('research_copy needs an open research ask', () => {
  const env = setup({ prefix: 'm9-wr-' });
  const rc = (id, ask) => env.record.write({ actor: 'dispatcher', entity: 'card', id, expectRev: 0, doc: { state: 'draft', product: PRODUCT, kind: 'research_copy', research_ask: ask, ...plan() } });
  refused(rc('R-0', 'A-9'), /needs an open research ask/);
  seed(env, 'ask', 'A-1', { state: 'open', kind: 'research', reask_count: 0 });
  seed(env, 'ask', 'A-2', { state: 'consumed', kind: 'research', reask_count: 0 });
  refused(rc('R-0', 'A-2'), /needs an open research ask/);
  must(rc('R-1', 'A-1'));
  refused(rc('R-4', 'A-1'), /ask A-1 already has its research_copy card/);
  refused(roadmapEdit(env, 'R-1', { done_when: 'easier' }), /lead may not change the plan of a research_copy card/);
  refused(env.record.write({ actor: 'dispatcher', entity: 'card', id: 'R-2', expectRev: 0, doc: { state: 'ready', product: PRODUCT, kind: 'fix', module: 'M1' } }), /may not create a card in ready|created in draft/);
  refused(env.record.write({ actor: 'dispatcher', entity: 'card', id: 'R-3', expectRev: 0, doc: { state: 'draft', product: 'other-app', kind: 'research_copy', research_ask: 'A-1', ...plan() } }), /belongs to product sample-app/);
});

// ---------------- asks (R3-M1) ----------------

test('ask re-asks: a lapse → open with count 1; a second lapse → expired; a released box → open, count unchanged', () => {
  const env = setup({ prefix: 'm9-wr-' });
  const ask = (id, fields) => put(env.record, 'approvals', 'ask', id, fields);
  must(env.record.write({ actor: 'approvals', entity: 'ask', id: 'A-1', expectRev: 0, doc: { state: 'open', kind: 'question' } }));
  assert.equal(env.record.read('ask', 'A-1').doc.reask_count, 0);
  refused(env.record.write({ actor: 'approvals', entity: 'ask', id: 'A-0', expectRev: 0, doc: { state: 'open', kind: 'question', reask_count: 1 } }), /starts at reask_count 0/);
  must(ask('A-1', { state: 'pushed' }));
  refused(ask('A-1', { state: 'expired' }), /expires only after its one re-ask/, 'expired with count 0');
  must(ask('A-1', { state: 'open', reask_count: 1 }), 'first lapse');
  must(ask('A-1', { state: 'pushed' }));
  refused(ask('A-1', { state: 'open', reask_count: 2 }), /goes up by one/);
  must(ask('A-1', { state: 'expired' }), 'second lapse');
  // A released question box puts an ask back to open with its count unchanged.
  must(env.record.write({ actor: 'approvals', entity: 'ask', id: 'A-2', expectRev: 0, doc: { state: 'open', kind: 'question' } }));
  must(ask('A-2', { state: 'pushed' }));
  must(ask('A-2', { state: 'open' }), 'released');
  assert.equal(env.record.read('ask', 'A-2').doc.reask_count, 0);
  refused(ask('A-2', { reask_count: 1 }), /goes up by one, only with a first lapse/);
  // An open ask lapses in place by setting lapsed_at, then expires straight from open (0b-5 M5-2).
  must(ask('A-2', { reask_count: 1, lapsed_at: iso(env.clock.t) }), 'open ask lapses in place');
  refused(ask('A-2', { lapsed_at: iso(env.clock.t + 1), reask_count: 2 }), /goes up by one/);
  must(ask('A-2', { state: 'expired' }), 'second lapse from open');
  // An answered ask goes back to open only on its first lapse, never as a released box (M5-2).
  must(env.record.write({ actor: 'approvals', entity: 'ask', id: 'A-3', expectRev: 0, doc: { state: 'open', kind: 'question' } }));
  must(ask('A-3', { state: 'pushed' })); must(ask('A-3', { state: 'answered' }));
  refused(ask('A-3', { state: 'open' }), /answered ask goes back to open only on its first lapse/);
  must(ask('A-3', { state: 'open', reask_count: 1 }), 'the 24-hour rule');
});

// ---------------- sessions (G2) ----------------

test('sessions: no resume after a usage limit for the Lead or a Tier-1 card; only the Lead recycles; quarantine ends on an answer', () => {
  const env = setup({ prefix: 'm9-wr-' });
  const limit = { who: 'usage', what: 'limit', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN) };
  seed(env, 'card', 'T1', { state: 'running', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1, tier: 1, claim: { kind: 'tab', claim_id: 'x', host: 'h' } });
  seed(env, 'session', 'L-1', { state: 'waiting_limit', role: 'lead', wait: limit });
  seed(env, 'session', 'S-1', { state: 'waiting_limit', role: 'worker', card: 'T1', wait: limit });
  seed(env, 'session', 'S-2', { state: 'waiting_limit', role: 'worker', card: null, wait: limit });
  const resume = (id) => { const cur = env.record.read('session', id); const doc = { ...cur.doc, state: 'running' }; delete doc.wait; return env.record.write({ actor: 'dispatcher', entity: 'session', id, expectRev: cur.rev, doc }); };
  refused(resume('L-1'), /Lead never resumes/);
  refused(resume('S-1'), /Tier-1 card's session never resumes/);
  must(resume('S-2'), 'a Tier-2 worker resumes');
  refused(put(env.record, 'workshop', 'session', 'S-2', { state: 'recycling' }), /only the Lead's session recycles/);
  seed(env, 'session', 'Q-1', { state: 'quarantined', role: 'worker', card: 'T1' });
  refused(put(env.record, 'dispatcher', 'session', 'Q-1', { state: 'ended' }), /ends only once its card is final or the owner has answered/);
  seed(env, 'ask', 'A-1', { state: 'consumed', kind: 'question', session: 'Q-1', reask_count: 0 });
  must(put(env.record, 'dispatcher', 'session', 'Q-1', { state: 'ended' }), 'answered');
});

// ---------------- products ----------------

test('products: a pause records where to return, and returns only there', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env, 'light');
  refused(put(env.record, 'approvals', 'product', PRODUCT, { state: 'paused' }), /records the state to return to/);
  refused(put(env.record, 'approvals', 'product', PRODUCT, { state: 'paused', return_to: 'active' }), /records the state to return to/);
  must(put(env.record, 'approvals', 'product', PRODUCT, { state: 'paused', return_to: 'light' }));
  refused(put(env.record, 'approvals', 'product', PRODUCT, { return_to: 'active' }), /changes only with a pause/);
  refused(put(env.record, 'approvals', 'product', PRODUCT, { state: 'active' }), /returns only to light/);
  must(put(env.record, 'approvals', 'product', PRODUCT, { state: 'light' }));
  assert.equal(env.record.read('product', PRODUCT).doc.return_to, undefined, 'return_to is cleared');
  refused(env.record.write({ actor: 'approvals', entity: 'product', id: 'other-app', expectRev: 0, doc: { state: 'active' } }), /product sample-app's/);
});

// ---------------- verdicts (R2-M7) ----------------

test('verified needs a passing verdict for the current head from a reviewer launched on this card', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  readyCard(env, 'C-1');
  runCard(env, 'C-1');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD }));
  must(env.record.applyOutbox({ role: 'worker', sessionId: 'S-1', card: 'C-1' }, outboxFile(env, 'worker', 'S-1', 'handin-v.md', `${JSON.stringify({ entity: 'card', id: 'C-1', from_state: 'running', to_state: 'in_review' })}\n`)));
  const vfile = (sid, name, header) => outboxFile(env, 'reviewer', sid, name, `${JSON.stringify(header)}\n`);
  const apply = (sid, name, header) => env.review.applyOutbox({ role: 'reviewer', sessionId: sid, card: 'C-1' }, vfile(sid, name, header));
  // A reviewer's pass carries a clean checklist (M9 PASSES, L69).
  const hdr = (fields, over = {}) => ({ entity: 'verdict', card: 'C-1', expectRev: env.record.read('card', 'C-1').rev, fields: fields.pass === true ? { checklist: CLEAN_CHECKLIST, ...fields } : fields, ...over });
  // The verdict file's own checks.
  refused(apply('R-1', 'verdict-a.md', hdr({ head: HEAD, pass: true, state: 'verified' })), /may not set state/);
  refused(apply('R-1', 'verdict-b.md', hdr({ head: 'short', pass: true })), /40-hex head/);
  refused(apply('R-1', 'verdict-c.md', hdr({ head: HEAD, pass: 'yes' })), /pass: true or false/);
  refused(apply('R-1', 'verdict-d.md', hdr({ head: HEAD, pass: true }, { card: 'C-2' })), /own card/);
  // A verdict from a session the launcher never recorded is refused at intake (L44 planted case).
  refused(apply('R-1', 'verdict-f.md', hdr({ head: HEAD, pass: true })), /no launch of reviewer session R-1 on C-1/);
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass for head aaaaaaa/);
  // A reviewer launched for another head doesn't verify this one (round 5 m-4).
  runnerLaunch(env, 'C-1', 'R-3', 'reviewer', HEAD2);   // launched for another head
  refused(apply('R-3', 'verdict-f2.md', hdr({ head: HEAD, pass: true })), /no launch of reviewer session R-3 on C-1 at head aaaaaaa/);
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass for head aaaaaaa/);
  runnerLaunch(env, 'C-1', 'R-2');
  must(apply('R-2', 'verdict-g.md', hdr({ head: HEAD, pass: false })), 'a fail');
  runnerEndedRecord(env, 'C-1', 'R-2');
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /the reviewer session R-2 did not pass for head aaaaaaa/);
  // A verdict naming a head the session wasn't launched on is refused at intake (L44 planted case). Its file stays in
  // R-2's folder, so R-2 now holds two verdict files: it can't be counted, and that counts as a failure (L68).
  refused(apply('R-2', 'verdict-h.md', hdr({ head: HEAD2, pass: true })), /no launch of reviewer session R-2 on C-1 at head bbbbbbb/);
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /R-2's verdict can't be counted, so it counts as a failure: more than one verdict file/);
  // One verdict per session: R-2 already said fail, so a second file is refused at intake.
  refused(apply('R-2', 'verdict-i0.md', hdr({ head: HEAD, pass: true })), /already given its verdict/);
  // L68: a pass from a new launch on the same head never outruns R-2's fail. The head is fixed with a new push instead.
  runnerLaunch(env, 'C-1', 'R-5');
  must(apply('R-5', 'verdict-i.md', hdr({ head: HEAD, pass: true })), 'a later pass on the same head');
  runnerEndedRecord(env, 'C-1', 'R-5');
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /R-2's verdict can't be counted/);
  // R-3 (launched on HEAD2) left a verdict naming another head, so HEAD2 can't pass either: a fresh head, HEAD4.
  const HEAD4 = 'd'.repeat(40);
  // L68 (3): the intake matches a verdict on card, head and launched session, not on the card's revision.
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD4 }), 'a new head while in review');
  // The new head needs a reviewer launched on it: R-2 was launched on the old one (round 5 m-4).
  refused(apply('R-2', 'verdict-j0.md', hdr({ head: HEAD4, pass: true })), /no launch of reviewer session R-2/);
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass for head ddddddd/);
  runnerLaunch(env, 'C-1', 'R-4', 'reviewer', HEAD4);   // launched on the new head
  must(apply('R-4', 'verdict-j.md', hdr({ head: HEAD4, pass: true }, { expectRev: 1 })), 'the pass for the new head, its expectRev stale');
  runnerEndedRecord(env, 'C-1', 'R-4', 'reviewer', HEAD4);
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), 'verified');
  // A new head after verification sends it back to review.
  const HEAD3 = 'c'.repeat(40);
  refused(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD3 }), /sends it back to in_review/);
  // A head pushed while a verified card waits doesn't come back verified unreviewed (0b-2 audit round 3 MAT-A).
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env, { resume: 'continue', return_to: 'verified' }) }), 'paused');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: HEAD3 }), 'a push while it waits');
  refused(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'verified' }), /no reviewer session handed in a pass for head ccccccc/);
});

test('a doc nested too deep is refused, so it can never freeze its card (0b-2 audit round 3 MAT-B)', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  leadCard(env, 'C-1');
  let deep = 'x';
  for (let i = 0; i < 3000; i++) deep = [deep];
  refused(roadmapEdit(env, 'C-1', { brief: deep }), /nested deeper than 32 levels/);
  let ok = 'x';
  for (let i = 0; i < 20; i++) ok = [ok];
  must(roadmapEdit(env, 'C-1', { brief: ok }), 'a shallow brief');
  // The diary line's data too: one deep value would break every diary read (round 4 m-2).
  refused(put(env.record, 'approvals', 'card', 'C-1', { needs_joe: false }, { data: deep }), /data is nested deeper than 32 levels/);
  env.record.diary();
  must(put(env.record, 'approvals', 'card', 'C-1', { state: 'cancelled', cancel_reason: 'test' }), 'the card still takes writes');
});

// ---------------- merges ----------------

test('a merge request needs an approved card, or a verified one that doesn\'t need the owner', () => {
  const env = setup({ prefix: 'm9-wr-' });
  const base = { product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 };
  seed(env, 'card', 'C-a', { ...base, state: 'approved' });
  seed(env, 'card', 'C-v', { ...base, state: 'verified' });
  seed(env, 'card', 'C-j', { ...base, state: 'verified', needs_joe: true });
  seed(env, 'card', 'C-r', { ...base, state: 'verified', approval_required: true });
  seed(env, 'card', 'C-i', { ...base, state: 'in_review' });
  const mr = (card) => env.record.write({ actor: 'dispatcher', entity: 'merge_request', id: `mr-${card}`, expectRev: 0,
    doc: { card, pr: 1, session_id: 'S-1', head: HEAD, rev: 1, requested_at: iso(env.clock.t) } });
  must(mr('C-a'), 'approved');
  must(mr('C-v'), 'verified, no the owner');
  refused(mr('C-j'), /needs the owner; no merge request yet/);
  refused(mr('C-r'), /needs the owner/);
  refused(mr('C-i'), /is in_review/);
  refused(mr('C-x'), /missing card/);
  refused(env.record.write({ actor: 'merge_gate', entity: 'merge_request', id: 'mr-g', expectRev: 0, doc: { card: 'C-a', pr: 1, session_id: 'S-1', head: HEAD, rev: 1, requested_at: iso(env.clock.t) } }), /may not create/);
});

test('one merge at a time, and a verified card that needs the owner never enters merging', () => {
  const env = setup({ prefix: 'm9-wr-' });
  const base = { product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 };
  seed(env, 'card', 'C-1', { ...base, state: 'approved' });
  seed(env, 'card', 'C-2', { ...base, state: 'approved' });
  seed(env, 'card', 'C-3', { ...base, state: 'verified', needs_joe: true });
  for (const [m, c] of [['M-1', 'C-1'], ['M-2', 'C-2'], ['M-3', 'C-3']]) seed(env, 'merge', m, { state: 'queued', card: c });
  const check = (m, c) => {
    const card = env.record.read('card', c);
    return env.record.write({ actor: 'merge_gate', entity: 'merge', id: m, expectRev: env.record.read('merge', m).rev, doc: { state: 'checking', card: c },
      also: [{ entity: 'card', id: c, expectRev: card.rev, doc: { ...card.doc, state: 'merging' } }] });
  };
  refused(put(env.record, 'merge_gate', 'merge', 'M-1', { state: 'checking' }), /same write as its card moves to merging/);
  refused(put(env.record, 'merge_gate', 'card', 'C-1', { state: 'merging' }), /same write as its merge enters checking/);
  refused(check('M-3', 'C-3'), /needs the owner's Approve/);
  must(check('M-1', 'C-1'), 'first merge');
  refused(check('M-2', 'C-2'), /one merge at a time: M-1 is checking/);
  assert.equal(env.record.read('card', 'C-2').doc.state, 'approved', 'the pair is all or nothing');
  // The checking merge can't be re-pointed to put a second card into merging (0b-2 audit round 3 m-B).
  refused(check('M-1', 'C-2'), /card is set when it is made/);
  refused(put(env.record, 'merge_gate', 'merge', 'M-2', { card: 'C-3' }), /card is set when it is made/);
  // A merge already in checking can't be paired again to put its card into merging beside another (round 4 m-3).
  seed(env, 'merge', 'M-9', { state: 'checking', card: 'C-2' });
  const c2 = env.record.read('card', 'C-2');
  refused(env.record.write({ actor: 'merge_gate', entity: 'merge', id: 'M-9', expectRev: env.record.read('merge', 'M-9').rev, doc: { state: 'checking', card: 'C-2', note: 'again' },
    also: [{ entity: 'card', id: 'C-2', expectRev: c2.rev, doc: { ...c2.doc, state: 'merging' } }] }), /must be entering checking/);
  assert.equal(env.record.read('card', 'C-2').doc.state, 'approved');
});

test('the audit result comes from a Sensors audit_run fact for the merged commit', () => {
  const env = setup({ prefix: 'm9-wr-' });
  seed(env, 'merge', 'M-1', { state: 'merged', card: 'C-1', merge_commit: HEAD });
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-other', expectRev: 0, doc: { type: 'audit_run', commit: HEAD2, conclusion: 'success' } }));
  // Look-alikes (L74 addendum): the workshop's own, Sensors' outside audit-run-, and one in the family not by Sensors.
  must(env.record.write({ actor: 'workshop', entity: 'fact', id: 'push.ok-forged', expectRev: 0, doc: { type: 'audit_run', commit: HEAD, conclusion: 'success' } }));
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-ok', expectRev: 0, doc: { type: 'audit_run', commit: HEAD, conclusion: 'success' } }));
  env.store.transaction((tx) => tx.commit([{ entity: 'fact', id: 'audit-run-planted', doc: { type: 'audit_run', commit: HEAD, conclusion: 'success' } }], { actor: 'merge_gate', kind: 'seed' }));
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'audit-run-bad', expectRev: 0, doc: { type: 'audit_run', commit: HEAD, conclusion: 'failure' } }));
  const audit = (to, fact) => put(env.record, 'merge_gate', 'merge', 'M-1', { state: to }, { data: { fact } });
  refused(audit('audited_ok', undefined), /comes from a Sensors audit_run fact/);
  refused(audit('audited_ok', 'push.ok-forged'), /comes from a Sensors audit_run fact/);
  refused(audit('audited_ok', 'pr-ok'), /comes from a Sensors audit_run fact/);
  refused(audit('audited_ok', 'audit-run-planted'), /comes from a Sensors audit_run fact/);
  refused(audit('audited_ok', 'audit-run-other'), /for another commit/);
  refused(audit('audited_ok', 'audit-run-bad'), /concluded failure, so the merge is audit_flagged/);
  must(audit('audit_flagged', 'audit-run-bad'));
});

test('L85 M-1 (b): an interrupted merge becomes merged only with the Sensors reading of its PR, merged at the judged head', () => {
  const env = setup({ prefix: 'm9-wr-' });
  seed(env, 'merge', 'M-1', { state: 'refused', reasons: ['interrupted'], card: 'C-1', pr: 7, judged_head: HEAD2 });
  seed(env, 'merge', 'M-2', { state: 'refused', reasons: ['timeout'], card: 'C-2', pr: 8, judged_head: HEAD2 });
  const reading = (id, doc) => must(env.record.write({ actor: 'sensors', entity: 'fact', id, expectRev: 0, doc: { merged: true, merge_commit_sha: HEAD, head_sha: HEAD2, observed_at: iso(env.clock.t), ...doc } }));
  reading('pr-7', {});
  reading('pr-8', {});
  reading('pr-6', {});
  must(env.record.write({ actor: 'workshop', entity: 'fact', id: 'push.pr-7', expectRev: 0, doc: { merged: true, merge_commit_sha: HEAD, head_sha: HEAD2 } }));
  const rec = (id, fact, patch = {}) => put(env.record, 'merge_gate', 'merge', id, { state: 'merged', merge_commit: HEAD, merged_at: iso(env.clock.t), ...patch }, { data: { fact } });
  refused(rec('M-2', 'pr-8'), /only an interrupted merge is reconciled/);
  refused(rec('M-1', undefined), /Sensors reading of this merge's PR/);
  refused(rec('M-1', 'push.pr-7'), /Sensors reading of this merge's PR/);
  refused(rec('M-1', 'pr-6'), /Sensors reading of this merge's PR/, 'another PR');
  refused(rec('M-1', 'pr-7', { merge_commit: undefined }), /names its merge commit/);
  refused(rec('M-1', 'pr-7', { merge_commit: 'f'.repeat(40) }), /does not show this PR merged at the judged head with this commit/);
  refused(rec('M-1', 'pr-7', { judged_head: HEAD }), /judged head never changes/);
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: env.record.read('fact', 'pr-7').rev, doc: { ...env.record.read('fact', 'pr-7').doc, head_sha: HEAD } }));
  refused(rec('M-1', 'pr-7'), /does not show this PR merged at the judged head/, 'merged at another head');
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: env.record.read('fact', 'pr-7').rev, doc: { ...env.record.read('fact', 'pr-7').doc, head_sha: HEAD2, merged: false } }));
  refused(rec('M-1', 'pr-7'), /does not show this PR merged/, 'not merged');
  must(env.record.write({ actor: 'sensors', entity: 'fact', id: 'pr-7', expectRev: env.record.read('fact', 'pr-7').rev, doc: { ...env.record.read('fact', 'pr-7').doc, merged: true } }));
  refused(put(env.record, 'dispatcher', 'merge', 'M-1', { state: 'merged', merge_commit: HEAD }, { data: { fact: 'pr-7' } }), /./, 'only the Merge Gate');
  // L94 m-B: the reading must be Sensors' own, not just named pr-<n>. A pr-5 entry another role put below the writer
  // (the second wall: the fact families stop it at the writer too) is no reading.
  seed(env, 'merge', 'M-5', { state: 'refused', reasons: ['interrupted'], card: 'C-5', pr: 5, judged_head: HEAD2 });
  env.store.transaction((tx) => tx.commit([{ entity: 'fact', id: 'pr-5', doc: { merged: true, merge_commit_sha: HEAD, head_sha: HEAD2, observed_at: iso(env.clock.t) } }], { actor: 'merge_gate', kind: 'seed' }));
  refused(rec('M-5', 'pr-5'), /Sensors reading of this merge's PR/, 'a pr- entry Sensors did not make');
  must(rec('M-1', 'pr-7'));
});

// ---------------- overdue ----------------

test('overdue: a state past its limit by a minute is listed, a minute before is not; a wait past next_check is listed', () => {
  const env = setup({ prefix: 'm9-wr-' });
  product(env);
  readyCard(env, 'C-1');
  const t0 = env.clock.t;
  const ids = (at) => env.record.overdue(at).map((o) => `${o.entity}/${o.id}`);
  assert.ok(!ids(t0 + 59 * MIN).includes('card/C-1'));
  assert.ok(ids(t0 + 61 * MIN).includes('card/C-1'));
  const row = env.record.overdue(t0 + 61 * MIN).find((o) => o.id === 'C-1');
  assert.equal(row.limit, 60);
  assert.equal(row.then, 'alert');
  // A draft has no limit, only a reason: never overdue by time.
  leadCard(env, 'D-1');
  assert.ok(!ids(t0 + 10000 * MIN).includes('card/D-1'));
  // A waiting card is overdue once its next_check passes.
  runCard(env, 'C-1');
  env.clock.t = t0 + 5 * MIN;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(env) }));
  assert.ok(!ids(t0 + 34 * MIN).includes('card/C-1'));
  assert.equal(env.record.overdue(t0 + 36 * MIN).find((o) => o.id === 'C-1')?.limit, 'next_check');
  // A state with no rule at all is reported, not skipped.
  const env2 = setup({ prefix: 'm9-wr-', values: { timeouts: { card: {} } } });
  seed(env2, 'card', 'C-1', { state: 'in_review', product: PRODUCT, module: 'M1', kind: 'ordinary', round: 1 });
  const bad = env2.record.overdue(env2.clock.t).find((o) => o.id === 'C-1');
  assert.equal(bad.corrupt, true);
  assert.match(bad.reason, /no time limit for card in_review/);
});

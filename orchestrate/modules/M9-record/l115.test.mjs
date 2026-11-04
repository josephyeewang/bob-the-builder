// l115.test.mjs — L115 m-A: heartbeatLimit, the one reading of proposals.heartbeat_stale_min that lane 3's fit check
// calls; L116: an approved card whose merge is refused twice can be put on the owner (approved → waiting → approved),
// on the real Record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, PRODUCT, iso, must, outboxFile, passingVerdict, product, put, readyCard, seed, setup } from './fixtures.test-helper.mjs';
import { heartbeatLimit } from './writer.mjs';
import { fakeRules } from '../../shared/rules.mjs';
import { MOVES } from './moves.mjs';

const MIN = 60000;
// A rules object over text values, the way yaml-lite hands them back.
const textRules = (values) => fakeRules({ values });

test('L115 m-A: heartbeatLimit reads through num(), with the product, and a limit below 1 is no limit', () => {
  const seen = [];
  const spy = (values) => { const r = textRules(values); return { ...r, num: (k, o) => { seen.push([k, o?.product]); return r.num(k, o); } }; };
  assert.equal(heartbeatLimit(spy({ 'proposals.heartbeat_stale_min': '10' }), PRODUCT), 10);
  assert.deepEqual(seen, [['proposals.heartbeat_stale_min', PRODUCT]]);
  assert.equal(heartbeatLimit(textRules({ 'proposals.heartbeat_stale_min': 10 }), PRODUCT), 10);
  for (const v of ['0', '-3', '1.5', '030', 'ten', '', undefined, null, true]) {
    assert.equal(heartbeatLimit(textRules({ 'proposals.heartbeat_stale_min': v }), PRODUCT), undefined, String(v));
  }
  assert.equal(heartbeatLimit(undefined, PRODUCT), undefined, 'no rules at all is no limit, not a crash');
});

test('L116: MOVES lets the dispatcher put an approved card on the owner and bring it back', () => {
  assert.ok(MOVES.card.approved.waiting, 'approved → waiting');
  assert.ok(MOVES.card.waiting.approved, 'waiting → approved');
});

test('L116, the real Record: approved → waiting (resume continue, return_to approved) → approved', () => {
  const env = setup({ prefix: 'm9-l116-' });
  product(env);
  readyCard(env, 'C-1');
  seed(env, 'card', 'C-1', { ...env.record.read('card', 'C-1').doc, state: 'approved', head: HEAD });
  const wait = (over = {}) => ({ who: 'joe', what: 'the merge was refused twice', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN), resume: 'continue', return_to: 'approved', ...over });
  // Only the dispatcher moves it, and only with a wait that comes back to approved.
  for (const actor of ['lead', 'workshop', 'merge_gate']) {
    assert.equal(put(env.record, actor, 'card', 'C-1', { state: 'waiting', wait: wait() }).ok, false, actor);
  }
  const r = put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait({ return_to: 'in_review' }) });
  assert.equal(r.ok, false); assert.match(r.reason, /continue returns to approved/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait() }), 'approved → waiting');
  assert.equal(env.record.read('card', 'C-1').doc.state, 'waiting');
  const back = put(env.record, 'dispatcher', 'card', 'C-1', { state: 'ready' });
  assert.equal(back.ok, false); assert.match(back.reason, /returns only to approved/);
  // Coming back to approved still needs a pass for the head, like every way into approved.
  assert.equal(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'approved' }).ok, false, 'no pass yet');
  passingVerdict(env, 'C-1', 'R-1');
  // A move needing a verdict goes through the view that knows the review user (as in moves.test).
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'approved' }), 'waiting → approved');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'approved');
  assert.equal(c.wait, undefined, 'the return clears the wait');
});

// L123 m-2, m-3, m-4 on the real Record: an approved card put on the owner.
function approvedWaiting(prefix) {
  const env = setup({ prefix });
  product(env);
  readyCard(env, 'C-1');
  seed(env, 'card', 'C-1', { ...env.record.read('card', 'C-1').doc, state: 'approved', head: HEAD });
  const wait = (over = {}) => ({ who: 'joe', what: 'the merge was refused twice', since: iso(env.clock.t), next_check: iso(env.clock.t + 30 * MIN), resume: 'continue', return_to: 'approved', ...over });
  return { env, wait };
}

test('L123 m-2: only the dispatcher brings a waiting card back to approved', () => {
  const { env, wait } = approvedWaiting('m9-l123a-');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait() }), 'approved → waiting');
  passingVerdict(env, 'C-1', 'R-1');
  for (const actor of ['lead', 'workshop', 'merge_gate', 'approvals']) {
    const r = put(env.review, actor, 'card', 'C-1', { state: 'approved' });
    assert.equal(r.ok, false, `${actor}: ${r.reason}`);
    assert.equal(env.record.read('card', 'C-1').doc.state, 'waiting', actor);
  }
  // The lead is an AI role: its one way to move a card is a roadmap- file in its outbox. That is refused too.
  const move = `${JSON.stringify({ entity: 'card', id: 'C-1', expectRev: env.record.read('card', 'C-1').rev, from_state: 'waiting', to_state: 'approved' })}\n`;
  const viaOutbox = env.record.applyOutbox({ role: 'lead', sessionId: 'L-1' }, outboxFile(env, 'lead', 'L-1', 'roadmap-C-1.md', move));
  assert.equal(viaOutbox.ok, false, viaOutbox.reason);
  assert.match(viaOutbox.reason, /may not move card waiting → approved/);
  assert.equal(env.record.read('card', 'C-1').doc.state, 'waiting', 'lead outbox');
  must(put(env.review, 'dispatcher', 'card', 'C-1', { state: 'approved' }), 'the dispatcher may');
});

test('L123 m-3: an approved card waits only with resume continue, back to approved (probe A refused)', () => {
  const { env, wait } = approvedWaiting('m9-l123b-');
  for (const over of [{ resume: 'retry', return_to: 'ready' }, { resume: 'retry', return_to: 'approved' }, { resume: 'continue', return_to: 'ready' },
    { resume: 'continue', return_to: 'verified' }, { resume: 'continue', return_to: 'in_review' }, { resume: null, return_to: null }]) {
    const r = put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait(over) });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(env.record.read('card', 'C-1').doc.state, 'approved');
  }
  assert.match(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait({ resume: 'retry', return_to: 'ready' }) }).reason, /approved card waits only with resume: continue/);
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait() }), 'continue → approved');
});

test('L123 m-4: a head pushed while an approved card waits sends it back through review, never straight to approved (probe B)', () => {
  const { env, wait } = approvedWaiting('m9-l123c-');
  const OTHER = (c) => c.repeat(40);
  // The caller cannot pick the head the wait remembers.
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait({ head: OTHER('f') }) }), 'approved → waiting');
  assert.equal(env.record.read('card', 'C-1').doc.wait.head, HEAD);
  // A re-check keeps it.
  env.clock.t += MIN * 5;
  must(put(env.record, 'dispatcher', 'card', 'C-1', { wait: wait({ head: OTHER('d') }) }), 're-check');
  assert.equal(env.record.read('card', 'C-1').doc.wait.head, HEAD);
  const NEW = OTHER('b');
  must(put(env.record, 'workshop', 'card', 'C-1', { head: NEW }), 'a new head while it waits');
  passingVerdict(env, 'C-1', 'R-2', NEW);
  const r = put(env.review, 'dispatcher', 'card', 'C-1', { state: 'approved' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /head changed while the card waited/);
  // It goes back to in_review, and from there through verified to approved as any new head does.
  assert.equal(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'ready' }).ok, false, 'only in_review');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'in_review' }), 'waiting → in_review');
  const c = env.record.read('card', 'C-1').doc;
  assert.equal(c.state, 'in_review');
  assert.equal(c.wait, undefined);
});

test('L123 m-4: with the head unchanged, the way back is approved only', () => {
  const { env, wait } = approvedWaiting('m9-l123d-');
  must(put(env.record, 'dispatcher', 'card', 'C-1', { state: 'waiting', wait: wait() }), 'approved → waiting');
  const r = put(env.record, 'dispatcher', 'card', 'C-1', { state: 'in_review' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /returns only to approved/);
});

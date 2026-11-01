// l115.test.mjs — L115 m-A: heartbeatLimit, the one reading of proposals.heartbeat_stale_min that lane 3's fit check
// calls; L116: an approved card whose merge is refused twice can be put on the owner (approved → waiting → approved),
// on the real Record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, PRODUCT, iso, must, passingVerdict, product, put, readyCard, seed, setup } from './fixtures.test-helper.mjs';
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

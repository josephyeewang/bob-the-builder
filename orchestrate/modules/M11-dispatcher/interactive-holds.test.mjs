// interactive-holds.test.mjs — R-0b-175a (d)(4): a Lead, Front Door or Mini Base session the owner-side runner holds is
// told to the owner once, through the real alert queue. A status that can't be read is told as such, once, and clears
// nothing. The relay is not yet wired into timeLimits (as drainHolds was not), so the port's throw is caught here as
// timeLimits catches drainHolds'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTIVE_HOLD_FACT, INTERACTIVE_UNKNOWN_FACT, relayInteractiveHolds } from './interactive-holds.mjs';
import { recWith, T0, MIN, withAlerts } from './fixtures.test-helper.mjs';

const DAY = 24 * 60 * MIN;
const since = new Date(T0).toISOString();
const held = (sessionId, role = 'lead', launchId = 'L1', reason = 'no first signal within 120 s of its start') => ({ sessionId, role, product: role === 'lead' ? 'p1' : null, reason, since, launchId });
const STORE = { sessionId: null, role: null, product: null, reason: 'the hook store can\'t be read (Unexpected token)', since, launchId: null };

function world() {
  const rec = recWith();
  const run = async (at, interactiveHolds, deliver = true) => {
    const got = [];
    let held = null; let error;
    try { held = await interactiveHolds(); } catch (e) { error = e?.message ?? String(e); }
    await withAlerts(rec, at, (t) => { got.push(t); return deliver; },
      (alert) => relayInteractiveHolds({ rec, held, error, alert, now: at, report: (line) => assert.fail(line) }));
    return got;
  };
  return { rec, run };
}

test('R-0b-175a (d)(4): one held session over two Dispatcher passes is told once, and not again a day on', async () => {
  const w = world();
  const got = await w.run(T0, () => [held('lead-1')]);
  assert.equal(got.length, 1);
  assert.match(got[0], /^owner runner: the Lead session lead-1 \(product p1\) is held: no first signal within 120 s of its start \(since .*\)\. Nothing is typed into it and it is not restarted/);
  assert.ok(w.rec.read('fact', INTERACTIVE_HOLD_FACT('lead-1'))?.doc?.told_at, 'marked once delivered');
  assert.deepEqual(await w.run(T0 + MIN, () => [held('lead-1')]), [], 'the second pass: quiet');
  assert.deepEqual(await w.run(T0 + 2 * DAY, () => [held('lead-1')]), [], 'no daily repeat');
});

test('R-0b-175a (d)(4): the once-mark is keyed by session, reason and launch id; each role is its own hold; a return is told afresh', async () => {
  const w = world();
  assert.equal((await w.run(T0, () => [held('lead-1'), held('fd-1', 'frontDoor', 'F1'), held('mb-1', 'minibase', 'M1')])).length, 3);
  const relaunched = await w.run(T0 + MIN, () => [held('lead-1', 'lead', 'L2'), held('fd-1', 'frontDoor', 'F1'), held('mb-1', 'minibase', 'M1')]);
  assert.equal(relaunched.length, 1, 'a new launch id is a new hold');
  assert.match(relaunched[0], /the Lead session lead-1/);
  assert.equal((await w.run(T0 + 2 * MIN, () => [held('lead-1', 'lead', 'L2', 'another reason'), held('fd-1', 'frontDoor', 'F1'), held('mb-1', 'minibase', 'M1')])).length, 1, 'a new reason too');
  // The Front Door's hold ends: its mark is cleared, the others kept; it comes back -> told afresh.
  assert.deepEqual(await w.run(T0 + 3 * MIN, () => [held('lead-1', 'lead', 'L2', 'another reason'), held('mb-1', 'minibase', 'M1')]), []);
  assert.equal(w.rec.read('fact', INTERACTIVE_HOLD_FACT('fd-1'))?.doc?.told_at ?? null, null);
  assert.ok(w.rec.read('fact', INTERACTIVE_HOLD_FACT('mb-1')).doc.told_at);
  const back = await w.run(T0 + 4 * MIN, () => [held('lead-1', 'lead', 'L2', 'another reason'), held('fd-1', 'frontDoor', 'F1'), held('mb-1', 'minibase', 'M1')]);
  assert.equal(back.length, 1); assert.match(back[0], /the Front Door session fd-1 is held/);
});

test('R-0b-175a (d)(4): a hook store that can\'t be read is told once, as every send held', async () => {
  const w = world();
  const got = await w.run(T0, () => [STORE]);
  assert.equal(got.length, 1);
  assert.match(got[0], /^owner runner: the hook store can't be read \(Unexpected token\), so no Lead, Front Door or Mini Base session is typed into until it is fixed by hand/);
  assert.deepEqual(await w.run(T0 + MIN, () => [STORE]), []);
  assert.deepEqual(await w.run(T0 + 2 * DAY, () => [STORE]), [], 'said once');
});

test('R-0b-175a (d)(4): not delivered is not marked, so it is sent again next pass', async () => {
  const w = world();
  assert.equal((await w.run(T0, () => [held('lead-1')], false)).length, 1);
  assert.equal(w.rec.read('fact', INTERACTIVE_HOLD_FACT('lead-1'))?.doc?.told_at, undefined);
  assert.equal((await w.run(T0 + MIN, () => [held('lead-1')])).length, 1, 'sent again');
});

test('R-0b-175a (d)(4): a status that can\'t be read is told once on its own hold and clears no session\'s hold', async () => {
  const w = world();
  await w.run(T0, () => [held('lead-1')]);
  for (const [i, port] of [() => { throw new Error('the status is 9 minutes old'); }, async () => { throw new Error('EIO'); }, () => null, () => 'x',
    () => [held('lead-1'), { ...held('x'), role: 'worker' }], () => [null]].entries()) {
    const got = await w.run(T0 + (i + 1) * MIN, port);
    if (i === 0) {
      assert.equal(got.length, 1);
      assert.match(got[0], /^owner runner: its status could not be read, so whether a Lead, Front Door or Mini Base session is held is not known \(the status is 9 minutes old\)/);
    } else assert.deepEqual(got, [], `the same unknown, said once (${i})`);
    assert.ok(w.rec.read('fact', INTERACTIVE_HOLD_FACT('lead-1')).doc.told_at, `lead-1's hold is kept (${i})`);
  }
  assert.deepEqual(await w.run(T0 + 2 * DAY, () => { throw new Error('still'); }), [], 'no daily repeat');
  assert.deepEqual(await w.run(T0 + 2 * DAY + MIN, () => [held('lead-1')]), [], 'readable again: lead-1 still quiet');
  assert.equal(w.rec.read('fact', INTERACTIVE_UNKNOWN_FACT)?.doc?.told_at ?? null, null, 'the unknown hold is cleared');
});

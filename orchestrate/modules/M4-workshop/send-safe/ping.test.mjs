// L135 F: the needs-input ping's answer counts. A lost one (false or a throw) is sent again, never dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, MemoryStore, State } from './activity.mjs';
import { fakeAlert } from '../../../test/fake-alert.test-helper.mjs';

const sig = (state, event, toolName = '', toolUseId = '') => ({ valid: true, state, event, toolName, toolUseId });

function rig(answers) {
  const store = new MemoryStore();
  // answers[n] is the n-th ping's answer ('throw' throws); past the list every ping is sent.
  const notify = fakeAlert({ answer: (_, n) => (n < answers.length ? answers[n] : true), throws: (_, n) => answers[n] === 'throw' && 'down' });
  const sent = notify.calls;
  const t = new ActivityTracker(store, { notify });
  store.set('s-1', { id: 's-1', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
  const block = () => {
    t.applySignal('s-1', sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_1'));
    t.applySignal('s-1', sig(State.BLOCKED, 'permission-request', 'Bash', ''));
  };
  return { t, store, sent, block, rec: () => store.get('s-1') };
}

for (const lost of [false, 'throw']) {
  test(`L135 F: a ping that answers ${lost === false ? 'false' : 'with a throw'} is owed, and the reaper's next look sends it again`, () => {
    const h = rig([lost]);
    h.block();
    assert.equal(h.sent.length, 1);
    assert.equal(h.rec().pingPending, true, 'the lost ping is marked owed');
    assert.equal(h.rec().activity.state, State.BLOCKED, 'the state is still written');
    h.t.applyRuntimeObservation('s-1', { alive: true });
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.sent[1][0], { type: 'needs_input', id: 's-1' });
    assert.equal('pingPending' in h.rec(), false, 'a sent ping clears the mark');
    h.t.applyRuntimeObservation('s-1', { alive: true });
    assert.equal(h.sent.length, 2, 'sent once, not every look');
  });
}

test('L135 F: a ping lost twice stays owed until one is sent; a sent first ping owes nothing', () => {
  const h = rig([false, false]);
  h.block();
  h.t.applyRuntimeObservation('s-1', { alive: true });
  assert.equal(h.rec().pingPending, true);
  h.t.applyRuntimeObservation('s-1', { alive: true });
  assert.equal(h.sent.length, 3);
  assert.equal('pingPending' in h.rec(), false);
  const ok = rig([undefined]);
  ok.block();
  ok.t.applyRuntimeObservation('s-1', { alive: true });
  assert.equal(ok.sent.length, 1, 'a notify that answers nothing counts as sent');
});

test('L135 F: a later signal inside the wait sends an owed ping; leaving the wait ends it unsent', () => {
  const h = rig([false]);
  h.t.applySignal('s-1', sig(State.WAITING_INPUT, 'notification'));
  assert.equal(h.rec().pingPending, true);
  h.t.applySignal('s-1', sig(State.BLOCKED, 'permission-request', 'Bash', ''));
  assert.equal(h.rec().activity.state, State.BLOCKED, 'setup: a written signal inside the wait');
  assert.equal(h.sent.length, 2, 'the escalation inside the wait carries the owed ping');
  assert.equal('pingPending' in h.rec(), false);
  const g = rig([false]);
  g.block();
  g.t.applySignal('s-1', sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(g.rec().activity.state, State.ACTIVE);
  assert.equal('pingPending' in g.rec(), false, 'no ping is owed for a wait that ended');
  g.t.applyRuntimeObservation('s-1', { alive: true });
  assert.equal(g.sent.length, 1);
});

test('L135 F: a dead session is not pinged again', () => {
  const h = rig([false]);
  h.block();
  h.t.applyRuntimeObservation('s-1', { alive: false });
  h.t.applyRuntimeObservation('s-1', { alive: true });
  assert.equal(h.sent.length, 1);
});

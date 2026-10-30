// Ported from Orchestrator.inc @1e478c5 lifecycle/toolflight_test.go (Apache-2.0), modified:
// see ../third_party/orchestrator-inc/NOTICE. Upstream has 24 test functions (31 cases with
// sub-cases). The 15 that apply to Claude Code are here under their upstream names (22 leaf
// cases), one of them inverted (review 0b-3 M1). Not ported, no adapter for that agent here:
//   Cursor: CursorMatchingAfterClearsBlocked, CursorUnrelatedAfterDoesNotClearBlocked,
//     CursorConcurrentDialogsRemainBlockedUntilAllComplete,
//     CursorTerminalFailureClearsOnlyMatchingPendingRequest, CursorSameKeyDialogsDecrementOneAtATime
//   Kimchi: LegacyKimchiFailurePostAlsoClears, ToolUseIDMatchBridgesCasingMismatch,
//     NotificationCorrelationFailurePostClearsBlocked, NotificationCorrelationSiblingDoesNotClear
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker, MemoryStore, State } from './activity.mjs';

const sig = (state, event, toolName = '', toolUseId = '') => ({ valid: true, state, event, toolName, toolUseId });

function setup(state = State.ACTIVE) {
  const store = new MemoryStore();
  const notes = [];
  const t = new ActivityTracker(store, { notify: (n) => notes.push(n) });
  store.set('s-1', { id: 's-1', activity: { state, at: 0 }, firstSignalAt: 1 });
  const apply = (s) => t.applySignal('s-1', s);
  const stateOf = () => store.get('s-1').activity.state;
  return { t, store, notes, apply, stateOf };
}

function blockOnDialog(h, toolName = 'Bash', toolUseId = 'toolu_1') {
  h.apply(sig(State.ACTIVE, 'pre-tool-use', toolName, toolUseId));
  h.apply(sig(State.BLOCKED, 'permission-request', toolName, ''));
  assert.equal(h.stateOf(), State.BLOCKED, 'setup');
}

test('ApprovedToolPostClearsBlocked', () => {
  const h = setup(); blockOnDialog(h);
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('ApprovedToolFailurePostAlsoClears', () => {
  const h = setup(); blockOnDialog(h);
  h.apply(sig(State.ACTIVE, 'post-tool-use-failure', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('SubagentTrafficDoesNotClearBlocked', () => {
  const h = setup(); blockOnDialog(h);
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Read', 'toolu_sub'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Read', 'toolu_sub'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('TurnBoundariesClearBlocked', async (t) => {
  const cases = [
    ['user-prompt-submit', sig(State.ACTIVE, 'user-prompt-submit'), State.ACTIVE],
    ['stop', sig(State.IDLE, 'stop'), State.IDLE],
    ['stop-failure', sig(State.IDLE, 'stop-failure'), State.IDLE],
    ['interrupt', sig(State.IDLE, 'interrupt'), State.IDLE],
    ['session-end', sig(State.EXITED, 'session-end'), State.EXITED],
    ['chat-controller-stopped', sig(State.EXITED, 'chat.controller.stopped'), State.EXITED],
  ];
  for (const [name, s, want] of cases) {
    await t.test(name, () => {
      const h = setup(); blockOnDialog(h);
      h.apply(s);
      assert.equal(h.stateOf(), want);
    });
  }
});

test('NotificationSubtypesDoNotClearBlocked', () => {
  const h = setup(); blockOnDialog(h);
  h.apply(sig(State.IDLE, 'notification'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.WAITING_INPUT, 'notification'));
  assert.equal(h.stateOf(), State.BLOCKED);
});

test('IdentitylessBlockedDuplicatePreservesCandidate', () => {
  const h = setup(); blockOnDialog(h);
  h.apply(sig(State.BLOCKED, 'notification'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('NoCandidatesFailsSafe', () => {
  const h = setup();
  h.apply(sig(State.BLOCKED, 'permission-request'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.IDLE, 'stop'));
  assert.equal(h.stateOf(), State.IDLE);
});

test('DefinitivePermissionResolutionClearsBlocked', async (t) => {
  for (const want of [State.ACTIVE, State.IDLE, State.WAITING_INPUT]) {
    await t.test(want, () => {
      const h = setup();
      h.apply(sig(State.BLOCKED, 'permission-blocked'));
      assert.ok(h.t.flights.has('s-1'), 'blocked modal created a tool flight');
      h.apply(sig(want, 'permission-resolved'));
      assert.equal(h.stateOf(), want);
      assert.ok(!h.t.flights.has('s-1'), 'flight released');
    });
  }
});

test('LegacySignalsKeepLastWriterWins (inverted: an untagged signal never lifts a pause)', () => {
  // Upstream lets an untagged signal clear blocked. Here that would let a stray signal unmask a
  // live permission dialog and sendSafe would type into it, so the expectation is reversed.
  const h = setup(); blockOnDialog(h);
  h.apply({ valid: true, state: State.ACTIVE });
  assert.equal(h.stateOf(), State.BLOCKED);
  const w = setup(State.WAITING_INPUT);
  w.apply({ valid: true, state: State.IDLE });
  assert.equal(w.stateOf(), State.WAITING_INPUT);
  const a = setup(State.ACTIVE); // out of a pause, untagged signals still pass
  a.apply({ valid: true, state: State.IDLE });
  assert.equal(a.stateOf(), State.IDLE);
});

test('ToolEventsDoNotDemoteWaitingInput', () => {
  const h = setup(State.WAITING_INPUT);
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Read', 'toolu_bg'));
  assert.equal(h.stateOf(), State.WAITING_INPUT);
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Read', 'toolu_bg'));
  assert.equal(h.stateOf(), State.WAITING_INPUT);
  h.apply(sig(State.ACTIVE, 'user-prompt-submit'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('AmbiguousSameNameBlockFailsClosed', () => {
  const h = setup();
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_1'));
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_2'));
  h.apply(sig(State.BLOCKED, 'permission-request', 'Bash'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_2'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.IDLE, 'stop'));
  assert.equal(h.stateOf(), State.IDLE);
});

test('SequentialDialogsResetAmbiguity', () => {
  const h = setup();
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_1'));
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_2'));
  h.apply(sig(State.BLOCKED, 'permission-request', 'Bash'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_2'));
  assert.equal(h.stateOf(), State.BLOCKED);
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_3'));
  h.apply(sig(State.BLOCKED, 'permission-request', 'Bash'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_3'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('UniqueSameNameToolClears', () => {
  const h = setup();
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_1'));
  h.apply(sig(State.BLOCKED, 'permission-request', 'Bash'));
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Bash', 'toolu_1'));
  assert.equal(h.stateOf(), State.ACTIVE);
});

test('ReaperTerminationReleasesFlight', () => {
  const h = setup();
  h.apply(sig(State.ACTIVE, 'pre-tool-use', 'Bash', 'toolu_1'));
  assert.ok(h.t.flights.has('s-1'), 'setup: flight tracked');
  h.t.applyRuntimeObservation('s-1', { alive: false });
  assert.equal(h.store.get('s-1').terminated, true);
  assert.ok(!h.t.flights.has('s-1'), 'flight released');
});

test('SuppressedSignalEmitsNoNotification', () => {
  const h = setup(); blockOnDialog(h);
  const entered = h.notes.length;
  assert.equal(entered, 1, 'blocked entry pinged once');
  h.apply(sig(State.ACTIVE, 'post-tool-use', 'Read', 'toolu_sub'));
  assert.equal(h.notes.length, entered);
});


// Guard tests. The first group follows Orchestrator.inc @1e478c5 sessionguard/guard_test.go
// (Apache-2.0), modified: see ../third_party/orchestrator-inc/NOTICE. The rest are ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard, Outcome, sendSafe, tmuxMessenger } from './guard.mjs';
import { ActivityTracker, MemoryStore, State } from './activity.mjs';
import { signalFromHook, deriveActivityState } from './claude-signals.mjs';

function rig(rec, { lease, startupGate } = {}) {
  const sent = [];
  const sessions = new Map(rec ? [[rec.id, rec]] : []);
  const store = { getSession: async (id) => sessions.get(id) ?? null };
  const messenger = { send: async (id, text) => { sent.push({ id, text }); } };
  return { sent, sessions, guard: new Guard({ store, messenger, lease, startupGate }) };
}
const live = (state, extra = {}) => ({ id: 's-1', activity: { state }, firstSignalAt: 1, ...extra });

test('OutcomeByState', async () => {
  const cases = [
    // [state, deliver, nudge, nudgeCoordination]
    [State.IDLE, Outcome.SENT, Outcome.SENT, Outcome.SENT],
    [State.ACTIVE, Outcome.SENT, Outcome.SENT, Outcome.SUPPRESSED_BUSY],
    [State.WAITING_INPUT, Outcome.SENT, Outcome.SUPPRESSED_AWAITING_USER, Outcome.SUPPRESSED_AWAITING_USER],
    [State.BLOCKED, Outcome.SUPPRESSED_AWAITING_USER, Outcome.SUPPRESSED_AWAITING_USER, Outcome.SUPPRESSED_AWAITING_USER],
    [State.EXITED, Outcome.SUPPRESSED_EXITED, Outcome.SUPPRESSED_EXITED, Outcome.SUPPRESSED_EXITED],
  ];
  for (const [state, d, n, c] of cases) {
    const r = rig(live(state));
    assert.equal((await r.guard.deliver('s-1', 'x')).outcome, d, `deliver ${state}`);
    assert.equal((await r.guard.nudge('s-1', 'x')).outcome, n, `nudge ${state}`);
    assert.equal((await r.guard.nudgeCoordination('s-1', 'x')).outcome, c, `coordination ${state}`);
  }
  assert.equal((await rig(null).guard.nudge('s-1', 'x')).outcome, Outcome.SUPPRESSED_NOT_FOUND);
  assert.equal((await rig(live(State.IDLE, { terminated: true })).guard.nudge('s-1', 'x')).outcome, Outcome.SUPPRESSED_TERMINATED);
});

test('UnknownStateFailsClosed', async () => {
  const r = rig(live('dialog_maybe'));
  assert.equal((await r.guard.deliver('s-1', 'x')).outcome, Outcome.SUPPRESSED_UNKNOWN);
  assert.equal(r.sent.length, 0);
});

test('StoreErrorFailsClosed', async () => {
  const sent = [];
  const guard = new Guard({ store: { getSession: async () => { throw new Error('disk'); } }, messenger: { send: async (i, t) => sent.push(t) } });
  const res = await guard.deliver('s-1', 'x');
  assert.equal(res.outcome, Outcome.SUPPRESSED_UNKNOWN);
  assert.ok(res.error);
  assert.equal(sent.length, 0);
});

test('CancelledContextNeverWrites', async () => {
  const r = rig(live(State.IDLE));
  const ac = new AbortController(); ac.abort();
  const res = await r.guard.deliver('s-1', 'x', { signal: ac.signal });
  assert.equal(res.outcome, Outcome.SUPPRESSED_UNKNOWN);
  assert.equal(r.sent.length, 0);
});

test('MessengerErrorIsSentPlusError', async () => {
  const guard = new Guard({ store: { getSession: async () => live(State.IDLE) }, messenger: { send: async () => { throw new Error('pane gone'); } } });
  const res = await guard.deliver('s-1', 'x');
  assert.equal(res.outcome, Outcome.SENT);
  assert.ok(res.error);
});

test('NudgeUrgentReachesNeedsInputButNotBlocked', async () => {
  let r = rig(live(State.WAITING_INPUT));
  assert.equal((await r.guard.nudgeUrgent('s-1', 'x', { acceptsWaitingInput: () => true })).outcome, Outcome.SENT);
  r = rig(live(State.WAITING_INPUT));
  assert.equal((await r.guard.nudgeUrgent('s-1', 'x')).outcome, Outcome.SUPPRESSED_AWAITING_USER, 'missing capability means no');
  r = rig(live(State.BLOCKED));
  assert.equal((await r.guard.nudgeUrgent('s-1', 'x', { acceptsWaitingInput: () => true })).outcome, Outcome.SUPPRESSED_AWAITING_USER);
});

test('StartupPendingBlocksEveryWrite', async () => {
  // Ours: gated by default. A session that has sent no hook may sit on a startup dialog.
  const r = rig(live(State.IDLE, { firstSignalAt: undefined }));
  for (const m of ['deliver', 'nudge', 'nudgeUrgent', 'nudgeCoordination']) {
    assert.equal((await r.guard[m]('s-1', 'x')).outcome, Outcome.SUPPRESSED_STARTUP_PENDING, m);
  }
  const ungated = rig(live(State.IDLE, { firstSignalAt: undefined }), { startupGate: () => false });
  assert.equal((await ungated.guard.deliver('s-1', 'x')).outcome, Outcome.SENT);
  assert.equal(r.sent.length, 0);
});

test('InputLeaseCoversActualPaneWrite', async () => {
  const events = [];
  const lease = { acquire: () => { events.push('acquire'); return () => events.push('release'); } };
  const guard = new Guard({ store: { getSession: async () => { events.push('read'); return live(State.IDLE); } },
    messenger: { send: async () => { events.push('write'); } }, lease });
  await guard.deliver('s-1', 'x');
  assert.deepEqual(events, ['acquire', 'read', 'write', 'release']);
});

test('ClosedInputGateSuppressesBeforePaneWrite', async () => {
  const r = rig(live(State.IDLE), { lease: { acquire: () => null } });
  assert.equal((await r.guard.deliver('s-1', 'x')).outcome, Outcome.SUPPRESSED_INPUT_GATED);
  assert.equal(r.sent.length, 0);
});

test('NudgeCoordinationEnforcesSteeringAtWriteBoundary', async () => {
  // The state is re-read at the write, not taken from the caller's earlier look.
  const r = rig(live(State.IDLE));
  r.sessions.set('s-1', live(State.ACTIVE)); // changed after the caller looked
  assert.equal((await r.guard.nudgeCoordination('s-1', 'x')).outcome, Outcome.SUPPRESSED_BUSY);
  assert.equal((await r.guard.nudgeCoordination('s-1', 'x', { steersActiveTurn: () => true })).outcome, Outcome.SENT);
});

// --- ours -------------------------------------------------------------------------------

test('golden task: a dialog is open, a helper finishes a step, the Dispatcher fires — nothing is typed', async () => {
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('w-1', { id: 'w-1', activity: { state: State.IDLE, at: 0 } });
  const hook = (event, payload) => { const s = signalFromHook(event, payload); if (s) tracker.applySignal('w-1', s); };

  hook('user-prompt-submit', { prompt: 'build card C-1' });
  hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_main' });
  hook('permission-request', { tool_name: 'Bash' });            // the dialog is on screen
  hook('notification', { notification_type: 'permission_prompt' });
  hook('pre-tool-use', { tool_name: 'Read', tool_use_id: 'toolu_helper' }); // a helper works on
  hook('post-tool-use', { tool_name: 'Read', tool_use_id: 'toolu_helper' });
  hook('notification', { notification_type: 'agent_completed' });          // the helper finishes
  assert.equal(store.get('w-1').activity.state, State.BLOCKED);

  const sent = [];
  const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async (i, t) => sent.push(t) } });
  const res = await sendSafe(guard, 'w-1', 'continue with the next step');
  assert.equal(res.outcome, Outcome.SUPPRESSED_AWAITING_USER);
  assert.deepEqual(sent, [], 'nothing is typed');

  // The planted fault: the same events through a tracker with the tool-flight rule removed
  // (plain last-writer-wins) leave the session idle, and the same sendSafe call types.
  class NoRule extends ActivityTracker { applyToolPrecedence(id, cur, s) { return s; } }
  const nstore = new MemoryStore();
  const naive = new NoRule(nstore);
  nstore.set('w-1', { id: 'w-1', activity: { state: State.IDLE, at: 0 } });
  for (const [e, p] of [['user-prompt-submit', { prompt: 'build card C-1' }], ['pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_main' }],
    ['permission-request', { tool_name: 'Bash' }], ['pre-tool-use', { tool_name: 'Read', tool_use_id: 'toolu_helper' }],
    ['post-tool-use', { tool_name: 'Read', tool_use_id: 'toolu_helper' }], ['notification', { notification_type: 'agent_completed' }]]) {
    naive.applySignal('w-1', signalFromHook(e, p));
  }
  const nsent = [];
  const nguard = new Guard({ store: { getSession: (id) => nstore.get(id) }, messenger: { send: async (i, t) => nsent.push(t) } });
  await sendSafe(nguard, 'w-1', 'continue with the next step');
  assert.equal(nsent.length, 1, 'without the rule the dialog would have been answered');
});

test('a [watchdog] line never lifts a pause (counting approvals is M2\'s check)', async () => {
  for (const start of [State.BLOCKED, State.WAITING_INPUT]) {
    const store = new MemoryStore();
    const tracker = new ActivityTracker(store);
    store.set('w-1', { id: 'w-1', activity: { state: start, at: 0 }, firstSignalAt: 1 });
    tracker.applySignal('w-1', signalFromHook('user-prompt-submit', { prompt: '[watchdog] you have a new message' }));
    assert.equal(store.get('w-1').activity.state, start, `${start} stays`);
    tracker.applySignal('w-1', signalFromHook('user-prompt-submit', { prompt: 'yes' })); // the person answers
    assert.equal(store.get('w-1').activity.state, State.ACTIVE);
  }
});

test('sendSafe: every line it writes starts with "[watchdog] "', async () => {
  const r = rig(live(State.IDLE));
  for (const t of ['check your outbox', '[watchdog] already prefixed', '  [WATCHDOG]x', '', '   lead space', 42]) await sendSafe(r.guard, 's-1', t);
  assert.equal(r.sent.length, 6);
  for (const { text } of r.sent) assert.ok(text.startsWith('[watchdog] '), text);
  assert.deepEqual(r.sent.map((s) => s.text).slice(0, 3), ['[watchdog] check your outbox', '[watchdog] already prefixed', '[watchdog] x']);
});

test('sendSafe refuses every state but idle (review 0b-3 M3)', async () => {
  const want = { [State.ACTIVE]: Outcome.SUPPRESSED_BUSY, [State.WAITING_INPUT]: Outcome.SUPPRESSED_AWAITING_USER,
    [State.BLOCKED]: Outcome.SUPPRESSED_AWAITING_USER, [State.EXITED]: Outcome.SUPPRESSED_EXITED, mystery: Outcome.SUPPRESSED_UNKNOWN };
  for (const [state, outcome] of Object.entries(want)) {
    const r = rig(live(state));
    assert.equal((await sendSafe(r.guard, 's-1', 'x')).outcome, outcome, state);
    assert.equal(r.sent.length, 0);
  }
  assert.equal((await sendSafe(rig(live(State.IDLE, { firstSignalAt: undefined })).guard, 's-1', 'x')).outcome, Outcome.SUPPRESSED_STARTUP_PENDING);
});

test('an open AskUserQuestion is waiting on the person until it is answered', async () => {
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
  const hook = (e, p) => tracker.applySignal('L', signalFromHook(e, p));
  hook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
  assert.equal(store.get('L').activity.state, State.WAITING_INPUT);
  hook('pre-tool-use', { tool_name: 'Read', tool_use_id: 'r1' });
  hook('post-tool-use', { tool_name: 'Read', tool_use_id: 'r1' });
  assert.equal(store.get('L').activity.state, State.WAITING_INPUT, 'other tool traffic does not end the wait');
  const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async () => assert.fail('typed') } });
  assert.equal((await sendSafe(guard, 'L', 'WRAP')).outcome, Outcome.SUPPRESSED_AWAITING_USER);
  hook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
  assert.equal(store.get('L').activity.state, State.ACTIVE);
});

test('Claude hook mapping', () => {
  assert.equal(deriveActivityState('permission-request'), State.BLOCKED);
  assert.equal(deriveActivityState('notification', { notification_type: 'agent_needs_input' }), State.WAITING_INPUT);
  assert.equal(deriveActivityState('notification', { notification_type: 'idle_prompt' }), State.IDLE);
  assert.equal(deriveActivityState('notification', { notification_type: 'auth_success' }), null);
  assert.equal(deriveActivityState('notification', null), null);
  assert.equal(deriveActivityState('session-end', { reason: 'clear' }), null);
  assert.equal(deriveActivityState('session-end', { reason: 'logout' }), State.EXITED);
  assert.equal(deriveActivityState('session-end', {}), State.EXITED);
  assert.equal(deriveActivityState('session-start'), null);
});

test('tmux messenger: argument arrays, literal text, refuses control characters and odd targets', async () => {
  const calls = [];
  const m = tmuxMessenger({ run: async (cmd, args) => calls.push([cmd, ...args]), targetFor: (id) => (id === 'bad' ? 'x;rm' : `orch:${id}`) });
  await m.send('w-1', '[watchdog] hi $(whoami)');
  assert.deepEqual(calls, [['tmux', 'send-keys', '-t', 'orch:w-1', '-l', '--', '[watchdog] hi $(whoami)'], ['tmux', 'send-keys', '-t', 'orch:w-1', 'Enter']]);
  await assert.rejects(m.send('w-1', 'line one\nline two'));
  await assert.rejects(m.send('bad', 'x'));
  assert.equal(calls.length, 2);
});

// Guard tests. The first group follows Orchestrator.inc @1e478c5 sessionguard/guard_test.go
// (Apache-2.0), modified: see ../third_party/orchestrator-inc/NOTICE. The rest are ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard, Outcome, sendSafe, tmuxMessenger, personGuard } from './guard.mjs';
import { ActivityTracker, MemoryStore, State } from './activity.mjs';
import { signalFromHook, deriveActivityState } from './claude-signals.mjs';

function rig(rec, { lease, startupGate } = {}) {
  const sent = [];
  const sessions = new Map(rec ? [[rec.id, rec]] : []);
  const store = { getSession: async (id) => sessions.get(id) ?? null };
  const messenger = { send: async (id, text) => { sent.push({ id, text }); } };
  // personGuard: these upstream cases exercise deliver(), the person's own typing.
  return { sent, sessions, guard: personGuard({ store, messenger, lease, startupGate }) };
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
  const guard = personGuard({ store: { getSession: async () => { throw new Error('disk'); } }, messenger: { send: async (i, t) => sent.push(t) } });
  const res = await guard.deliver('s-1', 'x');
  assert.equal(res.outcome, Outcome.SUPPRESSED_UNKNOWN);
  assert.ok(res.error);
  assert.equal(sent.length, 0);
});

test('CancelledContextNeverWrites', async () => {
  // Cancelled mid-flight, after the read began (audit m6), as upstream does.
  const sent = [];
  const ac = new AbortController();
  const guard = personGuard({ store: { getSession: async () => { ac.abort(); return live(State.IDLE); } }, messenger: { send: async (i, t) => sent.push(t) } });
  const res = await guard.deliver('s-1', 'x', { signal: ac.signal });
  assert.equal(res.outcome, Outcome.SUPPRESSED_UNKNOWN);
  assert.equal(sent.length, 0);
});

test('MessengerErrorIsSentPlusError', async () => {
  const guard = personGuard({ store: { getSession: async () => live(State.IDLE) }, messenger: { send: async () => { throw new Error('pane gone'); } } });
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
  // As upstream: a messenger that blocks until we let it finish. The lease must still be held
  // while the write is in progress (audit MAT-6: a non-blocking fake could not tell).
  const events = [];
  let finish; const writing = new Promise((r) => { finish = r; });
  let entered; const inWrite = new Promise((r) => { entered = r; });
  const lease = { acquire: () => { events.push('acquire'); return () => events.push('release'); } };
  const guard = personGuard({ store: { getSession: async () => { events.push('read'); return live(State.IDLE); } },
    messenger: { send: async () => { events.push('write-start'); entered(); await writing; events.push('write-end'); } }, lease });
  const done = guard.deliver('s-1', 'x');
  await inWrite;
  await new Promise((r) => setImmediate(r));
  assert.equal(events.includes('release'), false, 'lease released while the write was in progress');
  finish();
  await done;
  assert.deepEqual(events, ['acquire', 'read', 'write-start', 'write-end', 'release']);
});

test('async lease: a refusing, throwing or odd lease is a closed gate; a granting one works (audit MAT-4)', async () => {
  for (const acquire of [async () => null, async () => { throw new Error('x'); }, () => 'yes', async () => ({})]) {
    const r = rig(live(State.IDLE), { lease: { acquire } });
    assert.equal((await r.guard.deliver('s-1', 'x')).outcome, Outcome.SUPPRESSED_INPUT_GATED);
    assert.equal(r.sent.length, 0);
  }
  let released = 0;
  const ok = rig(live(State.IDLE), { lease: { acquire: async () => async () => { released += 1; } } });
  assert.equal((await ok.guard.deliver('s-1', 'x')).outcome, Outcome.SENT);
  assert.equal(released, 1);
  const badRelease = rig(live(State.IDLE), { lease: { acquire: () => () => { throw new Error('release broke'); } } });
  assert.equal((await badRelease.guard.deliver('s-1', 'x')).outcome, Outcome.SENT, 'a release error never hides the write');
});

test('every write path of an automated guard carries the prefix; deliver needs personGuard (audit MAT-3)', async () => {
  const sent = [];
  const store = { getSession: async () => live(State.IDLE) };
  const g = new Guard({ store, messenger: { send: async (i, t) => sent.push(t) } });
  const writers = Object.getOwnPropertyNames(Guard.prototype).filter((n) => n !== 'constructor' && n !== 'awaitingStartup');
  assert.deepEqual(writers.sort(), ['deliver', 'nudge', 'nudgeCoordination', 'nudgeUrgent']);
  assert.equal((await g.deliver('s-1', 'go ahead')).outcome, Outcome.SUPPRESSED_NOT_PERSON);
  for (const m of ['nudge', 'nudgeUrgent', 'nudgeCoordination']) await g[m]('s-1', 'go ahead');
  await sendSafe(g, 's-1', 'go ahead');
  assert.equal(sent.length, 4);
  for (const t of sent) assert.equal(t, '[watchdog] go ahead');
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
  // No capability can be passed through sendSafe (audit m5).
  const act = rig(live(State.ACTIVE));
  assert.equal((await sendSafe(act.guard, 's-1', 'x', { steersActiveTurn: () => true })).outcome, Outcome.SUPPRESSED_BUSY);
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

// Audit 0b-3 R29 MAT-1: nothing but the answer, a real prompt or the end lifts an open question.
test('an open question survives idle notifications, stops, helper finishes and unknown tags', async () => {
  const lifts = [
    ['notification', { notification_type: 'idle_prompt' }],
    ['notification', { notification_type: 'agent_completed' }],
    ['stop', {}],
    ['stop-failure', {}],
    ['post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'other' }],
    ['user-prompt-submit', { prompt: '[watchdog] WRAP' }],
  ];
  for (const [e, p] of lifts) {
    const store = new MemoryStore();
    const tracker = new ActivityTracker(store);
    store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
    tracker.applySignal('L', signalFromHook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }));
    tracker.applySignal('L', signalFromHook(e, p));
    tracker.applySignal('L', { valid: true, state: State.IDLE }); // untagged stray
    assert.equal(store.get('L').activity.state, State.WAITING_INPUT, `${e} lifted the question`);
    const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async () => assert.fail(`typed after ${e}`) } });
    assert.equal((await sendSafe(guard, 'L', 'WRAP')).outcome, Outcome.SUPPRESSED_AWAITING_USER);
    assert.equal((await guard.nudgeUrgent('L', 'WRAP', { acceptsWaitingInput: () => true })).outcome, Outcome.SUPPRESSED_AWAITING_USER, 'audit m4');
  }
  // A real prompt from the person does end it.
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
  tracker.applySignal('L', signalFromHook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }));
  tracker.applySignal('L', signalFromHook('user-prompt-submit', { prompt: 'never mind' }));
  assert.equal(store.get('L').activity.state, State.ACTIVE);
});

test('a question opened while another dialog shows stays open after that dialog ends', async () => {
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
  const hook = (e, p) => tracker.applySignal('L', signalFromHook(e, p));
  hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'b1' });
  hook('permission-request', { tool_name: 'Bash' });
  hook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
  assert.equal(store.get('L').activity.state, State.BLOCKED);
  hook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'b1' });
  assert.equal(store.get('L').activity.state, State.WAITING_INPUT);
  hook('notification', { notification_type: 'idle_prompt' });
  assert.equal(store.get('L').activity.state, State.WAITING_INPUT);
  const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async () => assert.fail('typed') } });
  assert.equal((await sendSafe(guard, 'L', 'WRAP')).outcome, Outcome.SUPPRESSED_AWAITING_USER);
  hook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' });
  assert.equal(store.get('L').activity.state, State.ACTIVE);
});

// Audit 0b-3 R29 MAT-2.
test('late hooks never bring an exited session back; a real prompt does', () => {
  for (const [e, p] of [['stop', {}], ['notification', { notification_type: 'idle_prompt' }], ['pre-tool-use', { tool_name: 'Read', tool_use_id: 'r' }], ['user-prompt-submit', { prompt: '[watchdog] x' }], [null]]) {
    const store = new MemoryStore();
    const tracker = new ActivityTracker(store);
    store.set('S', { id: 'S', activity: { state: State.IDLE, at: 0 }, firstSignalAt: 1 });
    tracker.applySignal('S', signalFromHook('session-end', { reason: 'logout' }));
    assert.equal(store.get('S').activity.state, State.EXITED);
    tracker.applySignal('S', e ? signalFromHook(e, p) : { valid: true, state: State.IDLE });
    assert.equal(store.get('S').activity.state, State.EXITED, `${e} revived it`);
  }
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('S', { id: 'S', activity: { state: State.EXITED, at: 0 }, firstSignalAt: 1 });
  tracker.applySignal('S', signalFromHook('user-prompt-submit', { prompt: 'hello' }));
  assert.equal(store.get('S').activity.state, State.ACTIVE);
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
  // Text and Enter in one tmux call (audit m1).
  assert.deepEqual(calls, [['tmux', 'send-keys', '-t', 'orch:w-1', '-l', '--', '[watchdog] hi $(whoami)', ';', 'send-keys', '-t', 'orch:w-1', 'Enter']]);
  await assert.rejects(m.send('w-1', 'line one\nline two'));
  await assert.rejects(m.send('bad', 'x'));
  await assert.rejects(m.send('w-1', '[watchdog] ends;'), /ends in/);
  await assert.rejects(m.send('w-1', ';'), /ends in/);
  assert.equal(calls.length, 1);
});

test('two open questions: answering one leaves the session waiting on the other (audit round 2 MAT-1)', async () => {
  const cases = [
    ['q1', 'q2', 'q1'], // the first one answered first
    ['q1', 'q2', 'q2'],
    ['', 'q2', ''], // a question with no id is ended only by an answer with no id
    ['q1', '', 'q1'],
  ];
  for (const [a, b, answered] of cases) {
    const store = new MemoryStore();
    const tracker = new ActivityTracker(store);
    store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
    tracker.applySignal('L', signalFromHook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: a }));
    tracker.applySignal('L', signalFromHook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: b }));
    tracker.applySignal('L', signalFromHook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: answered }));
    tracker.applySignal('L', signalFromHook('notification', { notification_type: 'idle_prompt' }));
    assert.equal(store.get('L').activity.state, State.WAITING_INPUT, `${a}/${b} answered ${answered}`);
    const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async () => assert.fail('typed into an open question') } });
    assert.equal((await sendSafe(guard, 'L', 'WRAP')).outcome, Outcome.SUPPRESSED_AWAITING_USER);
    assert.equal((await guard.nudgeUrgent('L', 'WRAP', { acceptsWaitingInput: () => true })).outcome, Outcome.SUPPRESSED_AWAITING_USER);
  }
  // An answer with no id does not end a question that has one.
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('L', { id: 'L', activity: { state: State.ACTIVE, at: 0 }, firstSignalAt: 1 });
  tracker.applySignal('L', signalFromHook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }));
  tracker.applySignal('L', signalFromHook('post-tool-use', { tool_name: 'AskUserQuestion' }));
  assert.equal(store.get('L').activity.state, State.WAITING_INPUT);
  // Both answered: the session moves on.
  tracker.applySignal('L', signalFromHook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }));
  assert.notEqual(store.get('L').activity.state, State.WAITING_INPUT);
});

test('a line the tmux sender refuses is reported as refused, not sent (audit round 2)', async () => {
  const calls = [];
  const messenger = tmuxMessenger({ run: async (cmd, args) => calls.push([cmd, ...args]), targetFor: (id) => (id === 'bad' ? 'x;rm' : `orch:${id}`) });
  const sessions = new Map([['w-1', live(State.IDLE, { id: 'w-1' })], ['bad', live(State.IDLE, { id: 'bad' })]]);
  const guard = new Guard({ store: { getSession: async (id) => sessions.get(id) ?? null }, messenger });
  assert.equal((await sendSafe(guard, 'w-1', 'two\nlines')).outcome, Outcome.REFUSED_BY_SENDER);
  assert.equal((await sendSafe(guard, 'w-1', 'WRAP;')).outcome, Outcome.REFUSED_BY_SENDER);
  assert.equal((await sendSafe(guard, 'bad', 'WRAP')).outcome, Outcome.REFUSED_BY_SENDER);
  assert.equal(calls.length, 0);
  assert.equal((await sendSafe(guard, 'w-1', 'WRAP')).outcome, Outcome.SENT);
  // A failure while typing is still "sent": part of the line may be on screen.
  const failing = new Guard({ store: { getSession: async (id) => sessions.get(id) ?? null }, messenger: { send: async () => { throw new Error('pane gone'); } } });
  assert.equal((await sendSafe(failing, 'w-1', 'WRAP')).outcome, Outcome.SENT);
});

test('a late hook from a stopped launch never moves the restarted session (audit m3)', async () => {
  const store = new MemoryStore();
  const tracker = new ActivityTracker(store);
  store.set('L', { id: 'L', activity: { state: State.IDLE, at: 0 }, firstSignalAt: 1 });
  assert.equal(tracker.beginLaunch('L', 'launch-2'), true);
  assert.equal(store.get('L').firstSignalAt, null);
  // The old process's stop and idle notice: dropped, so the startup gate stays shut.
  tracker.applySignal('L', signalFromHook('stop', {}, 5, 'launch-1'));
  tracker.applySignal('L', signalFromHook('notification', { notification_type: 'idle_prompt' }, 6, 'launch-1'));
  tracker.applySignal('L', signalFromHook('stop', {}, 7)); // names no launch
  assert.equal(store.get('L').firstSignalAt, null);
  const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async () => assert.fail('typed into a starting session') } });
  assert.equal((await sendSafe(guard, 'L', 'WRAP')).outcome, Outcome.SUPPRESSED_STARTUP_PENDING);
  // The new launch's own hook counts.
  tracker.applySignal('L', signalFromHook('stop', {}, 8, 'launch-2'));
  assert.equal(store.get('L').firstSignalAt, 8);
  assert.equal(store.get('L').activity.state, State.IDLE);
});

// ---- audit rounds 2 and 3: one test per safety line that a planted bug could break ----

function trackRig(start = State.ACTIVE) {
  const store = new MemoryStore();
  let t = new ActivityTracker(store);
  store.set('S', { id: 'S', activity: { state: start, at: 0 }, firstSignalAt: 1 });
  const hook = (e, p = {}) => { const s = signalFromHook(e, p); if (s) t.applySignal('S', s); };
  const sent = [];
  const guard = new Guard({ store: { getSession: (id) => store.get(id) }, messenger: { send: async (i, x) => sent.push(x) } });
  return { store, hook, raw: (s) => t.applySignal('S', s), restart: () => { t = new ActivityTracker(store); }, tracker: () => t, sent, guard };
}
async function nothingTyped(r, what) {
  assert.notEqual((await sendSafe(r.guard, 'S', 'WRAP')).outcome, Outcome.SENT, `${what}: sendSafe typed`);
  assert.notEqual((await r.guard.nudgeUrgent('S', 'WRAP', { acceptsWaitingInput: () => true })).outcome, Outcome.SENT, `${what}: urgent nudge typed`);
  assert.equal(r.sent.length, 0, what);
}
const askQ = (r, id = 'q1') => r.hook('pre-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: id });
const ansQ = (r, id = 'q1') => r.hook('post-tool-use', { tool_name: 'AskUserQuestion', tool_use_id: id });
const idleNote = (r) => r.hook('notification', { notification_type: 'idle_prompt' });
const blockOn = (r, id = 'b1') => { r.hook('pre-tool-use', { tool_name: 'Bash', tool_use_id: id }); r.hook('permission-request', { tool_name: 'Bash' }); };

test('a question answered while a dialog is still open leaves the session blocked (A3)', async () => {
  const r = trackRig(); blockOn(r); askQ(r); ansQ(r); idleNote(r);
  assert.equal(r.store.get('S').activity.state, State.BLOCKED);
  await nothingTyped(r, 'A3');
});

test('a helper tool finishing does not turn a dialog into a question wait (A6)', async () => {
  const r = trackRig(); blockOn(r); askQ(r);
  r.hook('pre-tool-use', { tool_name: 'Read', tool_use_id: 'h1' }); r.hook('post-tool-use', { tool_name: 'Read', tool_use_id: 'h1' });
  ansQ(r); idleNote(r);
  assert.equal(r.store.get('S').activity.state, State.BLOCKED);
  await nothingTyped(r, 'A6');
});

test('after the blocking tool posts, the open question still refuses an urgent nudge (A8)', async () => {
  const r = trackRig(); blockOn(r); askQ(r);
  r.hook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'b1' });
  assert.deepEqual(r.store.get('S').activity.state, State.WAITING_INPUT);
  assert.equal(r.store.get('S').activity.reason, 'question');
  await nothingTyped(r, 'A8');
});

test('a question opened during another wait keeps its reason (A11)', async () => {
  const r = trackRig(); r.hook('notification', { notification_type: 'agent_needs_input' }); askQ(r); r.hook('stop');
  assert.equal(r.store.get('S').activity.reason, 'question');
  await nothingTyped(r, 'A11');
});

test('after the in-flight cap resets, the old blocking tool is not named (D3)', async () => {
  const { MAX_INFLIGHT_TOOLS } = await import('./activity.mjs');
  const r = trackRig(); blockOn(r, 'A');
  for (let i = 0; i < MAX_INFLIGHT_TOOLS + 1; i += 1) r.hook('pre-tool-use', { tool_name: 'Read', tool_use_id: `r${i}` });
  r.hook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'A' });
  r.hook('notification', { notification_type: 'agent_completed' });
  assert.equal(r.store.get('S').activity.state, State.BLOCKED);
  await nothingTyped(r, 'D3');
});

test('an unknown event tag never lifts a block; an exit drops every in-flight record (B3, E3)', async () => {
  const r = trackRig(); blockOn(r);
  r.raw({ valid: true, state: State.ACTIVE, event: 'mystery' });
  assert.equal(r.store.get('S').activity.state, State.BLOCKED);
  await nothingTyped(r, 'B3');
  r.hook('session-end', { reason: 'logout' });
  assert.equal(r.store.get('S').activity.state, State.EXITED);
  assert.equal(r.tracker().flights.has('S'), false);
});

test('a restarted tracker still knows every open question (audit round 3 MAT-1)', async () => {
  // Two boxes, restart, one answered, idle notice: the other box is still open.
  const two = trackRig(); askQ(two, 'q1'); askQ(two, 'q2'); two.restart(); ansQ(two, 'q1'); idleNote(two);
  assert.equal(two.store.get('S').activity.state, State.WAITING_INPUT);
  await nothingTyped(two, 'two boxes');
  // One box, restart, a stop: still open.
  const one = trackRig(); askQ(one); one.restart(); one.hook('stop'); idleNote(one);
  assert.equal(one.store.get('S').activity.state, State.WAITING_INPUT);
  await nothingTyped(one, 'one box');
  // A record that says "question" but has no list (written before the list existed): only a
  // real prompt clears it, never an answer we cannot match, a stop or an idle notice.
  const old = trackRig();
  old.store.set('S', { id: 'S', activity: { state: State.WAITING_INPUT, at: 0, reason: 'question' }, firstSignalAt: 1 });
  ansQ(old, 'q9'); old.hook('stop'); idleNote(old);
  assert.equal(old.store.get('S').activity.state, State.WAITING_INPUT);
  await nothingTyped(old, 'no list');
  old.hook('user-prompt-submit', { prompt: 'here is my answer' });
  assert.equal(old.store.get('S').activity.state, State.ACTIVE);
  // Answering all of them after a restart moves on.
  const done = trackRig(); askQ(done, 'q1'); askQ(done, 'q2'); done.restart(); ansQ(done, 'q1'); ansQ(done, 'q2');
  assert.notEqual(done.store.get('S').activity.state, State.WAITING_INPUT);
});

test('audit round 4: a restart while blocked with a question open never crashes the tracker (m1)', async () => {
  const r = trackRig(); blockOn(r); askQ(r); r.restart();
  assert.doesNotThrow(() => r.hook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'b1' }));
  idleNote(r);
  assert.notEqual(r.store.get('S').activity.state, State.IDLE);
  await nothingTyped(r, 'restart while blocked');
});

test('audit round 4: the unnamed-question stand-in survives a dialog opening on top of it (m2)', async () => {
  const r = trackRig();
  r.store.set('S', { id: 'S', activity: { state: State.WAITING_INPUT, at: 0, reason: 'question' }, firstSignalAt: 1 });
  blockOn(r); r.hook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'b1' }); r.hook('stop'); idleNote(r);
  assert.deepEqual(r.store.get('S').openAsks, ['?']);
  await nothingTyped(r, 'stand-in under a dialog');
});

test('audit round 4: lines no test protected (m3)', async () => {
  // An idle notice never ends a "needs input" wait.
  const w = trackRig(State.WAITING_INPUT); idleNote(w);
  assert.equal(w.store.get('S').activity.state, State.WAITING_INPUT);
  assert.notEqual((await sendSafe(w.guard, 'S', 'WRAP')).outcome, Outcome.SENT, 'idle ends a wait');
  // A real prompt clears the open-question list, so the session can move on afterwards.
  const p = trackRig(); askQ(p); p.hook('user-prompt-submit', { prompt: 'answer' });
  assert.deepEqual(p.store.get('S').openAsks, []);
  p.hook('stop');
  assert.notEqual(p.store.get('S').activity.state, State.WAITING_INPUT);
  // A new launch clears the list.
  const l = trackRig(); askQ(l); l.tracker().beginLaunch('S', 'L2');
  assert.deepEqual(l.store.get('S').openAsks, []);
  l.hook('stop', {});
});

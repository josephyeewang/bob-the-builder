// Runner step 3: one pass of the worker runner, on fake ports, read back through the Dispatcher's own readers
// (owner-status.mjs and owner-asks.mjs), so what the runner writes is what the Dispatcher trusts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_SKEW_MS, RUNNER_KEEP_USED_UP_MS, RUNNER_STATUS_EVERY_MS, ownerSyncPorts, readOwnerStatus } from './owner-status.mjs';
import { ownerAsyncPorts } from './owner-asks.mjs';
import { RUNNER_DRAIN_HELD_MS, RUNNER_NOTE_EVERY_MS, RUNNER_PORT_MS, requestKey, saveKey, workerRunnerPass } from './worker-runner.mjs';
import { DRAIN_CAUSES } from '../modules/M11-dispatcher/drain-alerts.mjs';
import { FUTURE_SKEW_MS } from '../shared/still-waiting.mjs';

const OWNER = 501; const ROOT = '/outboxes'; const COPIES = '/copies'; const FILE = '/runner/status.json';
const T0 = Date.parse('2026-11-09T12:00:00Z'); const MIN = 60_000; const CLAIM = 10 * MIN;
const N1 = '0123456789abcdef'; const N2 = 'fedcba9876543210';
const st = ({ dir = false } = {}) => ({ uid: OWNER, mode: dir ? 0o755 : 0o644, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });

// A runner world: fake processes by pgid, the last status written, and the reads of it the Dispatcher makes.
function world({ startAnswer, stopAnswer, gone = new Set(), drained = () => true } = {}) {
  const w = { now: T0, state: {}, saves: [], writes: [], notes: [], removed: [], started: [], stops: [], gone, status: null, n: 0 };
  w.ports = {
    start: async (x) => { w.started.push(x.sessionId); if (startAnswer) return startAnswer(x); w.n += 1; const role = x.kind === 'script' ? 'script' : 'worker';
      return { ok: true, pid: 4000 + w.n, pidStart: `2026-11-10T12:${String(w.n % 60).padStart(2, '0')}:00Z`, pgid: 4000 + w.n, head: 'a'.repeat(40), outbox: `${ROOT}/${x.product}/${role}/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/${x.product}/${x.card}` }; },
    groupGone: async (s) => w.gone.has(s.pgid),
    stopGroup: async (s) => { w.stops.push({ id: s.id, flagWritten: w.writes.at(-1)?.sessions.find((x) => x.id === s.id)?.stop_requested === true });
      if (stopAnswer) return stopAnswer(s); w.gone.add(s.pgid); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async (x) => { w.saves.push(x.id); return { ok: true }; },
    pauseLead: async () => ({ ok: true }),
    outboxDrained: async (s) => drained(s),
  };
  // The caller's side: the memory kept (keep) and the starts still on (pending), both held across passes.
  w.pending = new Map(); w.kept = []; w.keptAtWrite = [];
  // Every write is read back by the Dispatcher's reader at once (self-review m5), not only the last one.
  w.pass = async (requests = [], more = {}) => {
    const r = await workerRunnerPass({ state: w.state, requests, now: w.now, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, claimMs: CLAIM, portMs: 50,
      ports: w.ports, pending: w.pending, realpath: (p) => p, keep: (m) => { w.kept.push(m); w.state = m; },
      write: (d) => { w.keptAtWrite.push(w.kept.length); w.writes.push(structuredClone(d)); w.status = d; w.read(); }, remove: (n) => w.removed.push(n), note: (t) => w.notes.push(t), ...more });
    w.state = r.state; return r;
  };
  const open = () => ({ st: st(), text: JSON.stringify(w.status) });
  w.read = () => readOwnerStatus({ file: FILE, now: w.now, uid: OWNER, outboxRoot: ROOT, realpath: (p) => p, stat: () => st({ dir: true }), open });
  w.sync = (holds = () => true) => ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, product: 'p1', clock: () => w.now, stat: () => st({ dir: true }), open, realpath: (p) => p, holds, writeRequest: (n, t) => w.asked.push({ name: n, body: JSON.parse(t) }) });
  w.asked = [];
  // The Dispatcher's asks, with the runner's pass run between its polls: end to end through the real readers.
  w.asks = () => ownerAsyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, clock: () => w.now, pollMs: 2000, giveUpMs: 20_000, nonce: (() => { let i = 0; return () => [N1, N2][i++]; })(),
    sleep: async (ms) => { const q = w.asked.splice(0); await w.pass(q); w.now += ms; }, stat: () => st({ dir: true }), open, realpath: (p) => p,
    writeRequest: (n, t) => w.asked.push({ name: n, body: JSON.parse(t) }) });
  return w;
}
// Each session its own card (#358 r1 m4: one session per card), S-n on C-n.
const launchReq = (sid, more = {}, at = T0) => ({ name: `launch-${sid}.json`, body: { launch: { card: sid.replace(/^S/, 'C'), kind: 'editing', product: 'p1', sessionId: sid, ...more }, asked_at: new Date(at).toISOString() } });

test('step 3: a launch asked through owner-asks starts once, is listed, and the ask trusts the answer the runner wrote', async () => {
  const w = world();
  await w.pass();
  // The product rule is M10's (as the ask checks it): a name with capitals, a dot and an underscore is taken.
  const r = await w.asks().launch({ card: 'C-1', kind: 'editing', product: 'p1-x', sessionId: 'S-1' });
  assert.equal(r.ok, true, r.reason); assert.equal(r.outbox, `${ROOT}/p1-x/worker/S-1`); assert.equal(r.copy, `${COPIES}/p1-x/C-1`);
  assert.deepEqual(w.started, ['S-1']);
  const s = w.read();
  assert.deepEqual([s.requests['S-1'].state, s.sessions.map((x) => [x.id, x.alive, x.stop_requested, x.outbox_open])], ['started', [['S-1', true, false, true]]]);
  assert.deepEqual(w.sync().sessions().map((x) => x.id), ['S-1']);
  assert.equal('pid' in s.sessions[0], false, 'the status carries no field of the runner\'s own memory');
  // L767: a script launch's outbox is its own folder, and the ask trusts it.
  const sr = await w.asks().launch({ card: 'C-2', kind: 'script', product: 'p1', sessionId: 'S-2' });
  assert.equal(sr.ok, true, sr.reason); assert.equal(sr.outbox, `${ROOT}/p1/script/S-2`);
});

test('step 3: stopGroup writes stop_requested before it acts, answers ok only once the group is gone, and the session stays listed with that answer', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  const r = await w.asks().stopGroup({ id: 'S-1', pgid: 4001, kind: 'editing' });
  assert.deepEqual(r, { ok: true, how: 'SIGTERM' });
  assert.deepEqual(w.stops, [{ id: 'S-1', flagWritten: true }], 'the flag was in a written status before the stop');
  const s = w.read();
  assert.deepEqual(s.sessions.map((x) => [x.id, x.alive, x.ended, x.stop_requested]), [['S-1', false, true, true]]);
  assert.equal(s.requests['S-1'].state, 'stopped');
  assert.deepEqual(w.sync().board(), [], 'stopped on request: off the board');
  // A stop the port calls done while the group is still there is no ok: the answer waits on the group, not the port.
  const z = world({ stopAnswer: () => ({ ok: true, how: 'SIGTERM' }) });
  await z.pass([launchReq('S-1')]);
  const zr = await z.asks().stopGroup({ id: 'S-1', pgid: 4001, kind: 'editing' });
  assert.equal(zr.ok, false); assert.match(zr.reason, /the process group is still there; it may still run/);
  // A session the runner never started is no silent ok.
  const other = await w.asks().stopGroup({ id: 'S-9', pgid: 77, kind: 'editing' });
  assert.equal(other.ok, false); assert.match(other.reason, /did not start/);
});

test('L764 c1: a stop that times out answers ok: false with the flag set; the session then dies, and no dead row is ever shown', async () => {
  const w = world({ stopAnswer: () => new Promise(() => {}) });
  await w.pass([launchReq('S-1')]);
  const r = await w.asks().stopGroup({ id: 'S-1', pgid: 4001, kind: 'editing' });
  assert.equal(r.ok, false); assert.match(r.reason, /did not answer within the runner's limit; it may still run/);
  let s = w.read();
  assert.deepEqual(s.sessions.map((x) => [x.alive, x.stop_requested]), [[true, true]], 'still running, flag set');
  assert.deepEqual(w.sync().board().map((x) => x.id), ['S-1'], 'a live session stays on the board whatever the flag says');
  // It dies on its own a moment later: alive false, 'stopped', and the board drops it rather than showing a death.
  w.gone.add(4001); w.now += MIN; await w.pass();
  s = w.read();
  assert.deepEqual(s.sessions.map((x) => [x.alive, x.ended, x.stop_requested]), [[false, true, true]]);
  assert.equal(s.requests['S-1'].state, 'stopped');
  for (const holds of [() => true, () => false]) assert.deepEqual(w.sync(holds).board(), [], 'no dead row, whether or not the claim is still held');
  // Control: one that dies with no stop asked is shown once, while its claim is its own.
  const v = world(); await v.pass([launchReq('S-2')]); v.gone.add(4001); await v.pass();
  assert.deepEqual(v.sync(() => true).board().map((x) => [x.id, x.alive]), [['S-2', false]]);
});

test('#433 r1 m1: a request still being written is left in place, unnoted, and acted on once it is whole', async () => {
  const w = world();
  await w.pass([{ name: 'launch-S-1.json', body: { notYet: 'the request is empty yet' } }]);
  assert.deepEqual(w.removed, [], 'not removed, so not lost');
  assert.deepEqual(w.started, []);
  assert.equal(w.notes.join('\n'), '', 'nothing to tell');
  w.now += 2_000;
  await w.pass([launchReq('S-1')]);
  assert.deepEqual(w.started, ['S-1'], 'read next pass, whole');
  // Control: a refused one is still removed.
  const v = world(); await v.pass([{ name: 'launch-S-2.json', body: { refused: 'the request can\'t be read' } }]);
  assert.equal(v.removed.length, 1);
});

test('#328 r1 m2: a replayed request, one whose body is not its name\'s, and one older than the runner keeps answers are not read', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  const before = structuredClone(w.state.answers);
  w.now += MIN;
  await w.pass([launchReq('S-1'), { name: 'launch-S-2.json', body: launchReq('S-3').body },
    launchReq('S-4', {}, T0 - RUNNER_KEEP_USED_UP_MS - 1), { name: `stopGroup-S-1-${N1}.json`, body: { stopGroup: { id: 'S-9' } } },
    { name: 'launch-S-5.json', body: { refused: 'the request has 2 names' } }, { name: '../x.json', body: {} }]);
  assert.deepEqual(w.started, ['S-1'], 'nothing new started');
  assert.deepEqual(w.state.answers, before, 'no answer changed');
  assert.deepEqual(w.stops, []);
  const said = w.notes.join('\n');
  for (const re of [/launch-S-1.json was answered before/, /launch-S-2.json says something other than its name/, /launch-S-4.json is older than/, /stopGroup-S-1-[0-9a-f]+.json says something other/, /launch-S-5.json was refused unread: the request has 2 names/, /not a name the Dispatcher writes/]) assert.match(said, re);
  assert.equal(w.removed.length, 7, 'every file read is removed, so none is read twice');
  // A key seen once is not acted on again, even after its answer has gone (and a pass has run in between).
  const k = `saveWork-S-1-${N2}`; const ask = () => ({ name: `${k}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } });
  await w.pass([ask()]);
  assert.deepEqual(w.saves, ['S-1']);
  delete w.state.answers[k]; await w.pass();
  await w.pass([ask()]);
  assert.deepEqual(w.saves, ['S-1'], 'not saved again');
});

test('step 3: a stop request that reaches a launch first cancels it; a launch past the claim timeout, or of a kind or card the runner does not take, is refused', async () => {
  const w = world();
  await w.pass([{ name: 'stop-S-1.json', body: { stop: 'S-1' } }, launchReq('S-1')]);
  assert.deepEqual(w.started, []);
  assert.equal(w.read().requests['S-1'].state, 'cancelled');
  assert.equal(w.sync().stopSession('S-1'), true, 'used up: the claim can go');
  await w.pass([launchReq('S-2', {}, T0 - CLAIM - 1), launchReq('S-3', { kind: 'review' }), launchReq('S-4', { card: '../x' }), launchReq('S-5', { card: '.' }), launchReq('S-6', { product: 'Bad Name' })]);
  assert.deepEqual(w.started, []);
  const s = w.read();
  for (const id of ['S-2', 'S-3', 'S-4', 'S-5', 'S-6']) { assert.equal(s.requests[id].state, 'refused', id); assert.equal(s.answers[`launch-${id}`].ok, false, id); }
  assert.match(s.answers['launch-S-2'].reason, /older than the claim timeout/);
  // A stop asked again (stopSession asks each pass) acts again: a first stop that failed is tried on the next request.
  const z = world({ stopAnswer: () => ({ ok: false, reason: 'EPERM' }) });
  await z.pass([launchReq('S-1')]);
  await z.pass([{ name: 'stop-S-1.json', body: { stop: 'S-1' } }]); await z.pass([{ name: 'stop-S-1.json', body: { stop: 'S-1' } }]);
  assert.equal(z.stops.length, 2);
  // A start that refuses, or throws, is refused with its reason; nothing is listed.
  const v = world({ startAnswer: (x) => (x.sessionId === 'S-1' ? { ok: false, reason: 'not walled: x' } : Promise.reject(new Error('spawn failed'))) });
  await v.pass([launchReq('S-1'), launchReq('S-2')]);
  const vs = v.read();
  assert.deepEqual([vs.answers['launch-S-1'].reason, vs.sessions.length], ['not walled: x', 0]);
  assert.match(vs.answers['launch-S-2'].reason, /spawn failed/);
});

test('step 3: a start that does not answer stays waiting, unanswered and never used up; it is never started again', async () => {
  const w = world({ startAnswer: () => new Promise(() => {}) });
  await w.pass([launchReq('S-1')]);
  const s = w.read();
  assert.deepEqual([s.requests['S-1'].state, Object.keys(s.answers)], ['waiting', []]);
  assert.equal(w.sync().stopSession('S-1'), false, 'not used up, so the claim stays');
  await w.pass([launchReq('S-1')]);
  assert.deepEqual(w.started, ['S-1']);
  // A stop request for it leaves it waiting: the session may have started, so the request is never used up by a stop.
  await w.pass([{ name: 'stop-S-1.json', body: { stop: 'S-1' } }]);
  assert.equal(w.read().requests['S-1'].state, 'waiting');
  assert.equal(w.sync().stopSession('S-1'), false);
});

test('step 3: an ended session keeps its outbox open until intake has drained it, then leaves the listing after the keep window', async () => {
  let dry = false;
  const w = world({ drained: () => dry });
  await w.pass([launchReq('S-1')]);
  w.gone.add(4001); await w.pass();
  assert.deepEqual(w.sync().outboxSessions().map((x) => x.sessionId), ['S-1'], 'ended, outbox still open');
  dry = true; await w.pass();
  assert.deepEqual(w.sync().outboxSessions(), []);
  assert.deepEqual(w.read().sessions.map((x) => x.id), ['S-1'], 'still listed within the keep window');
  // Past the keep window with its outbox still open, the session stays listed, and so does its 'stopped' entry.
  dry = false; w.state.sessions[0].outbox_open = true; w.now += RUNNER_KEEP_USED_UP_MS + MIN; await w.pass();
  assert.deepEqual([w.read().sessions.map((x) => x.id), w.read().requests['S-1']?.state], [['S-1'], 'stopped']);
  dry = true; await w.pass();
  const s = w.read();
  assert.deepEqual([s.sessions, s.requests], [[], {}], 'gone with its used-up entry once the window has passed');
  // The keep window counts from the end, not the launch: one launched long ago that ends now stays listed (no answer names it).
  const u = world(); await u.pass([launchReq('S-3')]);
  u.now += RUNNER_KEEP_USED_UP_MS + MIN; await u.pass();
  assert.deepEqual(u.read().answers, {}, 'its launch answer is past keeping');
  u.gone.add(4001); await u.pass(); await u.pass();
  assert.deepEqual([u.read().sessions.map((x) => [x.id, x.outbox_open]), u.read().requests['S-3'].state], [[['S-3', false]], 'stopped']);
  // A group the port can't tell about has no alive field, so it still counts as live.
  const v = world(); await v.pass([launchReq('S-2')]);
  v.ports.groupGone = async () => { throw new Error('ps failed'); }; await v.pass();
  assert.deepEqual(v.read().sessions.map((x) => ['alive' in x, x.ended]), [[false, false]]);
  assert.deepEqual(v.sync().sessions().map((x) => x.id), ['S-2']);
});

test('step 3: request names: each verb\'s key, and nothing else', () => {
  assert.deepEqual(requestKey('launch-S-1.json'), { verb: 'launch', key: 'launch-S-1', id: 'S-1' });
  assert.deepEqual(requestKey(`stopGroup-S-1-${N1}.json`), { verb: 'stopGroup', key: `stopGroup-S-1-${N1}`, id: 'S-1', nonce: N1 });
  assert.deepEqual(requestKey(`pauseLead-p1-${N1}.json`), { verb: 'pauseLead', key: `pauseLead-p1-${N1}`, product: 'p1', nonce: N1 });
  for (const n of ['launch-S-1', 'other-S-1.json', `stopGroup-S-1.json`, `stopGroup-S-1-xyz.json`, `pauseLead-.p1-${N1}.json`, '../launch-S-1.json', 'launch-__proto__x.json/']) assert.equal(requestKey(n), null, n);
});

const stopReq = (sid, nonce, at, more = {}) => ({ name: `stopGroup-${sid}-${nonce}.json`, body: { stopGroup: { id: sid, ...more }, asked_at: new Date(at).toISOString() } });

test('self-review M1: an ended session is final; a process group number used again never brings it back', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  w.gone.add(4001); await w.pass();
  w.gone.delete(4001); await w.pass(); // the number is in use again, by some other process
  const s = w.read();
  assert.deepEqual([s.sessions.map((x) => [x.alive, x.ended]), s.requests['S-1'].state], [[[false, true]], 'stopped']);
  assert.deepEqual(w.sync().sessions(), [], 'not live');
});

// #384 m1: the start's base reaches the answer the Dispatcher's launch ask reads; a start that says none leaves it out,
// never null (owner-asks launchAnswerWrong refuses a null one).
test('#384 m1: a start\'s base is handed on in its answer, and left out when the start names none', async () => {
  const ok = (x, more = {}) => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'a'.repeat(40), outbox: `${ROOT}/${x.product}/worker/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/${x.product}/${x.card}`, ...more });
  const w = world({ startAnswer: (x) => ok(x, { base: 'b'.repeat(40) }) });
  await w.pass([launchReq('S-1')]);
  assert.equal(w.read().answers['launch-S-1'].base, 'b'.repeat(40));
  const v = world({ startAnswer: (x) => ok(x) });
  await v.pass([launchReq('S-1')]);
  assert.equal(v.read().answers['launch-S-1'].ok, true);
  assert.ok(!Object.hasOwn(v.read().answers['launch-S-1'], 'base'), 'no base key at all');
  // A malformed one is refused as any other bad answer, and the session stopped.
  const m = world({ startAnswer: (x) => ok(x, { base: 'main' }) });
  await m.pass([launchReq('S-1')]);
  assert.deepEqual([m.read().answers['launch-S-1'].ok, m.stops.map((x) => x.id)], [false, ['S-1']]);
});

test('self-review M2: a start answer the reader would refuse is never listed; it is stopped, then refused once its group is gone', async () => {
  const bad = { 'outbox outside the root': { outbox: '/elsewhere/worker/S-1' }, 'a script outbox for an editing card': { outbox: `${ROOT}/p1/script/S-1` },
    'no sign-in': { signin: '' }, 'no config folder': { configDir: undefined }, 'process group 1': { pgid: 1, ok: true }, 'no process': { pid: 0 },
    'no start time (step-4 review M3)': { pidStart: '' }, 'a leader not its group\'s (step-4 review M3)': { pgid: 4002 },
    'no commit (#358 r1 m1)': { head: 'not-a-sha' }, 'another card\'s copy (#358 r1 m1)': { copy: '/somewhere/else' } };
  for (const [what, more] of Object.entries(bad)) {
    const w = world({ startAnswer: (x) => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'a'.repeat(40), outbox: `${ROOT}/p1/worker/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/p1/C-1`, ...more }) });
    await w.pass([launchReq('S-1')]);
    const s = w.read();
    assert.deepEqual(s.sessions, [], what);
    if (more.pgid === 1) { assert.equal(s.requests['S-1'].state, 'waiting', `${what}: can't be stopped, so the claim stays`); assert.deepEqual(w.stops, [], what); continue; }
    assert.deepEqual([s.requests['S-1'].state, s.answers['launch-S-1'].ok, w.stops.map((x) => x.id)], ['refused', false, ['S-1']], what);
    assert.match(s.answers['launch-S-1'].reason, /it was stopped/, what);
  }
  // One whose group can't be shown gone stays waiting (the session may run), so its claim stays.
  const v = world({ startAnswer: () => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'a', outbox: '/elsewhere', signin: 's', configDir: '/c', copy: '/c' }), stopAnswer: () => ({ ok: false, reason: 'EPERM' }) });
  await v.pass([launchReq('S-1')]);
  assert.deepEqual([v.read().requests['S-1'].state, v.read().sessions, v.sync().stopSession('S-1')], ['waiting', [], false]);
});

test('self-review M3: the memory is kept before every status write, so a runner that stops mid-start comes back with the start still waiting', async () => {
  let atStart;
  const w = world({ startAnswer: () => { atStart = structuredClone(w.kept.at(-1)); return new Promise(() => {}); } });
  await w.pass([launchReq('S-1')]);
  assert.equal(atStart.requests['S-1'].state, 'waiting', 'kept before the start was called');
  assert.deepEqual(w.keptAtWrite, w.writes.map((_, i) => i + 1), 'each write comes after its keep');
  // The runner stops here and comes back: the memory is what was kept, and no start is held.
  w.state = structuredClone(atStart); w.pending = new Map();
  await w.pass([{ name: 'stop-S-1.json', body: { stop: 'S-1' } }]);
  assert.equal(w.read().requests['S-1'].state, 'waiting');
  assert.equal(w.sync().stopSession('S-1'), false, 'never cancelled, so the claim stays');
  assert.match(w.notes.join('\n'), /start of S-1 was on when the runner last stopped/);
});

test('self-review m2: a start that answers after the runner\'s limit is settled by a later pass, not lost', async () => {
  let go; const w = world();
  const real = w.ports.start; w.ports.start = (x) => new Promise((resolve) => { go = () => resolve(real(x)); });
  await w.pass([launchReq('S-1')]);
  assert.equal(w.read().requests['S-1'].state, 'waiting');
  go(); await new Promise((r) => setImmediate(r));
  await w.pass();
  const s = w.read();
  assert.deepEqual([s.requests['S-1'].state, s.answers['launch-S-1'].ok, s.sessions.map((x) => x.id), w.pending.size], ['started', true, ['S-1'], 0]);
});

test('self-review M4: the status is written after each session and each request, and no port is waited on for as long as the rewrite cadence', async () => {
  assert.ok(RUNNER_PORT_MS < RUNNER_STATUS_EVERY_MS);
  const w = world();
  await w.pass([launchReq('S-1'), launchReq('S-2')]);
  // Ports that hang: every port wait is followed by a write before the next port is asked (step-4 review M4).
  const at = []; const hang = (name) => () => { at.push([name, w.writes.length]); return new Promise(() => {}); };
  w.ports.groupGone = hang('groupGone'); w.ports.size = hang('size'); w.ports.outboxDrained = hang('outboxDrained'); w.ports.saveWork = hang('saveWork');
  const t = Date.now();
  await w.pass([launchReq('S-3'), { name: `saveWork-S-1-${N1}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } }]);
  assert.deepEqual(at.map((x) => x[0]), ['groupGone', 'size', 'groupGone', 'size', 'saveWork']);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i][1] > at[i - 1][1], `a write between ${at[i - 1][0]} and ${at[i][0]}`);
  assert.ok(w.writes.length > at.at(-1)[1], 'and after the last');
  assert.ok(Date.now() - t < 1000, 'each hung port is given up after portMs');
});

test('#388 r1 m4: a drain that hangs, throws or answers anything but true keeps an ended session\'s outbox open', async () => {
  const cases = [['hangs', () => new Promise(() => {})], ['throws', () => { throw new Error('EIO'); }], ['rejects', () => Promise.reject(new Error('EIO'))],
    ['false', () => false], ['undefined', () => undefined], ['an object', () => ({ drained: true })], ['the text true', () => 'true']];
  for (const [why, drained] of [...cases, ['true', () => true]]) {
    const w = world({ drained });
    await w.pass([launchReq('S-1')]);
    w.gone.add(4001); await w.pass(); await w.pass();
    const x = w.status.sessions.find((y) => y.id === 'S-1');
    assert.equal(x?.ended, true, why);
    assert.equal(x.outbox_open, why !== 'true', why);
  }
});

test('self-review m1, m3, m6, c3: a session stays listed while an answer naming it is kept; a request dated ahead, one that can\'t be removed, and a stop of another group are not acted on', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  w.gone.add(4001); await w.pass();
  w.now += RUNNER_KEEP_USED_UP_MS + MIN;
  await w.pass([stopReq('S-1', N1, w.now)]);
  assert.deepEqual(w.read().answers[`stopGroup-S-1-${N1}`], { ok: true, how: 'already gone' });
  w.now += MIN; await w.pass();
  assert.deepEqual([w.read().sessions.map((x) => x.id), Object.keys(w.read().answers)], [['S-1'], [`stopGroup-S-1-${N1}`]], 'listed while its answer is kept');
  w.now += RUNNER_KEEP_USED_UP_MS; await w.pass(); await w.pass();
  assert.deepEqual([w.read().sessions, w.read().answers], [[], {}]);
  // m3: dated later than now by more than the clock skew.
  const v = world();
  await v.pass([launchReq('S-1', {}, T0 + CLOCK_SKEW_MS + 1), launchReq('S-2', {}, T0 + CLOCK_SKEW_MS)]);
  assert.deepEqual(v.started, ['S-2']); assert.match(v.notes.join('\n'), /launch-S-1.json is dated later than now/);
  // m6: a remove that throws leaves that file unread, and the pass goes on.
  const u = world();
  await u.pass([launchReq('S-1'), launchReq('S-2')], { remove: (n) => { if (n === 'launch-S-1.json') throw new Error('EACCES'); } });
  assert.deepEqual(u.started, ['S-2']); assert.match(u.notes.join('\n'), /launch-S-1.json could not be removed \(EACCES\)/);
  // c3: a stop naming another process group than the listed one.
  await u.pass([stopReq('S-2', N1, u.now, { pgid: 999 })]);
  assert.deepEqual([u.stops, u.read().answers[`stopGroup-S-2-${N1}`].ok], [[], false]);
  await u.pass([stopReq('S-2', N2, u.now, { pgid: 4001 })]);
  assert.equal(u.read().answers[`stopGroup-S-2-${N2}`].ok, true);
});

test('#358 r1 M1: each write is stamped when it is made, no two writes are further apart than one port wait, and step 0 writes after each settle', async () => {
  // The clock moves on during the pass; each write carries the time it was made.
  const w = world(); let t = T0;
  await w.pass([launchReq('S-1'), launchReq('S-2')], { clock: () => (t += 1000) });
  const at = w.writes.map((d) => Date.parse(d.written_at));
  assert.ok(new Set(at).size === at.length && at.every((x, i) => i === 0 || x > at[i - 1]), `written_at moves on: ${at}`);
  // Every port hangs: the widest gap between writes is one port wait (portMs 50), whatever the number of sessions.
  const v = world();
  await v.pass([launchReq('S-1'), launchReq('S-2'), launchReq('S-3')]);
  const times = []; const hang = () => new Promise(() => {});
  v.ports.groupGone = hang; v.ports.size = hang; v.ports.stopGroup = hang; v.ports.start = hang;
  const t0 = Date.now();
  await v.pass([stopReq('S-1', N1, v.now), launchReq('S-4')], { write: (d) => { times.push(Date.now()); v.writes.push(d); v.status = d; } });
  const gaps = [times[0] - t0, ...times.slice(1).map((x, i) => x - times[i])];
  assert.ok(Math.max(...gaps) < 50 * 1.9, `the widest gap is one port wait: ${gaps}`);
  // Step 0: starts that answered wrong are each stopped (a port wait or two), with a write after each.
  let go = []; const u = world({ startAnswer: (x) => new Promise((r) => go.push(() => r({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'x', outbox: '/elsewhere', signin: 's', configDir: '/c', copy: `${COPIES}/${x.product}/${x.card}` }))) });
  await u.pass([launchReq('S-1'), launchReq('S-2'), launchReq('S-3')]);
  go.forEach((f) => f()); await new Promise((r) => setImmediate(r));
  const settledAt = [];
  u.ports.stopGroup = async (s) => { settledAt.push(u.writes.length); u.gone.add(s.pgid); return { ok: true }; };
  await u.pass();
  assert.equal(settledAt.length, 3);
  // A start settled right is in a written status before the first session is checked.
  let go2; const q = world(); const real = q.ports.start; q.ports.start = (x) => new Promise((r) => { go2 = () => r(real(x)); });
  await q.pass([launchReq('S-1')]); go2(); await new Promise((r) => setImmediate(r));
  let listed; q.ports.groupGone = async () => { listed = q.status.sessions.map((x) => x.id); return false; };
  await q.pass();
  assert.deepEqual(listed, ['S-1'], 'written after the settle');
  for (let i = 1; i < settledAt.length; i += 1) assert.ok(settledAt[i] > settledAt[i - 1], 'a write between one settle and the next');
});

test('#358 r1 m2: a replay of a request dated ahead of the clock is still refused a day on', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  const save = { name: `saveWork-S-1-${N1}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(T0 + CLOCK_SKEW_MS).toISOString() } };
  await w.pass([save]);
  // A day after it was seen, but not yet a day after its own date.
  w.now = T0 + RUNNER_KEEP_USED_UP_MS + 5; await w.pass();
  w.now += 5; await w.pass([save]);
  assert.deepEqual(w.saves, ['S-1']);
  assert.match(w.notes.join('\n'), /saveWork-S-1-0123456789abcdef.json was answered before/);
});

test('#358 r1 m3, #362 r1 M1: a keep that fails just after a start settled leaves the start held, so the next pass lists it and a stop reaches it', async () => {
  const w = world(); let failed = false;
  const keep = (m) => { if (!failed && m.requests?.['S-1']?.state === 'started') { failed = true; throw new Error('EIO'); } w.kept.push(m); w.state = m; };
  await assert.rejects(w.pass([launchReq('S-1')], { keep }), /EIO/);
  assert.equal(w.state.requests['S-1'].state, 'waiting', 'the memory last kept');
  assert.equal(w.pending.size, 1, 'and the start is still held');
  await w.pass([stopReq('S-1', N1, w.now)]);
  assert.deepEqual([w.read().sessions.map((x) => [x.id, x.alive]), w.stops.map((x) => x.id), w.pending.size], [[['S-1', false]], ['S-1'], 0]);
  assert.equal(w.started.length, 1, 'started once');
  // The same for a start settled by step 0 (one that answered after the runner's limit).
  let go; const v = world(); const real = v.ports.start; v.ports.start = (x) => new Promise((r) => { go = () => r(real(x)); });
  let vf = false;
  const vkeep = (m) => { if (!vf && m.requests?.['S-1']?.state === 'started') { vf = true; throw new Error('EIO'); } v.kept.push(m); v.state = m; };
  await v.pass([launchReq('S-1')]);
  go(); await new Promise((r) => setImmediate(r));
  await assert.rejects(v.pass([], { keep: vkeep }), /EIO/);
  assert.equal(v.pending.size, 1, 'still held after step 0\'s keep failed');
  await v.pass();
  assert.deepEqual([v.read().sessions.map((x) => x.id), v.pending.size], [['S-1'], 0]);
});

test('#358 r1 m4: a second launch for a card with a live session, or a start still on, is refused', async () => {
  const w = world();
  await w.pass([launchReq('S-1'), launchReq('S-2', { card: 'C-1' })]);
  assert.deepEqual([w.started, w.read().answers['launch-S-2'].ok], [['S-1'], false]);
  assert.match(w.read().answers['launch-S-2'].reason, /card C-1 already has a session/);
  const v = world(); v.ports.start = () => new Promise(() => {});
  await v.pass([launchReq('S-1')]); await v.pass([launchReq('S-2', { card: 'C-1' })]);
  assert.equal(v.read().requests['S-2'].state, 'refused', 'a start still waiting holds the card too');
  // Once the first has ended, the card can start again.
  w.gone.add(4001); await w.pass([launchReq('S-3', { card: 'C-1' })]);
  assert.deepEqual(w.started, ['S-1', 'S-3']);
});

test('#358 r1 m6: a start still on is noted again, at most every RUNNER_NOTE_EVERY_MS', async () => {
  const w = world(); w.ports.start = () => new Promise(() => {});
  await w.pass([launchReq('S-1')]);
  const n = () => w.notes.filter((x) => /start of S-1 is still on/.test(x)).length;
  assert.equal(n(), 1);
  w.now += MIN; await w.pass(); assert.equal(n(), 1, 'not every pass');
  w.now += RUNNER_NOTE_EVERY_MS; await w.pass(); assert.equal(n(), 2, 'but again after the note interval');
});

test('#358 r1 m7: a stopGroup whose pgid is not the listed number (a string included) is refused', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  await w.pass([stopReq('S-1', N1, w.now, { pgid: '4001' })]);
  assert.deepEqual([w.stops, w.read().answers[`stopGroup-S-1-${N1}`].ok], [[], false]);
});

test('#358 r2 m-a (P7): each port wait is followed by a write, and no write comes before the first port', async () => {
  const ev = [];
  const a = (x) => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'a'.repeat(40), outbox: `/o/p1/worker/${x.sessionId}`, signin: 's', configDir: '/c', copy: `/copies/p1/${x.card}` });
  const ports = { start: async (x) => a(x), groupGone: async () => { ev.push('port:gg'); return false; }, stopGroup: async () => ({ ok: true }),
    saveWork: async () => { ev.push('port:save'); return { ok: true }; }, pauseLead: async () => ({ ok: true }), outboxDrained: async () => false };
  const base = { uid: 501, outboxRoot: '/o', copiesRoot: '/copies', claimMs: 600000, portMs: 50, ports, pending: new Map(), realpath: (p) => p, keep: () => {}, now: T0 };
  const r1 = await workerRunnerPass({ ...base, state: {}, requests: [{ name: 'launch-S-1.json', body: { launch: { card: 'C-1', kind: 'editing', product: 'p1', sessionId: 'S-1' }, asked_at: new Date(T0).toISOString() } }], write: () => {} });
  ev.length = 0;
  await workerRunnerPass({ ...base, state: r1.state, write: () => ev.push('write'),
    requests: [{ name: 'saveWork-S-1-0123456789abcdef.json', body: { saveWork: { id: 'S-1' }, asked_at: new Date(T0).toISOString() } }] });
  assert.equal(ev[0], 'port:gg', ev.join(' '));
  for (let i = 0; i < ev.length; i++) if (ev[i].startsWith('port:')) assert.equal(ev[i + 1], 'write', ev.join(' '));
});

test('#364 r1 m3, m2: a start answered as running stays waiting with its claim; a started one keeps base in its row and answer', async () => {
  const answers = [];
  const mk = (start) => ({ uid: 501, outboxRoot: '/o', copiesRoot: '/copies', claimMs: 600000, portMs: 50, pending: new Map(), realpath: (p) => p, keep: () => {}, now: T0,
    ports: { start, groupGone: async () => false, stopGroup: async () => ({ ok: true }), saveWork: async () => ({ ok: true }), pauseLead: async () => ({ ok: true }), outboxDrained: async () => false },
    write: (doc) => answers.push(doc) });
  const req = [{ name: 'launch-S-1.json', body: { launch: { card: 'C-1', kind: 'editing', product: 'p1', sessionId: 'S-1' }, asked_at: new Date(T0).toISOString() } }];
  const r = await workerRunnerPass({ ...mk(async () => ({ ok: false, running: true, pgid: 4001, reason: 'may run' })), state: {}, requests: req });
  assert.equal(r.state.requests['S-1'].state, 'waiting', 'not refused, so the claim stays');
  const B = 'c'.repeat(40);
  const r2 = await workerRunnerPass({ ...mk(async (x) => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:00:01Z', pgid: 4001, head: 'a'.repeat(40), base: B, outbox: `/o/p1/worker/${x.sessionId}`, signin: 's', configDir: '/c', copy: `/copies/p1/${x.card}` })), state: {}, requests: req });
  assert.equal(r2.state.sessions[0].base, B);
  assert.equal(JSON.stringify(answers.at(-1)).includes(B), true, 'the answer names base');
});

test('#364 r2 n2: a start answered as running keeps its process group in the waiting row and every note; a stop asked for it names the group and signals nothing', { timeout: 10_000 }, async () => {   // L842: a stop that falls through to a signal fails, never hangs
  const notes = []; const stops = [];
  const mk = (start, now) => ({ uid: 501, outboxRoot: '/o', copiesRoot: '/copies', claimMs: 600000, portMs: 50, pending: new Map(), realpath: (p) => p, keep: () => {}, now,
    ports: { start, groupGone: async () => false, stopGroup: async (s) => { stops.push(s); return { ok: true }; }, saveWork: async () => ({ ok: true }), pauseLead: async () => ({ ok: true }), outboxDrained: async () => false },
    write: () => {}, note: (t) => notes.push(t) });
  const req = [{ name: 'launch-S-1.json', body: { launch: { card: 'C-1', kind: 'editing', product: 'p1', sessionId: 'S-1' }, asked_at: new Date(T0).toISOString() } }];
  const r = await workerRunnerPass({ ...mk(async () => ({ ok: false, running: true, pgid: 4001, reason: 'may run' }), T0), state: {}, requests: req });
  const row = r.state.requests['S-1'];
  assert.equal(row.state, 'waiting'); assert.equal(row.running, true); assert.equal(row.pgid, 4001); assert.equal(row.card, 'C-1');
  assert.match(notes.join('\n'), /S-1 may have left claude running in process group 4001 \(may run\)/);
  // A later pass (a new runner: nothing held) names the group, not "was on when the runner last stopped".
  notes.length = 0;
  const later = await workerRunnerPass({ ...mk(async () => { throw new Error('not again'); }, T0 + RUNNER_NOTE_EVERY_MS + 1), state: structuredClone(r.state), requests: [] });
  assert.match(notes.join('\n'), /S-1 may have left claude running in process group 4001; it stays waiting/);
  assert.doesNotMatch(notes.join('\n'), /was on when the runner last stopped/);
  // A stop asked for it: the group is named, nothing is signalled, the claim stays.
  notes.length = 0;
  const st = await workerRunnerPass({ ...mk(async () => { throw new Error('not again'); }, T0 + 1000), state: structuredClone(later.state), requests: [{ name: 'stop-S-1.json', body: { stop: 'S-1' } }] });
  assert.deepEqual(stops, []);
  assert.equal(st.state.requests['S-1'].state, 'waiting'); assert.equal(st.state.requests['S-1'].pgid, 4001);
  assert.match(notes.join('\n'), /a stop was asked for S-1, but its start may have left claude running in process group 4001.*not signalled/);
});

test('#378 r1 M1, m3: a start is told the other live sessions (listed, and an earlier run\'s waiting starts, marked unstarted); a waiting row names its product; a product setup makes no folder for is refused', async () => {
  let seen; let row;
  const w = world({ startAnswer: (x) => { seen = x.live; row = structuredClone(w.kept.at(-1)?.requests?.[x.sessionId]);
    w.n += 1; return { ok: true, pid: 4000 + w.n, pidStart: `2026-11-10T12:${String(w.n % 60).padStart(2, '0')}:00Z`, pgid: 4000 + w.n, head: 'a'.repeat(40), outbox: `${ROOT}/${x.product}/worker/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/${x.product}/${x.card}` }; } });
  await w.pass([launchReq('S-1')]);
  assert.deepEqual(seen, [], 'the first start: none');
  w.state = { ...w.state, requests: { ...w.state.requests, 'S-8': { state: 'waiting', at: T0, card: 'C-8', product: 'p2' } } };
  await w.pass([launchReq('S-2', { product: 'p3' })]);
  assert.deepEqual(seen, [{ id: 'S-1', product: 'p1' }, { id: 'S-8', product: 'p2', unstarted: true }]);
  assert.equal(row.state, 'waiting'); assert.equal(row.product, 'p3');
  seen = undefined;
  await w.pass([launchReq('S-3', { product: 'Alpha' })]);
  assert.equal(seen, undefined, 'not started');
  assert.equal(w.state.requests['S-3'].state, 'refused');
});

test('L896: an ended session\'s outbox undrained past the limit is listed with its cause and since, read on by the status reader; drained, it goes', async () => {
  let answer = { drained: false, cause: 'not-taken' };
  const w = world({ drained: () => answer });
  await w.pass([launchReq('S-1')]);
  const row = () => w.status.sessions.find((x) => x.id === 'S-1');
  await w.pass();
  assert.equal(row().drain_held, undefined, 'running: never held');
  w.gone.add(4001); await w.pass();
  const first = w.now;
  assert.equal(row().outbox_open, true);
  assert.equal(row().drain_held, undefined, 'not yet past the limit');
  w.now = first + RUNNER_DRAIN_HELD_MS - 1; await w.pass();
  assert.equal(row().drain_held, undefined, 'one ms short');
  w.now = first + RUNNER_DRAIN_HELD_MS; await w.pass();
  assert.deepEqual(row().drain_held, { cause: 'not-taken', since: new Date(w.now).toISOString() });
  assert.deepEqual(w.sync().drainHolds(), [{ session: 'S-1', card: 'C-1', product: 'p1', cause: 'not-taken', since: new Date(w.now).toISOString() }]);
  const since = row().drain_held.since;
  w.now += MIN; await w.pass();
  assert.equal(row().drain_held.since, since, 'the same cause keeps its since');
  answer = { drained: false, cause: 'hash-mismatch' };
  w.now += MIN; await w.pass();
  assert.deepEqual(row().drain_held, { cause: 'hash-mismatch', since: new Date(w.now).toISOString() }, 'a new cause, a new since');
  // #425 r1 m1: a late or failed check keeps the cause already held, and its since: one slow pass tells nothing new.
  const kept = row().drain_held;
  for (const slow of [() => new Promise(() => {}), () => { throw new Error(''); }]) {
    answer = undefined; const was = w.ports.outboxDrained; w.ports.outboxDrained = slow;
    w.now += MIN; await w.pass();
    w.ports.outboxDrained = was;
    assert.deepEqual(row().drain_held, kept, 'a slow or failed pass keeps the held cause');
  }
  answer = { drained: false, cause: 'hash-mismatch' };
  w.now += MIN; await w.pass();
  assert.deepEqual(row().drain_held, kept, 'back to the same cause: still the same since');
  // #425 r1 m4: a memory that keeps drain_held but not when it was first seen (an older one) is past the limit at once.
  delete w.state.sessions.find((x) => x.id === 'S-1').undrained_since;
  answer = { drained: false, cause: 'in-flight' };
  w.now += MIN; await w.pass();
  assert.deepEqual(row().drain_held, { cause: 'in-flight', since: new Date(w.now).toISOString() }, 'a changed cause shows at once, not half an hour on');
  answer = true;
  w.now += MIN; await w.pass();
  assert.equal(row().outbox_open, false);
  assert.equal('drain_held' in row(), false, 'drained: no longer held');
  assert.deepEqual(w.sync().drainHolds(), []);
  assert.ok(!JSON.stringify(w.status).includes('undrained_since'), 'when it was first seen stays in the runner\'s memory');
});

test('#425 r1, r2: a first sight more than FUTURE_SKEW_MS ahead is past the limit; a failed Record read keeps the held cause; a bad drain_held is dropped', async () => {
  let answer = { drained: false, cause: 'not-taken' };
  const w = world({ drained: () => answer });
  await w.pass([launchReq('S-1')]);
  const row = () => w.status.sessions.find((x) => x.id === 'S-1');
  const mem = () => w.state.sessions.find((x) => x.id === 'S-1');
  w.gone.add(4001); await w.pass();
  assert.equal(row().drain_held, undefined, 'not yet past the limit');
  // M1: a clock set back an hour leaves the first sight ahead of now; it is told now, not an hour and a half on.
  w.now -= 60 * MIN; await w.pass();
  assert.deepEqual(row().drain_held, { cause: 'not-taken', since: new Date(w.now).toISOString() }, 'a clock set back');
  delete mem().drain_held; mem().undrained_since = w.now + 365 * 24 * 60 * MIN;
  w.now += MIN; await w.pass();
  assert.equal(row().drain_held?.cause, 'not-taken', 'a first sight a year ahead, nothing held: past the limit');
  // r2 m1: ahead by no more than FUTURE_SKEW_MS at the pass's own now is waited out as any first sight; one ms more is
  // held at once.
  w.now += MIN; delete mem().drain_held; mem().undrained_since = w.now + FUTURE_SKEW_MS;
  await w.pass();
  assert.equal(row().drain_held, undefined, 'FUTURE_SKEW_MS ahead: waited out');
  w.now += 30_000; await w.pass();
  assert.equal(row().drain_held, undefined, 'still within the limit from that first sight');
  w.now += MIN; delete mem().drain_held; mem().undrained_since = w.now + 30_000;
  await w.pass();
  assert.equal(row().drain_held, undefined, '30 s ahead: waited out');
  w.now += RUNNER_DRAIN_HELD_MS + 30_000; await w.pass();
  assert.equal(row().drain_held?.cause, 'not-taken', 'then held at the limit');
  w.now += MIN; delete mem().drain_held; mem().undrained_since = w.now + FUTURE_SKEW_MS + 1;
  await w.pass();
  assert.equal(row().drain_held?.cause, 'not-taken', 'FUTURE_SKEW_MS + 1 ahead: held at once');
  // m2: a Record that can't be read keeps the cause held; a cause that flips with it tells nothing new.
  const kept = row().drain_held;
  for (const c of ['record-unreadable', 'not-taken', 'record-unreadable', 'not-taken']) {
    answer = { drained: false, cause: c }; w.now += MIN; await w.pass();
    assert.deepEqual(row().drain_held, kept, `flipping to ${c} keeps the held cause`);
  }
  // Nothing held yet: record-unreadable is held as itself.
  const v = world({ drained: () => ({ drained: false, cause: 'record-unreadable' }) });
  await v.pass([launchReq('S-1')]); v.gone.add(4001); await v.pass();
  v.now += RUNNER_DRAIN_HELD_MS; await v.pass();
  assert.equal(v.status.sessions.find((x) => x.id === 'S-1').drain_held?.cause, 'record-unreadable');
  // m4, r2 c1: a drain_held in memory the status reader would refuse is dropped, and the real cause held in the same
  // pass: no write of that pass shows any other cause first, and the status stays readable.
  for (const bad of [{ cause: 'not-taken', since: 'garbled' }, { cause: 'made-up', since: kept.since }, { ...kept, extra: 1 }, 'x', []]) {
    answer = { drained: false, cause: 'not-taken' };
    mem().drain_held = bad; w.now += MIN; w.writes.length = 0; await w.pass();
    assert.deepEqual(row().drain_held, { cause: 'not-taken', since: new Date(w.now).toISOString() }, JSON.stringify(bad));
    assert.deepEqual([...new Set(w.writes.map((d) => d.sessions.find((x) => x.id === 'S-1').drain_held?.cause ?? 'none'))], ['none', 'not-taken'], `nothing else published first (${JSON.stringify(bad)})`);
    assert.ok(Array.isArray(w.sync().drainHolds()), `the status reads (${JSON.stringify(bad)})`);
  }
  // A bad one beside a failed check: held at once as the check's own cause, never 'other'.
  answer = undefined; const was = w.ports.outboxDrained; w.ports.outboxDrained = () => { throw new Error('EIO'); };
  mem().drain_held = { cause: 'made-up', since: 'garbled' }; w.now += MIN; await w.pass();
  w.ports.outboxDrained = was;
  assert.deepEqual(row().drain_held, { cause: 'check-failed', since: new Date(w.now).toISOString() }, 'dropped, then held as the failed check');
  // r2 m2: a valid one on a session whose outbox is closed, or on a live one, is dropped: the status stays readable.
  for (const [why, damage] of [['closed', (m) => { m.outbox_open = false; }], ['live', (m) => { m.alive = true; delete m.ended; }]]) {
    const x = world({ drained: () => ({ drained: false, cause: 'not-taken' }) });
    await x.pass([launchReq('S-1')]); x.gone.add(4001); await x.pass();
    x.now += RUNNER_DRAIN_HELD_MS; await x.pass();
    const m = x.state.sessions.find((y) => y.id === 'S-1');
    assert.equal(m.drain_held?.cause, 'not-taken');
    damage(m);
    // A live session is one whose launch is still started (the reader's other rule), so the damage is the memory's alone.
    if (why === 'live') { x.gone.delete(4001); x.state.requests['S-1'] = { ...x.state.requests['S-1'], state: 'started' }; }
    x.now += MIN; await x.pass();
    assert.equal('drain_held' in x.status.sessions.find((y) => y.id === 'S-1'), false, `${why}: dropped`);
    assert.ok(Array.isArray(x.sync().drainHolds()), `${why}: the status reads`);
  }
  // A bad one in an older memory that kept no first sight: it was told, so the real cause is held at once.
  answer = { drained: false, cause: 'hash-mismatch' };
  delete mem().undrained_since; mem().drain_held = { cause: 'made-up' }; w.now += MIN; await w.pass();
  assert.deepEqual(row().drain_held, { cause: 'hash-mismatch', since: new Date(w.now).toISOString() }, 'no first sight kept: held at once');
  mem().outbox_open = false; mem().drain_held = 'x'; w.now += MIN; await w.pass();
  assert.equal('drain_held' in row(), false, 'closed and malformed: dropped');
});

test('L896: a drain check that is late, fails or answers no known cause is held under its own cause', async () => {
  for (const [why, drained, cause] of [['late', () => new Promise(() => {}), 'check-late'], ['throws', () => { throw new Error('EIO'); }, 'check-failed'], ['throws with no message', () => { throw new Error(''); }, 'check-failed'],
    ['false', () => false, 'other'], ['an unknown cause', () => ({ drained: false, cause: 'made-up' }), 'other'], ['nothing', () => undefined, 'other'],
    ...DRAIN_CAUSES.map((c) => [c, () => ({ drained: false, cause: c }), c])]) {
    const w = world({ drained });
    await w.pass([launchReq('S-1')]);
    w.gone.add(4001); await w.pass();
    w.now += RUNNER_DRAIN_HELD_MS; await w.pass();
    assert.equal(w.status.sessions.find((x) => x.id === 'S-1').drain_held?.cause, cause, why);
  }
});

test('#456 runLocked self-review M1: a save still on after portMs is held, answered by a later pass, and a second save of that session meanwhile is refused at once', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  let end; const runs = [];
  w.ports.saveWork = (s) => { runs.push(s.id); return new Promise((r) => { end = r; }); };
  const ask = (n) => ({ name: `saveWork-S-1-${n}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } });
  const t = Date.now();
  await w.pass([ask(N1)]);
  assert.ok(Date.now() - t < 1000, 'the pass does not wait on the save past portMs (the status cadence, L769)');
  assert.equal(w.read().answers[`saveWork-S-1-${N1}`], undefined, 'not answered while it runs');
  assert.ok(w.pending.has(saveKey('S-1')));
  assert.match(w.notes.join('\n'), /the save of S-1 is still on/);
  await w.pass([ask(N2)]);
  assert.deepEqual(runs, ['S-1'], 'never two saves in one copy');
  assert.deepEqual(w.read().answers[`saveWork-S-1-${N2}`], { ok: false, reason: 'a save of S-1 is still running' });
  end({ ok: true }); await new Promise((r) => setImmediate(r));
  await w.pass();
  assert.deepEqual(w.read().answers[`saveWork-S-1-${N1}`], { ok: true }, 'answered by the next pass once it ended');
  assert.equal(w.pending.has(saveKey('S-1')), false, 'and no longer held');
  // A held save that fails is answered with its reason; one that answers within portMs is answered in its own pass.
  w.ports.saveWork = async () => { throw new Error('boom'); };
  const n3 = '00112233445566ff'; await w.pass([ask(n3)]);
  assert.deepEqual(w.read().answers[`saveWork-S-1-${n3}`], { ok: false, reason: 'the save failed (boom)' });
});

test('#463 r1 m1: every save of a pass is started before any is waited for, and all are waited for once', async () => {
  const w = world();
  await w.pass([launchReq('S-1'), launchReq('S-2')]);
  const ev = [];
  w.ports.saveWork = async (s) => { ev.push(`start ${s.id}`); await new Promise((r) => setTimeout(r, 30)); ev.push(`end ${s.id}`); return { ok: true }; };
  const ask = (id, n) => ({ name: `saveWork-${id}-${n}.json`, body: { saveWork: { id }, asked_at: new Date(w.now).toISOString() } });
  const t = Date.now();
  await w.pass([ask('S-1', N1), ask('S-2', N2)]);
  assert.deepEqual(ev.slice(0, 2), ['start S-1', 'start S-2'], 'the second starts before the first is waited for');
  assert.deepEqual(w.read().answers[`saveWork-S-1-${N1}`], { ok: true });
  assert.deepEqual(w.read().answers[`saveWork-S-2-${N2}`], { ok: true }, 'both answered in their own pass');
  assert.ok(Date.now() - t < 1000);
  // Two that outlast the one wait are both held and noted, and both answered by the next pass.
  const ends = [];
  w.ports.saveWork = () => new Promise((r) => ends.push(r));
  const n3 = '00112233445566aa'; const n4 = '00112233445566bb';
  await w.pass([ask('S-1', n3), ask('S-2', n4)]);
  assert.equal(ends.length, 2, 'both started');
  assert.ok(w.pending.has(saveKey('S-1')) && w.pending.has(saveKey('S-2')));
  assert.equal((w.notes.join('\n').match(/is still on; it is answered when it ends/g) ?? []).length, 2);
  for (const e of ends) e({ ok: true });
  await new Promise((r) => setImmediate(r));
  await w.pass();
  assert.deepEqual([w.read().answers[`saveWork-S-1-${n3}`], w.read().answers[`saveWork-S-2-${n4}`]], [{ ok: true }, { ok: true }]);
});

test('#463 r1 m2: a save\'s process group is kept in the memory while it runs, forgotten when it ends, and one left by an earlier run is stopped', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  let end;
  w.ports.saveWork = (s, { onGroup }) => { onGroup({ pgid: 7001, pid: 7001, pid_start: '2026-11-10T12:00:00Z' }); return new Promise((r) => { end = r; }); };
  const ask = (n) => ({ name: `saveWork-S-1-${n}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } });
  await w.pass([ask(N1)]);
  assert.deepEqual(w.kept.at(-1).saves['S-1'], { pgid: 7001, pid: 7001, pid_start: '2026-11-10T12:00:00Z', at: w.now }, 'kept in the memory');
  // Held by this runner: never stopped by a later pass while it runs.
  w.stops.length = 0;
  await w.pass();
  assert.deepEqual(w.stops, []);
  end({ ok: true }); await new Promise((r) => setImmediate(r));
  await w.pass();
  assert.equal(w.kept.at(-1).saves['S-1'], undefined, 'forgotten once it ended');
  // A runner that restarts (no save held) with one in its memory stops that group, through the stop's leader check.
  const z = world();
  z.state = { saves: { 'S-9': { pgid: 7009, pid: 7009, pid_start: '2026-11-10T12:00:00Z', at: T0 } } };
  const asked = [];
  z.ports.stopGroup = async (s) => { asked.push(s); return { ok: true, how: 'SIGTERM' }; };
  await z.pass();
  assert.deepEqual(asked, [{ id: 'S-9', pgid: 7009, pid: 7009, pid_start: '2026-11-10T12:00:00Z' }]);
  assert.equal(z.kept.at(-1).saves['S-9'], undefined, 'forgotten once stopped');
  // One that can't be stopped is told, kept, and tried again next pass.
  const y = world();
  y.state = { saves: { 'S-8': { pgid: 7008, pid: 7008, pid_start: '2026-11-10T12:00:00Z', at: T0 } } };
  y.ports.stopGroup = async () => ({ ok: false, reason: 'the group leader\'s start time can\'t be read' });
  await y.pass();
  assert.ok(y.kept.at(-1).saves['S-8']);
  assert.match(y.notes.join('\n'), /the save of S-8 from an earlier run may still run in process group 7008/);
});

test('#463 r1 m3: a start\'s save settings hash is kept in the session\'s row (never in the status); one in another form is not kept', async () => {
  const base = (x) => ({ ok: true, pid: 4001, pidStart: '2026-11-10T12:01:00Z', pgid: 4001, head: 'a'.repeat(40), outbox: `${ROOT}/p1/worker/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/p1/${x.card}` });
  const w = world({ startAnswer: (x) => ({ ...base(x), saveSettingsSha: 'b'.repeat(64) }) });
  await w.pass([launchReq('S-1')]);
  assert.equal(w.kept.at(-1).sessions[0].save_settings_sha, 'b'.repeat(64));
  assert.equal('save_settings_sha' in w.read().sessions[0], false, 'not in the status');
  const z = world({ startAnswer: (x) => ({ ...base(x), saveSettingsSha: 'B'.repeat(64) }) });
  await z.pass([launchReq('S-1')]);
  assert.equal('save_settings_sha' in z.kept.at(-1).sessions[0], false);
});

test('#463 r1 self-review m1, c2: a save left by an earlier run blocks a new save of that session; a group told after its pass returned is kept by the next pass, not written into the old one', async () => {
  const w = world();
  await w.pass([launchReq('S-1')]);
  const ask = (n) => ({ name: `saveWork-S-1-${n}.json`, body: { saveWork: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } });
  // m1: the earlier run's group can't be stopped yet, so no second job runs in the copy.
  w.state.saves = { 'S-1': { pgid: 7001, pid: 7001, pid_start: '2026-11-10T12:00:00Z', at: T0 } };
  w.ports.stopGroup = async () => ({ ok: false, reason: 'not yet' });
  let ran = 0; w.ports.saveWork = async () => { ran += 1; return { ok: true }; };
  await w.pass([ask(N1)]);
  assert.equal(ran, 0);
  assert.deepEqual(w.read().answers[`saveWork-S-1-${N1}`], { ok: false, reason: 'a save of S-1 from an earlier run may still be running' });
  assert.equal(w.kept.at(-1).saves['S-1'].pgid, 7001, 'still kept, to be stopped');
  // m3: the note of a group that can't be stopped is made once per RUNNER_NOTE_EVERY_MS.
  const told = () => w.notes.filter((t) => /from an earlier run may still run in process group 7001/.test(t)).length;
  const n0 = told(); await w.pass(); assert.equal(told(), n0, 'not again at once');
  w.now += RUNNER_NOTE_EVERY_MS; await w.pass(); assert.equal(told(), n0 + 1);
  // c2: once stopped, a new save runs; its group is told only after the pass returned.
  w.ports.stopGroup = async () => ({ ok: true, how: 'SIGTERM' });
  await w.pass();
  assert.equal(w.kept.at(-1).saves['S-1'], undefined);
  let onG; let end;
  w.ports.saveWork = (s, { onGroup }) => { onG = onGroup; return new Promise((r) => { end = r; }); };
  await w.pass([ask(N2)]);
  const kept = w.kept.length; const writes = w.writes.length;
  onG({ pgid: 7002, pid: 7002, pid_start: '2026-11-10T12:02:00Z' });
  assert.deepEqual([w.kept.length, w.writes.length], [kept, writes], 'nothing written from the old pass');
  await w.pass();
  assert.equal(w.kept.at(-1).saves['S-1'].pgid, 7002, 'kept by the next pass');
  end({ ok: true }); await new Promise((r) => setImmediate(r));
  await w.pass();
  assert.equal(w.kept.at(-1).saves['S-1'], undefined);
  assert.deepEqual(w.read().answers[`saveWork-S-1-${N2}`], { ok: true });
});

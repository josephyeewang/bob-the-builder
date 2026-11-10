// Runner step 3: one pass of the worker runner, on fake ports, read back through the Dispatcher's own readers
// (owner-status.mjs and owner-asks.mjs), so what the runner writes is what the Dispatcher trusts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER_KEEP_USED_UP_MS, ownerSyncPorts, readOwnerStatus } from './owner-status.mjs';
import { ownerAsyncPorts } from './owner-asks.mjs';
import { requestKey, workerRunnerPass } from './worker-runner.mjs';

const OWNER = 501; const ROOT = '/outboxes'; const COPIES = '/copies'; const FILE = '/runner/status.json';
const T0 = Date.parse('2026-11-09T12:00:00Z'); const MIN = 60_000; const CLAIM = 10 * MIN;
const N1 = '0123456789abcdef'; const N2 = 'fedcba9876543210';
const st = ({ dir = false } = {}) => ({ uid: OWNER, mode: dir ? 0o755 : 0o644, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false });

// A runner world: fake processes by pgid, the last status written, and the reads of it the Dispatcher makes.
function world({ startAnswer, stopAnswer, gone = new Set(), drained = () => true } = {}) {
  const w = { now: T0, state: {}, writes: [], notes: [], removed: [], started: [], stops: [], gone, status: null, n: 0 };
  w.ports = {
    start: async (x) => { w.started.push(x.sessionId); if (startAnswer) return startAnswer(x); w.n += 1; const role = x.kind === 'script' ? 'script' : 'worker';
      return { ok: true, pid: 4000 + w.n, pidStart: `start-${w.n}`, pgid: 4000 + w.n, head: 'a'.repeat(40), outbox: `${ROOT}/${role}/${x.sessionId}`, signin: 's', configDir: '/cfg', copy: `${COPIES}/${x.card}` }; },
    groupGone: async (s) => w.gone.has(s.pgid),
    stopGroup: async (s) => { w.stops.push({ id: s.id, flagWritten: w.writes.at(-1)?.sessions.find((x) => x.id === s.id)?.stop_requested === true });
      if (stopAnswer) return stopAnswer(s); w.gone.add(s.pgid); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async () => ({ ok: true }),
    pauseLead: async () => ({ ok: true }),
    outboxDrained: async (s) => drained(s),
  };
  w.pass = async (requests = [], more = {}) => {
    const r = await workerRunnerPass({ state: w.state, requests, now: w.now, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, claimMs: CLAIM, portMs: 50,
      ports: w.ports, write: (d) => { w.writes.push(structuredClone(d)); w.status = d; }, remove: (n) => w.removed.push(n), note: (t) => w.notes.push(t), ...more });
    w.state = r.state; return r;
  };
  const open = () => ({ st: st(), text: JSON.stringify(w.status) });
  w.read = () => readOwnerStatus({ file: FILE, now: w.now, uid: OWNER, outboxRoot: ROOT, realpath: (p) => p, stat: () => st({ dir: true }), open });
  w.sync = (holds = () => true) => ownerSyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, clock: () => w.now, stat: () => st({ dir: true }), open, realpath: (p) => p, holds, writeRequest: (n, t) => w.asked.push({ name: n, body: JSON.parse(t) }) });
  w.asked = [];
  // The Dispatcher's asks, with the runner's pass run between its polls: end to end through the real readers.
  w.asks = () => ownerAsyncPorts({ statusFile: FILE, uid: OWNER, outboxRoot: ROOT, copiesRoot: COPIES, clock: () => w.now, pollMs: 2000, giveUpMs: 20_000, nonce: (() => { let i = 0; return () => [N1, N2][i++]; })(),
    sleep: async (ms) => { const q = w.asked.splice(0); await w.pass(q); w.now += ms; }, stat: () => st({ dir: true }), open, realpath: (p) => p,
    writeRequest: (n, t) => w.asked.push({ name: n, body: JSON.parse(t) }) });
  return w;
}
const launchReq = (sid, more = {}, at = T0) => ({ name: `launch-${sid}.json`, body: { launch: { card: 'C-1', kind: 'editing', product: 'p1', sessionId: sid, ...more }, asked_at: new Date(at).toISOString() } });

test('step 3: a launch asked through owner-asks starts once, is listed, and the ask trusts the answer the runner wrote', async () => {
  const w = world();
  await w.pass();
  const r = await w.asks().launch({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: 'S-1' });
  assert.equal(r.ok, true, r.reason); assert.equal(r.outbox, `${ROOT}/worker/S-1`); assert.equal(r.copy, `${COPIES}/C-1`);
  assert.deepEqual(w.started, ['S-1']);
  const s = w.read();
  assert.deepEqual([s.requests['S-1'].state, s.sessions.map((x) => [x.id, x.alive, x.stop_requested, x.outbox_open])], ['started', [['S-1', true, false, true]]]);
  assert.deepEqual(w.sync().sessions().map((x) => x.id), ['S-1']);
  assert.equal('pid' in s.sessions[0], false, 'the status carries no field of the runner\'s own memory');
  // L767: a script launch's outbox is its own folder, and the ask trusts it.
  const sr = await w.asks().launch({ card: 'C-2', kind: 'script', product: 'p1', sessionId: 'S-2' });
  assert.equal(sr.ok, true, sr.reason); assert.equal(sr.outbox, `${ROOT}/script/S-2`);
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
  // A stopGroup key seen once is not acted on again, even after its answer has gone.
  const k = `stopGroup-S-1-${N2}`;
  await w.pass([{ name: `${k}.json`, body: { stopGroup: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } }]);
  delete w.state.answers[k]; w.gone.delete(4001); const stops = w.stops.length;
  await w.pass([{ name: `${k}.json`, body: { stopGroup: { id: 'S-1' }, asked_at: new Date(w.now).toISOString() } }]);
  assert.equal(w.stops.length, stops);
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
  w.now += RUNNER_KEEP_USED_UP_MS + MIN; await w.pass();
  const s = w.read();
  assert.deepEqual([s.sessions, s.requests], [[], {}], 'gone with its used-up entry once the window has passed');
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

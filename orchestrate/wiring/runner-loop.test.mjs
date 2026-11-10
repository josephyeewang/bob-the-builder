// Part C, runner step 4: the loop around one pass, on real files in a temp folder, and the process-group ports on a
// real process group; what the loop writes is read back through the Dispatcher's own reader (owner-status.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pidStart } from '../modules/M9-record/lock.mjs';
import { RUNNER_STATUS_EVERY_MS, readOwnerStatus } from './owner-status.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_TERM_WAIT_MS, RUNNER_TICK_MS, listRequests, loadMemory, processGroupPorts, runRunner, runnerTick } from './runner-loop.mjs';

const UID = process.getuid();
const T0 = Date.parse('2026-11-10T12:00:00Z');

function world() {
  const d = tempDir('orch-rloop-');
  const w = { d, requestsDir: join(d, 'requests'), statusFile: join(d, 'state', 'status.json'), memoryFile: join(d, 'memory', 'memory.json'), outboxRoot: join(d, 'outboxes'), now: T0, notes: [], n: 0 };
  for (const f of [w.requestsDir, join(d, 'state'), join(d, 'memory'), w.outboxRoot]) mkdirSync(f, { recursive: true });
  w.gone = new Set();
  w.ports = {
    start: async (x) => { w.n += 1; const role = x.kind === 'script' ? 'script' : 'worker';
      return { ok: true, pid: 7000 + w.n, pidStart: 's', pgid: 7000 + w.n, head: 'a'.repeat(40), outbox: join(w.outboxRoot, role, x.sessionId), signin: 's', configDir: '/cfg', copy: `/copies/${x.card}` }; },
    groupGone: async (s) => w.gone.has(s.pgid), stopGroup: async (s) => { w.gone.add(s.pgid); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async () => ({ ok: true }), pauseLead: async () => ({ ok: true }), outboxDrained: async () => true,
  };
  w.ctx = (more = {}) => ({ requestsDir: w.requestsDir, statusFile: w.statusFile, memoryFile: w.memoryFile, orchestrateUid: UID, uid: UID, outboxRoot: w.outboxRoot,
    copiesRoot: '/copies', claimMs: 600_000, ports: w.ports, clock: () => w.now, note: (t) => w.notes.push(t), realpath: (p) => p, ...more });
  w.ask = (name, body) => { const f = join(w.requestsDir, name); writeFileSync(f, JSON.stringify({ ...body, asked_at: new Date(w.now).toISOString() })); chmodSync(f, 0o644); };
  w.read = () => readOwnerStatus({ file: w.statusFile, now: w.now, uid: UID, outboxRoot: w.outboxRoot, realpath: (p) => p });
  return w;
}
const launch = (sid) => [`launch-${sid}.json`, { launch: { card: 'C-1', kind: 'editing', product: 'p1', sessionId: sid } }];

test('step 4: the limits fit inside each other (a tick under the status cadence, a stop inside one port\'s wait)', () => {
  assert.ok(RUNNER_TICK_MS < RUNNER_STATUS_EVERY_MS);
  assert.ok(RUNNER_TERM_WAIT_MS + 1_000 < RUNNER_PORT_MS);
});

test('step 4: a tick reads the requests, removes them, keeps the memory 0o600 and writes a status the Dispatcher reads', async () => {
  const w = world();
  w.ask(...launch('S-1'));
  writeFileSync(join(w.requestsDir, '.launch-S-2.json'), '{}'); // a write in progress (a dot file) is never read
  const state = await runnerTick({ ...w.ctx(), state: {}, pending: new Map() });
  assert.deepEqual(listRequests(w.requestsDir), [], 'the request was removed');
  assert.ok(existsSync(join(w.requestsDir, '.launch-S-2.json')));
  const s = w.read();
  assert.deepEqual([s.requests['S-1'].state, s.sessions.map((x) => x.id)], ['started', ['S-1']]);
  assert.equal(statSync(w.memoryFile).mode & 0o777, 0o600);
  assert.equal(statSync(w.statusFile).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(readFileSync(w.memoryFile, 'utf8')), JSON.parse(JSON.stringify(state)), 'the memory kept is the state returned');
  assert.deepEqual(loadMemory(w.memoryFile, { uid: UID }), JSON.parse(JSON.stringify(state)));
  // A request the reader refuses (writable by others) is removed, not acted on, and noted.
  w.ask(...launch('S-3')); chmodSync(join(w.requestsDir, 'launch-S-3.json'), 0o666);
  await runnerTick({ ...w.ctx(), state, pending: new Map() });
  assert.equal(w.read().requests['S-3'], undefined);
  assert.match(w.notes.join('\n'), /launch-S-3.json was refused unread: the request can be written by others/);
});

test('step 4: requests are taken oldest first; a loop without every port is refused', async () => {
  const w = world();
  w.ask('stop-S-1.json', { stop: 'S-1' });
  w.ask(...launch('S-1'));
  const old = new Date(Date.now() - 60_000); const { utimesSync } = await import('node:fs');
  utimesSync(join(w.requestsDir, 'stop-S-1.json'), old, old);
  assert.deepEqual(listRequests(w.requestsDir), ['stop-S-1.json', 'launch-S-1.json']);
  await runnerTick({ ...w.ctx(), state: {}, pending: new Map() });
  assert.equal(w.read().requests['S-1'].state, 'cancelled', 'the stop came first, so the launch is cancelled');
  const { start, ...noStart } = w.ports;
  await assert.rejects(runnerTick({ ...w.ctx({ ports: noStart }), state: {}, pending: new Map() }), /has no start port/);
});

test('step 4: the memory is loaded once; a missing file is a first run, and a memory that is not the runner\'s own stops it before any tick', async () => {
  const w = world();
  assert.deepEqual(loadMemory(w.memoryFile, { uid: UID }), {});
  writeFileSync(w.memoryFile, '{"requests":{"S-1":{"state":"waiting","at":1}}}'); chmodSync(w.memoryFile, 0o644);
  assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /read or written by others/);
  chmodSync(w.memoryFile, 0o600);
  assert.throws(() => loadMemory(w.memoryFile, { uid: UID + 1 }), /not the owner's/);
  writeFileSync(w.memoryFile, '{not json'); assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /can't be read/);
  let ticks = 0;
  await assert.rejects(runRunner({ ...w.ctx(), stopWhen: () => (ticks += 1) > 1, sleep: async () => {} }), /can't be read/);
  // The loop: a first run is noted, a tick that throws is noted and the next one runs, and stopWhen ends it.
  const v = world(); let n = 0; const slept = [];
  v.ports.outboxDrained = async () => true;
  const state = await runRunner({ ...v.ctx(), stopWhen: () => n >= 2, sleep: async (ms) => { slept.push(ms); n += 1; },
    load: (f, o) => loadMemory(f, o) });
  assert.match(v.notes.join('\n'), /no memory yet: a first run/);
  assert.deepEqual(slept, [RUNNER_TICK_MS, RUNNER_TICK_MS]);
  assert.deepEqual(state.sessions, []);
  const u = world(); let k = 0;
  await runRunner({ ...u.ctx({ ports: { ...u.ports, outboxDrained: undefined } }), stopWhen: () => k >= 1, sleep: async () => { k += 1; } });
  assert.match(u.notes.join('\n'), /a worker runner tick failed \(the worker runner has no outboxDrained port\)/);
});

test('step 4: the process-group ports on a real group: live, stopped with SIGTERM, then gone; a reused leader number counts as gone and is never signalled', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pgid = child.pid;
  try {
    await new Promise((r) => setTimeout(r, 100));
    const s = { id: 'S-1', pgid, pid: pgid, pid_start: pidStart(pgid) };
    assert.ok(s.pid_start);
    const p = processGroupPorts();
    assert.equal(p.groupGone(s), false);
    // The same number under another start time: the runner's group is gone, and a stop sends nothing.
    const sent = [];
    const q = processGroupPorts({ kill: (g, sig) => { sent.push(sig); return process.kill(-g, sig); } });
    assert.equal(q.groupGone({ ...s, pid_start: 'Mon Jan  1 00:00:00 2001' }), true);
    assert.deepEqual(await q.stopGroup({ ...s, pid_start: 'Mon Jan  1 00:00:00 2001' }), { ok: true, how: 'already gone' });
    assert.deepEqual(sent, [], 'a reused number is never signalled');
    const r = await p.stopGroup(s);
    assert.deepEqual(r, { ok: true, how: 'SIGTERM' });
    assert.equal(p.groupGone(s), true);
  } finally { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  // A group that won't go on SIGTERM gets SIGKILL; a signal that fails otherwise is an answer, and a group the port
  // can't tell about throws (so the pass keeps no alive field).
  let alive = true; const sigs = [];
  const z = processGroupPorts({ kill: (g, sig) => { if (sig === 0) { if (!alive) throw Object.assign(new Error('x'), { code: 'ESRCH' }); return; } sigs.push(sig); if (sig === 'SIGKILL') alive = false; },
    probe: { kill: () => {}, pidStart: () => null }, sleep: async () => {}, waitMs: 1000 });
  assert.deepEqual(await z.stopGroup({ pgid: 4242 }), { ok: true, how: 'SIGKILL' });
  assert.deepEqual(sigs, ['SIGTERM', 'SIGKILL']);
  const e = processGroupPorts({ kill: (g, sig) => { if (sig === 0) return; throw Object.assign(new Error('x'), { code: 'EPERM' }); }, probe: { kill: () => {}, pidStart: () => null } });
  assert.deepEqual(await e.stopGroup({ pgid: 4242 }), { ok: false, reason: 'EPERM' });
  const g = processGroupPorts({ kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, probe: { kill: () => {}, pidStart: () => null } });
  assert.equal(g.groupGone({ pgid: 4242 }), false, 'EPERM: the group is there');
  const f = processGroupPorts({ kill: () => { throw Object.assign(new Error('x'), { code: 'EINVAL' }); }, probe: { kill: () => {}, pidStart: () => null } });
  assert.throws(() => f.groupGone({ pgid: 4242 }), /x/);
  assert.throws(() => f.groupGone({ pgid: 1 }), /no process group/);
});

test('step 4: a start still on at the end of a tick is settled by a later tick of the same loop', async () => {
  const w = world(); let go; let n = 0;
  const real = w.ports.start; w.ports.start = (x) => new Promise((resolve) => { go = () => resolve(real(x)); });
  w.ask(...launch('S-1'));
  const state = await runRunner({ ...w.ctx({ portMs: 20 }), stopWhen: () => n >= 2, sleep: async () => { if (n === 0) { assert.equal(w.read().requests['S-1'].state, 'waiting'); go(); await new Promise((r) => setImmediate(r)); } n += 1; } });
  assert.deepEqual([state.requests['S-1'].state, w.read().answers['launch-S-1'].ok], ['started', true]);
});

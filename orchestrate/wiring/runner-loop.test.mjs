// Part C, runner step 4: the loop around one pass, on real files in a temp folder, and the process-group ports on a
// real process group; what the loop writes is read back through the Dispatcher's own reader (owner-status.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { writeStatus } from './runner-files.mjs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { RUNNER_STATUS_EVERY_MS, readOwnerStatus } from './owner-status.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_KILL_WAIT_MS, RUNNER_PS_MS, RUNNER_TERM_WAIT_MS, RUNNER_TICK_MS, leaderStart, listRequests, loadMemory, processGroupPorts, runRunner, runnerTick } from './runner-loop.mjs';

const UID = process.getuid();
const T0 = Date.parse('2026-11-10T12:00:00Z');

const S0 = '2026-11-10T10:00:00Z'; const S1 = '2026-11-10T11:00:00Z';

function world() {
  const d = tempDir('orch-rloop-');
  const w = { d, requestsDir: join(d, 'requests'), statusFile: join(d, 'state', 'status.json'), memoryFile: join(d, 'memory', 'memory.json'), outboxRoot: join(d, 'outboxes'), now: T0, notes: [], n: 0 };
  for (const f of [w.requestsDir, join(d, 'state'), join(d, 'memory'), w.outboxRoot]) mkdirSync(f, { recursive: true });
  w.gone = new Set();
  w.ports = {
    start: async (x) => { w.n += 1; const role = x.kind === 'script' ? 'script' : 'worker';
      return { ok: true, saveSettingsSha: 'a'.repeat(64), pid: 7000 + w.n, pidStart: S0, pgid: 7000 + w.n, head: 'a'.repeat(40), outbox: join(w.outboxRoot, x.product, role, x.sessionId), signin: 's', configDir: '/cfg', copy: `/copies/${x.product}/${x.card}` }; },
    groupGone: async (s) => w.gone.has(s.pgid), stopGroup: async (s) => { w.gone.add(s.pgid); return { ok: true, how: 'SIGTERM' }; },
    saveWork: async () => ({ ok: true }), pauseLead: async () => ({ ok: true }), outboxDrained: async () => true,
  };
  w.ctx = (more = {}) => ({ requestsDir: w.requestsDir, statusFile: w.statusFile, memoryFile: w.memoryFile, orchestrateUid: UID, uid: UID, outboxRoot: w.outboxRoot,
    copiesRoot: '/copies', claimMs: 600_000, ports: w.ports, clock: () => w.now, note: (t) => w.notes.push(t), realpath: (p) => p, ...more });
  w.ask = (name, body) => { const f = join(w.requestsDir, name); writeFileSync(f, JSON.stringify({ ...body, asked_at: new Date(w.now).toISOString() })); chmodSync(f, 0o644); };
  w.read = () => readOwnerStatus({ file: w.statusFile, now: w.now, uid: UID, outboxRoot: w.outboxRoot, realpath: (p) => p });
  return w;
}
const launch = (sid) => [`launch-${sid}.json`, { launch: { card: sid.replace(/^S/, 'C'), kind: 'editing', product: 'p1', sessionId: sid } }];

test('step 4: the limits fit inside each other (a tick under the status cadence, a stop inside one port\'s wait)', () => {
  assert.ok(RUNNER_TICK_MS + RUNNER_PORT_MS < RUNNER_STATUS_EVERY_MS, 'a sleep and one port wait fit between two writes');
  assert.ok(RUNNER_TERM_WAIT_MS + RUNNER_KILL_WAIT_MS + 1_000 < RUNNER_PORT_MS);
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
  writeFileSync(w.memoryFile, '{"requests":{"S-1":{"state":"waiting","at":1}}}');
  // Any group or other bit (#362 r1 m3).
  for (const mode of [0o644, 0o604, 0o640, 0o602]) { chmodSync(w.memoryFile, mode); assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /read or written by others/, mode.toString(8)); }
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
  assert.match(v.notes.join('\n'), /no memory file yet: a first run/);
  assert.deepEqual(slept, [RUNNER_TICK_MS, RUNNER_TICK_MS]);
  assert.deepEqual(state.sessions, []);
  const u = world(); let k = 0;
  await runRunner({ ...u.ctx({ ports: { ...u.ports, outboxDrained: undefined } }), stopWhen: () => k >= 1, sleep: async () => { k += 1; } });
  assert.match(u.notes.join('\n'), /a worker runner tick failed \(the worker runner has no outboxDrained port\)/);
});

test('step 4: the process-group ports on a real group: live, stopped with SIGTERM, then gone; a reused leader number counts as gone and is never signalled', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pgid = child.pid; let start;
  try {
    await new Promise((r) => setTimeout(r, 100));
    const s = { id: 'S-1', pgid, pid: pgid, pid_start: (start = leaderStart(pgid)) };
    assert.ok(s.pid_start);
    const p = processGroupPorts();
    assert.equal(p.groupGone(s), false);
    // The same number under another start time: the runner's group is gone, and a stop sends nothing.
    const sent = [];
    const q = processGroupPorts({ kill: (g, sig) => { sent.push(sig); return process.kill(-g, sig); } });
    assert.equal(q.groupGone({ ...s, pid_start: '2001-01-01T00:00:00Z' }), true);
    assert.deepEqual(await q.stopGroup({ ...s, pid_start: '2001-01-01T00:00:00Z' }), { ok: true, how: 'already gone' });
    assert.deepEqual(sent, [], 'a reused number is never signalled');
    const r = await p.stopGroup(s);
    assert.deepEqual(r, { ok: true, how: 'SIGTERM' });
    assert.equal(p.groupGone(s), true);
  } finally {
    // Only a group not yet shown gone (#362 r1 m6): once gone, its number may be a stranger's.
    let gone = true; try { gone = processGroupPorts().groupGone({ pgid, pid: pgid, pid_start: start }); } catch { gone = false; }
    if (!gone) child.kill('SIGKILL');
  }
  // A group that won't go on SIGTERM gets SIGKILL; a signal that fails otherwise is an answer, and a group the port
  // can't tell about throws (so the pass keeps no alive field).
  const G = { pgid: 4242, pid: 4242, pid_start: S0 };
  let alive = true; const sigs = [];
  const z = processGroupPorts({ kill: (g, sig) => { if (sig === 0) { if (!alive) throw Object.assign(new Error('x'), { code: 'ESRCH' }); return; } sigs.push(sig); if (sig === 'SIGKILL') alive = false; },
    probe: { kill: () => {}, pidStart: () => S0 }, sleep: async () => {}, waitMs: 1000 });
  assert.deepEqual(await z.stopGroup(G), { ok: true, how: 'SIGKILL' });
  assert.deepEqual(sigs, ['SIGTERM', 'SIGKILL']);
  const e = processGroupPorts({ kill: (g, sig) => { if (sig === 0) return; throw Object.assign(new Error('x'), { code: 'EPERM' }); }, probe: { kill: () => {}, pidStart: () => S0 } });
  assert.deepEqual(await e.stopGroup(G), { ok: false, reason: 'EPERM' });
  const g = processGroupPorts({ kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, probe: { kill: () => {}, pidStart: () => S0 } });
  assert.equal(g.groupGone(G), false, 'EPERM: the group is there');
  const f = processGroupPorts({ kill: () => { throw Object.assign(new Error('x'), { code: 'EINVAL' }); }, probe: { kill: () => {}, pidStart: () => S0 } });
  assert.throws(() => f.groupGone(G), /x/);
  assert.throws(() => f.groupGone({ pgid: 1 }), /no process group/);
});

test('step 4: a start still on at the end of a tick is settled by a later tick of the same loop', async () => {
  const w = world(); let go; let n = 0;
  const real = w.ports.start; w.ports.start = (x) => new Promise((resolve) => { go = () => resolve(real(x)); });
  w.ask(...launch('S-1'));
  const state = await runRunner({ ...w.ctx({ portMs: 20 }), stopWhen: () => n >= 2, sleep: async () => { if (n === 0) { assert.equal(w.read().requests['S-1'].state, 'waiting'); go(); await new Promise((r) => setImmediate(r)); } n += 1; } });
  assert.deepEqual([state.requests['S-1'].state, w.read().answers['launch-S-1'].ok], ['started', true]);
});

test('step-4 review M2, M3, m2: a group whose leader start can\'t be read, or that has no leader start, is "can\'t tell" and never signalled; after SIGKILL the stop waits for the group to go', async () => {
  const G = { pgid: 4242, pid: 4242, pid_start: S0 }; const sent = [];
  const kill = (g, sig) => { sent.push(sig); };
  const noPs = processGroupPorts({ kill, probe: { kill: () => {}, pidStart: () => null } });
  assert.throws(() => noPs.groupGone(G), /start time can't be read/);
  await assert.rejects(noPs.stopGroup(G), /start time can't be read/);
  assert.deepEqual(sent.filter((x) => x !== 0), [], 'no stop signal sent');
  const noStart = processGroupPorts({ kill, probe: { kill: () => {}, pidStart: () => S0 } });
  sent.length = 0;
  for (const s of [{ pgid: 4242, pid: 4242 }, { pgid: 4242, pid: 4243, pid_start: S0 }]) assert.throws(() => noStart.groupGone(s), /no group leader start time/);
  assert.deepEqual(sent, [], 'nothing sent, not even signal 0');
  // The leader gone (ESRCH) with the rest of its group still there: live.
  const members = processGroupPorts({ kill: () => {}, probe: { kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, pidStart: () => null } });
  assert.equal(members.groupGone(G), false);
  // After SIGKILL the group takes a moment to go: the stop waits (up to RUNNER_KILL_WAIT_MS), so its answer is not a false failure.
  let zero = 0; let killed = false; const slept = [];
  const slow = processGroupPorts({ kill: (g, sig) => { if (sig === 'SIGKILL') killed = true; if (sig === 0 && killed && (zero += 1) > 3) throw Object.assign(new Error('x'), { code: 'ESRCH' }); },
    probe: { kill: () => {}, pidStart: () => S0 }, sleep: async (ms) => { slept.push(ms); }, waitMs: 500 });
  assert.deepEqual(await slow.stopGroup(G), { ok: true, how: 'SIGKILL' });
  assert.equal(slow.groupGone(G), true);
  const waits = slept.filter((x) => x === 100).length;
  assert.ok(waits >= 3 && waits <= RUNNER_KILL_WAIT_MS / 100, String(waits));
});

test('step-4 review M1, M5: a tick that fails after keeping memory leaves the loop on that memory; a listing that fails still writes the status', async () => {
  const w = world(); let n = 0; let failStatus = true;
  w.ask(...launch('S-1'));
  // The status write fails once the session is started: its memory was kept just before.
  const files = { write: (f, text, mode) => { if (f === w.statusFile && failStatus && JSON.parse(text).requests['S-1']?.state === 'started') throw new Error('ENOSPC'); writeStatus(f, text, { mode }); } };
  const state = await runRunner({ ...w.ctx({ files }), stopWhen: () => n >= 2, sleep: async () => {
    if (n === 0) { failStatus = false; w.ask('stop-S-1.json', { stop: 'S-1' }); } n += 1; } });
  assert.match(w.notes.join('\n'), /tick failed \(ENOSPC\)/);
  // The launch kept before the failure is remembered: the stop stops the session, never cancels a launch it can't see.
  assert.notEqual(state.requests['S-1'].state, 'cancelled');
  assert.deepEqual(state.sessions.map((x) => [x.id, x.stop_requested]), [['S-1', true]]);
  assert.ok(w.gone.has(7001), 'the group was stopped');
  // M5: the requests folder gone: noted, and the status still written.
  const v = world(); rmSync(v.requestsDir, { recursive: true });
  await runnerTick({ ...v.ctx(), state: {}, pending: new Map() });
  assert.match(v.notes.join('\n'), /requests can't be listed \(ENOENT\)/);
  assert.deepEqual(v.read().sessions, []);
});

test('step-4 review m3, m4: a memory that is a link, has two names or the wrong shape is refused', () => {
  const w = world();
  writeFileSync(join(w.d, 'real.json'), '{}'); chmodSync(join(w.d, 'real.json'), 0o600);
  symlinkSync(join(w.d, 'real.json'), w.memoryFile);
  assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /is a link/);
  rmSync(w.memoryFile); linkSync(join(w.d, 'real.json'), w.memoryFile);
  assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /more than one name/);
  rmSync(w.memoryFile);
  assert.throws(() => loadMemory('memory.json', { uid: UID }), /not a full path/, '#362 r1 c3');
  for (const bad of ['{"sessions":{}}', '{"requests":[]}', '{"answers":null}', '{"seen":[1]}', '[]', '{"sessions":[null]}', '{"requests":{"S-1":null}}', '{"saves":[]}', '{"saves":{"S-1":7}}', '{"saves":{"S-1":{"pgid":1,"pid":1,"pid_start":"x","at":1}}}', '{"saves":{"S-1":{"pgid":70,"pid":71,"pid_start":"x","at":1}}}', '{"saves":{"S-1":{"pgid":70,"pid":70,"at":1}}}', '{"saves":{"S-1":{"pgid":70,"pid":70,"pid_start":"x","at":1,"job":{"pgid":71,"pid":72,"pid_start":"y"}}}}', '{"saves":{"S-1":{"pgid":70,"pid":70,"pid_start":"x","at":1,"job":7}}}']) {
    writeFileSync(w.memoryFile, bad); chmodSync(w.memoryFile, 0o600);
    assert.throws(() => loadMemory(w.memoryFile, { uid: UID }), /not what the runner writes/, bad);
    rmSync(w.memoryFile);
  }
});

test('#362 r1 M2: the leader\'s start time is read in UTC, so a time zone change never makes a live group read as gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const old = process.env.TZ;
  try {
    await new Promise((r) => setTimeout(r, 200));
    process.env.TZ = 'Asia/Seoul';
    const s = { id: 'S-1', pgid: child.pid, pid: child.pid, pid_start: leaderStart(child.pid) };
    assert.ok(s.pid_start);
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(leaderStart(child.pid), s.pid_start, 'the same string whatever the zone');
    // A start recorded before L850 X1, as real ps printed it in UTC: the same live group.
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' } }).trim();
    assert.equal(processGroupPorts().groupGone({ ...s, pid_start: raw }), false, 'an old raw value of a live group');
    const sent = [];
    const p = processGroupPorts({ kill: (g, sig) => { sent.push(sig); return process.kill(-g, sig); } });
    assert.equal(p.groupGone(s), false, 'a live group the runner started is not gone');
    assert.deepEqual(sent, [0]);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; child.kill('SIGKILL'); }
  // ps is given the UTC zone, the C locale and RUNNER_PS_MS; a failing ps is null, never a guess.
  let got; assert.equal(leaderStart(4242, { run: (bin, args, o) => { got = { bin, args, o }; return 'Tue Nov 10 10:00:00 2026\n'; } }), '2026-11-10T10:00:00Z', 'M9 startTime: UTC ISO (L850)');
  assert.deepEqual([got.bin, got.args, got.o.env.TZ, got.o.env.LC_ALL, got.o.timeout], ['ps', ['-o', 'lstart=', '-p', '4242'], 'UTC0', 'C', RUNNER_PS_MS]);
  assert.equal(leaderStart(4242, { run: () => { throw new Error('ETIMEDOUT'); } }), null);
  assert.equal(leaderStart(1), null);
  assert.equal(leaderStart(4242, { run: () => 'not a time\n' }), null, 'text in no shape is null');
});

test('#394 r1 m1: the leader is checked again just before SIGKILL: one reused in the SIGTERM wait gets nothing, one that can\'t be told about is not signalled', async () => {
  const G = { pgid: 4242, pid: 4242, pid_start: S0 };
  const run = async (laterStart) => {
    const sent = []; let reads = 0;
    const p = processGroupPorts({ kill: (g, sig) => { if (sig !== 0) sent.push(sig); }, probe: { kill: () => {}, pidStart: () => (reads++ === 0 ? S0 : laterStart) }, sleep: async () => {}, waitMs: 1000 });
    let r; try { r = await p.stopGroup(G); } catch (e) { r = { threw: e.message }; }
    return { r, sent };
  };
  assert.deepEqual(await run(S1), { r: { ok: true, how: 'already gone' }, sent: ['SIGTERM'] }, 'a new leader on the number: no SIGKILL');
  const t = await run(null);
  assert.deepEqual(t.sent, ['SIGTERM'], 'can\'t tell: no SIGKILL');
  assert.equal(t.r.ok, false); assert.match(t.r.reason, /start time can't be read/);
  const same = await run(S0);
  assert.deepEqual(same.sent, ['SIGTERM', 'SIGKILL'], 'the same leader still there: SIGKILL');
});

test('L850 X1: groupGone compares start times with M9 startDiffers: an old raw value, a new one, a different one, a null read', () => {
  const sent = [];
  const at = (now, there = true) => processGroupPorts({ kill: (g, sig) => { sent.push(sig); if (!there) throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, probe: { kill: () => {}, pidStart: () => now } });
  const G = { pgid: 4242, pid: 4242, pid_start: S0 };
  // The same start: the runner's group, alive.
  assert.equal(at(S0).groupGone(G), false, 'a new value, the same');
  // A start recorded before L850 X1 (ps's UTC lstart text) is the same instant, not another start: alive.
  assert.equal(at(S0).groupGone({ ...G, pid_start: 'Tue Nov 10 10:00:00 2026' }), false, 'an old raw value of the same start');
  assert.equal(at(S0).groupGone({ ...G, pid_start: 'Tue Nov 10 09:00:00 2026' }), true, 'an old raw value of another start: reused');
  // Another start: the number was used again, the runner's group is gone.
  assert.equal(at(S1).groupGone(G), true, 'a different new value');
  // A read that fails is not another start: there, it can't be told (never signalled); gone by signal 0, gone.
  sent.length = 0;
  assert.throws(() => at(null).groupGone(G), /start time can't be read/);
  assert.deepEqual(sent, [0], 'only signal 0');
  assert.equal(at(null, false).groupGone(G), true);
  assert.throws(() => at('Tue Nov 10 10:00:00 2026').groupGone(G), /start time can't be read/, 'a read in the old shape is not compared');
  // An old raw value of a single-digit day (ps pads it with a space), and one whose leader has gone with the rest still there.
  assert.equal(at('2026-11-03T10:00:00Z').groupGone({ ...G, pid_start: 'Tue Nov  3 10:00:00 2026' }), false, 'a padded day');
  const leaderGone = processGroupPorts({ kill: () => {}, probe: { kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, pidStart: () => null } });
  assert.equal(leaderGone.groupGone({ ...G, pid_start: 'Tue Nov 10 10:00:00 2026' }), false, 'an old raw value, the leader gone, members there');
  // A recorded value in no shape can't be compared: only signal 0 is sent; there, can't tell; gone, gone.
  sent.length = 0;
  assert.throws(() => at(S0).groupGone({ ...G, pid_start: 'x' }), /no shape it can be compared in/);
  assert.deepEqual(sent, [0], 'only signal 0');
  assert.equal(at(S0, false).groupGone({ ...G, pid_start: 'x' }), true, 'no shape, the group gone');
});

test('#362 r1 m1, m4, c2: the stop\'s ps fits its budget; a leader another user holds is still checked by its start time; a cadence past the bound is refused', async () => {
  assert.ok(RUNNER_PS_MS + RUNNER_TERM_WAIT_MS + RUNNER_KILL_WAIT_MS < RUNNER_PORT_MS);
  // The leader answers "not yours to signal": it is there, so its start time decides.
  const notOurs = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  const sent = [];
  const p = processGroupPorts({ kill: (g, sig) => { sent.push(sig); }, probe: { kill: notOurs, pidStart: () => S1 } });
  assert.equal(p.groupGone({ pgid: 4242, pid: 4242, pid_start: S0 }), true, 'a reused number held by another user');
  assert.deepEqual(await p.stopGroup({ pgid: 4242, pid: 4242, pid_start: S0 }), { ok: true, how: 'already gone' });
  assert.deepEqual(sent, [], 'and it is never signalled');
  const w = world();
  await assert.rejects(runRunner({ ...w.ctx(), everyMs: RUNNER_STATUS_EVERY_MS - RUNNER_PORT_MS, stopWhen: () => true }), /tick must leave a port wait/);
});

test('#362 r1 M1 (its probe A): a memory write that fails just after a start settled leaves the session listed, and a later stop reaches it', async () => {
  const w = world(); let n = 0; let failed = false; const stops = [];
  w.ports.stopGroup = async (s) => { stops.push(s.pgid); w.gone.add(s.pgid); return { ok: true, how: 'SIGTERM' }; };
  w.ask(...launch('S-1'));
  const files = { write: (f, text, mode) => {
    if (f === w.memoryFile && !failed && JSON.parse(text).requests?.['S-1']?.state === 'started') { failed = true; throw new Error('EIO'); }
    writeStatus(f, text, { mode });
  } };
  const state = await runRunner({ ...w.ctx({ files }), stopWhen: () => n >= 3, sleep: async () => { if (n === 1) w.ask('stop-S-1.json', { stop: 'S-1' }); n += 1; } });
  assert.ok(failed);
  assert.deepEqual([state.sessions.map((s) => s.id), stops, w.n], [['S-1'], [7001], 1]);
});

test('#358 r1 M1 through the loop: each write carries the clock at that write', async () => {
  const w = world(); w.ask(...launch('S-1')); w.ask(...launch('S-2'));
  const at = []; let t = T0;
  const files = { write: (f, text, mode) => { if (f === w.statusFile) at.push(JSON.parse(text).written_at); writeStatus(f, text, { mode }); } };
  await runnerTick({ ...w.ctx({ files, clock: () => (t += 1000) }), state: {}, pending: new Map() });
  assert.equal(new Set(at).size, at.length, at.join(' '));
  // With no clock given, the tick's own (the real time) reaches each write: hung ports space the writes out.
  const v = world(); v.now = Date.now(); v.ask(...launch('S-1')); v.ask(...launch('S-2'));
  const st = await runnerTick({ ...v.ctx(), clock: undefined, state: {}, pending: new Map() });
  const vat = []; v.ports.groupGone = () => new Promise(() => {});
  const vfiles = { write: (f, text, mode) => { if (f === v.statusFile) vat.push(Date.parse(JSON.parse(text).written_at)); writeStatus(f, text, { mode }); } };
  await runnerTick({ ...v.ctx({ files: vfiles, portMs: 30 }), clock: undefined, state: st, pending: new Map() });
  // At least one hung port's wait (portMs 30) lies between the first and last stamps. The ports may wait side by side, so
  // don't count on two waits in a row (CI saw 42 ms; L855).
  assert.ok(vat.at(-1) - vat[0] >= 25, `the stamps move with the clock: ${vat}`);
});

test('#364 self-review M1: a start still on when the stop comes is waited for and settled by a last tick that reads no request', async () => {
  const w = world(); let n = 0; let release;
  w.ports.start = (x) => new Promise((r) => { release = () => r({ ok: true, saveSettingsSha: 'a'.repeat(64), pid: 7001, pidStart: S0, pgid: 7001, head: 'a'.repeat(40), outbox: join(w.outboxRoot, x.product, 'worker', x.sessionId), signin: 's', configDir: '/cfg', copy: `/copies/${x.product}/${x.card}` }); });
  w.ask(...launch('S-1'));
  const state = await runRunner({ ...w.ctx({ portMs: 30 }), stopWhen: () => n >= 1, sleep: async () => { w.ask(...launch('S-2')); setTimeout(() => release(), 50); n += 1; } });
  assert.deepEqual(state.sessions.map((s) => s.id), ['S-1']);
  assert.deepEqual(loadMemory(w.memoryFile, { uid: UID }).sessions.map((s) => s.id), ['S-1'], 'the memory the next runner reads lists it');
  assert.ok(existsSync(join(w.requestsDir, 'launch-S-2.json')), 'the last tick reads no request');
  // One that does not end in time is noted, and stays waiting.
  const v = world(); let m = 0;
  v.ports.start = () => new Promise(() => {});
  v.ask(...launch('S-1'));
  const st = await runRunner({ ...v.ctx({ portMs: 30 }), drainMs: 30, stopWhen: () => m >= 1, sleep: async () => { m += 1; } });
  assert.equal(st.requests['S-1'].state, 'waiting');
  assert.ok(v.notes.some((t) => /still on when the worker runner stopped/.test(t)), v.notes.join('\n'));
});

test('#463 r1 m2: a save still on when the runner stops has its kept process group stopped, and is told truly (not answered, told as not saved)', async () => {
  const w = world(); let n = 0;
  w.ask(...launch('S-1'));
  // The first tick starts S-1; the save is asked during the sleep and never ends.
  // #463 r2 M1: claude's group and the job's own, both stopped.
  // Self-review m3: the job's group is told only while claude's is being stopped: it is read again and stopped too.
  let late;
  w.ports.saveWork = (s, { onGroup }) => { onGroup({ pgid: 7101, pid: 7101, pid_start: S0 }); late = () => onGroup({ pgid: 7101, pid: 7101, pid_start: S0, job: { pgid: 7102, pid: 7102, pid_start: S0 } }); return new Promise(() => {}); };
  const stopped = [];
  w.ports.stopGroup = async (s) => { stopped.push(s); if (s.pgid === 7101) late(); return { ok: true, how: 'SIGTERM' }; };
  const state = await runRunner({ ...w.ctx({ portMs: 30 }), drainMs: 30, stopWhen: () => n >= 2,
    sleep: async () => { if (n === 0) w.ask('saveWork-S-1-0123456789abcdef.json', { saveWork: { id: 'S-1' } }); n += 1; } });
  assert.deepEqual(stopped.map((s) => [s.id, s.pgid, s.pid, s.pid_start]), [['S-1', 7101, 7101, S0], ['S-1', 7102, 7102, S0]]);
  const told = w.notes.find((t) => /the save of S-1 was still on when the worker runner stopped/.test(t));
  assert.match(told, /its process groups are stopped\. It is not answered, so the Dispatcher's wait for it runs out and the work is told as not saved/);
  assert.equal(/asks again/.test(w.notes.join('\n')), false, 'never the old claim');
  assert.ok(state.saves['S-1'], 'kept until the next runner sees it gone');
});

// #463 r2 plant 'SR M-2 loop gives no keeper': the loop hands every tick the one saveHolder, so a save's job group told
// after its pass returned (between ticks) is in the memory file at once, before its go-ahead, not only at the last tick.
test('#463 r2 self-review M-2: the loop\'s ticks keep a job group told between ticks in the memory at once', async () => {
  const w = world(); let n = 0; let late; let kept = null;
  w.ask(...launch('S-1'));
  w.ports.saveWork = (s, { onGroup }) => { onGroup({ pgid: 7101, pid: 7101, pid_start: S0 }); late = () => onGroup({ pgid: 7101, pid: 7101, pid_start: S0, job: { pgid: 7102, pid: 7102, pid_start: S0 } }); return new Promise(() => {}); };
  await runRunner({ ...w.ctx({ portMs: 30 }), drainMs: 30, stopWhen: () => n >= 3, sleep: async () => {
    if (n === 0) w.ask('saveWork-S-1-0123456789abcdef.json', { saveWork: { id: 'S-1' } });
    if (n === 1) { late(); kept = loadMemory(w.memoryFile, { uid: UID }); }   // the save's pass has returned; no tick runs now
    n += 1;
  } });
  assert.ok(late, 'the save was asked and started');
  assert.deepEqual(kept?.saves?.['S-1']?.job, { pgid: 7102, pid: 7102, pid_start: S0 }, JSON.stringify(kept?.saves ?? null));
});

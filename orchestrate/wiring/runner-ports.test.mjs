// Part C, runner step 5: the worker runner's real ports. The start runs on fakes for what other lanes still owe (the
// worker checks, the prompt) and on real files for what it makes; spawnLeader runs a real process group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { launch } from '../modules/M4-workshop/launcher/launch.mjs';
import { drainedPort, pauseLeadPort, projectFolderName, saveWorkPort, sizePort, spawnLeader, startPort, transcriptPath } from './runner-ports.mjs';

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HEAD = 'b'.repeat(40);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };

test('step 5: size reads the session\'s conversation file and its last write; a missing or linked file is a throw', () => {
  const d = tempDir('orch-rports-');
  try {
    const s = { id: SID, config_dir: join(d, 'cfg'), copy: '/copies/C-1' };
    assert.equal(projectFolderName('/copies/C-1'), '-copies-C-1');
    assert.equal(projectFolderName('/copies/a.b_c d'), '-copies-a-b-c-d', 'every character but a letter or digit');
    const f = transcriptPath({ configDir: s.config_dir, copy: s.copy, sessionId: SID });
    assert.equal(f, join(d, 'cfg', 'projects', '-copies-C-1', `${SID}.jsonl`));
    const size = sizePort();
    assert.throws(() => size(s), /ENOENT/);
    mkdirSync(join(d, 'cfg', 'projects', '-copies-C-1'), { recursive: true });
    const line = { type: 'assistant', timestamp: '2026-11-10T12:00:00Z', message: { stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 5 }, content: [] } };
    writeFileSync(f, `${JSON.stringify(line)}\n`);
    const z = size(s);
    assert.equal(z.size.tokens, 15); assert.equal(z.size.turnEnded, true); assert.equal(z.lastWriteAt, statSync(f).mtimeMs);
    assert.equal('activity' in z, false, 'no activity state is made up: the tracker is not fed in the runner');
    rmSync(f); writeFileSync(join(d, 'other'), `${JSON.stringify(line)}\n`); symlinkSync(join(d, 'other'), f);
    assert.throws(() => size(s), /not a plain file/);
    assert.throws(() => sizePort({ read: () => null })({ ...s, id: SID }), /not a plain file|can't be read/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5: an outbox is drained only when nothing is in it (a dot file counts) or it is gone; one that can\'t be read is not', () => {
  const d = tempDir('orch-rports-');
  try {
    const o = join(d, 'worker', SID); mkdirSync(o, { recursive: true });
    const drained = drainedPort();
    assert.equal(drained({ outbox: o }), true);
    writeFileSync(join(o, '.half'), 'x');
    assert.equal(drained({ outbox: o }), false);
    rmSync(o, { recursive: true });
    assert.equal(drained({ outbox: o }), true, 'gone: nothing left to take');
    assert.equal(drainedPort({ list: () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } })({ outbox: o }), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5: save-work refuses without the lock-down runner, and the pause is not wired', async () => {
  const s = { product: 'p1', copy: '/copies/C-1', card: 'C-1', outbox: `/o/worker/${SID}` };
  assert.match((await saveWorkPort({ mirrorOf: () => '/m' })(s)).reason, /only inside the worker's lock-down/);
  assert.match((await saveWorkPort({ mirrorOf: () => null })(s)).reason, /no mirror/);
  const seen = [];
  await saveWorkPort({ mirrorOf: () => '/m', make: () => async (x) => { seen.push(x); return { ok: true }; } })(s);
  assert.deepEqual(seen, [{ clone: '/copies/C-1', mirror: '/m', card: 'C-1', branch: 'card/c-1', outbox: `/o/worker/${SID}` }]);
  const p = await pauseLeadPort()({ product: 'p1' });
  assert.equal(p.ok, false); assert.match(p.reason, /^not wired: /);
});

test('step 5: spawnLeader starts its own process group with a start time; one whose start time can\'t be read is killed', async () => {
  const a = await spawnLeader({ spawn, bin: '/bin/sleep', args: ['30'], cwd: '/', env: { PATH: '/usr/bin:/bin' } });
  try {
    assert.equal(a.ok, true, a.reason);
    assert.equal(a.pgid, a.pid);
    const pg = Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(a.pid)]).stdout.toString().trim());
    assert.equal(pg, a.pid, 'claude leads its own group');
    assert.equal(typeof a.pidStart, 'string'); assert.ok(a.pidStart);
  } finally { try { process.kill(-a.pid, 'SIGKILL'); } catch { /* gone */ } }
  let child;
  const b = await spawnLeader({ spawn: (...x) => (child = spawn(...x)), bin: '/bin/sleep', args: ['30'], cwd: '/', env: { PATH: '/usr/bin:/bin' }, pidStartOf: () => null });
  assert.equal(b.ok, false); assert.match(b.reason, /start time could not be read, so its group was killed/);
  assert.ok(await until(() => !alive(child.pid)), 'the group is gone');
  const c = await spawnLeader({ spawn, bin: '/nonexistent/claude', args: [], cwd: '/', env: {} });
  assert.equal(c.ok, false);
});

// The start's world: real folders, fakes for the Record, the copy and the launch.
function world(over = {}) {
  const d = tempDir('orch-rports-');
  const w = { d, copiesRoot: join(d, 'copies'), outboxRoot: join(d, 'outboxes'), settingsDir: join(d, 'runner', 'settings'), calls: [] };
  for (const f of [w.copiesRoot, join(w.outboxRoot, 'worker'), join(w.outboxRoot, 'script'), w.settingsDir]) mkdirSync(f, { recursive: true });
  mkdirSync(join(w.copiesRoot, 'C-9'));
  w.c = { copiesRoot: w.copiesRoot, outboxRoot: w.outboxRoot, settingsDir: w.settingsDir, home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: '/bin/sleep',
    workerRunner: { requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json') },
    products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { hooksDir: '/h', deny: { secrets: ['/s'] } }, product: { hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/prop'] } } } };
  w.card = { state: 'claimed', claim: { session_id: SID }, product: 'p1' };
  w.deps = {
    readCard: () => ({ ok: true, doc: w.card }),
    startCommit: async () => HEAD,
    prepare: async (x) => { w.calls.push(['prepare', x]); mkdirSync(x.dest); return { ok: true, dest: x.dest, head: HEAD }; },
    promptFor: () => 'do the card',
    account: () => ({ account: 'a', dir: join(d, 'home', '.claude'), env: {} }),
    walled: (x) => { w.calls.push(['walled', x]); return { ok: true, role: 'worker', settings: { s: 1 } }; },
    launchFn: async (x) => { w.calls.push(['launch', x]); return { ok: true, started: await x.start() }; },
    spawn: (bin, args, o) => { w.calls.push(['spawn', bin, args, o]); return { pid: 4242, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }; },
    pidStartOf: () => 'Tue Nov 10 12:00:00 2026',
    ...over,
  };
  w.start = (x = {}) => startPort(w.c, w.deps)({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: SID, ...x });
  w.left = () => ({ copy: existsSync(join(w.copiesRoot, 'C-1')), outbox: existsSync(join(w.outboxRoot, 'worker', SID)), settings: existsSync(join(w.settingsDir, `${SID}.json`)) });
  return w;
}

test('step 5: a start makes the copy, the outbox and the walled settings, and answers what the status lists', async () => {
  const w = world();
  try {
    const a = await w.start();
    assert.deepEqual(a, { ok: true, pid: 4242, pgid: 4242, pidStart: 'Tue Nov 10 12:00:00 2026', head: HEAD, outbox: join(w.outboxRoot, 'worker', SID),
      signin: 'a', configDir: join(w.d, 'home', '.claude'), copy: join(w.copiesRoot, 'C-1') });
    const prep = w.calls.find((c) => c[0] === 'prepare')[1];
    assert.deepEqual(prep.card, { id: 'C-1', repo: 'o/p1', commit: HEAD, branch: 'card/c-1' });
    const wl = w.calls.find((c) => c[0] === 'walled')[1];
    assert.equal(wl.kind, 'editing'); assert.deepEqual(wl.workerRunner, w.c.workerRunner);
    assert.equal(wl.paths.copy, join(w.copiesRoot, 'C-1')); assert.equal(wl.paths.outbox, join(w.outboxRoot, 'worker', SID));
    assert.deepEqual(wl.paths.deny, { secrets: ['/s'], otherCopies: [join(w.copiesRoot, 'C-9')] }, 'every other card\'s copy is denied');
    const f = join(w.settingsDir, `${SID}.json`);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { s: 1 });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.outboxRoot, 'worker', SID)).mode & 0o077, 0);
    const sp = w.calls.find((c) => c[0] === 'spawn');
    assert.equal(sp[1], '/bin/sleep'); assert.equal(sp[3].cwd, join(w.copiesRoot, 'C-1')); assert.equal(sp[3].detached, true);
    assert.ok(sp[2].includes(f) && sp[2].includes(SID) && sp[2].at(-1) === 'do the card');
    assert.equal(sp[3].env.HOME, w.c.home); assert.equal(sp[3].env.PATH, '/usr/bin:/bin');
    // A second start for the same card is refused, and leaves the first one's copy alone.
    const b = await startPort(w.c, { ...w.deps, prepare: (x) => import('../modules/M4-workshop/launcher/worker-copy.mjs').then((m) => m.prepareWorkerCopy(x)) })({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: SID.replace('0f', '1f') });
    assert.equal(b.ok, false);
    assert.equal(w.left().copy, true);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('step 5: a script card gets the script outbox', async () => {
  const w = world();
  try {
    const a = await w.start({ kind: 'script' });
    assert.equal(a.ok, true, a.reason); assert.equal(a.outbox, join(w.outboxRoot, 'script', SID));
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('step 5: a start refused before the copy makes nothing; one refused after it removes what it made', async () => {
  const cases = [
    ['a card claimed by another session', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: 'x' } } }) }, /not claimed for this session/],
    ['a card not in the Record', { readCard: () => ({ ok: false, reason: 'no such card' }) }, /no such card/],
    ['another product\'s card', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: SID }, product: 'p2' } }) }, /another product's/],
    ['no prompt', { promptFor: () => null }, /^not wired: no worker prompt/],
    ['no sign-in', { account: () => ({ account: null, reason: 'not set up' }) }, /not set up/],
    ['no start commit', { startCommit: async () => { throw new Error('no main'); } }, /no main/],
    ['a copy that can\'t be made', { prepare: async () => ({ ok: false, reason: 'copy folder already exists' }) }, /already exists/],
  ];
  for (const [what, over, re] of cases) {
    const w = world(over);
    try {
      const a = await w.start();
      assert.equal(a.ok, false, what); assert.match(a.reason, re, what);
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, what);
      assert.equal(w.calls.some((c) => c[0] === 'spawn'), false, what);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
  for (const [what, x] of [['an unknown kind', { kind: 'review' }], ['a bad session id', { sessionId: 'S-1' }], ['a bad card', { card: '../x' }], ['an unknown product', { product: 'p9' }]]) {
    const w = world();
    try { const a = await w.start(x); assert.equal(a.ok, false, what); assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, what); } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
  const after = [
    ['not walled', { walled: () => ({ ok: false, reason: 'not walled: x' }) }, /^not walled: x/],
    ['a launch check refusing', { launchFn: async () => ({ ok: false, reason: 'launch check 3 (outbox emptied): busy' }) }, /launch check 3/],
    ['a launch that throws', { launchFn: async () => { throw new Error('boom'); } }, /boom/],
    ['claude not spawned', { spawn: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }, /could not be spawned/],
    ['no start time', { pidStartOf: () => null, kill: () => {} }, /start time could not be read/],
  ];
  for (const [what, over, re] of after) {
    const w = world(over);
    try {
      const a = await w.start();
      assert.equal(a.ok, false, what); assert.match(a.reason, re, what);
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false }, `${what}: what the start made is removed`);
      assert.ok(existsSync(join(w.copiesRoot, 'C-9')), `${what}: another card's copy is left alone`);
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
});

test('step 5: with M4\'s own launch() and no worker checks given, nothing starts and nothing is left', async () => {
  const w = world({ launchFn: launch, walled: () => ({ ok: true, role: 'worker', settings: {} }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /launch check|not confirmed|not locked down/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('step 5: a real start\'s group is gone once killed (the leader the answer names is the group)', async () => {
  const w = world();
  delete w.deps.pidStartOf;
  w.deps.spawn = spawn;
  // A stand-in claude that takes any arguments and waits.
  const bin = join(w.d, 'claude'); writeFileSync(bin, '#!/bin/sh\nexec /bin/sleep 30\n'); chmodSync(bin, 0o755);
  w.c.claudeBin = bin;
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    assert.ok(alive(a.pid));
    process.kill(-a.pgid, 'SIGKILL');
    assert.ok(await until(() => !alive(a.pid)));
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

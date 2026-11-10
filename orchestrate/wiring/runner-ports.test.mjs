// Part C, runner step 5: the worker runner's real ports. The start runs on fakes for what other lanes still owe (the
// worker checks, the prompt) and on real files for what it makes; spawnLeader runs a real process group.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { gitOk, initMirror } from '../modules/M4-workshop/git/safe-git.mjs';
import { launch } from '../modules/M4-workshop/launcher/launch.mjs';
import { cardStartCommit, drainedPort, groupThere, pauseLeadPort, projectFolderName, saveWorkPort, sizePort, spawnLeader, startPort, transcriptPath } from './runner-ports.mjs';
import { walledLaunchSettings } from './runner-launch.mjs';
import { leaderStart } from './runner-loop.mjs';
import { FLAGS, namesIn } from '../modules/M4-workshop/launcher/settings-names.mjs';
import { sessionArgs } from '../modules/M4-workshop/launcher/review-launch.mjs';

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
    assert.equal(a.pidStart, leaderStart(a.pid), 'read by the runner\'s one reader, the one the stop checks against');
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
    mainOf: async () => 'c'.repeat(40),
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
    assert.deepEqual(a, { ok: true, pid: 4242, pgid: 4242, pidStart: 'Tue Nov 10 12:00:00 2026', head: HEAD, base: HEAD, outbox: join(w.outboxRoot, 'worker', SID),
      signin: 'a', configDir: join(w.d, 'home', '.claude'), copy: join(w.copiesRoot, 'C-1') });
    const prep = w.calls.find((c) => c[0] === 'prepare')[1];
    assert.deepEqual(prep.card, { id: 'C-1', repo: 'o/p1', commit: HEAD, branch: 'card/c-1' });
    const wl = w.calls.find((c) => c[0] === 'walled')[1];
    assert.equal(wl.kind, 'editing'); assert.deepEqual(wl.workerRunner, w.c.workerRunner);
    assert.equal(wl.paths.copy, join(w.copiesRoot, 'C-1')); assert.equal(wl.paths.outbox, join(w.outboxRoot, 'worker', SID));
    assert.deepEqual(wl.paths.deny, { secrets: ['/s'], otherCopies: [join(w.copiesRoot, 'C-9'), join(w.copiesRoot, `C-1~baseline-${SID}`)] }, 'every other card\'s copy is denied, and the baseline\'s throwaway place');
    const f = join(w.settingsDir, `${SID}.json`);
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { s: 1 });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.outboxRoot, 'worker', SID)).mode & 0o077, 0);
    const sp = w.calls.find((c) => c[0] === 'spawn');
    assert.equal(sp[1], '/bin/sleep'); assert.equal(sp[3].cwd, join(w.copiesRoot, 'C-1')); assert.equal(sp[3].detached, true);
    assert.ok(sp[2].includes(f) && sp[2].includes(SID) && sp[2].at(-1) === 'do the card');
    assert.equal(sp[3].env.HOME, w.c.home); assert.equal(sp[3].env.PATH, '/usr/bin:/bin');
    // Launch check 0 is given the very flags claude is started with (#364 self-review m5).
    const ln = w.calls.find((c) => c[0] === 'launch')[1];
    assert.deepEqual(ln.names.flags, sp[2].filter((x) => x.startsWith('--')));
    assert.deepEqual(ln.names.flags, sessionArgs({ profile: ln.profile, settingsFile: f, sessionId: SID, prompt: 'p' }).filter((x) => x.startsWith('--')));
    // A second start for the same card, claimed by that second session, is refused by the copy already there, and
    // leaves the first one's copy, outbox and settings alone (#364 self-review M3).
    const SID2 = SID.replace('0f', '1f');
    w.card.claim.session_id = SID2;
    const b = await startPort(w.c, { ...w.deps, prepare: (x) => import('../modules/M4-workshop/launcher/worker-copy.mjs').then((m) => m.prepareWorkerCopy(x)) })({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: SID2 });
    assert.equal(b.ok, false); assert.match(b.reason, /already exists/);
    assert.deepEqual(w.left(), { copy: true, outbox: true, settings: true });
    assert.equal(existsSync(join(w.outboxRoot, 'worker', SID2)), false);
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
    ['a card naming no product', { readCard: () => ({ ok: true, doc: { state: 'claimed', claim: { session_id: SID } } }) }, /names no product/],
    ['a Tier 1 card with no main_commit', { startCommit: cardStartCommit }, /main_commit/],
    ['a runner that is stopping', { stopped: () => true }, /is stopping$/],
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
    ['no start time', { pidStartOf: () => null, kill: () => {}, there: () => false }, /start time could not be read/],   // #364 r2 n3: no real group is signalled
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

test('#364 self-review M4: with M4\'s own launch(), names that pass check 0 and no worker checks, check 1 refuses and nothing starts', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  const confirmed = {};
  const w = world({ launchFn: launch, walled: (x) => { const r = walledLaunchSettings(x); if (r.ok) for (const n of namesIn(r.settings)) confirmed[n] = { by: 'readback:stand-in', version: '2.1.300' }; return r; },
    names: { version: '2.1.300', confirmed } });
  for (const f of Object.values(FLAGS)) if (f.startsWith('--')) confirmed[f] = { by: 'readback:stand-in', version: '2.1.300' };
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  w.c.products.p1.render = { paths: { hooksDir: '/w/hooks', snapshot: '/w/rules.json', node: '/w/node', notes: '/w/notes', bobFolder: '/w/bob', mirror: '/w/mirror.git',
    deny: { proposals: ['/w/proposals'], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: ['/w/proposals'] };
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /^launch check 1 \(fresh copy\): no check is wired/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#364 self-review M1: a stop that comes while a start runs its checks spawns nothing, and the start removes what it made', async () => {
  let stopping = false;
  const w = world({ stopped: () => stopping, launchFn: async (x) => { stopping = true; return { ok: true, started: await x.start() }; } });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /stopping, so claude was not started/);
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#369 M1: check 2 runs once more just before claude starts; setup files changed by the checks\' runs stop the start', async () => {
  const seen = [];
  const w = world({ beforeStart: async (x) => { seen.push([x.copy, x.product, x.sessionId]); return 'the copy holds .claude/settings.local.json, which main does not'; },
    launchFn: async (x) => ({ ok: true, started: await x.start() }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /a check failed again just before claude was to start, so it was not started: the copy holds \.claude\/settings\.local\.json/);
    assert.equal(seen.length, 1); assert.equal(typeof seen[0][0], 'string');
    assert.equal(w.calls.some((c) => c[0] === 'spawn'), false);
    assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  const ok = world({ beforeStart: async () => null, launchFn: async (x) => ({ ok: true, started: await x.start() }) });
  try { assert.equal((await ok.start()).ok, true); assert.equal(ok.calls.some((c) => c[0] === 'spawn'), true); } finally { rmSync(ok.d, { recursive: true, force: true }); }
});

test('#369 r1 m3, r2 m3: main moving during a launch is said as such, and never hides a check\'s own reason; checks get the main the copy was restored from', async () => {
  const A = 'a'.repeat(40); const B = 'e'.repeat(40);
  for (const [when, re] of [['after prepare', /^main changed during launch; retry$/], ['before start', /^a check failed again just before claude was to start, so it was not started: the copy's \.mcp\.json is not main's \(main also moved during launch\)$/]]) {
    let mains = [A];
    let seen;
    const w = world({ mainOf: async () => mains.shift() ?? B, checksFor: (x) => { seen = x.mainAt; return {}; },
      beforeStart: async () => 'the copy\'s .mcp.json is not main\'s', launchFn: async (x) => ({ ok: true, started: await x.start() }) });
    if (when === 'before start') mains = [A, A];
    try {
      const a = await w.start();
      assert.equal(a.ok, false); assert.match(a.reason, re, when);
      if (when === 'before start') assert.equal(seen, A, 'the checks compare with the main read before the copy was made');
      assert.deepEqual(w.left(), { copy: false, outbox: false, settings: false });
    } finally { rmSync(w.d, { recursive: true, force: true }); }
  }
});

test('#369 r1 M1: the baseline\'s throwaway copy is the same commit, walled apart from the session\'s copy and outbox, and removed', async () => {
  let t; let x0;
  const w = world({ checksFor: (x) => { x0 = x; return {}; }, launchFn: async (x) => { t = await x0.throwaway(); return { ok: true, started: await x.start() }; } });
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    const spare = join(w.copiesRoot, `C-1~baseline-${SID}`);
    assert.deepEqual({ ok: t.ok, copy: t.copy, settingsFile: t.settingsFile }, { ok: true, copy: join(spare, 'copy'), settingsFile: join(w.settingsDir, `${SID}~baseline.json`) });
    const preps = w.calls.filter((c) => c[0] === 'prepare').map((c) => c[1]);
    assert.equal(preps.length, 2); assert.deepEqual(preps[1].card, preps[0].card, 'the same card and commit'); assert.equal(preps[1].dest, join(spare, 'copy'));
    const [own, theirs] = w.calls.filter((c) => c[0] === 'walled').map((c) => c[1]);
    assert.ok(own.paths.deny.otherCopies.includes(spare), 'the session denies the throwaway place');
    assert.equal(theirs.paths.copy, join(spare, 'copy')); assert.equal(theirs.paths.outbox, join(spare, 'outbox'));
    for (const p of [join(w.copiesRoot, 'C-1'), join(w.outboxRoot, 'worker', SID), join(w.copiesRoot, 'C-9')]) assert.ok(theirs.paths.deny.otherCopies.includes(p), `the baseline denies ${p}`);
    assert.equal(theirs.paths.deny.otherCopies.includes(spare), false, 'never its own place');
    assert.equal(existsSync(t.settingsFile), true); assert.equal(statSync(spare).mode & 0o077, 0);
    await t.done();
    assert.equal(existsSync(spare), false); assert.equal(existsSync(t.settingsFile), false);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
  // Another commit than the session's copy: refused, and nothing is left.
  {
    let r; let x1;
    const v = world({ prepare: async (x) => { mkdirSync(x.dest); return { ok: true, dest: x.dest, head: x.dest.endsWith(`~baseline-${SID}/copy`) ? 'f'.repeat(40) : HEAD }; },
      checksFor: (x) => { x1 = x; return {}; }, launchFn: async () => { r = await x1.throwaway(); return { ok: false, reason: 'stop here' }; } });
    try { await v.start(); assert.equal(r.ok, false); assert.match(r.reason, /holds another commit than the session's copy/); assert.equal(existsSync(join(v.copiesRoot, `C-1~baseline-${SID}`)), false); } finally { rmSync(v.d, { recursive: true, force: true }); }
  }
  // #369 r2 m3: main moving while the throwaway is made refuses nothing there (its setup files come from main, trusted).
  {
    let r; let x1;
    const v = world({ mainOf: (() => { let n = 0; return async () => (++n > 2 ? 'e'.repeat(40) : 'c'.repeat(40)); })(), checksFor: (x) => { x1 = x; return {}; },
      launchFn: async () => { r = await x1.throwaway(); await r.done?.(); return { ok: false, reason: 'stop here' }; } });
    try { await v.start(); assert.equal(r.ok, true, r.reason); } finally { rmSync(v.d, { recursive: true, force: true }); }
  }
});

test('#369 r2 m1: a throwaway left by an earlier start of the card (one made read-only inside, too) is removed; one that can\'t be is told, and never stops the card starting', async () => {
  let t; let x0;
  const logs = [];
  const w = world({ log: (s) => logs.push(s), checksFor: (x) => { x0 = x; return {}; }, launchFn: async (x) => { t = await x0.throwaway(); return { ok: true, started: await x.start() }; } });
  const old = join(w.copiesRoot, 'C-1~baseline'); const earlier = join(w.copiesRoot, 'C-1~baseline-S-0');
  const other = join(w.copiesRoot, 'C-10~baseline-S-7');
  for (const f of [join(old, 'copy'), join(earlier, 'copy', 'ro'), other]) mkdirSync(f, { recursive: true });
  writeFileSync(join(earlier, 'copy', 'ro', 'f'), 'x'); chmodSync(join(earlier, 'copy', 'ro'), 0o555); chmodSync(join(earlier, 'copy'), 0o555);
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(t.ok, true, t.reason);
    assert.deepEqual([existsSync(old), existsSync(earlier), existsSync(other)], [false, false, true], 'this card\'s leftovers only');
    // A folder made read-only inside the throwaway itself is removed by done() too.
    mkdirSync(join(t.copy, 'ro')); writeFileSync(join(t.copy, 'ro', 'f'), 'x'); chmodSync(join(t.copy, 'ro'), 0o555);
    await t.done();
    assert.equal(existsSync(join(w.copiesRoot, `C-1~baseline-${SID}`)), false);
    assert.deepEqual(logs, []);
  } finally { chmodSync(w.copiesRoot, 0o700); rmSync(w.d, { recursive: true, force: true }); }
  // One that can't be removed: told once per try, left, and the start still goes on under the session's own name.
  const logs2 = []; let t2; let x2;
  const fails = (p) => p.includes('~baseline');
  const v = world({ log: (s) => logs2.push(s), checksFor: (x) => { x2 = x; return {}; }, launchFn: async (x) => { t2 = await x2.throwaway(); return { ok: true, started: await x.start() }; },
    fs: { rm: (p, o) => { if (fails(p) && !p.endsWith('.json')) throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }); return rmSync(p, o); } } });
  mkdirSync(join(v.copiesRoot, 'C-1~baseline-S-0'));
  try {
    const a = await v.start();
    assert.equal(a.ok, true, a.reason); assert.equal(t2.ok, true, t2.reason);
    assert.equal(t2.copy, join(v.copiesRoot, `C-1~baseline-${SID}`, 'copy'));
    assert.ok(logs2.some((l) => /C-1~baseline-S-0 can't be removed \(ENOTEMPTY\); it is left for cleanup/.test(l)), logs2.join('\n'));
    await t2.done();
    assert.ok(logs2.some((l) => new RegExp(`C-1~baseline-${SID} can't be removed`).test(l)), logs2.join('\n'));
  } finally { rmSync(v.d, { recursive: true, force: true }); }
});

test('#369 r2 m2: a product the runner holds back (its rules snapshot not kept fresh) starts nothing, saying why', async () => {
  const w = world({ productHeld: (p) => (p === 'p1' ? 'product p1\'s rules snapshot is not kept fresh (ENOSPC), so its sessions are not started' : null) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.match(a.reason, /p1's rules snapshot is not kept fresh/);
    assert.equal(w.calls.some((c) => c[0] === 'prepare'), false, 'nothing is made');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('L825: a Tier 1 card (or one with no tier) starts on its plan\'s main_commit; any other card on the mirror\'s main', async () => {
  const C = 'c'.repeat(40); const M = 'd'.repeat(40);
  const main = async (m) => { assert.equal(m, '/m'); return M; };
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { tier: 1, main_commit: C } }, { main }), C);
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { main_commit: C } }, { main }), C);
  assert.equal(await cardStartCommit({ mirror: '/m', cardDoc: { tier: 2, main_commit: null } }, { main }), M);
  for (const doc of [{ tier: 1 }, { tier: 1, main_commit: 'abc' }, { main_commit: C.toUpperCase() }, {}, undefined]) {
    await assert.rejects(cardStartCommit({ mirror: '/m', cardDoc: doc }, { main }), /main_commit/, JSON.stringify(doc));
  }
  // #364 r1 m1: a tier the Store would refuse is refused here too, never read as Tier 2.
  for (const tier of ['1', '2', 0, 3, true, 1.5, -1]) {
    await assert.rejects(cardStartCommit({ mirror: '/m', cardDoc: { tier, main_commit: C } }, { main }), /is not 1 or 2/, JSON.stringify(tier));
  }
  // The answer's base is the commit the copy was made on.
  const w = world({ startCommit: undefined });
  delete w.deps.startCommit; w.card.tier = 1; w.card.main_commit = C;
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(a.base, C);
    assert.equal(w.calls.find((c) => c[0] === 'prepare')[1].card.commit, C);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r1 m6: a Tier 2 card starts on the real mirror\'s main through the start port, and base names it', async () => {
  const w = world();
  delete w.deps.startCommit; w.card.tier = 2;
  const src = join(w.d, 'src'); mkdirSync(src);
  const o = { gitDir: join(src, '.git'), workTree: src, cwd: src };
  try {
    await gitOk(['init', '-q', '-b', 'main', src], o); writeFileSync(join(src, 'a.txt'), 'a\n');
    await gitOk(['add', '-A'], o); await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'm'], o);
    const M = (await gitOk(['rev-parse', 'HEAD'], o)).trim();
    await initMirror(w.c.products.p1.mirror);
    await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main'], { gitDir: w.c.products.p1.mirror });
    const a = await w.start();
    assert.equal(a.ok, true, a.reason); assert.equal(a.base, M);
    assert.equal(w.calls.find((c) => c[0] === 'prepare')[1].card.commit, M);
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r1 M1: with two products, a p1 session\'s settings deny p2\'s mirror and every copy there at start, never its own', async () => {
  const d0 = realpathSync(tempDir('orch-rports-'));
  let got;
  const w = world({ walled: (x) => { const r = walledLaunchSettings(x); got = r; return r; } });
  const runner = { requestsDir: join(d0, 'requests'), statusFile: join(d0, 'state', 'status.json') };
  mkdirSync(runner.requestsDir); mkdirSync(join(d0, 'state'));
  w.c.workerRunner = runner;
  const render = (n) => ({ paths: { hooksDir: `/w/${n}/hooks`, snapshot: `/w/${n}/rules.json`, node: '/w/node', notes: `/w/${n}/notes`, bobFolder: '/w/bob', mirror: `/w/${n}/mirror.git`,
    deny: { proposals: [`/w/${n}/proposals`], secrets: ['/w/secrets'], claudeHome: '/h/.claude', ssh: '/h/.ssh', gh: '/h/.config/gh', robotKeys: '/w/keys', record: '/w/record' } },
  product: { commands: { test: 'npm test' }, hosts: [] }, rulesHosts: [], productionFiles: [], proposalOutboxes: [`/w/${n}/proposals`] });
  w.c.products.p1.render = render('p1');
  w.c.products.p2 = { repo: 'o/p2', mirror: join(w.d, 'mirror-p2'), render: render('p2') };
  mkdirSync(join(w.copiesRoot, 'C-7'));   // p2's card, made before this start
  try {
    const a = await w.start();
    assert.equal(a.ok, true, a.reason);
    const denyRead = got.settings[S.sandbox][S.filesystem][S.denyRead];
    for (const p of [w.c.products.p2.mirror, join(w.copiesRoot, 'C-7'), join(w.copiesRoot, 'C-9'), '/w/record', '/h/.ssh', '/w/keys']) assert.ok(denyRead.includes(p), `${p} is denied`);
    assert.equal(denyRead.includes(join(w.copiesRoot, 'C-1')), false, 'its own copy is not denied');
    assert.equal(denyRead.includes(w.c.products.p1.mirror), false, 'its own product\'s mirror is not denied');
    // And the other way: a p2 session denies p1's mirror.
    const SID2 = SID.replace('0f', '2f');
    w.card.claim.session_id = SID2; w.card.product = 'p2';
    const b = await startPort(w.c, w.deps)({ card: 'C-2', kind: 'editing', product: 'p2', sessionId: SID2 });
    assert.equal(b.ok, true, b.reason);
    const dr2 = got.settings[S.sandbox][S.filesystem][S.denyRead];
    assert.ok(dr2.includes(w.c.products.p1.mirror) && dr2.includes(join(w.copiesRoot, 'C-1')) && !dr2.includes(join(w.copiesRoot, 'C-2')));
  } finally { rmSync(w.d, { recursive: true, force: true }); rmSync(d0, { recursive: true, force: true }); }
});

test('#364 r1 m3: a claude whose start time can\'t be read and whose group can\'t be shown gone is answered as running, and its start keeps what it made', async () => {
  const kills = [];
  const s = await spawnLeader({ spawn: () => ({ pid: 4243, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }), bin: '/x', args: [], cwd: '/', env: {},
    pidStartOf: () => null, kill: (g, sig) => kills.push([g, sig]), there: () => true, killWaitMs: 60 });
  assert.deepEqual(kills, [[4243, 'SIGKILL']]);
  assert.equal(s.ok, false); assert.equal(s.running, true); assert.equal(s.pgid, 4243);
  const gone = await spawnLeader({ spawn: () => ({ pid: 4244, once: (ev, fn) => { if (ev === 'spawn') fn(); }, unref: () => {} }), bin: '/x', args: [], cwd: '/', env: {},
    pidStartOf: () => null, kill: () => {}, there: () => false, killWaitMs: 60 });
  assert.equal(gone.ok, false); assert.equal(gone.running, undefined); assert.match(gone.reason, /so its group was killed/);
  const w = world({ pidStartOf: () => null, kill: () => {} });
  w.deps.launchFn = async (x) => ({ ok: false, reason: 'start failed', started: await spawnLeader({ spawn: w.deps.spawn, bin: '/x', args: [], cwd: '/', env: {}, pidStartOf: () => null, kill: () => {}, there: () => true, killWaitMs: 60 }) });
  try {
    const a = await w.start();
    assert.equal(a.ok, false); assert.equal(a.running, true); assert.equal(a.pgid, 4242);
    assert.deepEqual(w.left(), { copy: true, outbox: true, settings: true }, 'nothing it made is removed while claude may run');
  } finally { rmSync(w.d, { recursive: true, force: true }); }
});

test('#364 r2 c-b: a group is gone only on ESRCH; EPERM (there, not ours to signal) and any other error read as still there', () => {
  const seen = [];
  assert.equal(groupThere(4243, (g, s) => { seen.push([g, s]); }), true);
  assert.deepEqual(seen, [[-4243, 0]], 'signal 0 to the group, never the leader alone');
  assert.equal(groupThere(4243, () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }), false);
  assert.equal(groupThere(4243, () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }), true);
  assert.equal(groupThere(4243, () => { throw new Error('odd'); }), true);
});

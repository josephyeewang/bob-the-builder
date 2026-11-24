// Part C, runner step 5: the worker runner's entry point and its LaunchAgent file. Nothing here loads a job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { spawn } from 'node:child_process';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { statusOf, statusText } from '../setup/builder-wall.mjs';
import { DENY_KEYS, personUserProblem, carriedOverProblem, checkRunnerConfig, realRenderPaths, updateRestart, hookStoreOf, launchInputs, lockedOf, lockedWiring, productCommands, readRunnerConfig, startDeps, listenStop, main, readRootFile, realRunnerPorts, testProductHeld, testProductProblem, workerCheckInputs } from './runner-main.mjs';
import { SIGNIN_TOKEN_VAR, checkRoleEnv } from '../modules/M4-workshop/launcher/env-check.mjs';
import { workerSnapshotProblem } from './runner-checks.mjs';
import { rulesText } from '../setup/worker-rules.mjs';
import { RUNNER_JOB_LOG, RUNNER_JOB_UMASK, RUNNER_JOB_USER, RUNNER_NODE_FLAGS, fullPath, workerRunnerPlist } from './runner-job.mjs';
import { BUILDER } from '../setup/layout.mjs';
// The tests run as a person's user; main's own check of that is tested apart (L1079).
const AS_BUILDER = () => null;

const config = (d, over = {}) => ({ installRoot: join(d, 'install'), requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json'), orchestrateUid: 501,
  outboxRoot: join(d, 'outboxes'), copiesRoot: join(d, 'copies'), home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: join(d, 'install', 'claude'),
  recordRoot: join(d, 'record'), recordUid: 501, claimMs: 600_000, wallStatus: join(d, 'wall', 'wall-status.json'), products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { deny: DENY(d) } } } }, ...over });
// The roots as setup makes them, at their real paths (#378 r1 m4: the Mac's temp folder is reached through /var).
const roots = (d0) => { const d = realpathSync.native(d0); mkdirSync(join(d, 'copies')); mkdirSync(join(d, 'outboxes')); return d; };
const DENY = (d) => ({ record: join(d, 'record'), ssh: join(d, 'home', '.ssh'), gh: join(d, 'home', '.config', 'gh'), claudeHome: join(d, 'home', '.claude'),
  robotKeys: join(d, 'keys'), secrets: [join(d, 'secrets'), join(d, 'approvals')] });
test('step 5: the config is refused unless every path is full, the uids are uids, and each product has its repo, mirror and paths', () => {
  const c = checkRunnerConfig(config('/x'));
  assert.equal(c.ownDir, '/x/runner'); assert.equal(c.memoryFile, '/x/runner/memory.json'); assert.equal(c.settingsDir, '/x/runner/settings');
  assert.deepEqual(c.workerRunner, { requestsDir: '/x/requests', statusFile: '/x/runner/status.json' });
  const bad = [
    [{ statusFile: 'status.json' }, /statusFile must be a full path/], [{ copiesRoot: '/' }, /copiesRoot must be a full path in its simplest form, not \//],
    [{ recordUid: -1 }, /recordUid must be a uid/], [{ path: 'bin' }, /path must be full folders/], [{ claimMs: 0 }, /claimMs/],
    [{ products: {} }, /at least one product/], [{ products: { '../p': { repo: 'o/p', mirror: '/m', render: { paths: {} } } } }, /not a product name/],
    [{ products: { p1: { repo: 'p', mirror: '/m', render: { paths: {} } } } }, /repo must be owner\/name/],
    [{ products: { p1: { repo: 'o/p', mirror: 'm', render: { paths: {} } } } }, /mirror must be a full path/],
    [{ products: { p1: { repo: 'o/p', mirror: '/m' } } }, /render.paths/],
    [{ requestsDir: '/x/runner' }, /apart from the requests folder/],
  ];
  for (const [over, re] of bad) assert.throws(() => checkRunnerConfig(config('/x', over)), re, JSON.stringify(over));
});

test('step 5: the real ports are all there, each a function, and a test can replace any', () => {
  const p = realRunnerPorts(checkRunnerConfig(config('/x')), { pauseLead: 'mine' });
  for (const k of ['start', 'groupGone', 'stopGroup', 'saveWork', 'outboxDrained', 'size']) assert.equal(typeof p[k], 'function', k);
  assert.equal(p.pauseLead, 'mine');
});

test('step 5: main runs the loop with the config\'s paths, holds one lock for its life, and stops on SIGTERM', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = []; let stop; let ctx;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), onStop: (fn) => { stop = fn; },
      run: async (x) => { ctx = x; assert.ok(existsSync(join(d, 'runner', 'lock')), 'the lock is held while the loop runs');
        assert.throws(() => makeLock({ dir: join(d, 'runner'), timeoutMs: 50 }).acquire(), /busy/, 'a second runner can\'t take it');
        assert.equal(x.stopWhen(), false); stop(); assert.equal(x.stopWhen(), true);
        // The start port is told: once stopping, it starts nothing (#364 self-review M1).
        assert.match((await x.ports.start({})).reason, /is stopping$/); } });
    assert.equal(code, 0, logs.join('\n'));
    assert.equal(ctx.memoryFile, join(d, 'runner', 'memory.json')); assert.equal(ctx.statusFile, join(d, 'runner', 'status.json'));
    assert.equal(ctx.uid, process.getuid()); assert.equal(ctx.orchestrateUid, 501); assert.equal(ctx.claimMs, 600_000);
    assert.equal(typeof ctx.ports.start, 'function');
    assert.equal(statSync(join(d, 'runner', 'settings')).mode & 0o077, 0);
    assert.equal(existsSync(join(d, 'runner', 'lock')), false, 'the lock is let go at the end');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5: main does not start on a bad config, while another runner holds the lock, and answers 1 when the loop stops on a throw', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = [];
    let ran = false;
    const run = async () => { ran = true; };
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => { throw new Error('job config /cfg.json: is owned by uid 9'); }, log: (s) => logs.push(s), run }), 1);
    assert.match(logs.at(-1), /did not start: job config/);
    const other = makeLock({ dir: join(d, 'runner') }); const h = other.acquire();
    try {
      assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), run, lock: (dir) => makeLock({ dir, timeoutMs: 50 }), onStop: () => {} }), 1);
      assert.match(logs.at(-1), /another worker runner is running/);
    } finally { other.release(h.nonce); }
    assert.equal(ran, false);
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), run: async () => { throw new Error('the memory can\'t be read'); }, onStop: () => {} }), 1);
    assert.match(logs.at(-1), /stopped: the memory can't be read/);
    assert.equal(existsSync(join(d, 'runner', 'lock')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5 (L1079): the job file is loginJobPlist\'s, run as the builder user, with its own logs, the builder\'s HOME and Umask 077', () => {
  const o = { label: 'org.example.worker-runner', node: '/usr/local/bin/node', script: '/i/wiring/runner-main.mjs', config: '/i/runner.json', path: '/usr/bin:/bin', logDir: '/logs', workDir: '/B/home/builder', home: '/B/home/builder' };
  assert.throws(() => workerRunnerPlist({ ...o, home: 'o' }), /home must be/);
  for (const home of ['/', '//', '/.', '/..', '/./', '/B/home/builder/', '/B//home', '/B/../home', '/B/h o']) assert.throws(() => workerRunnerPlist({ ...o, home }), /simplest form, not \/ itself/, home);
  // A person's home is refused: the builder's is setup's, under the base (I1: nothing falls back to the owner).
  for (const home of ['/Users/o', '/users/o', '/Users']) assert.throws(() => workerRunnerPlist({ ...o, home }), /not a person's home under \/Users \(L1079\)/, home);
  assert.equal(RUNNER_JOB_UMASK, 0o077, 'what the runner makes is the builder\'s alone');
  assert.equal(RUNNER_JOB_USER, BUILDER);
  assert.equal(BUILDER, 'builder');
  const t = workerRunnerPlist(o);
  assert.match(t, /<key>HOME<\/key><string>\/B\/home\/builder<\/string>/);
  assert.match(t, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(t, /<key>UserName<\/key><string>builder<\/string>/, 'a LaunchDaemon run as the builder, never root and never the owner');
  assert.equal(t.match(/<key>UserName<\/key>/g).length, 1);
  assert.ok(t.includes(`/logs/${RUNNER_JOB_LOG}.out.log`) && t.includes(`/logs/${RUNNER_JOB_LOG}.err.log`));
  assert.match(t, /<array><string>\/usr\/local\/bin\/node<\/string><string>--disable-sigusr1<\/string><string>\/i\/wiring\/runner-main.mjs<\/string><string>\/i\/runner.json<\/string><\/array>/, 'L1242 m1: no debugger by signal');
  assert.deepEqual(RUNNER_NODE_FLAGS, ['--disable-sigusr1']);
});

test('L1242 m1: with --disable-sigusr1 a SIGUSR1 starts no debugger; without it, one starts (the control)', async () => {
  const debuggerOn = (flags) => new Promise((resolve) => {
    // --inspect-port=0: a debugger the signal starts takes a free port, so this never collides with another test's.
    const p = spawn(process.execPath, ['--inspect-port=0', ...flags, '-e', 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); p.kill('SIGKILL'); resolve(v); };
    p.stderr.on('data', (b) => { err += b; if (/Debugger listening/.test(err)) finish(true); });
    p.stdout.once('data', () => { p.kill('SIGUSR1'); });
    p.on('exit', () => finish(/Debugger listening/.test(err)));
    const t = setTimeout(() => finish(/Debugger listening/.test(err)), 3000);
  });
  assert.equal(await debuggerOn([]), true, 'the control: a plain node starts its debugger on SIGUSR1');
  assert.equal(await debuggerOn([...RUNNER_NODE_FLAGS]), false, 'the runner\'s flags: none starts');
  // The other jobs built by loginJobPlist are unchanged: no node option unless a caller passes one; a bad one is refused.
  const base = { label: 'org.example.x', node: '/n', script: '/s.mjs', config: '/c.json', path: '/usr/bin', logDir: '/l', workDir: '/w' };
  assert.match(loginJobPlist(base), /<array><string>\/n<\/string><string>\/s\.mjs<\/string>/);
  for (const bad of [['--inspect=0.0.0.0:9'], ['-e'], ['--require', '/x.js'], 'x', [1]]) assert.throws(() => loginJobPlist({ ...base, nodeFlags: bad }), /nodeFlags must be/, String(bad));
});

test('#364 self-review m6: main never makes the runner\'s own folder (setup does, with the access the Dispatcher needs)', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    const logs = [];
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), run: async () => {}, onStop: () => {} }), 1);
    assert.equal(existsSync(join(d, 'runner')), false);
    assert.match(logs.join('\n'), /did not start: .*ENOENT/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#364 r1 M2: a config whose product lacks any of the Record, key, home or secrets deny entries is refused', () => {
  assert.equal(checkRunnerConfig(config('/x')).products.p1.render.paths.deny.record, '/x/record');
  const withDeny = (deny) => config('/x', { products: { p1: { repo: 'o/p1', mirror: '/x/mirror', render: { paths: { deny } } } } });
  assert.throws(() => checkRunnerConfig(config('/x', { products: { p1: { repo: 'o/p1', mirror: '/x/mirror', render: { paths: {} } } } })), /render\.paths\.deny\.record must be a full path/, 'an empty render.paths');
  assert.deepEqual([...DENY_KEYS], ['record', 'ssh', 'gh', 'claudeHome', 'robotKeys']);
  for (const k of ['record', 'ssh', 'gh', 'claudeHome', 'robotKeys']) {
    for (const v of [undefined, '', 'rel', '/', '//']) {
      assert.throws(() => checkRunnerConfig(withDeny({ ...DENY('/x'), [k]: v })), new RegExp(`deny\\.${k} must be a full path`), `${k}=${v}`);
    }
  }
  for (const v of [undefined, [], ['rel'], ['/'], '/x/s']) assert.throws(() => checkRunnerConfig(withDeny({ ...DENY('/x'), secrets: v })), /deny\.secrets must list full paths/, JSON.stringify(v));
});

test('#364 r1 m4: every SIGTERM is heard, not only the first', () => {
  let n = 0; const fn = () => { n += 1; };
  const before = process.listenerCount('SIGTERM');
  listenStop(fn);
  try {
    process.emit('SIGTERM'); process.emit('SIGTERM');
    assert.equal(n, 2); assert.equal(process.listenerCount('SIGTERM'), before + 1, 'still listening after two');
  } finally { process.removeListener('SIGTERM', fn); }
});

test('#364 r1 m4: main listens with listenStop by default, so a second SIGTERM in the run is heard too', async () => {
  const d = roots(tempDir('orch-rmain-'));
  const before = process.listeners('SIGTERM');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    let heard = 0;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: () => {}, run: async (x) => {
      process.emit('SIGTERM'); if (x.stopWhen()) heard += 1;
      assert.equal(process.listeners('SIGTERM').length, before.length + 1, 'still listening after the first');
    } });
    assert.equal(code, 0); assert.equal(heard, 1);
  } finally { for (const l of process.listeners('SIGTERM')) if (!before.includes(l)) process.removeListener('SIGTERM', l); rmSync(d, { recursive: true, force: true }); }
});

// Spellings a path match may not see as the path they resolve to (#364 r2 n1, n4).
const UNPLAIN = ['/x/home/kk/', '/x/home/./kk', '/x/home//kk', '/x/zz/../home/kk', '/x/home/k k', '//', '/.', '/./', '/..', '//x', '/x/.', '/x/..', 'x/y'];

test('#364 r2 n1, n4: deny entries and the config\'s own paths must be spelled as they resolve; any other spelling is refused, never cleaned', () => {
  for (const p of UNPLAIN) assert.equal(fullPath(p), false, p);
  for (const p of ['/x', '/x/home/kk', '/Users/o/.ssh', '/a/b.c_d-e']) assert.equal(fullPath(p), true, p);
  const withDeny = (deny) => config('/x', { products: { p1: { repo: 'o/p1', mirror: '/x/mirror', render: { paths: { deny } } } } });
  for (const v of UNPLAIN) {
    for (const k of DENY_KEYS) assert.throws(() => checkRunnerConfig(withDeny({ ...DENY('/x'), [k]: v })), new RegExp(`deny\\.${k} must be a full path in its simplest form`), `${k}=${v}`);
    assert.throws(() => checkRunnerConfig(withDeny({ ...DENY('/x'), secrets: ['/x/s', v] })), /deny\.secrets must list full paths in their simplest form/, `secrets ${v}`);
    for (const k of ['installRoot', 'requestsDir', 'statusFile', 'outboxRoot', 'copiesRoot', 'home', 'claudeBin', 'recordRoot']) {
      assert.throws(() => checkRunnerConfig(config('/x', { [k]: v })), new RegExp(`${k} must be a full path in its simplest form`), `${k}=${v}`);
    }
    assert.throws(() => checkRunnerConfig(config('/x', { path: `/usr/bin:${v}` })), /path must be full folders in their simplest form/, `path ${v}`);
    assert.throws(() => checkRunnerConfig(config('/x', { products: { p1: { repo: 'o/p1', mirror: v, render: { paths: { deny: DENY('/x') } } } } })), /mirror must be a full path in its simplest form/, `mirror ${v}`);
  }
});

test('#369 r2 c2: a RECHECK check that throws is a failure with its reason, never a pass; one with no port is refused', async () => {
  const ok = async () => ({ ok: true });
  const of = (k) => startDeps({ pin: '1' }, { checksOf: () => k }).beforeStart({});
  assert.equal(await of({ 1: ok, 2: ok, 3: ok, 8: ok }), null);
  assert.equal(await of({ 1: ok, 2: async () => { throw new Error('git cat-file failed'); }, 3: ok, 8: ok }), 'check 2: git cat-file failed');
  assert.equal(await of({ 1: ok, 2: ok, 3: ok }), 'check 8 has no port');
});

// L1125: a test whose product stands for the test product passes main's gate this way (no budget is loaded in these tests).
const TEST_PRODUCT_OK = () => null;
// L1193: a test whose Mac has the builder wall confirmed passes main's wall gate this way: lane A's real module (the
// default loadWall, #585) and its own writer's line for this test's uid, written a minute before the clock.
const WALL_OK = { wallPorts: { chain: () => null, now: () => Date.parse('2026-11-14T12:00:00.000Z'),
    readRoot: () => statusText(statusOf([{ ok: true, what: 'pf is on' }], process.getuid(), new Date('2026-11-14T11:59:00.000Z'))) } };

test('L1226 (L1252): main holds a product until root\'s snapshot is root\'s, fresh and its own, behind the wall and test-product gates; told once per reason', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const dir = join(d, 'worker-rules'); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755); chmodSync(d, 0o755);
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const snap = join(dir, 'p1.json');
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: snap, snapshotOwner: 0 } } } } });
    const SHA = createHash('sha256').update('cfg bytes').digest('hex');
    const ME = process.getuid();
    const logs = []; let r;
    const go = (o) => main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, sourceOf: () => SHA,
      snapshotProblem: (s) => workerSnapshotProblem(s, { owner: ME }),
      run: async (ctx) => { r = await ctx.ports.start({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' }); }, ...WALL_OK, ...o });
    // L1193: the wall gate comes first: no wall confirmed (here, lane A's code is stood in for by nothing), and the start is
    // held for the wall before the test-product gate or the snapshot is asked.
    assert.equal(await go({ loadWall: async () => { throw new Error('Cannot find module builder-wall.mjs'); }, testProduct: TEST_PRODUCT_OK }), 0, logs.join('\n'));
    assert.equal(r.ok, false); assert.match(r.reason, /the builder wall's code can't be loaded from the installed copy \(Cannot find module builder-wall\.mjs\), so no session starts/);
    assert.ok(logs.some((l) => /the builder wall's code can't be loaded \(Cannot find module builder-wall\.mjs\); every start is held/.test(l)), 'told at start');
    assert.equal(await go({ wallPorts: { ...WALL_OK.wallPorts, now: () => Date.parse('2026-11-14T12:30:00.000Z') }, testProduct: TEST_PRODUCT_OK }), 0);
    assert.match(r.reason, /older than two of the wall job's beats/, 'a stale status holds the start');
    assert.equal(await go({ wallPorts: { ...WALL_OK.wallPorts, chain: (p) => `${p} is not owned by root` }, testProduct: TEST_PRODUCT_OK }), 0);
    assert.match(r.reason, /status file is not root's alone \(.*wall-status\.json is not owned by root\)/, 'main asks about the config\'s own wallStatus file');
    assert.equal(await go({ wallPorts: { ...WALL_OK.wallPorts, readRoot: () => { throw new Error('x'); } }, testProduct: TEST_PRODUCT_OK }), 0);
    assert.match(r.reason, /status can't be read/);
    // L1125: main's own gate, left in place: no budget is loaded, so the product is held by the gate first.
    assert.equal(await go({}), 0, logs.join('\n'));
    assert.equal(r.ok, false); assert.match(r.reason, /the Dispatcher's rules are not loaded .*only a test product runs on the worker runner/);
    // A test product (the gate passes): the snapshot's own hold. None written yet: held, and the runner wrote none.
    logs.length = 0;
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK }), 0, logs.join('\n'));
    assert.equal(r.reason, "product p1's rules snapshot: rules snapshot is missing or unreadable: is root's worker-rules job loaded? (setup.mjs daemons check), so its sessions are not started");
    assert.equal(existsSync(snap), false, 'the runner never writes the snapshot (L1226)');
    assert.equal(logs.filter((l) => /p1's rules snapshot: rules snapshot is missing/.test(l)).length, 1, logs.join('\n'));
    // Root's job's file (the test's uid standing in for root): the hold lifts, told once, and the start goes on to the card.
    writeFileSync(snap, rulesText('p1', rules, SHA)); chmodSync(snap, 0o644);
    logs.length = 0;
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK }), 0, logs.join('\n'));
    assert.doesNotMatch(r.reason, /rules snapshot/, r.reason);
    assert.ok(logs.includes("product p1's rules snapshot: root's, fresh, matches"), logs.join('\n'));
    // L1252 (c): root's and fresh, but from another read of the config (the runner's own bytes differ): held.
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK, sourceOf: () => createHash('sha256').update('other').digest('hex') }), 0);
    assert.match(r.reason, /p1's rules snapshot: the rules snapshot was written from other bytes of worker-runner\.json than the runner read/);
    // The default sourceOf is readSha256: a config not read by job-config's one handle (this test's) holds every product.
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK, sourceOf: undefined }), 0);
    assert.match(r.reason, /p1's rules snapshot: the runner's config was not read from its file through one handle/);
    // Plant 1: the default check, with root as the owner: the test's own file (as the runner wrote it, the old way) is held.
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK, snapshotProblem: undefined }), 0);
    assert.match(r.reason, /p1's rules snapshot: .*not root's alone/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L836: a product named as a role, or not named as setup names its folders, is refused (#378 M1)', () => {
  const p = (n) => ({ repo: `o/${n}`, mirror: `/x/${n}`, render: { paths: { deny: DENY('/x') } } });
  for (const n of ['worker', 'script', 'lead']) assert.throws(() => checkRunnerConfig(config('/x', { products: { [n]: p('a') } })), /named as a role/, n);
  for (const n of ['Alpha', 'Script', 'p.1', 'p_1']) assert.throws(() => checkRunnerConfig(config('/x', { products: { [n]: p('a') } })), /is not a product name/, n);
  assert.doesNotThrow(() => checkRunnerConfig(config('/x', { products: { alpha: p('a'), beta: p('b') } })));
});

test('#378 r1 m4: main does not start when the copies or outbox root is reached through a link, or is missing', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'));
    const logs = []; let ran = false; const run = async () => { ran = true; };
    mkdirSync(join(d, 'real-copies'));
    symlinkSync(join(d, 'real-copies'), join(d, 'linked'));
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { copiesRoot: join(d, 'linked') }), log: (s) => logs.push(s), run, onStop: () => {} }), 1);
    assert.match(logs.at(-1), /did not start: copiesRoot is reached through a link/);
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { outboxRoot: join(d, 'linked') }), log: (s) => logs.push(s), run, onStop: () => {} }), 1);
    assert.match(logs.at(-1), /did not start: outboxRoot is reached through a link/);
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { outboxRoot: join(d, 'none') }), log: (s) => logs.push(s), run, onStop: () => {} }), 1);
    assert.match(logs.at(-1), /did not start: outboxRoot can't be read \(ENOENT\)/);
    assert.equal(ran, false);
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), run, onStop: () => {} }), 0, logs.join('\n'));
    assert.equal(ran, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1347: main gives the sessions the real paths of the tool places setup names through the install link, and stops on one it can\'t read', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'));
    mkdirSync(join(d, 'install.v-1', 'hooks'), { recursive: true }); mkdirSync(join(d, 'install.v-1', 'bin'));
    writeFileSync(join(d, 'install.v-1', 'bin', 'node'), '');
    symlinkSync(join(d, 'install.v-1'), join(d, 'current'));
    const paths = { deny: DENY(d), hooksDir: join(d, 'current', 'hooks'), node: join(d, 'current', 'bin', 'node'), notes: join(d, 'current', 'notes-not-yet') };
    const cfg = () => config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths } } } });
    const logs = []; let got = null;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: cfg, log: (s) => logs.push(s), onStop: () => {},
      portsOf: (cc, ports, o) => { got = cc; return realRunnerPorts(cc, ports, o); }, run: async () => {} });
    assert.equal(code, 0, logs.join('\n'));
    const q = got.products.p1.render.paths;
    assert.equal(q.hooksDir, join(d, 'install.v-1', 'hooks'));
    assert.equal(q.node, join(d, 'install.v-1', 'bin', 'node'));
    assert.equal(q.notes, join(d, 'current', 'notes-not-yet'), 'a place not there yet is left for the wall');
    assert.deepEqual(q.deny, paths.deny);
    assert.ok(logs.some((l) => /p1's hooksDir is reached through a link; its sessions are given its real path/.test(l)), logs.join('\n'));
    // A read that fails other than "not there" stops the runner before anything runs.
    let ran = false;
    const code2 = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: cfg, log: (s) => logs.push(s), onStop: () => {}, run: async () => { ran = true; },
      realpath: (x) => { if (x === paths.hooksDir) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } return realpathSync.native(x); } });
    assert.equal(code2, 1); assert.equal(ran, false);
    assert.match(logs.at(-1), /did not start: product p1's render\.paths\.hooksDir can't be read \(EACCES\)/);
    // The one function main uses, which the runLocked proof also calls: the config given is left as it was.
    const c0 = checkRunnerConfig(cfg());
    const r = realRenderPaths(c0);
    assert.equal(r.products.p1.render.paths.node, join(d, 'install.v-1', 'bin', 'node'));
    assert.equal(c0.products.p1.render.paths.node, paths.node);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1348: the runner stops for a restart once the install link names another version than its code and nothing only it holds is on', () => {
  let at = '/i/v-1'; let q = 0; let t = 0; const logs = [];
  const rp = (p) => { if (p === '/code') return '/i/v-1'; assert.equal(p, '/i/cur'); if (at === null) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } return at; };
  const u = updateRestart({ installRoot: '/i/cur', from: '/code', realpath: rp, log: (x) => logs.push(x), waiting: () => q, now: () => t });
  const idle = { state: { sessions: [], saves: {}, installs: {} }, pending: new Map() };
  assert.equal(u(idle), false, 'same version: no stop');
  assert.equal(u(undefined), false); assert.equal(u({}), false);
  at = '/i/v-2';
  // What only this process holds keeps it: a start or save still on, a kept save or install group, a request waiting.
  const on = [
    { state: { sessions: [] }, pending: new Map([['x', {}]]) },
    { state: { sessions: [], saves: { s: { pgid: 1 } } }, pending: new Map() },
    { state: { sessions: [], installs: { s: { pgid: 1 } } }, pending: new Map() },
  ];
  for (const x of on) assert.equal(u(x), false, JSON.stringify(x.state));
  q = 1; assert.equal(u(idle), false, 'a request waiting'); q = 0;
  assert.equal(logs.filter((l) => /newer version is installed \(\/i\/v-2\); it restarts on it once no start, save or request is on/.test(l)).length, 1, logs.join('\n'));
  // Told again every ten minutes while it waits.
  t = 600_000; assert.equal(u(on[0]), false);
  assert.equal(logs.filter((l) => /it restarts on it once/.test(l)).length, 2);
  // A link that can't be read now changes nothing.
  at = null; assert.equal(u(idle), false); at = '/i/v-2';
  // Running sessions, and ended ones with an open outbox, carry over: they don't hold it (#378 path).
  const sessions = { state: { sessions: [{ id: 'b' }, { id: 'c', alive: true }, { id: 'd', alive: false, ended: true, outbox_open: true }], saves: {}, installs: {} }, pending: new Map() };
  assert.equal(u(sessions), true);
  assert.match(logs.at(-1), /no start, save or request is on; it stops, and the Mac starts it again on the new version within a minute/);
  // The version is the running code's: the link moved before the runner read it doesn't make it look current.
  at = '/i/v-2'; const u3 = updateRestart({ installRoot: '/i/cur', from: '/code', realpath: rp });
  assert.equal(u3(idle), true, 'code is v-1, the link is v-2');
  // No code folder to read never restarts, and says so.
  const l2 = []; const u2 = updateRestart({ installRoot: '/i/cur', realpath: rp, log: (x) => l2.push(x) });
  assert.match(l2[0], /own code folder can't be read now, so it won't restart itself/);
  assert.equal(u2(idle), false);
});

test('L1348: main hands the loop a stop that is the update restart as well as SIGTERM, and returns 0 when it stops', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'));
    mkdirSync(join(d, 'v-1')); mkdirSync(join(d, 'v-2')); symlinkSync(join(d, 'v-1'), join(d, 'install'));
    const logs = []; let seen = null;
    const run = async (ctx) => {
      const idle = { state: { sessions: [], saves: {}, installs: {} }, pending: new Map() };
      assert.equal(ctx.stopWhen(idle), false, 'not moved yet');
      rmSync(join(d, 'install')); symlinkSync(join(d, 'v-2'), join(d, 'install'));
      // A request waiting in the runner's own requests folder holds the stop; read from the config's folder.
      mkdirSync(join(d, 'requests'), { recursive: true }); writeFileSync(join(d, 'requests', 'r-1.json'), '{}');
      assert.equal(ctx.stopWhen(idle), false, 'a request is waiting');
      rmSync(join(d, 'requests', 'r-1.json'));
      seen = ctx.stopWhen(idle);
    };
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: (s) => logs.push(s), run, onStop: () => {}, codeRoot: () => join(d, 'v-1') });
    assert.equal(code, 0, logs.join('\n'));
    assert.equal(seen, true, logs.join('\n'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#378 r1 M1: a runner restart carrying over a product A session whose settings do not deny product B, added since, does not start', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner', 'settings'), { recursive: true });
    const c0 = config(d, { products: { p1: config(d).products.p1, p2: { repo: 'o/p2', mirror: join(d, 'mirror2'), render: { paths: { deny: DENY(d) } } } } });
    const c = checkRunnerConfig(c0);
    const SA = '0f8fad5b-d9cb-469f-a165-70867728950e';
    // A's settings as written when p1 was the only product (runner-ports.test.mjs makes them for real): p2 is not on them.
    const denied = [join(d, 'record'), join(d, 'copies', 'p1', 'C-9')];
    const w = { settings: { sandbox: { filesystem: { denyRead: denied } }, permissions: { deny: denied.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } } };
    writeFileSync(join(c.settingsDir, `${SA}.json`), JSON.stringify(w.settings));
    const A = { id: SA, product: 'p1', kind: 'editing', card: 'C-1', pgid: 4242, pid: 4242, pid_start: '2026-11-10T10:00:00Z', alive: true };
    const logs = []; let ran = false; const run = async () => { ran = true; };
    const go = (memory, groupGone) => main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => c0, log: (s) => logs.push(s), run, onStop: () => {}, memory: () => memory, ports: { groupGone } });
    assert.equal(await go({ sessions: [A], requests: {} }, () => false), 1);
    assert.match(logs.at(-1), new RegExp(`did not start: session ${SA} \\(product p1\\) started before product p2's folders were on its deny list`));
    assert.equal(await go({ sessions: [A] }, () => { throw new Error('can\'t tell'); }), 1, 'a group the port can\'t tell about is live');
    assert.equal(ran, false);
    // #378 self-review M2: a waiting start of an earlier run never keeps the runner down (it can't be shown gone); each
    // start checks it instead (runner-ports.test.mjs).
    assert.equal(await go({ sessions: [], requests: { [SA]: { state: 'waiting', card: 'C-1', product: 'p1' } } }, () => false), 0, logs.join('\n'));
    ran = false;
    // A's group shown gone, or A ended: the runner starts.
    assert.equal(await go({ sessions: [A] }, () => true), 0, logs.join('\n'));
    assert.equal(await go({ sessions: [{ ...A, alive: false }] }, () => false), 0, logs.join('\n'));
    assert.equal(await go({ sessions: [], requests: { [SA.replace('0f', '9f')]: { state: 'waiting', card: 'C-2', product: 'p1' } } }, () => false), 0, logs.join('\n'));
    assert.equal(ran, true);
    // #378 self-review M3: no memory while earlier sessions' settings files are there: a session may run unknown.
    assert.match(carriedOverProblem(c, {}, { groupGone: () => false }), new RegExp(`no memory, but its settings folder holds 1 earlier session's settings \\(${SA}\\.json\\)`));
    assert.equal(await go({}, () => false), 1); assert.match(logs.at(-1), /did not start: it has no memory/);
    // #378 r2 n4: a memory with empty lists is no memory either. n3 (A10): a settings folder that can't be listed refuses.
    assert.match(carriedOverProblem(c, { sessions: [], requests: {} }, { groupGone: () => false }), /no memory, but its settings folder holds 1/);
    assert.match(carriedOverProblem(c, {}, { groupGone: () => false, listSettings: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), /settings folder can't be listed \(EACCES\)/);
    // n3 (A11): a carried-over session that names no product can't be told about: the runner does not start.
    assert.match(carriedOverProblem(c, { sessions: [{ ...A, product: undefined }], requests: {} }, { groupGone: () => false }), /names no product/);
    // #528 r2 m3: an entry that is not a session refuses the start, never skipped as "not live" (I1).
    for (const x of [null, 'abc', 42, []]) assert.match(carriedOverProblem(c, { sessions: [x, { ...A, alive: false, ended: true }], requests: {} }, { groupGone: () => false }) ?? '', /lists a session that is not what the runner writes/, JSON.stringify(x));
    // A first run (no memory, no settings files) starts.
    rmSync(join(c.settingsDir, `${SA}.json`));
    assert.equal(carriedOverProblem(c, {}, { groupGone: () => false }), null);
    // #378 self-review M1: B's copies and outboxes denied, but not B's mirror: still a gap.
    const most = [...denied, join(d, 'copies', 'p2'), join(d, 'outboxes', 'p2')];
    writeFileSync(join(c.settingsDir, `${SA}.json`), JSON.stringify({ sandbox: { filesystem: { denyRead: most } }, permissions: { deny: most.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } }));
    assert.match(carriedOverProblem(c, { sessions: [A], requests: {} }, { groupGone: () => false }), new RegExp(`shell may read ${join(d, 'mirror2')}$|shell may read ${join(d, 'mirror2')}\\)`));
    const all = [...most, join(d, 'mirror2')];
    writeFileSync(join(c.settingsDir, `${SA}.json`), JSON.stringify({ sandbox: { filesystem: { denyRead: all } }, permissions: { deny: all.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } }));
    assert.equal(carriedOverProblem(c, { sessions: [A], requests: {} }, { groupGone: () => false }), null);
    // #463 r2 m5: its save settings must deny the later product too; none written is no gap, one unreadable refuses.
    const save = join(c.settingsDir, `${SA}.save.json`);
    writeFileSync(save, JSON.stringify({ sandbox: { filesystem: { denyRead: most } }, permissions: { deny: most.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } }));
    // A row with no save settings' hash is never saved: its file is not read.
    assert.equal(carriedOverProblem(c, { sessions: [A], requests: {} }, { groupGone: () => false }), null);
    const As = { ...A, save_settings_sha: 'a'.repeat(64) };
    // Self-review M-1: a stopped session (its group gone) is still to be saved, so its save settings count too.
    assert.match(carriedOverProblem(c, { sessions: [{ ...As, alive: false }], requests: {} }, { groupGone: () => true }), /save settings were written before product p2's folders/);
    assert.match(carriedOverProblem(c, { sessions: [As], requests: {} }, { groupGone: () => false }), new RegExp(`session ${SA} \\(product p1\\)'s save settings were written before product p2's folders were on their deny list \\(its shell may read ${join(d, 'mirror2')}\\)`));
    writeFileSync(save, JSON.stringify({ sandbox: { filesystem: { denyRead: all } }, permissions: { deny: all.flatMap((x) => [`Read(/${x}/**)`, `Edit(/${x}/**)`]) } }));
    assert.equal(carriedOverProblem(c, { sessions: [As], requests: {} }, { groupGone: () => false }), null);
    rmSync(save); symlinkSync(join(c.settingsDir, `${SA}.json`), save);
    assert.match(carriedOverProblem(c, { sessions: [As], requests: {} }, { groupGone: () => false }), /save settings can't be read \(ELOOP\)/, 'never through a link');
    rmSync(save);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L852: main\'s drain reads the Record\'s own fact file (M4 readFactFile): a file intake took is drained, one it has not is not', () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    const fdir = join(d, 'record', 'docs', 'fact'); mkdirSync(fdir, { recursive: true, mode: 0o755 });
    for (const f of [join(d, 'record'), join(d, 'record', 'docs'), fdir]) chmodSync(f, 0o755);
    const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const o = join(d, 'outboxes', 'p1', 'worker', SID); mkdirSync(o, { recursive: true });
    writeFileSync(join(o, 'report-C-1.md'), '{"a":1}');
    const p = realRunnerPorts(checkRunnerConfig(config(d, { recordUid: process.getuid(), orchestrateUid: process.getuid() + 1 })));
    const s = { id: SID, role: 'worker', card: 'C-1', outbox: o };
    const held = (cause) => ({ drained: false, cause });
    assert.deepEqual(p.outboxDrained(s), held('not-taken'), 'no fact yet');
    const id = `intake-applied-${SID}-report-C-1.md`;
    const doc = { session: SID, name: 'report-C-1.md', state: 'applied', sha256: createHash('sha256').update('{"a":1}').digest('hex') };
    writeFileSync(join(fdir, `${id}.json`), JSON.stringify({ entity: 'fact', id, rev: 1, doc }), { mode: 0o644 });
    assert.equal(p.outboxDrained(s), true, 'taken by the Record');
    writeFileSync(join(fdir, `${id}.json`), JSON.stringify({ entity: 'fact', id, rev: 2, doc: { ...doc, state: 'applying' } }), { mode: 0o644 });
    assert.deepEqual(p.outboxDrained(s), held('in-flight'), 'still in flight');
    // L898, L899: the card's bundle, taken by its push, read through the Record's own session and fact files.
    writeFileSync(join(fdir, `${id}.json`), JSON.stringify({ entity: 'fact', id, rev: 3, doc }), { mode: 0o644 });
    const bytes = Buffer.from([0x00, 0xff, 0x10]);
    writeFileSync(join(o, 'bundle-C-1.bundle'), bytes);
    assert.deepEqual(p.outboxDrained(s), held('record-unreadable'), 'a bundle with no session doc or push');
    const sdir = join(d, 'record', 'docs', 'session'); mkdirSync(sdir, { mode: 0o755 }); chmodSync(sdir, 0o755);
    writeFileSync(join(sdir, `${SID}.json`), JSON.stringify({ entity: 'session', id: SID, rev: 1, doc: { card: 'C-1', attempt: 'a1' } }), { mode: 0o644 });
    assert.deepEqual(p.outboxDrained(s), held('bundle-not-pushed'), 'no push fact yet');
    const push = { result: 'pushed', branch: 'card/c-1', tip: 'f'.repeat(40), bundle_sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(join(fdir, 'push.C-1.a1.json'), JSON.stringify({ entity: 'fact', id: 'push.C-1.a1', rev: 1, doc: push }), { mode: 0o644 });
    assert.equal(p.outboxDrained(s), true, 'the bundle its push took, and the report intake took');
    chmodSync(sdir, 0o777);
    assert.deepEqual(p.outboxDrained(s), held('record-unreadable'), 'a session folder others can write is not read');
    chmodSync(sdir, 0o755);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- L1001: the worker runner's budget (check 12) and Bob file list (check 13) ----
const PIN_OPTS = (d) => ({ budget: join(d, 'install', 'modules', 'M11-dispatcher', 'budget.mjs'), bobManifest: join(d, 'install', 'bob-manifest.json'),
  dispatcherRules: join(d, 'products', 'p1', 'rules', 'dispatcher-rules.json'), reviewStatusFile: join(d, 'review', 'status.json'), reviewUid: 503 });

test('L1001: the config\'s budget needs the snapshot, the review runner\'s status file and user; both files sit inside the copy', () => {
  const d = '/x';
  assert.equal(checkRunnerConfig(config(d, PIN_OPTS(d))).budget, PIN_OPTS(d).budget);
  for (const k of ['dispatcherRules', 'reviewStatusFile', 'reviewUid']) {
    const o = PIN_OPTS(d); delete o[k];
    assert.throws(() => checkRunnerConfig(config(d, o)), new RegExp(`config: ${k} must be set with budget`), k);
  }
  assert.throws(() => checkRunnerConfig(config(d, { ...PIN_OPTS(d), budget: '/elsewhere/budget.mjs' })), /config: budget must be inside installRoot/);
  assert.throws(() => checkRunnerConfig(config(d, { bobManifest: '/x/installed/m.json' })), /config: bobManifest must be inside installRoot/, 'a sibling spelled alike is not inside');
  assert.throws(() => checkRunnerConfig(config(d, { ...PIN_OPTS(d), budget: 'budget.mjs' })), /config: budget must be a full path/);
  assert.throws(() => checkRunnerConfig(config(d, { ...PIN_OPTS(d), reviewUid: -1 })), /config: reviewUid must be a uid/);
  // The Bob file list alone needs nothing else.
  assert.equal(checkRunnerConfig(config(d, { bobManifest: PIN_OPTS(d).bobManifest })).bobManifest, PIN_OPTS(d).bobManifest);
});

test('L1001: main stops when the budget or Bob file list is not root\'s alone in the copy, and otherwise loads each once for the ports', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const cfg = config(d, PIN_OPTS(d));
    // The real check: this test's copy is not root's, so the runner does not start.
    let logs = []; let ran = false;
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), run: async () => { ran = true; }, onStop: () => {} }), 1);
    assert.match(logs.join('\n'), /^the worker runner did not start: its budget or Bob file list is not root's alone in the installed copy: /m);
    assert.equal(ran, false);
    // Root's alone (stood in for): each is loaded once, with the runner's own status file and user, and handed to the ports.
    const loads = []; const reads = []; const got = [];
    const budget = { rules: {}, rec: {}, bandsNow: () => ({}), runningNow: () => [] };
    const opts = (o = {}) => ({ asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, run: async () => {},
      pinnedProblem: (root, files) => { got.push(['pinned', root, files]); return null; },
      loadBudget: async (file, c) => { loads.push([file, c]); return budget; }, readManifest: (f) => { reads.push(f); return '{"a.md":"x"}'; },
      portsOf: (c, ports, x) => { got.push(['ports', x.budget, x.bobManifest]); return realRunnerPorts(c, ports, x); }, ...o });
    logs = [];
    assert.equal(await main(['/cfg.json'], opts()), 0, logs.join('\n'));
    assert.deepEqual(got[0], ['pinned', cfg.installRoot, [cfg.budget, cfg.bobManifest]]);
    assert.equal(loads.length, 1); assert.equal(loads[0][0], cfg.budget);
    assert.equal(loads[0][1].workerStatusFile, cfg.statusFile); assert.equal(loads[0][1].workerUid, process.getuid());
    assert.equal(loads[0][1].dispatcherRules, cfg.dispatcherRules); assert.equal(loads[0][1].reviewUid, 503);
    assert.deepEqual(reads, [cfg.bobManifest]);
    assert.deepEqual(got[1], ['ports', budget, { 'a.md': 'x' }]);
    // One that can't be loaded, or answers nothing, is logged and leaves its check without a port; the runner still runs.
    for (const [o, said] of [[{ loadBudget: async () => { throw new Error('no snapshot'); } }, /the budget module could not be loaded \(no snapshot\); no session starts/],
      [{ loadBudget: async () => ({ rules: {} }) }, /the budget module gave no rules, rec, bandsNow and runningNow; no session starts/],
      // Each of the four is needed (BUDGET_PORTS, L1121 c2): one missing alone is refused.
      ...['rules', 'rec', 'bandsNow', 'runningNow'].map((k) => [{ loadBudget: async () => ({ ...budget, [k]: undefined }) }, /the budget module gave no rules, rec, bandsNow and runningNow; no session starts/]),
      [{ readManifest: () => '{not json' }, /the Bob file list could not be read/]]) {
      logs = []; got.length = 0;
      assert.equal(await main(['/cfg.json'], opts(o)), 0, logs.join('\n'));
      assert.match(logs.join('\n'), said);
      const p = got.find((g) => g[0] === 'ports');
      assert.equal(o.readManifest ? p[2] : p[1], null);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1001: the Bob file list is read only as root\'s own plain file, never through a link', () => {
  const d = tempDir('orch-rmain-');
  try {
    const f = join(d, 'm.json'); writeFileSync(f, '{}'); chmodSync(f, 0o644);
    assert.equal(readRootFile(f, { uid: process.getuid() }), '{}');
    assert.throws(() => readRootFile(f), /is not root's own plain file/, 'the test\'s own file is not root\'s');
    chmodSync(f, 0o664);
    assert.throws(() => readRootFile(f, { uid: process.getuid() }), /is not root's own plain file/);
    chmodSync(f, 0o644);
    const l = join(d, 'l.json'); symlinkSync(f, l);
    assert.throws(() => readRootFile(l, { uid: process.getuid() }), /ELOOP|link/);
    // L1207: a second name (a hard link) is refused by both names, and read again once it is gone.
    const h = join(d, 'h.json'); linkSync(f, h);
    for (const p of [f, h]) assert.throws(() => readRootFile(p, { uid: process.getuid() }), /has 2 names, not one/);
    rmSync(h); assert.equal(readRootFile(f, { uid: process.getuid() }), '{}');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1079 (I1): the runner runs as the builder user only (an allowed list, #528 r1 m1), never root or a person\'s user, checked first, before its config is read', async () => {
  const B = 'builder';
  assert.equal(personUserProblem(601, [601, 12, 61, 100, 701], B), null, 'the builder: its own group and the Mac\'s all-users groups');
  assert.match(personUserProblem(0, [0], 'root'), /runs as root/);
  // An allowed list (#528 r1 m1): any other user is refused, a setup user with none of a person's groups too.
  for (const n of ['orchestrate', 'review', 'pages', 'sam', 'Builder', 'builder ']) assert.match(personUserProblem(602, [602, 12], n), /only the builder user may run it/, n);
  for (const n of [null, undefined, '']) assert.match(personUserProblem(601, [601], n), /name can't be read/, String(n));
  assert.match(personUserProblem(501, [20, 12, 80], B), /in staff and admin \(a person's user\)/);
  assert.match(personUserProblem(601, [601, 20], B), /in staff/, 'the builder added to staff is a person\'s user to it');
  assert.match(personUserProblem(601, [601, 80], B), /in admin/);
  for (const g of [null, undefined, [], ['20'], [601, NaN]]) assert.match(personUserProblem(601, g, B), /groups can't be read/, String(g));
  const logs = []; let read = false;
  const code = await main(['/cfg.json'], { asUser: () => personUserProblem(501, [20, 80], 'builder'), readConfig: () => { read = true; return {}; }, log: (s) => logs.push(s) });
  assert.equal(code, 1);
  assert.equal(read, false, 'refused before the config is read');
  assert.match(logs.join('\n'), /did not start: it runs as a user in staff and admin/);
  assert.equal(await main(['/cfg.json'], { asUser: () => { throw new Error('no'); }, readConfig: () => { read = true; return {}; }, log: (s) => logs.push(s) }), 1);
  assert.equal(read, false);
  // The real default checks this process: a test run as a person's user is refused.
  const me = personUserProblem(process.getuid(), process.getgroups(), (await import('node:os')).userInfo().username);
  if (me) assert.equal(await main(['/cfg.json'], { readConfig: () => { read = true; return {}; }, log: () => {} }), 1);
});

test('L1079: a worker signs in with the owner\'s account choice, read from root\'s copy, in the builder\'s own account folders', async () => {
  const { workerAccount } = await import('./runner-ports.mjs');
  const c = { home: '/B/home/builder', accountCopy: '/B/account-copy.json' };
  const seen = [];
  const read = (r) => ({ file, uid }) => { seen.push([file, uid]); return r; };
  const b = workerAccount(c, { readCopy: read({ ok: true, account: 'b' }), setUp: () => true, inUse: () => assert.fail('the builder\'s own file is not the owner\'s choice') });
  assert.deepEqual(b, { account: 'b', dir: '/B/home/builder/.claude-b', env: { CLAUDE_CONFIG_DIR: '/B/home/builder/.claude-b' } });
  assert.deepEqual(seen, [['/B/account-copy.json', 0]], 'root\'s copy, owned by root');
  assert.deepEqual(workerAccount(c, { readCopy: read({ ok: true, account: 'a' }), setUp: () => true }), { account: 'a', dir: '/B/home/builder/.claude', env: {} });
  // PLANT: the copy unreadable → refused, never account a by default; the chosen account not set up → refused.
  assert.match(workerAccount(c, { readCopy: read({ ok: false, reason: 'x is missing' }), inUse: () => ({ account: 'a' }) }).reason, /owner's account choice could not be read \(x is missing\)/);
  assert.match(workerAccount(c, { readCopy: read({ ok: true, account: 'b' }), setUp: () => false }).reason, /account b \(the owner's choice\) is not set up in \/B\/home\/builder/);
  // No accountCopy: the builder home's own file, as before.
  assert.deepEqual(workerAccount({ home: '/h' }, { inUse: ({ home }) => ({ account: 'a', home }) }), { account: 'a', home: '/h' });
});

test('L1092: launchInputs, the one loader of checks 12 and 13 (the runner\'s and the runLocked proof\'s): root\'s alone first, each loaded once with the caller\'s user', async () => {
  const c = { installRoot: '/i', budget: '/i/b.mjs', bobManifest: '/i/m.json', statusFile: '/s.json', dispatcherRules: '/r' };
  const budget = { rules: {}, rec: {}, bandsNow: () => ({}), runningNow: () => [] };
  const loads = []; const logs = [];
  const r = await launchInputs(c, { pinnedProblem: () => null, uid: 777, log: (s) => logs.push(s),
    loadBudget: async (f, x) => { loads.push([f, x.workerUid, x.workerStatusFile]); return budget; }, readManifest: () => '{"a.md":"x"}' });
  assert.deepEqual(r, { budget, bobManifest: { 'a.md': 'x' } });
  assert.deepEqual(loads, [['/i/b.mjs', 777, '/s.json']]);
  assert.deepEqual(logs, []);
  // Not root's alone, or a check that throws: a problem, and nothing is loaded.
  for (const pinnedProblem of [() => 'b.mjs is 501\'s', () => { throw new Error('b.mjs is 501\'s'); }]) {
    loads.length = 0;
    const p = await launchInputs(c, { pinnedProblem, loadBudget: async () => { loads.push(1); return budget; }, readManifest: () => '{}' });
    assert.equal(p.problem, 'its budget or Bob file list is not root\'s alone in the installed copy: b.mjs is 501\'s');
    assert.equal(loads.length, 0);
  }
  // Neither in the config: no pinned check, both null.
  let asked = false;
  assert.deepEqual(await launchInputs({ installRoot: '/i' }, { pinnedProblem: () => { asked = true; return 'x'; } }), { budget: null, bobManifest: null });
  assert.equal(asked, false);
});

test('L1121 m1: readRunnerConfig is the runner\'s one config reading: budget is checked as a code file when named; no own path, no read', () => {
  const copy = tempDir('orch-rrc-');
  const file = join(copy, 'runner.json');
  writeFileSync(file, JSON.stringify({ installRoot: copy, budget: 'budget.mjs' }));
  // budget named as code (optionalCode): a relative path is refused before anything else is read. Planted: dropped or mistyped.
  assert.throws(() => readRunnerConfig(file, join(copy, 'wiring', 'runner-main.mjs')), /budget must be a full path/);
  assert.throws(() => readRunnerConfig(file, undefined), /its own script's path can't be read/);
});

test('L1121 m2: launchInputs\' own defaults are the real ones: a budget or Bob file list that is not root\'s stops the start, and nothing is loaded', async () => {
  if (process.getuid() === 0) return;
  const copy = tempDir('orch-li-');
  for (const k of ['budget', 'bobManifest']) {
    const f = join(copy, k === 'budget' ? 'b.mjs' : 'm.json');
    writeFileSync(f, k === 'budget' ? 'export const budget = () => { throw new Error("loaded"); };\n' : '{}');
    const r = await launchInputs({ installRoot: copy, [k]: f });
    assert.match(r.problem ?? '', /^its budget or Bob file list is not root's alone in the installed copy: /, k);
  }
  // The manifest's own reader is a second guard: with the first check let through, a file that is not root's still reads as no list.
  const m = join(copy, 'm.json');
  const said = [];
  const r2 = await launchInputs({ installRoot: copy, bobManifest: m }, { pinnedProblem: () => null, log: (t) => said.push(t) });
  assert.equal(r2.bobManifest, null, 'planted: the manifest read without the root-only check');
  assert.match(said.join('\n'), /the Bob file list could not be read \(.*is not root's own plain file\)/);
});

test('R-0b-175a: hookStateDir is optional, a folder apart from the Dispatcher\'s, the requests and every place a worker writes; start_timeout_s per interactive role', () => {
  const c = checkRunnerConfig(config('/x', { hookStateDir: '/x/hookstate', start_timeout_s: { lead: 90, minibase: 200 } }));
  assert.equal(c.hookStateDir, '/x/hookstate');
  assert.equal(checkRunnerConfig(config('/x')).hookStateDir, undefined, 'left out: no store');
  const bad = [
    [{ hookStateDir: 'hooks' }, /hookStateDir must be a full path/], [{ hookStateDir: '/x/runner/hooks' }, /apart from the runner's own folder/],
    [{ hookStateDir: '/x/requests' }, /apart from the runner's own folder/], [{ hookStateDir: '/x/outboxes/h' }, /must not sit in the outboxes/],
    [{ hookStateDir: '/x/home/h' }, /must not sit in the sessions' home/], [{ hookStateDir: '/x/mirror/h' }, /must not sit in product p1's mirror/],
    [{ start_timeout_s: { lead: 90 } }, /start_timeout_s needs hookStateDir/],
    [{ hookStateDir: '/x/h', start_timeout_s: { worker: 90 } }, /worker is not one of lead, frontDoor, minibase/],
    [{ hookStateDir: '/x/h', start_timeout_s: { lead: 0 } }, /start_timeout_s.lead must be seconds/],
    [{ hookStateDir: '/x/h', start_timeout_s: [] }, /seconds per interactive role/],
  ];
  for (const [over, re] of bad) assert.throws(() => checkRunnerConfig(config('/x', over)), re, JSON.stringify(over));
});

test('R-0b-175a: main opens the hook store in a 0700 folder it makes, hands it to the loop, and does not start on a folder others can open', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = []; let ctx;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { hookStateDir: join(d, 'hookstate'), start_timeout_s: { lead: 30 } }), log: (s) => logs.push(s), onStop: () => {},
      run: async (x) => { ctx = x; } });
    assert.equal(code, 0, logs.join('\n'));
    for (const f of ['hookstate', 'hookstate/hooks']) assert.equal(statSync(join(d, f)).mode & 0o777, 0o700, f);
    assert.equal(typeof ctx.hooks.tick, 'function'); assert.deepEqual(ctx.hooks.held(), []);
    assert.equal(ctx.hooks.addSession('lead-1', { role: 'lead', product: 'p1' }), true);
    assert.equal(statSync(join(d, 'hookstate', 'activity.json')).mode & 0o777, 0o600);
    // Without the key, the loop has no store.
    await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d), log: () => {}, onStop: () => {}, run: async (x) => { ctx = x; } });
    assert.equal('hooks' in ctx, false);
    chmodSync(join(d, 'hookstate'), 0o750);
    const l2 = [];
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { hookStateDir: join(d, 'hookstate') }), log: (s) => l2.push(s), onStop: () => {}, run: async () => assert.fail('ran') }), 1);
    assert.match(l2.join('\n'), /did not start: hookStateDir .* can be opened by others; it must be 0700/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R-0b-175a: hookStoreOf refuses a hook folder that is a link or another user\'s; an unreadable store file starts, held and said', async () => {
  const d = realpathSync.native(tempDir('orch-hooks-'));
  try {
    const c = { hookStateDir: join(d, 'hs') };
    mkdirSync(join(d, 'elsewhere'), { mode: 0o700 }); symlinkSync(join(d, 'elsewhere'), join(d, 'hs'));
    assert.throws(() => hookStoreOf(c), /is not a folder/);
    rmSync(join(d, 'hs'));
    assert.throws(() => hookStoreOf(c, { uid: process.getuid() + 1 }), /is not the owner's/);
    writeFileSync(join(d, 'hs', 'activity.json'), 'garbage', { mode: 0o600 });
    assert.match(hookStoreOf(c).broken, /the hook store can't be read/);
    const logs = [];
    const r = roots(tempDir('orch-rmain-'));
    try {
      mkdirSync(join(r, 'runner'), { recursive: true });
      assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(r, { hookStateDir: join(d, 'hs') }), log: (s) => logs.push(s), onStop: () => {}, run: async () => {} }), 0);
      assert.match(logs.join('\n'), /hook store can't be read .*no Lead, Front Door or Mini Base session is typed into until it is fixed by hand/);
    } finally { rmSync(r, { recursive: true, force: true }); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1125 gate: the worker runner holds any product whose rules do not say product.test_product: true', () => {
  const rulesOf = (v) => ({ rules: { flag: (k, o) => { assert.equal(k, 'product.test_product'); assert.deepEqual(o, { product: 'p1' }); if (v instanceof Error) throw v; return v; } } });
  assert.equal(testProductProblem(rulesOf(true), 'p1'), null);
  for (const v of [false, undefined, null, 'true', 1]) assert.match(testProductProblem(rulesOf(v), 'p1'), /p1's rules do not say product\.test_product: true; only a test product runs/, String(v));
  assert.match(testProductProblem(rulesOf(new Error('snapshot is stale')), 'p1'), /can't be read \(snapshot is stale\)/);
  for (const b of [null, {}, { rules: {} }]) assert.match(testProductProblem(b, 'p1'), /rules are not loaded .*no budget/);
  // In front of the snapshots' own hold: the gate's reason first; a test product gets the snapshots' answer.
  const seen = [];
  const held = testProductHeld(rulesOf(true), (p) => { seen.push(p); return p === 'p1' ? null : 'x'; });
  assert.equal(held('p1'), null); assert.deepEqual(seen, ['p1']);
  assert.match(testProductHeld(rulesOf(false), () => null)('p1'), /test_product/);
  assert.match(testProductHeld(null, () => null)('p1'), /not loaded/);
});

test('L1125 gate REAL rules: M10\'s own parser and engine (as M11 budget() builds them) read test_product from the rules text', async () => {
  const { parsePolicy } = await import('../modules/M10-rules/policy.mjs');
  const { makeEngine } = await import('../modules/M10-rules/engine.mjs');
  const { makeRules } = await import('../shared/rules.mjs');
  const fixture = readFileSync(new URL('../modules/M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8');
  assert.match(fixture, /^product:\n  cutover_stage: first\n/m, 'the fixture\'s product block, which the plants add to');
  const gate = (text) => {
    const p = parsePolicy(text); if (!p.ok) return `refused when read: ${p.reason}`;
    const engine = makeEngine({ products: ['p1'], rulesState: () => ({ status: 'ok', policy: p.policy, commit: 'a'.repeat(40), blob: 'b'.repeat(40) }), productState: () => null, running: () => 0, rolesDir: new URL('../roles', import.meta.url).pathname, clock: Date.now });
    return testProductProblem({ rules: makeRules(engine) }, 'p1');
  };
  const withFlag = (v) => fixture.replace(/^product:\n/m, `product:\n  test_product: ${v}\n`);
  assert.equal(gate(withFlag("'true'")), null, 'the orchestrate-test rules\' own spelling');
  assert.equal(gate(withFlag('true')), null);
  for (const v of ["'false'", 'false']) assert.match(gate(withFlag(v)), /do not say product\.test_product: true/, v);
  // Anything but true or false: M10 refuses the rules when it reads them (L1100, #550), so they never load and nothing runs.
  for (const v of ["'yes'", "'True'", '1']) assert.match(gate(withFlag(v)), /refused when read: .*product\.test_product must be true or false/, v);
  assert.match(gate(fixture), /do not say product\.test_product: true/, 'left out: held');
});

// R-S1-2: the product's install and test commands, and the hosts its install may reach, come only from its rules file
// (product_profile.commands, product_profile.registry_hosts), read at each start. The config can't carry them too.
test('R-S1-2: the config refuses render.product and render.registryHosts; the commands come only from the rules', () => {
  const d = '/T';
  for (const [k, v] of [['product', { commands: { install: 'npm ci', test: 'npm test' } }], ['registryHosts', []]]) {
    const c = config(d); c.products.p1.render[k] = v;
    assert.throws(() => checkRunnerConfig(c), new RegExp(`product p1: render\\.${k} is not taken: the commands and registry hosts come only from the product's rules file \\(product_profile\\.commands and product_profile\\.registry_hosts\\), read at each start`), k);
  }
  // productCommands: what the rules say, only text kept; no rules, or rules that can't be read, give none and say why.
  const rulesOf = (cmds, hosts) => ({ rules: { get: (k, o) => { assert.deepEqual(o, { product: 'p1' }); if (cmds instanceof Error) throw cmds; return k === 'product_profile.commands' ? cmds : hosts; } } });
  assert.deepEqual(productCommands(rulesOf({ install: 'true', test: 'npm test', bad: 7 }, ['registry.npmjs.org', 3]), 'p1'), { commands: { install: 'true', test: 'npm test' }, registryHosts: ['registry.npmjs.org'] });
  assert.deepEqual(productCommands(rulesOf(undefined, undefined), 'p1'), { commands: {}, registryHosts: [] }, 'left out: none, and the checks say which line to add');
  assert.match(productCommands(rulesOf(new Error('snapshot is stale')), 'p1').why, /p1's rules can't be read \(snapshot is stale\)/);
  for (const b of [null, {}, { rules: {} }]) assert.match(productCommands(b, 'p1').why, /rules are not loaded .*no budget/);
  assert.deepEqual(startDeps(checkRunnerConfig(config(d))).productRules('p1').commands, {}, 'startDeps reads them through the same budget');
});

// R-S1-2 REAL loader: the Dispatcher's snapshot on the disk, M11 budget() over it (M10's own parser and engine), the
// runner's startDeps reading it, and the worker's checks 4 and 11 wired from what it read, as startPort hands them on.
test('R-S1-2 REAL loader: a rules snapshot naming the commands wires checks 4 and 11; one naming none refuses both with the line to add', async () => {
  const { budget, writeRulesSnapshot } = await import('../modules/M11-dispatcher/budget.mjs');
  const { PRODUCT, UID, product, setup } = await import('../modules/M9-record/fixtures.test-helper.mjs');
  const { DESIGN_PROFILES } = await import('../modules/M4-workshop/launcher/role-profiles.mjs');
  const fixture = readFileSync(new URL('../modules/M10-rules/fixtures/policy.yaml', import.meta.url), 'utf8');
  const withCommands = `${fixture.trimEnd()}\n\nproduct_profile:\n  commands:\n    install: "true"\n    test: "test -s orchestrate/policy.yaml"\n  registry_hosts: []\n`;
  const env = setup({ prefix: 'm11-rs12-rec-' }); product(env);
  const dir = join(tempDir('m11-rs12-rules-'), 'rules'); mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
  const file = join(dir, 'dispatcher-rules.json'); const clock = { t: Date.parse('2026-11-11T12:00:00Z') };
  const snap = (text, commit = 'c'.repeat(40)) => assert.deepEqual(writeRulesSnapshot(file, { product: PRODUCT, products: [PRODUCT], now: clock.t,
    state: () => ({ status: 'ok', text, commit, blob: commit.replace(/./g, 'b'), fetchedAt: clock.t, policy: {}, rev: 'x', reason: 'fresh' }) }), { ok: true });
  const b = budget({ recordRoot: env.root, recordUid: UID, dispatcherRules: file, workerStatusFile: join(dir, 'w.json'), workerUid: UID,
    reviewStatusFile: join(dir, 'r.json'), reviewUid: UID, outboxRoot: env.outRoot }, { now: () => clock.t, io: { userName: () => null } });
  const c = checkRunnerConfig(config('/T', { products: { [PRODUCT]: { repo: 'o/p1', mirror: '/T/mirror', render: { paths: { deny: DENY('/T') } } } } }));
  const jobs = [];
  const sd = startDeps(c, { budget: b, runLocked: async (j) => { jobs.push(j); return { ok: true }; } });
  // As startPort does: one read, its commands and hosts handed to the checks.
  const checks = () => {
    const pr = sd.productRules(PRODUCT);
    return sd.checksFor({ role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: PRODUCT, sessionId: 'S-1', copy: '/T/copies/C-1', settings: { file: '/T/s.json', settings: {} },
      installCommand: pr.commands.install, testCommand: pr.commands.test, registryHosts: pr.registryHosts, ...(pr.why ? { rulesWhy: pr.why } : {}),
      renderPhase: () => ({ ok: true, settings: {} }), writeSettings: () => ({ ok: true }), throwaway: async () => ({ ok: false, reason: 'stand-in throwaway' }),
      spawn: () => { throw new Error('stand-in spawn'); } });
  };
  try {
    snap(withCommands);
    assert.deepEqual(sd.productRules(PRODUCT), { commands: { install: 'true', test: 'test -s orchestrate/policy.yaml' }, registryHosts: [] });
    const k = checks();
    assert.equal(typeof k[4], 'function'); assert.equal(typeof k[11], 'function');
    assert.deepEqual(await k[4](), { ok: true }, 'check 4 runs the rules\' install');
    assert.equal(jobs[0].command, 'true');
    const eleven = await k[11]();
    assert.doesNotMatch(eleven?.reason ?? '', /product_profile/, 'check 11 is the real check, not the missing-command refusal');
    // The same snapshot without the commands: both refuse, naming the exact line the rules file must add.
    clock.t += 60_000; snap(fixture, 'd'.repeat(40));
    const n = checks();
    assert.deepEqual(await n[4](), { ok: false, reason: `product ${PRODUCT}'s rules file (orchestrate/policy.yaml) names no product_profile.commands.install: add the exact install command there, or install: "true" if there is nothing to install` });
    assert.deepEqual(await n[11](), { ok: false, reason: `product ${PRODUCT}'s rules file (orchestrate/policy.yaml) names no product_profile.commands.test: add the exact command that runs its tests there` });
    assert.equal(jobs.length, 1, 'no install ran');
    // No budget at all: both refuse with why.
    const nb = startDeps(c, { runLocked: async () => ({ ok: true }) }).productRules(PRODUCT);
    assert.match(nb.why, /rules are not loaded/);
  } finally { rmSync(env.root, { recursive: true, force: true }); rmSync(dirname(dir), { recursive: true, force: true }); }
});

test('L1193: the config\'s wallStatus, when given, is a full path in its simplest form; left out, the config loads and every start is held', () => {
  const d = '/T';
  assert.doesNotThrow(() => checkRunnerConfig(config(d)));
  assert.doesNotThrow(() => checkRunnerConfig(config(d, { wallStatus: undefined })));
  for (const w of ['rel/status.json', '/a/../status.json', '/a//status.json', '/', '', 5]) assert.throws(() => checkRunnerConfig(config(d, { wallStatus: w })), /wallStatus must be a full path in its simplest form/, String(w));
});

// r1 Minor 4: with the builder sign-in, the lock-down runner and each start pass the token through launch check 9, and
// main wires the told reader (signinTold) into both. Plant P8 (dropping the reader on the way) fails this.
test('L1261: the sign-in reaches the lock-down runner and each start through check 9, and main wires signinTold into both', async () => {
  const V = `sk-ant-oat01-${'Wq7_z-'.repeat(15)}KK`;   // made up
  const who = () => ({ account: 'a', dir: '/h/builder/.claude', env: { [SIGNIN_TOKEN_VAR]: V }, signinToken: true });
  const c = checkRunnerConfig(config('/x', { signinFile: '/x/builder-signin/claude-signin' }));
  // The lock-down runner: its environment holds the token and passes check 9 (the one form).
  let made; lockedOf(c, { who, make: (o) => { made = o; return () => {}; }, base: { PATH: '/usr/bin' } });
  const env = made.envOf();
  assert.equal(env[SIGNIN_TOKEN_VAR], V);
  assert.equal(checkRoleEnv(env, { allowSigninToken: true }).ok, true);
  // Each start's check 9 lets it through only because the config names the file.
  assert.equal(workerCheckInputs(c, { product: 'p1', env }).allowSigninToken, true);
  assert.equal(workerCheckInputs(checkRunnerConfig(config('/x')), { product: 'p1', env }).allowSigninToken, false);
  // lockedWiring hands the same reader to the lock-down runner and to the start port.
  const counted = () => who();
  const w = lockedWiring(c, { account: counted, log: () => {} });
  assert.equal(w.startDeps.account, counted, 'the start port was not given the sign-in reader');
  assert.equal(typeof w.runLocked, 'function');
  // main: the reader it hands the ports is signinTold's (told once in the log), wrapping the one it was given.
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = []; let opts = null;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => config(d, { signinFile: join(d, 'builder-signin', 'claude-signin') }), log: (s) => logs.push(s), onStop: () => {},
      signinOf: who, portsOf: (cc, ports, o) => { opts = o; return realRunnerPorts(cc, ports, o); }, run: async () => {} });
    assert.equal(code, 0, logs.join('\n'));
    assert.equal(typeof opts?.account, 'function', 'main gave the ports no sign-in reader');
    assert.equal(opts.account().env[SIGNIN_TOKEN_VAR], V); opts.account();
    assert.equal(logs.filter((l) => /the builder sign-in file: read/.test(l)).length, 1, logs.join('\n'));
    assert.ok(!logs.join('\n').includes(V.slice(0, 20)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

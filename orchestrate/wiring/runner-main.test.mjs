// Part C, runner step 5: the worker runner's entry point and its LaunchAgent file. Nothing here loads a job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { spawnSync } from 'node:child_process';
import { writeSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { statusOf, statusText } from '../setup/builder-wall.mjs';
import { DENY_KEYS, personUserProblem, aclWriteEntries, carriedOverProblem, checkRunnerConfig, hookStoreOf, keepSnapshots, launchInputs, readRunnerConfig, snapshotFolderProblem, startDeps, listenStop, main, readRootFile, realRunnerPorts, testProductHeld, testProductProblem } from './runner-main.mjs';
import { RUNNER_JOB_LOG, RUNNER_JOB_UMASK, RUNNER_JOB_USER, fullPath, workerRunnerPlist } from './runner-job.mjs';
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
// #419 r4 M1: the snapshot folder's parent, and every folder above it, must be root's, which a test's own temp folder
// and the folders above it never are. `over` reads one folder as another owner and mode; `rootAbove` reads every folder
// above `dir` that the test's user owns as root's, its mode kept (as setup's <base>/worker-runner/ in root's folders).
const over = (base, dir, uid, mode) => (p) => { const st = base(p); return p === dir ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid, mode }) : st; };
const rootAbove = (dir, base = lstatSync) => (p) => { const st = base(p); return (p === '/' || dir.startsWith(`${p}/`)) && st.uid === process.getuid() ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0 }) : st; };
const rootParentCheck = (dir, o = {}) => snapshotFolderProblem(dir, { ...o, lstat: rootAbove(dir, o.lstat) });
const others = (dir, a, uid, mode) => `its folder ${dir} sits in ${a}, which others than root can change (its owner is uid ${uid}, mode ${mode})`;

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
  assert.match(t, /<array><string>\/usr\/local\/bin\/node<\/string><string>\/i\/wiring\/runner-main.mjs<\/string><string>\/i\/runner.json<\/string><\/array>/);
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

test('#369 r1 m2: main keeps each product\'s rules snapshot fresh for its life, and stops doing so at the end', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    mkdirSync(join(d, 'snapshots'), { mode: 0o755 }); chmodSync(join(d, 'snapshots'), 0o755);   // L926: a folder only the runner can write
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: join(d, 'snapshots', 'rules-p1.json') } } },
      p2: { repo: 'o/p2', mirror: join(d, 'mirror2'), render: { paths: { deny: DENY(d) } } } } });
    const kept = []; const logs = [];
    const fresh = (path, r) => { const k = { path, r, stopped: false }; kept.push(k); return { stop: () => { k.stopped = true; }, error: () => (path.endsWith('p1.json') ? Object.assign(new Error('x'), { code: 'ENOSPC' }) : null) }; };
    let during;
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, folderProblem: rootParentCheck, run: async () => { during = kept.map((k) => k.stopped); } });
    assert.equal(code, 0, logs.join('\n'));
    assert.deepEqual(kept.map((k) => [k.path, k.r]), [[join(d, 'snapshots', 'rules-p1.json'), rules]], 'only a product with rules and a snapshot');
    assert.deepEqual(during, [false], 'kept fresh while the loop runs'); assert.equal(kept[0].stopped, true, 'stopped at the end');
    assert.ok(logs.some((l) => /p1's rules snapshot stopped being kept fresh \(ENOSPC\)/.test(l)), logs.join('\n'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#369 r2 m2: a product whose rules snapshot is not kept fresh is held back, saying why once, until its refresher starts again; each product its own', () => {
  const rules = { production: { env_files: [], programs: [], hosts: [] } };
  const c = { products: { p1: { rules, render: { paths: { snapshot: '/r/rules-p1.json' } } }, p2: { rules, render: { paths: { snapshot: '/r/rules-p2.json' } } }, p3: { render: { paths: {} } } } };
  const logs = []; const made = []; const dead = new Set(); let p2Fails = 1;
  const fresh = (path) => { if (path.endsWith('p2.json') && p2Fails-- > 0) throw Object.assign(new Error('x'), { code: 'EACCES' });
    const k = { path, stopped: false }; made.push(k); return { stop: () => { k.stopped = true; }, error: () => (dead.has(k) ? Object.assign(new Error('x'), { code: 'ENOSPC' }) : null) }; };
  const s = keepSnapshots(c, { fresh, log: (t) => logs.push(t) });
  assert.equal(s.held('p1'), null); assert.equal(s.held('p3'), null, 'no rules: nothing to keep');
  // p2's first write failed: the next start tries again, and it now works.
  assert.equal(s.held('p2'), null); assert.ok(logs.some((l) => /p2's rules snapshot is kept fresh again/.test(l)));
  // p1's refresher dies (p2's is untouched): its start tries again; while that fails too it is held back, told once.
  dead.add(made[0]);
  let n = 0; const realFresh = fresh;
  const s2 = keepSnapshots(c, { fresh: (path, r) => { if (path.endsWith('p1.json') && ++n > 1) throw Object.assign(new Error('x'), { code: 'ENOSPC' }); return realFresh(path, r); }, log: (t) => logs.push(t) });
  dead.add(made.at(-2));
  logs.length = 0;
  assert.match(s2.held('p1'), /p1's rules snapshot is not kept fresh \(ENOSPC\), so its sessions are not started/);
  assert.match(s2.held('p1'), /not kept fresh/);
  assert.equal(logs.filter((l) => /p1's rules snapshot is not kept fresh/.test(l)).length, 1, 'told once');
  assert.equal(made.at(-2).stopped, true, 'the dead refresher is stopped');
  assert.equal(s2.held('p2'), null, 'the other product starts');
  s.stop(); s2.stop();
  // L942 c5: while kept fresh, its folder is checked again at each start; one that now fails (its owner gave itself an
  // access list entry, or renamed it away) holds the product, told once, until it passes again.
  let bad = null; const seen = []; logs.length = 0;
  const s3 = keepSnapshots(c, { fresh, log: (t) => logs.push(t), recheck: (path) => { seen.push(path); return bad; } });
  assert.equal(s3.held('p1'), null);
  assert.ok(seen.length === 1 && seen[0].endsWith('p1.json'), JSON.stringify(seen));
  bad = 'its folder /s has an access list entry that lets others write (0: user:me allow delete)';
  assert.equal(s3.held('p1'), `product p1's rules snapshot: ${bad}, so its sessions are not started`);
  s3.held('p1');
  assert.equal(logs.filter((l) => /p1's rules snapshot: its folder \/s has an access list entry/.test(l)).length, 1, 'told once');
  // A new reason while held is told too (L942 self-review m4).
  bad = 'its folder /s is missing: make it'; s3.held('p1'); s3.held('p1');
  assert.equal(logs.filter((l) => /p1's rules snapshot: its folder \/s is missing/.test(l)).length, 1, 'the new reason told once');
  bad = 'its folder /s has an access list entry that lets others write (0: user:me allow delete)';
  assert.equal(s3.held('p2'), `product p2's rules snapshot: ${bad}, so its sessions are not started`);
  bad = null;
  assert.equal(s3.held('p1'), null);
  const s4 = keepSnapshots(c, { fresh, recheck: () => { throw new Error('ls failed'); } });
  assert.match(s4.held('p1'), /p1's rules snapshot: it can't be checked \(ls failed\), so its sessions are not started/);
  s3.stop(); s4.stop();
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

test('#369 r2 m2 self-review: main gives the start port its keeper, so a product whose snapshot is not kept fresh starts nothing; a die, a restart that works, a die again', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    mkdirSync(join(d, 'snapshots'), { mode: 0o755 }); chmodSync(join(d, 'snapshots'), 0o755);   // L926: a folder only the runner can write
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: join(d, 'snapshots', 'rules-p1.json') } } } } });
    const logs = []; let r;
    const fresh = () => { throw Object.assign(new Error('x'), { code: 'EROFS' }); };
    const go = (o) => main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, folderProblem: rootParentCheck,
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
    // A test product (the gate passes): the snapshot's own hold.
    assert.equal(await go({ testProduct: TEST_PRODUCT_OK }), 0, logs.join('\n'));
    assert.equal(r.ok, false); assert.match(r.reason, /p1's rules snapshot is not kept fresh \(EROFS\)/);
  } finally { rmSync(d, { recursive: true, force: true }); }
  // The cycle: dies, a restart works (told), dies again (told again), a restart fails (held, told once).
  const rules = { production: {} };
  const c = { products: { p1: { rules, render: { paths: { snapshot: '/r/rules-p1.json' } } } } };
  const logs = []; const made = []; let failNext = false;
  const fresh = () => { if (failNext) throw Object.assign(new Error('x'), { code: 'ENOSPC' }); const k = { dead: false, stopped: false }; made.push(k);
    return { stop: () => { k.stopped = true; }, error: () => (k.dead ? new Error('gone') : null) }; };
  const s = keepSnapshots(c, { fresh, log: (t) => logs.push(t) });
  made[0].dead = true;
  assert.equal(s.held('p1'), null); assert.equal(made[0].stopped, true); assert.equal(made.length, 2);
  made[1].dead = true;
  assert.equal(s.held('p1'), null); assert.equal(made[1].stopped, true); assert.equal(made.length, 3);
  assert.equal(logs.filter((l) => /kept fresh again/.test(l)).length, 2);
  made[2].dead = true; failNext = true;
  assert.match(s.held('p1'), /ENOSPC/); assert.match(s.held('p1'), /ENOSPC/);
  assert.equal(logs.filter((l) => /is not kept fresh/.test(l)).length, 1);
  failNext = false;
  assert.equal(s.held('p1'), null, 'and back once a restart works');
  s.stop(); assert.equal(made.at(-1).stopped, true);
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

test('L926 (#419 r3 M1, r4 M1): the snapshot\'s folder is decided on the disk: the runner\'s user\'s own real folder, in a folder of root\'s alone, under folders no one else can change', () => {
  const d = realpathSync(tempDir('orch-rmain-'));
  try {
    const ok = join(d, 'snaps'); mkdirSync(ok); chmodSync(ok, 0o755);
    assert.equal(rootParentCheck(ok), null);
    // #419 r4 M1, the real uid and the real disk: the runner's sessions are the runner's own user, so a folder whose parent
    // is that user's is refused: here the test's temp folder (the user's own temp folder, a folder under it), and a folder
    // made right in it, owned by the runner's user.
    const me = process.getuid();
    const notRoots = (dir, uid, mode) => `its folder ${dir} sits in ${dirname(dir)}, which is not root's alone (its owner is uid ${uid}, mode ${mode}): the runner's sessions are the runner's own user, so only a folder of root's that no one else can write keeps them from moving this one`;
    assert.equal(lstatSync(d).uid, me);
    assert.equal(snapshotFolderProblem(ok).reason, notRoots(ok, me, '0700'));
    if (process.platform === 'darwin' && existsSync(`/private/tmp/claude-${me}`)) {
      // claude's per-user sandbox temp folder sits in /private/tmp, root's but anyone's to write (sticky is not enough
      // here); a folder under it sits in the user's own folder.
      const sand = `/private/tmp/claude-${me}`;
      assert.equal(snapshotFolderProblem(sand).reason, notRoots(sand, 0, '1777'));
      const child = readdirSync(sand, { withFileTypes: true }).find((e) => e.isDirectory() && !e.isSymbolicLink());
      if (child) { const c = join(sand, child.name); const st = lstatSync(c); if (st.uid === me && !(st.mode & 0o022)) assert.equal(snapshotFolderProblem(c).reason, notRoots(c, me, (lstatSync(sand).mode & 0o7777).toString(8).padStart(4, '0'))); }
    }
    // The parent's mode and access list: root's with a group write bit, or sticky and anyone's, is refused; so is an
    // access list write entry on it (read by the walk up).
    assert.equal(snapshotFolderProblem(ok, { lstat: over(lstatSync, d, 0, 0o40775) }).reason, notRoots(ok, 0, '0775'));
    assert.equal(snapshotFolderProblem(ok, { lstat: over(lstatSync, d, 0, 0o41777) }).reason, notRoots(ok, 0, '1777'));
    assert.equal(snapshotFolderProblem(ok, { lstat: (p) => { if (p === d) throw Object.assign(new Error('no'), { code: 'EACCES' }); return lstatSync(p); } }).reason, `its folder ${ok} sits in ${d}, which can't be read (EACCES)`);
    const entry0 = '0: group:everyone allow add_file';
    assert.equal(rootParentCheck(ok, { aclWrites: (p) => (p === d ? [entry0] : []) }).reason, `its folder ${ok} sits in ${d}, which has an access list entry that lets others write (${entry0})`);
    // #433's layout passes: <base> and <base>/worker-runner root's 0755, snapshots/ the runner's user's 0755.
    const base = join(d, 'base'); const wr = join(base, 'worker-runner'); const snaps = join(wr, 'snapshots');
    mkdirSync(snaps, { recursive: true }); chmodSync(base, 0o755); chmodSync(wr, 0o755); chmodSync(snaps, 0o755);
    assert.equal(snapshotFolderProblem(snaps, { lstat: rootAbove(base, over(over(lstatSync, base, 0, 0o40755), wr, 0, 0o40755)) }), null, '<base>/worker-runner/snapshots');
    assert.equal(snapshotFolderProblem(snaps, { lstat: rootAbove(base, over(lstatSync, base, 0, 0o40755)) }).reason, notRoots(snaps, me, '0755'), 'worker-runner/ the user\'s: refused');
    // L939 self-review M-A: the same layout with <base> in a folder of the user's (here d) is refused, whatever is root's
    // below it: a session may rename <base> there, snapshots and all.
    assert.equal(snapshotFolderProblem(snaps, { lstat: over(over(lstatSync, base, 0, 0o40755), wr, 0, 0o40755) }).reason, others(snaps, d, me, '0700'), '<base> in the user\'s folder');
    assert.equal(snapshotFolderProblem(snaps, { lstat: rootAbove(d, over(over(lstatSync, base, 0, 0o40755), wr, 0, 0o40755)) }).reason, others(snaps, d, me, '0700'), 'only that one folder the user\'s');
    // Missing: held, saying which folder to make, where its parent passes the rule for the folders above it (L942 m2).
    assert.deepEqual(rootParentCheck(join(d, 'none')), { missing: true, reason: `its folder ${join(d, 'none')} is missing: make it, owned by the runner's user, mode 0755, in a folder of root's that no one else can write (setup does not make it yet)` });
    // Its parent the user's (as the test's temp folder), or one above it not root's: refused for that, not "missing".
    assert.deepEqual(snapshotFolderProblem(join(d, 'none')), { missing: false, reason: notRoots(join(d, 'none'), me, '0700') });
    const up = join(d, 'up'); mkdirSync(up, { mode: 0o755 });
    assert.deepEqual(snapshotFolderProblem(join(up, 'none'), { lstat: over(rootAbove(join(up, 'none')), d, me, 0o40755) }), { missing: false, reason: others(join(up, 'none'), d, me, '0755') });
    rmSync(up, { recursive: true });
    assert.match(rootParentCheck(join(d, 'none'), { aclWrites: (p) => (p === d ? ['0: group:everyone allow add_file'] : []) }).reason, /sits in .*, which has an access list entry that lets others write \(0: group:everyone allow add_file\)$/);
    // L942 self-review: its parent reached through a link is refused (as /tmp is /private/tmp); one that can't be read
    // is refused for that, not "missing"; a path that is not full is refused.
    const ln = join(d, 'ln'); symlinkSync(d, ln);
    assert.deepEqual(rootParentCheck(join(ln, 'none')), { missing: false, reason: `its folder ${join(ln, 'none')} sits in ${ln}, which is reached through a link (it is ${d})` });
    rmSync(ln);
    if (process.platform === 'darwin') assert.match(snapshotFolderProblem('/tmp/orch-none-here').reason, /sits in \/tmp, which is reached through a link \(it is \/private\/tmp\)/);
    const eacces = (p) => { if (p === d) throw Object.assign(new Error('no'), { code: 'EACCES' }); return lstatSync(p); };
    assert.deepEqual(snapshotFolderProblem(join(d, 'none'), { lstat: (p) => (p === join(d, 'none') ? lstatSync(p) : eacces(p)) }), { missing: false, reason: `its folder ${join(d, 'none')} sits in ${d}, which can't be read (EACCES)` });
    assert.deepEqual(snapshotFolderProblem('rel/none'), { missing: false, reason: 'its folder rel/none is not a full path' });
    // Its parent missing too: held, saying which folder to make (setup makes the parents).
    assert.deepEqual(snapshotFolderProblem(join(d, 'gone', 'none')), { missing: true, reason: `its folder ${join(d, 'gone', 'none')} is missing: make it, owned by the runner's user, mode 0755, in a folder of root's that no one else can write (setup does not make it yet)` });
    // A link into a worker's copy, and a folder reached through one.
    const card = join(d, 'copies', 'p1', 'card'); mkdirSync(card, { recursive: true });
    symlinkSync(card, join(d, 'link'));
    assert.deepEqual(snapshotFolderProblem(join(d, 'link')), { missing: false, reason: `its folder ${join(d, 'link')} is a link` });
    mkdirSync(join(card, 'sub')); symlinkSync(join(d, 'copies'), join(d, 'via'));
    assert.match(snapshotFolderProblem(join(d, 'via', 'p1', 'card', 'sub')).reason, /is reached through a link \(it is .*copies\/p1\/card\/sub\)$/);
    // Group or other writable.
    for (const mode of [0o775, 0o757, 0o777]) { chmodSync(ok, mode); assert.match(snapshotFolderProblem(ok).reason, /can be written by others than the runner/, mode.toString(8)); }
    chmodSync(ok, 0o755);
    // A folder another Mac user owns (the runner told it is another uid), and one in a folder another user owns.
    assert.equal(snapshotFolderProblem(ok, { uid: me + 1 }).reason, `its folder ${ok} is not owned by the runner's user (its owner is uid ${me}, the runner is ${me + 1})`);
    const otherOwns = (dir) => (p) => { const st = lstatSync(p); return p === dir ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: me + 7 }) : st; };
    assert.equal(snapshotFolderProblem(ok, { lstat: otherOwns(d) }).reason, notRoots(ok, me + 7, '0700'));
    // Its parent anyone's to write.
    chmodSync(d, 0o777);
    assert.equal(snapshotFolderProblem(ok).reason, notRoots(ok, me, '0777'));
    chmodSync(d, 0o700);
    // Every folder up, not only the parent (self-review m2): two levels up, others can write.
    const deep = join(d, 'a', 'snaps'); mkdirSync(deep, { recursive: true }); chmodSync(join(d, 'a'), 0o755); chmodSync(deep, 0o755);
    assert.equal(rootParentCheck(deep), null);
    chmodSync(d, 0o777);
    assert.equal(rootParentCheck(deep).reason, others(deep, d, 0, '0777'));
    chmodSync(d, 0o700);
    assert.equal(rootParentCheck(deep, { lstat: otherOwns(d) }).reason, others(deep, d, me + 7, '0700'));
    // Sticky (self-review m3): a folder anyone may write but only its owners rename in passes when root's; not sticky, or
    // not root's or the runner's, it does not.
    const asIf = (dir, uid, mode) => (p) => { const st = lstatSync(p); return p === dir ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid, mode }) : st; };
    assert.equal(rootParentCheck(deep, { lstat: asIf(d, 0, 0o41777) }), null, 'root\'s, sticky');
    assert.equal(rootParentCheck(deep, { lstat: asIf(d, 0, 0o40777) }).reason, others(deep, d, 0, '0777'), 'root\'s, not sticky');
    assert.equal(rootParentCheck(deep, { lstat: asIf(d, me + 7, 0o41777) }).reason, others(deep, d, me + 7, '1777'), 'another\'s, sticky');
    // The runner's user's, as a home folder (M-A): every folder above it root's, its parent root's, it the user's.
    assert.equal(snapshotFolderProblem(deep, { lstat: over(rootAbove(d, asIf(d, me, 0o40755)), join(d, 'a'), 0, 0o40755) }).reason, others(deep, d, me, '0755'), 'the runner\'s user\'s, as a home folder (M-A)');
    // An access list entry that lets others write, on the folder or one above it (self-review M1); a deny entry is fine.
    const entry = '0: group:everyone allow add_file,delete_child';
    assert.equal(rootParentCheck(deep, { aclWrites: (p) => (p === deep ? [entry] : []) }).reason, `its folder ${deep} has an access list entry that lets others write (${entry})`);
    assert.equal(rootParentCheck(deep, { aclWrites: (p) => (p === d ? [entry] : []) }).reason, `its folder ${deep} sits in ${d}, which has an access list entry that lets others write (${entry})`);
    assert.match(rootParentCheck(deep, { aclWrites: () => { throw new Error('ls failed'); } }).reason, /access list can't be read \(ls failed\)/);
    const ls = (out) => () => ({ status: 0, stdout: out });
    assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls('drwxr-xr-x+ 51 u staff 1 Nov 10 /x\n 0: group:everyone deny delete\n') }), []);
    assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls('drwxr-xr-x+ 2 u staff 1 Nov 10 /x\n 0: user:w inherited allow list,add_subdirectory\n 1: group:everyone allow list,search\n') }), ['0: user:w inherited allow list,add_subdirectory']);
    // #419 r4 m1: a name with a space, a line it can't parse and a right it doesn't know are write entries; a deny, and an
    // allow of reading only, are not, whatever the name.
    const spaced = ['0: group:Domain Users allow add_file', '1: group:Domain Users allow list,search,readattr', '2: group:Domain Users deny add_file,delete',
      '3: user:Some One inherited allow list,delete_child', '4: something this does not know', '5: group:everyone allow frobnicate', '6: user:a allow b inherited allow list'];
    assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls(`drwxr-xr-x+ 2 u staff 1 Nov 10 /x\n${spaced.map((l) => ` ${l}`).join('\n')}\n`) }), [spaced[0], spaced[3], spaced[4], spaced[5]]);
    // L942 m3: every right chmod(1) "ACL MANIPULATION" names that changes something, alone and among harmless ones, in an
    // allow entry (inherited or not), is a write entry; every harmless one alone is not.
    const WRITES = ['add_file', 'add_subdirectory', 'delete_child', 'delete', 'writeattr', 'writeextattr', 'writesecurity', 'chown', 'write', 'append'];
    for (const right of WRITES) for (const line of [`0: user:w allow ${right}`, `0: group:everyone inherited allow list,${right},search`, `0: user:Some One allow readattr,${right}`]) {
      assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls(`drwxr-xr-x+ 2 u staff 1 Nov 10 /x\n ${line}\n`) }), [line], line);
    }
    for (const right of ['read', 'list', 'search', 'execute', 'readattr', 'readextattr', 'readsecurity', 'file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit']) {
      assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls(`drwxr-xr-x+ 2 u staff 1 Nov 10 /x\n 0: user:w allow ${right}\n`) }), [], right);
    }
    // L942 m1: a line after the folder's own that is not numbered is a write entry, not skipped; the folder's own line
    // runs on one line more for each newline in its path, and only those are skipped. Empty lines are nothing.
    assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls('drwxr-xr-x+ 2 u staff 1 Nov 10 /x\n user:w allow add_file\n\n 0: user:a allow list\n') }), ['user:w allow add_file']);
    assert.deepEqual(aclWriteEntries('/x', { platform: 'darwin', run: ls('drwxr-xr-x+ 2 u staff 1 Nov 10 /x\nmore of a name\n') }), ['more of a name']);
    assert.deepEqual(aclWriteEntries('/a\nb', { platform: 'darwin', run: ls('drwxr-xr-x+ 2 u staff 1 Nov 10 /a\nb\n 0: user:a allow list\n') }), [], 'a newline in the path is part of its own line');
    assert.deepEqual(aclWriteEntries('/a\nb', { platform: 'darwin', run: ls('drwxr-xr-x+ 2 u staff 1 Nov 10 /a\nb\n 0: user:w allow add_file\nextra\n') }), ['0: user:w allow add_file', 'extra']);
    assert.throws(() => aclWriteEntries('/x', { platform: 'darwin', run: () => ({ status: 1, stdout: '' }) }), /ls -lde failed/);
    assert.deepEqual(aclWriteEntries('/x', { platform: 'linux', run: () => { throw new Error('not run'); } }), []);
    if (process.platform === 'darwin') {
      // The real reader, with a real entry.
      assert.equal(spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', deep]).status, 0);
      assert.match(rootParentCheck(deep).reason, /has an access list entry that lets others write \(0: group:everyone allow add_file,delete_child\)/);
      assert.equal(spawnSync('/bin/chmod', ['-N', deep]).status, 0);
      assert.equal(rootParentCheck(deep), null);
      // A case that differs from the disk's is told so, not called a link (self-review m7).
      assert.equal(rootParentCheck(deep.replace('/snaps', '/SNAPS')).reason, `its folder ${deep.replace('/snaps', '/SNAPS')} is spelled otherwise on the disk (it is ${deep})`);
    }
    // The temp folder: /tmp is a link, and /private/tmp is root's and anyone's to write.
    if (process.platform === 'darwin') {
      assert.match(snapshotFolderProblem('/tmp').reason, /^its folder \/tmp is (a link|reached through a link)/);
      assert.match(snapshotFolderProblem('/private/tmp').reason, /^its folder \/private\/tmp is not owned by the runner's user/);
    }
  } finally { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); }
});

test('L926 (#419 r3 M1, c2): main refuses to start for a snapshot folder linked into a copy, nothing written there; a missing one holds the product, named, and is checked again, folder and all, at each try', async () => {
  const d = roots(tempDir('orch-rmain-'));
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const card = join(d, 'copies', 'p1', 'card'); mkdirSync(card, { recursive: true });
    symlinkSync(card, join(d, 'snapshots'));
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: join(d, 'snapshots', 'rules-p1.json') } } } } });
    const logs = []; const wrote = [];
    // The fake refresher really writes (self-review m5): a write through the link would put a file in the copy.
    const fresh = (path, r) => { writeSnapshot(path, r); wrote.push(path); return { stop: () => {}, error: () => null }; };
    let ran = false; let locked = 0;
    const lock = (dir) => { locked++; return makeLock({ dir }); };
    const code = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, lock, run: async () => { ran = true; } });
    assert.equal(code, 1); assert.equal(ran, false); assert.deepEqual(wrote, []);
    assert.equal(locked, 0, 'refused before the lock (self-review m4)'); assert.equal(existsSync(join(d, 'runner', 'settings')), false, 'and before settings/ is made');
    assert.ok(logs.some((l) => l === `the worker runner did not start: product p1's rules snapshot: its folder ${join(d, 'snapshots')} is a link`), logs.join('\n'));
    assert.deepEqual(readdirSync(card), [], 'nothing written in the copy');
    // #419 r4 M1, with main's own check and the real uid: a right folder whose parent is the runner's user's (here the
    // test's temp folder) is refused before the lock, nothing written.
    rmSync(join(d, 'snapshots')); mkdirSync(join(d, 'snapshots')); chmodSync(join(d, 'snapshots'), 0o755); logs.length = 0;
    assert.equal(await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, run: async () => { ran = true; } }), 1);
    assert.equal(ran, false); assert.deepEqual(wrote, []); assert.deepEqual(readdirSync(join(d, 'snapshots')), []);
    assert.ok(logs.some((l) => l.startsWith(`the worker runner did not start: product p1's rules snapshot: its folder ${join(d, 'snapshots')} sits in ${d}, which is not root's alone (its owner is uid ${process.getuid()}, mode `)), logs.join('\n'));
    // Missing: the runner starts, the product is held, saying which folder to make; made as a link later, still held;
    // made right, kept fresh.
    rmSync(join(d, 'snapshots'), { recursive: true });
    logs.length = 0; const reasons = [];
    const start = (ctx) => ctx.ports.start({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    const code2 = await main(['/cfg.json'], { asUser: AS_BUILDER, readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, folderProblem: rootParentCheck, testProduct: TEST_PRODUCT_OK, ...WALL_OK, run: async (ctx) => {
      reasons.push((await start(ctx)).reason);
      symlinkSync(card, join(d, 'snapshots'));
      reasons.push((await start(ctx)).reason);
      rmSync(join(d, 'snapshots')); mkdirSync(join(d, 'snapshots')); chmodSync(join(d, 'snapshots'), 0o755);
      await start(ctx);
      // L942 c5: kept fresh, but its own access list changed since: the next start checks the folder again and holds it.
      if (process.platform === 'darwin') {
        assert.equal(spawnSync('/bin/chmod', ['+a', 'everyone allow delete', join(d, 'snapshots')]).status, 0);
        reasons.push((await start(ctx)).reason);
        assert.equal(spawnSync('/bin/chmod', ['-N', join(d, 'snapshots')]).status, 0);
        reasons.push((await start(ctx)).reason);
      }
    } });
    assert.equal(code2, 0, logs.join('\n'));
    const missing = `its folder ${join(d, 'snapshots')} is missing: make it, owned by the runner's user, mode 0755, in a folder of root's that no one else can write (setup does not make it yet)`;
    assert.ok(logs.some((l) => l === `product p1's rules snapshot can't be written (${missing}); its sessions are refused`), logs.join('\n'));
    assert.equal(reasons[0], `product p1's rules snapshot is not kept fresh (${missing}), so its sessions are not started`);
    assert.equal(reasons[1], `product p1's rules snapshot is not kept fresh (its folder ${join(d, 'snapshots')} is a link), so its sessions are not started`);
    assert.deepEqual(readdirSync(card), [], 'nothing written in the copy');
    assert.deepEqual(wrote, [join(d, 'snapshots', 'rules-p1.json')], 'written once the folder is right');
    if (process.platform === 'darwin') {
      assert.equal(reasons[2], `product p1's rules snapshot: its folder ${join(d, 'snapshots')} has an access list entry that lets others write (0: group:everyone allow delete), so its sessions are not started`);
      assert.doesNotMatch(String(reasons[3]), /rules snapshot/, 'cleared, it starts again');
    }
    assert.ok(logs.some((l) => /p1's rules snapshot is kept fresh again/.test(l)), logs.join('\n'));
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

test('L1193: the config\'s wallStatus, when given, is a full path in its simplest form; left out, the config loads and every start is held', () => {
  const d = '/T';
  assert.doesNotThrow(() => checkRunnerConfig(config(d)));
  assert.doesNotThrow(() => checkRunnerConfig(config(d, { wallStatus: undefined })));
  for (const w of ['rel/status.json', '/a/../status.json', '/a//status.json', '/', '', 5]) assert.throws(() => checkRunnerConfig(config(d, { wallStatus: w })), /wallStatus must be a full path in its simplest form/, String(w));
});

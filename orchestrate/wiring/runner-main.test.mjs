// Part C, runner step 5: the worker runner's entry point and its LaunchAgent file. Nothing here loads a job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { DENY_KEYS, checkRunnerConfig, keepSnapshots, startDeps, listenStop, main, realRunnerPorts } from './runner-main.mjs';
import { RUNNER_JOB_LOG, RUNNER_JOB_UMASK, fullPath, workerRunnerPlist } from './runner-job.mjs';

const config = (d, over = {}) => ({ installRoot: join(d, 'install'), requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json'), orchestrateUid: 501,
  outboxRoot: join(d, 'outboxes'), copiesRoot: join(d, 'copies'), home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: join(d, 'install', 'claude'),
  recordRoot: join(d, 'record'), recordUid: 501, claimMs: 600_000, products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { deny: DENY(d) } } } }, ...over });
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
  const d = tempDir('orch-rmain-');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = []; let stop; let ctx;
    const code = await main(['/cfg.json'], { readConfig: () => config(d), log: (s) => logs.push(s), onStop: (fn) => { stop = fn; },
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
  const d = tempDir('orch-rmain-');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const logs = [];
    let ran = false;
    const run = async () => { ran = true; };
    assert.equal(await main(['/cfg.json'], { readConfig: () => { throw new Error('job config /cfg.json: is owned by uid 9'); }, log: (s) => logs.push(s), run }), 1);
    assert.match(logs.at(-1), /did not start: job config/);
    const other = makeLock({ dir: join(d, 'runner') }); const h = other.acquire();
    try {
      assert.equal(await main(['/cfg.json'], { readConfig: () => config(d), log: (s) => logs.push(s), run, lock: (dir) => makeLock({ dir, timeoutMs: 50 }), onStop: () => {} }), 1);
      assert.match(logs.at(-1), /another worker runner is running/);
    } finally { other.release(h.nonce); }
    assert.equal(ran, false);
    assert.equal(await main(['/cfg.json'], { readConfig: () => config(d), log: (s) => logs.push(s), run: async () => { throw new Error('the memory can\'t be read'); }, onStop: () => {} }), 1);
    assert.match(logs.at(-1), /stopped: the memory can't be read/);
    assert.equal(existsSync(join(d, 'runner', 'lock')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 5: the LaunchAgent file is loginJobPlist\'s, with its own logs, the owner\'s HOME and Umask 077, and no UserName', () => {
  const o = { label: 'org.example.worker-runner', node: '/usr/local/bin/node', script: '/i/wiring/runner-main.mjs', config: '/i/runner.json', path: '/usr/bin:/bin', logDir: '/logs', workDir: '/Users/o', home: '/Users/o' };
  assert.throws(() => workerRunnerPlist({ ...o, home: 'o' }), /home must be/);
  for (const home of ['/', '//', '/.', '/..', '/./', '/Users/o/', '/Users//o', '/Users/../o', '/Users/o o']) assert.throws(() => workerRunnerPlist({ ...o, home }), /simplest form, not \/ itself/, home);
  assert.equal(RUNNER_JOB_UMASK, 0o077, 'what the runner makes is the owner\'s alone');
  // Before #292 lands, loginJobPlist has no home or umask option; the builder refuses rather than drop them.
  const hasHome = loginJobPlist({ ...o, home: '/h', umask: 0o77 }).includes('<key>HOME</key>');
  if (!hasHome) { assert.throws(() => workerRunnerPlist(o), /needs the loginJobPlist with home and umask \(#292\)/); return; }
  const t = workerRunnerPlist(o);
  assert.match(t, /<key>HOME<\/key><string>\/Users\/o<\/string>/);
  assert.match(t, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.ok(t.includes(`/logs/${RUNNER_JOB_LOG}.out.log`) && t.includes(`/logs/${RUNNER_JOB_LOG}.err.log`));
  assert.ok(!t.includes('UserName'), 'the owner\'s own LaunchAgent');
  assert.match(t, /<array><string>\/usr\/local\/bin\/node<\/string><string>\/i\/wiring\/runner-main.mjs<\/string><string>\/i\/runner.json<\/string><\/array>/);
});

test('#364 self-review m6: main never makes the runner\'s own folder (setup does, with the access the Dispatcher needs)', async () => {
  const d = tempDir('orch-rmain-');
  try {
    const logs = [];
    assert.equal(await main(['/cfg.json'], { readConfig: () => config(d), log: (s) => logs.push(s), run: async () => {}, onStop: () => {} }), 1);
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
  const d = tempDir('orch-rmain-');
  const before = process.listeners('SIGTERM');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    let heard = 0;
    const code = await main(['/cfg.json'], { readConfig: () => config(d), log: () => {}, run: async (x) => {
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
  const d = tempDir('orch-rmain-');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: join(d, 'runner', 'rules-p1.json') } } },
      p2: { repo: 'o/p2', mirror: join(d, 'mirror2'), render: { paths: { deny: DENY(d) } } } } });
    const kept = []; const logs = [];
    const fresh = (path, r) => { const k = { path, r, stopped: false }; kept.push(k); return { stop: () => { k.stopped = true; }, error: () => (path.endsWith('p1.json') ? Object.assign(new Error('x'), { code: 'ENOSPC' }) : null) }; };
    let during;
    const code = await main(['/cfg.json'], { readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh, run: async () => { during = kept.map((k) => k.stopped); } });
    assert.equal(code, 0, logs.join('\n'));
    assert.deepEqual(kept.map((k) => [k.path, k.r]), [[join(d, 'runner', 'rules-p1.json'), rules]], 'only a product with rules and a snapshot');
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
});

test('#369 r2 c2: a RECHECK check that throws is a failure with its reason, never a pass; one with no port is refused', async () => {
  const ok = async () => ({ ok: true });
  const of = (k) => startDeps({ pin: '1' }, { checksOf: () => k }).beforeStart({});
  assert.equal(await of({ 1: ok, 2: ok, 3: ok, 8: ok }), null);
  assert.equal(await of({ 1: ok, 2: async () => { throw new Error('git cat-file failed'); }, 3: ok, 8: ok }), 'check 2: git cat-file failed');
  assert.equal(await of({ 1: ok, 2: ok, 3: ok }), 'check 8 has no port');
});

test('#369 r2 m2 self-review: main gives the start port its keeper, so a product whose snapshot is not kept fresh starts nothing; a die, a restart that works, a die again', async () => {
  const d = tempDir('orch-rmain-');
  try {
    mkdirSync(join(d, 'runner'), { recursive: true });
    const rules = { production: { env_files: [], programs: [], hosts: [] } };
    const cfg = config(d, { products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), rules, render: { paths: { deny: DENY(d), snapshot: join(d, 'runner', 'rules-p1.json') } } } } });
    const logs = []; let r;
    const fresh = () => { throw Object.assign(new Error('x'), { code: 'EROFS' }); };
    const code = await main(['/cfg.json'], { readConfig: () => cfg, log: (s) => logs.push(s), onStop: () => {}, fresh,
      run: async (ctx) => { r = await ctx.ports.start({ card: 'C-1', kind: 'editing', product: 'p1', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' }); } });
    assert.equal(code, 0, logs.join('\n'));
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

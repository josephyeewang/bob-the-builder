// Part C, runner step 5: the worker runner's entry point and its LaunchAgent file. Nothing here loads a job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { checkRunnerConfig, main, realRunnerPorts } from './runner-main.mjs';
import { RUNNER_JOB_LOG, RUNNER_JOB_UMASK, workerRunnerPlist } from './runner-job.mjs';

const config = (d, over = {}) => ({ installRoot: join(d, 'install'), requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json'), orchestrateUid: 501,
  outboxRoot: join(d, 'outboxes'), copiesRoot: join(d, 'copies'), home: join(d, 'home'), path: '/usr/bin:/bin', claudeBin: join(d, 'install', 'claude'),
  recordRoot: join(d, 'record'), recordUid: 501, claimMs: 600_000, products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: {} } } }, ...over });

test('step 5: the config is refused unless every path is full, the uids are uids, and each product has its repo, mirror and paths', () => {
  const c = checkRunnerConfig(config('/x'));
  assert.equal(c.ownDir, '/x/runner'); assert.equal(c.memoryFile, '/x/runner/memory.json'); assert.equal(c.settingsDir, '/x/runner/settings');
  assert.deepEqual(c.workerRunner, { requestsDir: '/x/requests', statusFile: '/x/runner/status.json' });
  const bad = [
    [{ statusFile: 'status.json' }, /statusFile must be a full path/], [{ copiesRoot: '/' }, /copiesRoot must be a full path, not \//],
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
        assert.equal(x.stopWhen(), false); stop(); assert.equal(x.stopWhen(), true); } });
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

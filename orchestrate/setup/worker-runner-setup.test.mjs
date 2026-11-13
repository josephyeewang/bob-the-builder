// The worker runner's job in setup (L1092, L1112): off without the entry, the runner-shaped job as builder when on, and
// load refused until the copy holds a worker-runner.json the runner's own check takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallConfig } from './install.mjs';
import { jobsFor, onlyJobs, OPTIONAL_JOBS } from './daemons.mjs';
import { WORKER_RUNNER_CONFIG, WORKER_RUNNER_JOB, parseWorkerRunner, workerRunnerJobPlist, workerRunnerLoadProblem } from './worker-runner-setup.mjs';
import { NODE } from '../modules/M4-workshop/launcher/install-check.mjs';

const BASE = '/Library/orch-test';
const RAW = { base: BASE, owner: 'sam', products: ['alpha', 'beta'], address: 'https://github.com/example-org/example-repo.git', label: 'com.example.orch', runnerConfig: '/Users/sam/review.json', nodeBin: '/usr/local/bin/node' };
const R = `${BASE}/install/orchestrate`; const H = `${BASE}/home/builder`;

test('worker runner entry: absent is off; one of the config\'s products is on; anything else is refused by name', () => {
  assert.equal(parseInstallConfig(RAW).workerRunner, undefined);
  assert.deepEqual(parseInstallConfig({ ...RAW, workerRunner: { product: 'alpha' } }).workerRunner, { product: 'alpha' });
  const cfg = { products: ['alpha'] };
  for (const [raw, why] of [[null, /must be an object/], [[], /must be an object/], ['alpha', /must be an object/],
    [{}, /must be one of the config's products/], [{ product: 'gamma' }, /must be one of the config's products/],
    [{ product: 'alpha', rules: {} }, /keys it does not take: "rules".*rules lists come from the rules/],
    [{ product: 'alpha', products: ['alpha', 'beta'] }, /keys it does not take: "products"/]]) {
    assert.throws(() => parseWorkerRunner(raw, cfg), why, JSON.stringify(raw));
  }
});

test('worker runner job: off without its entry; on, runner-main.mjs with the copy\'s worker-runner.json, as builder, HOME the builder\'s home, Umask 63, its own logs, loaded last', () => {
  const off = parseInstallConfig(RAW);
  assert.ok(!jobsFor(off).includes(WORKER_RUNNER_JOB));
  assert.throws(() => onlyJobs(off, WORKER_RUNNER_JOB), /does not turn the worker runner's job on/);
  assert.deepEqual(onlyJobs(off, WORKER_RUNNER_JOB, { anyKnown: true }), [WORKER_RUNNER_JOB], 'a job the config has since turned off can still be taken out');
  assert.ok(OPTIONAL_JOBS.includes(WORKER_RUNNER_JOB));
  const cfg = parseInstallConfig({ ...RAW, workerRunner: { product: 'alpha' }, robot: false });
  assert.deepEqual(jobsFor(cfg), ['review-updater', 'review-account', 'review-runner', WORKER_RUNNER_JOB]);
  const t = workerRunnerJobPlist(cfg);
  assert.ok(t.includes('<key>Label</key><string>com.example.orch.worker-runner</string>'), t);
  assert.ok(t.includes(`<key>ProgramArguments</key><array><string>${R}/${NODE}</string><string>${R}/wiring/runner-main.mjs</string><string>${R}/${WORKER_RUNNER_CONFIG}</string></array>`), t);
  assert.ok(t.includes('<key>UserName</key><string>builder</string>'), t);
  assert.ok(t.includes(`<key>HOME</key><string>${H}</string>`), t);
  assert.ok(t.includes(`<key>WorkingDirectory</key><string>${H}</string>`), t);
  assert.ok(t.includes('<key>Umask</key><integer>63</integer>'), t);
  assert.ok(t.includes('worker-runner.out.log') && t.includes('worker-runner.err.log'), t);
  assert.ok(!t.includes('/Users/'), 'nothing of a person\'s home');
});

// A runner config its own check (runner-main.mjs checkRunnerConfig) takes.
const GOOD = {
  installRoot: R, requestsDir: `${BASE}/worker-runner/requests`, statusFile: `${BASE}/worker-runner/runner/status.json`, orchestrateUid: 401,
  outboxRoot: `${BASE}/outboxes`, copiesRoot: `${BASE}/worker-copies`, home: H, path: '/usr/bin:/bin', claudeBin: `${R}/bin/claude`,
  recordRoot: `${BASE}/products/alpha/store`, recordUid: 401, claimMs: 600_000,
  products: { alpha: { repo: 'example-org/alpha', mirror: `${BASE}/mirror`, render: { paths: { deny: {
    record: `${BASE}/products/alpha/store`, ssh: `${H}/.ssh`, gh: `${H}/.config/gh`, claudeHome: `${H}/.claude`, robotKeys: `${BASE}/keys`, secrets: [`${BASE}/private`],
  } } } } },
};
function fakeIo(files, { uid = 0, mode = 0o644, link = false } = {}) {
  return {
    rootUid: 0,
    lstat(f) { if (!Object.hasOwn(files, f)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return { isFile: () => !link, isSymbolicLink: () => link, uid, mode: 0o100000 | mode }; },
    readText(f) { return files[f]; },
  };
}

test('worker runner load: refused until the copy holds worker-runner.json, root\'s 0644, that the runner takes', () => {
  const cfg = parseInstallConfig({ ...RAW, workerRunner: { product: 'alpha' } });
  const f = `${R}/${WORKER_RUNNER_CONFIG}`; const good = { [f]: JSON.stringify(GOOD) };
  assert.equal(workerRunnerLoadProblem(fakeIo(good), cfg), null);
  for (const [io, why] of [[fakeIo({}), /is not there \(run worker-config first\)/], [fakeIo(good, { uid: 501 }), /not root's 0644/],
    [fakeIo(good, { mode: 0o666 }), /not root's 0644/], [fakeIo(good, { link: true }), /not a plain file/], [fakeIo({ [f]: '{' }), /not valid JSON/],
    [fakeIo({ [f]: JSON.stringify({ ...GOOD, products: {} }) }), /one the runner refuses \(config: products must name at least one product\)/]]) {
    const p = workerRunnerLoadProblem(io, cfg);
    assert.match(p ?? '', why); assert.match(p, /so the worker runner's job would not start/);
  }
});

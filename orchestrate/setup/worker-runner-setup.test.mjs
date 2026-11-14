// The worker runner's job in setup (L1092, L1112): off without the entry, the runner-shaped job as builder when on, and
// load refused until the copy holds a worker-runner.json the runner's own check takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallConfig } from './install.mjs';
import { jobsFor, onlyJobs, OPTIONAL_JOBS } from './daemons.mjs';
import { WORKER_CLAIM_MS, WORKER_RUNNER_CONFIG, WORKER_RUNNER_JOB, parseWorkerRunner, workerRunnerConfigFor, workerRunnerConfigText, workerRunnerJobPlist, workerRunnerLoadProblem } from './worker-runner-setup.mjs';
import { updaterConfigFor } from './install.mjs';
import { checkRunnerConfig } from '../wiring/runner-main.mjs';
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
  const f = `${R}/${WORKER_RUNNER_CONFIG}`; const good = { [f]: workerRunnerConfigText(GOOD) };
  const built = () => ({ config: GOOD, problems: [] });
  assert.equal(workerRunnerLoadProblem(fakeIo(good), cfg, { built }), null);
  for (const [io, why] of [[fakeIo({}), /is not there \(run worker-config first\)/], [fakeIo(good, { uid: 501 }), /not root's 0644/],
    [fakeIo(good, { mode: 0o666 }), /not root's 0644/], [fakeIo(good, { link: true }), /not a plain file/], [fakeIo({ [f]: '{' }), /not valid JSON/],
    [fakeIo({ [f]: JSON.stringify({ ...GOOD, products: {} }) }), /one the runner refuses \(config: products must name at least one product\)/]]) {
    const p = workerRunnerLoadProblem(io, cfg, { built });
    assert.match(p ?? '', why); assert.match(p, /so the worker runner's job would not start/);
  }
  // One the runner takes but not what setup writes now (another folder, by hand or an older setup), or setup can't build one: refused too.
  const other = workerRunnerConfigText({ ...GOOD, claimMs: 1 });
  assert.match(workerRunnerLoadProblem(fakeIo({ [f]: other }), cfg, { built }), /is not the config worker-config writes now: claimMs is 1, not 600000 \(run worker-config\)/);
  assert.match(workerRunnerLoadProblem(fakeIo(good), cfg, { built: () => ({ config: null, problems: ['no review.json'] }) }), /can't be compared with the config setup builds \(no review\.json\)/);
});

// ── worker-config (L1112): every value from the layout, the Mac, the copy's review.json and the Dispatcher's products.json.
const DISP = { product: 'alpha', productsFile: `${BASE}/private/products.json`, rulesStateDir: `${BASE}/private/rules-state`, tokenFile: `${BASE}/keys/t`, approvalsStateDir: `${BASE}/private/approvals` };
const RULES = { production: { env_files: ['/srv/app/prod.cfg', 'relative/prod.cfg'], programs: ['deploytool'], hosts: ['db.example.invalid'] }, secrets: { paths: ['/srv/app/keys', '~/.netrc'] } };
const RC = { installRoot: R, recordRoot: `${BASE}/products/alpha/store`, rules: RULES, pin: '2.1.300', claudeBin: `${R}/claude-code/2.1.300/claude`, hooksDir: `${R}/hooks`,
  machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json', accountCopy: `${BASE}/account-copy.json`, bobFolder: `${BASE}/bob`,
  budget: `${R}/modules/M11-dispatcher/budget.mjs`, dispatcherRules: `${BASE}/products/alpha/rules/dispatcher-rules.json` };
const PRODUCTS = [{ product: 'alpha', owner: 'example-org', repo: 'alpha-repo', joe_github_id: 7 }, { product: 'beta', owner: 'example-org', repo: 'beta-repo', joe_github_id: 7 }];
const USERS = { orchestrate: 401, review: 402, builder: 403, sam: 501 };
const userOf = (n) => (USERS[n] ? { exists: true, uid: USERS[n], home: n === 'sam' ? '/Users/sam' : `${BASE}/home/${n}` } : { exists: false });
const cfgOn = (over = {}) => parseInstallConfig({ ...RAW, hostLockPath: '/Users/sam/host.lock', dispatcher: DISP, workerRunner: { product: 'alpha' }, ...over });
const ioOf = (files) => ({ rootUid: 0, prefix: '', at: (p) => p, readText(f) { if (!Object.hasOwn(files, f)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[f]; } });
const FILES = (rc = RC, products = PRODUCTS) => ({ [`${R}/review.json`]: JSON.stringify(rc), [DISP.productsFile]: JSON.stringify(products) });

test('worker-config: the config is built from the layout, the Mac, the copy\'s review.json and products.json, and the runner\'s own check takes it', () => {
  const { config, problems } = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf });
  assert.deepEqual(problems, []);
  assert.doesNotThrow(() => checkRunnerConfig(config));
  const W = `${BASE}/worker-runner`;
  assert.deepEqual(config, {
    installRoot: R, requestsDir: `${W}/requests`, statusFile: `${W}/runner/status.json`, orchestrateUid: 401,
    outboxRoot: `${BASE}/outboxes`, copiesRoot: `${BASE}/worker-copies`, home: H, path: '/usr/bin:/bin:/usr/sbin:/sbin', claudeBin: RC.claudeBin,
    recordRoot: `${BASE}/products/alpha/store`, recordUid: 401, claimMs: WORKER_CLAIM_MS,
    products: { alpha: {
      repo: 'example-org/alpha-repo', mirror: `${BASE}/mirror`, rules: RULES,
      render: {
        paths: {
          // Slip-catchers (L1112 (3)): the rules' full plain paths (a relative or ~ one is left to the hooks), the private folder,
          // the Dispatcher's rules-state and approvals folders, and the owner's home.
          deny: { record: `${BASE}/products/alpha/store`, ssh: `${H}/.ssh`, gh: `${H}/.config/gh`, claudeHome: `${H}/.claude`, robotKeys: `${BASE}/keys`,
            secrets: ['/srv/app/keys', '/srv/app/prod.cfg', `${BASE}/private`, DISP.rulesStateDir, DISP.approvalsStateDir, '/Users/sam'] },
          hooksDir: RC.hooksDir, node: `${R}/${NODE}`, bobFolder: RC.bobFolder, snapshot: `${W}/snapshots/alpha.json`,
        },
        // From the rules, never the entry (L1112 (2), I7); every product's proposals folder.
        rulesHosts: ['db.example.invalid'], productionFiles: ['/srv/app/prod.cfg', 'relative/prod.cfg'],
        proposalOutboxes: ['/Users/Shared/orchestrate-proposals/alpha', '/Users/Shared/orchestrate-proposals/beta'],
      },
    } },
    pin: RC.pin, machineWide: RC.machineWide, accountCopy: RC.accountCopy,
    budget: RC.budget, dispatcherRules: RC.dispatcherRules, reviewStatusFile: `${BASE}/review/status.json`, reviewUid: 402,
  });
  assert.equal(workerRunnerConfigText(config), `${JSON.stringify(config, null, 1)}\n`);
});

test('worker-config PLANT: refused by name, nothing built, when a source is missing or is another product\'s', () => {
  const cases = [
    [cfgOn({ workerRunner: undefined }), FILES(), /does not turn the worker runner's job on/],
    [cfgOn({ dispatcher: undefined }), FILES(), /needs the Dispatcher's entry too/],
    [cfgOn(), { [DISP.productsFile]: JSON.stringify(PRODUCTS) }, /the copy's review\.json can't be read \(ENOENT\)/],
    [cfgOn(), FILES({ ...RC, claudeBin: undefined }), /the --for-install form; run review-config and add-to-install first/],
    [cfgOn(), FILES({ ...RC, recordRoot: `${BASE}/products/beta/store` }), /is for another product's Record .*so its rules are not alpha's/],
    [cfgOn(), FILES({ ...RC, rules: { production: RULES.production } }), /must set rules\.secrets/],
    [cfgOn(), FILES(RC, [PRODUCTS[1]]), /products\.json does not list alpha/],
    [cfgOn(), FILES(RC, [{ product: 'alpha' }]), /products\.json can't be used \(products\.json entry needs product, owner, repo\)/],
    [cfgOn(), { [`${R}/review.json`]: JSON.stringify(RC) }, /products\.json can't be used \(ENOENT\)/],
  ];
  for (const [cfg, files, why] of cases) {
    const r = workerRunnerConfigFor(ioOf(files), cfg, { userOf });
    assert.equal(r.config, null, String(why)); assert.match(r.problems.join('; '), why);
  }
  // No builder user (L1079): refused, never built for another user.
  const r = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf: (n) => (n === 'builder' ? { exists: false } : userOf(n)) });
  assert.match(r.problems.join('; '), /the Mac user builder .* does not exist/);
  // A value the runner refuses is never written: a pin in the wrong form.
  assert.match(workerRunnerConfigFor(ioOf(FILES({ ...RC, pin: 'latest' })), cfgOn(), { userOf }).problems.join(), /one the worker runner refuses \(config: pin must be a Claude Code version\)/);
});

test('worker-config: the copy\'s updater keeps worker-runner.json once the entry is on, and the name can\'t ride in as an extra', () => {
  const io = { at: (p) => p };
  assert.ok(updaterConfigFor(io, cfgOn()).keep.includes(WORKER_RUNNER_CONFIG));
  assert.ok(!updaterConfigFor(io, parseInstallConfig(RAW)).keep.includes(WORKER_RUNNER_CONFIG));
  assert.throws(() => parseInstallConfig({ ...RAW, extras: ['/Users/sam/x/worker-runner.json'] }), /extras must be full paths/);
});

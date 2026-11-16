// The worker runner's job in setup (L1092, L1112): off without the entry, the runner-shaped job as builder when on, and
// load refused until the copy holds a worker-runner.json the runner's own check takes.
import { STATUS_FILE } from './builder-wall.mjs';
import * as layout from './layout.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallConfig } from './install.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkDaemons, jobsFor, onlyJobs, OPTIONAL_JOBS, planLoad, planPlace, runRows, startChecks } from './daemons.mjs';
import { COPY_CHANGED, WORKER_CLAIM_MS, WORKER_RUNNER_CONFIG, WORKER_RUNNER_JOB, parseWorkerRunner, planWorkerRunnerConfig, workerRunnerConfigFor, workerRunnerConfigText, workerRunnerJobPlist, workerRunnerLoadCheck, workerRunnerLoadProblem } from './worker-runner-setup.mjs';
import { fakeMac, macTest } from './fake-mac.test-helper.mjs';
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
  // L1193: the builder wall's check job comes with the runner, just before it (it leaves the status the runner's gate reads).
  assert.deepEqual(jobsFor(cfg), ['review-updater', 'review-account', 'review-runner', 'worker-rules', 'builder-wall-check', WORKER_RUNNER_JOB]);
  const t = workerRunnerJobPlist(cfg);
  assert.ok(t.includes('<key>Label</key><string>com.example.orch.worker-runner</string>'), t);
  assert.ok(t.includes(`<key>ProgramArguments</key><array><string>${R}/${NODE}</string><string>--disable-sigusr1</string><string>${R}/wiring/runner-main.mjs</string><string>${R}/${WORKER_RUNNER_CONFIG}</string></array>`), t);
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
  const built = () => ({ config: GOOD, problems: [] }); const keepsOf = () => true;
  assert.equal(workerRunnerLoadProblem(fakeIo(good), cfg, { built, keepsOf }), null);
  for (const [io, why] of [[fakeIo({}), /is not there \(run worker-config first\)/], [fakeIo(good, { uid: 501 }), /not root's 0644/],
    [fakeIo(good, { mode: 0o666 }), /not root's 0644/], [fakeIo(good, { link: true }), /not a plain file/], [fakeIo({ [f]: '{' }), /not valid JSON/],
    [fakeIo({ [f]: JSON.stringify({ ...GOOD, products: {} }) }), /one the runner refuses \(config: products must name at least one product\)/]]) {
    const p = workerRunnerLoadProblem(io, cfg, { built, keepsOf });
    assert.match(p ?? '', why); assert.match(p, /so the worker runner's job would not start/);
  }
  // One the runner takes but not what setup writes now (another folder, by hand or an older setup), or setup can't build one: refused too.
  const other = workerRunnerConfigText({ ...GOOD, claimMs: 1 });
  assert.match(workerRunnerLoadProblem(fakeIo({ [f]: other }), cfg, { built, keepsOf }), /is not the config worker-config writes now: claimMs is 1, not 600000 \(run worker-config\)/);
  assert.match(workerRunnerLoadProblem(fakeIo(good), cfg, { built: () => ({ config: null, problems: ['no review.json'] }), keepsOf }), /can't be compared with the config setup builds \(no review\.json\)/);
  // The right file, but the copy's updater does not keep it (worker-config cut off before the keep list): refused, never loaded.
  assert.match(workerRunnerLoadProblem(fakeIo(good), cfg, { built, keepsOf: () => false }), /is not in the keep list of the copy's updater\.json, so the next update would drop it \(run worker-config\), so the worker runner's job would not start/);
  assert.match(workerRunnerLoadProblem({ ...fakeIo(good), euid: () => 0 }, cfg, { built, keepsOf: () => null }), /can't be checked against the copy's updater\.json, which can't be read/);
  const unk = workerRunnerLoadCheck({ ...fakeIo(good), euid: () => 501 }, cfg, { built, keepsOf: () => null });
  assert.equal(unk.unknown, true); assert.match(unk.why, /the copy's updater\.json can't be read/);
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
          hooksDir: RC.hooksDir, node: `${R}/${NODE}`, bobFolder: RC.bobFolder, snapshot: `${BASE}/worker-rules/alpha.json`, snapshotOwner: 0,
        },
        // From the rules, never the entry (L1112 (2), I7); every product's proposals folder.
        rulesHosts: ['db.example.invalid'], productionFiles: ['/srv/app/prod.cfg', 'relative/prod.cfg'],
        proposalOutboxes: ['/Users/Shared/orchestrate-proposals/alpha', '/Users/Shared/orchestrate-proposals/beta'],
      },
    } },
    pin: RC.pin, machineWide: RC.machineWide, accountCopy: RC.accountCopy,
    budget: RC.budget, dispatcherRules: RC.dispatcherRules, reviewStatusFile: `${BASE}/review/status.json`, reviewUid: 402,
    // L1193: root's wall job's status, at layout's place (builder-wall.mjs reads it as STATUS_FILE).
    wallStatus: `${BASE}/builder-wall-status/status.json`,
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

test('worker-config: install\'s keep list never names worker-runner.json (worker-config adds it), and the name can\'t ride in as an extra', () => {
  const io = { at: (p) => p };
  // The install can't seed it (it is built from the full review.json, after install), and the updater refuses a keep item
  // the seed lacks: so it joins keep at worker-config, never at install.
  assert.ok(!updaterConfigFor(io, cfgOn()).keep.includes(WORKER_RUNNER_CONFIG));
  assert.ok(!updaterConfigFor(io, parseInstallConfig(RAW)).keep.includes(WORKER_RUNNER_CONFIG));
  assert.throws(() => parseInstallConfig({ ...RAW, extras: ['/Users/sam/x/worker-runner.json'] }), /extras must be full paths/);
});

// ── #537 r1 (L1187) ──────────────────────────────────────────────────────────────────────────────────────────────────
// A Mac with no copy (the install check fails for every job, as it should) and one file of the copy: enough for the gate.
const NO_COPY = '/nonexistent-orch-537';
const gateIo = (files, { euid = 0, deny = null } = {}) => ({
  rootUid: 0, prefix: NO_COPY, at: (p) => `${NO_COPY}${p}`, euid: () => euid, list: () => [],
  lstat(f) { if (deny) throw Object.assign(new Error(deny), { code: deny }); if (!Object.hasOwn(files, f)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100644 }; },
  readText(f) { if (!Object.hasOwn(files, f)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return files[f]; },
  run: () => ({ status: 113, stdout: '', stderr: '' }),
});
const WF = `${R}/${WORKER_RUNNER_CONFIG}`;

test('#537 r1 m1: worker-config writes only into a copy that is there and root\'s alone, then adds the file to its keep', () => {
  const cfg = cfgOn(); const built = () => ({ config: GOOD, problems: [] });
  const DIR = `${BASE}/install/orchestrate.v-1/orchestrate`; const F = `${DIR}/${WORKER_RUNNER_CONFIG}`; const U = `${DIR}/updater.json`;
  const KEEP = ['bin', 'updater.json', 'review.json'];
  const copyOf = (keep = KEEP) => () => ({ dir: DIR, updater: { installRoot: R, keep } });
  const plan = (o = {}, files = {}) => planWorkerRunnerConfig(ioOf(files), cfg, { built, copyOf: copyOf(), copyProblem: () => null, ...o });
  // Not kept yet (a fresh install): the file, then the keep list, in that order, both in the copy's real folder.
  const ok = plan(); assert.deepEqual(ok.problems, []); assert.equal(ok.ops.length, 2);
  assert.ok(ok.ops[0].text.startsWith(`write ${F} `), ok.ops[0].text); assert.match(ok.ops[0].text, /root:wheel 0644; the runner reads it once, at start/);
  assert.ok(ok.ops[1].text.startsWith(`add ${WORKER_RUNNER_CONFIG} to the keep list of ${U} `), ok.ops[1].text);
  // Already kept: only the file. The file already right: only the keep list. Both: nothing (twice does nothing).
  assert.deepEqual(plan({ copyOf: copyOf([...KEEP, WORKER_RUNNER_CONFIG]) }).ops.map((o) => o.text.split(' ')[0]), ['write']);
  assert.deepEqual(plan({}, { [F]: workerRunnerConfigText(GOOD) }).ops.map((o) => o.text.split(' ')[0]), ['add']);
  assert.deepEqual(plan({ copyOf: copyOf([...KEEP, WORKER_RUNNER_CONFIG]) }, { [F]: workerRunnerConfigText(GOOD) }).ops, [], 'twice does nothing');
  for (const [o, why] of [[{ copyOf: () => null }, /the install is not there yet \(run the install first\)/],
    [{ copyOf: () => ({ dir: DIR, problem: 'the copy\'s updater.json was refused: config: keep must list plain top-level names' }) }, /the copy's updater\.json was refused/],
    [{ copyProblem: () => 'x is uid 501\'s' }, /the installed copy is not root's alone \(x is uid 501's\), so root won't write in it/]]) {
    const p = plan(o); assert.deepEqual(p.ops, [], String(why)); assert.match(p.problems.join('\n'), why);
  }
  assert.deepEqual(plan({ copyProblem: () => false }).problems, [], 'no reason is no problem');
  assert.deepEqual(plan({ built: () => ({ config: null, problems: ['no review.json'] }) }), { ops: [], problems: ['no review.json'] });
});

// The fix for the live install failure: the keep list is written after the file, each whole (writeAside), so a run cut off
// between the two never leaves keep naming a file the copy lacks (the updater refuses that), and a second run finishes it.
test('worker-config: missing from keep → written and added; twice → nothing; cut off between file and keep → consistent, and the next run finishes', () => {
  const cfg = cfgOn(); const built = () => ({ config: GOOD, problems: [] });
  const DIR = R; const F = `${DIR}/${WORKER_RUNNER_CONFIG}`; const U = `${DIR}/updater.json`;
  const updater0 = { installRoot: R, clone: `${BASE}/install/clone`, address: RAW.address, keep: ['bin', 'updater.json', 'review.json'], gitBin: '/usr/bin/git' };
  const files = { [U]: `${JSON.stringify(updater0, null, 1)}\n`, [`${DIR}/review.json`]: '{}' }; const order = [];
  const io = { ...ioOf(files), euid: () => 0, lstat: (p) => { if (!Object.hasOwn(files, p)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100644 }; }, unlink: (p) => { delete files[p]; }, write: (p, t) => { files[p] = t; }, secureFile: () => {},
    rename: (a, b) => { order.push(b); files[b] = files[a]; delete files[a]; } };
  const copyOf = () => ({ dir: DIR, updater: JSON.parse(files[U]) });
  const plan = () => planWorkerRunnerConfig(io, cfg, { built, copyOf, copyProblem: () => null });
  const keeps = () => JSON.parse(files[U]).keep.includes(WORKER_RUNNER_CONFIG);
  // Cut off after the first step: the file is there, the keep list does not name it yet. The updater takes that (keep names
  // only files the copy holds), and the job's load refuses it (the update would drop the file).
  const first = plan(); assert.equal(first.ops.length, 2); first.ops[0].run();
  assert.equal(files[F], workerRunnerConfigText(GOOD)); assert.equal(keeps(), false);
  assert.ok(JSON.parse(files[U]).keep.every((n) => n === 'bin' || Object.hasOwn(files, `${DIR}/${n}`)), 'keep names only what the copy holds');
  assert.match(workerRunnerLoadProblem(io, cfg, { built, keepsOf: () => keeps() }) ?? '', /is not in the keep list of the copy's updater\.json/);
  // The next run finishes it: only the keep list, and nothing else in updater.json changes.
  const second = plan(); assert.equal(second.ops.length, 1); assert.match(second.ops[0].text, /^add worker-runner\.json to the keep list/); second.ops[0].run();
  assert.deepEqual(JSON.parse(files[U]), { ...updater0, keep: [...updater0.keep, WORKER_RUNNER_CONFIG] });
  assert.deepEqual(order, [F, U], 'the file went in before the keep list');
  assert.equal(workerRunnerLoadProblem(io, cfg, { built, keepsOf: () => keeps() }), null, 'loads once the file is there and kept');
  assert.deepEqual(plan().ops, [], 'twice does nothing');
  // Uncut, from the start: both in one run, file first.
  delete files[F]; files[U] = `${JSON.stringify(updater0, null, 1)}\n`; order.length = 0;
  for (const o of plan().ops) o.run();
  assert.deepEqual(order, [F, U]); assert.equal(keeps(), true); assert.deepEqual(plan().ops, []);
  // The keep step adds to the keep list there when it runs: a name another step (bob, add-to-install) added since the plan stays.
  delete files[F]; files[U] = `${JSON.stringify(updater0, null, 1)}\n`;
  const later = plan(); assert.equal(later.ops.length, 2);
  files[U] = `${JSON.stringify({ ...updater0, keep: [...updater0.keep, 'bob-manifest.json'] }, null, 1)}\n`;
  for (const o of later.ops) o.run();
  assert.deepEqual(JSON.parse(files[U]).keep, [...updater0.keep, 'bob-manifest.json', WORKER_RUNNER_CONFIG]);
});

test('worker-config: an update that flips the copy between the file and the keep step is refused, and the new copy\'s keep is not touched', () => {
  const cfg = cfgOn(); const built = () => ({ config: GOOD, problems: [] });
  const OLD = `${BASE}/install/orchestrate.v-1/orchestrate`; const NEW = `${BASE}/install/orchestrate.v-2/orchestrate`;
  const updater0 = { installRoot: R, clone: `${BASE}/install/clone`, address: RAW.address, keep: ['bin', 'updater.json', 'review.json'], gitBin: '/usr/bin/git' };
  const files = { [`${OLD}/updater.json`]: JSON.stringify(updater0), [`${NEW}/updater.json`]: JSON.stringify(updater0) };
  const io = { ...ioOf(files), unlink: (p) => { delete files[p]; }, write: (p, t) => { files[p] = t; }, secureFile: () => {}, rename: (a, b) => { files[b] = files[a]; delete files[a]; } };
  let at = OLD; const copyOf = () => ({ dir: at, updater: JSON.parse(files[`${at}/updater.json`]) });
  const p = planWorkerRunnerConfig(io, cfg, { built, copyOf, copyProblem: () => null });
  assert.equal(p.ops.length, 2); p.ops[0].run();
  at = NEW;   // the updater flips the link here
  assert.throws(() => p.ops[1].run(), new RegExp(COPY_CHANGED.replace(/[()]/g, '\\$&')));
  assert.deepEqual(JSON.parse(files[`${NEW}/updater.json`]), updater0, 'the new copy\'s keep list is as the update left it');
  assert.deepEqual(JSON.parse(files[`${OLD}/updater.json`]), updater0, 'and the old one\'s too');
  // Run again: into the new copy, file and keep.
  const again = planWorkerRunnerConfig(io, cfg, { built, copyOf, copyProblem: () => null }); for (const o of again.ops) o.run();
  assert.ok(Object.hasOwn(files, `${NEW}/${WORKER_RUNNER_CONFIG}`)); assert.ok(JSON.parse(files[`${NEW}/updater.json`]).keep.includes(WORKER_RUNNER_CONFIG));
  // The copy gone by the keep step: refused the same way.
  delete files[`${NEW}/${WORKER_RUNNER_CONFIG}`]; files[`${NEW}/updater.json`] = JSON.stringify(updater0);
  let there = true; const vanishing = () => (there ? copyOf() : null);
  const last = planWorkerRunnerConfig(io, cfg, { built, copyOf: vanishing, copyProblem: () => null });
  assert.equal(last.ops.length, 2); last.ops[0].run(); there = false;
  assert.throws(() => last.ops[1].run(), /the copy changed during this run/);
});

test('#537 r1 m2: place and load refuse the worker runner while the copy\'s worker-runner.json is missing or not one setup writes', () => {
  const cfg = cfgOn();
  for (const [files, why] of [[{}, /worker-runner\.json is not there \(run worker-config first\), so the worker runner's job would not start/],
    [{ [WF]: '{' }, /worker-runner\.json is not valid JSON, so the worker runner's job would not start/],
    [{ [WF]: workerRunnerConfigText({ ...GOOD, products: {} }) }, /worker-runner\.json is one the runner refuses/]]) {
    for (const plan of [planPlace, planLoad]) {
      const p = plan(gateIo(files), cfg, [WORKER_RUNNER_JOB]);
      assert.deepEqual(p.ops, [], plan.name); assert.match(p.problems.join('\n'), why, plan.name);
    }
  }
});

test('#537 r1 m3: a uid of 0 is no user, and orchestrate, review, the owner and builder each have their own uid', () => {
  for (const n of ['orchestrate', 'review', 'builder', 'sam']) {
    const r = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf: (x) => (x === n ? { exists: true, uid: 0, home: '/var/root' } : userOf(x)) });
    assert.equal(r.config, null, n); assert.match(r.problems.join('; '), new RegExp(`the Mac user ${n} \\(.*\\) does not exist`), n);
  }
  for (const [n, uid] of [['builder', 401], ['builder', 402], ['builder', 501], ['review', 401]]) {
    const r = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf: (x) => (x === n ? { ...userOf(x), uid } : userOf(x)) });
    assert.equal(r.config, null, `${n} ${uid}`); assert.match(r.problems.join('; '), /orchestrate, review, sam and builder must each have their own uid/);
  }
});

test('#537 r1 m4: the worker runner is a loop: loaded and alive passes at any age; no process FAILs; other jobs keep their limit', () => {
  const cfg = cfgOn();
  const ps = (s) => ({ run: () => ({ status: s ? 0 : 1, stdout: s ? `${s}\n` : '', stderr: '' }) });
  for (const etime of ['00:01', '31:00', '05:00:00', '3-00:00:00']) {
    for (const lastExit of ['(never exited)', '0', '1']) {
      const rows = runRows(ps(etime), cfg, WORKER_RUNNER_JOB, { loaded: true, pid: 42, lastExit });
      assert.equal(rows.length, 1); assert.equal(rows[0].ok, true, `${etime} ${lastExit}: ${JSON.stringify(rows)}`); assert.match(rows[0].what, /is running \(a loop that does not end/);
    }
  }
  const dead = runRows(ps(''), cfg, WORKER_RUNNER_JOB, { loaded: true, pid: null, lastExit: '1' });
  assert.equal(dead[0].ok, false); assert.match(dead[0].why, /no running process \(last exit code 1\); launchd starts it again within a minute/);
  const other = runRows(ps('31:00'), cfg, 'review-runner', { loaded: true, pid: 42, lastExit: '(never exited)' });
  assert.match(other.filter((r) => !r.ok).map((r) => r.why).join(), /first run has been going for 31 minutes/);
});

test('#537 r1 m5: a review.json with no budget is refused at worker-config, since every start would be held', () => {
  const r = workerRunnerConfigFor(ioOf(FILES({ ...RC, budget: undefined })), cfgOn(), { userOf });
  assert.equal(r.config, null); assert.match(r.problems.join('; '), /review\.json names no budget \(launch check 12's module\), so every start would be held: .*run review-config and add-to-install first/);
});

macTest('#537 r1 m6: worker-config reads review.json and products.json by their plain paths on the Mac (io.readText adds the prefix itself)', () => {
  const mac = fakeMac();
  const rc = { ...RC, installRoot: mac.at(R), recordRoot: mac.at(`${BASE}/products/alpha/store`), budget: mac.at(RC.budget) };
  for (const [f, t] of Object.entries(FILES(rc))) { mkdirSync(dirname(mac.at(f)), { recursive: true }); writeFileSync(mac.at(f), t); }
  const r = workerRunnerConfigFor(mac, cfgOn(), { userOf });
  assert.deepEqual(r.problems, []);
  assert.equal(r.config.installRoot, mac.at(R), 'what is written into the config is the real place');
  assert.equal(r.config.products.alpha.repo, 'example-org/alpha-repo');
});

test('#537 r1 m7: without root, a read refused is not known (L1043): never a reason to unload; as root, it is a refusal', () => {
  const cfg = cfgOn();
  for (const code of ['EACCES', 'EPERM']) {
    const c = workerRunnerLoadCheck(gateIo({}, { euid: 501, deny: code }), cfg);
    assert.equal(c.unknown, true); assert.match(c.why, new RegExp(`can't be checked without root \\(it can't be looked at, ${code}; run with sudo to check it\\), so whether the worker runner's job would start is not known`));
    const g = startChecks(gateIo({}, { euid: 501, deny: code }), cfg, [WORKER_RUNNER_JOB]);
    assert.ok(g.problems.includes(c.why)); assert.ok(!g.known.includes(c.why), 'not known: place does not say to unload for it');
    const asRoot = workerRunnerLoadCheck(gateIo({}, { euid: 0, deny: code }), cfg);
    assert.equal(asRoot.unknown, false); assert.match(asRoot.why, new RegExp(`can't be looked at \\(${code}\\), so the worker runner's job would not start`));
    assert.ok(startChecks(gateIo({}, { euid: 0, deny: code }), cfg, [WORKER_RUNNER_JOB]).known.includes(asRoot.why), 'as root it is known');
  }
  // A source the config is built from refused (products.json is root's): not known without root, a refusal as root.
  const good = { [WF]: workerRunnerConfigText(GOOD) };
  const denied = () => ({ config: null, problems: ['products.json can\'t be used (EACCES)'], denied: true });
  const u = workerRunnerLoadCheck(gateIo(good, { euid: 501 }), cfg, { built: denied });
  assert.equal(u.unknown, true); assert.match(u.why, /a file the config is built from can't be read: products\.json can't be used \(EACCES\)/);
  const k = workerRunnerLoadCheck(gateIo(good, { euid: 0 }), cfg, { built: denied });
  assert.equal(k.unknown, false); assert.match(k.why, /can't be compared with the config setup builds/);
  assert.equal(workerRunnerLoadCheck(gateIo(good, { euid: 501 }), cfg, { built: () => ({ config: null, problems: ['x'], denied: false }) }).unknown, false, 'a missing file is known');
  // workerRunnerConfigFor says which reads were refused.
  const files = FILES();
  const refuse = (which) => ({ ...ioOf(files), readText(f) { if (f === which) throw Object.assign(new Error('no'), { code: 'EACCES' }); return files[f]; } });
  assert.equal(workerRunnerConfigFor(refuse(DISP.productsFile), cfgOn(), { userOf }).denied, true);
  assert.equal(workerRunnerConfigFor(refuse(`${R}/review.json`), cfgOn(), { userOf }).denied, true);
  assert.equal(workerRunnerConfigFor(ioOf({ [`${R}/review.json`]: JSON.stringify(RC) }), cfgOn(), { userOf }).denied, false, 'ENOENT is known');
});

test('#537 r1 (L1188): daemons check\'s worker-runner.json row: not known without root is a NEEDS ROOT skip; a file that differs FAILs; the one setup writes passes', () => {
  const cfg = cfgOn(); const P = (p) => `${NO_COPY}${p}`;
  const dsclRun = (cmd, args) => { const n = /^\/Users\/(\w+)$/.exec(args?.[2] ?? '')?.[1]; const u = n && userOf(n);
    return u?.exists ? { status: 0, stdout: `UniqueID: ${u.uid}\nPrimaryGroupID: 20\nNFSHomeDirectory: ${u.home}\n`, stderr: '' } : { status: 56, stdout: '', stderr: '' }; };
  const io = (files, o) => ({ ...gateIo(files, o), run: dsclRun });
  const src = FILES({ ...RC, installRoot: P(R), recordRoot: P(`${BASE}/products/alpha/store`), budget: P(RC.budget) });
  const built = workerRunnerConfigFor(io(src), cfg); assert.deepEqual(built.problems, [], 'the sources build a config');
  const row = (files, o) => checkDaemons(io(files, o), cfg, [WORKER_RUNNER_JOB]).find((r) => /worker-runner\.json\) is the one this setup writes/.test(r.what));
  const unknown = row({}, { euid: 501, deny: 'EACCES' });
  assert.equal(unknown.skip, true, 'NEEDS ROOT'); assert.equal(unknown.ok, true, 'a skip, never a FAIL'); assert.match(unknown.why, /can't be checked without root/);
  const differs = row({ ...src, [WF]: workerRunnerConfigText({ ...built.config, claimMs: 1 }) });
  assert.equal(differs.ok, false); assert.ok(!differs.skip); assert.match(differs.why, /worker-runner\.json/);
  const kept = { [`${R}/updater.json`]: JSON.stringify({ keep: ['bin', 'updater.json', 'review.json', WORKER_RUNNER_CONFIG] }) };
  const same = row({ ...src, ...kept, [WF]: workerRunnerConfigText(built.config) });
  assert.deepEqual(same, { ok: true, what: same.what }, 'PASS: no reason, no skip');
  // The same file, but the copy's updater does not keep it yet (worker-config cut off before the keep list): a FAIL.
  const notKept = row({ ...src, [`${R}/updater.json`]: JSON.stringify({ keep: ['bin', 'updater.json', 'review.json'] }), [WF]: workerRunnerConfigText(built.config) });
  assert.equal(notKept.ok, false); assert.match(notKept.why, /is not in the keep list of the copy's updater\.json/);
  // A keep that is not a list is an updater.json that can't be read, never "not kept".
  const odd = row({ ...src, [`${R}/updater.json`]: JSON.stringify({ keep: 'worker-runner.json' }), [WF]: workerRunnerConfigText(built.config) });
  assert.equal(odd.ok, false); assert.match(odd.why, /can't be checked against the copy's updater\.json, which can't be read/);
});

test('L1193: worker-config names the builder wall status file at layout\'s place, and refuses a layout that names none (L1205 m3)', () => {
  const place = (cfg) => `${cfg.base}/builder-wall-status/status.json`;
  const on = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf, wallMod: { wallStatusPath: place } });
  assert.deepEqual(on.problems, []);
  assert.equal(on.config.wallStatus, `${BASE}/builder-wall-status/status.json`, 'the place is layout\'s wallStatusPath(cfg), never a copy here');
  assert.doesNotThrow(() => checkRunnerConfig(on.config));
  const pre = workerRunnerConfigFor({ ...ioOf(FILES({ ...RC, recordRoot: `/pfx${BASE}/products/alpha/store`, budget: `/pfx${RC.budget}` })), at: (p) => `/pfx${p}` }, cfgOn(), { userOf, wallMod: { wallStatusPath: place } });
  assert.deepEqual(pre.problems, []); assert.equal(pre.config.wallStatus, `/pfx${BASE}/builder-wall-status/status.json`, 'written through io.at, as every other place');
  for (const wallMod of [{}, { wallStatusPath: 'x' }, null]) {
    const off = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf, wallMod });
    assert.equal(off.config, null, 'no place named: refused, nothing built'); assert.match(off.problems.join(), /the layout names no place for the builder wall's status file \(layout\.mjs wallStatusPath\), so the worker runner would hold every start/);
  }
  const bad = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf, wallMod: { wallStatusPath: () => { throw new Error('no base'); } } });
  assert.equal(bad.config, null); assert.match(bad.problems.join(), /the builder wall's status file can't be placed \(no base\)/);
  const rel = workerRunnerConfigFor(ioOf(FILES()), cfgOn(), { userOf, wallMod: { wallStatusPath: () => 'builder-wall-status/status.json' } });
  assert.equal(rel.config, null); assert.match(rel.problems.join(), /one the worker runner refuses \(config: wallStatus must be a full path/);
  // The real layout and lane A's module: the config names the very file the wall job writes (STATUS_FILE).
  const cfg = cfgOn(); const real = workerRunnerConfigFor(ioOf(FILES()), cfg, { userOf });
  assert.deepEqual(real.problems, []);
  assert.equal(real.config.wallStatus, STATUS_FILE(cfg));
  assert.equal(real.config.wallStatus, layout.wallStatusPath(cfg));
});

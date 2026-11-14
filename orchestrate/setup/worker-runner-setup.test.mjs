// The worker runner's job in setup (L1092, L1112): off without the entry, the runner-shaped job as builder when on, and
// load refused until the copy holds a worker-runner.json the runner's own check takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallConfig } from './install.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkDaemons, jobsFor, onlyJobs, OPTIONAL_JOBS, planLoad, planPlace, runRows, startChecks } from './daemons.mjs';
import { WORKER_CLAIM_MS, WORKER_RUNNER_CONFIG, WORKER_RUNNER_JOB, parseWorkerRunner, planWorkerRunnerConfig, workerRunnerConfigFor, workerRunnerConfigText, workerRunnerJobPlist, workerRunnerLoadCheck, workerRunnerLoadProblem } from './worker-runner-setup.mjs';
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

test('#537 r1 m1: worker-config writes only into a copy that is there, keeps the file, and is root\'s alone', () => {
  const cfg = cfgOn(); const built = () => ({ config: GOOD, problems: [] });
  const plan = (o = {}, files = {}) => planWorkerRunnerConfig(ioOf(files), cfg, { built, keepsOf: () => true, copyProblem: () => null, ...o });
  const ok = plan(); assert.deepEqual(ok.problems, []); assert.equal(ok.ops.length, 1);
  assert.ok(ok.ops[0].text.startsWith(`write ${WF} `), ok.ops[0].text); assert.match(ok.ops[0].text, /root:wheel 0644; the runner reads it once, at start/);
  assert.deepEqual(plan({}, { [WF]: workerRunnerConfigText(GOOD) }).ops, [], 'twice does nothing');
  for (const [o, why] of [[{ keepsOf: () => null }, /the install is not there yet \(run the install first\)/], [{ keepsOf: () => false }, /the installed copy's updater does not keep worker-runner\.json/],
    [{ keepsOf: () => 'updater.json is not readable' }, /the installed copy's updater does not keep worker-runner\.json/],
    [{ copyProblem: () => 'x is uid 501\'s' }, /the installed copy is not root's alone \(x is uid 501's\), so root won't write in it/]]) {
    const p = plan(o); assert.deepEqual(p.ops, [], String(why)); assert.match(p.problems.join('\n'), why);
  }
  assert.deepEqual(plan({ copyProblem: () => false }).problems, [], 'no reason is no problem');
  assert.deepEqual(plan({ built: () => ({ config: null, problems: ['no review.json'] }) }), { ops: [], problems: ['no review.json'] });
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
  const same = row({ ...src, [WF]: workerRunnerConfigText(built.config) });
  assert.deepEqual(same, { ok: true, what: same.what }, 'PASS: no reason, no skip');
});

// Tests for setup part 2 (the install and the background jobs). Same stand-in Mac as setup.test.mjs, plus a launchctl
// stand-in. The install test runs the REAL updater (as a child process, on a local folder standing in for GitHub through
// the updater's own test-only options) against the install the setup built, so a wrong layout is refused by the real code.
// PLANT tests break one clause each and name the check that catches it. The last tests run read-only tools on this Mac.

import assert from 'node:assert/strict';
import { chmodSync, fchmodSync, linkSync, renameSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitOk } from '../modules/M4-workshop/git/safe-git.mjs';
import { SCRIPTS, reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { NODE, RUNNER_CONFIG, STAMP, UPDATER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { MUST_KEEP } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { realIo, writeNewFile } from './mac.mjs';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import { BOOTSTRAP_FILES, LABEL_RE, installPaths, parseInstallConfig, spawnUpdater, updaterCommand, updaterConfigFor } from './install.mjs';
import { FIRST_RUN_LIMIT_S, JOBS, checkDaemons, jobLogs, jobsFor, list, planLoad, planPlace, plistTexts } from './daemons.mjs';
import { ROBOT_NO_CONFIG, robotPlist } from './robot-setup.mjs';
import { DISPATCHER_RUN_LIMIT_S, dispatcherConfigFor, dispatcherConfigText, dispatcherPlist, planDispatcherConfig, robotMatchProblem } from './dispatcher-setup.mjs';
import { RUN_DEADLINE_MS, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { CONFIG_KEYS, checkConfig } from '../wiring/dispatcher-wiring.mjs';
import { ROOT_CONFIG_PATH as _R } from './layout.mjs';
import { dispatcherKeysOn } from './dispatcher-check.mjs';
import { checkInstall, rootMadeEntries } from './install.mjs';
import { main, parseArgs, planCommand } from './setup.mjs';
import { apply, check } from './users-folders.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { codeFileProblem, openJobJson } from '../shared/job-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ME = process.getuid();
const isDarwin = process.platform === 'darwin';
const GIT = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
const ID = [['user.name', 'test'], ['user.email', 'test@example.invalid']];
const BASE = '/Library/orch-test';
const LABEL = 'com.example.orch-test';

const sink = () => { const lines = []; return { lines, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }; };
const text = (s) => s.lines.join('\n');

/** A local bare repository standing in for GitHub: main holds an orchestrate folder. → its path. */
async function origin(root) {
  const bare = join(root, 'origin.git'); const seed = join(root, 'origin-seed');
  await gitOk(['init', '--bare', '-q', bare], { gitDir: bare });
  mkdirSync(join(seed, 'orchestrate'), { recursive: true });
  const sg = { gitDir: join(seed, '.git'), workTree: seed, cwd: seed, extraConfig: ID };
  await gitOk(['init', '-q', seed], sg);
  writeFileSync(join(seed, 'orchestrate', 'a.txt'), 'one\n');
  mkdirSync(dirname(join(seed, 'orchestrate', SCRIPTS.updater)), { recursive: true });
  writeFileSync(join(seed, 'orchestrate', SCRIPTS.updater), '// the updater, as the copy holds it\n');
  mkdirSync(join(seed, 'orchestrate', 'modules/M4-workshop/launcher'), { recursive: true });
  writeFileSync(join(seed, 'orchestrate', 'modules/M4-workshop/launcher/review-wiring.mjs'), '// the review wiring, as main holds it\n');
  mkdirSync(join(seed, 'scripts/blueprint'), { recursive: true });
  writeFileSync(join(seed, 'scripts/blueprint/yaml-lite.mjs'), '// the file outside orchestrate/ the copy imports\n');
  await gitOk(['add', '-A'], sg); await gitOk(['commit', '-q', '-m', 'first'], sg);
  await gitOk(['push', '-q', '-f', bare, 'HEAD:refs/heads/main'], sg);
  return bare;
}

/** The throwaway Mac with the users and folders already set up (part 1), and the files the install needs. */
async function world({ euid = 0, rules = null, robot = null, dispatcher = null, lock = DLOCK } = {}) {
  const mac = fakeMac({ euid: 0 });
  const ext = realpathSync(tempDir('orch-setup-ext-'));
  const bare = await origin(ext);
  // The runner's config, as the lead's wiring would hand it over, and the three things it names.
  writeFileSync(join(ext, 'claude-bin'), '#!/bin/sh\n'); chmodSync(join(ext, 'claude-bin'), 0o755);
  mkdirSync(join(ext, 'hooks')); writeFileSync(join(ext, 'hooks', 'h.sh'), '#!/bin/sh\n'); chmodSync(join(ext, 'hooks', 'h.sh'), 0o755);
  const root = mac.at(`${BASE}/install/orchestrate`);
  writeFileSync(join(ext, 'review.json'), JSON.stringify({ installRoot: root, wiring: `${root}/modules/M4-workshop/launcher/review-wiring.mjs`, claudeBin: `${root}/claude-bin`, hooksDir: `${root}/hooks` }));
  mkdirSync(join(mac.prefix, 'gitbin'));
  writeFileSync(join(mac.prefix, 'gitbin', 'git'), `#!/bin/sh\nexec '${GIT}' "$@"\n`); chmodSync(join(mac.prefix, 'gitbin', 'git'), 0o755);
  writeFileSync(join(ext, 'node'), '#!/bin/sh\n'); chmodSync(join(ext, 'node'), 0o755);
  const raw = {
    base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: LABEL,
    runnerConfig: join(ext, 'review.json'), extras: [join(ext, 'claude-bin'), join(ext, 'hooks')],
    gitBin: join(mac.prefix, 'gitbin', 'git'), nodeBin: join(ext, 'node'),
  };
  // `rules` (a text): the config also names the watch-only week, with the fingerprint of that text, and the file is at ext/rules.yaml.
  const rulesSrc = join(ext, 'rules.yaml');
  if (rules !== null) { writeFileSync(rulesSrc, rules); raw.watch = { repo: 'example-org/example-repo', rulesSha256: createHash('sha256').update(rules).digest('hex') }; }
  // `robot` (a function of the folders made → the robot's config object, or text): the config turns the robot job on, and its
  // robot.json is one of the extras. The file is written once the users exist (its ownerUid is orchestrate's).
  if (robot !== null) { raw.robot = true; raw.extras.push(join(ext, 'robot.json')); writeFileSync(join(ext, 'robot.json'), '{}'); }
  // `dispatcher` (an entry, or true for a good one): the config turns the Dispatcher job on, with the owner's host.lock at `lock`.
  if (dispatcher !== null) { raw.hostLockPath = lock; raw.dispatcher = dispatcher === true ? { ...GOOD_DISPATCHER } : dispatcher; }
  const cfgFile = join(ext, 'install.json'); writeFileSync(cfgFile, JSON.stringify(raw));
  const cfg = parseInstallConfig(raw);
  // The updater's first run, for real, in a child: the setup's own seed and bootstrap copy, GitHub's address swapped for the
  // local folder (the one option the updater has for tests), `owner`/`top` standing in for root and `/` as its own tests do.
  const runner = join(ext, 'run-updater.mjs');
  writeFileSync(runner, 'import { pathToFileURL } from "node:url";\nconst [script, opts, ...argv] = process.argv.slice(2);\nconst { main } = await import(pathToFileURL(script).href);\nprocess.exitCode = await main(argv, { ...JSON.parse(opts), gitTools: () => null });\n');
  const updaterRuns = []; const updaterCalls = [];
  // The stand-in updater takes the command the setup REALLY builds (updaterCommand: the node, the arguments, the environment), records
  // it, and refuses what root's updater would be unsafe to start on: anything in the work folder that is not root's (the fake Mac
  // knows no owner for a path nobody chowned), has a link, or can be written by others (L149 m9: P13, P14, P20).
  const runUpdater = (io, spec) => {
    const { config, seed } = spec;
    const cmd = updaterCommand(io, spec);
    updaterCalls.push(cmd);
    const stray = []; const walk = (logical) => { const st = mac.lstat(logical); if (st.isSymbolicLink() || st.uid !== mac.rootUid || (st.mode & 0o022)) stray.push(logical); if (st.isDirectory()) for (const n of readdirSync(mac.at(logical))) walk(join(logical, n)); };
    walk(installPaths(parseInstallConfig(raw)).work);
    if (stray.length) { updaterRuns.push(1); return { status: 1, stderr: `the stand-in updater refuses to start: not root's alone: ${stray.slice(0, 3).join(', ')}` }; }
    const c = JSON.parse(readFileSync(io.at(config), 'utf8'));
    writeFileSync(io.at(config), JSON.stringify({ ...c, address: bare }));
    const [script, ...rest] = cmd.args;
    const r = spawnSync(process.execPath, [runner, script, JSON.stringify({ uid: ME, owner: ME, top: mac.prefix, localAddress: true, pathDirs: [] }), ...rest], { encoding: 'utf8' });
    updaterRuns.push(r.status);
    return { status: r.status ?? 1, stderr: r.stderr };
  };
  const argvFor = (args) => { if (mac.as === 0) { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return args; } return [...args, '--config', cfgFile]; };
  const run = (args, extra = {}) => { const s = sink(); const code = main(argvFor(args), { io: mac, runUpdater, out: s.out, err: s.err, ...extra }); return { code, text: text(s), s }; };
  const folders = run(['users-folders']);
  assert.equal(folders.code, 0, folders.text);
  if (robot !== null) { const c = robot({ mac, root, uid: Number(mac.users.get('orchestrate').UniqueID) }); writeFileSync(join(ext, 'robot.json'), typeof c === 'string' ? c : JSON.stringify(c)); }
  if (dispatcher !== null) {
    // What check-dispatcher looks for: the owner's home and host.lock (sam's), and the runner's launches folder.
    chmodSync(mac.prefix, 0o755);   // the stand-in's '/': on a real Mac everyone may search it
    const sam = { uid: 65001, gid: 20 };
    const dirs = []; for (let d = dirname(lock); d !== '/'; d = dirname(d)) dirs.unshift(d);
    for (const d of dirs) { mkdirSync(mac.at(d), { recursive: true }); chmodSync(mac.at(d), 0o755); mac.owners.set(d, d === '/Users' ? { uid: mac.rootUid, gid: 0 } : sam); }
    writeFileSync(mac.at(lock), 'host: mini\n'); chmodSync(mac.at(lock), 0o644); mac.owners.set(lock, sam);
    mkdirSync(mac.at(`${BASE}/review/launches`), { recursive: true });
  }
  mac.as = euid;
  return { mac, ext, raw, cfg, cfgFile, run, runUpdater, updaterRuns, updaterCalls, root, rulesSrc };
}
const DLOCK = '/Users/sam/Sync Folder/host.lock';
const GOOD_DISPATCHER = Object.freeze({ product: 'alpha', productsFile: `${BASE}/home/orchestrate/products.json`, rulesStateDir: `${BASE}/home/orchestrate/rules`, tokenFile: `${BASE}/keys/watch-only-token`, approvalsStateDir: `${BASE}/home/orchestrate/approvals` });
const installed = async () => { const w = await world(); const r = w.run(['install']); assert.equal(r.code, 0, r.text); return w; };
const placed = async () => { const w = await installed(); const r = w.run(['daemons', 'place']); assert.equal(r.code, 0, r.text); return w; };
const failed = (res) => res.filter((r) => !r.ok);
const realCopy = (w) => join(w.mac.at(`${BASE}/install`), readdirSync(w.mac.at(`${BASE}/install`)).find((n) => n.startsWith('orchestrate.v-')));
/** The copy itself: the versioned folder's orchestrate/ (the stamp and the outside files sit beside it, in the folder). */
const copyOf = (w) => join(realCopy(w), 'orchestrate');
const plistFile = (w, job) => w.mac.at(`/Library/LaunchDaemons/${LABEL}.${job}.plist`);

// ───────────────────────────── config and the pins to the launcher's own modules ─────────────────────────────

test('install config: refusals', async () => {
  const w = await world();
  for (const bad of [
    { ...w.raw, address: 'http://example.invalid/x.git' }, { ...w.raw, address: '/local/folder' }, { ...w.raw, address: undefined },
    { ...w.raw, label: 'has space' }, { ...w.raw, label: '-x' }, { ...w.raw, label: '' },
    { ...w.raw, runnerConfig: 'review.json' }, { ...w.raw, gitBin: 'git' }, { ...w.raw, nodeBin: 'node' },
    { ...w.raw, extras: 'x' }, { ...w.raw, extras: ['/x/bin'] }, { ...w.raw, extras: [`/x/${UPDATER_CONFIG}`] }, { ...w.raw, extras: [`/x/${RUNNER_CONFIG}`] },
    { ...w.raw, extras: ['/x/..'] }, { ...w.raw, extras: ['rel/x'] }, { ...w.raw, base: '/Users/x/orch' },
  ]) assert.throws(() => parseInstallConfig(bad), /config/, JSON.stringify(bad).slice(0, 120));
  // A code home's name, in any case (lane 2 on #144; audit #144 P14): the refusal says the name is the copy's own code's.
  for (const name of ['wiring', 'Wiring', 'MODULES', 'shared']) {
    assert.throws(() => parseInstallConfig({ ...w.raw, extras: [...w.raw.extras, `/x/${name}`] }), new RegExp(`extras must not hold /x/${name}: ${name} is the name of a folder of the copy's own code`), name);
  }
  assert.throws(() => parseInstallConfig({ ...w.raw, extras: ['/x/BIN'] }), /config: extras must be full paths/, 'a reserved item name in another case');
});

test('PIN: the label rule here is the launcher\'s (review-daemons.mjs refuses what LABEL_RE refuses, and takes what it takes)', () => {
  const common = { installRoot: '/Library/x/install/orchestrate', logDir: '/Library/x/logs' };
  for (const label of ['a', 'com.example.orch', 'A-b.c1', 'x'.repeat(128), 'x'.repeat(129), '', '-a', '.a', 'a b', 'a/b', 'a\nb', 'a<b', 'é', 'a_b']) {
    let accepted = true; try { updaterPlist({ label, ...common }); } catch { accepted = false; }
    assert.equal(LABEL_RE.test(label), accepted, `label ${JSON.stringify(label)}`);
  }
});

test('PIN: LABEL_RE IS the launcher\'s LABEL (one rule, exported by review-daemons.mjs)', async () => {
  const { LABEL } = await import('../modules/M4-workshop/launcher/review-daemons.mjs');
  assert.equal(LABEL_RE, LABEL);
});

test('PIN: the updater\'s bootstrap copy carries every file the updater imports (a missing one would break root\'s first run)', () => {
  const orch = resolve(HERE, '..');
  const seen = new Set(); const todo = [SCRIPTS.updater];
  while (todo.length) {
    const rel = todo.pop(); if (seen.has(rel)) continue; seen.add(rel);
    const src = readFileSync(join(orch, rel), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      todo.push(join(dirname(rel), m[1] ?? m[2]));
    }
  }
  const have = new Set(BOOTSTRAP_FILES.map((f) => resolve(orch, f)));
  for (const f of seen) assert.ok(have.has(resolve(orch, f)), `${f} is imported by the updater but not in BOOTSTRAP_FILES`);
  for (const f of BOOTSTRAP_FILES) assert.ok(existsSync(join(orch, f)), `${f} is in BOOTSTRAP_FILES but does not exist`);
});

test('the updater\'s own config names everything the updater insists it keeps', async () => {
  const w = await world();
  const uc = updaterConfigFor(w.mac, w.cfg);
  for (const k of Object.keys(MUST_KEEP)) assert.ok(uc.keep.includes(k), `keep lacks ${k}`);
  for (const e of ['claude-bin', 'hooks']) assert.ok(uc.keep.includes(e), e);
  assert.ok(!uc.keep.includes('wiring'), 'the wiring is the copy\'s own code from main, never carried as an extra (#82)');
  assert.equal(uc.installRoot, w.mac.at(installPaths(w.cfg).installRoot));
});

// ───────────────────────────── the install ─────────────────────────────

test('install: dry run prints the steps and changes nothing; not root is refused', async () => {
  const w = await world();
  const before = w.mac.log.length;
  const d = w.run(['install', '--dry-run']);
  assert.equal(d.code, 0, d.text);
  assert.match(d.text, /would run: .*first run as root/);
  assert.equal(w.mac.log.length, before, 'dry run changed something');
  assert.equal(existsSync(w.mac.at(`${BASE}/install`)), false);
  w.mac.as = 501;
  const r = w.run(['install']);
  assert.equal(r.code, 2); assert.match(r.text, /must run as root/);
  assert.equal(w.mac.log.length, before);
});

test('install: the real updater accepts the layout; every item passes; the work folder is gone; a second run does nothing', async () => {
  const w = await installed();
  assert.deepEqual(w.updaterRuns, [0]);
  assert.equal(failed(checkInstall(w.mac, w.cfg)).length, 0, JSON.stringify(failed(checkInstall(w.mac, w.cfg))));
  assert.equal(existsSync(w.mac.at(`${BASE}/install-work`)), false, 'work folder left behind');
  const folder = realCopy(w); const copy = copyOf(w);
  for (const n of [NODE, UPDATER_CONFIG, RUNNER_CONFIG, 'modules/M4-workshop/launcher/review-wiring.mjs', 'claude-bin', 'hooks/h.sh', 'a.txt']) assert.ok(existsSync(join(copy, n)), n);
  assert.ok(existsSync(join(folder, STAMP)), 'the stamp is at the top of the versioned folder'); assert.ok(existsSync(join(folder, 'scripts/blueprint/yaml-lite.mjs')), 'the outside file is beside the copy');
  const stamp = readFileSync(join(folder, STAMP), 'utf8').trim();
  assert.match(stamp, /^[0-9a-f]{40}$/);
  const uc = JSON.parse(readFileSync(join(copy, UPDATER_CONFIG), 'utf8'));
  assert.equal(uc.installRoot, w.mac.at(`${BASE}/install/orchestrate`));
  // L253's setup condition: what this setup places passes the shared job-config reader's parts the review runner uses.
  // The runner config as placed is read by descriptor (a plain file no one else writes), and the wiring it names is
  // one of the copy's own code files. (No Dispatcher, robot or Sensors config is placed on 3 Nov.)
  const placed = openJobJson(join(copy, RUNNER_CONFIG), (why) => { throw new Error(`placed ${RUNNER_CONFIG} ${why}`); }).value;
  const inCopy = (p) => join(copy, p.slice(w.mac.at(`${BASE}/install/orchestrate`).length + 1));
  assert.equal(codeFileProblem(w.mac.at(`${BASE}/install/orchestrate`), placed.wiring, { owner: process.getuid() }), null, 'the placed wiring is a copy code file');
  assert.ok(existsSync(inCopy(placed.wiring)));
  const again = w.run(['install']);
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /already installed/);
  assert.deepEqual(w.updaterRuns, [0], 'a second run ran the updater again');
  const main40 = checkInstall(w.mac, w.cfg, { main: stamp });
  assert.equal(failed(main40).length, 0);
});

test('check after a correct install does not call the install folders strangers (r3 n4); PLANT without the carry it does', async () => {
  const w = await installed();
  const strangers = (rs) => rs.filter((r) => !r.ok && /did not make/.test(r.why ?? ''));
  assert.equal(strangers(check(w.mac, w.cfg, { alsoKnown: rootMadeEntries(w.cfg) })).length, 0);
  assert.ok(strangers(check(w.mac, w.cfg)).some((r) => /install/.test(r.why)), 'the plant: no carry → "install" is a stranger');
});

test('install: refuses a runner config for another place, or one that names things the copy would not carry; nothing is changed', async () => {
  const w = await world();
  const before = w.mac.log.length;
  writeFileSync(w.cfg.runnerConfig, JSON.stringify({ installRoot: '/somewhere/else', wiring: '/somewhere/else/w' }));
  let r = w.run(['install']);
  assert.equal(r.code, 1); assert.match(r.text, /installRoot must be/);
  const wiring = `${w.root}/modules/M4-workshop/launcher/review-wiring.mjs`;
  writeFileSync(w.cfg.runnerConfig, JSON.stringify({ installRoot: w.root, wiring, claudeBin: `${w.root}/not-carried/claude` }));
  r = w.run(['install']);
  assert.equal(r.code, 1); assert.match(r.text, /not inside any of the extras/);
  // The wiring is the copy's own code file from main: one outside modules/ or shared/ (an extra's path, a plain json) is refused.
  for (const bad of [`${w.root}/not-carried/w.json`, `${w.root}/claude-bin`, `${w.root}/modules/x.json`, `${w.root}/modules/../x.mjs`, '/elsewhere/review-wiring.mjs']) {
    writeFileSync(w.cfg.runnerConfig, JSON.stringify({ installRoot: w.root, wiring: bad }));
    r = w.run(['install']);
    assert.equal(r.code, 1, bad); assert.match(r.text, /own code files|is not inside/, bad);
  }
  writeFileSync(w.cfg.runnerConfig, 'not json');
  r = w.run(['install']);
  assert.equal(r.code, 1); assert.match(r.text, /is not valid JSON/);
  assert.equal(w.mac.log.length, before);
});

test('install: a cut-off run (the updater fails) leaves no link, and the next run starts clean and finishes', async () => {
  const w = await world();
  const failing = () => ({ status: 1, stderr: 'boom' });
  const s = sink(); const code = main(w.mac.as === 0 ? ['install'] : ['install', '--config', w.cfgFile], { io: w.mac, runUpdater: failing, out: s.out, err: s.err });
  assert.equal(code, 1); assert.match(text(s), /first run failed/);
  assert.equal(failed(checkInstall(w.mac, w.cfg)).length > 0, true, 'a failed install must not read as installed');
  const r = w.run(['install']);
  assert.equal(r.code, 0, r.text);
  assert.equal(existsSync(w.mac.at(`${BASE}/install-work`)), false);
});

test('install: something other than root\'s link where the copy belongs is refused, not replaced', async () => {
  const w = await world();
  mkdirSync(w.mac.at(`${BASE}/install`)); mkdirSync(w.mac.at(`${BASE}/install/orchestrate`));
  const r = w.run(['install']);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /Nothing was changed/);
  assert.deepEqual(readdirSync(w.mac.at(`${BASE}/install/orchestrate`)), []);
});

// ───────────────────────────── PLANTS: the install check ─────────────────────────────

test('PLANT install: an ACL on an install folder → "none of the … install folders has an access list" FAILS', { skip: !isDarwin }, async () => {
  const w = await installed();
  const r = spawnSync('/bin/chmod', ['+a', 'everyone allow write', join(copyOf(w), 'hooks')]); assert.equal(r.status, 0);
  const bad = failed(checkInstall(w.mac, w.cfg));
  assert.ok(bad.some((b) => /access list/.test(b.what)), JSON.stringify(bad));
});

test('PLANT install: a folder above the copy that others can write → the "root\'s, written by no one else" item FAILS', async () => {
  const w = await installed();
  chmodSync(w.mac.at(`${BASE}/install`), 0o775);
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /written by no one else/.test(b.what)));
});

test('PLANT install: a file in the copy that others can write → the same item FAILS', async () => {
  const w = await installed();
  chmodSync(join(copyOf(w), UPDATER_CONFIG), 0o666);
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /written by no one else/.test(b.what)));
});

test('PLANT install: owned by someone other than root → the link / owner items FAIL (owner stood in as another uid)', async () => {
  const w = await installed();
  w.mac.rootUid = ME + 1;
  assert.ok(failed(checkInstall(w.mac, w.cfg)).length >= 1);
});

test('PLANT install: the commit stamp is gone → the stamp item FAILS; a stamp that is not main\'s → the main item FAILS', async () => {
  const w = await installed();
  const stamp = readFileSync(join(realCopy(w), STAMP), 'utf8').trim();
  assert.ok(failed(checkInstall(w.mac, w.cfg, { main: 'a'.repeat(40) })).some((b) => /main's commit/.test(b.what)));
  assert.equal(failed(checkInstall(w.mac, w.cfg, { main: stamp })).length, 0);
  rmSync(join(realCopy(w), STAMP));
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /stamp/.test(b.what)));
});

test('PLANT install: review.json names another copy → "names this copy" FAILS; a thing it names is missing → "exists in the copy" FAILS', async () => {
  const w = await installed();
  const f = join(copyOf(w), RUNNER_CONFIG);
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, good.replace(/"installRoot":"[^"]*"/, '"installRoot":"/elsewhere"'));
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /names this copy/.test(b.what)));
  writeFileSync(f, good);
  rmSync(join(copyOf(w), 'claude-bin'));
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /claudeBin exists/.test(b.what)));
});

test('PLANT install: a link in the folder above the copy\'s name (the install folder is a link) → FAILS, nothing passes silently', async () => {
  const w = await installed();
  const real = w.mac.at(`${BASE}/install-elsewhere`);
  mkdirSync(real);
  rmSync(w.mac.at(`${BASE}/install`), { recursive: true });
  symlinkSync(real, w.mac.at(`${BASE}/install`));
  assert.ok(failed(checkInstall(w.mac, w.cfg)).length >= 1);
});

test('check-install: exit 1 with a FAIL line when something is wrong, 0 when all pass; --dry-run and a bad --main are usage errors', async () => {
  const w = await installed();
  let r = w.run(['check-install']);
  assert.equal(r.code, 0, r.text); assert.match(r.text, /all \d+ PASS/);
  chmodSync(join(copyOf(w), UPDATER_CONFIG), 0o666);
  r = w.run(['check-install']);
  assert.equal(r.code, 1); assert.match(r.text, /FAIL/);
  assert.throws(() => parseArgs(['check-install', '--config', 'x', '--dry-run']), /never changes/);
  assert.throws(() => parseArgs(['check-install', '--config', 'x', '--main', 'abc']), /40-hex/);
  assert.throws(() => parseArgs(['install', '--config', 'x', '--main', 'a'.repeat(40)]), /only for check-install/);
});

// ───────────────────────────── the background jobs ─────────────────────────────

test('daemons place: three job files, root\'s 0644, exactly what review-daemons.mjs builds, real (unprefixed) paths inside; twice changes nothing', async () => {
  const w = await installed();
  const d = w.run(['daemons', 'place', '--dry-run']);
  assert.equal(d.code, 0, d.text); assert.match(d.text, /would run: write .*review-runner\.plist/);
  assert.equal(existsSync(plistFile(w, 'review-runner')), false, 'dry run wrote a file');
  const r = w.run(['daemons', 'place']);
  assert.equal(r.code, 0, r.text);
  const { plists } = plistTexts(w.mac, w.cfg);
  for (const job of JOBS) {
    assert.equal(readFileSync(plistFile(w, job), 'utf8'), plists[job]);
    assert.equal(w.mac.lstat(`/Library/LaunchDaemons/${LABEL}.${job}.plist`).mode & 0o7777, 0o644);
    assert.ok(plists[job].includes(`<string>${LABEL}.${job}</string>`), job);
    assert.ok(plists[job].includes(`${BASE}/install/orchestrate`) || job === 'review-account', job);
    assert.ok(!plists[job].includes(w.mac.prefix), `${job} carries the test prefix`);
  }
  const owner = reviewDaemonPlists({ label: LABEL, installRoot: `${BASE}/install/orchestrate`, config: `${BASE}/install/orchestrate/${RUNNER_CONFIG}`, reviewRoot: `${BASE}/review`, reviewHome: `${BASE}/home/review`, accountCopy: `${BASE}/account-copy.json`, ownerHome: '/Users/sam', ownerUid: 65001, logDir: `${BASE}/logs` });
  assert.equal(plists['review-runner'], owner.runner);
  assert.equal(plists['review-account'], owner.accountCopy);
  assert.equal(plists['review-updater'], updaterPlist({ label: LABEL, installRoot: `${BASE}/install/orchestrate`, logDir: `${BASE}/logs` }));
  const before = w.mac.log.length;
  const again = w.run(['daemons', 'place']);
  assert.equal(again.code, 0); assert.match(again.text, /nothing to do/);
  assert.equal(w.mac.log.length, before);
});

test('daemons check: files pass, "is loaded" items fail until the jobs are loaded', async () => {
  const w = await placed();
  const res = checkDaemons(w.mac, w.cfg);
  assert.deepEqual(failed(res).map((r) => r.what.replace(/^\S+ /, '')), JOBS.map(() => 'is loaded').map((x, i) => `${LABEL}.${JOBS[i]} is loaded`.replace(/^\S+ /, '')));
  assert.equal(w.run(['daemons', 'check']).code, 1);
});

test('daemons load / list / unload: load starts all three once; a second load does nothing; unload stops them; a second unload is not an error', async () => {
  const w = await placed();
  let r = w.run(['daemons', 'load', '--dry-run']);
  assert.equal(r.code, 0, r.text); assert.equal(w.mac.loaded.size, 0);
  r = w.run(['daemons', 'load']);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual([...w.mac.loaded.keys()].sort(), JOBS.map((j) => `${LABEL}.${j}`).sort());
  assert.equal(failed(checkDaemons(w.mac, w.cfg)).length, 0);
  assert.equal(w.run(['daemons', 'check']).code, 0);
  r = w.run(['daemons', 'load']);
  assert.equal(r.code, 0); assert.match(r.text, /nothing to do/);
  r = w.run(['daemons', 'list']);
  assert.equal(r.code, 0); for (const j of JOBS) assert.match(r.text, new RegExp(`${LABEL}.${j}: loaded`));
  r = w.run(['daemons', 'unload']);
  assert.equal(r.code, 0, r.text); assert.equal(w.mac.loaded.size, 0);
  r = w.run(['daemons', 'unload']);
  assert.equal(r.code, 0, r.text); assert.match(r.text, /nothing to do/);
  assert.ok(list(w.mac, w.cfg).every((j) => !j.loaded));
});

test('daemons: not root is refused for place / load / unload with nothing changed; list and check need no root', async () => {
  const w = await placed();
  w.mac.as = 501;
  const before = w.mac.log.length;
  for (const sub of ['place', 'load', 'unload']) { const r = w.run(['daemons', sub]); assert.equal(r.code, 2, sub); assert.match(r.text, /must run as root/); }
  assert.equal(w.mac.log.length, before);
  assert.equal(w.run(['daemons', 'list']).code, 0);
  assert.equal(w.run(['daemons', 'check']).code, 1);
});

test('PLANT daemons: load before the install → refused, nothing loaded', async () => {
  const w = await world();
  w.run(['daemons', 'place']);
  const r = w.run(['daemons', 'load']);
  assert.equal(r.code, 1); assert.match(r.text, /install is not there yet/);
  assert.equal(w.mac.loaded.size, 0);
});

test('PLANT daemons: load before place → refused naming the missing file, nothing loaded', async () => {
  const w = await installed();
  const r = w.run(['daemons', 'load']);
  assert.equal(r.code, 1); assert.match(r.text, /is not there \(run daemons place first\)/);
  assert.equal(w.mac.loaded.size, 0);
});

test('PLANT daemons: a job file changed by hand → the "exactly the built job file" item FAILS; place puts it right', async () => {
  const w = await placed();
  const f = plistFile(w, 'review-runner');
  writeFileSync(f, `${readFileSync(f, 'utf8')}<!-- edited -->\n`);
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /review-runner\.plist/.test(b.what) && /differs/.test(b.why)));
  assert.equal(w.run(['daemons', 'place']).code, 0);
  assert.ok(!failed(checkDaemons(w.mac, w.cfg)).some((b) => /\.plist/.test(b.what)));
});

test('PLANT daemons: a job file anyone can write (mode 666) → FAILS on the mode; place resets it', async () => {
  const w = await placed();
  chmodSync(plistFile(w, 'review-updater'), 0o666);
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /mode is 666/.test(b.why)));
  assert.equal(w.run(['daemons', 'place']).code, 0);
  assert.equal(failed(checkDaemons(w.mac, w.cfg)).filter((b) => /\.plist/.test(b.what)).length, 0);
});

test('PLANT daemons: a job file owned by someone else → FAILS on the owner; place resets it', async () => {
  const w = await placed();
  w.mac.owners.set('/Library/LaunchDaemons/' + `${LABEL}.review-account.plist`, { uid: ME + 7, gid: 0 });
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /not root/.test(b.why)));
  assert.equal(w.run(['daemons', 'place']).code, 0);
  assert.equal(failed(checkDaemons(w.mac, w.cfg)).filter((b) => /\.plist/.test(b.what)).length, 0);
});

test('PLANT daemons: a link in place of a job file → FAILS ("not a plain file"); place replaces the link with the real file', async () => {
  const w = await placed();
  const f = plistFile(w, 'review-runner'); const keep = readFileSync(f, 'utf8');
  rmSync(f); writeFileSync(join(w.mac.prefix, 'elsewhere.plist'), keep); symlinkSync(join(w.mac.prefix, 'elsewhere.plist'), f);
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /not a plain file/.test(b.why)));
  assert.equal(w.run(['daemons', 'place']).code, 0);
  assert.equal(failed(checkDaemons(w.mac, w.cfg)).filter((b) => /\.plist/.test(b.what)).length, 0);
});

test('PLANT daemons: a missing job file → FAILS "missing"', async () => {
  const w = await placed();
  rmSync(plistFile(w, 'review-account'));
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /missing/.test(b.why)));
});

test('PLANT daemons: an ACL on a job file → FAILS (darwin)', { skip: !isDarwin }, async () => {
  const w = await placed();
  assert.equal(spawnSync('/bin/chmod', ['+a', 'everyone allow write', plistFile(w, 'review-runner')]).status, 0);
  assert.ok(failed(checkDaemons(w.mac, w.cfg)).some((b) => /review-runner\.plist/.test(b.what)));
});

test('PLANT daemons: a job that is not loaded → its "is loaded" item FAILS; a load that launchd refuses stops with the reason', async () => {
  const w = await placed();
  assert.equal(w.run(['daemons', 'load']).code, 0);
  w.mac.loaded.delete(`${LABEL}.review-account`);
  assert.deepEqual(failed(checkDaemons(w.mac, w.cfg)).map((b) => b.what), [`${LABEL}.review-account is loaded`]);
  // the stand-in refuses a bad file as the real launchd does: tell it the file is someone else's, then load.
  w.mac.owners.set(`/Library/LaunchDaemons/${LABEL}.review-account.plist`, { uid: ME + 7, gid: 0 });
  const r = w.run(['daemons', 'load']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /could not load .*review-account/);
});

// ───────────────────────────── the stand-ins refuse what the real tools refuse ─────────────────────────────

test('stand-in launchctl: print of an unknown job is 113; bootstrap and bootout need root; a file with the wrong owner or mode is refused; double load / unload-when-not-loaded fail', async () => {
  const w = await placed();
  const f = plistFile(w, 'review-runner');
  assert.equal(w.mac.launchctl(['print', 'system/nothing']).status, 113);
  w.mac.as = 501;
  assert.equal(w.mac.launchctl(['bootstrap', 'system', f]).status, 1);
  assert.equal(w.mac.launchctl(['bootout', `system/${LABEL}.review-runner`]).status, 1);
  w.mac.as = 0;
  chmodSync(f, 0o666);
  assert.equal(w.mac.launchctl(['bootstrap', 'system', f]).status, 5, 'group/other-writable file accepted');
  chmodSync(f, 0o644);
  w.mac.owners.set('/Library/LaunchDaemons/' + `${LABEL}.review-runner.plist`, { uid: ME + 3, gid: 0 });
  assert.equal(w.mac.launchctl(['bootstrap', 'system', f]).status, 5, 'someone else\'s file accepted');
  w.mac.owners.delete('/Library/LaunchDaemons/' + `${LABEL}.review-runner.plist`);
  assert.equal(w.mac.launchctl(['bootstrap', 'system', f]).status, 0);
  assert.equal(w.mac.launchctl(['bootstrap', 'system', f]).status, 5, 'loaded twice');
  assert.equal(w.mac.launchctl(['bootout', `system/${LABEL}.review-runner`]).status, 0);
  assert.equal(w.mac.launchctl(['bootout', `system/${LABEL}.review-runner`]).status, 3, 'unloaded twice');
  assert.equal(w.mac.launchctl(['bootstrap', 'system', join(w.mac.prefix, 'nope.plist')]).status, 5);
});

test('stand-in: secure and secureFile refuse a path that is not there, a link and the wrong kind; write makes a NEW file only and needs the parent', async () => {
  const w = await world();
  assert.throws(() => w.mac.secure(`${BASE}/nope`, { uid: 0, mode: 0o755 }), /could not be opened/);
  assert.throws(() => w.mac.secureFile(`${BASE}/nope`, { uid: 0, mode: 0o644 }), /could not be opened/);
  assert.throws(() => w.mac.write(`${BASE}/nope/x`, 'x', 0o644), /ENOENT/);
  w.mac.write(`${BASE}/new-file`, 'x', 0o644);
  assert.throws(() => w.mac.write(`${BASE}/new-file`, 'y', 0o644), /EEXIST/, 'a write never overwrites');
  assert.throws(() => w.mac.secure(`${BASE}/new-file`, { uid: 0, mode: 0o755 }), /not a folder/);
  assert.throws(() => w.mac.secureFile(`${BASE}`, { uid: 0, mode: 0o644 }), /not a plain file|could not be opened/);
  symlinkSync(w.mac.at(`${BASE}/new-file`), w.mac.at(`${BASE}/a-link`));
  assert.throws(() => w.mac.write(`${BASE}/a-link`, 'z', 0o644), /EEXIST|ELOOP/, 'a write never goes through a link');
  assert.throws(() => w.mac.secureFile(`${BASE}/a-link`, { uid: 0, mode: 0o644 }), /now a link/);
});

// ───────────────────────────── L90: the wall, and never following a link (PR 2 and PR 3 steps too) ─────────────────────────────

function renameLibrary(lib, other) {
  rmSync(other, { recursive: true }); spawnSync('/bin/mv', [lib, other]); symlinkSync(other, lib);
}

test('PLANT P1: /Library writable by others → install, place, load and unload run NO step (log unchanged), exit 1', async () => {
  const w = await world();
  chmodSync(w.mac.at('/Library'), 0o777);
  const n = w.mac.log.length;
  for (const args of [['install'], ['daemons', 'place'], ['daemons', 'load'], ['daemons', 'unload']]) {
    // As root the config's own wall stops it first (exit 2); the plan's guard is reached by a dry run without root.
    const r = w.run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.text}`);
    assert.match(r.text, /not root's alone/);
    w.mac.as = w.mac.rootUid + 1;
    const d = w.run([...args, '--dry-run']);
    assert.equal(d.code, 1, `${args.join(' ')}: ${d.text}`);
    assert.match(d.text, /folders above \/Library\/orch-test are not safe for root to work in/);
    w.mac.as = 0;
  }
  assert.equal(w.mac.log.length, n, 'a step ran');
});

test('PLANT P7: /Library is a link → install runs no step', async () => {
  const w = await world();
  const lib = w.mac.at('/Library'); const other = w.mac.at('/elsewhere');
  mkdirSync(other); renameLibrary(lib, other);
  const n = w.mac.log.length;
  const r = w.run(['install']);
  assert.equal(r.code, 2, r.text); assert.match(r.text, /is a link|not safe for root/);
  w.mac.as = w.mac.rootUid + 1;
  const d = w.run(['install', '--dry-run']);
  assert.equal(d.code, 1, d.text); assert.match(d.text, /is a link|not safe for root/);
  assert.equal(w.mac.log.length, n);
});

test('the guard is the FIRST step of install, place, load and unload; a folder changed after the plan stops the run with nothing done', async () => {
  for (const o of [{ cmd: 'install' }, { cmd: 'daemons', sub: 'place' }, { cmd: 'daemons', sub: 'load' }, { cmd: 'daemons', sub: 'unload' }]) {
    const w = o.cmd === 'install' ? await world() : await placed();
    if (o.sub === 'unload') w.mac.loaded.set(`${LABEL}.review-runner`, { state: 'waiting' });
    if (o.sub === 'place') rmSync(plistFile(w, 'review-runner'));
    const p = planCommand(w.mac, w.cfg, o, { runUpdater: w.runUpdater });
    assert.deepEqual(p.problems, [], JSON.stringify(o));
    assert.match(p.ops[0].text, /check that every folder above \/Library\/orch-test is root's alone/, JSON.stringify(o));
    chmodSync(w.mac.at('/Library'), 0o777);
    const n = w.mac.log.length;
    assert.throws(() => apply(p.ops), /not safe for root to work in/);
    assert.equal(w.mac.log.length, n, `${JSON.stringify(o)}: a step ran`);
  }
});

test('PLANT /Library/LaunchDaemons writable by others → place writes nothing', async () => {
  const w = await installed();
  chmodSync(w.mac.at('/Library/LaunchDaemons'), 0o777);
  const n = w.mac.log.length;
  const r = w.run(['daemons', 'place']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /LaunchDaemons is not safe for root to write in/);
  assert.equal(w.mac.log.length, n);
});

test('PLANT P2: an install folder swapped for a link to a victim between the plan and the run → refused, the victim unchanged', async () => {
  const w = await world();
  const p = planCommand(w.mac, w.cfg, { cmd: 'install' }, { runUpdater: w.runUpdater });
  assert.deepEqual(p.problems, []);
  const victim = w.mac.at(`${BASE}/victim`); mkdirSync(victim, { mode: 0o700 }); chmodSync(victim, 0o700);
  let swapped = false;
  assert.throws(() => {
    for (const o of p.ops) {
      if (!swapped && /^set owner and mode of .*\/install-work\/bootstrap:/.test(o.text)) { rmSync(w.mac.at(`${BASE}/install-work/bootstrap`), { recursive: true }); symlinkSync(victim, w.mac.at(`${BASE}/install-work/bootstrap`)); swapped = true; }
      o.run();
    }
  }, /now a link/);
  assert.equal(swapped, true);
  assert.equal(statSync(victim).mode & 0o7777, 0o700, 'the victim was changed');
  assert.equal(w.mac.owners.get(`${BASE}/victim`), undefined);
});

test('PLANT the logs folder swapped for a link to a victim between making it and handing it over → refused, the victim unchanged', async () => {
  const w = await installed();
  const p = planCommand(w.mac, w.cfg, { cmd: 'daemons', sub: 'place' });
  assert.ok(p.ops.some((o) => /mkdir .*\/logs/.test(o.text)), p.ops.map((o) => o.text).join('\n'));
  const victim = w.mac.at(`${BASE}/victim`); mkdirSync(victim, { mode: 0o700 }); chmodSync(victim, 0o700);
  let swapped = false;
  assert.throws(() => {
    for (const o of p.ops) {
      o.run();
      if (!swapped && /^mkdir /.test(o.text)) { rmSync(w.mac.at(`${BASE}/logs`), { recursive: true }); symlinkSync(victim, w.mac.at(`${BASE}/logs`)); swapped = true; }
    }
  }, /now a link/);
  assert.equal(swapped, true);
  assert.equal(statSync(victim).mode & 0o7777, 0o700);
  assert.equal(w.mac.owners.get(`${BASE}/victim`), undefined);
});

test('a job file written where a link sits replaces the link itself; the link\'s target is never written or changed', async () => {
  const w = await installed();
  const victim = w.mac.at(`${BASE}/victim.txt`); writeFileSync(victim, 'keep\n', { mode: 0o600 });
  symlinkSync(victim, plistFile(w, 'review-runner'));
  const r = w.run(['daemons', 'place']);
  assert.equal(r.code, 0, r.text);
  assert.equal(readFileSync(victim, 'utf8'), 'keep\n'); assert.equal(statSync(victim).mode & 0o7777, 0o600);
  assert.equal(statSync(plistFile(w, 'review-runner')).isFile(), true);
});

// ───────────────────────────── A8: reload the account job only if it is loaded ─────────────────────────────

test('L173 n5 reload-account: the job is not loaded → says plainly "the account job … is not loaded … Run: daemons load", exit 1, never "nothing to do" or "done", the Mac not touched', async () => {
  const w = await placed(); const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /the account job \(.*review-account\) is not loaded.*Run: daemons load/); assert.doesNotMatch(r.text, /nothing to do|done/); assert.equal(w.mac.log.length, n);
  const d = w.run(['daemons', 'reload-account', '--dry-run']); assert.equal(d.code, 1); assert.match(d.text, /is not loaded/);
});

test('reload-account: loaded with an OLD file (no --install) → the file is rewritten to carry --install <the installed copy>, unloaded, loaded; the other jobs untouched', async () => {
  const w = await placed();
  assert.equal(w.run(['daemons', 'load']).code, 0);
  const f = plistFile(w, 'review-account');
  rmSync(f); writeFileSync(f, readFileSync(plistFile(w, 'review-runner'), 'utf8').replace('review-runner', 'review-account'), { mode: 0o644 });   // some old text
  const { plists } = plistTexts(w.mac, w.cfg);
  assert.ok(plists['review-account'].includes(`<string>--install</string><string>${installPaths(w.cfg).installRoot}</string>`));
  const dry = w.run(['daemons', 'reload-account', '--dry-run']);
  assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /would run: write .*review-account\.plist/); assert.match(dry.text, /would run: launchctl bootout/); assert.match(dry.text, /would run: launchctl bootstrap/);
  const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 0, r.text);
  assert.equal(readFileSync(f, 'utf8'), plists['review-account']);
  const steps = w.mac.log.slice(n).filter((l) => /review-account|launchctl/.test(l) && !/^(chown|chmod) /.test(l));
  assert.deepEqual(steps.map((s) => s.split(' ').slice(0, 2).join(' ')), ['rm /Library/LaunchDaemons/com.example.orch-test.review-account.plist', 'write /Library/LaunchDaemons/com.example.orch-test.review-account.plist', 'launchctl bootout', 'launchctl bootstrap']);
  assert.ok(!w.mac.log.slice(n).some((l) => /review-runner|review-updater/.test(l)), 'another job was touched');
  assert.ok(w.mac.loaded.has(`${LABEL}.review-account`) && w.mac.loaded.has(`${LABEL}.review-runner`));
  assert.deepEqual(failed(checkDaemons(w.mac, w.cfg)), []);
});

test('PLANT reload-account when /Library is writable by others → no step runs (the guard, as for every root command)', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  chmodSync(w.mac.at('/Library'), 0o777); const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 2); assert.equal(w.mac.log.length, n);
});

test('reload-account refuses when not root; --dry-run does not need root', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0); w.mac.as = 1234;   // loaded, so a dry run has a reload to show
  assert.equal(w.run(['daemons', 'reload-account']).code, 2);
  assert.equal(w.run(['daemons', 'reload-account', '--dry-run']).code, 0);
});

// ───────────────────────────── the real read-only tools on this Mac ─────────────────────────────

test('REAL launchctl print: an unknown job is "not loaded" (exit 113), read only', { skip: !isDarwin }, () => {
  const io = realIo();
  const cfg = { label: 'com.example.orch-test-not-a-real-job' };
  const states = list(io, cfg);
  assert.equal(states.length, 3);
  for (const s of states) { assert.equal(s.loaded, false); assert.equal(s.error ?? null, null, String(s.error)); }
});

test('REAL daemons list and check on this Mac with a throwaway prefix: reads only, FAILs for what is not there, changes nothing', { skip: !isDarwin }, async () => {
  const w = await world();
  const before = w.mac.log.length;
  const c = w.run(['check-install']);
  assert.equal(c.code, 1);
  assert.equal(w.mac.log.length, before);
  assert.equal(existsSync(w.mac.at(`${BASE}/install`)), false);
});

// ───────────────────────────── L149: the r4 audit's Minors ─────────────────────────────

const NOT_A_SECRET = 'zz-not-a-real-secret-zz';
const assertNoStep = (w, before, what) => assert.equal(w.mac.log.length, before, `${what}: a step ran`);

test('L149 m1 root reads the runner config through one handle: a link, a file others can write, and a file that is not JSON are refused, and no byte of the file is ever shown', async () => {
  const w = await world(); const before = w.mac.log.length;
  const real = join(w.ext, 'review.json'); const hidden = join(w.ext, 'hidden.json');
  writeFileSync(hidden, `${NOT_A_SECRET} not json`); symlinkSync(hidden, join(w.ext, 'link.json'));
  w.raw.runnerConfig = join(w.ext, 'link.json');
  let r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /the runner config is a link, and a link is not followed/); assert.doesNotMatch(r.text, /zz-not/);
  w.raw.runnerConfig = hidden;
  r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is not valid JSON/); assert.doesNotMatch(r.text, /zz-not/);
  w.raw.runnerConfig = real; chmodSync(real, 0o666);
  r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /can be written by others than root/);
  assertNoStep(w, before, 'install');
  chmodSync(real, 0o644); r = w.run(['install']); assert.equal(r.code, 0, r.text);   // and a plain file of the right kind is fine
});

test('L149 m4 m6 a linked extra, a missing extra and a node root may not run are refused at plan time, before any root step', async () => {
  const w = await world(); const before = w.mac.log.length; const extras = [...w.raw.extras];
  symlinkSync(join(w.ext, 'claude-bin'), join(w.ext, 'claude-link'));
  w.raw.extras = [join(w.ext, 'claude-link'), join(w.ext, 'hooks')];
  let r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /the extra .*claude-link: is a link .*Name the real file/);
  r = w.run(['install', '--dry-run']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is a link/);   // a dry run shows it too
  w.raw.extras = extras; symlinkSync(join(w.ext, 'claude-bin'), join(w.ext, 'hooks', 'inner'));
  r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /inner is a link inside it/);
  rmSync(join(w.ext, 'hooks', 'inner'));
  w.raw.extras = [join(w.ext, 'nope')]; r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /does not exist/);
  w.raw.extras = extras;
  chmodSync(join(w.ext, 'node'), 0o666);   // a node program others can write: root would run a copy of it
  r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /nodeBin .*can be written by others than root/);
  assertNoStep(w, before, 'install'); assert.equal(w.updaterRuns.length, 0);
  chmodSync(join(w.ext, 'node'), 0o755); r = w.run(['install']); assert.equal(r.code, 0, r.text);
});

test('L149 m3 m2 m7 daemons check FAILS on a leftover job under another label, a loaded job older than its file and a job whose last exit is not 0; load reloads the changed job', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  assert.equal(w.run(['daemons', 'check']).code, 0);
  // (a) a leftover set of jobs under another label
  const stray = w.mac.at('/Library/LaunchDaemons/com.example.old.review-updater.plist'); writeFileSync(stray, 'x');
  let r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /FAIL  no job file in .* under another label .*com\.example\.old\.review-updater\.plist/);
  rmSync(stray); assert.equal(w.run(['daemons', 'check']).code, 0);
  // (b) the owner's home folder changes: place rewrites the account job's file, but launchd still runs the old definition
  w.mac.users.get('sam').NFSHomeDirectory = '/Users/sam2';
  r = w.run(['daemons', 'place']); assert.equal(r.code, 0, r.text); assert.match(r.text, /write .*review-account\.plist/);
  r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, new RegExp(`FAIL  ${LABEL}.review-account was loaded from the job file as it is now`)); assert.doesNotMatch(r.text, new RegExp(`FAIL  ${LABEL}.review-updater`));
  const mark = w.mac.log.length;
  r = w.run(['daemons', 'load']); assert.equal(r.code, 0, r.text);
  const steps = w.mac.log.slice(mark).filter((x) => x.startsWith('launchctl'));
  assert.deepEqual(steps, [`launchctl bootout system/${LABEL}.review-account`, `launchctl bootstrap system ${w.mac.at(`/Library/LaunchDaemons/${LABEL}.review-account.plist`)}`]);   // only that job, out and in
  assert.equal(w.run(['daemons', 'check']).code, 0);
  assert.match(w.run(['daemons', 'load']).text, /nothing to do/);
  // (c) a job that keeps crashing
  w.mac.loaded.get(`${LABEL}.review-runner`).lastExit = '78';
  r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, new RegExp(`FAIL  ${LABEL}.review-runner's last run ended well .*last exit code 78`));
  w.mac.loaded.get(`${LABEL}.review-runner`).lastExit = '0'; assert.equal(w.run(['daemons', 'check']).code, 0);
  // (d) L160 m1: "never exited" passes only while the first run is young; a job stuck on its first run, or loaded with no process, FAILs
  const rj = w.mac.loaded.get(`${LABEL}.review-runner`); delete rj.lastExit;
  rj.ageS = 29 * 60; assert.equal(w.run(['daemons', 'check']).code, 0, 'young first run passes');
  rj.ageS = 3 * 3600 + 5 * 60; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, new RegExp(`FAIL  ${LABEL}.review-runner is on its first run.*has been going for 185 minutes`));
  rj.ageS = 2 * 86400; assert.equal(w.run(['daemons', 'check']).code, 1, 'days (dd-hh:mm:ss) counts');
  const pid = rj.pid; delete rj.pid; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /no running process and has never finished a run/);
  rj.pid = pid; rj.ageS = 5; rj.lastExit = '0'; assert.equal(w.run(['daemons', 'check']).code, 0);
  // L169 m1: a LATER run that hangs (pid present, last exit 0) fails too, because launchd starts no new run while one is going
  rj.ageS = 3 * 3600; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, new RegExp(`FAIL  ${LABEL}.review-runner's current run is not stuck.*has been going for 180 minutes`));
  rj.ageS = 29 * 60; assert.equal(w.run(['daemons', 'check']).code, 0, 'a young later run passes');
  rj.ageS = 31 * 60; assert.equal(w.run(['daemons', 'check']).code, 1, 'L180 m5a: 31 minutes is over the 30-minute limit (a 60-minute limit would pass this)');
  rj.ageS = 30 * 60; assert.equal(w.run(['daemons', 'check']).code, 0, 'exactly 30 minutes still passes'); rj.ageS = 29 * 60;
  // L169 a4: a pid that ps does not know (prints nothing): never-exited fails with "no running process"; a job that has exited before just passes
  rj.ageS = 5; const known = rj.pid; rj.pid = 7777; const realPs = w.mac.ps; w.mac.ps = (a) => (Number(a[3]) === rj.pid ? { status: 0, stdout: '', stderr: '' } : realPs(a)); rj.lastExit = '0'; const q = w.run(['daemons', 'check']); assert.equal(q.code, 0, q.text);
  delete rj.lastExit; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /no running process and has never finished a run/);
  // L180 m5b: ps answers (exit 0) with something unreadable: unlike printing nothing, that FAILs, for a later run and a first run
  w.mac.ps = (a) => (Number(a[3]) === rj.pid ? { status: 0, stdout: 'garbled output\n', stderr: '' } : realPs(a));
  rj.lastExit = '0'; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /could not be read/);
  delete rj.lastExit; r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /could not be read/); assert.doesNotMatch(r.text, /NaN/);
  w.mac.ps = realPs; rj.pid = known; rj.lastExit = '0'; assert.equal(w.run(['daemons', 'check']).code, 0);
  // unload forgets the fingerprints: a job loaded again is recorded again
  assert.equal(w.run(['daemons', 'unload']).code, 0); assert.deepEqual(JSON.parse(readFileSync(w.mac.at(`${BASE}/install/loaded-jobs.json`), 'utf8')), {});
});

test('L149 m8 load refuses unless the install check passes (the copy is root\'s alone): nothing is loaded', async () => {
  const w = await placed();
  chmodSync(copyOf(w), 0o777);
  const r = w.run(['daemons', 'load']); assert.equal(r.code, 1, r.text); assert.match(r.text, /the install check fails/); assert.equal(w.mac.loaded.size, 0);
  chmodSync(copyOf(w), 0o755); assert.equal(w.run(['daemons', 'load']).code, 0);
});

test('L149 cosmetic 3 an owner record with no home folder is a plain message, not a stack trace', async () => {
  const w = await installed(); w.mac.users.get('sam').NFSHomeDirectory = '';
  const r = w.run(['daemons', 'place']); assert.equal(r.code, 1, r.text); assert.match(r.text, /the job files cannot be built from the owner's Mac user sam/); assert.doesNotMatch(r.text, /\n\s+at /);
});

test('L149 m9 P12 the logs folder the jobs make is not a stranger to `check`', async () => {
  const w = await placed();
  assert.ok(rootMadeEntries(w.cfg).includes(installPaths(w.cfg).logDir));
  const strangers = check(w.mac, w.cfg, { alsoKnown: rootMadeEntries(w.cfg) }).filter((r) => !r.ok && /did not make/.test(r.why ?? ''));
  assert.deepEqual(strangers, []);
});

test('L149 m9 P14 P20 the updater is started with --first and the seed, a fixed PATH and nothing else of the environment — and spawnUpdater really does it', async () => {
  const w = await installed();
  const call = w.updaterCalls.at(-1); const P = installPaths(w.cfg);
  assert.equal(call.file, w.mac.at(`${P.seed}/${NODE}`));
  assert.deepEqual(call.args.slice(1), [w.mac.at(`${P.seed}/${UPDATER_CONFIG}`), '--first', w.mac.at(P.seed)]);
  assert.deepEqual(Object.keys(call.env), ['PATH']);
  // the REAL spawnUpdater, with node standing in for the copied node and a script that reports what it was given
  const dump = join(w.mac.prefix, 'dump.mjs'); writeFileSync(dump, 'process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }));\n');
  symlinkSync(process.execPath, join(w.mac.prefix, 'node-stand-in'));
  const r = spawnUpdater(w.mac, { node: '/node-stand-in', script: '/dump.mjs', config: '/c.json', seed: '/s' });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stderr);
  assert.deepEqual(seen.argv, [join(w.mac.prefix, 'c.json'), '--first', join(w.mac.prefix, 's')]);
  assert.ok(!seen.env.includes('HOME') && !seen.env.some((k) => /TOKEN|SECRET|KEY/i.test(k)), seen.env.join(','));
  assert.ok(seen.env.includes('PATH'));
});

test('L149 m9 P13 P21 nothing the install or place makes is left without an owner or with a mode nobody set (the stand-in Mac gives no default owner)', async () => {
  const w = await placed();
  for (const job of JOBS) { const st = w.mac.lstat(`/Library/LaunchDaemons/${LABEL}.${job}.plist`); assert.equal(st.uid, w.mac.rootUid, job); assert.equal(st.mode & 0o7777, 0o644, job); }
  writeFileSync(w.mac.at('/nobody-chowned-this'), 'x'); assert.equal(w.mac.lstat('/nobody-chowned-this').uid, -1);
});

// ───────────────────────────── L150 m2: reload-account never ends in a false "done" ─────────────────────────────

test('L150 m2 reload-account: a load that fails leaves the job unloaded; the stop says "run: daemons load"; running reload-account again says the job is NOT loaded (never "nothing to do"); daemons load puts it right', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  const f = plistFile(w, 'review-account'); rmSync(f); writeFileSync(f, 'old text', { mode: 0o644 });
  w.mac.failBootstrap = new Set([`${LABEL}.review-account`]);
  let r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 1, r.text); assert.match(r.text, /could not load .*run: daemons load/); assert.doesNotMatch(r.text, /Run it again after fixing that/, 'one instruction, not two (L173 n5)');
  assert.ok(!w.mac.loaded.has(`${LABEL}.review-account`));
  r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is NOT loaded now/); assert.match(r.text, /Run: daemons load/); assert.doesNotMatch(r.text, /nothing to do|done\./);
  w.mac.failBootstrap = null;
  r = w.run(['daemons', 'load']); assert.equal(r.code, 0, r.text); assert.ok(w.mac.loaded.has(`${LABEL}.review-account`));
  assert.deepEqual(failed(checkDaemons(w.mac, w.cfg)), []);
});

test('L150 m2 a load that says yes but leaves nothing loaded is a failure: load and reload-account both read back', async () => {
  const w = await placed();
  w.mac.bootstrapLies = new Set([`${LABEL}.review-account`]);
  let r = w.run(['daemons', 'load']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is NOT loaded after the load/);
  w.mac.bootstrapLies = null; assert.equal(w.run(['daemons', 'load']).code, 0);
  rmSync(plistFile(w, 'review-account')); w.run(['daemons', 'place']);
  w.mac.users.get('sam').NFSHomeDirectory = '/Users/sam2'; w.run(['daemons', 'place']);
  w.mac.bootstrapLies = new Set([`${LABEL}.review-account`]);
  r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is NOT loaded after the load/);
  assert.match(r.text, /run: daemons load/i); assert.doesNotMatch(r.text, /run it again/i, 'L180 m1: one instruction, not two');
});

test('L173 n5 reload-account on a fresh Mini (never loaded, nothing recorded) says the account job is not loaded and to run daemons load', async () => {
  const w = await placed(); const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 1, r.text); assert.match(r.text, /is not loaded.*Run: daemons load/); assert.doesNotMatch(r.text, /nothing to do/);
});

test('L160 m6 a nodeBin that is a link (even to a root-safe node) is refused at plan time: the copy would be made from the name, not the checked file', async () => {
  const w = await world(); const before = w.mac.log.length;
  const link = join(w.ext, 'node-link'); symlinkSync(join(w.ext, 'node'), link); w.raw.nodeBin = link;
  const r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /nodeBin .*is not the program's own real place.*name .* itself/);
  assertNoStep(w, before, 'install'); assert.equal(w.updaterRuns.length, 0);
  w.raw.nodeBin = join(w.ext, 'node'); assert.equal(w.run(['install']).code, 0);   // the real file itself is fine
});

test('L160 m4 the runner config is read ONCE: the copy root installs is the text that was checked, never a second read of the path', async () => {
  const w = await world(); const orig = w.mac.readSource; const reads = [];
  w.mac.readSource = (p) => { reads.push(p); return orig(p); };
  const checked = readFileSync(w.raw.runnerConfig, 'utf8');
  const r = w.run(['install']); assert.equal(r.code, 0, r.text);
  assert.deepEqual(reads, [w.raw.runnerConfig]);
  assert.equal(readFileSync(w.mac.at(`${BASE}/install/orchestrate/review.json`), 'utf8'), checked);
});

test('L169 m4 the install dry run runs root\'s own read of the runner config and WARNS only when root would refuse it, with the exact reason; a real run and a no-op dry run do not', async () => {
  const w = await world();
  const ok = w.run(['install', '--dry-run']); assert.equal(ok.code, 0, ok.text); assert.doesNotMatch(ok.text, /WARNING/, 'a file root would take: no warning');
  const asWas = w.mac.as; w.mac.as = 501; w.mac.sourceOwner = w.mac.rootUid + 1;   // a dry run as an ordinary user; the file is someone else's, as far as root's read can tell
  const r = w.run(['install', '--dry-run']); assert.equal(r.code, 0, r.text);
  assert.match(r.text, /WARNING  root will refuse .*review\.json: .*not owned by root/);
  assert.match(r.text, /folder only you can open.*sudo install -o root -g wheel -m 0644 \/dev\/stdin .*set runnerConfig in your settings/);
  assert.doesNotMatch(r.text, /can't check that/);
  w.mac.sourceOwner = null; w.mac.as = asWas;
  const real = w.run(['install']); assert.equal(real.code, 0, real.text); assert.doesNotMatch(real.text, /WARNING/);
  const again = w.run(['install', '--dry-run']); assert.doesNotMatch(again.text, /WARNING/);   // nothing left to do: nothing to warn about
});

test('L169 a8 the copy root installs is the text that was checked even if the source file changes right after the read (no second read of the path)', async () => {
  const w = await world(); const orig = w.mac.readSource; const checked = readFileSync(w.raw.runnerConfig, 'utf8');
  w.mac.readSource = (p) => { const t = orig(p); writeFileSync(p, `{"swapped":true}\n`); return t; };
  const r = w.run(['install']); assert.equal(r.code, 0, r.text);
  assert.equal(readFileSync(w.mac.at(`${BASE}/install/orchestrate/review.json`), 'utf8'), checked);
});

test('L169 a11/a14 the REAL io refuses a node program named by a link or with a trailing slash (it must be its own real place)', () => {
  const d = realpathSync(tempDir('orch-a11-')); const io = realIo();
  const lnk = join(d, 'node'); symlinkSync(process.execPath, lnk);
  assert.match(io.nodeBinProblem(lnk), /not the program's own real place/);
  assert.match(io.nodeBinProblem(`${process.execPath}/`) ?? '', /not the program's own real place|could not find/);
});


test('L160 c3 the REAL readers name which config they refuse: the runner config (readSource) and the setup config (readConfig)', () => {
  const d = realpathSync(tempDir('orch-c3-')); const io = realIo();
  writeFileSync(join(d, 'real.json'), '{}'); symlinkSync(join(d, 'real.json'), join(d, 'link.json'));
  assert.throws(() => io.readSource(join(d, 'link.json')), /^Error: the runner config is a link/);
  assert.throws(() => io.readSource(join(d, 'none.json')), /^Error: the runner config file was not found/);
  assert.throws(() => io.readConfig(join(d, 'link.json')), /^Error: the setup config is a link/);
  assert.throws(() => io.readConfig(join(d, 'none.json')), /^Error: the setup config file was not found/);
});

test('R6 m-4 daemons place|load|unload|check --only watch-only through the command: exactly that job, read back, recorded, and check keeps the loaded-record and first-run items', async () => {
  const w = await world({ rules: 'version: 1\n' }); const wl = `${LABEL}.watch-only`;
  assert.equal(w.run(['install']).code, 0);
  assert.equal(w.run(['watch-rules', '--rules-source', w.rulesSrc]).code, 0);
  assert.equal(w.run(['daemons', 'place', '--only', 'watch-only']).code, 0);
  const dry = w.run(['daemons', 'load', '--only', 'watch-only', '--dry-run']); assert.equal(dry.code, 0, dry.text);
  assert.ok(dry.text.includes(`read back: ${wl} is loaded`), dry.text); assert.equal(w.mac.loaded.size, 0);
  const ld = w.run(['daemons', 'load', '--only', 'watch-only']); assert.equal(ld.code, 0, ld.text);
  assert.deepEqual([...w.mac.loaded.keys()], [wl], 'exactly that one job was loaded');
  const rec = () => JSON.parse(readFileSync(w.mac.at(installPaths(w.cfg).install + '/loaded-jobs.json'), 'utf8'));
  assert.deepEqual(Object.keys(rec()), [wl], 'the loaded record names that one job');
  assert.equal(w.run(['daemons', 'check', '--only', 'watch-only']).code, 0);
  // the loaded record is part of the check under --only
  writeFileSync(w.mac.at(installPaths(w.cfg).install + '/loaded-jobs.json'), '{}\n');
  let r = w.run(['daemons', 'check', '--only', 'watch-only']); assert.equal(r.code, 1, r.text); assert.match(r.text, /was loaded from the job file as it is now/);
  assert.equal(w.run(['daemons', 'load', '--only', 'watch-only']).code, 0);
  assert.equal(w.run(['daemons', 'check', '--only', 'watch-only']).code, 0);
  // a first run that never ends is part of the check under --only
  const j = w.mac.loaded.get(wl); delete j.lastExit; j.ageS = 3 * 3600;
  r = w.run(['daemons', 'check', '--only', 'watch-only']); assert.equal(r.code, 1, r.text); assert.match(r.text, /on its first run, and not for long/);
  j.lastExit = '0'; j.ageS = 5;
  // unload --only takes out that job and forgets only it
  w.mac.loaded.set(`${LABEL}.review-runner`, { ...j });   // another job is loaded: unload --only must leave it alone
  const un = w.run(['daemons', 'unload', '--only', 'watch-only']); assert.equal(un.code, 0, un.text);
  assert.deepEqual([...w.mac.loaded.keys()], [`${LABEL}.review-runner`]); assert.deepEqual(Object.keys(rec()), []);
});

test('R6 m-6 a watch-only job file left under an old label is flagged by a full check', async () => {
  const w = await world({ rules: 'version: 1\n' });
  assert.equal(w.run(['install']).code, 0);
  assert.equal(w.run(['watch-rules', '--rules-source', w.rulesSrc]).code, 0);
  assert.equal(w.run(['daemons', 'place']).code, 0);
  writeFileSync(w.mac.at('/Library/LaunchDaemons/com.example.oldlabel.watch-only.plist'), 'x');
  const r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /oldlabel\.watch-only\.plist/);
});

test('L180 m4 the REAL realIo.readSourceStrict: a root-owned file with no links is read, a file you own is refused, a path through a link is refused, and no message shows the file\'s bytes', { skip: !isDarwin || process.getuid?.() === 0 }, () => {
  const io = realIo(); const dir = tempDir('orch-strict-'); const mine = join(dir, 'review.json'); writeFileSync(mine, 'zz-secret-marker-text', { mode: 0o644 });
  assert.equal(typeof io.readSourceStrict('/private/etc/protocols'), 'string');                        // root's, 0644, every folder above root's, no link
  assert.throws(() => io.readSourceStrict(mine), (e) => /not owned by root/.test(e.message) && !/zz-secret/.test(e.message));
  assert.throws(() => io.readSourceStrict('/etc/protocols'), (e) => /link/.test(e.message) && !/zz-secret/.test(e.message));   // /etc is a link to /private/etc
});

test('L180 m5c writeNewFile with `own` never touches the name again after the handle is closed: a file swapped in at the name keeps its mode', () => {
  const dir = tempDir('orch-wnf-'); const f = join(dir, 'secret');
  let swapped = false;
  const chmod = (fd, mode) => { fchmodSync(fd, mode); if (!swapped) { swapped = true; renameSync(f, `${f}.moved`); writeFileSync(f, 'decoy\n', { mode: 0o600 }); } };
  writeNewFile(f, 'token\n', 0o600, { uid: process.getuid(), gid: process.getgid(), mode: 0o640 }, { chmod });
  assert.equal(statSync(`${f}.moved`).mode & 0o7777, 0o640, 'the handle got the mode');
  assert.equal(statSync(f).mode & 0o7777, 0o600, 'the file swapped in at the name was touched by name'); assert.equal(readFileSync(f, 'utf8'), 'decoy\n');
});

// ───────────────────────────── L194: reload-account runs load's install check, and does nothing when there is nothing to do ─────────────────────────────

test('L194 M1 PLANT reload-account refuses unless the install check passes, as load does: a copy others can write is never reloaded', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  chmodSync(copyOf(w), 0o777); const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']);
  assert.equal(r.code, 1, r.text); assert.match(r.text, /the install check fails/);
  assert.ok(!w.mac.log.slice(n).some((l) => /^launchctl (bootout|bootstrap)/.test(l)), 'a job was unloaded or loaded against a copy others can write');
  const d = w.run(['daemons', 'reload-account', '--dry-run']); assert.equal(d.code, 1, d.text); assert.match(d.text, /the install check fails/);
  chmodSync(copyOf(w), 0o755); assert.equal(w.run(['daemons', 'reload-account']).code, 0);
});

test('L194 m1 reload-account run again with nothing to change has no steps: the job (and any pass it is running) is left alone', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  assert.equal(w.run(['daemons', 'reload-account']).code, 0);
  const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 0, r.text);
  assert.match(r.text, /nothing to do: already as needed\.\ndone: all 2 items PASS\./, 'a no-op still ends with its closing check (L198), never a bare "done."');
  assert.deepEqual(w.mac.log.slice(n).filter((l) => /^launchctl (bootout|bootstrap)/.test(l)), []);
  assert.ok(w.mac.loaded.has(`${LABEL}.review-account`)); assert.deepEqual(failed(checkDaemons(w.mac, w.cfg)), []);
  // a job file changed on disk since the load is still reloaded
  const f = plistFile(w, 'review-account'); const good = readFileSync(f, 'utf8');
  rmSync(f); writeFileSync(f, good.replace('</dict>', '<key>Nice</key><integer>1</integer></dict>'), { mode: 0o644 });
  const m = w.mac.log.length;
  assert.equal(w.run(['daemons', 'reload-account']).code, 0);
  assert.ok(w.mac.log.slice(m).some((l) => /^launchctl bootstrap/.test(l)), 'a changed file was not reloaded');
  assert.equal(readFileSync(f, 'utf8'), good);
});

// ───────────────────────────── L203: the #112 audit's probes, kept as tests ─────────────────────────────
test('L203 the job was loaded from an OLDER file and `daemons place` has since rewritten it (no reload): reload-account must still reload', async () => {
  const w = await placed(); const f = plistFile(w, 'review-account'); const good = readFileSync(f, 'utf8');
  rmSync(f); writeFileSync(f, good.replace('</dict>', '<key>Nice</key><integer>1</integer></dict>'), { mode: 0o644 });
  assert.equal(w.run(['daemons', 'load']).code, 0);          // loaded (and recorded) from the older text
  assert.equal(w.run(['daemons', 'place']).code, 0);         // file back to the built text; launchd still runs the older one
  assert.equal(readFileSync(f, 'utf8'), good);
  const n = w.mac.log.length; const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 0, r.text);
  assert.ok(w.mac.log.slice(n).some((l) => /^launchctl bootstrap/.test(l)), 'reload-account skipped a job loaded from an older file');
});
test('L203 reload-account refuses on a missing install (the not-there branch of the shared check)', async () => {
  const w = await placed(); assert.equal(w.run(['daemons', 'load']).code, 0);
  rmSync(w.mac.at(`${BASE}/install/orchestrate`)); const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']); assert.equal(r.code, 1, r.text); assert.match(r.text, /install is not there yet/);
  assert.ok(!w.mac.log.slice(n).some((l) => /^launchctl (bootout|bootstrap)/.test(l)));
});

// ───────────────────────────── the robot job (robot-setup.mjs; L236, L238, L610) ─────────────────────────────

const ROBOT_LABEL = `${LABEL}.robot`;
/** A robot.json as setup lays it out: the copy's wiring, orchestrate as the Record's owner, the keys folder, two locks of its own. */
const goodRobot = ({ mac, root, uid }) => ({
  installRoot: root, wiring: `${root}/wiring/robot-wiring.mjs`, product: 'alpha', ownerUid: uid,
  lockFile: mac.at(`${BASE}/home/orchestrate/robot.lock`), dispatcherLockFile: mac.at(`${BASE}/home/orchestrate/dispatcher.lock`),
  recordRoot: mac.at(`${BASE}/record`), productsFile: mac.at(`${BASE}/home/orchestrate/products.json`), rulesStateDir: mac.at(`${BASE}/home/orchestrate/rules`),
  tokenFile: mac.at(`${BASE}/keys/watch-only-token`), keyDir: mac.at(`${BASE}/keys`),
});
const robotWorld = async (edit = (c) => c) => { const w = await world({ robot: (x) => edit(goodRobot(x), x) }); const r = w.run(['install']); assert.equal(r.code, 0, r.text); return w; };

test('robot job: off unless the config says so; on, its file is the Dispatcher-shaped job as orchestrate, every 60 s, robot-main.mjs with the copy\'s robot.json, its own logs', async () => {
  const off = await world();
  assert.deepEqual(jobsFor(off.cfg), ['review-updater', 'review-account', 'review-runner'], 'a config without "robot" places exactly what it did');
  assert.equal(plistTexts(off.mac, off.cfg).plists.robot, undefined);
  const w = await world({ robot: goodRobot });
  assert.deepEqual(jobsFor(w.cfg), ['review-updater', 'review-account', 'review-runner', 'robot']);
  const t = robotPlist(w.cfg); const R = `${BASE}/install/orchestrate`;
  assert.equal(plistTexts(w.mac, w.cfg).plists.robot, t);
  assert.ok(t.includes(`<key>Label</key><string>${ROBOT_LABEL}</string>`), t);
  assert.ok(t.includes(`<key>ProgramArguments</key><array><string>${R}/${NODE}</string><string>${R}/wiring/robot-main.mjs</string><string>${R}/robot.json</string></array>`), t);
  assert.ok(t.includes('<key>StartInterval</key><integer>60</integer>'), t);
  assert.ok(t.includes(`<key>WorkingDirectory</key><string>${BASE}/home/orchestrate</string>`), t);
  assert.ok(t.includes(`<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>${BASE}/home/orchestrate</string></dict>`), t);
  assert.ok(t.includes('<key>Umask</key><integer>63</integer>'), t);
  assert.deepEqual(jobLogs(t), { user: 'orchestrate', files: [`${BASE}/logs/robot.out.log`, `${BASE}/logs/robot.err.log`] });
  if (process.platform === 'darwin') {
    const f = join(w.ext, 'robot.plist'); writeFileSync(f, t);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' }); assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
});

test('robot job: "robot": true needs its robot.json among the extras; anything but true or false is refused', async () => {
  const w = await world();
  assert.throws(() => parseInstallConfig({ ...w.raw, robot: true }), new RegExp(ROBOT_NO_CONFIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const bad of ['yes', 1, {}]) assert.throws(() => parseInstallConfig({ ...w.raw, robot: bad }), /config: robot must be true or false/, String(bad));
  assert.equal(parseInstallConfig({ ...w.raw, robot: false }).robot, undefined);
  for (const sub of ['place', 'load', 'check']) { const r = w.run(['daemons', sub, '--only', 'robot']); assert.equal(r.code, 2, r.text); assert.match(r.text, /does not turn the robot job on/); }
});

test('robot job: install carries robot.json into the copy; place, load and check take it with the other jobs; its logs are orchestrate\'s; twice does nothing', async () => {
  const w = await robotWorld();
  assert.ok(existsSync(join(w.root, 'robot.json')), 'the copy holds robot.json');
  assert.equal(w.run(['daemons', 'place']).code, 0);
  assert.equal(readFileSync(plistFile(w, 'robot'), 'utf8'), robotPlist(w.cfg));
  for (const f of ['robot.out.log', 'robot.err.log']) assert.equal(w.mac.lstat(`${BASE}/logs/${f}`).uid, Number(w.mac.users.get('orchestrate').UniqueID), f);
  const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 0, ld.text);
  assert.ok(w.mac.loaded.has(ROBOT_LABEL), 'the robot job is loaded');
  const ck = w.run(['daemons', 'check']); assert.equal(ck.code, 0, ck.text);
  assert.match(ck.text, /robot job's config in the copy \(robot\.json\) matches this setup/);
  assert.equal(planPlace(w.mac, w.cfg).ops.length, 0); assert.equal(planLoad(w.mac, w.cfg).ops.length, 0);
  assert.ok(list(w.mac, w.cfg).some((j) => j.label === ROBOT_LABEL && j.loaded));
  const un = w.run(['daemons', 'unload', '--only', 'robot']); assert.equal(un.code, 0, un.text); assert.equal(w.mac.loaded.has(ROBOT_LABEL), false);
});

// Each clause of robotConfigProblem, planted one at a time in the copy's robot.json: load refuses and names it, check FAILs on it.
const ROBOT_PLANTS = [
  ['the wiring is not the copy\'s robot-wiring.mjs', (c) => ({ ...c, wiring: `${c.installRoot}/wiring/dispatcher-wiring.mjs` }), /wiring must be/],
  ['the Record\'s owner is not orchestrate', (c) => ({ ...c, ownerUid: c.ownerUid + 1 }), /ownerUid must be/],
  ['the key folder is another one', (c) => ({ ...c, keyDir: `${c.keyDir}-other` }), /keyDir must be/],
  ['another install named', (c) => ({ ...c, installRoot: `${c.installRoot}-other` }), /installRoot must be/],
  ['its lock is the Dispatcher\'s', (c) => ({ ...c, lockFile: c.dispatcherLockFile }), /a lock of its own/],
  ['a lock inside the install', (c) => ({ ...c, lockFile: `${c.installRoot}/robot.lock` }), /lockFile is inside the install/],
  ['a lock that is not a full path', (c) => ({ ...c, dispatcherLockFile: 'dispatcher.lock' }), /dispatcherLockFile must be a full path/],
  // L740, audit #292 M1 (A1–A3): a lock path the robot could never take, or one a worker could plant, is refused here, not at 03:00.
  ['A1 a lock in a folder that does not exist', (c) => ({ ...c, lockFile: '/no-such-folder-audit/robot.lock' }), /lockFile must be .*home\/orchestrate\/robot\.lock, in orchestrate's home/],
  ['A1 the Dispatcher\'s lock in a folder that does not exist', (c, { mac }) => ({ ...c, dispatcherLockFile: mac.at(`${BASE}/no-such-folder/dispatcher.lock`) }), /dispatcherLockFile: its folder \S*no-such-folder is missing/],
  ['A2 both locks in /tmp, which anyone can write', (c) => ({ ...c, lockFile: '/tmp/robot.lock', dispatcherLockFile: '/tmp/dispatcher.lock' }), /lockFile must be .*orchestrate's home.*dispatcherLockFile: it is not under/],
  ['A3 a lock that reaches the install through ..', (c) => ({ ...c, lockFile: `/tmp/..${c.installRoot}/robot.lock` }), /lockFile must be written plainly/],
  // L738 self-review: root's folder that others can write (a 1777 one, as /tmp is), inside the prefix, so the mode check is reached.
  ['A2 the Dispatcher\'s lock in a root folder others can write', (c, { mac }) => { mkdirSync(mac.at(`${BASE}/shared`)); chmodSync(mac.at(`${BASE}/shared`), 0o1777); mac.owners.set(`${BASE}/shared`, { uid: mac.rootUid, gid: 0 }); return { ...c, dispatcherLockFile: mac.at(`${BASE}/shared/dispatcher.lock`) }; }, /dispatcherLockFile: its folder \S*shared can be written by its group or others/],
  ['A3 the Dispatcher\'s lock written with .. or a doubled /', (c) => ({ ...c, dispatcherLockFile: c.dispatcherLockFile.replace('/orchestrate/', '/orchestrate/../orchestrate//') }), /dispatcherLockFile must be written plainly/],
  ['a key the robot does not take', (c) => ({ ...c, approvalsStateDir: '/x' }), /keys the robot job does not take: approvalsStateDir/],
  ['a bad run deadline', (c) => ({ ...c, runDeadlineMs: -1 }), /runDeadlineMs must be a positive number/],
  ['not JSON', () => '{ not json', /is not JSON/],
  ['not an object', () => '[]', /is not a JSON object/],
];
for (const [what, edit, re] of ROBOT_PLANTS) {
  test(`PLANT robot.json: ${what} → load refuses, check FAILs`, async () => {
    const w = await robotWorld(edit);
    assert.equal(w.run(['daemons', 'place']).code, 0);
    const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text); assert.match(ld.text, re); assert.match(ld.text, /so the robot job would not start/);
    assert.equal(w.mac.loaded.size, 0, 'nothing was loaded');
    const ck = w.run(['daemons', 'check', '--only', 'robot']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, re);
  });
}

// L740, audit #292 M1 (A2): the lock folders themselves. Each planted on its own, after install: load refuses and names it, check FAILs.
const LOCK_FOLDER_PLANTS = [
  ['orchestrate\'s home written by others', (w) => chmodSync(w.mac.at(`${BASE}/home/orchestrate`), 0o777), /lockFile: its folder \S*home\/orchestrate can be written by its group or others/],
  ['orchestrate\'s home owned by a worker', (w) => w.mac.owners.set(`${BASE}/home/orchestrate`, { uid: Number(w.mac.users.get('orchestrate').UniqueID) + 1, gid: 0 }), /lockFile: its folder \S*home\/orchestrate is owned by uid \d+, which may not hold this lock/],
  ['orchestrate\'s home replaced by a link', (w) => { const h = w.mac.at(`${BASE}/home/orchestrate`); renameSync(h, `${h}-real`); symlinkSync(`${h}-real`, h); }, /lockFile: its folder \S*home\/orchestrate is a link/],
  ['a folder above the locks that others can write', (w) => chmodSync(w.mac.at(`${BASE}/home`), 0o777), /lockFile: a folder above it: \S*home can be written by others than root/],
];
for (const [what, plant, re] of LOCK_FOLDER_PLANTS) {
  test(`PLANT robot locks: ${what} → load refuses, check FAILs`, async () => {
    const w = await robotWorld();
    assert.equal(w.run(['daemons', 'place']).code, 0);
    plant(w);
    const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text); assert.match(ld.text, re); assert.equal(w.mac.loaded.size, 0, 'nothing was loaded');
    const ck = w.run(['daemons', 'check', '--only', 'robot']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, re);
  });
}

test('PLANT robot.json: missing from the copy, or not root\'s alone → load refuses, check FAILs', async () => {
  const w = await robotWorld();
  assert.equal(w.run(['daemons', 'place']).code, 0);
  chmodSync(join(w.root, 'robot.json'), 0o666);
  let ld = w.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text); assert.match(ld.text, /robot\.json in the copy is not root's alone/);
  rmSync(join(w.root, 'robot.json'));
  ld = w.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text); assert.match(ld.text, /robot\.json is not in the copy/);
  const ck = w.run(['daemons', 'check', '--only', 'robot']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, /robot\.json is not in the copy/);
});

test('robot job: a robot job file or loaded job the config leaves off, or one under an old label, fails a full check (each optional job, not only the watch job)', async () => {
  const w = await installed();
  assert.equal(w.run(['daemons', 'place']).code, 0); assert.equal(w.run(['daemons', 'load']).code, 0);
  assert.equal(w.run(['daemons', 'check']).code, 0);
  writeFileSync(plistFile(w, 'robot'), 'x');
  let r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /no com\.example\.orch-test\.robot job is placed or loaded \(the config does not turn the robot job on\)/);
  rmSync(plistFile(w, 'robot'));
  w.mac.loaded.set(ROBOT_LABEL, { lastExit: '0', ageS: 5 });
  r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /it is loaded: take it out with sudo node setup\.mjs daemons unload --only robot, then delete /);
  assert.ok(list(w.mac, w.cfg).some((j) => j.label === ROBOT_LABEL), 'list shows a loaded job the config leaves off');
  // audit #292 m3 (A4): the command check names works while the config leaves the robot off, and takes out that job alone.
  for (const sub of ['place', 'load', 'check']) { const x = w.run(['daemons', sub, '--only', 'robot']); assert.equal(x.code, 2, `${sub}: ${x.text}`); assert.match(x.text, /does not turn the robot job on/); }
  const ls = w.run(['daemons', 'list', '--only', 'robot']); assert.equal(ls.code, 0, ls.text); assert.match(ls.text, new RegExp(`${ROBOT_LABEL.replace(/\./g, '\\.')}: loaded`));
  const before = [...w.mac.loaded.keys()].filter((k) => k !== ROBOT_LABEL);
  const one = w.run(['daemons', 'unload', '--only', 'robot']); assert.equal(one.code, 0, one.text);
  assert.equal(w.mac.loaded.has(ROBOT_LABEL), false); assert.deepEqual([...w.mac.loaded.keys()], before, 'the other jobs stay loaded');
  w.mac.loaded.set(ROBOT_LABEL, { lastExit: '0', ageS: 5 });
  assert.equal(w.run(['daemons', 'unload']).code, 0); assert.equal(w.mac.loaded.has(ROBOT_LABEL), false, 'a plain unload takes it out too');
  assert.equal(w.run(['daemons', 'load']).code, 0);
  writeFileSync(w.mac.at('/Library/LaunchDaemons/com.example.oldlabel.robot.plist'), 'x');
  r = w.run(['daemons', 'check']); assert.equal(r.code, 1, r.text); assert.match(r.text, /oldlabel\.robot\.plist/);
});

// ───────────────────────────── the Dispatcher's config and job (dispatcher-setup.mjs; L757) ─────────────────────────────

const D_LABEL = `${LABEL}.dispatcher`;
const D_SRC = `${BASE}/dispatcher.json`;
const dWorld = async (opts = {}) => {
  const w = await world({ dispatcher: true, ...opts });
  const c = w.run(['dispatcher-config']); assert.equal(c.code, 0, c.text);
  const r = w.run(['install']); assert.equal(r.code, 0, r.text);
  return w;
};
const dPlaced = async (opts) => { const w = await dWorld(opts); const p = w.run(['daemons', 'place']); assert.equal(p.code, 0, p.text); return w; };
const copyConfig = (w) => join(w.root, 'dispatcher.json');

test('Dispatcher job: off without its entry; on, the Dispatcher-shaped job as orchestrate, main.mjs with the copy\'s dispatcher.json, HOME, Umask, its own logs', async () => {
  const off = await world();
  assert.ok(!jobsFor(off.cfg).includes('dispatcher'));
  assert.equal(plistTexts(off.mac, off.cfg).plists.dispatcher, undefined);
  const w = await world({ dispatcher: true });
  assert.deepEqual(jobsFor(w.cfg), ['review-updater', 'review-account', 'review-runner', 'dispatcher']);
  const t = dispatcherPlist(w.cfg); const R = `${BASE}/install/orchestrate`; const H = `${BASE}/home/orchestrate`;
  assert.equal(plistTexts(w.mac, w.cfg).plists.dispatcher, t);
  assert.ok(t.includes(`<key>Label</key><string>${D_LABEL}</string>`), t);
  assert.ok(t.includes(`<key>ProgramArguments</key><array><string>${R}/${NODE}</string><string>${R}/modules/M11-dispatcher/main.mjs</string><string>${R}/dispatcher.json</string></array>`), t);
  assert.ok(t.includes('<key>StartInterval</key><integer>60</integer>'), t);
  assert.ok(t.includes(`<key>UserName</key><string>orchestrate</string>`), t);
  assert.ok(t.includes(`<key>WorkingDirectory</key><string>${H}</string>`), t);
  assert.ok(t.includes(`<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>${H}</string></dict>`), t);
  assert.ok(t.includes('<key>Umask</key><integer>63</integer>'), t);
  assert.deepEqual(jobLogs(t), { user: 'orchestrate', files: [`${BASE}/logs/dispatcher.out.log`, `${BASE}/logs/dispatcher.err.log`] });
  if (process.platform === 'darwin') {
    const f = join(w.ext, 'dispatcher.plist'); writeFileSync(f, t);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', f], { encoding: 'utf8' }); assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  }
  for (const sub of ['place', 'load', 'check']) { const r = off.run(['daemons', sub, '--only', 'dispatcher']); assert.equal(r.code, 2, r.text); assert.match(r.text, /does not turn the Dispatcher job on/); }
});

test('Dispatcher config: the entry takes only the owner\'s keys, plain full paths outside the install, a listed product, and needs hostLockPath', async () => {
  const w = await world();
  const raw = { ...w.raw, hostLockPath: DLOCK };
  assert.equal(parseInstallConfig(raw).dispatcher, undefined);
  assert.deepEqual({ ...parseInstallConfig({ ...raw, dispatcher: GOOD_DISPATCHER }).dispatcher }, GOOD_DISPATCHER);
  assert.equal(parseInstallConfig({ ...raw, dispatcher: { ...GOOD_DISPATCHER, runDeadlineMs: 900000 } }).dispatcher.runDeadlineMs, 900000);
  assert.equal(parseInstallConfig({ ...raw, dispatcher: { ...GOOD_DISPATCHER, runDeadlineMs: RUN_DEADLINE_MS } }).dispatcher.runDeadlineMs, RUN_DEADLINE_MS);
  const bad = [
    [{ ...w.raw, dispatcher: GOOD_DISPATCHER }, /needs hostLockPath/],
    [{ ...raw, dispatcher: 'yes' }, /dispatcher must be an object/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, product: 'beta' } }, /product must be one of the config's products/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, lockFile: '/x' } }, /keys it does not take: "lockFile"/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, tokenFile: 'token' } }, /dispatcher\.tokenFile must be a full path/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, rulesStateDir: `${BASE}/home/../keys` } }, /rulesStateDir must be a full path, written plainly/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, productsFile: `${BASE}/install/orchestrate/products.json` } }, /must not be inside the install/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, approvalsStateDir: `${BASE}/home/orchestrate/approvals/` } }, /written plainly/],
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, runDeadlineMs: -1 } }, /runDeadlineMs must be a positive whole number/],
    // Longer than the default the robot judges a pass by: a healthy pass would read as stuck (self-review M1).
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, runDeadlineMs: RUN_DEADLINE_MS + 1 } }, new RegExp(`runDeadlineMs may be at most ${RUN_DEADLINE_MS}`)],
    // The disk ignores case, so INSTALL is the install too (self-review c2).
    [{ ...raw, dispatcher: { ...GOOD_DISPATCHER, productsFile: `${BASE}/INSTALL/orchestrate/products.json` } }, /must not be inside the install/],
    // The name is reserved whether or not the entry is set, so an owner's file of that name never rides into the copy (c3).
    [{ ...w.raw, extras: [...w.raw.extras, join(w.ext, 'dispatcher.json')] }, /extras must be full paths/],
    [{ ...raw, dispatcher: GOOD_DISPATCHER, extras: [...w.raw.extras, join(w.ext, 'dispatcher.json')] }, /extras must be full paths/],
  ];
  for (const [r, re] of bad) assert.throws(() => parseInstallConfig(r), re, JSON.stringify(r.dispatcher));
});

test('Dispatcher config: every key the Dispatcher takes, from the layout and the entry; the Dispatcher\'s own check takes it', async () => {
  const w = await world({ dispatcher: true });
  const { config, problems } = dispatcherConfigFor(w.mac, w.cfg);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(config), CONFIG_KEYS.filter((k) => k !== 'runDeadlineMs'));
  assert.doesNotThrow(() => checkConfig(config));
  const at = (p) => w.mac.at(p); const R = at(`${BASE}/install/orchestrate`);
  const uid = (u) => Number(w.mac.users.get(u).UniqueID);
  assert.deepEqual(config, {
    installRoot: R, wiring: `${R}/wiring/dispatcher-wiring.mjs`, lockFile: at(`${BASE}/home/orchestrate/dispatcher.lock`),
    product: 'alpha', recordRoot: at(`${BASE}/products/alpha/store`), ownerUid: uid('orchestrate'),
    productsFile: at(GOOD_DISPATCHER.productsFile), rulesStateDir: at(GOOD_DISPATCHER.rulesStateDir), tokenFile: at(GOOD_DISPATCHER.tokenFile), approvalsStateDir: at(GOOD_DISPATCHER.approvalsStateDir),
    reviewRequestsDir: at(`${BASE}/review/requests`), reviewStatusFile: at(`${BASE}/review/status.json`), reviewUid: uid('review'),
    reviewRunnerLog: at(`${BASE}/logs/review-runner.err.log`), reviewInstallRoot: R,
    reviewRoot: at(`${BASE}/review`), mirror: at(`${BASE}/mirror`), sealRoot: at(`${BASE}/seals`), hostLockPath: at(DLOCK), hostLockUid: uid('sam'),
  });
  // The five worker keys are dispatcherKeys' (the one source), as the job sees them; host.lock's owner is the owner's uid.
  const k = dispatcherKeysOn(w.mac, w.cfg);
  for (const key of Object.keys(k)) assert.equal(config[key], key === 'hostLockUid' ? k[key] : at(k[key]), key);
  assert.notEqual(config.hostLockUid, config.ownerUid, 'host.lock is the owner\'s, not the Dispatcher\'s');
});

test('Dispatcher config: install refuses until dispatcher-config wrote it; then the copy carries it, the updater keeps it; place, load, check pass; twice does nothing', async () => {
  const w0 = await world({ dispatcher: true });
  const early = w0.run(['install']); assert.equal(early.code, 1, early.text); assert.match(early.text, /run dispatcher-config first/);
  const dry = w0.run(['dispatcher-config', '--dry-run']); assert.equal(dry.code, 0, dry.text); assert.match(dry.text, /would run: write \/Library\/orch-test\/dispatcher\.json/);
  assert.equal(existsSync(w0.mac.at(D_SRC)), false, 'a dry run writes nothing');
  const w = await dWorld();
  const st = w.mac.lstat(D_SRC); assert.deepEqual([st.uid, st.mode & 0o7777], [w.mac.rootUid, 0o644]);
  const want = dispatcherConfigText(dispatcherConfigFor(w.mac, w.cfg).config);
  assert.equal(readFileSync(w.mac.at(D_SRC), 'utf8'), want);
  assert.equal(readFileSync(copyConfig(w), 'utf8'), want, 'the copy holds the same text');
  assert.ok(JSON.parse(readFileSync(join(w.root, UPDATER_CONFIG), 'utf8')).keep.includes('dispatcher.json'), 'the updater keeps it');
  assert.equal(planDispatcherConfig(w.mac, w.cfg).ops.length, 0, 'twice does nothing');
  assert.equal(w.run(['daemons', 'place']).code, 0);
  const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 0, ld.text); assert.ok(w.mac.loaded.has(D_LABEL));
  const ck = w.run(['daemons', 'check']); assert.equal(ck.code, 0, ck.text);
  assert.match(ck.text, /Dispatcher's config in the copy \(dispatcher\.json\) is the one this setup writes/);
  assert.equal(w.run(['check']).code, 0, 'the base file is no stranger to check');
  const un = w.run(['daemons', 'unload', '--only', 'dispatcher']); assert.equal(un.code, 0, un.text); assert.equal(w.mac.loaded.has(D_LABEL), false);
});

test('Dispatcher config: changed later, dispatcher-config rewrites both files; a copy made before the Dispatcher was set up says to install again', async () => {
  const w = await dPlaced();
  w.raw.dispatcher = { ...GOOD_DISPATCHER, runDeadlineMs: 600000 }; w.cfg = parseInstallConfig(w.raw);
  const ck0 = w.run(['daemons', 'check', '--only', 'dispatcher']); assert.equal(ck0.code, 1, ck0.text); assert.match(ck0.text, /not the config this setup writes now \(run dispatcher-config\)/);
  const r = w.run(['dispatcher-config']); assert.equal(r.code, 0, r.text); assert.match(r.text, /all 2 items PASS/);
  assert.equal(JSON.parse(readFileSync(copyConfig(w), 'utf8')).runDeadlineMs, 600000);
  // An install from before: its updater's keep has no dispatcher.json.
  const old = await installed();
  old.raw.hostLockPath = DLOCK; old.raw.dispatcher = { ...GOOD_DISPATCHER }; old.cfg = parseInstallConfig(old.raw);
  const r2 = old.run(['dispatcher-config']); assert.equal(r2.code, 1, r2.text); assert.match(r2.text, /does not keep dispatcher\.json .*install again/);
  assert.equal(existsSync(copyConfig(old)), false, 'nothing is put in a copy that would drop it');
});

// Each clause, planted one at a time after a good install and place: load refuses and names it, nothing loads, check FAILs.
const D_PLANTS = [
  ['the copy\'s file differs by one value', (w) => { const f = copyConfig(w); const c = JSON.parse(readFileSync(f, 'utf8')); c.lockFile = '/tmp/dispatcher.lock'; chmodSync(f, 0o644); rmSync(f); writeFileSync(f, dispatcherConfigText(c)); chmodSync(f, 0o644); }, /not the config this setup writes now/],
  ['the copy\'s file written by its group', (w) => chmodSync(copyConfig(w), 0o664), /not root's alone|has mode 664/],
  ['the copy\'s file gone', (w) => rmSync(copyConfig(w)), /dispatcher\.json is not in the copy/],
  // Root's alone yet not 644: orchestrate, which the job runs as, could not read it.
  ['the copy\'s file mode 600', (w) => chmodSync(copyConfig(w), 0o600), /orchestrate\/dispatcher\.json has mode 600, want 644/],
  // The file is fine but the copy's folder is not root's alone, so another user could swap it.
  ['the copy\'s folder written by its group', (w) => chmodSync(w.root, 0o775), /dispatcher\.json in the copy is not root's alone: /],
  // The file is there, but the copy's updater would drop it on the next update.
  ['the copy\'s updater does not keep it', (w) => { const f = join(w.root, UPDATER_CONFIG); const u = JSON.parse(readFileSync(f, 'utf8')); u.keep = u.keep.filter((k) => k !== 'dispatcher.json'); chmodSync(f, 0o600); writeFileSync(f, JSON.stringify(u, null, 2) + '\n'); chmodSync(f, 0o644); }, /was made before the Dispatcher was set up, so its updater does not keep dispatcher\.json/],
  ['the copy\'s file a link', (w) => { const f = copyConfig(w); renameSync(f, `${w.ext}/d.json`); symlinkSync(`${w.ext}/d.json`, f); }, /not root's alone|not a plain file/],
  ['the copy\'s file with a second name', (w) => { linkSync(copyConfig(w), join(w.root, 'second.json')); }, /orchestrate\/dispatcher\.json has 2 names/],
  ['the Dispatcher\'s lock folder writable by others', (w) => chmodSync(w.mac.at(`${BASE}/home/orchestrate`), 0o777), /the Dispatcher's lock \(lockFile\): its folder .* can be written by its group or others/],
  ['check-dispatcher FAILs: no launches folder', (w) => rmSync(w.mac.at(`${BASE}/review/launches`), { recursive: true }), /check-dispatcher FAILs .*launches/],
  ['check-dispatcher FAILs: host.lock orchestrate can\'t read', (w) => chmodSync(w.mac.at(DLOCK), 0o600), /check-dispatcher FAILs .*host\.lock/],
];
for (const [what, plant, re] of D_PLANTS) {
  test(`PLANT Dispatcher: ${what} → load refuses, check FAILs`, async () => {
    const w = await dPlaced();
    plant(w);
    const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text); assert.match(ld.text, re);
    assert.equal(w.mac.loaded.size, 0, 'nothing was loaded');
    if (!/check-dispatcher/.test(what)) { const ck = w.run(['daemons', 'check', '--only', 'dispatcher']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, re); }
  });
}

test('Dispatcher job: host.lock in a folder macOS guards is NOT TRIED in check-dispatcher, and does not stop the load (only the job can prove it)', async () => {
  const lock = '/Users/sam/Library/CloudStorage/Sync/host.lock';
  const w = await dPlaced({ lock });
  const cd = w.run(['check-dispatcher']); assert.equal(cd.code, 1, cd.text); assert.match(cd.text, /NOT TRIED/);
  const ld = w.run(['daemons', 'load']); assert.equal(ld.code, 0, ld.text); assert.ok(w.mac.loaded.has(D_LABEL));
});

test('Dispatcher with the robot job: robot.json must name the same Record and the Dispatcher\'s lock', async () => {
  const same = ({ mac, root, uid }) => ({ installRoot: root, wiring: `${root}/wiring/robot-wiring.mjs`, product: 'alpha', ownerUid: uid,
    lockFile: mac.at(`${BASE}/home/orchestrate/robot.lock`), dispatcherLockFile: mac.at(`${BASE}/home/orchestrate/dispatcher.lock`),
    recordRoot: mac.at(`${BASE}/products/alpha/store`), productsFile: mac.at(GOOD_DISPATCHER.productsFile), rulesStateDir: mac.at(GOOD_DISPATCHER.rulesStateDir),
    tokenFile: mac.at(GOOD_DISPATCHER.tokenFile), keyDir: mac.at(`${BASE}/keys`) });
  const w = await dPlaced({ robot: same });
  const ok = w.run(['daemons', 'check', '--only', 'dispatcher']);
  assert.match(ok.text, /PASS {2}the Dispatcher's config in the copy/, ok.text);
  const w2 = await dPlaced({ robot: (x) => ({ ...same(x), recordRoot: x.mac.at(`${BASE}/record`), dispatcherLockFile: x.mac.at(`${BASE}/home/orchestrate/other.lock`) }) });
  const ld = w2.run(['daemons', 'load']); assert.equal(ld.code, 1, ld.text);
  assert.match(ld.text, /must name the same Record and lock; they differ in recordRoot, dispatcherLockFile/);
  // Loading or checking only the robot holds the two together too (self-review M2).
  const only = w2.run(['daemons', 'load', '--only', 'robot']); assert.equal(only.code, 1, only.text);
  assert.match(only.text, /they differ in recordRoot, dispatcherLockFile.*so the robot job would not start/);
  assert.equal(w2.mac.loaded.size, 0, 'nothing was loaded');
  const ck = w2.run(['daemons', 'check', '--only', 'robot']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, /they differ in recordRoot, dispatcherLockFile/);
  assert.equal(w.run(['daemons', 'load', '--only', 'robot']).code, 0, 'the same Record and lock: the robot alone loads');
  // A Dispatcher config that can't be built says why, so a robot-only load or check is not left without a reason (r2 m4).
  w.mac.users.delete('orchestrate');
  assert.match(robotMatchProblem(w.mac, w.cfg), /can't be built from this setup \(the orchestrate user does not exist \(run users-folders first\)\)/);
});

test('Dispatcher config: each file is written whole and renamed over its name; root writes in the copy only when it is root\'s alone', async () => {
  const w = await dPlaced();
  w.raw.dispatcher = { ...GOOD_DISPATCHER, runDeadlineMs: 600000 }; w.cfg = parseInstallConfig(w.raw);
  const from = w.mac.log.length;
  const r = w.run(['dispatcher-config']); assert.equal(r.code, 0, r.text);
  const log = w.mac.log.slice(from);
  const copyFile = `${BASE}/install/orchestrate/dispatcher.json`;
  for (const f of [D_SRC, copyFile]) {
    const tmp = join(dirname(f), '.dispatcher.json.new');
    assert.ok(log.includes(`rename ${tmp} ${f}`), `planted: a writer that removes ${f} first leaves a gap with no file (${log.join(' | ')})`);
    assert.ok(!log.includes(`rm ${f}`), `${f} is never removed`);
    assert.equal(existsSync(w.mac.at(tmp)), false, 'no temporary file is left');
  }
  // A copy with a file its group can write: root won't write in it.
  w.raw.dispatcher = { ...GOOD_DISPATCHER, runDeadlineMs: 500000 }; w.cfg = parseInstallConfig(w.raw);
  chmodSync(join(w.root, UPDATER_CONFIG), 0o664);
  const before = readFileSync(copyConfig(w), 'utf8');
  const r2 = w.run(['dispatcher-config']); assert.equal(r2.code, 1, r2.text); assert.match(r2.text, /the installed copy is not root's alone .*so root won't write in it/);
  assert.equal(readFileSync(copyConfig(w), 'utf8'), before, 'planted: a writer without the copy check writes here');
  // The base file took the new text, so install is not refused for it and replaces the copy: no stuck state (r2 m1).
  assert.equal(readFileSync(w.mac.at(D_SRC), 'utf8'), dispatcherConfigText(dispatcherConfigFor(w.mac, w.cfg).config), 'the base file is written first');
  assert.match(r2.text, /unload the jobs, remove .*\/install, run install/);
  rmSync(w.mac.at(`${BASE}/install`), { recursive: true, force: true });
  const inst = w.run(['install']); assert.equal(inst.code, 0, inst.text);
  assert.equal(readFileSync(copyConfig(w), 'utf8'), readFileSync(w.mac.at(D_SRC), 'utf8'), 'the new copy carries the new text');
  assert.equal(w.run(['dispatcher-config']).code, 0, 'and dispatcher-config then has nothing to do');
  // A rename that fails leaves no side file behind, and the old file as it was (r2 m2).
  w.raw.dispatcher = { ...GOOD_DISPATCHER, runDeadlineMs: 400000 }; w.cfg = parseInstallConfig(w.raw);
  const old = readFileSync(w.mac.at(D_SRC), 'utf8'); const real = w.mac.rename;
  w.mac.rename = () => { const e = new Error('EIO: rename failed'); e.code = 'EIO'; throw e; };
  const r3 = w.run(['dispatcher-config']); w.mac.rename = real; assert.equal(r3.code, 1, r3.text);
  assert.equal(existsSync(w.mac.at(join(dirname(D_SRC), '.dispatcher.json.new'))), false, 'planted: a writer without the clean-up leaves the side file');
  assert.equal(readFileSync(w.mac.at(D_SRC), 'utf8'), old, 'the old file is unchanged');
});

test('Dispatcher job: daemons check reads a run as stuck only past the Dispatcher\'s deadline and the watchdog\'s margin', async () => {
  assert.ok(DISPATCHER_RUN_LIMIT_S * 1000 >= RUN_DEADLINE_MS + WATCHDOG_MARGIN_MS, 'a healthy pass is never stuck');
  assert.ok(DISPATCHER_RUN_LIMIT_S * 1000 <= RUN_DEADLINE_MS + WATCHDOG_MARGIN_MS + 120_000, 'and a hung one is told soon after');
  const w = await dPlaced();
  const ld = w.run(['daemons', 'load', '--only', 'dispatcher']); assert.equal(ld.code, 0, ld.text);
  const job = w.mac.loaded.get(D_LABEL); job.lastExit = '0';
  // Past the review jobs' 30 minutes but inside the Dispatcher's own limit: a healthy pass, not stuck.
  job.ageS = FIRST_RUN_LIMIT_S + 60; let ck = w.run(['daemons', 'check', '--only', 'dispatcher']); assert.equal(ck.code, 0, `planted: the Dispatcher judged by the review jobs' limit (${ck.text})`);
  assert.match(ck.text, new RegExp(`current run is not stuck \\(at most ${Math.ceil(DISPATCHER_RUN_LIMIT_S / 60)} minutes\\)`));
  job.ageS = DISPATCHER_RUN_LIMIT_S + 1; ck = w.run(['daemons', 'check', '--only', 'dispatcher']); assert.equal(ck.code, 1, ck.text); assert.match(ck.text, /current run is not stuck.*has been going for/);
  delete job.lastExit; job.ageS = FIRST_RUN_LIMIT_S + 60; assert.equal(w.run(['daemons', 'check', '--only', 'dispatcher']).code, 0, 'a first run is held to the same limit');
});

// The base file is what install carries into the copy: each fault in it, planted after dispatcher-config, stops the install.
for (const [what, plant] of [
  ['owned by another user', (w) => w.mac.owners.set(D_SRC, { uid: 65001, gid: 20 })],
  ['mode 666', (w) => chmodSync(w.mac.at(D_SRC), 0o666)],
  ['with a second name', (w) => linkSync(w.mac.at(D_SRC), w.mac.at(`${BASE}/d2.json`))],
  ['a link', (w) => { renameSync(w.mac.at(D_SRC), w.mac.at(`${BASE}/d2.json`)); symlinkSync(w.mac.at(`${BASE}/d2.json`), w.mac.at(D_SRC)); }],
  ['other text', (w) => { const f = w.mac.at(D_SRC); chmodSync(f, 0o644); writeFileSync(f, '{}\n'); }],
]) {
  test(`PLANT Dispatcher: the base dispatcher.json ${what} → install refuses`, async () => {
    const w = await world({ dispatcher: true });
    const c = w.run(['dispatcher-config']); assert.equal(c.code, 0, c.text);
    plant(w);
    const r = w.run(['install']); assert.equal(r.code, 1, r.text); assert.match(r.text, /run dispatcher-config first/);
    assert.equal(existsSync(copyConfig(w)), false, 'nothing reached a copy');
  });
}

// Tests for setup part 2 (the install and the background jobs). Same stand-in Mac as setup.test.mjs, plus a launchctl
// stand-in. The install test runs the REAL updater (as a child process, on a local folder standing in for GitHub through
// the updater's own test-only options) against the install the setup built, so a wrong layout is refused by the real code.
// PLANT tests break one clause each and name the check that catches it. The last tests run read-only tools on this Mac.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitOk } from '../modules/M4-workshop/git/safe-git.mjs';
import { SCRIPTS, reviewDaemonPlists, updaterPlist } from '../modules/M4-workshop/launcher/review-daemons.mjs';
import { NODE, RUNNER_CONFIG, STAMP, UPDATER_CONFIG } from '../modules/M4-workshop/launcher/install-check.mjs';
import { MUST_KEEP } from '../modules/M4-workshop/launcher/review-updater.mjs';
import { realIo } from './mac.mjs';
import { ROOT_CONFIG_PATH } from './layout.mjs';
import { BOOTSTRAP_FILES, LABEL_RE, installPaths, parseInstallConfig, updaterConfigFor } from './install.mjs';
import { JOBS, checkDaemons, list, plistTexts } from './daemons.mjs';
import { checkInstall, rootMadeEntries } from './install.mjs';
import { main, parseArgs, planCommand } from './setup.mjs';
import { apply, check } from './users-folders.mjs';
import { fakeMac, macTest as test } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';

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
  await gitOk(['add', '-A'], sg); await gitOk(['commit', '-q', '-m', 'first'], sg);
  await gitOk(['push', '-q', '-f', bare, 'HEAD:refs/heads/main'], sg);
  return bare;
}

/** The throwaway Mac with the users and folders already set up (part 1), and the files the install needs. */
async function world({ euid = 0 } = {}) {
  const mac = fakeMac({ euid: 0 });
  const ext = tempDir('orch-setup-ext-');
  const bare = await origin(ext);
  // The runner's config, as the lead's wiring would hand it over, and the three things it names.
  mkdirSync(join(ext, 'wiring'));
  writeFileSync(join(ext, 'wiring', 'wiring.json'), '{}\n');
  writeFileSync(join(ext, 'claude-bin'), '#!/bin/sh\n'); chmodSync(join(ext, 'claude-bin'), 0o755);
  mkdirSync(join(ext, 'hooks')); writeFileSync(join(ext, 'hooks', 'h.sh'), '#!/bin/sh\n'); chmodSync(join(ext, 'hooks', 'h.sh'), 0o755);
  const root = mac.at(`${BASE}/install/orchestrate`);
  writeFileSync(join(ext, 'review.json'), JSON.stringify({ installRoot: root, wiring: `${root}/wiring/wiring.json`, claudeBin: `${root}/claude-bin`, hooksDir: `${root}/hooks` }));
  mkdirSync(join(mac.prefix, 'gitbin'));
  writeFileSync(join(mac.prefix, 'gitbin', 'git'), `#!/bin/sh\nexec '${GIT}' "$@"\n`); chmodSync(join(mac.prefix, 'gitbin', 'git'), 0o755);
  writeFileSync(join(ext, 'node'), '#!/bin/sh\n'); chmodSync(join(ext, 'node'), 0o755);
  const raw = {
    base: BASE, owner: 'sam', products: ['alpha'], address: 'https://example.invalid/org/repo.git', label: LABEL,
    runnerConfig: join(ext, 'review.json'), extras: [join(ext, 'wiring'), join(ext, 'claude-bin'), join(ext, 'hooks')],
    gitBin: join(mac.prefix, 'gitbin', 'git'), nodeBin: join(ext, 'node'),
  };
  const cfgFile = join(ext, 'install.json'); writeFileSync(cfgFile, JSON.stringify(raw));
  const cfg = parseInstallConfig(raw);
  // The updater's first run, for real, in a child: the setup's own seed and bootstrap copy, GitHub's address swapped for the
  // local folder (the one option the updater has for tests), `owner`/`top` standing in for root and `/` as its own tests do.
  const runner = join(ext, 'run-updater.mjs');
  writeFileSync(runner, 'import { pathToFileURL } from "node:url";\nconst [script, opts, ...argv] = process.argv.slice(2);\nconst { main } = await import(pathToFileURL(script).href);\nprocess.exitCode = await main(argv, { ...JSON.parse(opts), gitTools: () => null });\n');
  const updaterRuns = [];
  const runUpdater = (io, { script, config, seed }) => {
    const c = JSON.parse(readFileSync(io.at(config), 'utf8'));
    writeFileSync(io.at(config), JSON.stringify({ ...c, address: bare }));
    const r = spawnSync(process.execPath, [runner, io.at(script), JSON.stringify({ uid: ME, owner: ME, top: mac.prefix, localAddress: true, pathDirs: [] }), io.at(config), '--first', io.at(seed)], { encoding: 'utf8' });
    updaterRuns.push(r.status);
    return { status: r.status ?? 1, stderr: r.stderr };
  };
  const argvFor = (args) => { if (mac.as === 0) { const f = mac.at(ROOT_CONFIG_PATH); rmSync(f, { force: true }); writeFileSync(f, JSON.stringify(raw)); chmodSync(f, 0o644); return args; } return [...args, '--config', cfgFile]; };
  const run = (args, extra = {}) => { const s = sink(); const code = main(argvFor(args), { io: mac, runUpdater, out: s.out, err: s.err, ...extra }); return { code, text: text(s), s }; };
  const folders = run(['users-folders']);
  assert.equal(folders.code, 0, folders.text);
  mac.as = euid;
  return { mac, ext, raw, cfg, cfgFile, run, runUpdater, updaterRuns, root };
}
const installed = async () => { const w = await world(); const r = w.run(['install']); assert.equal(r.code, 0, r.text); return w; };
const placed = async () => { const w = await installed(); const r = w.run(['daemons', 'place']); assert.equal(r.code, 0, r.text); return w; };
const failed = (res) => res.filter((r) => !r.ok);
const realCopy = (w) => join(w.mac.at(`${BASE}/install`), readdirSync(w.mac.at(`${BASE}/install`)).find((n) => n.startsWith('orchestrate.v-')));
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
});

test('PIN: the label rule here is the launcher\'s (review-daemons.mjs refuses what LABEL_RE refuses, and takes what it takes)', () => {
  const common = { installRoot: '/Library/x/install/orchestrate', logDir: '/Library/x/logs' };
  for (const label of ['a', 'com.example.orch', 'A-b.c1', 'x'.repeat(128), 'x'.repeat(129), '', '-a', '.a', 'a b', 'a/b', 'a\nb', 'a<b', 'é', 'a_b']) {
    let accepted = true; try { updaterPlist({ label, ...common }); } catch { accepted = false; }
    assert.equal(LABEL_RE.test(label), accepted, `label ${JSON.stringify(label)}`);
  }
});

test('PIN: LABEL_RE is the same pattern text as LABEL in review-daemons.mjs (delete the copy when lane 2 exports it)', () => {
  const src = readFileSync(resolve(HERE, '..', SCRIPTS.daemons ?? 'modules/M4-workshop/launcher/review-daemons.mjs'), 'utf8');
  const theirs = /^(?:export )?const LABEL = (\/.+\/);?\s*$/m.exec(src)?.[1];
  assert.ok(theirs, 'could not find LABEL in review-daemons.mjs');
  assert.equal(String(LABEL_RE), theirs);
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
  for (const e of ['wiring', 'claude-bin', 'hooks']) assert.ok(uc.keep.includes(e), e);
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
  const copy = realCopy(w);
  for (const n of [NODE, UPDATER_CONFIG, RUNNER_CONFIG, STAMP, 'wiring/wiring.json', 'claude-bin', 'hooks/h.sh', 'a.txt']) assert.ok(existsSync(join(copy, n)), n);
  const stamp = readFileSync(join(copy, STAMP), 'utf8').trim();
  assert.match(stamp, /^[0-9a-f]{40}$/);
  const uc = JSON.parse(readFileSync(join(copy, UPDATER_CONFIG), 'utf8'));
  assert.equal(uc.installRoot, w.mac.at(`${BASE}/install/orchestrate`));
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
  writeFileSync(w.cfg.runnerConfig, JSON.stringify({ installRoot: w.root, wiring: `${w.root}/not-carried/w.json` }));
  r = w.run(['install']);
  assert.equal(r.code, 1); assert.match(r.text, /not inside any of the extras/);
  writeFileSync(w.cfg.runnerConfig, 'not json');
  r = w.run(['install']);
  assert.equal(r.code, 1); assert.match(r.text, /can't be read as JSON/);
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
  const r = spawnSync('/bin/chmod', ['+a', 'everyone allow write', join(realCopy(w), 'hooks')]); assert.equal(r.status, 0);
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
  chmodSync(join(realCopy(w), UPDATER_CONFIG), 0o666);
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
  const f = join(realCopy(w), RUNNER_CONFIG);
  const good = readFileSync(f, 'utf8');
  writeFileSync(f, good.replace(/"installRoot":"[^"]*"/, '"installRoot":"/elsewhere"'));
  assert.ok(failed(checkInstall(w.mac, w.cfg)).some((b) => /names this copy/.test(b.what)));
  writeFileSync(f, good);
  rmSync(join(realCopy(w), 'claude-bin'));
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
  chmodSync(join(realCopy(w), UPDATER_CONFIG), 0o666);
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

test('reload-account: the job is not loaded → nothing to do, exit 0, the Mac not touched (a no-op, as the runbook expects on a fresh Mini)', async () => {
  const w = await placed(); const n = w.mac.log.length;
  const r = w.run(['daemons', 'reload-account']);
  assert.equal(r.code, 0, r.text); assert.match(r.text, /nothing to do/); assert.equal(w.mac.log.length, n);
  const d = w.run(['daemons', 'reload-account', '--dry-run']); assert.equal(d.code, 0); assert.match(d.text, /nothing to do/);
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
  const w = await placed(); w.mac.as = 1234;
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

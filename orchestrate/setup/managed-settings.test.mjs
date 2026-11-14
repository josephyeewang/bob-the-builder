// L1031, L1044: setup.mjs managed-settings, on the stand-in Mac. The guard every session will run is tried in-process here with
// this test's uid standing in for root (the real hook always means root, 0); some tests run the real hook and node too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { tempDir } from '../shared/test-tmp.mjs';
import { reinstallSteps } from './install.mjs';
import { apply } from './users-folders.mjs';
import { installPaths } from './install.mjs';
import { managedGuardDir, managedRulesPath } from './layout.mjs';
import { GUARD, GUARD_FILES, NODE_BIN, WAY_OUT, blockedByRule, checkManagedSettings, copyRules, isOurs, planManagedSettings, probeCalls, runGuard } from './managed-settings.mjs';
import { parseArgs } from './setup.mjs';
import { decide } from '../modules/M4-workshop/hooks/production-write-guard.mjs';
import { makeSnapshot, readSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { CLAUDE_FILE, checkMachineWide } from '../modules/M4-workshop/launcher/env-check.mjs';
import { machineWideSettings, MACHINE_WIDE_FAILS_CLOSED } from '../modules/M4-workshop/launcher/render-settings.mjs';

const HOOKS_SRC = join(dirname(fileURLToPath(import.meta.url)), '../modules/M4-workshop/hooks');
const BASE = '/Library/orchestrate';
const RULES = Object.freeze({ production: { env_files: ['/srv/app/prod-settings.conf'], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: ['/srv/app/keys'] } });
const COPIED = copyRules(RULES);   // the production block alone (L1044 c1)
const NOW = new Date('2026-11-12T00:00:00Z');

/** A stand-in Mac with the hooks installed in the copy, the runner config in place and a node root may run. */
function world({ rc = {}, hooks = true } = {}) {
  const mac = fakeMac();
  const cfg = { base: BASE, owner: 'sam', products: ['alpha'], runnerConfig: join(mac.prefix, 'runner-review.json') };
  const P = installPaths(cfg);
  const hooksDir = join(mac.at(P.installRoot), 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const d of ['/Library', BASE, P.install, P.installRoot]) chmodSync(mac.at(d), 0o755);
  if (hooks) for (const n of readdirSync(HOOKS_SRC).filter((n) => n.endsWith('.mjs') && !n.includes('.test'))) { copyFileSync(join(HOOKS_SRC, n), join(hooksDir, n)); chmodSync(join(hooksDir, n), 0o644); }
  chmodSync(hooksDir, 0o755);
  mkdirSync(mac.at('/Library/Application Support'), { recursive: true });
  writeFileSync(cfg.runnerConfig, JSON.stringify({ hooksDir, machineWide: CLAUDE_FILE, rules: RULES, ...rc }));
  const node = join(mac.prefix, 'node'); writeFileSync(node, '#!/bin/sh\n'); chmodSync(node, 0o755);
  // The guard, as a session would run it, with this test's uid as root: a block says runHook's own line.
  const calls = [];
  const guard = ({ hook, copy, input }) => { calls.push({ hook, copy, input }); const r = decide(input, { machineWide: true, snapshot: copy, ownerUid: mac.rootUid }); return { code: r.block ? 2 : 0, stderr: r.block ? `[orchestrate] blocked: ${r.reason}\n` : '' }; };
  const plan = (over = {}) => planManagedSettings(mac, cfg, { nodeBin: node, guard, now: () => NOW, ...over });
  const dir = mac.at(managedGuardDir(cfg));
  return { mac, cfg, P, hooksDir, node, plan, calls, dir, file: mac.at(CLAUDE_FILE), copy: mac.at(managedRulesPath(cfg)) };
}
const run = (p) => { assert.deepEqual(p.problems, []); apply(p.ops); };
const absent = () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; };
const failing = (rows) => rows.filter((r) => !r.ok);

test('L1031, L1044 M2: managed-settings fills the guard\'s own folder, tries it in the side folder and again where it lives, THEN places managed-settings.json; again it does nothing', () => {
  const w = world();
  const p = w.plan();
  const texts = p.ops.map((o) => o.text);
  const at = (re) => texts.findIndex((t) => re.test(t));
  const triedNext = at(/^run the guard in .*\.next /); const live = at(/^rename .*\.next\/rules\.json → /); const triedLive = at(/^read back .*rules\.json and run the guard where it now lives/);
  const fileIn = at(/^rename .*managed-settings\.json\.writing → /);
  assert.ok(at(/^read back .*\.next as the guard will/) < triedNext && triedNext < live && live < triedLive && triedLive < fileIn, `guard a's order: ${texts.join(' | ')}`);
  assert.equal(texts.slice(0, triedNext).some((t) => /^rename /.test(t)), false, 'nothing is renamed live before the side folder\'s trial');
  run(p);
  // The folder, outside install: the guard and its two modules, as installed, and the copy, each root's 0644.
  assert.equal(managedGuardDir(w.cfg), join(BASE, 'machine-wide-guard')); assert.ok(!managedGuardDir(w.cfg).startsWith(w.P.install));
  assert.deepEqual(readdirSync(w.dir).sort(), [...GUARD_FILES, 'rules.json'].sort(), 'no side folder left');
  assert.equal(statSync(w.dir).mode & 0o777, 0o755); assert.deepEqual(w.mac.owners.get(managedGuardDir(w.cfg)), { uid: w.mac.rootUid, gid: 0 });
  for (const n of GUARD_FILES) {
    assert.equal(readFileSync(join(w.dir, n), 'utf8'), readFileSync(join(w.hooksDir, n), 'utf8'), n);
    assert.equal(statSync(join(w.dir, n)).mode & 0o777, 0o644); assert.deepEqual(w.mac.owners.get(join(managedGuardDir(w.cfg), n)), { uid: w.mac.rootUid, gid: 0 });
  }
  const r = readSnapshot(w.copy, { maxAgeMs: Infinity, ownerUid: w.mac.rootUid });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.rules, COPIED, 'the production block alone, no secret paths (c1)');
  assert.equal(statSync(w.copy).mode & 0o777, 0o644); assert.deepEqual(w.mac.owners.get(managedRulesPath(w.cfg)), { uid: w.mac.rootUid, gid: 0 });
  // The file: exactly the built settings, naming the guard's folder, root's 0644, and launch check 10 takes it.
  const text = readFileSync(w.file, 'utf8');
  assert.equal(text, `${JSON.stringify(machineWideSettings({ node: w.node, hooksDir: w.dir, snapshot: w.copy }), null, 1)}\n`);
  assert.ok(!text.includes(w.P.install), 'the hook names nothing in install');
  assert.equal(statSync(w.file).mode & 0o777, 0o644); assert.deepEqual(w.mac.owners.get(CLAUDE_FILE), { uid: w.mac.rootUid, gid: 0 });
  assert.deepEqual(w.mac.owners.get(dirname(CLAUDE_FILE)), { uid: w.mac.rootUid, gid: 0 }); assert.equal(statSync(dirname(w.file)).mode & 0o777, 0o755);
  assert.deepEqual(checkMachineWide({ readFile: (q) => (q === CLAUDE_FILE ? text : absent()), path: CLAUDE_FILE, listDir: absent, plist: () => null, user: () => 'sam', home: () => '/Users/sam' }), { ok: true });
  assert.deepEqual(failing(checkManagedSettings(w.mac, w.cfg)), []);
  assert.deepEqual(readdirSync(dirname(w.file)).filter((n) => n.includes('.writing')), [], 'no side file left');
  // The guard was tried on both calls in the side folder, then on both where it lives, before the file was placed.
  const pr = probeCalls(COPIED);
  assert.deepEqual(w.calls.map((c) => c.input), [pr.pass, pr.block, pr.pass, pr.block]);
  assert.deepEqual(w.calls.map((c) => [c.hook, c.copy]), [
    [join(w.dir, '.next', GUARD), join(w.dir, '.next', 'rules.json')], [join(w.dir, '.next', GUARD), join(w.dir, '.next', 'rules.json')],
    [join(w.dir, GUARD), w.copy], [join(w.dir, GUARD), w.copy]]);
  // Again: nothing to do.
  assert.deepEqual(w.plan(), { ops: [], problems: [], installed: true });
});

test('L1044 M2: a reinstall that removes the install folder leaves the guard whole; the real hook command still runs it', () => {
  if (process.getuid() === 0) return;
  const w = world(); run(w.plan());
  rmSync(w.mac.at(w.P.install), { recursive: true, force: true });
  assert.equal(existsSync(w.hooksDir), false);
  // In-process: the guard, from its folder, lets a harmless call through and blocks a production one.
  assert.equal(decide(probeCalls(COPIED).pass, { machineWide: true, snapshot: w.copy, ownerUid: w.mac.rootUid }).block, false);
  assert.equal(decide({ tool_name: 'Read', cwd: '/', tool_input: { file_path: '/srv/app/prod-settings.conf' } }, { machineWide: true, snapshot: w.copy, ownerUid: w.mac.rootUid }).block, true);
  // The real command, with this node: the script and its modules load from the guard's folder (no "Cannot find module").
  // Run as a user, it judges the copy against root (0), so it blocks by its own rule; that it got that far is the point.
  const cmd = machineWideSettings({ node: process.execPath, hooksDir: w.dir, snapshot: w.copy }).hooks.PreToolUse[0].hooks[0].command;
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(probeCalls(COPIED).pass), encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /^\[orchestrate\] blocked: .*machine-wide rules copy is not root's alone/m);
  assert.doesNotMatch(r.stderr, /Cannot find module|could not run/);
  // check-install's known entries name the folder, so a users-folders check does not call it a stranger.
  assert.ok(existsSync(w.dir));
});

test('L1044 M2: a guard that can\'t run at all (its script gone) still blocks, and the hook says the way out', () => {
  const d = tempDir('orch-mw-gone-');   // #487 r2 c3: the shared temp helper
  try {
    const cmd = machineWideSettings({ node: process.execPath, hooksDir: join(d, 'nothing'), snapshot: join(d, 'rules.json') }).hooks.PreToolUse[0].hooks[0].command;
    assert.ok(cmd.endsWith(MACHINE_WIDE_FAILS_CLOSED));
    const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8' });
    assert.equal(r.status, 2, 'blocked');
    assert.match(r.stderr, /the machine-wide guard could not run; .*sudo rm "\/Library\/Application Support\/ClaudeCode\/managed-settings\.json"/);
    // A block by the guard itself (its own exit 2) gets no extra words; a pass passes.
    for (const [code, said] of [[2, false], [0, false], [1, true]]) {
      const s = spawnSync('/bin/sh', ['-c', `${process.execPath} -e "process.exit(${code})"${MACHINE_WIDE_FAILS_CLOSED}`], { encoding: 'utf8' });
      assert.equal(s.status, code === 0 ? 0 : 2, `exit ${code}`); assert.equal(/could not run/.test(s.stderr), said, `exit ${code}`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1031: rules changed in the runner config are carried on the next run, over the guard this command wrote', () => {
  const w = world(); run(w.plan());
  const rules = { ...RULES, production: { ...RULES.production, hosts: ['other.example.com'] } };
  writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules }));
  run(w.plan());
  assert.deepEqual(readSnapshot(w.copy, { maxAgeMs: Infinity, ownerUid: w.mac.rootUid }).rules, copyRules(rules));
  assert.deepEqual(w.calls.at(-1).input.tool_input, { url: 'https://other.example.com/' });
});

test('L1031 guard a, L1044 m2: a copy that does not read back stops the run before anything goes live; an earlier copy stays as it was', () => {
  for (const placedBefore of [false, true]) {
    const w = world();
    if (placedBefore) { run(w.plan()); writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules: { ...RULES, production: { ...RULES.production, programs: ['vercel', 'flyctl'] } } })); }
    const before = existsSync(w.file) ? readFileSync(w.file, 'utf8') : null;
    const copyBefore = existsSync(w.copy) ? readFileSync(w.copy, 'utf8') : null;
    const calls = w.calls.length;
    // The copy is written broken (a fingerprint that does not match), as a bad write or a full disk might leave it.
    const write = w.mac.write;
    w.mac.write = (q, text, mode) => write(q, q.endsWith('.next/rules.json') ? text.replace(/"hash":"[0-9a-f]+"/, `"hash":"${'0'.repeat(64)}"`) : text, mode);
    const p = w.plan();
    assert.throws(() => apply(p.ops), /did not read back \(rules snapshot hash does not match\), so .*managed-settings\.json was not placed/);
    assert.equal(existsSync(w.file) ? readFileSync(w.file, 'utf8') : null, before, 'managed-settings.json is as it was');
    assert.equal(existsSync(w.copy) ? readFileSync(w.copy, 'utf8') : null, copyBefore, 'the live copy is as it was (m2)');
    assert.equal(w.calls.length, calls, 'the guard is not even tried on a copy that did not read back');
  }
  // A copy that reads back whole (fingerprint and owner fine) but holds other rules than the runner config's is refused too.
  {
    const w = world(); const write = w.mac.write;
    w.mac.write = (q, text, mode) => write(q, q.endsWith('.next/rules.json') ? `${makeSnapshot({ production: { ...RULES.production, hosts: [] } }, NOW)}\n` : text, mode);
    assert.throws(() => apply(w.plan().ops), /the rules copy .* read back with other rules, so .*managed-settings\.json was not placed/);
    assert.equal(existsSync(w.file), false); assert.equal(existsSync(w.copy), false);
    assert.equal(w.calls.length, 0, 'the guard is not tried on a copy with other rules');
  }
  // A copy left writable by others is refused the same way.
  {
    const w = world(); const secure = w.mac.secureFile;
    w.mac.secureFile = (q, want) => secure(q, q.endsWith('.next/rules.json') ? { ...want, mode: 0o666 } : want);
    assert.throws(() => apply(w.plan().ops), /did not read back \(the machine-wide rules copy is not root's alone/);
    assert.equal(existsSync(w.file), false);
  }
  // A guard file that does not copy whole is refused before the trial.
  const w = world(); const copy = w.mac.copyFile;
  w.mac.copyFile = (src, q, mode) => (q.endsWith(`.next/lib.mjs`) ? w.mac.write(q, '// cut short\n', mode) : copy(src, q, mode));
  assert.throws(() => apply(w.plan().ops), /\.next\/lib\.mjs did not read back as installed/);
  assert.equal(existsSync(w.file), false); assert.equal(w.calls.length, 0);
});

test('L1031 guard a, L1044 m6 A9: a guard that blocks a harmless call, lets a production one through, or crashes on it, stops the run before anything goes live', () => {
  for (const [guard, re] of [
    [() => ({ code: 2, stderr: '[orchestrate] blocked: rules snapshot is missing or unreadable\n' }), /the guard in .*\.next blocked a harmless call \(\[orchestrate\] blocked: rules snapshot is missing or unreadable\)/],
    [() => ({ code: 0, stderr: '' }), /the guard in .*\.next did not block a production call by its own rule \(it let it through\)/],
    // A crash on the production call reads as a block by exit code alone: it must not pass for one (A9).
    [({ input }) => (input.tool_input.command === 'true' ? { code: 0, stderr: '' } : { code: 2, stderr: 'TypeError: x is not a function\n', status: 1 }), /did not block a production call by its own rule \(TypeError/],
    [({ input }) => (input.tool_input.command === 'true' ? { code: 0, stderr: '' } : { code: 2, stderr: '[orchestrate] blocked: hook error, refusing: boom\n', status: 2 }), /did not block a production call by its own rule \(\[orchestrate\] blocked: hook error/],
  ]) {
    const w = world();
    assert.throws(() => apply(w.plan({ guard }).ops), re);
    assert.equal(existsSync(w.file), false, 'not placed'); assert.equal(existsSync(w.copy), false, 'nothing live');
    assert.equal(existsSync(dirname(w.file)), false, 'Claude\'s folder is made only after the trial');
  }
  assert.equal(blockedByRule({ code: 2, status: 2, stderr: '[orchestrate] blocked: "vercel" reaches production\n' }), true);
  assert.equal(blockedByRule({ code: 2, status: 1, stderr: '[orchestrate] blocked: x\n' }), false, 'node\'s own exit 1');
  assert.equal(blockedByRule({ code: 2, status: null, stderr: '' }), false, 'a time-out');
});

test('L1044 m6 A9: runGuard, the real spawn: a hook that crashes is never read as a block by its rule', () => {
  const d = join(process.env.TMPDIR ?? '/tmp', `mw-crash-${process.pid}`); mkdirSync(d, { recursive: true });
  try {
    const hook = join(d, 'crash.mjs'); writeFileSync(hook, 'throw new Error("boom");\n');
    const r = runGuard({ node: process.execPath, hook, copy: join(d, 'x.json'), input: {} });
    assert.equal(r.code, 2); assert.equal(blockedByRule(r), false);
    const gone = runGuard({ node: join(d, 'no-node'), hook, copy: join(d, 'x.json'), input: {} });
    assert.equal(gone.code, 2); assert.equal(blockedByRule(gone), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('L1031 guard a: the real hook and node, on a copy root does not own, block the harmless call, so the file is never placed', () => {
  if (process.getuid() === 0) return;
  const w = world();
  // The real guard script in the side folder, run with this node: it judges ownership against root (0) for real.
  w.mac.nodeBinProblem = () => null;   // this test's node is not root's; the trial is what is under test
  const q = planManagedSettings(w.mac, w.cfg, { nodeBin: process.execPath, guard: runGuard });
  assert.deepEqual(q.problems, []);
  let err; try { apply(q.ops); } catch (e) { err = e; }
  assert.match(err?.message ?? '', /the guard in .*\.next blocked a harmless call \(.*not root's alone.*sudo rm/);
  assert.equal(existsSync(w.file), false); assert.equal(existsSync(w.copy), false);
});

test('L1031: refusals, each before anything is changed', () => {
  const cases = [
    [{ rc: { hooksDir: undefined } }, /hooksDir must be .*run review-config without --for-install, put it in place, and run add-to-install first/],
    [{ rc: { machineWide: '/etc/claude.json' } }, /machineWide must be \/Library\/Application Support\/ClaudeCode\/managed-settings\.json/],
    [{ rc: { rules: { production: { env_files: [], programs: [] }, secrets: { paths: [] } } } }, /must set rules\.production\.hosts/],
    [{ rc: { rules: undefined } }, /rules must be an object/],
    [{ hooks: false }, /the guard's .*production-write-guard\.mjs is not there: run add-to-install first/],
  ];
  for (const [opts, re] of cases) {
    const w = world(opts);
    const p = w.plan();
    assert.deepEqual(p.ops, []); assert.match(p.problems.join('\n'), re);
  }
  // Each guard file writable by others; the node root may not run; a runner config that is not JSON; a file where the folder goes.
  for (const n of GUARD_FILES) { const w = world(); chmodSync(join(w.hooksDir, n), 0o666); assert.match(w.plan().problems.join('\n'), new RegExp(`${n.replace('.', '\\.')} is not a plain file that is root's alone`)); }
  let w = world(); w.mac.nodeBinProblem = () => 'it is not root\'s';
  assert.match(w.plan().problems.join('\n'), /can't be the node every session runs the guard with: it is not root's\. Install node from nodejs\.org \(it goes to \/usr\/local\/bin\/node\)/);
  w = world(); writeFileSync(w.cfg.runnerConfig, '{not json'); assert.match(w.plan().problems.join('\n'), /is not valid JSON/);
  w = world(); writeFileSync(w.cfg.runnerConfig, '[]'); assert.match(w.plan().problems.join('\n'), /must be one JSON object/);
  w = world(); writeFileSync(w.dir, 'a file'); assert.match(w.plan().problems.join('\n'), /machine-wide-guard is not a plain folder/);
});

test('L1031: a managed-settings.json this command did not write is never replaced; a file or link where Claude\'s folder is, refused', () => {
  for (const other of ['{"permissions":{"deny":["Bash(rm:*)"]}}', '{not json', '{}',
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/n /h/production-write-guard.mjs --machine-wide --snapshot /c || exit 2' }, { type: 'command', command: 'x' }] }] } })]) {
    const w = world(); mkdirSync(dirname(w.file)); writeFileSync(w.file, other);
    const p = w.plan();
    assert.deepEqual(p.ops, []); assert.match(p.problems.join('\n'), /holds settings this command did not write; it is left as it is\. .*sudo rm "\/Library\/Application Support\/ClaudeCode\/managed-settings\.json"/);
    assert.equal(readFileSync(w.file, 'utf8'), other);
  }
  const w = world(); writeFileSync(join(w.mac.prefix, 'Library/Application Support/ClaudeCode'), 'a file');
  assert.match(w.plan().problems.join('\n'), /ClaudeCode is not a plain folder/);
  assert.equal(isOurs(machineWideSettings({ node: NODE_BIN, hooksDir: '/a/machine-wide-guard', snapshot: '/a/machine-wide-guard/rules.json' })), true);
  // r1's form (the guard in install, ` || exit 2`) is ours too, so a rerun moves it to the guard's folder.
  const r1 = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/node /b/install/c/hooks/production-write-guard.mjs --machine-wide --snapshot /b/machine-wide-rules.json || exit 2', timeout: 30, onFailure: 'block' }] }] } };
  assert.equal(isOurs(r1), true);
  { const v = world(); mkdirSync(dirname(v.file)); writeFileSync(v.file, JSON.stringify(r1)); run(v.plan()); assert.match(readFileSync(v.file, 'utf8'), /machine-wide-guard\/production-write-guard\.mjs/); }
});

test('L1031: rules that name nothing still place the guard, said as a WARNING; the guard is then tried on the harmless call only', () => {
  const w = world({ rc: { rules: { production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } } } });
  const p = w.plan();
  assert.deepEqual(p.warnings, ['the rules name no production host, program or settings file, so the guard blocks nothing']);
  run(p); assert.equal(w.calls.length, 2, 'once in the side folder, once where it lives');
});

test('L1031: setup.mjs takes managed-settings with --dry-run only, and the way out names the one file, run from Terminal with sudo', () => {
  assert.equal(parseArgs(['managed-settings']).cmd, 'managed-settings');
  assert.equal(parseArgs(['managed-settings', '--dry-run']).dry, true);
  for (const bad of [['managed-settings', '--pin', '2.1.316'], ['managed-settings', '--input', '/x'], ['managed-settings', '--main', 'a'.repeat(40)]]) assert.throws(() => parseArgs(bad));
  assert.equal(WAY_OUT, `To switch the machine-wide guard off: open the Terminal app (not Claude) and run  sudo rm "${CLAUDE_FILE}"  then start Claude again.`);
  assert.throws(() => machineWideSettings({ node: '/usr/local/bin/node', hooksDir: '/Library/Application Support/x', snapshot: '/a' }), /plain absolute path/);
  assert.throws(() => machineWideSettings({ node: '/usr/local/bin/node', hooksDir: '/a/../b', snapshot: '/a' }), /plain absolute path/);
});

test('L1031, L1044 m3 m4 m6: checkManagedSettings says what is wrong once something moves', () => {
  const fresh = () => { const w = world(); run(w.plan()); assert.deepEqual(failing(checkManagedSettings(w.mac, w.cfg)), []); return w; };
  const says = (w, re) => { const bad = failing(checkManagedSettings(w.mac, w.cfg)); assert.ok(bad.length, 'a row fails'); assert.match(bad.map((r) => `${r.what}: ${r.why}`).join(' | '), re); };
  // A broken copy.
  let w = fresh(); writeFileSync(w.copy, makeSnapshot({ ...COPIED, extra: 1 }).replace(/"hash":"[0-9a-f]+"/, '"hash":"x"')); says(w, /hash does not match/);
  // A12: a copy others can write (read with the owner rule).
  w = fresh(); chmodSync(w.copy, 0o666); says(w, /not root's alone/);
  // m4: the runner config's rules changed since the copy was made.
  w = fresh(); writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules: { ...RULES, production: { ...RULES.production, hosts: ['new.example.com'] } } }));
  says(w, /holds the runner config's production rules.*changed since the copy was made: run managed-settings again/);
  // A changed secret path alone is no drift: the copy carries the production block only.
  w = fresh(); writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules: { ...RULES, secrets: { paths: [] } } }));
  assert.deepEqual(failing(checkManagedSettings(w.mac, w.cfg)), []);
  // A7: the file's mode.
  w = fresh(); chmodSync(w.file, 0o664); says(w, /managed-settings\.json is root's 0644/);
  // A8: a hook that names another copy (still this guard's shape).
  w = fresh(); writeFileSync(w.file, JSON.stringify(machineWideSettings({ node: w.node, hooksDir: w.dir, snapshot: '/elsewhere/rules.json' })));
  says(w, /its hook does not run .*machine-wide-guard\/production-write-guard\.mjs on .*rules\.json/);
  // A guard file changed or others can write it; the folder others can write.
  w = fresh(); chmodSync(join(w.dir, 'lib.mjs'), 0o666); says(w, /lib\.mjs is root's 0644/);
  w = fresh(); chmodSync(w.dir, 0o775); says(w, /the guard's folder .* is root's 0755/);
  // m3: launch check 10 itself: a drop-in beside the file that carries no guard overrides it.
  w = fresh(); const drop = w.mac.at('/Library/Application Support/ClaudeCode/managed-settings.d'); mkdirSync(drop); writeFileSync(join(drop, '10-x.json'), '{"permissions":{"allow":["Bash(*)"]}}');
  says(w, /launch check 10.*(allow or ask rules|not in force)/);
});

test('#487 r2 m3: new guard code installed after a run is no "nothing to do": the check says so, and a rerun puts it live', () => {
  for (const n of GUARD_FILES) {
    const w = world(); run(w.plan());
    assert.deepEqual(w.plan(), { ops: [], problems: [], installed: true }, 'unchanged: nothing to do');
    writeFileSync(join(w.hooksDir, n), `${readFileSync(join(w.hooksDir, n), 'utf8')}\n// newer\n`);
    const bad = failing(checkManagedSettings(w.mac, w.cfg));
    assert.deepEqual(bad.map((r) => r.what), [`${join(managedGuardDir(w.cfg), n)} is the installed ${join(w.hooksDir, n)}`], n);
    assert.match(bad[0].why, /run managed-settings again/);
    const p = w.plan();
    assert.notEqual(p.installed, true, `${n}: a rerun has work to do`); assert.ok(p.ops.length > 0, n);
    run(p);
    assert.equal(readFileSync(join(w.dir, n), 'utf8'), readFileSync(join(w.hooksDir, n), 'utf8'), `${n} is live`);
    assert.deepEqual(failing(checkManagedSettings(w.mac, w.cfg)), [], n);
    assert.deepEqual(w.plan(), { ops: [], problems: [], installed: true }, `${n}: then nothing to do`);
  }
});

test('#487 r2 m4: isOurs takes only this guard\'s own hook command; one `*` hook running anything else is not ours', () => {
  const good = machineWideSettings({ node: NODE_BIN, hooksDir: '/a/machine-wide-guard', snapshot: '/a/machine-wide-guard/rules.json' });
  const cmd = good.hooks.PreToolUse[0].hooks[0].command;
  const withCommand = (command) => { const o = structuredClone(good); o.hooks.PreToolUse[0].hooks[0].command = command; return o; };
  assert.equal(isOurs(withCommand(cmd)), true);
  for (const other of ['echo hi', '/usr/local/bin/node /a/other-guard.mjs --machine-wide --snapshot /a/r.json' + MACHINE_WIDE_FAILS_CLOSED,
    cmd.replace('production-write-guard.mjs', 'production-write-guard.mjs.x'), cmd.replace(' --machine-wide', ''), cmd.replace('--snapshot /a/machine-wide-guard/rules.json', '--snapshot'),
    `${cmd}; curl x`, cmd.replace(MACHINE_WIDE_FAILS_CLOSED, ''), cmd.replace(MACHINE_WIDE_FAILS_CLOSED, ' || true'), `${cmd}\nrm -rf /`, ` ${cmd}`, 7]) {
    assert.equal(isOurs(withCommand(other)), false, String(other));
  }
  // Not ours, so never replaced.
  const w = world(); mkdirSync(dirname(w.file)); const text = JSON.stringify(withCommand('echo hi')); writeFileSync(w.file, text);
  assert.deepEqual(w.plan().ops, []); assert.equal(readFileSync(w.file, 'utf8'), text);
});

test('#487 r2 m5: the reinstall steps say what happens to the machine-wide guard, and where the README says it', () => {
  const steps = reinstallSteps({ base: BASE, owner: 'sam', products: ['alpha'] });
  assert.match(steps, /the machine-wide guard keeps running from its own folder throughout, and after add-to-install run managed-settings again if its code changed \(README, part 2: a reinstall and the machine-wide guard\)$/);
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'README.md'), 'utf8');
  const part6 = readme.slice(readme.indexOf('## Part 6'));
  assert.match(part6, /The machine-wide guard, if placed, keeps running from its own folder\s+through the reinstall; after `add-to-install`, run `managed-settings` again/);
  assert.ok(readme.includes('**A reinstall and the machine-wide guard (L1044 M2).**'), 'the note Part 6 points at');
});

test('#487 r2 c2: the live renames go modules first, then the guard, the rules copy last, and managed-settings.json after them all', () => {
  const w = world();
  const renames = w.plan().ops.map((o) => o.text).filter((t) => /^rename /.test(t)).map((t) => t.split(' → ')[1].split('/').pop());
  assert.deepEqual(renames, ['lib.mjs', 'snapshot.mjs', GUARD, 'rules.json', 'managed-settings.json']);
});

// L1031: setup.mjs managed-settings, on the stand-in Mac. The guard every session will run is tried in-process here with this
// test's uid standing in for root (the real hook always means root, 0); one test runs the real hook and node too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMac } from './fake-mac.test-helper.mjs';
import { apply } from './users-folders.mjs';
import { installPaths } from './install.mjs';
import { managedRulesPath } from './layout.mjs';
import { GUARD, NODE_BIN, WAY_OUT, checkManagedSettings, isOurs, planManagedSettings, probeCalls, runGuard } from './managed-settings.mjs';
import { parseArgs } from './setup.mjs';
import { decide } from '../modules/M4-workshop/hooks/production-write-guard.mjs';
import { makeSnapshot, readSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { CLAUDE_FILE, checkMachineWide } from '../modules/M4-workshop/launcher/env-check.mjs';
import { machineWideSettings } from '../modules/M4-workshop/launcher/render-settings.mjs';

const HOOKS_SRC = join(dirname(fileURLToPath(import.meta.url)), '../modules/M4-workshop/hooks');
const BASE = '/Library/orchestrate';
const RULES = Object.freeze({ production: { env_files: ['/srv/app/prod-settings.conf'], programs: ['vercel'], hosts: ['prod.example.com'] }, secrets: { paths: ['/srv/app/keys'] } });

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
  // The guard, as a session would run it, with this test's uid as root.
  const calls = [];
  const guard = ({ hook, copy, input }) => { calls.push({ hook, copy, input }); const r = decide(input, { machineWide: true, snapshot: copy, ownerUid: mac.rootUid }); return { code: r.block ? 2 : 0, stderr: r.reason ?? '' }; };
  const plan = (over = {}) => planManagedSettings(mac, cfg, { nodeBin: node, guard, now: () => new Date('2026-11-12T00:00:00Z'), ...over });
  return { mac, cfg, P, hooksDir, node, plan, calls, file: mac.at(CLAUDE_FILE), copy: mac.at(managedRulesPath(cfg)) };
}
const run = (p) => { assert.deepEqual(p.problems, []); apply(p.ops); };

test('L1031: managed-settings writes the rules copy, reads it back, tries the guard, THEN places managed-settings.json; again it does nothing', () => {
  const w = world();
  const p = w.plan();
  const texts = p.ops.map((o) => o.text);
  const at = (re) => texts.findIndex((t) => re.test(t));
  const copyIn = at(/^rename .*machine-wide-rules\.json\.writing → /); const readBack = at(/^read back /); const tried = at(/^run the guard /);
  const fileIn = at(/^rename .*managed-settings\.json\.writing → /);
  assert.ok(copyIn >= 0 && copyIn < readBack && readBack < tried && tried < fileIn, `guard a's order: ${texts.join(' | ')}`);
  assert.equal(texts.slice(0, fileIn).some((t) => t.includes('managed-settings.json') && !t.startsWith('read back') && !t.startsWith('run the guard')), true, 'only its own side file is touched before the trial ends');
  run(p);
  // The copy: the runner config's rules, root's 0644, read back as the guard will.
  const r = readSnapshot(w.copy, { maxAgeMs: Infinity, ownerUid: w.mac.rootUid });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.rules, RULES);
  assert.equal(statSync(w.copy).mode & 0o777, 0o644); assert.deepEqual(w.mac.owners.get(managedRulesPath(w.cfg)), { uid: w.mac.rootUid, gid: 0 });
  // The file: exactly the built settings, root's 0644, and launch check 10 takes it.
  const text = readFileSync(w.file, 'utf8');
  assert.equal(text, `${JSON.stringify(machineWideSettings({ node: w.node, hooksDir: w.hooksDir, snapshot: w.copy }), null, 1)}\n`);
  assert.equal(statSync(w.file).mode & 0o777, 0o644); assert.deepEqual(w.mac.owners.get(CLAUDE_FILE), { uid: w.mac.rootUid, gid: 0 });
  assert.deepEqual(w.mac.owners.get(dirname(CLAUDE_FILE)), { uid: w.mac.rootUid, gid: 0 }); assert.equal(statSync(dirname(w.file)).mode & 0o777, 0o755);
  const absent = () => { const e = new Error('absent'); e.code = 'ENOENT'; throw e; };
  assert.deepEqual(checkMachineWide({ readFile: (p) => (p === CLAUDE_FILE ? text : absent()), path: CLAUDE_FILE, listDir: absent, plist: () => null, user: () => 'sam', home: () => '/Users/sam' }), { ok: true });
  assert.ok(checkManagedSettings(w.mac, w.cfg).every((x) => x.ok), JSON.stringify(checkManagedSettings(w.mac, w.cfg)));
  assert.deepEqual(readdirSync(dirname(w.file)).filter((n) => n.includes('.writing')), [], 'no side file left');
  // The guard was tried on both calls, on the copy, before the file was placed.
  assert.deepEqual(w.calls.map((c) => c.input), [probeCalls(RULES).pass, probeCalls(RULES).block]);
  assert.ok(w.calls.every((c) => c.copy === w.copy && c.hook === join(w.hooksDir, GUARD)));
  // Again: nothing to do.
  assert.deepEqual(w.plan(), { ops: [], problems: [], installed: true });
});

test('L1031: rules changed in the runner config are carried on the next run, over the guard this command wrote', () => {
  const w = world(); run(w.plan());
  const rules = { ...RULES, production: { ...RULES.production, hosts: ['other.example.com'] } };
  writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules }));
  run(w.plan());
  assert.deepEqual(readSnapshot(w.copy, { maxAgeMs: Infinity, ownerUid: w.mac.rootUid }).rules, rules);
  assert.deepEqual(w.calls.at(-1).input.tool_input, { url: 'https://other.example.com/' });
});

test('L1031 guard a: a copy that does not read back stops the run before managed-settings.json is placed, and an earlier one stays', () => {
  for (const placedBefore of [false, true]) {
    const w = world();
    if (placedBefore) { run(w.plan()); writeFileSync(w.cfg.runnerConfig, JSON.stringify({ hooksDir: w.hooksDir, machineWide: CLAUDE_FILE, rules: { ...RULES, secrets: { paths: [] } } })); }
    const before = existsSync(w.file) ? readFileSync(w.file, 'utf8') : null;
    // The copy is written broken (a fingerprint that does not match), as a bad write or a full disk might leave it.
    const write = w.mac.write;
    w.mac.write = (p, text, mode) => write(p, p.endsWith('machine-wide-rules.json.writing') ? text.replace(/"hash":"[0-9a-f]+"/, `"hash":"${'0'.repeat(64)}"`) : text, mode);
    const p = w.plan();
    assert.throws(() => apply(p.ops), /did not read back \(rules snapshot hash does not match\), so .*managed-settings\.json was not placed/);
    assert.equal(existsSync(w.file) ? readFileSync(w.file, 'utf8') : null, before, 'managed-settings.json is as it was');
    assert.equal(w.calls.length, placedBefore ? 2 : 0, 'the guard is not even tried on a copy that did not read back');
  }
  // A copy that reads back whole (fingerprint and owner fine) but holds other rules than the runner config's is refused too:
  // the guard would run on rules nobody asked for.
  {
    const w = world(); const write = w.mac.write;
    w.mac.write = (p, text, mode) => write(p, p.endsWith('machine-wide-rules.json.writing') ? `${makeSnapshot({ ...RULES, production: { ...RULES.production, hosts: [] } }, new Date('2026-11-12T00:00:00Z'))}\n` : text, mode);
    assert.throws(() => apply(w.plan().ops), /the rules copy .* read back with other rules, so .*managed-settings\.json was not placed/);
    assert.equal(existsSync(w.file), false);
    assert.equal(w.calls.length, 0, 'the guard is not tried on a copy with other rules');
  }
  // A copy left writable by others is refused the same way.
  const w = world(); const secure = w.mac.secureFile;
  w.mac.secureFile = (p, want) => secure(p, p.endsWith('machine-wide-rules.json.writing') ? { ...want, mode: 0o666 } : want);
  assert.throws(() => apply(w.plan().ops), /did not read back \(the machine-wide rules copy is not root's alone/);
  assert.equal(existsSync(w.file), false);
});

test('L1031 guard a: a guard that blocks a harmless call, or lets a production one through, stops the run before the file is placed', () => {
  for (const [guard, re] of [
    [() => ({ code: 2, stderr: 'rules snapshot is missing or unreadable' }), /the guard blocked a harmless call \(rules snapshot is missing or unreadable\)/],
    [() => ({ code: 0, stderr: '' }), /the guard let a production call through/],
  ]) {
    const w = world();
    assert.throws(() => apply(w.plan({ guard }).ops), re);
    assert.equal(existsSync(w.file), false, 'not placed');
    assert.equal(existsSync(dirname(w.file)), false, 'Claude\'s folder is made only after the trial');
  }
});

test('L1031 guard a: the real hook and node, on a copy root does not own, block the harmless call, so the file is never placed', () => {
  if (process.getuid() === 0) return;
  const w = world();
  // The real guard script in the copy, run with this node: it judges ownership against root (0) for real.
  w.mac.nodeBinProblem = () => null;   // this test's node is not root's; the trial is what is under test
  const q = planManagedSettings(w.mac, w.cfg, { nodeBin: process.execPath, guard: runGuard });
  assert.deepEqual(q.problems, []);
  let err; try { apply(q.ops); } catch (e) { err = e; }
  assert.match(err?.message ?? '', /the guard blocked a harmless call \(.*not root's alone.*sudo rm/);
  assert.equal(existsSync(w.file), false);
});

test('L1031: refusals, each before anything is changed', () => {
  const cases = [
    [{ rc: { hooksDir: undefined } }, /hooksDir must be .*run review-config without --for-install, put it in place, and run add-to-install first/],
    [{ rc: { machineWide: '/etc/claude.json' } }, /machineWide must be \/Library\/Application Support\/ClaudeCode\/managed-settings\.json/],
    [{ rc: { rules: { production: { env_files: [], programs: [] }, secrets: { paths: [] } } } }, /must set rules\.production\.hosts/],
    [{ rc: { rules: undefined } }, /rules must be an object/],
    [{ hooks: false }, /the guard .*production-write-guard\.mjs is not there: run add-to-install first/],
  ];
  for (const [opts, re] of cases) {
    const w = world(opts);
    const p = w.plan();
    assert.deepEqual(p.ops, []); assert.match(p.problems.join('\n'), re);
  }
  // The guard script writable by others; the node root may not run; a runner config that is not JSON.
  let w = world(); chmodSync(join(w.hooksDir, GUARD), 0o666);
  assert.match(w.plan().problems.join('\n'), /is not a plain file that is root's alone/);
  w = world(); w.mac.nodeBinProblem = () => 'it is not root\'s';
  assert.match(w.plan().problems.join('\n'), /can't be the node every session runs the guard with: it is not root's\. Install node from nodejs\.org \(it goes to \/usr\/local\/bin\/node\)/);
  w = world(); writeFileSync(w.cfg.runnerConfig, '{not json'); assert.match(w.plan().problems.join('\n'), /is not valid JSON/);
  w = world(); writeFileSync(w.cfg.runnerConfig, '[]'); assert.match(w.plan().problems.join('\n'), /must be one JSON object/);
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
  assert.equal(isOurs(machineWideSettings({ node: NODE_BIN, hooksDir: '/a/hooks', snapshot: '/a/c.json' })), true);
});

test('L1031: rules that name nothing still place the guard, said as a WARNING; the guard is then tried on the harmless call only', () => {
  const w = world({ rc: { rules: { production: { env_files: [], programs: [], hosts: [] }, secrets: { paths: [] } } } });
  const p = w.plan();
  assert.deepEqual(p.warnings, ['the rules name no production host, program or settings file, so the guard blocks nothing']);
  run(p); assert.equal(w.calls.length, 1);
});

test('L1031: setup.mjs takes managed-settings with --dry-run only, and the way out names the one file, run from Terminal with sudo', () => {
  assert.equal(parseArgs(['managed-settings']).cmd, 'managed-settings');
  assert.equal(parseArgs(['managed-settings', '--dry-run']).dry, true);
  for (const bad of [['managed-settings', '--pin', '2.1.316'], ['managed-settings', '--input', '/x'], ['managed-settings', '--main', 'a'.repeat(40)]]) assert.throws(() => parseArgs(bad));
  assert.equal(WAY_OUT, `To switch the machine-wide guard off: open the Terminal app (not Claude) and run  sudo rm "${CLAUDE_FILE}"  then start Claude again.`);
  assert.throws(() => machineWideSettings({ node: '/usr/local/bin/node', hooksDir: '/Library/Application Support/x', snapshot: '/a' }), /plain absolute path/);
  assert.throws(() => machineWideSettings({ node: '/usr/local/bin/node', hooksDir: '/a/../b', snapshot: '/a' }), /plain absolute path/);
});

test('L1031: checkManagedSettings says what is wrong once something moves', () => {
  const w = world(); run(w.plan());
  writeFileSync(w.copy, makeSnapshot({ ...RULES, extra: 1 }).replace(/"hash":"[0-9a-f]+"/, '"hash":"x"'));
  const rows = checkManagedSettings(w.mac, w.cfg);
  assert.match(rows.find((r) => !r.ok).why, /hash does not match/);
});

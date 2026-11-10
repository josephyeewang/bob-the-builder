// Part C, runner step 6: the worker launch checks (runner-checks.mjs). Check 2 runs on a real mirror and copy; the
// baseline runs its command with a stand-in claude that runs the one shell command it is asked to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { gitOk, initMirror } from '../modules/M4-workshop/git/safe-git.mjs';
import { prepareWorkerCopy } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { baselineCommand, baselineFile, setupFilesProblem, workerChecks } from './runner-checks.mjs';
import { checkRunnerConfig, startDeps, workerCheckInputs } from './runner-main.mjs';

const REPO = 'example-owner/example-repo';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

async function copyOfMain() {
  const root = tempDir('orch-rchecks-');
  const src = join(root, 'src'); mkdirSync(src);
  const o = { gitDir: join(src, '.git'), workTree: src, cwd: src };
  await gitOk(['init', '-q', '-b', 'main', src], o);
  mkdirSync(join(src, '.claude')); writeFileSync(join(src, '.claude', 'settings.json'), '{"main":true}\n');
  writeFileSync(join(src, '.mcp.json'), '{}\n');
  mkdirSync(join(src, 'pkg')); writeFileSync(join(src, 'pkg', 'CLAUDE.local.md'), 'notes\n'); writeFileSync(join(src, 'a.txt'), 'a\n');
  await gitOk(['add', '-A'], o); await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'm'], o);
  const c1 = (await gitOk(['rev-parse', 'HEAD'], o)).trim();
  const mirror = join(root, 'mirror.git'); await initMirror(mirror);
  await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main'], { gitDir: mirror });
  const copy = join(root, 'copy');
  const r = await prepareWorkerCopy({ product: { repo: REPO, mirror }, card: { id: 'C-1', repo: REPO, commit: c1 }, dest: copy });
  assert.equal(r.ok, true, r.reason);
  return { root, mirror, copy, head: r.head };
}

test('step 6, check 2: the copy\'s setup files are main\'s exactly; one changed, added, missing or a link is refused', async () => {
  const f = await copyOfMain();
  try {
    assert.equal(await setupFilesProblem(f), null);
    const s = join(f.copy, '.claude', 'settings.json');
    writeFileSync(s, '{"main":false}\n');
    assert.match(await setupFilesProblem(f), /\.claude\/settings\.json is not main's/);
    writeFileSync(s, '{"main":true}\n');
    mkdirSync(join(f.copy, 'pkg', '.Claude')); writeFileSync(join(f.copy, 'pkg', '.Claude', 'agents.md'), 'x');
    assert.match(await setupFilesProblem(f), /holds pkg\/\.Claude\/agents\.md, which main does not/);
    rmSync(join(f.copy, 'pkg', '.Claude'), { recursive: true });
    unlinkSync(join(f.copy, '.mcp.json'));
    assert.match(await setupFilesProblem(f), /\.mcp\.json is not put back/);
    symlinkSync(join(f.root, 'src', '.mcp.json'), join(f.copy, '.mcp.json'));
    assert.match(await setupFilesProblem(f), /\.mcp\.json is a link/);
    unlinkSync(join(f.copy, '.mcp.json')); writeFileSync(join(f.copy, '.mcp.json'), '{}\n');
    assert.equal(await setupFilesProblem(f), null, 'put right again');
    assert.match(await setupFilesProblem({ copy: f.copy, mirror: join(f.root, 'nope.git') }), /can't be read from the mirror/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// A stand-in claude: it runs the one shell command its prompt names, in its working folder, and ends.
function standIn(calls) {
  return (bin, args, opts) => {
    const cmd = args.at(-1).replace(/^Run exactly this shell command once and report its exit code: /, '');
    calls.push({ bin, args, cwd: opts.cwd, cmd });
    const c = new EventEmitter(); c.kill = () => {};
    setImmediate(() => { spawnSync('/bin/sh', ['-c', cmd], { cwd: opts.cwd }); c.emit('close', 0); });
    return c;
  };
}

function inputs(over = {}) {
  const d = tempDir('orch-rchecks-');
  const copy = join(d, 'copy'); mkdirSync(copy); chmodSync(copy, 0o700);
  const home = join(d, 'home'); mkdirSync(home);
  return { d, x: { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', sessionId: SID, card: 'C-1', cardDoc: { product: 'p1' }, product: 'p1',
    copy, outbox: join(d, 'outbox'), env: { PATH: '/usr/bin:/bin' }, head: 'b'.repeat(40), claudeBin: '/x/claude-code/2.1.300/claude',
    settings: { file: join(d, 'settings.json'), settings: {} }, ownUid: () => process.getuid(), mirror: '/m', pin: '2.1.300', hooksDir: '/h', rules: {},
    snapshot: join(d, 'rules.json'), writeSnapshot: () => {}, machineWide: '/mw', busy: () => [], alert: () => {}, spawn: () => { throw new Error('no'); },
    home, testCommand: 'npm test', budget: null, bobFolder: null, bobManifest: null, ...over } };
}

test('step 6: a port for each check whose inputs are there, none for one whose inputs are not (launch() refuses it)', async () => {
  const { d, x } = inputs();
  try {
    assert.deepEqual(Object.keys(workerChecks(x)).map(Number), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11], 'no install (4), budget (12) or Bob list (13) yet');
    const none = workerChecks({ ...x, mirror: undefined, busy: undefined, pin: undefined, rules: undefined, machineWide: undefined, testCommand: undefined });
    assert.deepEqual(Object.keys(none).map(Number), [1, 5, 9]);
    assert.deepEqual(Object.keys(workerChecks({ ...x, role: 'script', profile: DESIGN_PROFILES.script, kind: 'script', testCommand: undefined })).map(Number).includes(11), true, 'a script session runs the smoke only');
    // Check 12 is M11's own gate, with this session's kind.
    let seen; let given;
    const budget = { rules: {} };
    const gateOf = (b) => { given = b; return (ctx) => { seen = ctx; return { ok: true }; }; };
    const p = workerChecks({ ...x, budget, kind: 'undo' }, { gateOf });
    assert.deepEqual(await p[12](), { ok: true });
    assert.equal(given, budget); assert.deepEqual(seen, { card: x.cardDoc, kind: 'undo', product: 'p1' });
    assert.match((await workerChecks({ ...x, budget, cardDoc: null }, { gateOf })[12]()).reason, /not in the Record/);
    assert.equal(typeof workerChecks({ ...x, bobFolder: '/b', bobManifest: { a: 'x' } })[13], 'function');
    assert.equal(workerChecks({ ...x, bobFolder: '/b', bobManifest: null })[13], undefined, 'no pinned list, no port');
    // Check 1 on the copy: this user's alone and holding the head.
    chmodSync(x.copy, 0o755);
    assert.match((await workerChecks(x)[1]()).reason, /alone/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('step 6, check 11: a worker\'s baseline runs first and must exit 0; then the smoke runs', async () => {
  const runs = [['exit 3', /baseline tests failed inside the lock-down \(exit 3\)/, 1], ['true', /wrote outside the copy/, 2]];
  for (const [testCommand, re, n] of runs) {
    const calls = [];
    const { d, x } = inputs({ testCommand, spawn: standIn(calls) });
    try {
      const r = await workerChecks(x)[11]();
      assert.equal(r.ok, false); assert.match(r.reason, re, testCommand);
      assert.equal(calls.length, n, testCommand);
      assert.equal(calls[0].cwd, x.copy); assert.ok(calls[0].args.includes(x.settings.file), 'the role\'s own settings');
      assert.equal(calls[0].cmd, baselineCommand(testCommand, baselineFile(x)));
      assert.equal(existsSync(baselineFile(x)), false, 'the exit file is removed');
      if (n === 2) assert.ok(calls[1].cmd.includes(`'${x.home}/`), 'the smoke tries to write in the owner\'s home, outside the copy');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A command that never writes its exit code can't say: refused.
  const { d, x } = inputs({ spawn: (b, a, o) => { const c = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; } });
  try { assert.match((await workerChecks(x)[11]()).reason, /exit not written/); } finally { rmSync(d, { recursive: true, force: true }); }
  assert.throws(() => baselineCommand('a\nb', '/f'), /one-line test command/);
  assert.throws(() => baselineCommand('', '/f'), /one-line/);
  assert.throws(() => baselineCommand('t', "/f'x"), /quote/);
});

test('step 6: the runner\'s config feeds the checks (pin, machine-wide file, the product\'s rules, paths and test command)', () => {
  const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, pin: '2.1.300', machineWide: '/mw.json',
    products: { p1: { repo: 'o/p', mirror: '/m', rules: { k: 1 }, render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, hooksDir: '/h', snapshot: '/s.json', bobFolder: '/b' }, product: { commands: { test: 'npm test' } } } } } });
  const i = workerCheckInputs(c, { product: 'p1', sessionId: SID });
  assert.deepEqual([i.mirror, i.pin, i.hooksDir, i.rules, i.snapshot, i.machineWide, i.home, i.testCommand, i.bobFolder, i.budget],
    ['/m', '2.1.300', '/h', { k: 1 }, '/s.json', '/mw.json', '/home', 'npm test', '/b', null]);
  for (const k of ['busy', 'writeSnapshot', 'spawn', 'alert']) assert.equal(typeof i[k], 'function', k);
  // The start port gets these checks and check 0's version.
  const sd = startDeps(c);
  assert.equal(sd.names.version, '2.1.300');
  assert.deepEqual(Object.keys(sd.checksFor({ role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: 'p1', sessionId: SID, copy: '/c/C-1', settings: { file: '/f', settings: {} } })).map(Number), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  const base = { installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, products: { p1: { repo: 'o/p', mirror: '/m', render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] } } } } } };
  assert.throws(() => checkRunnerConfig({ ...base, pin: 'latest' }), /pin must be/);
  for (const machineWide of ['mw', '/mw/', '/a/../mw', '//mw', '/m w']) assert.throws(() => checkRunnerConfig({ ...base, machineWide }), /machineWide must be a full path in its simplest form/, machineWide);   // the #364 r2 n4 class
  assert.throws(() => checkRunnerConfig({ ...base, products: { p1: { ...base.products.p1, rules: [] } } }), /rules must be/);
});

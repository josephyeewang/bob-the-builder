// Part C, runner step 6: the worker launch checks (runner-checks.mjs). Check 2 runs on a real mirror and copy; the
// baseline runs its command with a stand-in claude that runs the one shell command it is asked to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { gitOk, initMirror } from '../modules/M4-workshop/git/safe-git.mjs';
import { prepareWorkerCopy } from '../modules/M4-workshop/launcher/worker-copy.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { CHECKS } from '../modules/M4-workshop/launcher/launch.mjs';
import { BASELINE_MS, WALK_DEPTH, baselineCommand, baselineFile, setupFilesProblem, workerChecks } from './runner-checks.mjs';
import { LOCKED_MS, groupFile, groupRecordCommand } from './runner-locked.mjs';
import { RECHECK, checkRunnerConfig, lockedOf, lockedWiring, realRunnerPorts, startDeps, workerCheckInputs } from './runner-main.mjs';

const FIXED = '/Library/Application Support/ClaudeCode/managed-settings.json';
// #419 r3 m1: near misses of the fixed file, each refused by this layer's own check.
const NEAR_MISSES = [FIXED + '/', FIXED.toLowerCase(), FIXED.replace(' ', '\u00a0'), FIXED + '.bak'];
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

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

// claude as its Bash tool runs a command (#463 r2 M3, claude 2.1.322): detached, in a process group of its own, so claude's
// group is not the command's; claude ends when the command does.
const bashTool = (cmd, opts) => childSpawn(process.execPath, ['-e',
  "const c = require('node:child_process').spawn('/bin/sh', ['-c', process.argv[1]], { detached: true, stdio: 'ignore' }); c.on('exit', (x) => process.exit(x ?? 1));", cmd], opts);
// A stand-in claude: it runs the one shell command its prompt names, in its working folder, and ends. The baseline's runs
// as the Bash tool runs it (bashTool), its group's record and the runner's go-ahead (#463 r2 M3) for real; `baseline:
// false`, it runs nothing (a claude that never ran the command).
function standIn(calls, { sandbox = false, baseline = true } = {}) {
  return (bin, args, opts) => {
    const cmd = args.at(-1).replace(/^Run exactly this shell command once and report its exit code: /, '');
    calls.push({ bin, args, cwd: opts.cwd, env: opts.env, cmd });
    const smoke = cmd.includes('.orch-smoke-');
    if (!smoke && baseline) return bashTool(cmd, opts);
    const c = new EventEmitter(); c.kill = () => {};
    // Sandboxed: the smoke's first step (marking it ran, inside the copy) runs; its write outside and network reach do not.
    const run = smoke && sandbox ? cmd.split(';')[0] : smoke ? cmd : null;
    setImmediate(() => { if (run) spawnSync('/bin/sh', ['-c', run], { cwd: opts.cwd, stdio: 'ignore' }); c.emit('close', 0); });
    return c;
  };
}
// A made-up claude (#463 r2 M3) that keeps the handshake: its command's shell records a made-up pid, in a group of its own
// (jobPorts below read it as there and started after claude), and `then` runs once the runner's go-ahead is written.
const T0 = '2026-01-01T00:00:00.000Z';
const fakeJob = (more = {}) => ({ info: (pid) => ({ pgid: pid, start: T0 }), pidStartOf: () => T0, jobGone: () => true, pollMs: 5, ...more });
const handshake = async (args, then, pid = 7777) => {
  const g = /^\( set -C; \/bin\/echo \$\$ > '([^']+)' \)/.exec(args.at(-1).replace(/^Run exactly this shell command once and report its exit code: /, ''))[1];
  writeFileSync(g, `${pid}\n`);
  for (let n = 0; n < 400 && !existsSync(`${g}.ok`); n += 1) await new Promise((r) => setTimeout(r, 5));
  if (existsSync(`${g}.ok`)) then();
};

function inputs(over = {}) {
  const d = tempDir('orch-rchecks-');
  const copy = join(d, 'copy'); mkdirSync(copy); chmodSync(copy, 0o700);
  const home = join(d, 'home'); mkdirSync(home);
  // The baseline's throwaway copy (#369 r1 M1), as the start port makes it: its own folder and settings file.
  const spare = join(d, 'spare');
  const throwaway = async () => { mkdirSync(join(spare, 'copy'), { recursive: true }); return { ok: true, copy: join(spare, 'copy'), settingsFile: join(d, 'spare.json'), done: async () => rmSync(spare, { recursive: true, force: true }) }; };
  return { d, spare, x: { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', sessionId: SID, card: 'C-1', cardDoc: { product: 'p1' }, product: 'p1',
    copy, outbox: join(d, 'outbox'), env: { PATH: '/usr/bin:/bin' }, head: 'b'.repeat(40), claudeBin: '/x/claude-code/2.1.300/claude',
    settings: { file: join(d, 'settings.json'), settings: {} }, ownUid: () => process.getuid(), mirror: '/m', pin: '2.1.300', hooksDir: '/h', rules: {},
    snapshot: join(d, 'rules.json'), writeSnapshot: () => {}, machineWide: '/mw', busy: () => [], alert: () => {}, spawn: () => { throw new Error('no'); },
    home, testCommand: 'npm test', budget: null, bobFolder: null, bobManifest: null, throwaway, ...over } };
}

test('step 6: a port for each check whose inputs are there, none for one whose inputs are not (launch() refuses it)', async () => {
  const { d, x } = inputs();
  try {
    assert.deepEqual(Object.keys(workerChecks(x)).map(Number), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11], 'no install (4), budget (12) or Bob list (13) yet');
    const none = workerChecks({ ...x, mirror: undefined, busy: undefined, pin: undefined, rules: undefined, machineWide: undefined, testCommand: undefined });
    assert.deepEqual(Object.keys(none).map(Number), [1, 5, 9]);
    // Check 12 is M11's own gate, with this session's kind.
    let seen; let given;
    const budget = { rules: {}, filesOf: () => [] };
    const gateOf = (b) => { given = b; return (ctx) => { seen = ctx; return { ok: true }; }; };
    const p = workerChecks({ ...x, budget, kind: 'undo', undoCommit: 'f'.repeat(40) }, { gateOf });
    assert.deepEqual(await p[12](), { ok: true });
    // L976: an undo's gate is handed its reversed commit, to hold it to the source's.
    assert.equal(given, budget); assert.deepEqual(seen, { card: { id: x.card, ...x.cardDoc }, kind: 'undo', product: 'p1', undoCommit: 'f'.repeat(40) }); assert.equal(seen.card.id, x.card, 'L863: the card carries its id');
    assert.match((await workerChecks({ ...x, budget, cardDoc: null }, { gateOf })[12]()).reason, /not in the Record/);
    // #369 r2 m4: the budget carries the pass's filesOf; an undo with none is refused here, saying so. Other kinds don't need it.
    seen = undefined;
    assert.match((await workerChecks({ ...x, budget: { rules: {} }, kind: 'undo' }, { gateOf })[12]()).reason, /carries no filesOf/); assert.equal(seen, undefined);
    assert.deepEqual(await workerChecks({ ...x, budget: { rules: {} }, kind: 'editing' }, { gateOf })[12](), { ok: true });
    assert.equal('undoCommit' in seen, false, 'an editing gate is handed no reversed commit');
    assert.equal(typeof workerChecks({ ...x, bobFolder: '/b', bobManifest: { a: 'x' } })[13], 'function');
    assert.equal(workerChecks({ ...x, bobFolder: '/b', bobManifest: null })[13], undefined, 'no pinned list, no port');
    // Check 1 on the copy: this user's alone and holding the head.
    chmodSync(x.copy, 0o755);
    assert.match((await workerChecks(x)[1]()).reason, /alone/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// L969: check 4 runs the product's install through runLocked, between the install-phase settings and the session's again.
test('L969, check 4: a port only with runLocked, an install command and both settings ports; the install runs between the two settings writes', async () => {
  const { d, x } = inputs();
  try {
    const log = [];
    const session = { permissions: { allow: [] }, sandbox: { network: { allowedDomains: ['api.example.com'] } } };
    const during = { permissions: { allow: [] }, sandbox: { network: { allowedDomains: ['api.example.com', 'registry.npmjs.org'] } } };
    const four = { runLocked: async (j) => { log.push(['run', j]); return { ok: true }; }, installCommand: 'npm ci', registryHosts: ['registry.npmjs.org'],
      renderPhase: (ph) => { log.push(['render', ph]); return { ok: true, settings: ph === 'install' ? during : session }; }, writeSettings: (st) => { log.push(['write', st]); return { ok: true }; } };
    for (const k of ['runLocked', 'installCommand', 'renderPhase', 'writeSettings']) assert.equal(workerChecks({ ...x, ...four, [k]: undefined })[4], undefined, `no ${k}, no check 4`);
    assert.equal(workerChecks({ ...x, ...four, installCommand: '' })[4], undefined, 'an empty install command, no check 4');
    const p = workerChecks({ ...x, ...four });
    assert.deepEqual(await p[4](), { ok: true });
    assert.deepEqual(log.map((l) => (l[0] === 'run' ? 'run' : l[0] === 'write' ? (l[1] === during ? 'write install' : 'write session') : `render ${l[1]}`)),
      ['render install', 'write install', 'run', 'render session', 'write session'], 'the install runs under the install settings, and the session settings are put back');
    const job = log.find((l) => l[0] === 'run')[1];
    assert.deepEqual(job, { job: 'install', command: 'npm ci', sessionId: SID, role: 'worker', settingsFile: x.settings.file, cwd: x.copy, env: x.env }, 'in the copy, under the session\'s settings file, with the start\'s own environment (#463 r1 m6)');
    // A failed install, or one that throws, is refused once the session settings are back.
    log.length = 0;
    const failed = await workerChecks({ ...x, ...four, runLocked: async () => { throw new Error('the install job did not finish inside the lock-down (it did not finish in time)'); } })[4]();
    assert.match(failed.reason, /the install failed: the install job did not finish inside the lock-down/);
    assert.equal(log.at(-1)[1], session, 'the session settings were written back first');
    // The registry left allowed in the session settings is refused.
    const leaky = await workerChecks({ ...x, ...four, renderPhase: () => ({ ok: true, settings: during }) })[4]();
    assert.match(leaky.reason, /the registry is still allowed after the install: registry\.npmjs\.org/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// #456 r1 m3: save-work and launch check 4 come from ONE runLocked, so a launch is never possible while its work can't be saved.
test('#456 r1 m3: save-work and check 4 are both on or both off: one runLocked feeds them', async () => {
  const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1,
    products: { p1: { repo: 'o/p', mirror: '/m', render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, hooksDir: '/h', snapshot: '/snap/s.json' }, product: { commands: { install: 'npm ci', test: 'npm test' } }, registryHosts: [] } } } });
  const wx = { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: 'p1', sessionId: SID, copy: '/c/C-1', settings: { file: '/f', settings: {} }, renderPhase: () => ({ ok: true, settings: {} }), writeSettings: () => ({ ok: true }) };
  const session = { id: SID, product: 'p1', kind: 'editing', card: 'C-1', copy: '/c/C-1', outbox: '/ob/p1/worker/x', save_settings_sha: 'a'.repeat(64) };
  // Off: no runLocked. Save-work refuses (it runs only in the lock-down) and no worker has check 4.
  const off = lockedWiring(c, { runLocked: null });
  assert.equal(off.runLocked, null);
  assert.equal(off.startDeps.checksFor(wx)[4], undefined, 'no check 4');
  assert.deepEqual(await off.saveWork(session), { ok: false, reason: 'save-work runs only inside the worker\'s lock-down' });
  // On: the same function reaches both.
  const seen = [];
  const runLocked = async (j) => { seen.push(j.job); return j.job === 'install' ? { ok: true } : { ok: false, reason: 'stand-in' }; };
  const on = lockedWiring(c, { runLocked });
  assert.equal(on.runLocked, runLocked);
  assert.deepEqual(await on.startDeps.checksFor(wx)[4](), { ok: true });
  // The save runs in the copy's real .git (#463 r2 m3), so the copy here is a real one.
  const real = tempDir('orch-'); mkdirSync(join(real, '.git'));
  try { assert.deepEqual(await on.saveWork({ ...session, copy: real }), { ok: false, reason: 'stand-in' }); } finally { rmSync(real, { recursive: true, force: true }); }
  assert.deepEqual(seen, ['install', 'save-work'], 'one runLocked ran both');
  // By default it is built from the config's claude: one there, both on, with the config's time limit.
  assert.equal(typeof lockedWiring(c).runLocked, 'function');
  let made; lockedOf({ ...c, lockedMs: 5000 }, { make: (o) => { made = o; return () => {}; } });
  assert.deepEqual([made.claudeBin, made.ms, typeof made.envOf], ['/i/claude', 5000, 'function']);
  assert.equal(lockedOf({ ...c, claudeBin: undefined }), null, 'no claude: none, so both off');
  for (const bad of [0, 10 * 60_000 + 1]) assert.throws(() => checkRunnerConfig({ ...c, products: c.products, lockedMs: bad }), /lockedMs must be/, String(bad));
  // The job's environment (#456 runLocked self-review m5): the sign-in's, HOME and PATH from the config, held to check 9.
  const envOf = (who, base = { PATH: '/elsewhere', TERM: 'x' }) => { let o; lockedOf(c, { who: () => who, base, make: (m) => { o = m; return () => {}; } }); return o.envOf; };
  assert.throws(() => envOf({ reason: 'not signed in' })(), /not signed in/);
  const got = envOf({ account: 'a', env: { CLAUDE_CONFIG_DIR: '/cfg' } })();
  assert.deepEqual([got.HOME, got.PATH, got.CLAUDE_CONFIG_DIR], [c.home, c.path, '/cfg']);
  assert.throws(() => envOf({ account: 'a', env: { SOME_API_TOKEN: 't' } })(), /key-like variables/, 'a key-like variable fails check 9 here too');
});

test('step 6, check 11 (#369 M2): the smoke runs first; a worker\'s baseline runs only once it passes, and must exit 0', async () => {
  // A sandbox stand-in: the smoke's write outside the copy and its network reach are blocked, as the lock-down blocks them.
  const runs = [['exit 3', /baseline tests failed inside the lock-down \(exit 3\)/, 2, true], ['true', null, 2, true], ['true', /wrote outside the copy/, 1, false]];
  for (const [testCommand, re, n, sandbox] of runs) {
    const calls = [];
    const { d, x, spare } = inputs({ testCommand, spawn: standIn(calls, { sandbox }), nonce: () => 'r1' });
    try {
      const r = await workerChecks(x)[11]();
      if (re) { assert.equal(r.ok, false); assert.match(r.reason, re, testCommand); } else assert.deepEqual(r, { ok: true });
      assert.equal(calls.length, n, `${testCommand}: the baseline runs only after the smoke passed`);
      assert.ok(calls[0].cmd.includes(`'${x.home}/`), 'the smoke is first, and tries to write in the owner\'s home, outside the copy');
      assert.equal(calls[0].cwd, x.copy); assert.ok(calls[0].args.includes(x.settings.file), 'the smoke: the role\'s own settings, in the session\'s copy');
      if (n === 2) {
        // #369 r1 M1: the baseline runs in the throwaway copy with its settings, never in the session's copy.
        assert.equal(calls[1].cwd, join(spare, 'copy')); assert.ok(calls[1].args.includes(join(d, 'spare.json'))); assert.equal(calls[1].args.includes(x.settings.file), false);
        // #463 r2 M3: its shell's record first, in a process group of its own, and the Bash tool's wait the baseline's limit.
        assert.equal(calls[1].cmd, `${groupRecordCommand(groupFile({ cwd: join(spare, 'copy'), job: 'baseline', sessionId: SID, run: 'r1' }))} && { ${baselineCommand(testCommand, baselineFile({ copy: join(spare, 'copy'), sessionId: SID }))}; }`);
        assert.deepEqual(calls[1].env, { PATH: '/usr/bin:/bin', BASH_DEFAULT_TIMEOUT_MS: String(BASELINE_MS), BASH_MAX_TIMEOUT_MS: String(BASELINE_MS) });
      }
      assert.equal(existsSync(spare), false, 'the throwaway copy, its exit file with it, is removed');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // #463 r2 M3, r3 m2: the baseline's limit is the lock-down's own cap, 10 minutes, not 15.
  assert.equal(BASELINE_MS, LOCKED_MS); assert.equal(BASELINE_MS, 10 * 60_000);
  // Only guardedRun's reading ports are taken from jobPorts (self-review c1): a spawn there is not used.
  {
    const calls = [];
    const { d, x } = inputs({ testCommand: 'true', spawn: standIn(calls, { sandbox: true }), jobPorts: { spawn: () => { throw new Error('the jobPorts spawn'); } } });
    try { assert.deepEqual(await workerChecks(x)[11](), { ok: true }); assert.equal(calls.length, 2); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A limit past that wait is refused before claude starts.
  {
    const calls = [];
    const { d, x } = inputs({ spawn: standIn(calls, { sandbox: true }), baselineMs: LOCKED_MS + 1 });
    try { assert.match((await workerChecks(x)[11]()).reason, /the baseline's limit is not a time limit within the lock-down's cap \(600000 ms\)/); assert.equal(calls.length, 1, 'the smoke only'); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A claude that never ran the command (no record of its group) is no baseline.
  {
    const { d, x } = inputs({ spawn: standIn([], { sandbox: true, baseline: false }) });
    try { assert.match((await workerChecks(x)[11]()).reason, /the baseline run did not finish: the baseline's process group was not recorded, so it did not run as the runner runs it \(claude exited 0\)/); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A command that ran, kept, but never wrote its exit code can't say: refused.
  {
    const smoke = standIn([], { sandbox: true });
    const spawn = (b, a, o) => { if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4320; c.kill = () => {}; handshake(a, () => c.emit('close', 0)); return c; };
    const { d, x } = inputs({ spawn, killGroup: () => {}, groupThere: () => false, jobPorts: fakeJob() });
    try { assert.match((await workerChecks(x)[11]()).reason, /exit not written; claude exited 0/); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // #463 r2 M3: a group that can't be told about at claude's end, or a record that can't be trusted, is no baseline.
  for (const [more, re] of [[{ jobGone: () => { throw new Error('ps'); } }, /the baseline run did not finish: the baseline may still be running after claude ended \(claude exited 0\); its process group can't be told about/],
    [{ info: () => null }, /the baseline run did not finish: its job's process group can't be kept \(the job's shell 7777 can't be read\), so it is stopped/]]) {
    const smoke = standIn([], { sandbox: true });
    const spawn = (b, a, o) => { if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4319; c.kill = () => {};
      handshake(a, () => { writeFileSync(baselineFile({ copy: o.cwd, sessionId: SID }), '0\n'); c.emit('close', 0); }); return c; };
    const { d, x } = inputs({ spawn, killGroup: () => {}, groupThere: () => false, jobPorts: fakeJob(more) });
    try { assert.match((await workerChecks(x)[11]()).reason, re); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A baseline past its time limit has its whole process group killed, not claude alone (#369 m2).
  {
    const killed = []; const spawned = [];
    const smoke = standIn([], { sandbox: true });
    const spawn = (b, a, o) => { spawned.push(o.detached); if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4321; c.kill = () => { killed.push('child'); }; return c; };
    const { d, x } = inputs({ spawn, baselineMs: 50, killGroup: (g) => killed.push(g), jobPorts: fakeJob() });
    try {
      assert.match((await workerChecks(x)[11]()).reason, /did not finish in time/);
      assert.deepEqual(killed, [4321], 'the group, by its leader\'s pid'); assert.equal(spawned.at(-1), true, 'the baseline leads its own group');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // #369 r1 M1: the group is killed after a normal end too, so what the tests left running in it goes.
  {
    const killed = [];
    const smoke = standIn([], { sandbox: true });
    const spawn = (b, a, o) => { if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4322; c.kill = () => {}; handshake(a, () => c.emit('close', 0)); return c; };
    const { d, x } = inputs({ spawn, killGroup: (g) => killed.push(g), groupThere: (g) => g === 4322, jobPorts: fakeJob() });
    try { assert.match((await workerChecks(x)[11]()).reason, /exit not written/); assert.deepEqual(killed, [4322]); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // #369 r2 c3: after the end, a group signal 0 no longer finds is not killed (its number may be another's).
  {
    const killed = [];
    const smoke = standIn([], { sandbox: true });
    const spawn = (b, a, o) => { if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4323; c.kill = () => {}; handshake(a, () => c.emit('close', 0)); return c; };
    const { d, x } = inputs({ spawn, killGroup: (g) => killed.push(g), groupThere: () => false, jobPorts: fakeJob() });
    try { assert.match((await workerChecks(x)[11]()).reason, /exit not written/); assert.deepEqual(killed, []); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // #369 r1 m6: an empty exit file, one that is not a number, and a link to a file holding 0 are not exit 0.
  for (const [what, write] of [['empty', (f) => writeFileSync(f, '')], ['abc', (f) => writeFileSync(f, 'abc\n')],
    ['a link', (f, d) => { writeFileSync(join(d, 'zero'), '0\n'); symlinkSync(join(d, 'zero'), f); }]]) {
    const smoke = standIn([], { sandbox: true });
    let dd;
    const spawn = (b, a, o) => { if (a.at(-1).includes('.orch-smoke-')) return smoke(b, a, o); const c = new EventEmitter(); c.pid = 4324; c.kill = () => {}; handshake(a, () => { write(baselineFile({ copy: o.cwd, sessionId: SID }), dd); c.emit('close', 0); }); return c; };
    const { d, x } = inputs({ spawn, killGroup: () => {}, groupThere: () => false, jobPorts: fakeJob() }); dd = d;
    try { const r = await workerChecks(x)[11](); assert.equal(r.ok, false, what); assert.match(r.reason, /baseline tests failed inside the lock-down \(exit (|abc|not written; claude exited 0)\)/, what); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // No throwaway port: a worker gets no check 11, so launch() refuses there.
  { const { d, x } = inputs({ throwaway: undefined }); try { assert.equal(workerChecks(x)[11], undefined); } finally { rmSync(d, { recursive: true, force: true }); } }
  // A throwaway that can't be made refuses, and nothing runs.
  {
    const calls = [];
    const { d, x } = inputs({ spawn: standIn(calls, { sandbox: true }), throwaway: async () => ({ ok: false, reason: 'the baseline\'s throwaway copy can\'t be made (EEXIST)' }) });
    try { assert.match((await workerChecks(x)[11]()).reason, /throwaway copy can't be made \(EEXIST\)/); assert.equal(calls.length, 1, 'the smoke only'); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  // A script session has no shell, so launch() skips check 11 for it (#369 m6): its port is never called.
  assert.equal(CHECKS.find((c) => c.n === 11).applies('script', DESIGN_PROFILES.script), false);
  assert.equal(CHECKS.find((c) => c.n === 11).applies('worker', DESIGN_PROFILES.worker), true);
  assert.throws(() => baselineCommand('a\nb', '/f'), /one-line test command/);
  assert.throws(() => baselineCommand('', '/f'), /one-line/);
  assert.throws(() => baselineCommand('t', "/f'x"), /quote/);
});

test('#463 r2 M3: the baseline\'s own process group (the Bash tool\'s, not claude\'s) is killed at its time limit', async () => {
  const { d, x } = inputs({ spawn: standIn([], { sandbox: true }), baselineMs: 4_000 });
  x.testCommand = `/bin/echo $$ > '${join(d, 'job.pid')}'; /bin/sleep 30`;
  try {
    assert.match((await workerChecks(x)[11]()).reason, /the baseline run did not finish: it did not finish in time/);
    assert.ok(existsSync(join(d, 'job.pid')), 'the tests started (their shell wrote its pid) before the limit');
    const g = Number(readFileSync(join(d, 'job.pid'), 'utf8'));
    let alive = true;
    for (let n = 0; n < 100 && alive; n += 1) { try { process.kill(-g, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; } }
    assert.equal(alive, false, 'the tests\' own group is gone, not claude\'s alone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#369 r1 M1: what the baseline leaves running, in its group or in a session of its own, never reaches the session\'s copy', async () => {
  const late = [
    ['a background child', '( sleep 1; echo x > .mcp.json; mkdir -p .claude; echo x > .claude/settings.local.json ) & true'],
    ['a child in its own session', "perl -e 'use POSIX; exit 0 if fork; POSIX::setsid(); sleep 1; open(my $f, q{>}, q{.mcp.json}); print $f q{x};'; true"],
  ];
  for (const [what, cmd] of late) {
    const { d, x } = inputs({ testCommand: cmd, spawn: standIn([], { sandbox: true }) });
    try {
      assert.deepEqual(await workerChecks(x)[11](), { ok: true }, what);
      await new Promise((r) => setTimeout(r, 1600));
      assert.equal(existsSync(join(x.copy, '.mcp.json')), false, `${what}: the session's copy is untouched`);
      assert.equal(existsSync(join(x.copy, '.claude')), false, what);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('step 6, check 2 (#369 m7): names compared after folding letter case, a non-plain file of main\'s refused, a nested change found', async () => {
  const root = tempDir('orch-rchecks-');
  try {
    const copy = join(root, 'copy'); mkdirSync(join(copy, '.claude'), { recursive: true }); mkdirSync(join(copy, 'pkg'));
    writeFileSync(join(copy, '.claude', 'a'), 'A'); writeFileSync(join(copy, '.claude', 'b'), 'B'); writeFileSync(join(copy, 'pkg', 'CLAUDE.local.md'), 'n');
    const blobs = { oa: 'A', ob: 'B', on: 'n' };
    const tree = (rows) => async (args) => args[0] === 'ls-tree' ? { code: 0, stdout: Buffer.from(rows.map((r) => `${r}\0`).join('')) } : { code: 0, stdout: Buffer.from(blobs[args[2]]) };
    const rows = ['100644 blob oa\t.claude/a', '100755 blob ob\t.CLAUDE/b', '100644 blob on\tpkg/CLAUDE.local.md', '100644 blob zz\tsrc.txt'];
    assert.equal(await setupFilesProblem({ copy, mirror: '/m' }, { run: tree(rows) }), null, 'main\'s .CLAUDE/b is the copy\'s .claude/b on the Mac\'s disk');
    assert.match(await setupFilesProblem({ copy, mirror: '/m' }, { run: tree([...rows, '120000 blob ol\t.mcp.json']) }), /main's \.mcp\.json is not a plain file \(mode 120000\)/);
    assert.match(await setupFilesProblem({ copy, mirror: '/m' }, { run: tree([...rows, '160000 commit oc\t.claude/sub']) }), /main's \.claude\/sub is not a plain file/);
    assert.match(await setupFilesProblem({ copy, mirror: '/m' }, { run: tree([...rows, '100644 blob om\t.mcp.json']) }), /main's \.mcp\.json is not put back/, 'the missing one by main\'s own name');
    writeFileSync(join(copy, 'pkg', 'CLAUDE.local.md'), 'changed');
    assert.match(await setupFilesProblem({ copy, mirror: '/m' }, { run: tree(rows) }), /the copy's pkg\/CLAUDE\.local\.md is not main's/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const RULES = { production: { env_files: ['.env'], programs: ['psql'], hosts: ['db.example.com'] } };
test('step 6: the runner\'s config feeds the checks (pin, machine-wide file, the product\'s rules, paths and test command)', async () => {
  const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, pin: '2.1.300', machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json',
    products: { p1: { repo: 'o/p', mirror: '/m', rules: RULES, render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, hooksDir: '/h', snapshot: '/snap/s.json', bobFolder: '/b' }, product: { commands: { test: 'npm test' } } } } } });
  const i = workerCheckInputs(c, { product: 'p1', sessionId: SID });
  assert.deepEqual([i.mirror, i.pin, i.hooksDir, i.rules, i.snapshot, i.machineWide, i.home, i.testCommand, i.bobFolder, i.budget],
    ['/m', '2.1.300', '/h', RULES, '/snap/s.json', '/Library/Application Support/ClaudeCode/managed-settings.json', '/home', 'npm test', '/b', null]);
  for (const k of ['busy', 'writeSnapshot', 'spawn', 'alert']) assert.equal(typeof i[k], 'function', k);
  // The start port gets these checks and check 0's version.
  const sd = startDeps(c);
  assert.equal(sd.names.version, '2.1.300');
  // Checks 1, 2, 3 and 8 once more just before claude starts (#369 M1, r1 m1): here no copy, so check 1 refuses first.
  assert.deepEqual(RECHECK, [1, 2, 3, 8]);
  assert.match(await sd.beforeStart({ product: 'p1', sessionId: SID, copy: '/c/C-1', ownUid: () => process.getuid() }), /^check 1: the card's copy is missing/);
  const wx = { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: 'p1', sessionId: SID, copy: '/c/C-1', settings: { file: '/f', settings: {} } };
  assert.deepEqual(Object.keys(sd.checksFor(wx)).map(Number), [1, 2, 3, 5, 6, 7, 8, 9, 10], 'no throwaway port, no check 11');
  assert.deepEqual(Object.keys(sd.checksFor({ ...wx, throwaway: async () => ({}) })).map(Number), [1, 2, 3, 5, 6, 7, 8, 9, 10, 11]);
  // L969: the install command and the registry hosts come from the product's render; runLocked from the one wiring.
  const withInstall = { ...c, products: { p1: { ...c.products.p1, render: { ...c.products.p1.render, product: { commands: { install: 'npm ci' } }, registryHosts: ['registry.npmjs.org'] } } } };
  const j = workerCheckInputs(withInstall, { product: 'p1', sessionId: SID }, { runLocked: async () => ({ ok: true }) });
  assert.deepEqual([j.installCommand, j.registryHosts, typeof j.runLocked], ['npm ci', ['registry.npmjs.org'], 'function']);
  assert.equal(workerCheckInputs(c, { product: 'p1', sessionId: SID }).runLocked, null, 'none given: none');
  const base = { installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, products: { p1: { repo: 'o/p', mirror: '/m', render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] } } } } } };
  assert.throws(() => checkRunnerConfig({ ...base, pin: 'latest' }), /pin must be/);
  // #419 r3 c1, m1: any value but the fixed file, a near miss or an unsimple path, is told the fixed file.
  for (const machineWide of ['mw', '/mw/', '/a/../mw', '//mw', '/m w', ...NEAR_MISSES]) assert.throws(() => checkRunnerConfig({ ...base, machineWide }), new RegExp(`config: machineWide must be ${esc(FIXED)}: claude 2\\.1\\.322 reads only that file$`), JSON.stringify(machineWide));
  // L915 (#420 m2): render.paths node, hooksDir, notes and bobFolder, when given, in their simplest form, at load.
  for (const k of ['node', 'hooksDir', 'notes', 'bobFolder']) {
    const at = (v) => ({ ...base, products: { p1: { ...base.products.p1, render: { paths: { ...base.products.p1.render.paths, [k]: v } } } } });
    for (const bad of [`/x/${k}/`, `x/${k}`, `/x/../${k}`, '/', 7]) {
      assert.throws(() => checkRunnerConfig(at(bad)), new RegExp(`product p1: render\\.paths\\.${k} must be a full path in its simplest form`), `${k} ${bad}`);
    }
    assert.doesNotThrow(() => checkRunnerConfig(at(`/x/${k}`)), k);
  }
  // L913 (a): any file but claude's fixed one is refused at load, not session by session at check 10.
  assert.throws(() => checkRunnerConfig({ ...base, machineWide: '/mw.json' }), /machineWide must be \/Library\/Application Support\/ClaudeCode\/managed-settings\.json: claude 2\.1\.322 reads only that file/);
  assert.equal(checkRunnerConfig({ ...base, machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json' }).machineWide, '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.throws(() => checkRunnerConfig({ ...base, products: { p1: { ...base.products.p1, rules: [] } } }), /rules must be/);
  // #369 m4: the rules' production lists, as the review runner requires; one snapshot per product, apart from the runner's folders (L916).
  for (const rules of [{}, { production: { env_files: [], programs: [] } }, { production: { env_files: [1], programs: [], hosts: [] } }]) {
    assert.throws(() => checkRunnerConfig({ ...base, products: { p1: { ...base.products.p1, rules } } }), /rules\.production must list env_files, programs and hosts/, JSON.stringify(rules));
  }
  const withSnap = (p1, p2) => ({ ...base, products: { p1: { ...base.products.p1, render: { paths: { ...base.products.p1.render.paths, snapshot: p1 } } }, p2: { ...base.products.p1, render: { paths: { ...base.products.p1.render.paths, snapshot: p2 } } } } });
  assert.doesNotThrow(() => checkRunnerConfig(withSnap('/snap/s1.json', '/snap/s2.json')));
  // L916: the old placement (the runner's own folder, /o), the requests folder (/r), inside either, above either, or not simple.
  const notApart = /p1: render\.paths\.snapshot must be a file in a folder of its own, apart from the runner's requests folder \(\/r\) and its own folder \(\/o\)/;
  for (const s of ['/o/s.json', '/O/s.json', '/o/sub/s.json', '/r/s.json', '/r/sub/s.json', '/o', '/r', '/s.json', '/o/../o/s.json', 's.json']) assert.throws(() => checkRunnerConfig(withSnap(s, '/snap/s2.json')), notApart, s);
  // #369 r1 m4: never one of the runner's own files there (now: never in its folder at all).
  for (const s of ['/o/status.json', '/o/Memory.json', '/o/settings', '/o/lock', '/o/break.lock']) assert.throws(() => checkRunnerConfig(withSnap(s, '/snap/s2.json')), notApart, s);
  assert.throws(() => checkRunnerConfig(withSnap('/snap/s.json', '/snap/S.json')), /p2: render\.paths\.snapshot is another product's/);
  // L916 self-review M1: never where a worker session can write it (base: copies /c, outboxes /ob, home /home, mirror /m).
  for (const [s, what] of [['/c/s.json', 'the copies \\(\\/c\\)'], ['/C/p1/s.json', 'the copies'], ['/ob/p1/s.json', 'the outboxes'], ['/home/s.json', "the sessions' home"], ['/m/s.json', "product p1's mirror"]]) {
    assert.throws(() => checkRunnerConfig(withSnap(s, '/snap/s2.json')), new RegExp(`p1: render\\.paths\\.snapshot must not sit in ${what}`), s);
  }
  // L916 self-review m1, m2: the session's own folders, and the status folder, apart from the runner's folders at load.
  const withPath = (k, v) => ({ ...base, products: { p1: { ...base.products.p1, render: { paths: { ...base.products.p1.render.paths, [k]: v } } } } });
  for (const k of ['node', 'hooksDir', 'notes', 'bobFolder']) for (const v of [`/o/${k}`, `/R/${k}`, '/o', '/r']) {
    assert.throws(() => checkRunnerConfig(withPath(k, v)), new RegExp(`p1: render\\.paths\\.${k} must be apart from the runner's requests folder`), `${k} ${v}`);
  }
  for (const statusFile of ['/r/status.json', '/r/sub/status.json', '/R/status.json']) assert.throws(() => checkRunnerConfig({ ...base, statusFile }), /status file must sit in the runner's own folder, apart from the requests folder/, statusFile);
});

test('#369 r1 m1, m2: just before claude starts, the copy, its setup files, the outbox and the rules snapshot are checked again', async () => {
  const f = await copyOfMain();
  try {
    const own = join(f.root, 'runner'); mkdirSync(own);
    const snapDir = join(f.root, 'snapshots'); mkdirSync(snapDir);   // L916: apart from the runner's folders
    const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: join(own, 'status.json'), orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
      path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, products: { p1: { repo: REPO, mirror: f.mirror, rules: RULES,
        render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, snapshot: join(snapDir, 'rules.json') } } } } });
    chmodSync(f.copy, 0o700);
    const outbox = join(f.root, 'outbox'); mkdirSync(outbox, { mode: 0o700 });
    const x = { product: 'p1', sessionId: SID, copy: f.copy, head: f.head, outbox, ownUid: () => process.getuid() };
    // What holds the outbox is read with /usr/sbin/lsof, the Mac's (the runner's machine). Off a Mac, where that file is
    // not there, the test stands in for it; on a Mac the real one runs. The real check fails closed without it (below).
    const busy = process.platform === 'darwin' ? undefined : () => [];
    const checksOf = (y) => workerChecks({ ...workerCheckInputs(c, y), ...(busy ? { busy } : {}) });
    const again = startDeps(c, { checksOf }).beforeStart;
    assert.equal(await again(x), null);
    // No way to tell what holds the outbox (lsof missing or failing): the start is refused, never passed on a guess.
    const blind = (y) => workerChecks({ ...workerCheckInputs(c, y), busy: () => { throw new Error('lsof failed (ENOENT)'); } });
    assert.equal(await startDeps(c, { checksOf: blind }).beforeStart(x), 'check 3: could not check what holds the outbox');
    // A check with no port refuses the start, never passes on a guess: here a product with no rules snapshot (check 8).
    const noSnap = { ...c, products: { p1: { ...c.products.p1, render: { paths: { ...c.products.p1.render.paths, snapshot: undefined } } } } };
    assert.equal(await startDeps(noSnap, { checksOf: (y) => workerChecks({ ...workerCheckInputs(noSnap, y), ...(busy ? { busy } : {}) }) }).beforeStart(x), 'check 8 has no port');
    // Check 8: the snapshot is written afresh.
    rmSync(join(snapDir, 'rules.json'));
    assert.equal(await again(x), null); assert.equal(existsSync(join(snapDir, 'rules.json')), true, 'the snapshot is written again');
    // Check 3: a hand-in left in the outbox.
    writeFileSync(join(outbox, 'bundle-C-1.json'), '{}');
    const o3 = await again(x);
    assert.ok(o3 === null ? !existsSync(join(outbox, 'bundle-C-1.json')) : /^check 3:/.test(o3), String(o3));
    // Check 2: a setup file changed.
    writeFileSync(join(f.copy, '.mcp.json'), '{"x":1}\n');
    assert.match(await again(x), /^check 2: the copy's \.mcp\.json is not main's/);
    writeFileSync(join(f.copy, '.mcp.json'), '{}\n');
    // Check 1: HEAD moved, and the copy's folder opened up.
    assert.match(await again({ ...x, head: 'a'.repeat(40) }), /^check 1: the card's copy holds/);
    chmodSync(f.copy, 0o755);
    assert.match(await again(x), /^check 1: the card's copy is not this user's alone/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('#369 r1 m3: check 2 compares with the main the copy was restored from, not the main that moved since', async () => {
  const f = await copyOfMain();
  try {
    const at = (await gitOk(['rev-parse', 'refs/heads/main'], { gitDir: f.mirror })).trim();
    const src = join(f.root, 'src'); const o = { gitDir: join(src, '.git'), workTree: src, cwd: src };
    writeFileSync(join(src, '.mcp.json'), '{"moved":true}\n');
    await gitOk(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'm2'], o);
    await gitOk(['fetch', '-q', src, 'refs/heads/main:refs/heads/main'], { gitDir: f.mirror });
    assert.match(await setupFilesProblem(f), /\.mcp\.json is not main's/, 'against the moving main');
    assert.equal(await setupFilesProblem({ ...f, mainAt: at }), null, 'against the main it was restored from');
    // #369 r1 c3: a tree deeper than the walk goes is refused, not walked for ever.
    let deep = f.copy; for (let i = 0; i < WALK_DEPTH + 2; i++) deep = join(deep, 'd');
    mkdirSync(deep, { recursive: true });
    assert.match(await setupFilesProblem({ ...f, mainAt: at }), /more than 64 folders deep/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('L1001: the config\'s budget and Bob file list reach the checks, which then have ports 12 and 13; with none, neither has', () => {
  const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, pin: '2.1.300', machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json',
    budget: '/i/modules/M11-dispatcher/budget.mjs', bobManifest: '/i/bob-manifest.json', dispatcherRules: '/d/rules.json', reviewStatusFile: '/rv/status.json', reviewUid: 503,
    products: { p1: { repo: 'o/p', mirror: '/m', rules: RULES, render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, hooksDir: '/h', snapshot: '/snap/s.json', bobFolder: '/b' } } } } });
  const budget = { rules: {}, rec: {}, bandsNow: () => ({}), runningNow: () => [] }; const bobManifest = { 'a.md': 'f'.repeat(64) };
  const i = workerCheckInputs(c, { product: 'p1', sessionId: SID }, { budget, bobManifest });
  assert.equal(i.budget, budget); assert.equal(i.bobManifest, bobManifest);
  const wx = { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: 'p1', sessionId: SID, copy: '/c/C-1', settings: { file: '/f', settings: {} } };
  const ports = (o) => Object.keys(startDeps(c, o).checksFor(wx)).map(Number);
  assert.deepEqual(ports({ budget, bobManifest }), [1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13]);
  assert.deepEqual(ports({}), [1, 2, 3, 5, 6, 7, 8, 9, 10], 'none loaded: no port, so launch refuses');
});

// #463 r3 m5: the merge with #478 keeps both: one lockedWiring carries the lock-down runner (check 4 and save-work) AND the
// budget and Bob file list (checks 12 and 13), and realRunnerPorts hands it all four. Taking either side alone would
// quietly drop check 4 and save-work, or check 12.
test('#463 r3 m5: check 4, save-work and checks 12 and 13 all stay wired through lockedWiring and realRunnerPorts', async () => {
  const c = checkRunnerConfig({ installRoot: '/i', requestsDir: '/r', statusFile: '/o/status.json', orchestrateUid: 501, outboxRoot: '/ob', copiesRoot: '/c', home: '/home',
    path: '/usr/bin', claudeBin: '/i/claude', recordRoot: '/rec', recordUid: 502, claimMs: 1, pin: '2.1.300', machineWide: '/Library/Application Support/ClaudeCode/managed-settings.json',
    budget: '/i/modules/M11-dispatcher/budget.mjs', bobManifest: '/i/bob-manifest.json', dispatcherRules: '/d/rules.json', reviewStatusFile: '/rv/status.json', reviewUid: 503,
    products: { p1: { repo: 'o/p', mirror: '/m', rules: RULES, render: { paths: { deny: { record: '/rec', ssh: '/h/.ssh', gh: '/h/.config/gh', claudeHome: '/h/.claude', robotKeys: '/k', secrets: ['/sec'] }, hooksDir: '/h', snapshot: '/snap/s.json', bobFolder: '/b' }, product: { commands: { install: 'npm ci', test: 'npm test' } }, registryHosts: [] } } } });
  const budget = { rules: {}, rec: {}, bandsNow: () => ({}), runningNow: () => [] }; const bobManifest = { 'a.md': 'f'.repeat(64) };
  const seen = []; const jobs = [];
  const runLocked = async (j) => { seen.push(j.job); jobs.push(j); return j.job === 'install' ? { ok: true } : { ok: false, reason: 'stand-in' }; };
  const wx = { role: 'worker', profile: DESIGN_PROFILES.worker, kind: 'editing', product: 'p1', sessionId: SID, copy: '/c/C-1', settings: { file: '/f', settings: {} }, renderPhase: () => ({ ok: true, settings: {} }), writeSettings: () => ({ ok: true }) };
  const w = lockedWiring(c, { runLocked, budget, bobManifest });
  const k = w.startDeps.checksFor(wx);
  assert.deepEqual(Object.keys(k).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13], 'check 4 and checks 12 and 13 together');
  assert.deepEqual(await k[4](), { ok: true }); assert.deepEqual(seen, ['install'], 'check 4 runs the install through the one runLocked');
  assert.equal(Object.hasOwn(jobs[0], 'onGroup'), false, 'no onGroup given, none passed');
  // #463 r3 m1: the runner's onGroup (the start's) reaches the install, so its groups are kept as a save's are.
  const og = () => {};
  assert.deepEqual(await w.startDeps.checksFor({ ...wx, onGroup: og })[4](), { ok: true });
  assert.equal(jobs.at(-1).onGroup, og); seen.length = 0; seen.push('install');
  const real = tempDir('orch-'); mkdirSync(join(real, '.git'));
  try { assert.deepEqual(await w.saveWork({ id: SID, product: 'p1', kind: 'editing', card: 'C-1', copy: real, outbox: '/ob/p1/worker/x', save_settings_sha: 'a'.repeat(64) }), { ok: false, reason: 'stand-in' }); }
  finally { rmSync(real, { recursive: true, force: true }); }
  assert.deepEqual(seen, ['install', 'save-work'], 'save-work through the same runLocked');
  // realRunnerPorts hands lockedWiring the runner, the budget and the Bob file list, and uses its save-work and start deps.
  let got; let made;
  const p = realRunnerPorts(c, {}, { runLocked, budget, bobManifest, wire: (cc, o) => { got = o; made = lockedWiring(cc, o); return made; } });
  assert.equal(got.runLocked, runLocked); assert.equal(got.budget, budget); assert.equal(got.bobManifest, bobManifest);
  assert.equal(p.saveWork, made.saveWork, 'the runner\'s save-work is lockedWiring\'s');
  // Left out, the budget and Bob list are null (checks 12 and 13 have no port), and check 4 stays on.
  realRunnerPorts(c, {}, { runLocked, wire: (cc, o) => { got = o; return lockedWiring(cc, o); } });
  assert.deepEqual([got.budget, got.bobManifest, got.runLocked], [null, null, runLocked]);
  assert.deepEqual(Object.keys(lockedWiring(c, { runLocked }).startDeps.checksFor(wx)).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

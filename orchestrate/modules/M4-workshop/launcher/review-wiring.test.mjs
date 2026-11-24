// R-0b-163: the review runner's wiring. It makes the copy and the settings, then every session goes through the
// launcher's own launch() (L83 M-3); claude is spawned only after every check passed. The ports themselves and the
// spawn arguments are tested in review-launch.test.mjs; L66's live wall proof is review-walls-proof.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as wiring from './review-wiring.mjs';
import { DESIGN_PROFILES } from './role-profiles.mjs';
import { renderRoleSettings } from './render-settings.mjs';
import { namesIn, FLAGS } from './settings-names.mjs';
import { sessionSettings, templateText, templateFile } from './review-settings.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { tempDir } from '../../../shared/test-tmp.mjs';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { reviewChecks, smokeCommand, smokeFiles } from './review-launch.mjs';
import { LOCKED_PROMPT } from './launch.mjs';
import { installHooks } from './hooks-check.mjs';
import { writeSnapshot } from '../hooks/snapshot.mjs';
import { fakeClaude } from './fake-claude.test-helper.mjs';
import { smokeRunOf } from '../../../wiring/runner-checks.mjs';
import { GUARD, jobGuard, lockedJobOf, lockedRule } from '../../../wiring/runner-locked.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const HEAD = 'a'.repeat(40);
const PKG_SHA = 'f'.repeat(64);
const ME = process.getuid();
const UIDS = { ...Object.fromEntries(Object.keys(DESIGN_PROFILES).map((r) => [r, ['reviewer', 'auditor'].includes(r) ? ME : ME + 1000])), plan_reviewer: ME };

function settingsOf(role) {
  const r = renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
    paths: { copy: '/rc/S-1', outbox: '/o/reviewer/S-1', hooksDir: '/i/hooks', snapshot: '/r/rules.json', node: '/i/node', bobFolder: '/b', notes: '/r/notes/S-1',
      deny: { proposals: ['/w/proposals'], secrets: ['/k'] }, reviewWalls: { outboxRoot: '/o', runnerRoot: '/r' } } });
  assert.equal(r.ok, true, r.reason);
  return r.settings;
}

// A spawn that records every call: the launch path must never reach it while a check refuses.
function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args, opts) => { calls.push({ bin, args, opts }); const c = new EventEmitter(); setImmediate(() => { c.pid = 4242; c.emit('spawn'); }); return c; };
  return { spawn, calls };
}

function x(over = {}, li = undefined) {
  const made = [];
  const settings = [];
  const sp = fakeSpawn();
  const role = over.role ?? 'reviewer';
  return {
    made, settings, calls: sp.calls,
    x: {
      role, card: 'C-1', head: HEAD, sessionId: 'S-1', outbox: '/o/reviewer/S-1', home: '/h', env: { CLAUDE_CONFIG_DIR: '/h/.claude' }, earlier: '',
      claudeBin: '/i/claude-code/2.1.300/claude', copy: '/rc/S-1-not-there', spawn: sp.spawn,
      makeCopy: async () => { made.push('/rc/S-1'); return { ok: true }; },
      settingsFor: (dir) => { settings.push(dir); return { ok: true, file: '/r/settings/S-1.json', settings: DESIGN_PROFILES[role] ? settingsOf(role) : {} }; },
      packageDir: '/r/packages/S-1',
      packageFor: async ({ copy, head, dir, since }) => { made.push(`package ${copy} -> ${dir}${since ? ` since ${since}` : ''}`); return { ok: true, base: 'b'.repeat(40), head, files: [{ status: 'M', path: 'a.txt' }], diffFile: `${dir}/change.diff`, diffBytes: 10, diffSha256: PKG_SHA }; },
      ...(li ? { launchInputs: li } : {}),
      ...over,
    },
  };
}

test('R-0b-163 (L78): the wiring exports start and nothing else', () => {
  assert.deepEqual(Object.keys(wiring).sort(), ['start']);
});

test('#530 r1 m1 PLANT: the review session\'s environment comes from startEnv, with HOME the runner names; none named, or a name off the allow-list, is refused before claude', async () => {
  for (const [over, re] of [[{ home: undefined }, /the environment: the session's home was not named by the runner/], [{ home: 'h' }, /home was not named/],
    [{ env: { CLAUDE_CONFIG_DIR: '/h/.claude', CLAUDECODE: '1' } }, /the environment: variables not on the role's allow-list .*CLAUDECODE/],
    [{ env: { ANTHROPIC_API_KEY: 'k' } }, /the environment: refused variables .*ANTHROPIC_API_KEY/], [{ env: 'x' }, /the environment: the extra environment is not an object/]]) {
    const w = x(over); const r = await wiring.start(w.x);
    assert.equal(r.ok, false, JSON.stringify(over)); assert.match(r.reason, re); assert.equal(w.calls.length, 0, 'claude is never spawned');
  }
});

test('L83 M-3 planted: start runs launch(): with no launch inputs it is refused at check 0, and claude is never spawned', async () => {
  for (const role of ['reviewer', 'auditor']) {
    const w = x({ role });
    const r = await wiring.start(w.x);
    assert.equal(r.ok, false, role);
    assert.match(r.reason, /runs only as the review user/);
    assert.deepEqual(r.launch_log, []);
    assert.equal(r.package_sha256, PKG_SHA, 'once the package is written its sha256 goes back for the runner to pin, even on a refusal');
    assert.deepEqual(w.made, ['/rc/S-1', 'package /rc/S-1-not-there -> /r/packages/S-1'], 'the copy is made first, then the package goes in the runner\'s folder');
    assert.deepEqual(w.settings, ['/rc/S-1-not-there'], 'the settings name that same copy');
    assert.equal(w.calls.length, 0, 'claude is never spawned');
  }
});

test('L83 M-3 planted: past check 0 the launcher\'s own checks run on the session (check 1 here), with the session\'s flags; still no spawn', async () => {
  const s = settingsOf('reviewer');
  const flags = Object.values(FLAGS).filter((f) => f.startsWith('--'));
  const confirmed = Object.fromEntries([...namesIn(s), ...flags].map((n) => [n, { by: 'readback:stand-in', version: '2.1.300' }]));
  const w = x({}, { uids: UIDS, ownUid: () => ME, pin: '2.1.300', names: { confirmed } });
  const r = await wiring.start(w.x);
  assert.equal(r.ok, false);
  assert.match(r.reason, /launch check 1 \(fresh copy\): the review copy is missing/);
  assert.deepEqual(r.launch_log, [{ n: 1, ok: false, reason: 'the review copy is missing' }]);
  assert.equal(w.calls.length, 0);
  // The names check reads the flags the session will really start with, and the pin as the version.
  const off = x({}, { uids: UIDS, ownUid: () => ME, pin: '2.1.299', names: { confirmed } });
  assert.match((await wiring.start(off.x)).reason, /setting names not confirmed/);
});

// L83 minor 2: the real sessionSettings, on a throwaway machine laid out as the updater lays it (as review-settings.test.mjs).
function machine() {
  const base = realpathSync(tempDir('m4-wiring-'));
  const d = (...p) => { const q = join(base, ...p); mkdirSync(q, { recursive: true }); return q; };
  const V = `install.v-${'c'.repeat(40)}`;
  d(V, 'orchestrate');
  const installRoot = join(base, 'install');
  symlinkSync(`${V}/orchestrate`, installRoot); // root's link to the copy in the versioned folder (L75 M-1, L92 item 4)
  mkdirSync(dirname(templateFile(installRoot, 'reviewer')), { recursive: true });
  for (const r of REVIEW_ROLES) { copyFileSync(join(HERE, 'templates', `${r}.settings.json`), templateFile(installRoot, r)); chmodSync(templateFile(installRoot, r), 0o644); }
  const node = join(d('install', 'bin'), 'node'); writeFileSync(node, '');
  const root = d('runner'); chmodSync(root, 0o700);
  const snapshot = join(root, 'rules.json'); writeFileSync(snapshot, '{}');
  const outboxRoot = d('outbox'); d('outbox', 'reviewer', 'S-1');
  const c = { installRoot, root, outboxRoot, hooksDir: d('install', 'hooks'), snapshot, bobFolder: d('bob'), deny: [d('secrets')], reviewCopies: d('review-copies'), workerCopies: d('worker-copies') };
  return { c, node, copy: join(c.reviewCopies, 'S-1') };
}

test('L83 minor 2 planted: the file the session is handed is byte for byte what the real sessionSettings wrote', async () => {
  const m = machine();
  let made = null;
  const w = x({
    copy: m.copy, outbox: join(m.c.outboxRoot, 'reviewer', 'S-1'),
    makeCopy: async () => { mkdirSync(m.copy, { mode: 0o700 }); return { ok: true }; },
    settingsFor: (dir) => {
      made = sessionSettings(m.c, { role: 'reviewer', sessionId: 'S-1', copy: dir, node: m.node }, { owner: ME, uid: ME });
      return made;
    },
  });
  const r = await wiring.start(w.x);
  assert.equal(made?.ok, true, made?.reason);
  assert.equal(r.ok, false, 'no launch inputs: refused at check 0');
  assert.equal(readFileSync(made.file, 'utf8'), templateText(made.settings), 'the wiring left the file as sessionSettings wrote it');
  assert.equal(made.file, join(m.c.root, 'settings', 'S-1.json'));
});

test('R-0b-146: a re-audit\'s package is made since the head the earlier audit passed', async () => {
  const w = x({ role: 'auditor', audited: 'c'.repeat(40) });
  await wiring.start(w.x);
  assert.deepEqual(w.made, ['/rc/S-1', `package /rc/S-1-not-there -> /r/packages/S-1 since ${'c'.repeat(40)}`]);
});

test('R-0b-163: no profile, no copy or no settings means no launch', async () => {
  assert.match((await wiring.start(x({ role: 'builder' }).x)).reason, /has no role profile/);
  const noCopy = x({ makeCopy: async () => ({ ok: false, reason: 'gone' }) });
  assert.match((await wiring.start(noCopy.x)).reason, /the review copy: gone/);
  const throws = x({ makeCopy: async () => { throw new Error('disk'); } });
  assert.match((await wiring.start(throws.x)).reason, /the review copy: disk/);
  const noSettings = x({ settingsFor: () => ({ ok: false, reason: 'template' }) });
  const ns = await wiring.start(noSettings.x);
  assert.match(ns.reason, /the settings: template/);
  assert.equal(ns.package_sha256, PKG_SHA);
  const noPkg = x({ packageFor: async () => ({ ok: false, reason: 'no diff' }) });
  assert.deepEqual(await wiring.start(noPkg.x), { ok: false, reason: 'the review package: no diff' });
  for (const w of [noCopy, throws, noSettings, noPkg]) assert.equal(w.calls.length, 0);
});

// L1353: check 11's smoke for a review session. A whole start can't reach check 11 yet (check 2 has no port for the
// review roles until lane 2 declares it), so what start hands launch() is read where launch() first uses it: check 1's
// own `x.ownUid()`, a method call on that very object (no hook in the wiring). Check 11 is then run on it as launch()
// would run it.
// An installed version as the updater lays it out (#666 r2 M1, L1354): the hooks copied to <version>/hooks, the guard
// at <version>/modules/M4-workshop/jobs, and the module hooks they were made from beside it; the role's settings
// rendered for that hooks folder, written as sessionSettings writes them.
function smokeMachine(role) {
  const base = realpathSync(tempDir('m4-wiring-smoke-'));
  const d = (...p) => { const q = join(base, ...p); mkdirSync(q, { recursive: true }); return q; };
  const v = d('orchestrate.v-abc', 'orchestrate');
  installHooks(join(v, 'hooks'));
  cpSync(GUARD, join(d('orchestrate.v-abc', 'orchestrate', 'modules', 'M4-workshop', 'jobs'), 'guard.sh'));
  installHooks(join(v, 'modules', 'M4-workshop', 'hooks'));
  const copy = d('review-copies', 'S-1'); chmodSync(copy, 0o700);
  const runner = d('runner'); chmodSync(runner, 0o700);
  const snapshot = join(runner, 'rules.json');
  writeSnapshot(snapshot, { production: { env_files: [join(base, 'prod.cfg')], programs: ['fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [d('keys')] } });
  const r = renderRoleSettings({ productionFiles: [], proposalOutboxes: ['/w/proposals'], role, profile: DESIGN_PROFILES[role], product: { commands: { test: 'npm test' } },
    paths: { copy, outbox: d('outbox', role, 'S-1'), hooksDir: join(v, 'hooks'), snapshot, node: process.execPath, bobFolder: d('bob'), notes: d('runner', 'notes', 'S-1'),
      deny: { proposals: ['/w/proposals'], secrets: [join(base, 'keys')] }, reviewWalls: { outboxRoot: join(base, 'outbox'), runnerRoot: runner } } });
  assert.equal(r.ok, true, r.reason);
  const file = join(d('runner', 'settings'), 'S-1.json');
  writeFileSync(file, templateText(r.settings), { mode: 0o600 });
  return { base, v, copy, outbox: join(base, 'outbox', role, 'S-1'), file, settings: r.settings, reviewHome: d('home') };
}

// The stand-in claude (fake-claude.test-helper.mjs), and what each smoke claude was handed: the one command, and the
// job's own settings file as it was while claude ran.
function smokeSpawn(m, seen, smoke = 'sandboxed') {
  const fake = fakeClaude(m.base);
  return (bin, args, opts) => {
    const prompt = args.at(-1);
    if (prompt.startsWith(LOCKED_PROMPT)) {
      const file = args[args.indexOf(FLAGS.settings) + 1];
      seen.push({ bin, command: prompt.slice(LOCKED_PROMPT.length), file, text: readFileSync(file, 'utf8'), cwd: opts.cwd, env: opts.env });
    }
    return childSpawn(process.execPath, [fake, ...args], { ...opts, env: { ...opts.env, PATH: process.env.PATH, FAKE_SMOKE: smoke } });
  };
}

async function handedToLaunch(m, role, { spawn, li = {}, over = {} } = {}) {
  const flags = Object.values(FLAGS).filter((f) => f.startsWith('--'));
  const confirmed = Object.fromEntries([...namesIn(m.settings), ...flags].map((n) => [n, { by: 'readback:stand-in', version: '2.1.300' }]));
  let got = null;
  const w = x({ role, copy: m.copy, outbox: m.outbox, spawn, settingsFor: () => ({ ok: true, file: m.file, settings: m.settings }), ...over },
    { uids: UIDS, pin: '2.1.300', names: { confirmed }, reviewHome: m.reviewHome, probeMs: 20_000, ownUid() { got = this; return ME; }, ...li });
  const r = await wiring.start(w.x);
  return { r, got };
}

test('L1353: a reviewer\'s and an auditor\'s start hand check 11 the one smokeRunOf, and the smoke passes with a stand-in claude', async () => {
  for (const role of ['reviewer', 'auditor']) {
    const m = smokeMachine(role);
    try {
      const seen = [];
      const { r, got } = await handedToLaunch(m, role, { spawn: smokeSpawn(m, seen) });
      assert.match(r.reason, /launch check 1 \(fresh copy\)/, `${role}: the start stops at check 1 (an empty folder, no commit), after handing in its inputs`);
      assert.equal(got?.smokeRunOf, smokeRunOf, `${role}: the worker runner's own maker, not a second copy`);
      assert.deepEqual(await reviewChecks(got)[11](), { ok: true }, role);
      assert.equal(seen.length, 1, `${role}: one smoke claude`);
      const [one] = seen;
      // The session's own: its pinned claude, its review copy, its environment (check 9's), its settings beside the job's.
      assert.equal(one.bin, got.claudeBin); assert.equal(one.cwd, m.copy); assert.equal(one.env.HOME, got.env.HOME);
      assert.match(one.file, new RegExp(`^${m.file.slice(0, -'.json'.length)}\\.job-[0-9a-f]{16}\\.json$`));
      assert.equal(existsSync(one.file), false, `${role}: the job's own settings file is removed after`);
      // The smoke's line is the job, run by the guard beside the hooks the session's settings name (jobGuard).
      const guard = join(m.v, 'modules', 'M4-workshop', 'jobs', 'guard.sh');
      assert.equal(jobGuard(m.settings), guard);
      assert.ok(one.command.startsWith(`/bin/sh '${guard}' `), one.command);
      assert.equal(lockedJobOf(one.command), smokeCommand(smokeFiles(got)));
      // The rule and the command, byte for byte: the job's settings are the session's with exactly that one rule added.
      const job = JSON.parse(one.text);
      assert.equal(job.permissions.allow.at(-1), `Bash(${one.command})`);
      assert.equal(lockedRule(one.command), `Bash(${one.command})`);
      assert.deepEqual({ ...job, permissions: { ...job.permissions, allow: job.permissions.allow.slice(0, -1) } }, m.settings, 'nothing else changed');
      assert.equal(readFileSync(m.file, 'utf8'), templateText(m.settings), `${role}: the session's own settings file never holds the rule`);
      // The real hooks of that settings file, run as claude runs them, let the command through, and still refuse a near miss.
      const bash = m.settings.hooks.PreToolUse.filter((g) => g.matcher === '*' || g.matcher.split('|').includes('Bash')).flatMap((g) => g.hooks.map((h) => h.command));
      assert.deepEqual(bash.map((c) => c.match(/\/hooks\/([a-z-]+)\.mjs /)[1]).sort(), ['merge-guard', 'no-verify-block', 'production-write-guard', 'secret-file-block']);
      const run = (command) => bash.map((c) => spawnSync('/bin/sh', ['-c', c], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: m.copy }), encoding: 'utf8', timeout: 10_000 }));
      const through = run(one.command);
      assert.deepEqual(through.map((h) => h.status), [0, 0, 0, 0], `${role}: ${through.map((h) => h.stderr).join('')}`);
      assert.ok(run(`${one.command}; touch x`).some((h) => h.status === 2), `${role}: a near miss is refused`);
    } finally { rmSync(m.base, { recursive: true, force: true }); }
  }
});

test('L1353: no smokeRunOf still refuses check 11, and the runner\'s launch inputs can\'t take it out; stale hooks are refused by name', async () => {
  const m = smokeMachine('reviewer');
  try {
    const seen = [];
    const { got } = await handedToLaunch(m, 'reviewer', { spawn: smokeSpawn(m, seen), li: { smokeRunOf: undefined } });
    assert.equal(got.smokeRunOf, smokeRunOf, 'set after the launch inputs, so they can\'t remove or swap it');
    assert.match((await reviewChecks({ ...got, smokeRunOf: undefined })[11]()).reason, /the smoke has no lock-down run to go through/);
    assert.equal(seen.length, 0, 'no claude started');
    // L1354: hooks that are not their version's own are named, before any claude starts.
    appendFileSync(join(m.v, 'hooks', 'merge-guard.mjs'), '\n// changed\n');
    const r = await reviewChecks(got)[11]();
    assert.equal(r.ok, false);
    assert.match(r.reason, /not its version's own hooks \(hook merge-guard\.mjs differs from the module copy\)/);
    assert.equal(seen.length, 0, 'no claude started');
  } finally { rmSync(m.base, { recursive: true, force: true }); }
});

// L1353 live: the same smoke, the role's real settings and hooks, with a real claude. It calls the model, so it runs only
// when asked: ORCH_LIVE_CLAUDE=1 and a claude on the PATH, or ORCH_LIVE_CLAUDE_BIN (the pin's claude, to prove the pin).
const liveClaude = (() => {
  if (process.env.ORCH_LIVE_CLAUDE !== '1') return null;
  const bin = process.env.ORCH_LIVE_CLAUDE_BIN ?? spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  return bin && existsSync(bin) ? realpathSync(bin) : null;
})();
test('L1353 live: a real claude runs a reviewer\'s and an auditor\'s smoke under their own settings and hooks: inside the copy lands, outside and the network do not', {
  skip: liveClaude ? false : 'set ORCH_LIVE_CLAUDE=1 with a claude on the PATH (it calls the model)',
  timeout: 400_000,
}, async () => {
  for (const role of ['reviewer', 'auditor']) {
    const m = smokeMachine(role);
    try {
      const { got } = await handedToLaunch(m, role, { spawn: childSpawn, over: { claudeBin: liveClaude }, li: { probeMs: 120_000 } });
      assert.equal(got.smokeRunOf, smokeRunOf);
      // The review user's own sign-in is not this test's to read; the claude runs as whoever runs the test, signed in as
      // it is (as the L1352 live test does). Everything else is the session's own: settings, hooks, copy, guard.
      assert.deepEqual(await reviewChecks({ ...got, env: { ...process.env } })[11](), { ok: true }, role);
      assert.equal(readFileSync(m.file, 'utf8'), templateText(m.settings), `${role}: the session's own settings file is as written`);
      assert.deepEqual(readdirSync(join(m.base, 'runner', 'settings')), ['S-1.json'], `${role}: the job's own settings file is removed after`);
    } finally { rmSync(m.base, { recursive: true, force: true }); }
  }
});

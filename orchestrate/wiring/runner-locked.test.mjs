// runner-locked.mjs (L969): the lock-down runner. claude is stood in for by /bin/sh running the one command claude is
// asked to run, so what is proven here is everything around claude: the command each job gets, the result file, every
// refusal, the time limit's group kill, and a real save-work job (M4's own script, node, git) making a bundle in the
// outbox. That claude runs it under dontAsk with the worker hooks, inside the sandbox, is a Mini proof (M4 README,
// "Live proofs still to run", item 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pushWorld } from '../modules/M4-workshop/git/push-world.test-helper.mjs';
import { createSaveWork } from '../modules/M4-workshop/git/save-work.mjs';
import { bundleName } from '../modules/M4-workshop/git/push.mjs';
import { JOBS_DIR, JOB_ACK_WAIT_MS, LOCKED_JOBS, LOCKED_MS, LOCKED_SAVE_MS, RESULT_MAX_BYTES, SAVE_DELAYS_MS, GUARD, ackFile, groupFile, guardedRun, jobGuard, jobSettings, processInfo, jobSettingsFile, lockedCommand, lockedJobOf, lockedRule, jobFile, jobGroupProblem, lockedRunner, readGroupRecord, runToEnd, settingsSha, claudeEnd, sayable, hearing, resultWords, SAID_MAX } from './runner-locked.mjs';
import { EventEmitter } from 'node:events';
import { SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { LOCKED_PROMPT } from '../modules/M4-workshop/launcher/launch.mjs';
import { POLICY_HOOKS } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { DESIGN_PROFILES, outboxKindsFor } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { makeSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { LOCKED_JOB_COMMAND, guardBesideHooks, unreadable } from '../modules/M4-workshop/hooks/lib.mjs';
import { HOOKS_SOURCE, installHooks } from '../modules/M4-workshop/launcher/hooks-check.mjs';
import { partialName } from '../modules/M4-workshop/git/save-work.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_TICK_MS } from './runner-loop.mjs';
import { ASK_POLL_MS } from './owner-asks.mjs';

const ASK = LOCKED_PROMPT;
// claude, stood in for: the command it is asked to run, by /bin/sh, in its folder, with its environment and group.
const sh = (calls = []) => (bin, args, opts) => {
  const prompt = args.at(-1);
  assert.ok(prompt.startsWith(ASK), prompt);
  const child = childSpawn('/bin/sh', ['-c', prompt.slice(ASK.length)], opts);
  calls.push({ bin, args, opts, child });
  return child;
};
// A settings file in the form every job needs (#463 r1 m3): the sandbox on, failing closed, every command in it, no host.
const sandbox = (more = {}) => ({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true }, ...more });
const SAFE = `${JSON.stringify({ permissions: {}, sandbox: sandbox() })}\n`;
const world = () => {
  const d = tempDir('orch-locked-');
  const cwd = join(d, 'copy'); mkdirSync(cwd);
  const settingsFile = join(d, 'S-1.json'); writeFileSync(settingsFile, SAFE);
  return { d, cwd, settingsFile, sha: settingsSha(Buffer.from(SAFE)) };
};
const runner = (more = {}) => lockedRunner({ claudeBin: '/x/claude', envOf: () => ({ PATH: '/usr/bin:/bin' }), ...more });
// The Bash tool's own wait, set to the job's limit (#463 r2 m1), beside the environment given.
const bashWait = (ms) => ({ BASH_DEFAULT_TIMEOUT_MS: String(ms), BASH_MAX_TIMEOUT_MS: String(ms) });
// The command's quoted words (L1352): [the guard, the record, the go-ahead, the job in base64].
const wordsOf = (args) => [...args.at(-1).slice(ASK.length).matchAll(/'([^']*)'/g)].map((m) => m[1]);
const innerOf = (args) => Buffer.from(wordsOf(args)[3], 'base64').toString('utf8');
// The guard alone: its record and the wait for the runner's go-ahead (#463 r2 M1), then a job that does nothing.
const recordOf = (args) => lockedCommand({ gfile: wordsOf(args)[1], inner: 'exit 0' });
// claude as its Bash tool runs a command (#463 r2 M1, claude 2.1.322; checked: claude-code 2.1.316): detached, in a process group of its own, so
// claude's group is not the job's. `leave`: claude ends at once, leaving its command running (as a Bash tool that moved
// a command to the background would).
const detachedClaude = (calls = [], { leave = false } = {}) => (bin, args, opts) => {
  const cmd = args.at(-1).slice(ASK.length);
  const js = `const c = require('node:child_process').spawn('/bin/sh', ['-c', process.argv[1]], { detached: true, stdio: 'ignore' });`
    + (leave ? 'setTimeout(() => process.exit(0), 600);' : 'c.on(\'exit\', (x) => process.exit(x ?? 1));');
  const child = childSpawn(process.execPath, ['-e', js, cmd], opts);
  calls.push({ bin, args, opts, child });
  return child;
};
const groupAlive = (g) => { try { process.kill(-g, 0); return true; } catch { return false; } };
const goneSoon = async (g) => { for (let n = 0; n < 100 && groupAlive(g); n += 1) await new Promise((r) => setTimeout(r, 20)); return !groupAlive(g); };

test('L969: the install job runs the declared command in the copy under the session settings; exit 0 is ok, any other is a refusal', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  const run = runner({ spawn: sh(calls) });
  assert.deepEqual(await run({ job: 'install', command: 'touch installed', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: true });
  assert.ok(existsSync(join(cwd, 'installed')), 'ran in the copy');
  assert.equal(calls[0].bin, '/x/claude');
  // L1352: under the job's own settings file, the session's with this command's exact rule added, removed after.
  const own = calls[0].args[calls[0].args.indexOf('--settings') + 1];
  assert.ok(own.startsWith(settingsFile.slice(0, -'.json'.length)) && /\.job-[0-9a-f]{16}\.json$/.test(own), own);
  assert.equal(existsSync(own), false, 'the job\'s own settings file is removed');
  assert.equal(readFileSync(settingsFile, 'utf8'), SAFE, 'the session\'s settings file is untouched');
  assert.equal(calls[0].opts.cwd, cwd); assert.equal(calls[0].opts.detached, true, 'it leads its own group');
  assert.deepEqual(calls[0].opts.env, { PATH: '/usr/bin:/bin', ...bashWait(LOCKED_MS) }, 'the sign-in environment, as envOf gave it, and the Bash tool\'s wait');
  assert.deepEqual(await run({ job: 'install', command: 'exit 3', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: false, reason: 'the install exited 3' });
  assert.deepEqual(readdirSync(cwd), ['installed'], 'no result file left');
});

// Self-review m1 (#463 r2 M3): an old record or go-ahead that can't be removed is said as it is, nothing having run.
test('#463 r2 M3: an old process-group record or go-ahead that can\'t be removed refuses the job, said as it is, before claude starts', async () => {
  const { cwd, settingsFile } = world();
  for (const [part, what] of [['.group.r1', 'process-group record'], ['.group.r1.ok', 'go-ahead']]) {
    const calls = [];
    const rm = (f, o) => { if (f.endsWith(part)) { const e = new Error('no'); e.code = 'EPERM'; throw e; } return rmSync(f, o); };
    const run = runner({ spawn: sh(calls), rm, nonce: () => 'r1' });
    await assert.rejects(run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }),
      { message: `the install job's old ${what} can't be removed (EPERM)` });
    assert.equal(calls.length, 0, 'claude never started');
  }
});

test('L969: a real save-work job (M4\'s own script, run by node) makes the card\'s bundle in the outbox', async () => {
  const w = await pushWorld({ root: tempDir('orch-locked-') });
  writeFileSync(join(w.clone, 'app.txt'), 'changed\n');
  const settingsFile = join(tempDir('orch-locked-'), 'S-1.save.json'); writeFileSync(settingsFile, SAFE);
  const calls = [];
  const run = runner({ spawn: sh(calls), envOf: () => ({ PATH: process.env.PATH, HOME: process.env.HOME }), nonce: () => 'r1' });
  // As saveWorkPort binds it (L991 M1): in the copy's .git, under the save's settings, by their hash.
  const at = join(w.clone, '.git');
  const bound = (j) => run({ ...j, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: settingsSha(Buffer.from(SAFE)), cwd: at });
  const saved = await createSaveWork({ runLocked: bound })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(saved.bundle, join(w.outbox, bundleName('C-1')));
  assert.equal(spawnSync('git', ['bundle', 'verify', '-q', saved.bundle], { cwd: w.mirror, encoding: 'utf8' }).status, 0, 'git bundle verify');
  const cmd = calls[0].args.at(-1).slice(ASK.length);
  const g = groupFile({ cwd: at, job: 'save-work', sessionId: 'S-1', run: 'r1' });
  const inner = innerOf(calls[0].args);
  assert.equal(cmd, lockedCommand({ gfile: g, inner }), 'one plain command: the guard, the record, its go-ahead and the job (L1352)');
  assert.ok(inner.startsWith(`'${process.execPath}' '${join(JOBS_DIR, 'save-work.mjs')}' '`), inner);
  assert.ok(inner.endsWith(` '${jobFile({ cwd: at, job: 'save-work', sessionId: 'S-1' })}'`), 'of the copy, the job names the result file only');
  assert.equal(cmd.split(w.clone).length, 3, 'the command names the copy for the record and its go-ahead');
  assert.equal(inner.split(w.clone).length, 2, 'the job names it for the result file');
  assert.deepEqual(calls[0].opts.env, { PATH: process.env.PATH, HOME: process.env.HOME, ...bashWait(LOCKED_SAVE_MS) }, 'the Bash tool waits as long as the save may run');
  assert.equal(calls[0].opts.cwd, at, 'run in the copy\'s .git');
  assert.equal(existsSync(jobFile({ cwd: at, job: 'save-work', sessionId: 'S-1' })), false, 'the result file is removed');
  // L991 M1: the bundle was written in .git and moved; the outbox holds the bundle only, never a dot file, and no
  // partial is left in .git.
  assert.deepEqual(readdirSync(w.outbox).filter((n) => n.startsWith('.') || n.endsWith('.partial')), [], 'no dot file or partial in the outbox');
  assert.equal(existsSync(join(at, partialName('C-1'))), false, 'no partial left in .git');
  assert.deepEqual([g, ackFile(g)].filter((f) => existsSync(f)), [], 'no record or go-ahead left');
});

// #463 r1 M1 (L991): the same real job, its command run under macOS's sandbox (Seatbelt, which Claude Code's shell
// sandbox runs on) with only the writes the save's settings allow: the copy's .git (its folder), the outbox (no dot
// file, as the session's denyWrite has it), and /dev. runner-launch.test.mjs proves the rendered save file allows just
// these; here the whole job (reset, bundle, move) is shown to need nothing more, and the copy's files are untouched.
test('#463 r1 M1: a real save-work job, run inside the save\'s writes only, makes the card\'s bundle', {
  skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') ? 'needs macOS sandbox-exec' : false,
}, async () => {
  const w = await pushWorld({ root: tempDir('orch-locked-') });
  writeFileSync(join(w.clone, 'app.txt'), 'changed\n');
  const before = readFileSync(join(w.clone, 'app.txt'), 'utf8');
  const settingsFile = join(tempDir('orch-locked-'), 'S-1.save.json'); writeFileSync(settingsFile, SAFE);
  const at = join(w.clone, '.git');
  // The temp folder claude's sandbox gives its commands (TMPDIR, writable inside it): safe-git makes its throwaway git home
  // there. That claude sets one the job can write is a Mini proof (M4 README item 9, step 9).
  const tmp = realpathSync(tempDir('orch-locked-tmp-'));
  const [g, o] = [realpathSync(at), realpathSync(w.outbox)];
  const q = (x) => JSON.stringify(x);
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // #463 r2 (P11): of the outbox, only the card's bundle by its final name may be written, so a partial or any other
  // name made there, even for a moment, fails the save.
  const profile = `(version 1)(allow default)(deny file-write* (require-not (require-any (subpath ${q(g)}) (subpath ${q(o)}) (subpath ${q(tmp)}) (subpath "/dev"))))`
    + `(deny file-write* (regex ${q(`^${esc(o)}/(.*/)?\\.`)}))`
    + `(deny file-write* (require-all (regex ${q(`^${esc(o)}/`)}) (require-not (literal ${q(join(o, bundleName('C-1')))}))))`;
  const boxed = (bin, args, opts) => {
    const prompt = args.at(-1);
    assert.ok(prompt.startsWith(ASK), prompt);
    return childSpawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', prompt.slice(ASK.length)], opts);
  };
  const run = runner({ spawn: boxed, envOf: () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmp }) });
  const bound = (j) => run({ ...j, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: settingsSha(Buffer.from(SAFE)), cwd: at });
  const saved = await createSaveWork({ runLocked: bound })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(spawnSync('git', ['bundle', 'verify', '-q', saved.bundle], { cwd: w.mirror, encoding: 'utf8' }).status, 0, 'git bundle verify');
  assert.equal(readFileSync(join(w.clone, 'app.txt'), 'utf8'), before, 'the copy\'s files are untouched');
  // Control: the same sandbox refuses a write beside the .git, a dot file in the outbox, and any other name there.
  for (const f of [join(w.clone, 'x.txt'), join(w.outbox, '.x'), join(w.outbox, partialName('C-1')), join(w.outbox, 'x')]) {
    const out = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', `echo x > ${q(f)}`], { encoding: 'utf8' });
    assert.notEqual(out.status, 0, f); assert.equal(existsSync(f), false, f);
  }
});

test('L969: save-work believes no answer alone: the bundle must be a plain, non-empty file of the card in the outbox', async () => {
  const d = tempDir('orch-locked-');
  const outbox = join(d, 'outbox'); mkdirSync(outbox);
  const want = join(outbox, bundleName('C-1'));
  // The stand-in job writes what it is given (or nothing) as the bundle, then answers ok naming `bundle`.
  const save = (bundle, writes, card = 'C-1') => createSaveWork({ runLocked: async () => { if (writes) writes(); return { ok: true, bundle }; } })({ clone: join(d, 'clone'), mirror: join(d, 'm.git'), card, branch: `card/${card.toLowerCase()}`, outbox });
  const no = { ok: false, reason: 'the save-work job answered, but no bundle of the card is in the outbox' };
  assert.deepEqual(await save(want), no, 'none there');
  assert.deepEqual(await save(want, () => writeFileSync(want, '')), no, 'an empty one');
  assert.deepEqual(await save(join(outbox, 'other.bundle'), () => writeFileSync(want, 'x')), no, 'the answer names another file');
  assert.deepEqual(await save(want, () => writeFileSync(want, 'x')), { ok: true, bundle: want });
  // #456 runLocked self-review m1: a bundle left from before is removed first, so a job that writes none is refused.
  assert.ok(existsSync(want));
  assert.deepEqual(await save(want), no, 'an old bundle never passes as this save\'s');
  assert.equal(existsSync(want), false);
  const other = join(d, 'elsewhere'); writeFileSync(other, 'x');
  const link = join(outbox, bundleName('C-2'));
  assert.deepEqual(await save(link, () => symlinkSync(other, link), 'C-2'), no, 'a link');
  mkdirSync(want);
  assert.match((await save(want)).reason, /the card's old bundle can't be removed/, 'a folder in its place');
});

test('L969: every way runLocked can fail is a throw with a plain reason, and nothing is run for one found before claude', async () => {
  const { d, cwd, settingsFile, sha } = world();
  const calls = [];
  const run = runner({ spawn: sh(calls) });
  const base = { job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd };
  const link = join(d, 'link.json'); symlinkSync(settingsFile, link);
  const arr = join(d, 'arr.json'); writeFileSync(arr, '[]');
  // #463 r1 m3: settings that are JSON but not a lock-down.
  const file = (name, v) => { const f = join(d, name); writeFileSync(f, `${JSON.stringify(v)}\n`); return f; };
  const off = file('off.json', { sandbox: sandbox({ enabled: false }) });
  const open = file('open.json', { sandbox: sandbox({ failIfUnavailable: undefined }) });
  const out = file('out.json', { sandbox: sandbox({ allowUnsandboxedCommands: true }) });
  const none = file('none.json', {});
  const hosts = file('hosts.json', { sandbox: sandbox({ network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true } }) });
  const saveOf = (f) => ({ ...base, job: 'save-work', args: {}, settingsFile: f, settingsSha: settingsSha(readFileSync(f)) });
  for (const [more, why] of [
    [{ job: 'rm' }, /"rm" is not a lock-down job/],
    [{ sessionId: 'S 1' }, /names no session the Dispatcher makes/],
    [{ role: 'nobody' }, /no role profile for "nobody"/],
    [{ cwd: 'copy' }, /names no folder to run in/],
    [{ settingsFile: 'S-1.json' }, /names no settings file/],
    [{ settingsFile: link }, /settings file .* can't be read/],
    [{ settingsFile: join(d, 'gone.json') }, /settings file .* can't be read \(ENOENT\)/],
    [{ settingsFile: arr }, /is not a settings object/],
    [{ settingsFile: none }, /does not turn the sandbox on/],
    [{ settingsFile: off }, /does not turn the sandbox on/],
    [{ settingsFile: open }, /does not refuse to run without the sandbox/],
    [{ settingsFile: out }, /does not keep every command in the sandbox/],
    [{ job: 'save-work', args: {} }, /the save names no hash of its settings file/],
    [{ job: 'save-work', args: {}, settingsSha: 'f'.repeat(64) }, /is not the one the start wrote \(its hash differs\)/],
    [saveOf(hosts), /does not shut the network/],
    [{ command: '' }, /the product declares no one-line install command/],
    [{ command: 'a\nb' }, /the product declares no one-line install command/],
  ]) await assert.rejects(run({ ...base, ...more }), why, JSON.stringify(more));
  await assert.rejects(runner({ spawn: sh(calls), envOf: () => { throw new Error('no account'); } })(base), /no sign-in to run the install job with \(no account\)/);
  await assert.rejects(runner({ spawn: sh(calls), rm: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } })(base), /the install job's old result can't be removed \(EPERM\)/);
  assert.equal(calls.length, 0, 'claude was never started');
  assert.throws(() => lockedRunner({ claudeBin: 'claude', envOf: () => ({}) }), /needs the pinned claude's path/);
  assert.throws(() => lockedRunner({ claudeBin: '/x/claude' }), /needs the sign-in environment/);
  assert.deepEqual(LOCKED_JOBS, ['save-work', 'install']);
  // After claude: no result, a result that is not the job's form, claude failing to start.
  // Each runs the job's record and waits for the go-ahead first (#463 r2 M1), then writes what it is given in place of the job.
  const quiet = (write) => (bin, args, opts) => childSpawn('/bin/sh', ['-c', `${recordOf(args)} && ${write ? `printf '%s' '${write}' > '${jobFile({ cwd, job: wordsOf(args)[1].includes('-save-work-') ? 'save-work' : 'install', sessionId: 'S-1' })}'` : 'exit 0'}`], opts);
  await assert.rejects(runner({ spawn: quiet() })(base), /the install job's result was not written \(claude exited 0; ENOENT\)/);
  const big = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `${recordOf(args)} && head -c ${RESULT_MAX_BYTES + 1} /dev/zero > '${jobFile({ cwd, job: 'install', sessionId: 'S-1' })}'`], opts);
  await assert.rejects(runner({ spawn: big })(base), new RegExp(`the install job's result was not written \\(claude exited 0; over ${RESULT_MAX_BYTES} bytes\\)`), 'a result over the limit is refused unread');
  await assert.rejects(runner({ spawn: quiet('x') })(base), /the install's exit code is not a number \(x; claude exited 0\)/);
  const save = { ...base, job: 'save-work', args: {}, settingsSha: sha };
  await assert.rejects(runner({ spawn: quiet() })(save), /the save-work job's result was not written/);
  for (const bad of ['nope', '{"ok":"yes"}', '{"ok":false}', '[]']) await assert.rejects(runner({ spawn: quiet(bad) })(save), /the save-work job's result is not its answer/, bad);
  assert.deepEqual(await runner({ spawn: quiet('{"ok":false,"reason":"r"}') })(save), { ok: false, reason: 'r' });
  await assert.rejects(runner({ spawn: () => { throw new Error('ENOENT claude'); } })(base), /the install job did not finish inside the lock-down \(ENOENT claude\)/);
  assert.deepEqual(readdirSync(cwd), [], 'no result file is ever left');
});

test('L969: a job past its time limit is refused and its whole process group is killed', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  const run = runner({ spawn: sh(calls), ms: 400 });
  await assert.rejects(run({ job: 'install', command: 'sleep 30 & sleep 30', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /the install job did not finish inside the lock-down \(it did not finish in time\)/);
  const g = calls[0].child.pid;
  let alive = true;
  for (let n = 0; n < 50 && alive; n += 1) { try { process.kill(-g, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; } }
  assert.equal(alive, false, 'no process of the group is left');
});

test('#456 runLocked self-review M1: save-work has its own time limit, under the Dispatcher\'s save deadline; the install keeps its own', async () => {
  const { cwd, settingsFile, sha } = world();
  const calls = [];
  // Whatever the job, the stand-in claude runs past any short limit.
  const slow = (bin, args, opts) => { const child = childSpawn('/bin/sh', ['-c', 'sleep 30'], opts); calls.push(child); return child; };
  const run = runner({ spawn: slow, ms: 60_000, saveMs: 300 });
  const t = Date.now();
  await assert.rejects(run({ job: 'save-work', args: {}, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: sha, cwd }), /the save-work job did not finish inside the lock-down \(it did not finish in time\)/);
  assert.ok(Date.now() - t < 10_000, 'killed at saveMs, not at the install\'s ms');
  assert.throws(() => runner({ saveMs: LOCKED_SAVE_MS + 1 }), /save-work's limit can't pass/);
  for (const bad of [{ ms: 0 }, { saveMs: -1 }, { ms: 1.5 }]) assert.throws(() => runner(bad), /is not a time limit/, JSON.stringify(bad));
});

test('#463 r1 m1: save-work\'s limit and every delay around it fit inside the Dispatcher\'s save deadline', () => {
  assert.equal(LOCKED_SAVE_MS, 40_000);
  // Every delay, from its own home: the status cadence (a save's answer waits for the next write), one port wait (the
  // pass's one wait for its saves), the runner's sleep between passes, and the Dispatcher's poll.
  assert.equal(SAVE_DELAYS_MS, RUNNER_STATUS_EVERY_MS + RUNNER_PORT_MS + RUNNER_TICK_MS + ASK_POLL_MS);
  assert.ok(LOCKED_SAVE_MS + SAVE_DELAYS_MS < SAVE_DEADLINE_MS, `${LOCKED_SAVE_MS} + ${SAVE_DELAYS_MS} < ${SAVE_DEADLINE_MS}`);
});

test('#463 r1 m4: every lock-down claude loads no user, project or local settings file (--setting-sources \'\')', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  await runner({ spawn: sh(calls) })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd });
  const a = calls[0].args;
  const i = a.indexOf('--setting-sources');
  assert.ok(i > 0, a.join(' '));
  assert.equal(a[i + 1], '', 'no source at all');
  assert.ok(a.at(-1).startsWith(ASK), 'the prompt stays last');
});

test('#463 r1 m6: an environment given (the start\'s own) is used, and the sign-in is not read again', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  let read = 0;
  const run = runner({ spawn: sh(calls), envOf: () => { read += 1; return { PATH: '/usr/bin:/bin' }; } });
  await run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd, env: { PATH: '/bin', X: '1' } });
  assert.equal(read, 0, 'envOf is not called');
  assert.deepEqual(calls[0].opts.env, { PATH: '/bin', X: '1', ...bashWait(LOCKED_MS) });
  await run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd });
  assert.equal(read, 1, 'without one, the sign-in is read');
  await assert.rejects(run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd, env: null }), /no environment to run the install job with/);
});

test('#463 r1 m2: the job\'s process group, with its leader\'s start time, is told as soon as it runs; one whose start time can\'t be read is stopped', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  const told = [];
  const run = runner({ spawn: sh(calls), pidStartOf: () => '2000-01-01T00:00:00Z' });
  assert.deepEqual(await run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd, onGroup: (g) => told.push(g) }), { ok: true });
  const pid = calls[0].child.pid;
  assert.deepEqual(told, [{ pgid: pid, pid, pid_start: '2000-01-01T00:00:00Z' }], 'the stand-in runs the job in claude\'s own group: no second group is told');
  const slow = [];
  const blind = runner({ spawn: sh(slow), pidStartOf: () => null });
  await assert.rejects(blind({ job: 'install', command: 'sleep 30', sessionId: 'S-1', role: 'worker', settingsFile, cwd, onGroup: () => {} }), /its process group can't be kept \(its start time can't be read\), so it is stopped/);
  const g = slow[0].child.pid;
  let alive = true;
  for (let n = 0; n < 50 && alive; n += 1) { try { process.kill(-g, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; } }
  assert.equal(alive, false, 'the group is killed');
});

test('#463 r1 c3: a claude ended by a signal is refused, whatever result it left; claude\'s exit code is said beside a bad result', async () => {
  const { cwd, settingsFile } = world();
  const f = jobFile({ cwd, job: 'install', sessionId: 'S-1' });
  const killed = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `echo 0 > '${f}'; kill -9 $$`], opts);
  await assert.rejects(runner({ spawn: killed })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /the install job did not finish inside the lock-down \(claude was ended by a signal\)/);
  const three = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `${recordOf(args)} && printf x > '${f}'; exit 3`], opts);
  await assert.rejects(runner({ spawn: three })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /the install's exit code is not a number \(x; claude exited 3\)/);
  // A non-zero exit with the result written is not refused (--max-turns 1 may end claude in error after its one command).
  const late = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `${recordOf(args)} && echo 0 > '${f}'; exit 1`], opts);
  assert.deepEqual(await runner({ spawn: late })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: true });
});

test('#463 r1 m5 (P15): the job script never writes through a result file already there: exit 2, the file untouched', () => {
  const d = tempDir('orch-locked-');
  const out = join(d, 'result');
  writeFileSync(out, 'planted\n');
  const r = spawnSync(process.execPath, [join(JOBS_DIR, 'save-work.mjs'), Buffer.from('{}').toString('base64'), out], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(readFileSync(out, 'utf8'), 'planted\n');
  const fresh = join(d, 'fresh');
  const r2 = spawnSync(process.execPath, [join(JOBS_DIR, 'save-work.mjs'), Buffer.from('{}').toString('base64'), fresh], { encoding: 'utf8' });
  assert.equal(r2.status, 1, 'a refused save still writes its answer');
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).ok, false);
});

// #463 r1 self-review M1: a spawn that fails (no folder, no claude) has no pid; node's kill() of such a child signals pid 0,
// the caller's own process group. Run in a child that leads its own group, so a wrong kill ends only it.
test('#463 r1 self-review M1: a save whose claude can\'t start is refused with the spawn\'s reason, and the runner lives', () => {
  const d = tempDir('orch-locked-');
  const settingsFile = join(d, 'S-1.json'); writeFileSync(settingsFile, SAFE);
  const probe = join(d, 'probe.mjs');
  writeFileSync(probe, `import { lockedRunner, settingsSha } from ${JSON.stringify(new URL('./runner-locked.mjs', import.meta.url).href)};
const sha = settingsSha(Buffer.from(${JSON.stringify(SAFE)}));
for (const [claudeBin, cwd] of [['/bin/sh', ${JSON.stringify(join(d, 'no-such-folder'))}], [${JSON.stringify(join(d, 'no-such-claude'))}, ${JSON.stringify(d)}]]) {
  const run = lockedRunner({ claudeBin, envOf: () => ({ PATH: '/usr/bin:/bin' }) });
  const told = [];
  try { await run({ job: 'save-work', args: {}, sessionId: 'S-1', role: 'worker', settingsFile: ${JSON.stringify(settingsFile)}, settingsSha: sha, cwd, onGroup: (g) => told.push(g) }); console.log('ran'); }
  catch (e) { console.log('refused', told.length, e.code ?? e.message); }
}
console.log('runner survived');
`);
  const r = spawnSync('/bin/sh', ['-c', `exec '${process.execPath}' '${probe}'`], { encoding: 'utf8', detached: true, timeout: 60_000 });
  assert.equal(r.signal, null, `the probe was ended by ${r.signal}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /runner survived/, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^refused 0 .*ENOENT/, 'no folder: the spawn\'s own reason, and no group told');
  assert.match(lines[1], /^refused 0 .*ENOENT/, 'no claude');
});

// #463 r2 M1: claude's Bash tool runs each command in a process group of its own, so killing claude's group alone left
// the job running. The job's shell records itself and waits; the runner keeps that group, then lets it run.
test('#463 r2 M1: the job\'s own process group is kept before it runs, told with claude\'s, and killed at the time limit', async () => {
  const { cwd, settingsFile } = world();
  const calls = []; const told = [];
  const run = runner({ spawn: detachedClaude(calls), ms: 1_500 });
  const t0 = Date.now(); const okBefore = [];
  // Self-review m6: when the job's group is told, no go-ahead is written yet (the job has not run).
  const onGroup = (g) => { told.push(g); if (g.job) okBefore.push(readdirSync(cwd).filter((n) => n.endsWith('.ok'))); };
  await assert.rejects(run({ job: 'install', command: 'sleep 30', sessionId: 'S-1', role: 'worker', settingsFile, cwd, onGroup }), /the install job did not finish inside the lock-down \(it did not finish in time\)/);
  assert.deepEqual(okBefore, [[]], 'kept before the go-ahead');
  assert.ok(Date.now() - t0 < 10_000);
  const claude = calls[0].child.pid;
  assert.equal(told.length, 2, JSON.stringify(told));
  assert.equal(told[0].pgid, claude);
  assert.deepEqual(told[1].pgid, claude, 'the same record, claude\'s group first');
  const job = told[1].job;
  assert.ok(job && job.pgid !== claude && job.pid === job.pgid && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(job.pid_start), JSON.stringify(job));
  assert.equal(await goneSoon(claude), true, 'claude\'s group is gone');
  assert.equal(await goneSoon(job.pgid), true, 'the job\'s own group is gone too');
  assert.deepEqual(readdirSync(cwd), [], 'no record, go-ahead or result left');
});

// #463 r2 m6: a job still running once claude closed is a plain refusal of its own, and its group is killed.
test('#463 r2 m6: a job group still there after claude closes is refused and killed, whatever result it left', async () => {
  const { cwd, settingsFile } = world();
  const calls = []; const told = [];
  const f = jobFile({ cwd, job: 'install', sessionId: 'S-1' });
  const run = runner({ spawn: detachedClaude(calls, { leave: true }) });
  await assert.rejects(run({ job: 'install', command: `echo 0 > '${f}'; sleep 30`, sessionId: 'S-1', role: 'worker', settingsFile, cwd, onGroup: (g) => told.push(g) }),
    /the install job was still running after claude ended \(claude exited 0\); its process group was stopped/);
  assert.equal(await goneSoon(told[1].job.pgid), true, 'killed');
  // A job that ended with claude is not refused.
  const ok = runner({ spawn: detachedClaude([]) });
  assert.deepEqual(await ok({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: true });
});

test('#463 r2 M1: no job runs without the runner\'s go-ahead, and a record that can\'t be trusted stops it', async () => {
  const { cwd, settingsFile } = world();
  const ran = join(cwd, 'ran');
  // The go-ahead can't be written: the job never runs, and the save is refused.
  const calls = [];
  await assert.rejects(runner({ spawn: detachedClaude(calls), answer: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } })({ job: 'install', command: `touch '${ran}'`, sessionId: 'S-1', role: 'worker', settingsFile, cwd }),
    /its job's process group can't be kept \(the job's go-ahead can't be written \(EACCES\)\), so it is stopped/);
  assert.equal(existsSync(ran), false, 'never ran');
  // A record naming a process older than claude: refused, nothing run. The older process is a sleep in its own group,
  // started 1.5 s ahead (start times are whole seconds), never this test's own: if the check broke, the kill that follows
  // would reach the test runner's group and whatever started it, not just fail this test (lane 2 plant run, 12 Nov).
  const older = childSpawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 1_500));
    const recordPath = (args) => wordsOf(args)[1];
    const old = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `echo ${older.pid} > '${recordPath(args)}'; sleep 1; touch '${ran}'`], opts);
    await assert.rejects(runner({ spawn: old })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /names a process that did not start after claude/);
  } finally { try { process.kill(-older.pid, 'SIGKILL'); } catch { /* already gone */ } }
  // No record at all (a claude that ran something else): refused, whatever result it left.
  const f = jobFile({ cwd, job: 'install', sessionId: 'S-1' });
  await assert.rejects(runner({ spawn: (bin, args, opts) => childSpawn('/bin/sh', ['-c', `echo 0 > '${f}'`], opts) })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }),
    /the install job's process group was not recorded/);
  // The shell gives up waiting for a go-ahead that never comes, and the job does not run.
  // The guard records its own shell: run in place of the shell started (`exec`), the record is that pid, on every
  // system. (Without `exec`, whether `sh -c` runs its last command in place is the shell's choice: macOS's sh does,
  // Ubuntu's dash forks a child; CI on #666, 24 Nov 2026. The runner never needs the record to be the group's leader:
  // readGroupRecord keeps the recorded process's group. That is held just below, in the form claude's Bash tool runs it.)
  const g = join(cwd, 'g');
  const r = spawnSync('/bin/sh', ['-c', `exec ${lockedCommand({ gfile: g, inner: `touch '${ran}'` })}`], { encoding: 'utf8', timeout: JOB_ACK_WAIT_MS + 5_000 });
  assert.notEqual(r.status, 0); assert.equal(existsSync(ran), false);
  assert.ok(Number.isInteger(r.pid)); assert.equal(readFileSync(g, 'utf8').trim(), String(r.pid), 'its record is its own pid');
  // Run as one command inside a shell (no `exec`), as claude's Bash tool runs it: the record names a process in the
  // job's own group (the group of the shell started), whichever process the guard ended up in.
  const g2 = join(cwd, 'g2');
  const sh2 = childSpawn('/bin/sh', ['-c', `${lockedCommand({ gfile: g2, inner: `touch '${ran}'` })}; :`], { detached: true, stdio: 'ignore' });
  try {
    let text = '';
    for (let n = 0; n < 200 && !text.endsWith('\n'); n += 1) { await new Promise((ok) => setTimeout(ok, 25)); try { text = readFileSync(g2, 'utf8'); } catch { /* not yet */ } }
    const pid = Number(text.trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `a record was written (${JSON.stringify(text)})`);
    assert.equal(processInfo(pid).pgid, sh2.pid, 'the recorded process is in the job\'s own group');
    assert.equal(readGroupRecord(g2, { since: '2000-01-01T00:00:00Z' }).pgid, sh2.pid, 'and the runner reads that group from it');
  } finally { try { process.kill(-sh2.pid, 'SIGKILL'); } catch { /* already gone */ } }
  assert.equal(existsSync(ran), false, 'no go-ahead: never ran');
  // The record's form: none yet, half written, not a pid.
  const rec = join(cwd, 'rec');
  assert.equal(readGroupRecord(rec, { since: '2000-01-01T00:00:00Z' }), null);
  writeFileSync(rec, '123'); assert.equal(readGroupRecord(rec, { since: '2000-01-01T00:00:00Z' }), null, 'no line break yet: still being written');
  writeFileSync(rec, 'x\n'); assert.throws(() => readGroupRecord(rec, { since: '2000-01-01T00:00:00Z' }), /not in its form/);
  writeFileSync(rec, '4242\n');
  assert.deepEqual(readGroupRecord(rec, { since: '2026-01-01T00:00:00Z', info: () => ({ pgid: 4200, start: '2026-02-01T00:00:00Z' }), startOf: () => '2026-01-02T00:00:00Z' }), { pgid: 4200, pid: 4200, pid_start: '2026-01-02T00:00:00Z' }, 'the group\'s leader, not the shell');
  assert.throws(() => readGroupRecord(rec, { since: '2026-01-03T00:00:00Z', info: () => ({ pgid: 4200, start: '2026-02-01T00:00:00Z' }), startOf: () => '2026-01-02T00:00:00Z' }), /did not start after claude/, 'a leader older than claude');
  assert.throws(() => readGroupRecord(rec, { since: '2026-01-01T00:00:00Z', info: () => null }), /can't be read/);
});

test('#463 r2 m1: the Bash tool waits as long as the job may run; the install\'s limit is at most the lock-down\'s cap', () => {
  assert.equal(LOCKED_MS, 600_000, 'our own cap (#463 r3 m2): the Bash tool\'s wait is set to each run\'s limit, not a tool ceiling');
  assert.throws(() => runner({ ms: LOCKED_MS + 1 }), /the install's limit can't pass 600000 ms/);
});

// #463 r2 (P4): a child with no pid (a spawn that failed) is never signalled: node's kill of it would reach pid 0.
test('#463 r2 P4: a pid-less child is never signalled, even at the time limit', async () => {
  const kills = [];
  const fake = new EventEmitter(); fake.pid = undefined; fake.kill = (s) => kills.push(['child.kill', s]);
  await assert.rejects(runToEnd(() => fake, '/x', [], {}, 30, (g) => kills.push(['group', g]), () => true, () => kills.push(['onSpawn'])), /it did not finish in time/);
  assert.deepEqual(kills, []);
});

test('#463 r2 self-review m2: each run\'s record has a name of its own, so a shell left by an earlier run never takes its go-ahead', async () => {
  const { cwd, settingsFile } = world();
  const seen = [];
  const spy = (bin, args, opts) => { seen.push(wordsOf(args)[1]); return childSpawn('/bin/sh', ['-c', 'exit 0'], opts); };
  const run = runner({ spawn: spy });
  for (let i = 0; i < 2; i += 1) await assert.rejects(run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /result was not written/);
  // #666 r2 m1: each run's guard never started (no record), so each was tried once more, under a record of its own too.
  assert.equal(seen.length, 4); assert.equal(new Set(seen).size, 4);
  for (const f of seen) assert.match(f, /\.orch-job-install-S-1\.group\.[0-9a-f]{16}$/);
});

// #463 r2 plants (lane 2, 2026-11-12): at the time limit the stop itself ends the job's own group, not only claude's later
// close (a claude that never closes still has the job killed), and a job group that can't be told about is said.
test('#463 r2 M1: the time limit kills the job\'s own group at once, before claude closes; one that can\'t be told about is said', async () => {
  for (const [gone, kills, said] of [[() => false, [4242, 5151], false], [() => { throw new Error('EPERM'); }, [4242], true], [() => true, [4242], false]]) {
    const child = Object.assign(new EventEmitter(), { pid: 4242 });   // never closes
    const killed = [];
    const job = { everyMs: 5, read: () => ({ pgid: 5151, pid: 5151, pid_start: '2026-11-12T00:00:00Z' }), gone, found: () => {}, ack: () => {} };
    const err = await runToEnd(() => child, '/x/claude', [], {}, 60, (g) => killed.push(g), () => true, undefined, job).then(() => null, (e) => e);
    assert.match(err?.message ?? '', /it did not finish in time/);
    assert.deepEqual(killed, kills, 'the stop kills claude\'s group, then the job\'s when it is still there');
    assert.equal(/its job's own process group may still run/.test(err.message), said, err.message);
  }
});

// #463 r3 m4 (A4): a record first read at a stop or at claude's close is kept (found) but never answered: the job's shell
// is never told to go once the runner has stopped waiting for it.
test('#463 r3 m4 A4: a record first read at the time limit or at claude\'s close is found but never given its go-ahead', async () => {
  for (const end of ['close', 'time limit']) {
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    const calls = [];
    // The poll never fires before the end (everyMs far past the limit), so the record is first read by the end itself.
    const job = { everyMs: 3_600_000, read: () => ({ pgid: 5151, pid: 5151, pid_start: '2026-11-12T00:00:00Z' }), gone: () => true,
      found: (g) => calls.push(['found', g.pgid]), ack: () => calls.push(['ack']) };
    const p = runToEnd(() => child, '/x/claude', [], {}, end === 'close' ? 3_600_000 : 30, () => {}, () => false, undefined, job);
    if (end === 'close') setTimeout(() => child.emit('close', 0), 10);
    await p.then(() => null, (e) => e);
    assert.deepEqual(calls, [['found', 5151]], `${end}: found, never acked`);
  }
});

// #463 r3 m4 (A10): a save-work answer is refused when its job's group was never recorded, as the install's exit code is.
test('#463 r3 m4 A10: a save-work run that left a valid answer but no group record is refused', async () => {
  const { cwd, settingsFile, sha } = world();
  const f = jobFile({ cwd, job: 'save-work', sessionId: 'S-1' });
  const run = runner({ spawn: (bin, args, opts) => childSpawn('/bin/sh', ['-c', `echo '{"ok":true}' > '${f}'`], opts) });
  await assert.rejects(run({ job: 'save-work', args: {}, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: sha, cwd }),
    /the save-work job's process group was not recorded/);
});

// #463 r3 m4 (A8): guardedRun itself refuses a limit past the Bash tool wait it sets (not only lockedRunner's install limit).
test('#463 r3 m4 A8: guardedRun refuses a limit past LOCKED_MS, a zero and a non-integer before anything runs', async () => {
  for (const ms of [LOCKED_MS + 1, 0, 1.5]) {
    let spawned = false;
    await assert.rejects(guardedRun({ spawn: () => { spawned = true; }, claudeBin: '/x/claude', settingsFile: '/x/s.json', inner: 'true', cwd: '/x', env: {}, ms, gfile: '/x/g', label: 'the x job' }),
      /the x job's limit is not a time limit/);
    assert.equal(spawned, false, String(ms));
  }
});

test('L1351: a claude that fails says why: its result and stderr reach the refusal through pipes, keys hidden', async () => {
  const dir = tempDir('orch-said-');
  const json = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid API key fake' + '-key-SECRETSECRET'] });
  const r = await runToEnd(childSpawn, '/bin/sh', ['-c', `echo '{"type":"assistant"}'; echo '${json}'; echo "fatal: sign-in refused token ${'A'.repeat(16)} https://joe:hunter2@host/x" >&2; exit 1`], { cwd: dir }, 10_000, () => {}, () => false);
  assert.equal(r.exitCode, 1);
  assert.match(r.said, /^result error_during_execution: Invalid API key \[hidden\]; stderr: fatal: sign-in refused token \[hidden\] https:\/\/\[hidden\]@host\/x$/);
  assert.doesNotMatch(r.said, /SECRET|AAAA|hunter2/);
  assert.match(claudeEnd(r), /^claude exited 1, saying "result error_during_execution: /);
  assert.equal(claudeEnd({ exitCode: 1 }), 'claude exited 1'); // nothing said: as before
  const q = await runToEnd(childSpawn, '/bin/sh', ['-c', 'exit 0'], { cwd: dir }, 10_000, () => {}, () => false);
  assert.equal(q.said, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('L1351: a process that keeps claude\'s pipe open does not hold its close past the drain', async () => {
  const dir = tempDir('orch-said-');
  const t0 = Date.now();
  // The background sleep inherits the pipes (as a job that kept them would); claude's exit closes them after the drain.
  const r = await runToEnd(childSpawn, '/bin/sh', ['-c', 'sleep 30 & echo said >&2; exit 2'], { cwd: dir }, 20_000, (g) => { try { process.kill(-g, 'SIGKILL'); } catch {} }, () => true);
  assert.equal(r.exitCode, 2);
  assert.ok(Date.now() - t0 < 10_000, 'the close came after the drain, not the sleep');
  assert.match(r.said, /stderr: said/);
  rmSync(dir, { recursive: true, force: true });
});

test('L1351: sayable hides key-shaped runs, URL sign-ins and keeps one short printable line', () => {
  for (const k of [['made', 'up/with+slash', 'es/end9Q'].join(''), ['npm', 'shortABCDEF12'].join('_'), 'Bearer abc.def.' + 'q'.repeat(14) + 'Z9', ['ghp', 'x'.repeat(14) + 'W7'].join('_')]) assert.doesNotMatch(sayable(`x ${k} y`), new RegExp(k.slice(-6).replace(/[.+/]/g, '\\$&')), k);
  assert.equal(sayable('a\n\tb\u0007 "c"'), "a b 'c'");
  assert.equal(sayable('https://u:p@h/'), 'https://[hidden]@h/');
  assert.equal(sayable('https://u:p@ss@h/ and https://u:pa/ss@h/'), 'https://[hidden]@h/ and https://[hidden]@h/');
  assert.equal(sayable('k %2Fabc%3Dxyz1234567%2B'), 'k [hidden]');
  const long = sayable('x '.repeat(400) + 'END');
  assert.ok(long.length <= SAID_MAX + 1 && long.startsWith('…') && long.endsWith('END'));
});

test('L1351: resultWords reads the last result event; a strange subtype is not shown; no event is null', () => {
  assert.deepEqual(resultWords('{"type":"result","subtype":"error_max_turns","is_error":true}'), { sub: 'error_max_turns', why: '' });
  assert.deepEqual(resultWords('{"type":"result","subtype":"X; rm","is_error":true,"result":"boom"}'), { sub: 'a subtype not shown', why: 'boom' });
  assert.equal(resultWords('not json\n{"type":"assistant"}'), null);
  const h = hearing(); assert.equal(h.said(), ''); // never listened: nothing said
});

// ---- L1352: one plain command, allowed by one exact rule ----
// On the Mini (card R-S1-2) the install's claude, under the worker's dontAsk with only the product's commands allowed,
// was refused the compound line (subshell, loop, `&&`, `>`) it was told to run, so the result was never written.

// claude, stood in for, that also keeps the settings file it was started with (read as it starts, as the live proof does).
const keeping = (calls = []) => (bin, args, opts) => {
  const f = args[args.indexOf('--settings') + 1];
  const settings = JSON.parse(readFileSync(f, 'utf8'));
  const child = childSpawn('/bin/sh', ['-c', args.at(-1).slice(ASK.length)], opts);
  calls.push({ args, settingsFile: f, settings, child });
  return child;
};

test('L1352: every job\'s command is one plain command, and its settings allow exactly it: the rule and the command are one string', async () => {
  const { cwd, settingsFile, sha } = world();
  const calls = [];
  const run = runner({ spawn: keeping(calls) });
  assert.deepEqual(await run({ job: 'install', command: 'touch installed', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: true });
  // The real save-work.mjs runs here, with an empty row: whatever it answers, claude was started once.
  await run({ job: 'save-work', args: {}, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: sha, cwd }).catch(() => null);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const cmd = c.args.at(-1).slice(ASK.length);
    assert.equal(c.args.at(-1), `${LOCKED_PROMPT}${cmd}`, 'the prompt: the exact-string wording, then the command');
    assert.deepEqual(c.settings.permissions.allow, [`Bash(${cmd})`], 'exactly the command claude is given, byte for byte');
    assert.equal(c.settings.permissions.allow[0], lockedRule(cmd));
    // One plain command: the guard and four words, no joiner, redirection or line break outside the quotes.
    assert.match(cmd, /^\/bin\/sh '[^']+' '[^']+' '[^']+' \d+ '[A-Za-z0-9+/=]+'$/, cmd);
    assert.equal(wordsOf(c.args)[0], GUARD);
    assert.equal(wordsOf(c.args)[2], ackFile(wordsOf(c.args)[1]));
    // Everything else is the session's settings as they were.
    const { permissions: _p, ...rest } = c.settings; const { permissions: _q, ...was } = JSON.parse(SAFE);
    assert.deepEqual(rest, was);
    assert.equal(existsSync(c.settingsFile), false, 'removed after');
  }
  assert.equal(readFileSync(settingsFile, 'utf8'), SAFE, 'the settings file itself never holds the rule');
});

test('L1352: lockedCommand refuses what can\'t be one plain command; lockedRule refuses what render-settings would', () => {
  assert.throws(() => lockedCommand({ gfile: '/a/g', inner: 'a\nb' }), /not one line/);
  assert.throws(() => lockedCommand({ gfile: '/a/g', inner: ' ' }), /not one line/);
  assert.throws(() => lockedCommand({ gfile: 'g', inner: 'true' }), /no process-group record/);
  assert.throws(() => lockedCommand({ gfile: "/a/it's", inner: 'true' }), /quote/);
  for (const bad of ['true; rm -rf x', 'a && b', 'a | b', 'a > b', 'a\nb', '$(x)', ' a']) assert.throws(() => lockedRule(bad), /not one exact command/, bad);
  // Any job at all, joiners and quotes included, goes through as plain base64 letters.
  const c = lockedCommand({ gfile: '/a/g', inner: "( npm ci && echo '*?' | tee x ); /bin/echo $? > '/a/r'" });
  assert.equal(lockedRule(c), `Bash(${c})`);
  assert.equal(lockedJobOf(c), "( npm ci && echo '*?' | tee x ); /bin/echo $? > '/a/r'", 'read back for the live proofs');
  for (const not of ['npm ci', `${c}; x`, c.replace('guard.sh', 'g.sh')]) assert.equal(lockedJobOf(not), null, not);
});

test('L1352: jobSettings adds only the rule, to the bytes it checked (the save\'s hash, its shut network); the file is the job\'s own', () => {
  const { d, settingsFile, sha } = world();
  const more = join(d, 'more.json');
  const v = { permissions: { defaultMode: 'dontAsk', allow: ['Bash(true)'], deny: ['Read(//x/**)'] }, sandbox: sandbox(), hooks: { PreToolUse: [] } };
  writeFileSync(more, `${JSON.stringify(v)}\n`);
  const cmd = lockedCommand({ gfile: '/a/g', inner: 'true' });
  assert.deepEqual(JSON.parse(jobSettings(more, cmd)), { ...v, permissions: { ...v.permissions, allow: ['Bash(true)', `Bash(${cmd})`] } });
  assert.deepEqual(JSON.parse(jobSettings(settingsFile, cmd, { sha, noNetwork: true })).permissions.allow, [`Bash(${cmd})`]);
  assert.throws(() => jobSettings(settingsFile, cmd, { sha: 'f'.repeat(64) }), /its hash differs/);
  // The bytes checked are the bytes used: one read only.
  let reads = 0;
  jobSettings(settingsFile, cmd, { sha, read: (f) => { reads += 1; return readFileSync(f); } });
  assert.equal(reads, 1);
  assert.throws(() => jobSettings(join(d, 'gone.json'), cmd), /can't be read \(ENOENT\)/);
  const odd = join(d, 'odd.json'); writeFileSync(odd, JSON.stringify({ permissions: { allow: 'x' }, sandbox: sandbox() }));
  assert.throws(() => jobSettings(odd, cmd), /allow list is not a list/);
  assert.equal(jobSettingsFile('/s/S-1.save.json', 'ab12'), '/s/S-1.save.job-ab12.json');
  assert.throws(() => jobSettingsFile('/s/S-1.json', '../x'), /no plain run name/);
});

test('L1352: a job whose settings can\'t be used, or whose own settings file can\'t be written, never starts claude', async () => {
  const { d, cwd, settingsFile } = world();
  const calls = [];
  const g = groupFile({ cwd, job: 'baseline', sessionId: 'S-1', run: 'r1' });
  const base = { spawn: keeping(calls), claudeBin: '/x/claude', inner: 'true', cwd, env: {}, ms: 1_000, gfile: g, label: 'the baseline' };
  const off = join(d, 'off.json'); writeFileSync(off, JSON.stringify({ sandbox: sandbox({ enabled: false }) }));
  await assert.rejects(guardedRun({ ...base, settingsFile: off }), (e) => e.beforeRun === true && /the baseline can't be run inside the lock-down \(.*does not turn the sandbox on\)/.test(e.message));
  await assert.rejects(guardedRun({ ...base, settingsFile: join(d, 'x.txt') }), (e) => e.beforeRun === true && /names no settings file/.test(e.message));
  await assert.rejects(guardedRun({ ...base, settingsFile, write: () => { throw Object.assign(new Error('x'), { code: 'EEXIST' }); } }),
    (e) => e.beforeRun === true && e.message === 'the baseline\'s own settings file can\'t be written (EEXIST)');
  assert.equal(calls.length, 0);
});

test('L1352: the guard records its own pid (in the group the Bash tool made, as readGroupRecord reads it), waits for the go-ahead, then runs the job, whose exit code is written', async () => {
  const d = tempDir('orch-locked-');
  const g = join(d, 'job.group.r1'); const res = join(d, 'res');
  // Run as claude's Bash tool runs it: detached, in a group of its own.
  const child = childSpawn('/bin/sh', ['-c', lockedCommand({ gfile: g, inner: `( exit 7 ); /bin/echo $? > '${res}'` })], { cwd: d, detached: true, stdio: 'ignore' });
  // Until the record is whole (its line break written), as readGroupRecord waits: the file is made before its pid is in it.
  const whole = () => existsSync(g) && readFileSync(g, 'utf8').endsWith('\n');
  for (let n = 0; n < 1_000 && !whole(); n += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(existsSync(res), false, 'nothing runs before the go-ahead');
  const pid = Number(readFileSync(g, 'utf8').trim());
  const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(Number(ps.stdout.trim()), child.pid, 'the recorded process is in the group the Bash tool made');
  assert.equal(readGroupRecord(g, { since: '2000-01-01T00:00:00Z' }).pgid, child.pid);
  writeFileSync(ackFile(g), '');
  assert.equal(await new Promise((r) => child.on('exit', r)), 0);
  assert.equal(readFileSync(res, 'utf8'), '7\n', 'the job\'s own exit code');
  // A record already there is never written through (noclobber): the job does not run.
  const res2 = join(d, 'res2');
  const again = spawnSync('/bin/sh', ['-c', lockedCommand({ gfile: g, inner: `touch '${res2}'` })], { encoding: 'utf8' });
  assert.equal(again.status, 65); assert.equal(existsSync(res2), false);
  assert.equal(spawnSync('/bin/sh', [GUARD, g], { encoding: 'utf8' }).status, 64, 'four words or nothing');
});

test('L1352: the worker\'s Bash hooks let every job\'s command through (install, save-work in .git, the baseline)', () => {
  const d = tempDir('orch-locked-');
  const outbox = join(d, 'outbox'); const copy = join(d, 'copy'); mkdirSync(outbox); mkdirSync(join(copy, '.git'), { recursive: true });
  const snapshot = join(d, 'rules.json');
  writeFileSync(snapshot, makeSnapshot({ production: { env_files: [join(d, 'prod', 'settings.production')], programs: ['fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(d, 'keys')] } }));
  const hooksDir = join(JOBS_DIR, '..', 'hooks');
  const at = join(copy, '.git');
  const jobs = [
    [copy, lockedCommand({ gfile: groupFile({ cwd: copy, job: 'install', sessionId: 'S-1', run: 'ab' }), inner: `( npm ci ); /bin/echo $? > '${jobFile({ cwd: copy, job: 'install', sessionId: 'S-1' })}'` })],
    [at, lockedCommand({ gfile: groupFile({ cwd: at, job: 'save-work', sessionId: 'S-1', run: 'ab' }), inner: `'${process.execPath}' '${join(JOBS_DIR, 'save-work.mjs')}' '${Buffer.from('{"card":"C-1"}').toString('base64')}' '${jobFile({ cwd: at, job: 'save-work', sessionId: 'S-1' })}'` })],
    [copy, lockedCommand({ gfile: groupFile({ cwd: copy, job: 'baseline', sessionId: 'S-1', run: 'ab' }), inner: `( npm test ); /bin/echo $? > '${join(copy, '.orch-baseline-S-1')}'` })],
  ];
  const bashHooks = Object.entries(POLICY_HOOKS).filter(([, m]) => m === '*' || m.split('|').includes('Bash')).map(([n]) => n);
  assert.deepEqual(bashHooks.sort(), ['merge-guard', 'no-verify-block', 'production-write-guard', 'secret-file-block']);
  // Near misses are still refused: the shape is read whole, or not let through.
  const [, one] = jobs[0];
  for (const near of [`${one}; touch x`, `${one} && touch x`, one.replace("/bin/sh '", "sh '"), one.replace('/jobs/guard.sh', '/jobs/other.sh'), one.replace(GUARD, join(copy, 'modules', 'M4-workshop', 'jobs', 'guard.sh')), one.replace(".ok'", ".no'"), `${one.slice(0, -1)}$(x)'`]) {
    assert.equal(LOCKED_JOB_COMMAND.test(near), false, near);
    assert.notEqual(unreadable(near), null, near);
  }
  for (const [cwd, command] of jobs) {
    assert.ok(LOCKED_JOB_COMMAND.test(command), command);
    for (const name of bashHooks) {
      const r = spawnSync(process.execPath, [join(hooksDir, `${name}.mjs`), '--role', 'worker', '--outbox', outbox, '--snapshot', snapshot, '--kinds', outboxKindsFor('worker').join(','), '--copy', copy],
        { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8', timeout: 10_000 });
      assert.equal(r.status, 0, `${name} on ${command}: ${r.stderr}`);
    }
  }
});

test('L1352 audit: the hooks let through only orchestrate\'s own guard, found from where they run', async () => {
  const d = realpathSync(tempDir('orch-guardpath-'));
  try {
    const lib = join(JOBS_DIR, '..', 'hooks', 'lib.mjs');
    // Installed: the hooks copied to <install>/hooks, the jobs at <install>/modules/M4-workshop/jobs (setup/layout.mjs).
    const inst = join(d, 'install');
    mkdirSync(join(inst, 'hooks'), { recursive: true }); mkdirSync(join(inst, 'modules', 'M4-workshop', 'jobs'), { recursive: true });
    writeFileSync(join(inst, 'hooks', 'lib.mjs'), readFileSync(lib));
    writeFileSync(join(inst, 'modules', 'M4-workshop', 'jobs', 'guard.sh'), readFileSync(GUARD));
    const m = await import(join(inst, 'hooks', 'lib.mjs'));
    const guard = join(inst, 'modules', 'M4-workshop', 'jobs', 'guard.sh');
    assert.equal(m.GUARD_PATH, guard);
    const gfile = groupFile({ cwd: join(d, 'copy'), job: 'install', sessionId: 'S-1', run: 'ab' });
    assert.equal(m.LOCKED_JOB_COMMAND.test(lockedCommand({ gfile, inner: 'npm ci', guard })), true);
    assert.equal(m.LOCKED_JOB_COMMAND.test(lockedCommand({ gfile, inner: 'npm ci' })), false, 'another orchestrate\'s guard is not this one\'s');
    // No guard where the hooks run: nothing is let through, so the hooks refuse it as they refuse any `sh` line.
    const bare = join(d, 'bare', 'hooks'); mkdirSync(bare, { recursive: true }); writeFileSync(join(bare, 'lib.mjs'), readFileSync(lib));
    const b = await import(join(bare, 'lib.mjs'));
    assert.equal(b.GUARD_PATH, null);
    assert.equal(b.LOCKED_JOB_COMMAND.test(lockedCommand({ gfile, inner: 'npm ci', guard: join(d, 'bare', 'jobs', 'guard.sh') })), false);
    assert.notEqual(b.unreadable(lockedCommand({ gfile, inner: 'npm ci', guard: join(d, 'bare', 'jobs', 'guard.sh') })), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// #666 r2 M1, m2: the installed layout as the updater makes it. Each version is `orchestrate.v-<commit>/orchestrate`, its
// hooks copied to `<version>/hooks` and its jobs at `<version>/modules/M4-workshop/jobs`; the install's link names the
// newest. A session's settings name its hooks folder (a version's real folder, realRenderPaths, or through the link).
const versions = (d, ...names) => {
  const at = {};
  for (const v of names) {
    const root = join(d, `orchestrate.v-${v}`, 'orchestrate');
    installHooks(join(root, 'hooks'), HOOKS_SOURCE);
    mkdirSync(join(root, 'modules', 'M4-workshop', 'jobs'), { recursive: true });
    writeFileSync(join(root, 'modules', 'M4-workshop', 'jobs', 'guard.sh'), readFileSync(GUARD));
    at[v] = root;
  }
  return at;
};
const hookSettings = (hooksDir) => ({ hooks: { PreToolUse: Object.keys(POLICY_HOOKS).map((n) => ({ matcher: '*', hooks: [{ type: 'command', command: `${process.execPath} ${join(hooksDir, `${n}.mjs`)} --role worker` }] })) } });
// The four Bash hooks, run as claude runs them (node <hooks folder>/<name>.mjs …), on one command: each one's exit.
const hooksOn = (hooksDir, command, cwd, d) => {
  const outbox = join(d, 'outbox'); mkdirSync(outbox, { recursive: true });
  const snapshot = join(d, 'rules.json');
  writeFileSync(snapshot, makeSnapshot({ production: { env_files: [join(d, 'prod', 'settings.production')], programs: ['fakedb'], hosts: ['db.prod.example.net'] }, secrets: { paths: [join(d, 'keys')] } }));
  return ['merge-guard', 'no-verify-block', 'production-write-guard', 'secret-file-block'].map((name) => spawnSync(process.execPath,
    [join(hooksDir, `${name}.mjs`), '--role', 'worker', '--outbox', outbox, '--snapshot', snapshot, '--kinds', outboxKindsFor('worker').join(','), '--copy', cwd],
    { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8', timeout: 10_000 }).status);
};

test('#666 r2 m2: the real installed layout: through the install\'s link, the runner\'s guard is the one the hooks let through', () => {
  const d = realpathSync(tempDir('orch-layout-'));
  try {
    const at = versions(d, 'abc');
    const link = join(d, 'orchestrate'); symlinkSync(at.abc, link);
    const cwd = join(d, 'copy'); mkdirSync(cwd);
    const guard = jobGuard(hookSettings(join(link, 'hooks')));
    assert.equal(guard, join(at.abc, 'modules', 'M4-workshop', 'jobs', 'guard.sh'), 'the version\'s own guard, by its real path');
    assert.equal(guardBesideHooks(join(link, 'hooks')), guard, 'the one function both sides use');
    const command = lockedCommand({ gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'ab' }), inner: 'npm ci', guard });
    assert.deepEqual(hooksOn(join(link, 'hooks'), command, cwd, d), [0, 0, 0, 0], 'the four Bash hooks, run through the link, let it through');
    assert.notDeepEqual(hooksOn(join(link, 'hooks'), lockedCommand({ gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'ab' }), inner: 'npm ci' }), cwd, d), [0, 0, 0, 0],
      'another orchestrate\'s guard (this checkout\'s) is refused');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#666 r2 M1: a session carried over an update gets its own version\'s guard, which its own hooks let through', () => {
  const d = realpathSync(tempDir('orch-skew-'));
  try {
    const at = versions(d, 'abc', 'def');
    const link = join(d, 'orchestrate'); symlinkSync(at.def, link);   // updated: the link names v-def, the runner restarted there
    const cwd = join(d, 'copy'); mkdirSync(cwd);
    const old = join(at.abc, 'hooks');                                 // the carried-over session's settings: v-abc's hooks
    const gfile = groupFile({ cwd, job: 'save-work', sessionId: 'S-1', run: 'ab' });
    // Before: the runner named the guard beside its own code (v-def's), which v-abc's hooks refuse.
    const runners = lockedCommand({ gfile, inner: 'true', guard: guardBesideHooks(join(link, 'hooks')) });
    assert.notDeepEqual(hooksOn(old, runners, cwd, d), [0, 0, 0, 0], 'v-def\'s guard is refused by v-abc\'s hooks');
    // After: the guard beside the hooks folder the job's settings name.
    const guard = jobGuard(hookSettings(old));
    assert.equal(guard, join(at.abc, 'modules', 'M4-workshop', 'jobs', 'guard.sh'));
    assert.deepEqual(hooksOn(old, lockedCommand({ gfile, inner: 'true', guard }), cwd, d), [0, 0, 0, 0]);
    // And a new session's, on v-def's hooks (through the link or its real folder), gets v-def's.
    assert.equal(jobGuard(hookSettings(join(link, 'hooks'))), join(at.def, 'modules', 'M4-workshop', 'jobs', 'guard.sh'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('#666 r2 M1: jobGuard: no hooks, the runner\'s own guard; hooks in two folders, a hook not in the runner\'s form, or no guard beside: refused', () => {
  const d = realpathSync(tempDir('orch-jobguard-'));
  try {
    const at = versions(d, 'abc', 'def');
    assert.equal(jobGuard({ permissions: {} }), GUARD);
    const two = hookSettings(join(at.abc, 'hooks')); two.hooks.PreToolUse.push(hookSettings(join(at.def, 'hooks')).hooks.PreToolUse[0]);
    assert.throws(() => jobGuard(two), /hooks in more than one folder/);
    assert.throws(() => jobGuard({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'merge-guard --role worker' }] }] } }), /not in the runner's form/);
    assert.throws(() => jobGuard({ hooks: [] }), /not an object/);
    const bare = join(d, 'bare', 'hooks'); mkdirSync(bare, { recursive: true });
    assert.throws(() => jobGuard(hookSettings(bare)), /no lock-down guard beside its hooks folder/);
    // guardedRun refuses before claude starts, naming why.
    const settingsFile = join(d, 'S-1.json'); writeFileSync(settingsFile, `${JSON.stringify({ ...hookSettings(bare), permissions: {}, sandbox: sandbox() })}\n`);
    return assert.rejects(guardedRun({ spawn: () => { throw new Error('started'); }, claudeBin: '/x/claude', settingsFile, inner: 'true', profile: DESIGN_PROFILES.worker, cwd: d, env: {}, ms: 1000, label: 'the job',
      gfile: groupFile({ cwd: d, job: 'install', sessionId: 'S-1', run: 'ab' }) }), (e) => e.beforeRun === true && /no lock-down guard beside its hooks folder/.test(e.message));
  } finally { setTimeout(() => rmSync(d, { recursive: true, force: true }), 2000); }
});

test('#666 r2 m1: a claude that ended its turn without running the command is tried once more, fresh; never twice, never after the guard started', async () => {
  const { d, cwd, settingsFile } = world();
  try {
    // First claude ends at once (no tool call: no record); the second runs the command as the Bash tool does.
    for (const [skips, recorded, spawns] of [[1, true, 2], [2, false, 2]]) {
      const seen = []; let n = 0;
      const real = detachedClaude();
      const spawn = (bin, args, opts) => { seen.push({ g: wordsOf(args)[1], s: args[args.indexOf('--settings') + 1] }); n += 1;
        return n <= skips ? childSpawn('/bin/sh', ['-c', 'exit 0'], opts) : real(bin, args, opts); };
      const res = join(cwd, `res-${skips}`);
      const r = await guardedRun({ spawn, claudeBin: '/x/claude', settingsFile, inner: `/bin/echo 0 > '${res}'`, profile: DESIGN_PROFILES.worker, cwd, env: { PATH: '/usr/bin:/bin' }, ms: 20_000,
        gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'ab' }), label: 'the job' });
      assert.equal(seen.length, spawns, 'once more at most');
      assert.notEqual(seen[0].g, seen[1].g, 'a fresh record'); assert.notEqual(seen[0].s, seen[1].s, 'a fresh settings file');
      assert.match(seen[1].g, /\.orch-job-install-S-1\.group\.[0-9a-f]{16}$/);
      assert.equal(r.job?.recorded === true, recorded);
      assert.equal(existsSync(res), recorded, 'the job ran on the retry, and only then');
    }
    // The guard started (its record written) but the job's exit was never written: no retry.
    const seen = [];
    const spawn = (bin, args, opts) => { seen.push(1); return detachedClaude()(bin, [...args.slice(0, -1), `${ASK}${recordOf(args)}`], opts); };
    const r = await guardedRun({ spawn, claudeBin: '/x/claude', settingsFile, inner: 'true', profile: DESIGN_PROFILES.worker, cwd, env: { PATH: '/usr/bin:/bin' }, ms: 20_000,
      gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'cd' }), label: 'the job' });
    assert.equal(seen.length, 1); assert.equal(r.job.recorded, true);
    // A claude past its time limit: no retry either.
    let starts = 0;
    const hang = (bin, args, opts) => { starts += 1; return childSpawn('/bin/sleep', ['5'], opts); };
    await assert.rejects(guardedRun({ spawn: hang, claudeBin: '/x/claude', settingsFile, inner: 'true', profile: DESIGN_PROFILES.worker, cwd, env: { PATH: '/usr/bin:/bin' }, ms: 300,
      gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'ef' }), label: 'the job' }), /did not finish in time/);
    assert.equal(starts, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A real claude (L1352), as the Mini runs it but with no hooks: dontAsk, the sandbox on, only the product's command
// allowed in the settings, --max-turns 1, the exact-string prompt. It calls the model, so it runs only when asked:
// ORCH_LIVE_CLAUDE=1 and a claude on the PATH (or ORCH_LIVE_CLAUDE_BIN). It proves the claude that runs it, not the pin.
const liveClaude = (() => {
  if (process.env.ORCH_LIVE_CLAUDE !== '1') return null;
  const bin = process.env.ORCH_LIVE_CLAUDE_BIN ?? spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  return bin && existsSync(bin) ? realpathSync(bin) : null;
})();
test('L1352 live: a real claude under dontAsk runs the job\'s one command, so its group is recorded and its exit code written', {
  skip: liveClaude ? false : 'set ORCH_LIVE_CLAUDE=1 with a claude on the PATH (it calls the model)',
  timeout: 180_000,
}, async () => {
  const d = realpathSync(tempDir('orch-locked-'));
  const cwd = join(d, 'copy'); mkdirSync(cwd);
  const settingsFile = join(d, 'S-1.json');
  writeFileSync(settingsFile, `${JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: ['Bash(true)'], deny: [], ask: [] }, sandbox: sandbox() })}\n`);
  const res = join(cwd, 'res');
  const told = [];
  const r = await guardedRun({ spawn: childSpawn, claudeBin: liveClaude, settingsFile, inner: `( true ); /bin/echo $? > '${res}'`, profile: DESIGN_PROFILES.worker, cwd,
    env: { ...process.env }, ms: 120_000, gfile: groupFile({ cwd, job: 'install', sessionId: 'S-1', run: 'live1' }), label: 'the live job', onGroup: (g) => told.push(g) });
  assert.equal(jobGroupProblem(r, 'the live job'), null, claudeEnd(r));
  assert.equal(readFileSync(res, 'utf8'), '0\n', claudeEnd(r));
  assert.ok(told.some((g) => g.job), 'the job\'s own group was kept');
});

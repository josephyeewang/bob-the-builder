// runner-locked.mjs (L969): the lock-down runner. claude is stood in for by /bin/sh running the one command claude is
// asked to run, so what is proven here is everything around claude: the command each job gets, the result file, every
// refusal, the time limit's group kill, and a real save-work job (M4's own script, node, git) making a bundle in the
// outbox. That claude runs it under dontAsk with the worker hooks, inside the sandbox, is a Mini proof (M4 README,
// "Live proofs still to run", item 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pushWorld } from '../modules/M4-workshop/git/push-world.test-helper.mjs';
import { createSaveWork } from '../modules/M4-workshop/git/save-work.mjs';
import { bundleName } from '../modules/M4-workshop/git/push.mjs';
import { JOBS_DIR, LOCKED_JOBS, LOCKED_SAVE_MS, RESULT_MAX_BYTES, SAVE_DELAYS_MS, jobFile, lockedRunner, settingsSha } from './runner-locked.mjs';
import { SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { partialName } from '../modules/M4-workshop/git/save-work.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_TICK_MS } from './runner-loop.mjs';
import { ASK_POLL_MS } from './owner-asks.mjs';

const ASK = 'Run exactly this shell command once and report its exit code: ';
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

test('L969: the install job runs the declared command in the copy under the session settings; exit 0 is ok, any other is a refusal', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  const run = runner({ spawn: sh(calls) });
  assert.deepEqual(await run({ job: 'install', command: 'touch installed', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: true });
  assert.ok(existsSync(join(cwd, 'installed')), 'ran in the copy');
  assert.equal(calls[0].bin, '/x/claude');
  assert.equal(calls[0].args[calls[0].args.indexOf('--settings') + 1], settingsFile, 'under the session\'s settings file');
  assert.equal(calls[0].opts.cwd, cwd); assert.equal(calls[0].opts.detached, true, 'it leads its own group');
  assert.deepEqual(calls[0].opts.env, { PATH: '/usr/bin:/bin' }, 'the sign-in environment, as envOf gave it');
  assert.deepEqual(await run({ job: 'install', command: 'exit 3', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), { ok: false, reason: 'the install exited 3' });
  assert.deepEqual(readdirSync(cwd), ['installed'], 'no result file left');
});

test('L969: a real save-work job (M4\'s own script, run by node) makes the card\'s bundle in the outbox', async () => {
  const w = await pushWorld({ root: tempDir('orch-locked-') });
  writeFileSync(join(w.clone, 'app.txt'), 'changed\n');
  const settingsFile = join(tempDir('orch-locked-'), 'S-1.save.json'); writeFileSync(settingsFile, SAFE);
  const calls = [];
  const run = runner({ spawn: sh(calls), envOf: () => ({ PATH: process.env.PATH, HOME: process.env.HOME }) });
  // As saveWorkPort binds it (L991 M1): in the copy's .git, under the save's settings, by their hash.
  const at = join(w.clone, '.git');
  const bound = (j) => run({ ...j, sessionId: 'S-1', role: 'worker', settingsFile, settingsSha: settingsSha(Buffer.from(SAFE)), cwd: at });
  const saved = await createSaveWork({ runLocked: bound })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(saved.bundle, join(w.outbox, bundleName('C-1')));
  assert.equal(spawnSync('git', ['bundle', 'verify', '-q', saved.bundle], { cwd: w.mirror, encoding: 'utf8' }).status, 0, 'git bundle verify');
  const cmd = calls[0].args.at(-1).slice(ASK.length);
  assert.ok(cmd.startsWith(`'${process.execPath}' '${join(JOBS_DIR, 'save-work.mjs')}' '`), cmd);
  assert.ok(cmd.endsWith(` '${jobFile({ cwd: at, job: 'save-work', sessionId: 'S-1' })}'`), 'of the copy, only the result file is named');
  assert.equal(cmd.split(w.clone).length, 2, 'the copy is named once, for the result file');
  assert.equal(calls[0].opts.cwd, at, 'run in the copy\'s .git');
  assert.equal(existsSync(jobFile({ cwd: at, job: 'save-work', sessionId: 'S-1' })), false, 'the result file is removed');
  // L991 M1: the bundle was written in .git and moved; the outbox holds the bundle only, never a dot file, and no
  // partial is left in .git.
  assert.deepEqual(readdirSync(w.outbox).filter((n) => n.startsWith('.') || n.endsWith('.partial')), [], 'no dot file or partial in the outbox');
  assert.equal(existsSync(join(at, partialName('C-1'))), false, 'no partial left in .git');
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
  const profile = `(version 1)(allow default)(deny file-write* (require-not (require-any (subpath ${q(g)}) (subpath ${q(o)}) (subpath ${q(tmp)}) (subpath "/dev"))))`
    + `(deny file-write* (regex ${q(`^${esc(o)}/(.*/)?\\.`)}))`;
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
  // Control: the same sandbox refuses a write beside the .git, and a dot file in the outbox.
  for (const f of [join(w.clone, 'x.txt'), join(w.outbox, '.x')]) {
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
  const quiet = (write) => (bin, args, opts) => childSpawn('/bin/sh', ['-c', write ? `printf '%s' '${write}' > '${jobFile({ cwd, job: args.at(-1).includes('save-work.mjs') ? 'save-work' : 'install', sessionId: 'S-1' })}'` : 'exit 0'], opts);
  await assert.rejects(runner({ spawn: quiet() })(base), /the install job's result was not written \(claude exited 0; ENOENT\)/);
  const big = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `head -c ${RESULT_MAX_BYTES + 1} /dev/zero > '${jobFile({ cwd, job: 'install', sessionId: 'S-1' })}'`], opts);
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
  assert.deepEqual(calls[0].opts.env, { PATH: '/bin', X: '1' });
  await run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd });
  assert.equal(read, 1, 'without one, the sign-in is read');
  await assert.rejects(run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd, env: null }), /no environment to run the install job with/);
});

test('#463 r1 m2: the job\'s process group, with its leader\'s start time, is told as soon as it runs; one whose start time can\'t be read is stopped', async () => {
  const { cwd, settingsFile } = world();
  const calls = [];
  const told = [];
  const run = runner({ spawn: sh(calls), pidStartOf: (pid) => `start-of-${pid}` });
  assert.deepEqual(await run({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd, onGroup: (g) => told.push(g) }), { ok: true });
  const pid = calls[0].child.pid;
  assert.deepEqual(told, [{ pgid: pid, pid, pid_start: `start-of-${pid}` }]);
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
  const three = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `printf x > '${f}'; exit 3`], opts);
  await assert.rejects(runner({ spawn: three })({ job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd }), /the install's exit code is not a number \(x; claude exited 3\)/);
  // A non-zero exit with the result written is not refused (--max-turns 1 may end claude in error after its one command).
  const late = (bin, args, opts) => childSpawn('/bin/sh', ['-c', `echo 0 > '${f}'; exit 1`], opts);
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

// runner-locked.mjs (L969): the lock-down runner. claude is stood in for by /bin/sh running the one command claude is
// asked to run, so what is proven here is everything around claude: the command each job gets, the result file, every
// refusal, the time limit's group kill, and a real save-work job (M4's own script, node, git) making a bundle in the
// outbox. That claude runs it under dontAsk with the worker hooks, inside the sandbox, is a Mini proof (M4 README,
// "Live proofs still to run", item 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../shared/test-tmp.mjs';
import { pushWorld } from '../modules/M4-workshop/git/push-world.test-helper.mjs';
import { createSaveWork } from '../modules/M4-workshop/git/save-work.mjs';
import { bundleName } from '../modules/M4-workshop/git/push.mjs';
import { JOBS_DIR, LOCKED_JOBS, jobFile, lockedRunner } from './runner-locked.mjs';

const ASK = 'Run exactly this shell command once and report its exit code: ';
// claude, stood in for: the command it is asked to run, by /bin/sh, in its folder, with its environment and group.
const sh = (calls = []) => (bin, args, opts) => {
  const prompt = args.at(-1);
  assert.ok(prompt.startsWith(ASK), prompt);
  const child = childSpawn('/bin/sh', ['-c', prompt.slice(ASK.length)], opts);
  calls.push({ bin, args, opts, child });
  return child;
};
const world = () => {
  const d = tempDir('orch-locked-');
  const cwd = join(d, 'copy'); mkdirSync(cwd);
  const settingsFile = join(d, 'S-1.json'); writeFileSync(settingsFile, '{"permissions":{}}\n');
  return { d, cwd, settingsFile };
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
  const settingsFile = join(tempDir('orch-locked-'), 'S-1.json'); writeFileSync(settingsFile, '{}\n');
  const calls = [];
  const run = runner({ spawn: sh(calls), envOf: () => ({ PATH: process.env.PATH, HOME: process.env.HOME }) });
  const bound = (j) => run({ ...j, sessionId: 'S-1', role: 'worker', settingsFile, cwd: w.clone });
  const saved = await createSaveWork({ runLocked: bound })({ clone: w.clone, mirror: w.mirror, card: 'C-1', branch: 'card/c-1', outbox: w.outbox });
  assert.equal(saved.ok, true, saved.reason);
  assert.equal(saved.bundle, join(w.outbox, bundleName('C-1')));
  assert.equal(spawnSync('git', ['bundle', 'verify', '-q', saved.bundle], { cwd: w.mirror, encoding: 'utf8' }).status, 0, 'git bundle verify');
  const cmd = calls[0].args.at(-1).slice(ASK.length);
  assert.ok(cmd.startsWith(`'${process.execPath}' '${join(JOBS_DIR, 'save-work.mjs')}' '`), cmd);
  assert.ok(cmd.endsWith(` '${jobFile({ cwd: w.clone, job: 'save-work', sessionId: 'S-1' })}'`), 'of the copy, only the result file is named');
  assert.equal(cmd.split(w.clone).length, 2, 'the copy is named once, for the result file');
  assert.equal(existsSync(jobFile({ cwd: w.clone, job: 'save-work', sessionId: 'S-1' })), false, 'the result file is removed');
});

test('L969: save-work believes no answer alone: the bundle must be a plain, non-empty file of the card in the outbox', async () => {
  const d = tempDir('orch-locked-');
  const outbox = join(d, 'outbox'); mkdirSync(outbox);
  const want = join(outbox, bundleName('C-1'));
  const save = (bundle) => createSaveWork({ runLocked: async () => ({ ok: true, bundle }) })({ clone: join(d, 'clone'), mirror: join(d, 'm.git'), card: 'C-1', branch: 'card/c-1', outbox });
  const no = { ok: false, reason: 'the save-work job answered, but no bundle of the card is in the outbox' };
  assert.deepEqual(await save(want), no, 'none there');
  writeFileSync(want, '');
  assert.deepEqual(await save(want), no, 'an empty one');
  writeFileSync(want, 'x');
  assert.deepEqual(await save(join(outbox, 'other.bundle')), no, 'the answer names another file');
  assert.deepEqual(await save(want), { ok: true, bundle: want });
  const other = join(d, 'elsewhere'); writeFileSync(other, 'x');
  const link = join(outbox, bundleName('C-2')); symlinkSync(other, link);
  assert.deepEqual(await createSaveWork({ runLocked: async () => ({ ok: true, bundle: link }) })({ clone: join(d, 'clone'), mirror: join(d, 'm.git'), card: 'C-2', branch: 'card/c-2', outbox }), no, 'a link');
});

test('L969: every way runLocked can fail is a throw with a plain reason, and nothing is run for one found before claude', async () => {
  const { d, cwd, settingsFile } = world();
  const calls = [];
  const run = runner({ spawn: sh(calls) });
  const base = { job: 'install', command: 'true', sessionId: 'S-1', role: 'worker', settingsFile, cwd };
  const link = join(d, 'link.json'); symlinkSync(settingsFile, link);
  const arr = join(d, 'arr.json'); writeFileSync(arr, '[]');
  for (const [more, why] of [
    [{ job: 'rm' }, /"rm" is not a lock-down job/],
    [{ sessionId: 'S 1' }, /names no session the Dispatcher makes/],
    [{ role: 'nobody' }, /no role profile for "nobody"/],
    [{ cwd: 'copy' }, /names no folder to run in/],
    [{ settingsFile: 'S-1.json' }, /names no settings file/],
    [{ settingsFile: link }, /settings file .* can't be read/],
    [{ settingsFile: join(d, 'none.json') }, /settings file .* can't be read \(ENOENT\)/],
    [{ settingsFile: arr }, /is not a settings object/],
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
  await assert.rejects(runner({ spawn: quiet() })(base), /the install job's result was not written \(claude exited 0\)/);
  await assert.rejects(runner({ spawn: quiet('x') })(base), /the install's exit code is not a number \(x\)/);
  const save = { ...base, job: 'save-work', args: {} };
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

// runner-entry.test.mjs — the worker runner, started as its job starts it: a real node process on the real entry.
//
// WHY. runner-main.mjs awaited main() at the top level, and main() loads the wall code with a dynamic import, whose own imports
// reach back to runner-main.mjs (builder-wall -> dispatcher-setup -> extras -> proofs -> install -> worker-runner-setup,
// which imports checkRunnerConfig). The import waited on runner-main's loading, and that waited on main(): nothing held
// node, so it exited 13 with one warning ("unsettled top-level await") and nothing else, once a minute, on the Mac. The
// other tests hand main() a loadWall of their own, so none of them could see it.
//
// Here the real entry runs from a copy of orchestrate/ and scripts/ (the config reader wants the script inside the
// installed copy), with the job's own node flags. One thing is changed, by a preload: the user's name reads "builder"
// and its groups leave out staff and admin, so the start check (personUserProblem) lets this test's user through. The
// runner must get past the wall's loading into its loop (runner-loop.mjs says it has no memory yet), then stop on
// SIGTERM with exit 0, as when launchd stops it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tempDir } from '../shared/test-tmp.mjs';
import { RUNNER_NODE_FLAGS } from './runner-job.mjs';
import { WORKER_RUNNER_MAIN } from '../setup/worker-runner-setup.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IN_LOOP = /the worker runner has no memory file \(.*\): a first run, or the file was lost/;

const PRELOAD = `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const real = os.userInfo;
os.userInfo = (o) => ({ ...real(o), username: 'builder' });
syncBuiltinESMExports();
process.getgroups = () => [4242];
`;

/** The runner, started on the copy's entry; → { code, signal, err } once it has ended (SIGTERM once it is in its loop). */
function startRunner(d) {
  const installRoot = join(d, 'repo', 'orchestrate');
  mkdirSync(join(d, 'repo'));
  cpSync(join(REPO, 'orchestrate'), installRoot, { recursive: true });
  cpSync(join(REPO, 'scripts'), join(d, 'repo', 'scripts'), { recursive: true });
  for (const k of ['copies', 'outboxes', 'requests']) mkdirSync(join(d, k));
  mkdirSync(join(d, 'runner'), { mode: 0o700 });
  writeFileSync(join(d, 'preload.mjs'), PRELOAD);
  const h = join(d, 'home');
  const config = { installRoot, requestsDir: join(d, 'requests'), statusFile: join(d, 'runner', 'status.json'), orchestrateUid: process.getuid(),
    outboxRoot: join(d, 'outboxes'), copiesRoot: join(d, 'copies'), home: h, path: '/usr/bin:/bin', claudeBin: join(installRoot, 'claude'),
    recordRoot: join(d, 'record'), recordUid: process.getuid(), claimMs: 600_000, wallStatus: join(d, 'wall', 'wall-status.json'),
    products: { p1: { repo: 'o/p1', mirror: join(d, 'mirror'), render: { paths: { deny: { record: join(d, 'record'), ssh: join(h, '.ssh'),
      gh: join(h, '.config', 'gh'), claudeHome: join(h, '.claude'), robotKeys: join(d, 'keys'), secrets: [join(d, 'secrets'), join(d, 'approvals')] } } } } } };
  const file = join(installRoot, 'worker-runner.json');
  writeFileSync(file, JSON.stringify(config)); chmodSync(file, 0o600);
  return new Promise((done) => {
    const p = spawn(process.execPath, [...RUNNER_NODE_FLAGS, '--import', join(d, 'preload.mjs'), join(installRoot, WORKER_RUNNER_MAIN), file],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; p.kill('SIGTERM'); } };
    p.stderr.on('data', (b) => { err += b; if (IN_LOOP.test(err)) stop(); });
    const t = setTimeout(stop, 30_000);
    p.on('close', (code, signal) => { clearTimeout(t); done({ code, signal, err }); });
  });
}

test('the worker runner started on its real entry gets past the wall\'s loading into its loop, not exit 13', { timeout: 60_000 }, async () => {
  const d = realpathSync.native(tempDir('orch-runner-entry-'));
  const r = await startRunner(d);
  const said = `exit ${r.code ?? r.signal}, said ${JSON.stringify(r.err.slice(0, 600))}`;
  assert.doesNotMatch(r.err, /unsettled top-level await/, said);
  assert.notEqual(r.code, 13, said);
  assert.doesNotMatch(r.err, /builder wall's code can't be loaded/, said);
  assert.match(r.err, IN_LOOP, `it reached its loop: ${said}`);
  assert.equal(r.code, 0, `SIGTERM stops it with exit 0: ${said}`);
});

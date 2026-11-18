// The review runner's config keys for a test Dispatcher (A2, L639): a throwaway runner folder of this user's, standing
// in for the review user's, with a requests folder, a status file and root's record of main beside a review copy.
// With them, the worker ports' keys (L739), which every Dispatcher config needs too: see workerConfig below.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIRROR_CONFIG_TEMPLATE } from '../modules/M4-workshop/git/safe-git.mjs';

const iso = (ms) => new Date(ms).toISOString();

/** Review config keys under `dir`. `status` and `seen` are written as given (null: not written). */
export function reviewConfig(dir, { now = Date.now(), status = {}, seen = {}, reviewUid = process.getuid() } = {}) {
  const runner = join(dir, 'review-runner');
  mkdirSync(join(runner, 'requests'), { recursive: true, mode: 0o755 });
  const keys = { reviewRequestsDir: join(runner, 'requests'), reviewStatusFile: join(runner, 'status.json'), reviewUid,
    reviewRunnerLog: join(dir, 'logs', 'review-runner.err.log'), reviewInstallRoot: join(dir, 'review-copy', 'current') };
  mkdirSync(join(dir, 'review-copy'), { recursive: true, mode: 0o755 });
  writeStatus(keys, status === null ? null : { now, ...status });
  writeSeen(keys, seen === null ? null : { now, ...seen });
  return { ...keys, ...workerConfig(dir) };
}

/**
 * The worker and cleanup ports' keys under `dir` (L739): the runner's folder with its launches folder, a mirror folder of
 * this user's (0755, as setup makes it), a seal folder made at start, and a host.lock that isn't there (no host claimed).
 */
export function workerConfig(dir) {
  const runner = join(dir, 'review-runner');
  mkdirSync(join(runner, 'launches'), { recursive: true, mode: 0o755 });
  const mirror = join(dir, 'mirror');
  mkdirSync(mirror, { recursive: true, mode: 0o755 }); chmodSync(mirror, 0o755);
  // The shape safe-git's checkMirror wants (worker-ports.mjs mirrorProblem, L763): its config is the template.
  writeFileSync(join(mirror, 'config'), MIRROR_CONFIG_TEMPLATE);
  // host.lock's owner is not the Dispatcher's own user (worker-ports.mjs, L763); the test's Dispatcher is this user.
  // The TOP outboxes and worker-copies folders (L887), real folders as setup makes them.
  for (const f of ['outboxes', 'worker-copies']) mkdirSync(join(dir, f), { recursive: true, mode: 0o755 });
  // The worker runner's requests and own folders (setup layout.mjs workerRunnerPaths, L921). Its user is the builder's
  // (L1079), a stand-in uid apart from host.lock's, so its status here is never trusted: a test of the reads stands in for the files.
  const workerRunner = join(dir, 'worker-runner');
  for (const f of ['requests', 'runner']) mkdirSync(join(workerRunner, f), { recursive: true, mode: 0o755 });
  return { reviewRoot: runner, mirror, sealRoot: join(dir, 'seals'), outboxRoot: join(dir, 'outboxes'), copiesRoot: join(dir, 'worker-copies'), hostLockPath: join(dir, 'host.lock'), hostLockUid: process.getuid() + 3,
    workerRequestsDir: join(workerRunner, 'requests'), workerStatusFile: join(workerRunner, 'runner', 'status.json'), workerUid: process.getuid() + 4 };
}

const C = 'c'.repeat(40);
export function writeStatus(keys, s) {
  if (!s) return;
  const { now = Date.now(), ...rest } = s;
  writeFileSync(keys.reviewStatusFile, JSON.stringify({ written_at: iso(now), ok: true, error: null, installed_commit: C, running: [], refused: [], alerts: [], ...rest }), { mode: 0o644 });
}
export function writeSeen(keys, s) {
  if (!s) return;
  const { now = Date.now(), ...rest } = s;
  writeFileSync(`${keys.reviewInstallRoot}.main-seen.json`, JSON.stringify({ commit: C, since: now, installed: C, checked_at: now, ...rest }), { mode: 0o644 });
}

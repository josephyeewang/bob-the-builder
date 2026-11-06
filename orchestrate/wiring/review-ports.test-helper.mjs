// The review runner's config keys for a test Dispatcher (A2, L639): a throwaway runner folder of this user's, standing
// in for the review user's, with a requests folder, a status file and root's record of main beside a review copy.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const iso = (ms) => new Date(ms).toISOString();

/** Review config keys under `dir`. `status` and `seen` are written as given (null: not written). */
export function reviewConfig(dir, { now = Date.now(), status = {}, seen = {} } = {}) {
  const runner = join(dir, 'review-runner');
  mkdirSync(join(runner, 'requests'), { recursive: true, mode: 0o755 });
  const keys = { reviewRequestsDir: join(runner, 'requests'), reviewStatusFile: join(runner, 'status.json'), reviewUid: process.getuid(),
    reviewRunnerLog: join(dir, 'logs', 'review-runner.err.log'), reviewInstallRoot: join(dir, 'review-copy', 'current') };
  mkdirSync(join(dir, 'review-copy'), { recursive: true, mode: 0o755 });
  writeStatus(keys, status === null ? null : { now, ...status });
  writeSeen(keys, seen === null ? null : { now, ...seen });
  return keys;
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

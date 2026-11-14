// Part C, runner step 5: the worker runner's job file. Since L1079 a LaunchDaemon (root:wheel 0644 in /Library/LaunchDaemons)
// with UserName set to the builder user (setup/layout.mjs BUILDER), as the review runner's job runs as review
// (review-daemons.mjs): the runner and every session it starts are the builder's, which holds no production credentials
// and cannot read the owner's home. Before L1079 it was a LaunchAgent of the owner's own user (L896); that file's label
// left behind is a second runner, so the Mini steps take it out (setup/README.md).
// Built by M11's loginJobPlist, the one builder of these files, so its beat, PATH and log rules are the Dispatcher's: node
// runs runner-main.mjs with its one config argument, at load and every 60 s. runner-main.mjs is the loop and does not end,
// and launchd never starts a second copy of a job that is running, so the beat only brings back a runner that died.
// HOME is the builder's own (claude and the sign-in folders read it; setup/layout.mjs homeOf) and Umask 077, as the robot
// job's: what the runner makes is the builder's alone, and the status file, which the Dispatcher reads, gets its 0o644 by
// name (runner-files.mjs writeStatus). Built and tested here; setup places it on the Mini, never on a laptop.

import { posix } from 'node:path';
import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';
import { BUILDER } from '../setup/layout.mjs';

/**
 * A full path in its simplest form (#364 r2 n1, n4; the rule of render-settings.mjs wallPath, L736): it starts with /,
 * holds only letters, digits and . _ / -, and is spelled as it resolves (no trailing slash, no // or /./, no ..), and is
 * not / itself. Any other spelling is refused, never cleaned up: a wall entry must name the one spelling the tool's path
 * match sees, and refusing is safe where guessing how the tool reads a path is not.
 */
export const fullPath = (p) => typeof p === 'string' && p.startsWith('/') && !/[^A-Za-z0-9._/-]/.test(p) && p !== '/' && posix.resolve(p) === p;

export const RUNNER_JOB_LOG = 'worker-runner';
export const RUNNER_JOB_UMASK = 0o077;
/** The user the worker runner's job runs as (L1079): the builder, never the owner. */
export const RUNNER_JOB_USER = BUILDER;

/** { label, node, script, config, path, logDir, workDir, home } → the plist text. Refuses what loginJobPlist refuses, and a
 *  home under /Users (a person's home: the builder's is setup's, under the base). */
export function workerRunnerPlist({ label, node, script, config, path, logDir, workDir, home }) {
  if (!fullPath(home)) throw new Error('home must be the builder user\'s home folder, a full path in its simplest form, not / itself');
  if (home.toLowerCase() === '/users' || home.toLowerCase().startsWith('/users/')) throw new Error(`home must be the ${RUNNER_JOB_USER} user's home under the base (setup layout homeOf), not a person's home under /Users (L1079)`);
  const text = loginJobPlist({ label, node, script, config, path, logDir, workDir, logName: RUNNER_JOB_LOG, home, umask: RUNNER_JOB_UMASK, userName: RUNNER_JOB_USER });
  // A loginJobPlist without the home and umask options (before #292) would drop both without a word, and one without the
  // user name would run the runner as root (a LaunchDaemon with no UserName).
  if (!text.includes('<key>HOME</key>') || !text.includes(`<key>Umask</key><integer>${RUNNER_JOB_UMASK}</integer>`)) {
    throw new Error('loginJobPlist did not write HOME and Umask: the worker runner\'s job needs the loginJobPlist with home and umask (#292)');
  }
  if (!text.includes(`<key>UserName</key><string>${RUNNER_JOB_USER}</string>`)) throw new Error(`loginJobPlist did not write UserName ${RUNNER_JOB_USER}: the worker runner would run as root (L1079)`);
  return text;
}

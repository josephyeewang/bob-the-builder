// Part C, runner step 5: the worker runner's LaunchAgent file (the owner's user's own job, so no UserName). Built by M11's
// loginJobPlist, the one builder of these files, so its beat, PATH and log rules are the Dispatcher's: node runs
// runner-main.mjs with its one config argument, at load and every 60 s. runner-main.mjs is the loop and does not end, and
// launchd never starts a second copy of a job that is running, so the beat only brings back a runner that died.
// HOME is the owner's (claude and the sign-in folders read it) and Umask 077, as the robot job's: what the runner makes is
// the owner's alone, and the status file, which the Dispatcher reads, gets its 0o644 by name (runner-files.mjs writeStatus).
// Built and tested here; setup places it on the Mini, never on a laptop.

import { loginJobPlist } from '../modules/M11-dispatcher/login-job.mjs';

export const RUNNER_JOB_LOG = 'worker-runner';
export const RUNNER_JOB_UMASK = 0o077;

/** { label, node, script, config, path, logDir, workDir, home } → the plist text. Refuses what loginJobPlist refuses. */
export function workerRunnerPlist({ label, node, script, config, path, logDir, workDir, home }) {
  if (typeof home !== 'string' || !home.startsWith('/') || /^\/+$/.test(home)) throw new Error('home must be the owner\'s home folder, a full path, not / itself');
  const text = loginJobPlist({ label, node, script, config, path, logDir, workDir, logName: RUNNER_JOB_LOG, home, umask: RUNNER_JOB_UMASK });
  // A loginJobPlist without the home and umask options (before #292) would drop both without a word.
  if (!text.includes('<key>HOME</key>') || !text.includes(`<key>Umask</key><integer>${RUNNER_JOB_UMASK}</integer>`)) {
    throw new Error('loginJobPlist did not write HOME and Umask: the worker runner\'s job needs the loginJobPlist with home and umask (#292)');
  }
  return text;
}

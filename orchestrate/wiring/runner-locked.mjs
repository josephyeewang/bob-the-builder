// The lock-down runner (L969, `runLocked`): one of a fixed list of jobs run inside a worker's lock-down, which is the
// worker's own sandbox, by the one path the check-11 baseline already uses (launch.mjs lockedRunCommand: claude, the
// Bash tool only, the session's settings file). A JS callback can't be moved into another process's sandbox, and the
// runner's own process is not locked down, so a job is never a function call here: it is a command claude runs once.
//
// The jobs (LOCKED_JOBS):
//   save-work  node runs M4's own job script (modules/M4-workshop/jobs/save-work.mjs, orchestrate's code, never the copy's)
//              with the save's arguments; it writes its answer as JSON into the result file. It runs in the copy's .git
//              under the session's save-phase settings (L991 M1, runner-ports.mjs saveWorkPort: the session's walls,
//              the network off, the start's file by its hash), so it writes in .git and the outbox only.
//              CAPABILITY NOTE, checked on claude 2.1.322 (its bundled sandbox code): RECHECK ON EVERY UPGRADE of the pin.
//              That claude's sandbox always denies writes to <cwd>/.git/config and <cwd>/.git/hooks (and **/.git/...).
//              With the copy as cwd, the job's reset of .git/config and .git/hooks (resetCloneGit) would be refused;
//              with <copy>/.git as cwd those paths are .git/.git/... and do not apply. M4 README item 9, step 9 proves it.
//   install    the product's declared install command, in the copy, under the install-phase settings installStep wrote
//              (the registry's hosts allowed); its exit code is written into the result file, as the baseline's is.
//
// Rejected: a direct /usr/bin/sandbox-exec. It would be a second copy of the lock-down, and Seatbelt can't allow only the
// registry's hosts, which Claude Code's network filter can (a design choice, not a capability claim).
//
// Fails closed, each a throw with a plain reason (save-work and installStep read a throw as a refusal): a job not on the
// list, a session id the Dispatcher does not make, a settings file that is not a plain JSON file with the sandbox on,
// failing closed and holding every command (settingsProblem; save-work's also the start's by its hash, with no host),
// no role profile, no sign-in (envOf), a process group whose start time can't be read (when it is to be kept), claude
// ended by a signal, a result file left from before that can't be removed, the time limit (the whole process group is
// killed: LOCKED_SAVE_MS for save-work, under the Dispatcher's SAVE_DEADLINE_MS so one ask can be answered; LOCKED_MS
// for the install), and no result, one over RESULT_MAX_BYTES, or one that is not the job's form ("not written").
// The group kill reaches what stayed in claude's process group only: a process an install's script moved into its own
// session (setsid) outlives it, in the session's own copy. Checks 1, 2, 3 and 8 run again after the install, but such a
// leftover can act after them; that is a limit of the install step, proven on the Mini (live proof 9). The result file sits in the copy, where
// the branch's own code (an install's scripts) could forge it: like the baseline's (#369 m1), it is a sanity check, not a
// wall; save-work's answer is checked again on the disk by createSaveWork (the bundle a plain file in the outbox).
//
// Proven on the Mini only (a capability claim tied to the pinned claude version, void on a pin move; the Mini checklist,
// modules/M4-workshop/README.md "Live proofs still to run", item 9): that claude runs the job's command under dontAsk with the worker hooks; that
// node can read orchestrate's code from inside the sandbox; that safe-git's temporary folder is writable there.
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as childSpawn } from 'node:child_process';
import { lockedRunCommand } from '../modules/M4-workshop/launcher/launch.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { SESSION_ID } from '../shared/record.mjs';
import { groupThere } from './runner-ports.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_TICK_MS, leaderStart } from './runner-loop.mjs';
import { ASK_POLL_MS } from './owner-asks.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';

export const LOCKED_JOBS = Object.freeze(['save-work', 'install']);
export const LOCKED_MS = 15 * 60_000;
/** save-work's own limit: with every delay around it (SAVE_DELAYS_MS) it is answered before the Dispatcher stops waiting. */
export const LOCKED_SAVE_MS = 40_000;
/**
 * Every delay between the Dispatcher's ask and its reading of the answer, besides the job itself (#463 r1 m1): the
 * runner's pickup of the request (a pass reads requests at least every RUNNER_STATUS_EVERY_MS), the rest of the pass
 * the job ends in (its one wait for this pass's saves, worker-runner.mjs, up to RUNNER_PORT_MS), the tick before the
 * extra pass that settles it (RUNNER_TICK_MS) and the Dispatcher's poll (ASK_POLL_MS). Every save of a pass is started
 * before any is waited for, so N saves cost this once, not N times. The bound assumes the runner's other port waits are
 * quick: a save that outlasts its pass is answered by the next pass's step 0, and a pass slowed by many hung ports
 * (each up to RUNNER_PORT_MS) comes later; such a save is told as not saved, never as saved (#463 r1 self-review m2).
 */
export const SAVE_DELAYS_MS = RUNNER_STATUS_EVERY_MS + RUNNER_PORT_MS + RUNNER_TICK_MS + ASK_POLL_MS;
if (LOCKED_SAVE_MS + SAVE_DELAYS_MS >= SAVE_DEADLINE_MS) throw new Error('LOCKED_SAVE_MS and the runner\'s and the Dispatcher\'s delays must fit inside SAVE_DEADLINE_MS');
/** The most a job's result file may hold: an exit code or one JSON answer, never more. */
export const RESULT_MAX_BYTES = 64 * 1024;
export const JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'M4-workshop', 'jobs');

/** Reads a plain file without following a link; one over `max` bytes (when given) is refused unread. */
export function readNoLink(p, { max } = {}) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) throw new Error('not a plain file');
    if (max !== undefined && f.size > max) throw new Error(`over ${max} bytes`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** One shell word: a path or argument in single quotes; one holding a quote, a NUL or a line break is refused. */
export const quoted = (p) => { if (/['\0\n]/.test(p)) throw new Error('a lock-down path holds a quote or a line break'); return `'${p}'`; };

/** A one-line shell command, run once, its exit code written into `file` (the baseline's form, and the install's). */
export function exitCodeCommand(command, file, what = 'command') {
  if (typeof command !== 'string' || !command.trim() || /[\0\n]/.test(command)) throw new Error(`the product declares no one-line ${what}`);
  return `( ${command} ); /bin/echo $? > ${quoted(file)}`;
}

// Runs one claude to its end (or the time limit). → { exitCode } (null when a signal ended it), or a throw.
// onSpawn(pid), when given, is told the group as soon as it is there (#463 r1 m2: the runner keeps it in its memory, so a
// restart or a stop can end it); one that throws has the group killed and the run refused. It leads its own process group, so a
// time-out kills the tests it started too, not claude alone (#369 m2), and so does a normal end (#369 r1 M1): what the
// tests left running in the group goes with it. After the end, the group is killed only if signal 0 still finds it
// (#369 r2 c3; runner-ports.mjs groupThere, the one test of a group): an empty group's number is not signalled.
export function runToEnd(spawn, bin, args, opts, timeoutMs, kill = (g) => process.kill(-g, 'SIGKILL'), there = groupThere, onSpawn) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { ...opts, detached: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { reject(e); return; }
    const group = () => Number.isInteger(child.pid) && child.pid > 1;
    // A child with no pid (its spawn failed: no cwd, no claude) is never signalled: node's kill() of it would signal
    // pid 0, the runner's own process group (#463 r1 self-review M1). Its 'error' ends the run.
    const stop = () => { try { if (group()) kill(child.pid); else if (Number.isInteger(child.pid) && child.pid > 1) child.kill('SIGKILL'); } catch { try { if (group()) child.kill('SIGKILL'); } catch { /* gone */ } } };
    let t;
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); try { if (group() && there(child.pid)) kill(child.pid); } catch { /* none of the group is left */ } resolve({ exitCode: code }); });
    if (typeof onSpawn === 'function') {
      // No group: the 'error' above rejects with the spawn's own reason.
      if (!group()) return;
      try { onSpawn(child.pid); } catch (e) {
        stop();
        reject(new Error(`its process group can't be kept (${e?.message ?? e}), so it is stopped`)); return;
      }
    }
    t = setTimeout(() => { stop(); reject(new Error('it did not finish in time')); }, timeoutMs);
  });
}

/**
 * The one way a command runs inside a lock-down (the baseline's, lifted here so runLocked is not a second copy): claude
 * with the Bash tool only and `settingsFile`, in `cwd`, to its end or `ms`. → { exitCode } (claude's own), or a throw.
 * `--setting-sources ''` (#463 r1 m4, as owner-answer.mjs runs claude): no user, project or local settings file is
 * loaded, the copy's own `.claude/settings*.json` least of all; only `--settings` and the machine-wide file are.
 */
export async function runLockedCommand({ spawn, claudeBin, settingsFile, command, profile, cwd, env, ms, killGroup, groupThere: there, onSpawn }) {
  const lr = lockedRunCommand({ claudeBin, settingsFile, command, roleArgs, profile });
  if (!lr.ok) throw new Error(lr.reason);
  const args = [...lr.args.slice(0, -1), '--setting-sources', '', lr.args[lr.args.length - 1]];
  return runToEnd(spawn, lr.bin, args, { cwd, env }, ms, killGroup, there, onSpawn);
}

/** Claude's own end, said beside a job's answer (#463 r1 c3). */
export const claudeEnd = (r) => (r?.exitCode === null ? 'claude was ended by a signal' : `claude exited ${r?.exitCode}`);

/** The job's result file: in the folder it runs in, named for the job and the session. */
export const jobFile = ({ cwd, job, sessionId }) => join(cwd, `.orch-job-${job}-${sessionId}`);

/** The sha256 of a settings file's bytes, as the start port keeps it for the save's file (#463 r1 m3). */
export const settingsSha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Why a job's settings file must not be used, or null (#463 r1 m3). It must be a plain JSON object whose sandbox is on,
 * fails closed and lets no command out of it; given `sha` (save-work's, kept in the session's row), its bytes must be
 * those; save-work's must also reach no host (the save phase). Read here, before claude reads it: the settings folder
 * is the runner's own, which every session's settings wall off (runner-launch.mjs), so the read and the use are of one file.
 */
export function settingsProblem(file, { sha, noNetwork = false, read = readNoLink } = {}) {
  let bytes; let v;
  try { bytes = read(file); v = JSON.parse(bytes.toString('utf8')); } catch (e) { return `the settings file ${file} can't be read (${e?.code ?? e?.message})`; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `the settings file ${file} is not a settings object`;
  if (sha !== undefined && settingsSha(bytes) !== sha) return `the settings file ${file} is not the one the start wrote (its hash differs)`;
  const b = v[S.sandbox];
  if (b?.[S.sandboxEnabled] !== true) return `the settings file ${file} does not turn the sandbox on`;
  if (b[S.failIfUnavailable] !== true) return `the settings file ${file} does not refuse to run without the sandbox`;
  if (b[S.allowUnsandboxedCommands] !== false) return `the settings file ${file} does not keep every command in the sandbox`;
  if (noNetwork) {
    const hosts = b[S.network]?.[S.allowedDomains];
    if (!Array.isArray(hosts) || hosts.length || b[S.network]?.[S.strictAllowlist] !== true) return `the settings file ${file} does not shut the network`;
  }
  return null;
}

/**
 * `runLocked` for this runner. claudeBin: the pinned claude; envOf() → the environment claude gets (roleEnv with the
 * sign-in; a throw is "no sign-in"); node: the node that runs a job script (the runner's own, outside every copy).
 * → runLocked({ job, args?, command?, sessionId, role, settingsFile, cwd, settingsSha?, env?, onGroup? }) → save-work:
 * its JSON answer; install: { ok, reason? } from the exit code. settingsSha: required for save-work (its save-phase
 * file's hash, kept in the session's row). env: the start's own, already held to check 9 (the install, #463 r1 m6), so
 * the sign-in is not read twice; else envOf(). onGroup({ pgid, pid, pid_start }): told the job's process group once it
 * runs (#463 r1 m2); a start time that can't be read stops the job. `run`, a stand-in's in-process body (createSaveWork
 * passes it for tests), is never called here.
 */
export function lockedRunner({ claudeBin, envOf, spawn = childSpawn, node = process.execPath, jobsDir = JOBS_DIR, ms = LOCKED_MS, saveMs = LOCKED_SAVE_MS, killGroup, groupThere: there, rm = rmSync, read = readNoLink, pidStartOf = leaderStart }) {
  if (typeof claudeBin !== 'string' || !claudeBin.startsWith('/')) throw new Error('the lock-down runner needs the pinned claude\'s path');
  if (typeof envOf !== 'function') throw new Error('the lock-down runner needs the sign-in environment');
  for (const [k, v] of [['ms', ms], ['saveMs', saveMs]]) if (!Number.isInteger(v) || v <= 0) throw new Error(`the lock-down runner's ${k} is not a time limit`);
  if (saveMs > LOCKED_SAVE_MS) throw new Error(`save-work's limit can't pass ${LOCKED_SAVE_MS} ms (the Dispatcher's save deadline)`);
  return async function runLocked({ job, args, command, sessionId, role, settingsFile, cwd, settingsSha: sha, env: given, onGroup } = {}) {
    if (!LOCKED_JOBS.includes(job)) throw new Error(`${JSON.stringify(job)} is not a lock-down job`);
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('the lock-down job names no session the Dispatcher makes');
    const profile = Object.hasOwn(DESIGN_PROFILES, role ?? '') ? DESIGN_PROFILES[role] : null;
    if (!profile) throw new Error(`no role profile for ${JSON.stringify(role)}`);
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('the lock-down job names no folder to run in');
    if (typeof settingsFile !== 'string' || !settingsFile.startsWith('/')) throw new Error('the lock-down job names no settings file');
    if (job === 'save-work' && (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha))) throw new Error('the save names no hash of its settings file, so the file can\'t be shown to be the one the start wrote');
    const bad = settingsProblem(settingsFile, { sha, noNetwork: job === 'save-work', read });
    if (bad) throw new Error(bad);
    const file = jobFile({ cwd, job, sessionId });
    const cmd = job === 'install' ? exitCodeCommand(command, file, 'install command')
      : `${quoted(node)} ${quoted(join(jobsDir, `${job}.mjs`))} ${quoted(Buffer.from(JSON.stringify(args ?? {})).toString('base64'))} ${quoted(file)}`;
    let env = given;
    if (env === undefined) try { env = envOf(); } catch (e) { throw new Error(`no sign-in to run the ${job} job with (${e?.message ?? e})`); }
    if (!env || typeof env !== 'object') throw new Error(`no environment to run the ${job} job with`);
    const onSpawn = typeof onGroup === 'function' ? (pid) => {
      let at = null; try { at = pidStartOf(pid); } catch { at = null; }
      if (typeof at !== 'string' || !at) throw new Error('its start time can\'t be read');
      onGroup({ pgid: pid, pid, pid_start: at });
    } : undefined;
    try { rm(file, { force: true }); } catch (e) { throw new Error(`the ${job} job's old result can't be removed (${e?.code ?? e?.message})`); }
    try {
      let r; try { r = await runLockedCommand({ spawn, claudeBin, settingsFile, command: cmd, profile, cwd, env, ms: job === 'install' ? ms : saveMs, killGroup, groupThere: there, onSpawn }); } catch (e) { throw new Error(`the ${job} job did not finish inside the lock-down (${e?.message ?? e})`); }
      // Claude's own end (#463 r1 c3): one ended by a signal is refused, whatever result it left. A non-zero exit with
      // the job's result written is not: with --max-turns 1, claude may end in error after its one command has run (a
      // capability claim on the pinned claude, proven on the Mini, README item 9); it is said in every refusal below.
      if (r?.exitCode === null) throw new Error(`the ${job} job did not finish inside the lock-down (${claudeEnd(r)})`);
      let text; try { text = read(file, { max: RESULT_MAX_BYTES }).toString('utf8').trim(); } catch (e) { throw new Error(`the ${job} job's result was not written (${claudeEnd(r)}; ${e?.code ?? e?.message})`); }
      if (job === 'install') {
        if (!/^\d{1,3}$/.test(text)) throw new Error(`the install's exit code is not a number (${text.slice(0, 20)}; ${claudeEnd(r)})`);
        return Number(text) === 0 ? { ok: true } : { ok: false, reason: `the install exited ${Number(text)}` };
      }
      let a; try { a = JSON.parse(text); } catch { a = null; }
      if (!a || typeof a !== 'object' || typeof a.ok !== 'boolean' || (!a.ok && typeof a.reason !== 'string')) throw new Error(`the ${job} job's result is not its answer (${claudeEnd(r)})`);
      return a;
    } finally { try { rm(file, { force: true }); } catch { /* left; removed before the next run of this job */ } }
  };
}

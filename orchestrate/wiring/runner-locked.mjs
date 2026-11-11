// The lock-down runner (L969, `runLocked`): one of a fixed list of jobs run inside a worker's lock-down, which is the
// worker's own sandbox, by the one path the check-11 baseline already uses (launch.mjs lockedRunCommand: claude, the
// Bash tool only, the session's settings file). A JS callback can't be moved into another process's sandbox, and the
// runner's own process is not locked down, so a job is never a function call here: it is a command claude runs once.
//
// The jobs (LOCKED_JOBS):
//   save-work  node runs M4's own job script (modules/M4-workshop/jobs/save-work.mjs, orchestrate's code, never the copy's)
//              with the save's arguments; it writes its answer as JSON into the result file.
//   install    the product's declared install command, in the copy, under the install-phase settings installStep wrote
//              (the registry's hosts allowed); its exit code is written into the result file, as the baseline's is.
//
// Rejected: a direct /usr/bin/sandbox-exec. It would be a second copy of the lock-down, and Seatbelt can't allow only the
// registry's hosts, which Claude Code's network filter can (a design choice, not a capability claim).
//
// Fails closed, each a throw with a plain reason (save-work and installStep read a throw as a refusal): a job not on the
// list, a session id the Dispatcher does not make, a settings file that is not a plain JSON file, no role profile, no
// sign-in (envOf), a result file left from before that can't be removed, the time limit (the whole process group is
// killed), and no result, or one that is not the job's form ("not written"). The result file sits in the copy, where
// the branch's own code (an install's scripts) could forge it: like the baseline's (#369 m1), it is a sanity check, not a
// wall; save-work's answer is checked again on the disk by createSaveWork (the bundle a plain file in the outbox).
//
// Proven on the Mini only (a capability claim tied to the pinned claude version, void on a pin move; the Mini checklist,
// modules/M4-workshop/README.md "Live proofs still to run", item 9): that claude runs the job's command under dontAsk with the worker hooks; that
// node can read orchestrate's code from inside the sandbox; that safe-git's temporary folder is writable there.
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as childSpawn } from 'node:child_process';
import { lockedRunCommand } from '../modules/M4-workshop/launcher/launch.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { SESSION_ID } from '../shared/record.mjs';
import { groupThere } from './runner-ports.mjs';

export const LOCKED_JOBS = Object.freeze(['save-work', 'install']);
export const LOCKED_MS = 15 * 60_000;
export const JOBS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'M4-workshop', 'jobs');

/** Reads a plain file without following a link. */
export function readNoLink(p) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error('not a plain file'); return readFileSync(fd); } finally { closeSync(fd); }
}

/** One shell word: a path or argument in single quotes; one holding a quote, a NUL or a line break is refused. */
export const quoted = (p) => { if (/['\0\n]/.test(p)) throw new Error('a lock-down path holds a quote or a line break'); return `'${p}'`; };

/** A one-line shell command, run once, its exit code written into `file` (the baseline's form, and the install's). */
export function exitCodeCommand(command, file, what = 'command') {
  if (typeof command !== 'string' || !command.trim() || /[\0\n]/.test(command)) throw new Error(`the product declares no one-line ${what}`);
  return `( ${command} ); /bin/echo $? > ${quoted(file)}`;
}

// Runs one claude to its end (or the time limit). → { exitCode }, or a throw. It leads its own process group, so a
// time-out kills the tests it started too, not claude alone (#369 m2), and so does a normal end (#369 r1 M1): what the
// tests left running in the group goes with it. After the end, the group is killed only if signal 0 still finds it
// (#369 r2 c3; runner-ports.mjs groupThere, the one test of a group): an empty group's number is not signalled.
export function runToEnd(spawn, bin, args, opts, timeoutMs, kill = (g) => process.kill(-g, 'SIGKILL'), there = groupThere) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { ...opts, detached: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { reject(e); return; }
    const group = () => Number.isInteger(child.pid) && child.pid > 1;
    const t = setTimeout(() => {
      try { if (group()) kill(child.pid); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      reject(new Error('it did not finish in time'));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); try { if (group() && there(child.pid)) kill(child.pid); } catch { /* none of the group is left */ } resolve({ exitCode: code }); });
  });
}

/**
 * The one way a command runs inside a lock-down (the baseline's, lifted here so runLocked is not a second copy): claude
 * with the Bash tool only and `settingsFile`, in `cwd`, to its end or `ms`. → { exitCode } (claude's own), or a throw.
 */
export async function runLockedCommand({ spawn, claudeBin, settingsFile, command, profile, cwd, env, ms, killGroup, groupThere: there }) {
  const lr = lockedRunCommand({ claudeBin, settingsFile, command, roleArgs, profile });
  if (!lr.ok) throw new Error(lr.reason);
  return runToEnd(spawn, lr.bin, lr.args, { cwd, env }, ms, killGroup, there);
}

/** The job's result file: in the folder it runs in, named for the job and the session. */
export const jobFile = ({ cwd, job, sessionId }) => join(cwd, `.orch-job-${job}-${sessionId}`);

const settingsProblem = (file) => {
  let v; try { v = JSON.parse(readNoLink(file).toString('utf8')); } catch (e) { return `the session's settings file ${file} can't be read (${e?.code ?? e?.message})`; }
  return v && typeof v === 'object' && !Array.isArray(v) ? null : `the session's settings file ${file} is not a settings object`;
};

/**
 * `runLocked` for this runner. claudeBin: the pinned claude; envOf() → the environment claude gets (roleEnv with the
 * sign-in; a throw is "no sign-in"); node: the node that runs a job script (the runner's own, outside every copy).
 * → runLocked({ job, args?, command?, sessionId, role, settingsFile, cwd }) → save-work: its JSON answer; install:
 * { ok, reason? } from the exit code. `run`, a stand-in's in-process body (createSaveWork passes it for tests), is never
 * called here.
 */
export function lockedRunner({ claudeBin, envOf, spawn = childSpawn, node = process.execPath, jobsDir = JOBS_DIR, ms = LOCKED_MS, killGroup, groupThere: there, rm = rmSync, read = readNoLink }) {
  if (typeof claudeBin !== 'string' || !claudeBin.startsWith('/')) throw new Error('the lock-down runner needs the pinned claude\'s path');
  if (typeof envOf !== 'function') throw new Error('the lock-down runner needs the sign-in environment');
  return async function runLocked({ job, args, command, sessionId, role, settingsFile, cwd } = {}) {
    if (!LOCKED_JOBS.includes(job)) throw new Error(`${JSON.stringify(job)} is not a lock-down job`);
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('the lock-down job names no session the Dispatcher makes');
    const profile = Object.hasOwn(DESIGN_PROFILES, role ?? '') ? DESIGN_PROFILES[role] : null;
    if (!profile) throw new Error(`no role profile for ${JSON.stringify(role)}`);
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('the lock-down job names no folder to run in');
    if (typeof settingsFile !== 'string' || !settingsFile.startsWith('/')) throw new Error('the lock-down job names no settings file');
    const bad = settingsProblem(settingsFile);
    if (bad) throw new Error(bad);
    const file = jobFile({ cwd, job, sessionId });
    const cmd = job === 'install' ? exitCodeCommand(command, file, 'install command')
      : `${quoted(node)} ${quoted(join(jobsDir, `${job}.mjs`))} ${quoted(Buffer.from(JSON.stringify(args ?? {})).toString('base64'))} ${quoted(file)}`;
    let env; try { env = envOf(); } catch (e) { throw new Error(`no sign-in to run the ${job} job with (${e?.message ?? e})`); }
    try { rm(file, { force: true }); } catch (e) { throw new Error(`the ${job} job's old result can't be removed (${e?.code ?? e?.message})`); }
    try {
      let r; try { r = await runLockedCommand({ spawn, claudeBin, settingsFile, command: cmd, profile, cwd, env, ms, killGroup, groupThere: there }); } catch (e) { throw new Error(`the ${job} job did not finish inside the lock-down (${e?.message ?? e})`); }
      let text; try { text = read(file).toString('utf8').trim(); } catch { throw new Error(`the ${job} job's result was not written (claude exited ${r?.exitCode})`); }
      if (job === 'install') {
        if (!/^\d{1,3}$/.test(text)) throw new Error(`the install's exit code is not a number (${text.slice(0, 20)})`);
        return Number(text) === 0 ? { ok: true } : { ok: false, reason: `the install exited ${Number(text)}` };
      }
      let a; try { a = JSON.parse(text); } catch { a = null; }
      if (!a || typeof a !== 'object' || typeof a.ok !== 'boolean' || (!a.ok && typeof a.reason !== 'string')) throw new Error(`the ${job} job's result is not its answer`);
      return a;
    } finally { try { rm(file, { force: true }); } catch { /* left; removed before the next run of this job */ } }
  };
}

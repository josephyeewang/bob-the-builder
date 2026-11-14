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
//              CAPABILITY NOTE, read in claude 2.1.322's bundled sandbox code and again in the pin's, 2.1.316, on
//              13 Nov 2026 (checked: claude-code 2.1.316); the Mini proof below runs it there. RECHECK ON EVERY UPGRADE
//              of the pin.
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
// The job's own process group (#463 r2 M1): claude's Bash tool (read in 2.1.317, 2.1.322 and the pin, 2.1.316; the Mini
// proof runs it) runs each command detached, in a group of its
// own, so claude's group alone does not hold the job. The job's shell first records its pid (groupRecordCommand) and
// waits; the runner reads its group and leader start time outside the sandbox, keeps them (onGroup is told claude's
// group, then the same record with `job`), and only then lets the job run. Both groups are killed at the time limit, on
// a stop and on a restart (worker-runner.mjs step 0); one still there once claude closed is killed and refused (m6). A
// job whose group can't be recorded or kept never runs. Each claude's Bash tool also gets the job's limit as its own
// wait (BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, m1), so it never moves the job to the background early.
// The group kill reaches what stayed in those two groups only: a process an install's script moved into its own
// session (setsid) outlives it, in the session's own copy. Checks 1, 2, 3 and 8 run again after the install, but such a
// leftover can act after them; that is a limit of the install step, proven on the Mini (live proof 9). The result file sits in the copy, where
// the branch's own code (an install's scripts) could forge it: like the baseline's (#369 m1), it is a sanity check, not a
// wall; save-work's answer is checked again on the disk by createSaveWork (the bundle a plain file in the outbox).
//
// Proven on the Mini only (a capability claim tied to the pinned claude version, void on a pin move; the Mini checklist,
// modules/M4-workshop/README.md "Live proofs still to run", item 9, run on the pin, 2.1.316): that claude's Bash tool runs
// the job in a group of its own that the record names, and honours the BASH_*_TIMEOUT_MS wait (both read in claude 2.1.317,
// 2.1.322 and 2.1.316's code); that claude runs the job's command under dontAsk with the worker hooks;
// that node can read orchestrate's code from inside the sandbox; that safe-git's temporary folder is writable there.
// The 10 minutes of LOCKED_MS (and check 11's BASELINE_MS, guardedRun, #463 r2 M3) is our own cap, a choice, not a tool
// limit (#463 r3 m2): the Bash tool's longest wait is BASH_MAX_TIMEOUT_MS when it is set (2.1.317, 2.1.322, 2.1.316), and the runner
// sets it to the job's limit. A product whose tests need longer splits its test command, or the cap is raised here.
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn as childSpawn } from 'node:child_process';
import { lockedRunCommand } from '../modules/M4-workshop/launcher/launch.mjs';
import { roleArgs } from '../modules/M4-workshop/launcher/readback.mjs';
import { DESIGN_PROFILES } from '../modules/M4-workshop/launcher/role-profiles.mjs';
import { SESSION_ID } from '../shared/record.mjs';
import { groupThere } from './runner-ports.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { RUNNER_PORT_MS } from './worker-runner.mjs';
import { RUNNER_TICK_MS, leaderStart, processGroupPorts } from './runner-loop.mjs';
import { lstartIso } from '../modules/M9-record/lock.mjs';
import { ASK_POLL_MS } from './owner-asks.mjs';
import { SETTINGS as S } from '../modules/M4-workshop/launcher/settings-names.mjs';

export const LOCKED_JOBS = Object.freeze(['save-work', 'install']);
/**
 * The install's limit, and the cap on every guardedRun (check 11's baseline too, #463 r2 M3): 10 minutes, our own choice
 * (#463 r3 m2), not a tool limit. Each run's limit is given to the command's claude as both the Bash tool's default and its
 * longest wait (BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, #463 r2 m1; read in claude 2.1.317, 2.1.322 and the pin,
 * 2.1.316: checked: claude-code 2.1.316), so the tool never moves the command to the background and ends its turn while it runs.
 */
export const LOCKED_MS = 10 * 60_000;
/** How often the job's process-group record is looked for while claude runs (#463 r2 M1). */
export const JOB_GROUP_POLL_MS = 100;
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
//
// job (#463 r2 M1), when given: { read() → the job's own process group { pgid, pid, pid_start } as its command recorded
// it, or null while none is recorded (a throw: a record that can't be trusted), gone(g) → true | false (a throw: can't
// tell; runner-loop.mjs processGroupPorts' groupGone, the leader's start time checked), found(g) (told the job's group,
// when it is not claude's), ack() (the go-ahead the job's shell waits for: given only after found, and never on a stop
// or a close, so a job whose group is not kept never runs), everyMs }. Claude's Bash tool
// runs each command detached, in a process group of its own (read in claude 2.1.317, 2.1.322 and the
// pin, 2.1.316: checked: claude-code 2.1.316; Mini proof 9 runs it), so killing claude's group
// leaves the job running. The record is read every everyMs while claude runs, and once more at every end; the job's
// group is then killed with claude's on the time limit and on every stop, and at claude's close: one still there then is
// killed and said (`job.left` 'killed'; 'unknown' when it can't be told), so runLocked refuses it (#463 r2 m6).
export function runToEnd(spawn, bin, args, opts, timeoutMs, kill = (g) => process.kill(-g, 'SIGKILL'), there = groupThere, onSpawn, job) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { ...opts, detached: true, stdio: ['ignore', 'ignore', 'ignore'] }); } catch (e) { reject(e); return; }
    const group = () => Number.isInteger(child.pid) && child.pid > 1;
    // The job's group once read (`jg`); `seen` also when the record named claude's own group (nothing more to kill).
    let jg = null; let seen = false;
    // go: answer the job's shell once its group is kept, so the job runs; never at a stop or after claude closed.
    const look = (go) => {
      if (!job || seen) return;
      const g = job.read();
      if (!g) return;
      seen = true;
      if (g.pgid !== child.pid) { jg = g; job.found?.(g); }
      if (go) job.ack?.();
    };
    // → 'gone' | 'killed' | 'unknown'. A group whose leader is not the recorded one (another start time) reads as gone
    // and is never signalled; one that can't be told about is not signalled either.
    const endJob = () => {
      if (!jg) return 'gone';
      let gone; try { gone = job.gone(jg) === true; } catch { return 'unknown'; }
      if (gone) return 'gone';
      try { kill(jg.pgid); } catch { /* gone in between */ }
      return 'killed';
    };
    // A child with no pid (its spawn failed: no cwd, no claude) is never signalled: node's kill() of it would signal
    // pid 0, the runner's own process group (#463 r1 self-review M1). Its 'error' ends the run.
    const stop = () => {
      try { if (group()) kill(child.pid); } catch { try { if (group()) child.kill('SIGKILL'); } catch { /* gone */ } }
      try { look(false); } catch { /* a record that can't be trusted: nothing more is signalled */ }
      return endJob();
    };
    const said = (left) => (left === 'unknown' ? '; its job\'s own process group may still run' : '');
    let t; let poll;
    const done = () => { clearTimeout(t); clearInterval(poll); };
    child.on('error', (e) => { done(); reject(e); });
    child.on('close', (code) => {
      done();
      try { if (group() && there(child.pid)) kill(child.pid); } catch { /* none of the group is left */ }
      let bad = null; try { look(false); } catch (e) { bad = e?.message ?? String(e); }
      const left = endJob();
      resolve({ exitCode: code, ...(job ? { job: { recorded: seen, left, ...(bad ? { bad } : {}) } } : {}) });
    });
    // No group (the spawn failed): the 'error' above rejects with the spawn's own reason; only the time limit is set.
    if (group() && typeof onSpawn === 'function') {
      try { onSpawn(child.pid); } catch (e) {
        const left = stop(); done();
        reject(new Error(`its process group can't be kept (${e?.message ?? e}), so it is stopped${said(left)}`)); return;
      }
    }
    if (job && group()) {
      poll = setInterval(() => {
        try { look(true); } catch (e) { const left = stop(); done(); reject(new Error(`its job's process group can't be kept (${e?.message ?? e}), so it is stopped${said(left)}`)); }
      }, job.everyMs);
    }
    t = setTimeout(() => { const left = stop(); done(); reject(new Error(`it did not finish in time${said(left)}`)); }, timeoutMs);
  });
}

/**
 * How claude runs one command inside a lock-down (guardedRun's last step, for runLocked's jobs and check 11's baseline): claude
 * with the Bash tool only and `settingsFile`, in `cwd`, to its end or `ms`. → { exitCode } (claude's own), or a throw.
 * `--setting-sources ''` (#463 r1 m4, as owner-answer.mjs runs claude): no user, project or local settings file is
 * loaded, the copy's own `.claude/settings*.json` least of all; only `--settings` and the machine-wide file are.
 */
export async function runLockedCommand({ spawn, claudeBin, settingsFile, command, profile, cwd, env, ms, killGroup, groupThere: there, onSpawn, job }) {
  const lr = lockedRunCommand({ claudeBin, settingsFile, command, roleArgs, profile });
  if (!lr.ok) throw new Error(lr.reason);
  const args = [...lr.args.slice(0, -1), '--setting-sources', '', lr.args[lr.args.length - 1]];
  return runToEnd(spawn, lr.bin, args, { cwd, env }, ms, killGroup, there, onSpawn, job);
}

/**
 * #463 r2 M3 (L1010): the one way claude runs a long command (an install, a save, check 11's baseline), with its own
 * process group kept (#463 r2 M1) and the Bash tool's wait set to the limit (m1). `inner` is the command; it runs only
 * after its shell's record (groupRecordCommand into `gfile`) is read, kept (onGroup: claude's group, then the same record
 * with `job`) and answered. → runToEnd's { exitCode, job: { recorded, left, bad? } } (jobGroupProblem says what is
 * wrong with it), or a throw (`label`'s old record can't be removed, marked `beforeRun`; a spawn, a time limit or a
 * group that can't be kept).
 * The record and its answer are removed before and after.
 */
export async function guardedRun({ spawn, claudeBin, settingsFile, inner, profile, cwd, env, ms, killGroup, groupThere: there, gfile, onGroup, label,
  read = readNoLink, info = processInfo, pidStartOf = leaderStart, jobGone = processGroupPorts().groupGone, pollMs = JOB_GROUP_POLL_MS,
  answer = answerFile, rm = rmSync }) {
  if (!env || typeof env !== 'object') throw new Error(`no environment to run ${label} with`);
  if (!Number.isInteger(ms) || ms <= 0 || ms > LOCKED_MS) throw new Error(`${label}'s limit is not a time limit within the lock-down's cap (${LOCKED_MS} ms)`);
  // The Bash tool's own wait is the limit (#463 r2 m1): it never moves the command to the background before it.
  const wait = { ...env, BASH_DEFAULT_TIMEOUT_MS: String(ms), BASH_MAX_TIMEOUT_MS: String(ms) };
  // Claude's start time bounds the record: { pgid, pid, pid_start, job?: { pgid, pid, pid_start } }.
  let since = null; let held = null;
  const onSpawn = (pid) => {
    let at = null; try { at = pidStartOf(pid); } catch { at = null; }
    if (typeof at !== 'string' || !at) throw new Error('its start time can\'t be read');
    since = at; held = { pgid: pid, pid, pid_start: at };
    if (typeof onGroup === 'function') onGroup({ ...held });
  };
  const watch = { everyMs: pollMs, read: () => readGroupRecord(gfile, { since, read, info, startOf: pidStartOf }), gone: jobGone,
    found: (g) => { if (typeof onGroup === 'function') onGroup({ ...held, job: { ...g } }); },
    // The answer the shell waits for: written only once its group is kept.
    ack: () => { try { answer(ackFile(gfile)); } catch (e) { throw new Error(`the job's go-ahead can't be written (${e?.code ?? e?.message})`); } } };
  for (const [f, what] of [[gfile, 'process-group record'], [ackFile(gfile), 'go-ahead']]) {
    try { rm(f, { force: true }); } catch (e) { throw Object.assign(new Error(`${label}'s old ${what} can't be removed (${e?.code ?? e?.message})`), { beforeRun: true }); }
  }
  try {
    return await runLockedCommand({ spawn, claudeBin, settingsFile, command: `${groupRecordCommand(gfile)} && { ${inner}; }`, profile, cwd, env: wait, ms, killGroup, groupThere: there, onSpawn, job: watch });
  } finally { for (const f of [gfile, ackFile(gfile)]) try { rm(f, { force: true }); } catch { /* left; removed before the next run */ } }
}

/** What guardedRun's end says is wrong with the command's own group (#463 r2 M1, m6), or null. `recorded`: also refuse
 *  a run whose record was never read (it did not run as the runner runs it). `killedOk`: a group still there at claude's
 *  end, and killed then, is not a refusal (check 11's baseline, whose copy is thrown away). */
export function jobGroupProblem(r, label, { recorded = true, killedOk = false } = {}) {
  if (r?.job?.bad) return `${label}'s process group can't be kept (${r.job.bad}; ${claudeEnd(r)})`;
  if (r?.job?.left === 'killed' && !killedOk) return `${label} was still running after claude ended (${claudeEnd(r)}); its process group was stopped`;
  if (r?.job?.left !== 'gone' && !(killedOk && r?.job?.left === 'killed')) return `${label} may still be running after claude ended (${claudeEnd(r)}); its process group can't be told about`;
  if (recorded && r?.job?.recorded !== true) return `${label}'s process group was not recorded, so it did not run as the runner runs it (${claudeEnd(r)})`;
  return null;
}

const answerFile = (f) => writeFileSync(f, '', { flag: 'wx', mode: 0o600 });

/** Claude's own end, said beside a job's answer (#463 r1 c3). */
export const claudeEnd = (r) => (r?.exitCode === null ? 'claude was ended by a signal' : `claude exited ${r?.exitCode}`);

/** The job's result file: in the folder it runs in, named for the job and the session. */
export const jobFile = ({ cwd, job, sessionId }) => join(cwd, `.orch-job-${job}-${sessionId}`);

/** The job's process-group record (#463 r2 M1): beside the result file, written by the job's own shell. `run`: a fresh
 *  name part for each run (self-review m2), so a shell left from an earlier run never takes this run's go-ahead. */
export const groupFile = ({ cwd, job, sessionId, run }) => join(cwd, `.orch-job-${job}-${sessionId}.group${run ? `.${run}` : ''}`);

/** The runner's answer to the record (#463 r2 M1): the job runs only once it is there. */
export const ackFile = (gfile) => `${gfile}.ok`;
/** How long the job's shell waits for that answer before it gives up (the job then never runs). */
export const JOB_ACK_WAIT_MS = 10_000; // a runner slowed by other ports' waits still answers in time (self-review m7)

/**
 * The shell words that start a job (#463 r2 M1): the shell claude's Bash tool runs it in writes its own pid, as a new
 * file (noclobber, never through one already there), then waits up to JOB_ACK_WAIT_MS for the runner's answer
 * (ackFile). The runner, outside the sandbox, reads that pid's process group and its leader's start time while the
 * shell waits, keeps them, and only then answers; so the group is known before the job (or any of an install's
 * scripts) runs, and nothing the job does can change what was kept. No ps runs inside the sandbox: /bin/ps is setuid,
 * which a sandboxed process can't run (seen under sandbox-exec on this Mac). A record that can't be made, or no answer,
 * stops the job before it runs, so its result is never written.
 */
export const groupRecordCommand = (gfile) => {
  const ack = quoted(ackFile(gfile));
  return `( set -C; /bin/echo $$ > ${quoted(gfile)} ) && n=0 && while [ ! -e ${ack} ] && [ $n -lt ${JOB_ACK_WAIT_MS / 50} ]; do /bin/sleep 0.05; n=$((n+1)); done && [ -e ${ack} ]`;
};

/** A process's group and start time, read outside the sandbox (ps in UTC and the C locale, M9's form): { pgid, start } or null. */
export function processInfo(pid, { run = execFileSync, timeoutMs = 1_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = run('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, env: { PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' } });
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(String(out));
    const start = m ? lstartIso(m[2]) : null;
    return m && start ? { pgid: Number(m[1]), start } : null;
  } catch { return null; }
}

/**
 * The job's process group from its shell's record, or null while there is none (a record with no line break yet is still
 * being written). → { pgid, pid, pid_start } of the group's leader. A throw: a record not in its form, a shell or leader
 * that can't be read, or one that started before claude (`since`, claude's start time, UTC ISO), so not one claude's Bash
 * tool made. The shell is still waiting for the runner's answer when this reads it, so it is there to be read.
 */
export function readGroupRecord(file, { since, read = readNoLink, info = processInfo, startOf = leaderStart } = {}) {
  let text;
  try { text = read(file, { max: 64 }).toString('utf8'); } catch (e) { if (e?.code === 'ENOENT') return null; throw new Error(`the job's process-group record can't be read (${e?.code ?? e?.message})`); }
  if (!text.endsWith('\n')) return null;
  const pid = /^\d{1,10}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  if (!(Number.isInteger(pid) && pid > 1)) throw new Error('the job\'s process-group record is not in its form');
  const me = info(pid);
  if (!me || !(Number.isInteger(me.pgid) && me.pgid > 1)) throw new Error(`the job's shell ${pid} can't be read`);
  const at = me.pgid === pid ? me.start : startOf(me.pgid);
  if (typeof at !== 'string' || !at) throw new Error(`the job's process group ${me.pgid} has no leader whose start time can be read`);
  const after = (x) => typeof since === 'string' && Date.parse(x) >= Date.parse(since);
  if (!after(me.start) || !after(at)) throw new Error(`the job's process-group record names a process that did not start after claude`);
  return { pgid: me.pgid, pid: me.pgid, pid_start: at };
}

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
export function lockedRunner({ claudeBin, envOf, spawn = childSpawn, node = process.execPath, jobsDir = JOBS_DIR, ms = LOCKED_MS, saveMs = LOCKED_SAVE_MS, killGroup, groupThere: there, rm = rmSync, read = readNoLink, pidStartOf = leaderStart, jobGone = processGroupPorts().groupGone, pollMs = JOB_GROUP_POLL_MS, info = processInfo, answer = answerFile, nonce = () => randomBytes(8).toString('hex') }) {
  if (typeof claudeBin !== 'string' || !claudeBin.startsWith('/')) throw new Error('the lock-down runner needs the pinned claude\'s path');
  if (typeof envOf !== 'function') throw new Error('the lock-down runner needs the sign-in environment');
  for (const [k, v] of [['ms', ms], ['saveMs', saveMs]]) if (!Number.isInteger(v) || v <= 0) throw new Error(`the lock-down runner's ${k} is not a time limit`);
  if (saveMs > LOCKED_SAVE_MS) throw new Error(`save-work's limit can't pass ${LOCKED_SAVE_MS} ms (the Dispatcher's save deadline)`);
  if (ms > LOCKED_MS) throw new Error(`the install's limit can't pass ${LOCKED_MS} ms (the lock-down's own cap)`);
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
    const gfile = groupFile({ cwd, job, sessionId, run: nonce() });
    // The job's own shell records its process group first (#463 r2 M1, guardedRun); the job runs only once that is kept.
    const inner = job === 'install' ? exitCodeCommand(command, file, 'install command')
      : `${quoted(node)} ${quoted(join(jobsDir, `${job}.mjs`))} ${quoted(Buffer.from(JSON.stringify(args ?? {})).toString('base64'))} ${quoted(file)}`;
    const limit = job === 'install' ? ms : saveMs;
    let env = given;
    if (env === undefined) try { env = envOf(); } catch (e) { throw new Error(`no sign-in to run the ${job} job with (${e?.message ?? e})`); }
    if (!env || typeof env !== 'object') throw new Error(`no environment to run the ${job} job with`);
    try { rm(file, { force: true }); } catch (e) { throw new Error(`the ${job} job's old result can't be removed (${e?.code ?? e?.message})`); }
    try {
      let r; try { r = await guardedRun({ spawn, claudeBin, settingsFile, inner, profile, cwd, env, ms: limit, killGroup, groupThere: there, gfile, onGroup, label: `the ${job} job`, read, info, pidStartOf, jobGone, pollMs, answer, rm }); } catch (e) {
        if (e?.beforeRun === true) throw e; // nothing ran: said as it is, as the result file's own removal is
        throw new Error(`the ${job} job did not finish inside the lock-down (${e?.message ?? e})`);
      }
      // Claude's own end (#463 r1 c3): one ended by a signal is refused, whatever result it left. A non-zero exit with
      // the job's result written is not: with --max-turns 1, claude may end in error after its one command has run (a
      // capability claim on the pinned claude, proven on the Mini, README item 9; checked: claude-code 2.1.316, open until
      // 2027-01-20 (R-0b-176)); it is said in every refusal below.
      if (r?.exitCode === null) throw new Error(`the ${job} job did not finish inside the lock-down (${claudeEnd(r)})`);
      // The job's own group (#463 r2 M1, m6): a record that can't be trusted, none at all, or a group still there once
      // claude closed (killed now, or not told) is a refusal of its own, whatever result it left.
      const left = jobGroupProblem(r, `the ${job} job`, { recorded: false });
      if (left) throw new Error(left);
      let text; try { text = read(file, { max: RESULT_MAX_BYTES }).toString('utf8').trim(); } catch (e) { throw new Error(`the ${job} job's result was not written (${claudeEnd(r)}; ${e?.code ?? e?.message})`); }
      if (job === 'install') {
        if (!/^\d{1,3}$/.test(text)) throw new Error(`the install's exit code is not a number (${text.slice(0, 20)}; ${claudeEnd(r)})`);
        const unrec = jobGroupProblem(r, `the ${job} job`);
        if (unrec) throw new Error(unrec);
        return Number(text) === 0 ? { ok: true } : { ok: false, reason: `the install exited ${Number(text)}` };
      }
      let a; try { a = JSON.parse(text); } catch { a = null; }
      if (!a || typeof a !== 'object' || typeof a.ok !== 'boolean' || (!a.ok && typeof a.reason !== 'string')) throw new Error(`the ${job} job's result is not its answer (${claudeEnd(r)})`);
      const unrec = jobGroupProblem(r, `the ${job} job`);
      if (unrec) throw new Error(unrec);
      return a;
    } finally { try { rm(file, { force: true }); } catch { /* left; removed before the next run of this job */ } }
  };
}

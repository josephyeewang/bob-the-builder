// Part C, runner step 4: the worker runner's loop around one pass (worker-runner.mjs), and its process-group ports.
//
// Each tick:
//   1. the request files are listed (plain *.json names, oldest first) and each read by runner-files.mjs readRequest;
//   2. one workerRunnerPass runs with them;
//   3. its memory is kept (keep) in `memoryFile`, written 0o600 by writeStatus (a new file renamed over the old), and the
//      status written to `statusFile` the same way, 0o644, so the Dispatcher can read it.
// Time (L769, step-4 review M4): within a pass no two writes are further apart than one port's wait (RUNNER_PORT_MS,
// worker-runner.mjs), and the loop sleeps RUNNER_TICK_MS after a tick's last write, so RUNNER_TICK_MS + RUNNER_PORT_MS,
// under RUNNER_STATUS_EVERY_MS, bounds the gap between any two writes. A listing that fails is noted and the pass runs
// with no requests (review M5), so the status is still rewritten and the sessions still checked.
//
// Memory (self-review M3): the memory file is read at start, and again after any tick that fails (review M1: that tick
// may have kept newer memory and removed requests before it threw; the old in-process state would undo both). A missing
// file is a first run (noted); one that
// can't be read, or is not the runner's own plain file with one name, stops the runner before any pass, because a runner
// that came back with no memory would read a stop for a session whose start was on as a launch it never saw, and cancel
// it, freeing a claim while the session may run. Starts still on (`pending`) are held in this process only: a runner
// that stops with one on comes back with its request 'waiting', which is told each pass and never used up.
//
// The process-group ports (groupGone, stopGroup) use M9's processDead and M11's stopProcessGroup (one home each):
//   - a group is gone when signal 0 to it says ESRCH, or when its leader's pid is alive under another start time (the
//     number was reused, so the group the runner started is gone: self-review M1's class). A leader that is there but
//     whose start time can't be read, or a session with no leader start time, is "can't tell" (a throw), never live:
//     the pass then keeps no alive field and sends no stop (review M2, M3);
//   - a stop's SIGTERM is sent only to a group shown to be the runner's by that rule. Between SIGTERM and SIGKILL the
//     group is checked with signal 0 alone (#362 r1 m1): a live group's number is not reused while it is there, so the
//     SIGKILL reaches a reused number only if the whole group went and its number was taken within that wait;
//   - the stop waits RUNNER_TERM_WAIT_MS for SIGTERM (signal 0 alone between, so the wait is not spent on ps), then
//     sends SIGKILL and waits up to RUNNER_KILL_WAIT_MS for the group to go (review m2). With the leader check's ps
//     (at most RUNNER_PS_MS) all of it fits inside RUNNER_PORT_MS.
// The leader's start time is read by leaderStart, the runner's one reader of it: ps in UTC and the C locale (#362 r1
// M2), so a time zone change on the Mac never makes a live group read as reused. The start port records it the same way.
// The start, save, pause, drain and size ports are runner-ports.mjs's (step 5), joined by runner-main.mjs; a loop
// without them is refused.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { realProbe } from '../modules/M9-record/lock.mjs';
import { stopProcessGroup } from '../modules/M11-dispatcher/pass.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { readRequest, writeStatus } from './runner-files.mjs';
import { RUNNER_PORT_MS, workerRunnerPass } from './worker-runner.mjs';

/** How far apart the ticks are: under the status rewrite cadence (L769). */
export const RUNNER_TICK_MS = 4_000;
/** How long a stop waits for SIGTERM before SIGKILL, and then for the group to go: inside one port's limit. */
export const RUNNER_TERM_WAIT_MS = 6_000;
export const RUNNER_KILL_WAIT_MS = 1_000;
/** The longest the leader check's ps may take (#362 r1 m1: it is counted in the stop's budget). */
export const RUNNER_PS_MS = 1_000;
if (RUNNER_TICK_MS + RUNNER_PORT_MS >= RUNNER_STATUS_EVERY_MS) throw new Error('RUNNER_TICK_MS + RUNNER_PORT_MS must be under RUNNER_STATUS_EVERY_MS');
if (RUNNER_PS_MS + RUNNER_TERM_WAIT_MS + RUNNER_KILL_WAIT_MS + 1_000 >= RUNNER_PORT_MS) throw new Error('the stop\'s ps and waits must leave room inside RUNNER_PORT_MS');

/**
 * A process's start time as ps prints it in UTC and the C locale, or null (#362 r1 M2): the one reader the runner records
 * and compares with, so the Mac's time zone or language never changes the string for the same process.
 */
export function leaderStart(pid, { run = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const out = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: RUNNER_PS_MS,
      env: { PATH: '/bin:/usr/bin', TZ: 'UTC0', LC_ALL: 'C' } });
    const t = String(out).trim();
    return t || null;
  } catch { return null; }
}
const runnerProbe = Object.freeze({ kill: realProbe.kill, pidStart: leaderStart });

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const groupKill = (pgid, sig) => process.kill(-pgid, sig);

/**
 * The process-group ports. `kill(pgid, signal)` signals a group; `probe` is { kill(pid), pidStart(pid) }: M9's kill and
 * leaderStart by default.
 * → { groupGone(session) → true | false (throws when it can't tell), stopGroup(session) → { ok, how | reason } }
 */
export function processGroupPorts({ kill = groupKill, probe = runnerProbe, sleep = sleepFor, waitMs = RUNNER_TERM_WAIT_MS, killWaitMs = RUNNER_KILL_WAIT_MS } = {}) {
  // Signal 0 to the group: true when it is gone, false when it is there, a throw when that can't be told.
  const signalGone = (pgid) => {
    try { kill(pgid, 0); return false; } catch (e) {
      if (e?.code === 'ESRCH') return true;
      if (e?.code === 'EPERM') return false; // there, but not ours to signal
      throw e;
    }
  };
  const groupGone = (s) => {
    if (!Number.isInteger(s?.pgid) || s.pgid <= 1) throw new Error('no process group');
    if (s.pid !== s.pgid || typeof s.pid_start !== 'string' || !s.pid_start) throw new Error('no group leader start time, so a reused number can\'t be told from the runner\'s group');
    // The leader's number used again by another process: the runner's group is gone, whatever signal 0 says.
    // (A leader that has exited says nothing: the rest of its group may still run, and signal 0 below tells.)
    let there = true; try { probe.kill(s.pid); } catch (e) { if (e?.code === 'ESRCH') there = false; else if (e?.code !== 'EPERM') throw e; }
    if (there) {
      const now = probe.pidStart(s.pid);
      if (typeof now !== 'string' || !now) { if (signalGone(s.pgid)) return true; throw new Error('the group leader\'s start time can\'t be read'); }
      if (now !== s.pid_start) return true;
    }
    return signalGone(s.pgid);
  };
  const stopGroup = async (s) => {
    if (groupGone(s)) return { ok: true, how: 'already gone' };
    const r = await stopProcessGroup({ pgid: s.pgid, kill, alive: (p) => !signalGone(p), sleep, waitMs });
    if (r?.how === 'SIGKILL') for (let t = 0; t < killWaitMs && !signalGone(s.pgid); t += 100) await sleep(100);
    return r;
  };
  return { groupGone, stopGroup };
}

/**
 * The runner's memory, read once at start. → {} on a first run (no file), the memory, or a throw (never a guess).
 */
export function loadMemory(file, { uid, note = () => {}, open = openSync, fstat = fstatSync, read = readFileSync, close = closeSync } = {}) {
  // A relative path would be refused at the first keep (writeStatus): said here instead (#362 r1 c3).
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('the worker runner\'s memory is not a full path');
  // Opened once, never through a link, and that open file checked and read (review m3: never check one file, read another).
  let fd;
  try { fd = open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    if (e?.code === 'ENOENT') { note('the worker runner has no memory file yet: a first run'); return {}; }
    throw new Error(e?.code === 'ELOOP' ? 'the worker runner\'s memory is a link' : `the worker runner's memory can't be opened (${e?.code ?? e?.message})`);
  }
  let m;
  try {
    const st = fstat(fd);
    if (!st.isFile()) throw new Error('the worker runner\'s memory is not a plain file');
    if (st.nlink !== 1) throw new Error('the worker runner\'s memory has more than one name');
    if (st.uid !== uid) throw new Error('the worker runner\'s memory is not the owner\'s');
    if (st.mode & 0o077) throw new Error('the worker runner\'s memory can be read or written by others');
    try { m = JSON.parse(read(fd, 'utf8')); } catch { throw new Error('the worker runner\'s memory can\'t be read'); }
  } finally { close(fd); }
  const plain = (x) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
  // The shape a pass needs (review m4): one that would make every pass throw is refused here, before any tick.
  const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  // Each session and request entry an object too (#362 r1 c1): one null would make every pass throw.
  if (!m || typeof m !== 'object' || Array.isArray(m) || !(m.sessions === undefined || (Array.isArray(m.sessions) && m.sessions.every(obj))) || !plain(m.requests)
    || !Object.values(m.requests ?? {}).every(obj) || !plain(m.answers) || !plain(m.seen)) {
    throw new Error('the worker runner\'s memory is not what the runner writes');
  }
  return m;
}

/** The request files waiting, oldest first (then by name): plain *.json names only; a dot file is a write in progress. */
export function listRequests(dir, { list = readdirSync, stat = lstatSync } = {}) {
  const names = list(dir).filter((n) => typeof n === 'string' && n.endsWith('.json') && !n.startsWith('.'));
  const at = new Map(names.map((n) => { try { return [n, stat(join(dir, n)).mtimeMs]; } catch { return [n, Infinity]; } }));
  return names.sort((a, b) => (at.get(a) - at.get(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

const PORTS = ['start', 'groupGone', 'stopGroup', 'saveWork', 'pauseLead', 'outboxDrained'];

/**
 * One tick. ctx: { state, pending, requestsDir, statusFile, memoryFile, orchestrateUid, uid, outboxRoot, copiesRoot,
 * claimMs, ports, clock?, note?, files? ({ list, stat, read, remove, write }), readNone? (the stop's last tick: no request
 * is read, so only the starts still on are settled) }. → the state to keep for the next tick.
 */
export async function runnerTick(ctx) {
  const { requestsDir, statusFile, memoryFile, orchestrateUid, ports, clock = Date.now, note = () => {}, files = {} } = ctx;
  for (const p of PORTS) if (typeof ports?.[p] !== 'function') throw new Error(`the worker runner has no ${p} port`);
  const read = files.read ?? ((f) => readRequest(f, { orchestrateUid }));
  const write = files.write ?? ((f, text, mode) => writeStatus(f, text, { mode }));
  let names = [];
  if (!ctx.readNone) try { names = listRequests(requestsDir, files); } catch (e) { note(`the worker runner's requests can't be listed (${e?.code ?? e?.message}); this pass reads none`); }
  const requests = names.map((name) => ({ name, body: read(join(requestsDir, name)) }));
  // The pass's one time for its age rules, and the clock for each write's written_at (#358 r1 M1, #362 r1 m7).
  const r = await workerRunnerPass({ ...ctx, requests, now: clock(), clock, note,
    keep: (m) => write(memoryFile, JSON.stringify(m), 0o600),
    write: (doc) => write(statusFile, JSON.stringify(doc), 0o644),
    remove: files.remove ?? ((name) => unlinkSync(join(requestsDir, name))) });
  return r.state;
}

/**
 * The loop: load the memory, then tick every RUNNER_TICK_MS until `stopWhen()` says so. A tick that throws is noted and
 * the loop goes on (the next tick rewrites the status); the memory failing to load stops it before any tick.
 */
export async function runRunner(ctx) {
  const { memoryFile, uid, sleep = sleepFor, stopWhen = () => false, note = () => {}, everyMs = RUNNER_TICK_MS, load = loadMemory, drainMs = RUNNER_PORT_MS } = ctx;
  // A cadence given in place of RUNNER_TICK_MS is held to the same bound (#362 r1 c2).
  if (!(everyMs > 0) || everyMs + RUNNER_PORT_MS >= RUNNER_STATUS_EVERY_MS) throw new Error('the worker runner\'s tick must leave a port wait under the status cadence');
  let state = load(memoryFile, { uid, note });
  const pending = new Map();
  while (!stopWhen()) {
    try { state = await runnerTick({ ...ctx, state, pending }); } catch (e) {
      note(`a worker runner tick failed (${e?.message ?? e}); the next one runs in ${everyMs} ms`);
      // What that tick kept is the memory now (review M1); one that can't be read back stops the runner (a throw).
      state = load(memoryFile, { uid, note });
    }
    if (stopWhen()) break;
    await sleep(everyMs);
  }
  // A start still on when the stop came (#364 self-review M1): the start port refuses to spawn once the runner is
  // stopping, so each start ends soon; it is waited for up to drainMs, then one last tick that reads no request settles
  // it, so a session that did start is listed in the memory the next runner reads. One still on after that is noted:
  // its request stays 'waiting', as a start on when a runner crashed does.
  if (pending.size) {
    let t; const late = new Promise((r) => { t = setTimeout(r, drainMs); });
    await Promise.race([Promise.all([...pending.values()].map((p) => p.on)), late]); clearTimeout(t);
    try { state = await runnerTick({ ...ctx, state, pending, readNone: true }); } catch (e) { note(`the worker runner's last tick failed (${e?.message ?? e})`); }
    for (const id of pending.keys()) note(`the start of ${id} was still on when the worker runner stopped; it stays waiting, so its claim stays`);
  }
  return state;
}

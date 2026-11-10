// Part C, runner step 4: the worker runner's loop around one pass (worker-runner.mjs), and its process-group ports.
//
// Each tick:
//   1. the request files are listed (plain *.json names, oldest first) and each read by runner-files.mjs readRequest;
//   2. one workerRunnerPass runs with them;
//   3. its memory is kept (keep) in `memoryFile`, written 0o600 by writeStatus (a new file renamed over the old), and the
//      status written to `statusFile` the same way, 0o644, so the Dispatcher can read it.
// The ticks are RUNNER_TICK_MS apart, under RUNNER_STATUS_EVERY_MS (L769), so the status is rewritten at that cadence
// even when no request comes.
//
// Memory (self-review M3): the memory file is read once, at start. A missing file is a first run (noted); one that
// can't be read, or is not the runner's own plain file with one name, stops the runner before any pass, because a runner
// that came back with no memory would read a stop for a session whose start was on as a launch it never saw, and cancel
// it, freeing a claim while the session may run. Starts still on (`pending`) are held in this process only: a runner
// that stops with one on comes back with its request 'waiting', which is told each pass and never used up.
//
// The process-group ports (groupGone, stopGroup) use M9's processDead and M11's stopProcessGroup (one home each):
//   - a group is gone when signal 0 to it says ESRCH, or when its leader's pid is alive under another start time (the
//     number was reused, so the group the runner started is gone: self-review M1's class);
//   - a stop is never sent to a group already gone by that rule, so a reused number is never signalled;
//   - the stop waits RUNNER_TERM_WAIT_MS for SIGTERM, then sends SIGKILL, inside RUNNER_PORT_MS.
// The start, save, pause, drain and size ports come in a later step; a loop without them is refused.

import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { processDead, realProbe } from '../modules/M9-record/lock.mjs';
import { stopProcessGroup } from '../modules/M11-dispatcher/pass.mjs';
import { RUNNER_STATUS_EVERY_MS } from './owner-status.mjs';
import { readRequest, writeStatus } from './runner-files.mjs';
import { RUNNER_PORT_MS, workerRunnerPass } from './worker-runner.mjs';

/** How far apart the ticks are: under the status rewrite cadence (L769). */
export const RUNNER_TICK_MS = 5_000;
/** How long a stop waits for SIGTERM before SIGKILL: inside one port's limit, with room for the SIGKILL. */
export const RUNNER_TERM_WAIT_MS = 6_000;
if (RUNNER_TICK_MS >= RUNNER_STATUS_EVERY_MS) throw new Error('RUNNER_TICK_MS must be under RUNNER_STATUS_EVERY_MS');
if (RUNNER_TERM_WAIT_MS + 1_000 >= RUNNER_PORT_MS) throw new Error('RUNNER_TERM_WAIT_MS must leave room inside RUNNER_PORT_MS');

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const groupKill = (pgid, sig) => process.kill(-pgid, sig);

/**
 * The process-group ports. `kill(pgid, signal)` signals a group; `probe` is M9's ({ kill(pid), pidStart(pid) }).
 * → { groupGone(session) → true | false (throws when it can't tell), stopGroup(session) → { ok, how | reason } }
 */
export function processGroupPorts({ kill = groupKill, probe = realProbe, sleep = sleepFor, waitMs = RUNNER_TERM_WAIT_MS } = {}) {
  const groupGone = (s) => {
    if (!Number.isInteger(s?.pgid) || s.pgid <= 1) throw new Error('no process group');
    // The leader's number used again by another process: the runner's group is gone, whatever signal 0 says.
    // (A leader that has exited says nothing: the rest of its group may still run, and signal 0 below tells.)
    if (s.pid === s.pgid && typeof s.pid_start === 'string' && s.pid_start) {
      let there = true; try { probe.kill(s.pid); } catch (e) { if (e?.code === 'ESRCH') there = false; }
      if (there && processDead({ pid: s.pid, pid_start: s.pid_start }, probe)) return true;
    }
    try { kill(s.pgid, 0); return false; } catch (e) {
      if (e?.code === 'ESRCH') return true;
      if (e?.code === 'EPERM') return false; // there, but not ours to signal
      throw e;
    }
  };
  const stopGroup = async (s) => {
    if (groupGone(s)) return { ok: true, how: 'already gone' };
    return stopProcessGroup({ pgid: s.pgid, kill, alive: (p) => !groupGone({ ...s, pgid: p }), sleep, waitMs });
  };
  return { groupGone, stopGroup };
}

/**
 * The runner's memory, read once at start. → {} on a first run (no file), the memory, or a throw (never a guess).
 */
export function loadMemory(file, { uid, stat = lstatSync, read = readFileSync } = {}) {
  let st;
  try { st = stat(file); } catch (e) { if (e?.code === 'ENOENT') return {}; throw new Error(`the worker runner's memory can't be checked (${e?.code ?? e?.message})`); }
  if (!st.isFile() || st.isSymbolicLink?.()) throw new Error('the worker runner\'s memory is not a plain file');
  if (st.nlink !== 1) throw new Error('the worker runner\'s memory has more than one name');
  if (st.uid !== uid) throw new Error('the worker runner\'s memory is not the owner\'s');
  if (st.mode & 0o077) throw new Error('the worker runner\'s memory can be read or written by others');
  let m; try { m = JSON.parse(read(file, 'utf8')); } catch { throw new Error('the worker runner\'s memory can\'t be read'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('the worker runner\'s memory is not what the runner writes');
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
 * claimMs, ports, clock?, note?, files? ({ list, stat, read, remove, write }) }. → the state to keep for the next tick.
 */
export async function runnerTick(ctx) {
  const { requestsDir, statusFile, memoryFile, orchestrateUid, ports, clock = Date.now, note = () => {}, files = {} } = ctx;
  for (const p of PORTS) if (typeof ports?.[p] !== 'function') throw new Error(`the worker runner has no ${p} port`);
  const read = files.read ?? ((f) => readRequest(f, { orchestrateUid }));
  const write = files.write ?? ((f, text, mode) => writeStatus(f, text, { mode }));
  const requests = listRequests(requestsDir, files).map((name) => ({ name, body: read(join(requestsDir, name)) }));
  const r = await workerRunnerPass({ ...ctx, requests, now: clock(), note,
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
  const { memoryFile, uid, sleep = sleepFor, stopWhen = () => false, note = () => {}, everyMs = RUNNER_TICK_MS, load = loadMemory } = ctx;
  let state = load(memoryFile, { uid });
  if (!Object.keys(state).length) note('the worker runner has no memory yet: a first run');
  const pending = new Map();
  while (!stopWhen()) {
    try { state = await runnerTick({ ...ctx, state, pending }); } catch (e) { note(`a worker runner tick failed (${e?.message ?? e}); the next one runs in ${everyMs} ms`); }
    if (stopWhen()) break;
    await sleep(everyMs);
  }
  return state;
}

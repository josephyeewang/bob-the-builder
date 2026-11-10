#!/usr/bin/env node
// robot-main.mjs — the script the robot job runs (R-0b-162 B; LEAD-CALLS L236, L238): `node robot-main.mjs <config.json>`.
//
// One run is one round of the robot passes (robot-wiring.mjs ROBOT_PASSES), each under its own time limit, under a
// single-instance lock of its own. The config is the Dispatcher's shape (M11 main.mjs readConfig: wiring, lockFile,
// runDeadlineMs) plus what the wiring module checks. The same guards as main.mjs, reused from it: the watchdog thread,
// the run deadline, a dead holder's lock broken and told.
//
// A pass that throws, refuses or runs late is told to the owner through the Record's alert queue (M11 pass.mjs holdAlert, once
// per pass per day), and the other passes still run. An alert the queue refuses ("could not be queued") is logged, never
// dropped in silence (L130 m12, as M11 main.mjs). The queue is sent by the robot job's own last pass, `deliver` (L242,
// robot-wiring.mjs), never by this file directly.
// Exit 0 when the round ran or another round was running; 1 when the config or the wiring could not be loaded; 2 when the
// round ran past its deadline. Exit 1 reaches only the job's log today: nothing tells the owner that this job never starts until
// M13's heartbeatOnce is wired and the outside check sees its heartbeat go stale (a first-cutover checklist condition). One
// exception: a store that stopped the start is told to the owner (L587), through the robot App's store-free channel
// (robot-wiring.mjs robotChannel, L727), or a `stopChannel` ({ gh, owner }) a test injects. A config with no robot App
// gets no channel, and the stop is only logged.
//
// A pass that ran past its time limit may still be running (a race stops the waiting, not the pass). The round then
// keeps its lock, as M11 does for a late pass: the process exits, and the next start breaks the dead lock and says so.

import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readConfig, startWatchdog, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { takePassLock } from '../modules/M11-dispatcher/pass-lock.mjs';
import { holdAlert } from '../modules/M11-dispatcher/pass.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { tellStoreStopped } from '../modules/M13-ledger/store-stopped.mjs';
import { ROBOT_PASSES, robotChannel } from './robot-wiring.mjs';

export const PASS_DEADLINE_MS = 120_000;
export const RUN_DEADLINE_MS = ROBOT_PASSES.length * PASS_DEADLINE_MS + 20_000;
export const CAUSE = (pass) => `robot-${pass}`;

export const NOT_QUEUED = 'could not be queued';

/**
 * One round: every pass in order, each with its own deadline. → { [pass]: { ok, result } | { ok: false, error, timedOut?,
 * tell? } }. `tell` says why the owner was NOT told of a failure (the queue refused it, or the queue threw). `hold` is a port
 * for a test only.
 */
export async function runPasses({ rec, passes, now, passDeadlineMs = PASS_DEADLINE_MS, hold = holdAlert }) {
  const res = {};
  const alert = outbox(rec, now());
  for (const name of ROBOT_PASSES) {
    let timer; let timedOut = false;
    try {
      if (typeof passes[name] !== 'function') throw new Error(`the wiring has no ${name} pass`);
      // unref: a pass that hangs on nothing must not hold the process open; the round's own deadline (main) still runs.
      const late = new Promise((_, no) => { timer = setTimeout(() => { timedOut = true; no(new Error(`it did not finish within ${passDeadlineMs} ms`)); }, passDeadlineMs); timer.unref?.(); });
      const result = await Promise.race([Promise.resolve().then(passes[name]), late]);
      // A pass may refuse by answering { refused } instead of throwing (lane 3's deliverAlertsPass, L242): that is a failed
      // pass, told like a throw, never counted as done, whatever the refusal's type (audit #137 M9).
      if (result?.refused) throw new Error(typeof result.refused === 'string' ? result.refused : `it refused (${JSON.stringify(result.refused)})`);
      res[name] = { ok: true, result };
    } catch (e) {
      const error = String(e?.message ?? e);
      res[name] = { ok: false, error, ...(timedOut ? { timedOut: true } : {}) };
      // A pass may say why its own alert was not queued (robot-wiring.mjs heartbeat): kept with the failure.
      if (e?.tell) res[name].tell = String(e.tell);
      try {
        if (hold({ rec, cause: CAUSE(name), text: `the robot job's ${name} pass failed: ${error}; the other passes still ran`, alert, now: now() }) === false) res[name].tell = NOT_QUEUED;
      } catch (e2) { res[name].tell = String(e2?.message ?? e2); }
    } finally { clearTimeout(timer); }
  }
  return res;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));

// `self`: this script's real path, checked as one of the installed copy's code files (audit #144 m4).
export async function main(argv, { now = () => Date.now(), log = (s) => process.stderr.write(`${s}\n`), watchdog = false, wireOpts = {}, hold = holdAlert, passDeadlineMs = PASS_DEADLINE_MS, self = SELF, startDog = startWatchdog } = {}) {
  let config; let wired;
  let dog = watchdog ? startDog(RUN_DEADLINE_MS + WATCHDOG_MARGIN_MS) : null;
  try {
    if (!argv[0]) throw new Error('usage: robot-main.mjs <config.json>');
    config = readConfig(argv[0], { self });
    const limit = config.runDeadlineMs ?? RUN_DEADLINE_MS;
    if (dog && config.runDeadlineMs !== undefined) { dog.terminate(); dog = startDog(limit + WATCHDOG_MARGIN_MS); }
    const mod = await import(pathToFileURL(config.wiring).href);
    if (typeof mod.wire !== 'function') throw new Error('the wiring module has no wire()');
    wired = await mod.wire(config, { now, log, ...wireOpts });
  } catch (e) {
    log(`robot: not started: ${e.message}`);
    // A store that won't open has no alert queue, so this is told here, once per reason (L587).
    if (e?.stop) await tellStoreStopped({ stop: e.stop, product: config?.product, channel: wireOpts.stopChannel ?? robotChannel(config, { log, fetchFn: wireOpts.fetchFn }), log });
    dog?.terminate();
    return 1;
  }
  const { rec, passes } = wired;
  const l = takePassLock(config.lockFile, { now: now() });
  if (!l.ok) { log(`robot: ${l.reason}`); dog?.terminate(); return 0; }
  const limit = config.runDeadlineMs ?? RUN_DEADLINE_MS;
  // One tell, with its refusal logged (L130 m12): a queue that answers false or throws is never silent.
  const tell = (what, text) => {
    try { if (hold({ rec, cause: 'robot-run-late', text, alert: outbox(rec, now()), now: now() }) === false) log(`robot: ${what} ${NOT_QUEUED}`); }
    catch (e) { log(`robot: ${what} could not be told: ${e?.message ?? e}`); }
  };
  let timer; let keepLock = false;
  try {
    if (l.broke) tell('the stopped round', `the last robot job round (taken ${l.broke.taken_at ?? 'at an unknown time'}) was stopped before it finished; this round runs as usual`);
    const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), limit); });
    const r = await Promise.race([runPasses({ rec, passes, now, hold, passDeadlineMs }), late]);
    if (r.late) {
      log(`robot: the round did not finish within ${limit} ms; exiting so the next start can run`);
      tell('the late round', `a robot job round did not finish within ${limit} ms and was stopped; the next round starts in a minute`);
      keepLock = true;   // a pass may still run: the lock stays until the process exits (audit #137 M7)
      return 2;
    }
    for (const [p, v] of Object.entries(r)) {
      if (!v.ok) log(`robot: ${p} failed: ${v.error}${v.tell ? ` (and could not be told: ${v.tell})` : ''}`);
      if (v.timedOut) keepLock = true;   // audit #137 M7, as above
      // A pass that ran but could not do all of it (deliver's unsent alerts) is logged (audit #137 M9).
      if (v.ok && Number(v.result?.failed) > 0) log(`robot: ${p} ran, and ${v.result.failed} of its items failed`);
    }
    if (keepLock) log('robot: a pass ran past its time limit and may still be running; the lock stays until this process exits');
    // A kept lock needs the watchdog: a pass that goes on to block the thread would otherwise hold the lock for good, and
    // every later round would exit 0 (audit #150 M2; M11 main.mjs: past the deadline the watchdog stays).
    if (!keepLock) dog?.terminate();
    return 0;
  } finally { clearTimeout(timer); if (!keepLock) l.release(); }
}

if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  const code = await main(process.argv.slice(2), { watchdog: true });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

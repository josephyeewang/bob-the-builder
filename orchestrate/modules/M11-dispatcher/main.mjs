#!/usr/bin/env node
// The script the login job runs (R-0b-55, R-0b-65; audit 0b-6 MAT-1): `node main.mjs <config.json>`.
//
// The config names every path; nothing here names a machine:
//   { "installRoot": "/abs/install", "wiring": "/abs/install/<code file>.mjs", "lockFile": "/abs/path/dispatcher.lock" }
// It is read through shared/job-config.mjs (L253): the config and the wiring must be the installed copy's own, root's
// or this job's user's alone, never links, or nothing starts.
// and, optionally, "runDeadlineMs" (a positive number; RUN_DEADLINE_MS when absent).
// The wiring module (built with the module that joins the real ports, not in this folder) exports
// `async function wire(config, { limitedSync })` returning exactly { rec, rules, ports } — see README, "The tick's ports".
// Any other key is refused (audit #127 r2 m-B): a wiring answering `lock` or `now` must not replace the lock or the clock.
// One run is one full pass under the single-instance lock. Exit 0 when the pass ran or another pass
// was running; exit 1 when the config or the wiring could not be loaded (launchd logs stderr); exit 2
// when the pass ran past RUN_DEADLINE_MS (audit 0b-6 r3 MAT-2), and Joe is told once a day (L38). The script then exits outright, so a
// port that never answers cannot keep the process, and with it the pass lock, alive: the next start
// finds the lock's pid dead and breaks it.
// A port that blocks the thread outright (a synchronous call that never returns) stops every timer here
// too, so the script also starts a watchdog thread (audit 0b-6 r4 MAT-3): WATCHDOG_MARGIN_MS after the
// run deadline it ends the process from outside. The next start breaks the lock and tells Joe (tick.mjs
// `runTick`).

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { readJobConfig } from '../../shared/job-config.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { runTick, STEPS, STEP_DEADLINE_MS } from './tick.mjs';
import { outbox, sendAlerts, ALERT_SEND_MS, ALERT_BUDGET_MS } from './alerts.mjs';
import { holdAlert } from './pass.mjs';
import { limitedSync } from './sync-limit.mjs';

// Every step at its own deadline and the pass's two sends (alerts.mjs), plus a margin: past this the pass is stuck.
export const RUN_DEADLINE_MS = STEPS.length * STEP_DEADLINE_MS + 2 * ALERT_BUDGET_MS + 20_000;
// Room for the late alert's one send before the watchdog ends the process (audit 0b-6 r7 m1).
export const WATCHDOG_MARGIN_MS = ALERT_SEND_MS + 5_000;
// What wire() returns, and all it may return (audit #127 r2 m-B).
export const WIRED_KEYS = Object.freeze(['rec', 'rules', 'ports']);

/** A thread of its own that kills this process after `ms`, however blocked the main thread is. */
export function startWatchdog(ms) {
  const code = `const { workerData: d } = require('node:worker_threads');
setTimeout(() => { require('node:fs').writeSync(2, 'dispatcher: the pass was blocked past ' + d.ms + ' ms; the watchdog ends it\\n'); process.kill(d.pid, 'SIGKILL'); }, d.ms);`;
  const w = new Worker(code, { eval: true, workerData: { ms, pid: process.pid } });
  w.unref();
  return w;
}

/**
 * Warnings the store holds in this process's memory (a full disk) die when it exits: their lines are tried once more,
 * in case the disk has room again (#260 r2 M1 b; the store's heldHere writes back what the disk takes). Any still held
 * stay in the store's held flag, which the robot's delivery pass tells; the log says so too. Never throws.
 */
export function flushHeld(rec, log) {
  try {
    const h = rec?.heldHere?.();
    if (h?.error) log(`dispatcher: what the store holds in memory could not be read: ${h.error}`);
    else if (h?.held?.length || h?.dropped) log(`dispatcher: ${h.held.length} warning(s) the store could not write${h.dropped ? ` and ${h.dropped} lost count(s)` : ''} are held in this process only and end with it; the held flag tells the robot's alert pass`);
  } catch (e) { log(`dispatcher: the store's held warnings could not be tried again: ${e?.message ?? e}`); }
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));

export function readConfig(file, opts = {}) {
  const c = readJobConfig(file, { code: ['wiring'], ...opts });
  for (const k of ['wiring', 'lockFile']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.runDeadlineMs !== undefined && !(Number.isFinite(c.runDeadlineMs) && c.runDeadlineMs > 0)) throw new Error('config: runDeadlineMs must be a positive number');
  return c;
}

// `self`: this script's real path, checked as one of the installed copy's code files (audit #144 m4); a test names a
// file inside its own layout.
export async function main(argv, { now, clock, log = (s) => process.stderr.write(`${s}\n`), runDeadlineMs, watchdog = false, readConfigFn = readConfig, self = SELF } = {}) {
  // The clock is main's own, never the wiring's (audit #127 r2 m-B). The tick reads it before each step, so no wait is
  // written with a `now` gone stale over a long pass (L321: the Store Writer refuses a since more than 60 s off its
  // clock). A test that names a fixed `now` and no clock keeps a fixed clock.
  const clockFn = clock ?? (now === undefined ? () => Date.now() : () => now);
  now ??= clockFn();
  let config;
  let wired;
  // The watchdog starts first (audit 0b-6 r5 MAT-1): a wiring whose import or wire() never finishes would
  // otherwise keep this process, and so every later start, from running. It starts on the default deadline
  // and is replaced once the config names its own. Past it the process ends with a line on stderr; no alert
  // can be sent then, since the alert port is what the wiring builds, so a run that never gets past the wiring
  // shows as an old `last-full-pass` fact and a watchdog line in the login job's log every minute.
  let dog = watchdog ? startWatchdog((runDeadlineMs ?? RUN_DEADLINE_MS) + WATCHDOG_MARGIN_MS) : null;
  try {
    if (!argv[0]) throw new Error('usage: main.mjs <config.json>');
    config = readConfigFn(argv[0], { self });
    if (dog && runDeadlineMs === undefined && config.runDeadlineMs !== undefined) { dog.terminate(); dog = startWatchdog(config.runDeadlineMs + WATCHDOG_MARGIN_MS); }
    const mod = await import(pathToFileURL(config.wiring).href);
    if (typeof mod.wire !== 'function') throw new Error('the wiring module has no wire()');
    // Every synchronous port runs its command through limitedSync (sync-limit.mjs): a time limit each.
    wired = await mod.wire(config, { limitedSync });
    const keys = wired && typeof wired === 'object' ? Object.keys(wired) : [];
    const extra = keys.filter((k) => !WIRED_KEYS.includes(k));
    const missing = WIRED_KEYS.filter((k) => !keys.includes(k));
    if (extra.length || missing.length) throw new Error(`wire() must return exactly ${WIRED_KEYS.join(', ')}${extra.length ? `, not also ${extra.join(', ')}` : ''}${missing.length ? `; it left out ${missing.join(', ')}` : ''}`);
  } catch (e) {
    log(`dispatcher: not started: ${e.message}`);
    dog?.terminate();
    return 1;
  }
  const limit = runDeadlineMs ?? config.runDeadlineMs ?? RUN_DEADLINE_MS;
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), limit); });
  let r;
  try { r = await Promise.race([runTick({ lockFile: config.lockFile, now, clock: clockFn, rec: wired.rec, rules: wired.rules, ports: wired.ports }), late]); } finally { clearTimeout(timer); }
  // Past the deadline the watchdog stays: the late alert below could block too.
  if (!r.late) dog?.terminate();
  if (r.late) {
    log(`dispatcher: the pass did not finish within ${limit} ms; exiting so the next start can run`);
    // Joe is told too (L38), once a day: a stuck pass holds everything after the step it is stuck in.
    // Queued, then sent with one send's time: a pass that is late every time never reaches its own sender.
    // A refused alert is logged (L130 m12): the late pass is otherwise silent.
    try { if (holdAlert({ rec: wired.rec, cause: 'run-late', text: `a Dispatcher pass did not finish within ${limit} ms and was stopped; the next pass starts in a minute`, alert: outbox(wired.rec, now), now }) === false) log('dispatcher: the late-pass alert could not be queued'); await sendAlerts(wired.rec, wired.ports.alert, now, { budgetMs: ALERT_SEND_MS }); }
    catch (e) { log(`dispatcher: the late pass could not be told: ${e?.message ?? e}`); }
    flushHeld(wired.rec, log);
    return 2;
  }
  if (!r.ran) log(`dispatcher: ${r.reason}`);
  // A step's refused drop, save, note or clear: its only trace if its alert is refused too (L449).
  for (const line of r.reports ?? []) log(`dispatcher: ${line}`);
  flushHeld(wired.rec, log);
  return 0;
}

// Run as a script, not when imported. Real paths on both sides (audit 0b-6 r2 MAT-1): a folder reached
// through a symlink spells the path differently, and a mismatch here would exit 0 having done nothing.
// A port left hanging keeps handles open; the unref'd timer exits a second later, after stderr is written.
if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  const code = await main(process.argv.slice(2), { watchdog: true });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

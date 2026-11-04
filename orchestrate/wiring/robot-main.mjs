#!/usr/bin/env node
// robot-main.mjs — the script the robot job runs (R-0b-162 B; LEAD-CALLS L236, L238): `node robot-main.mjs <config.json>`.
//
// One run is one round of the robot passes (robot-wiring.mjs ROBOT_PASSES), each under its own time limit, under a
// single-instance lock of its own. The config is the Dispatcher's shape (M11 main.mjs readConfig: wiring, lockFile,
// runDeadlineMs) plus what the wiring module checks. The same guards as main.mjs, reused from it: the watchdog thread,
// the run deadline, a dead holder's lock broken and told.
//
// A pass that throws or runs late is told to Joe through the Dispatcher's alert queue (M11 pass.mjs holdAlert, once per
// pass per day), and the other passes still run. Nothing here sends: the queue's one sender is the Dispatcher's.
// Exit 0 when the round ran or another round was running; 1 when the config or the wiring could not be loaded (the job's
// log has the reason, and the heartbeat goes stale); 2 when the round ran past its deadline.

import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readConfig, startWatchdog, WATCHDOG_MARGIN_MS } from '../modules/M11-dispatcher/main.mjs';
import { takePassLock } from '../modules/M11-dispatcher/pass-lock.mjs';
import { holdAlert } from '../modules/M11-dispatcher/pass.mjs';
import { outbox } from '../modules/M11-dispatcher/alerts.mjs';
import { ROBOT_PASSES } from './robot-wiring.mjs';

export const PASS_DEADLINE_MS = 120_000;
export const RUN_DEADLINE_MS = ROBOT_PASSES.length * PASS_DEADLINE_MS + 20_000;
export const CAUSE = (pass) => `robot-${pass}`;

/** One round: every pass in order, each with its own deadline. → { [pass]: { ok, result } | { ok: false, error } } */
export async function runPasses({ rec, passes, now, passDeadlineMs = PASS_DEADLINE_MS }) {
  const res = {};
  const alert = outbox(rec, now());
  for (const name of ROBOT_PASSES) {
    let timer;
    try {
      if (typeof passes[name] !== 'function') throw new Error(`the wiring has no ${name} pass`);
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`it did not finish within ${passDeadlineMs} ms`)), passDeadlineMs); });
      const result = await Promise.race([Promise.resolve().then(passes[name]), late]);
      // A pass may refuse by answering { refused: <why> } instead of throwing (lane 3's deliverAlertsPass, L242): that is
      // a failed pass, told like a throw, never counted as done.
      if (typeof result?.refused === 'string' && result.refused) throw new Error(result.refused);
      res[name] = { ok: true, result };
    } catch (e) {
      const error = String(e?.message ?? e);
      res[name] = { ok: false, error };
      try { holdAlert({ rec, cause: CAUSE(name), text: `the robot job's ${name} pass failed: ${error}; the other passes still ran`, alert, now: now() }); }
      catch (e2) { res[name].tell = String(e2?.message ?? e2); }
    } finally { clearTimeout(timer); }
  }
  return res;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const SELF = realOf(fileURLToPath(import.meta.url));

// `self`: this script's real path, checked as one of the installed copy's code files (audit #144 m4).
export async function main(argv, { now = () => Date.now(), log = (s) => process.stderr.write(`${s}\n`), watchdog = false, wireOpts = {}, self = SELF } = {}) {
  let config; let wired;
  let dog = watchdog ? startWatchdog(RUN_DEADLINE_MS + WATCHDOG_MARGIN_MS) : null;
  try {
    if (!argv[0]) throw new Error('usage: robot-main.mjs <config.json>');
    config = readConfig(argv[0], { self });
    const limit = config.runDeadlineMs ?? RUN_DEADLINE_MS;
    if (dog && config.runDeadlineMs !== undefined) { dog.terminate(); dog = startWatchdog(limit + WATCHDOG_MARGIN_MS); }
    const mod = await import(pathToFileURL(config.wiring).href);
    if (typeof mod.wire !== 'function') throw new Error('the wiring module has no wire()');
    wired = await mod.wire(config, { now, log, ...wireOpts });
  } catch (e) {
    log(`robot: not started: ${e.message}`);
    dog?.terminate();
    return 1;
  }
  const { rec, passes } = wired;
  const l = takePassLock(config.lockFile, { now: now() });
  if (!l.ok) { log(`robot: ${l.reason}`); dog?.terminate(); return 0; }
  const limit = config.runDeadlineMs ?? RUN_DEADLINE_MS;
  let timer;
  try {
    if (l.broke) {
      try { holdAlert({ rec, cause: 'robot-run-late', text: `the last robot job round (taken ${l.broke.taken_at ?? 'at an unknown time'}) was stopped before it finished; this round runs as usual`, alert: outbox(rec, now()), now: now() }); }
      catch (e) { log(`robot: the stopped round could not be told: ${e?.message ?? e}`); }
    }
    const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), limit); });
    const r = await Promise.race([runPasses({ rec, passes, now }), late]);
    if (r.late) {
      log(`robot: the round did not finish within ${limit} ms; exiting so the next start can run`);
      try { holdAlert({ rec, cause: 'robot-run-late', text: `a robot job round did not finish within ${limit} ms and was stopped; the next round starts in a minute`, alert: outbox(rec, now()), now: now() }); }
      catch (e) { log(`robot: the late round could not be told: ${e?.message ?? e}`); }
      return 2;
    }
    for (const [p, v] of Object.entries(r)) if (!v.ok) log(`robot: ${p} failed: ${v.error}${v.tell ? ` (and could not be told: ${v.tell})` : ''}`);
    dog?.terminate();
    return 0;
  } finally { clearTimeout(timer); l.release(); }
}

if (SELF && process.argv[1] && SELF === realOf(process.argv[1])) {
  const code = await main(process.argv.slice(2), { watchdog: true });
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

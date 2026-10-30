#!/usr/bin/env node
// The script the login job runs (R-0b-55, R-0b-65; audit 0b-6 MAT-1): `node main.mjs <config.json>`.
//
// The config names every path; nothing here names a machine:
//   { "wiring": "/abs/path/wiring.mjs", "lockFile": "/abs/path/dispatcher.lock" }
// and, optionally, "runDeadlineMs" (a positive number; RUN_DEADLINE_MS when absent).
// The wiring module (built with the module that joins the real ports, not in this folder) exports
// `async function wire(config)` returning { rec, rules, ports } — see README, "The tick's ports".
// One run is one full pass under the single-instance lock. Exit 0 when the pass ran or another pass
// was running; exit 1 when the config or the wiring could not be loaded (launchd logs stderr); exit 2
// when the pass ran past RUN_DEADLINE_MS (audit 0b-6 r3 MAT-2). The script then exits outright, so a
// port that never answers cannot keep the process, and with it the pass lock, alive: the next start
// finds the lock's pid dead and breaks it.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runTick, STEPS, STEP_DEADLINE_MS } from './tick.mjs';

// Every step at its own deadline, plus a margin: past this the pass is stuck.
export const RUN_DEADLINE_MS = STEPS.length * STEP_DEADLINE_MS + 60_000;

export function readConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['wiring', 'lockFile']) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.runDeadlineMs !== undefined && !(Number.isFinite(c.runDeadlineMs) && c.runDeadlineMs > 0)) throw new Error('config: runDeadlineMs must be a positive number');
  return c;
}

export async function main(argv, { now = Date.now(), log = (s) => process.stderr.write(`${s}\n`), runDeadlineMs } = {}) {
  let config;
  let wired;
  try {
    if (!argv[0]) throw new Error('usage: main.mjs <config.json>');
    config = readConfig(argv[0]);
    const mod = await import(pathToFileURL(config.wiring).href);
    if (typeof mod.wire !== 'function') throw new Error('the wiring module has no wire()');
    wired = await mod.wire(config);
  } catch (e) {
    log(`dispatcher: not started: ${e.message}`);
    return 1;
  }
  const limit = runDeadlineMs ?? config.runDeadlineMs ?? RUN_DEADLINE_MS;
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), limit); });
  let r;
  try { r = await Promise.race([runTick({ lockFile: config.lockFile, now, ...wired }), late]); } finally { clearTimeout(timer); }
  if (r.late) { log(`dispatcher: the pass did not finish within ${limit} ms; exiting so the next start can run`); return 2; }
  if (!r.ran) log(`dispatcher: ${r.reason}`);
  return 0;
}

// Run as a script, not when imported. Real paths on both sides (audit 0b-6 r2 MAT-1): a folder reached
// through a symlink spells the path differently, and a mismatch here would exit 0 having done nothing.
const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const self = realOf(fileURLToPath(import.meta.url));
// A port left hanging keeps handles open; the unref'd timer exits a second later, after stderr is written.
if (self && process.argv[1] && self === realOf(process.argv[1])) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

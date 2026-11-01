#!/usr/bin/env node
// loop.mjs — the Sensors' loop for the Dispatcher's readings (R-0b-169). One run is one pass; a background job runs it
// every EVERY_S seconds, the same beat as M11's own job.
//
// WHAT IT DOES. Each pass reads the five things M11 decides on, through ports, and writes each one with lane 3's
// writers (state-facts.mjs, R-0b-168): the signed-in account, that account's usage, and whether the network, the Front
// Door and Mini Base are up. It writes nothing else and edits none of those writers.
//
// THE TIME ON A READING. Each read is stamped `observed_at` from the clock taken JUST BEFORE the read starts, never
// after: a slow read can only look older than it is, so it goes stale sooner, never later. Every read also has a hard
// time limit (PROBE_DEADLINE_MS); a read that fails or runs past it is written as UNKNOWN with that same time (a value
// of null; for usage, a reading with no figures), so M11 sees "unknown now", not an old good reading that has not yet
// aged out. M11 treats a reading older than READING_MAX_AGE_MS as unknown too; EVERY_S is checked against it in the tests.
//
// Usage has no real source yet (R-0b-66, milestone 0b-6): with no `readUsage` port the pass writes the unknown reading
// every time, which is the honest state and what the heartbeat's "usage: unknown" already says.
//
// RUN AS A SCRIPT: `node loop.mjs <config.json>` with { "wiring": "/abs/path/wiring.mjs" } — the same shape as M11's
// main.mjs. The wiring exports `async function wire(config)` returning
//   { rec, ports: { whoIsSignedIn, readUsage?, probes: { network, reachable, minibase } } }
// (`rec` the real record; the probes from ./probes/, built from the wiring's own config, so no machine, product or
// account name lives here). Exit 0 when the pass ran, 1 when the config or wiring could not be loaded, 2 when the
// pass ran past RUN_DEADLINE_MS (the script then ends outright so the next start runs).

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeFactWriter } from './facts.mjs';
import { writeUsageFact, writeSignedInAccount, writeReading } from './state-facts.mjs';

export const EVERY_S = 60;
export const PROBE_DEADLINE_MS = 10_000;
// Account read (a synchronous command with its own 20 s limit), then the others at once, then the writes.
export const RUN_DEADLINE_MS = 20_000 + PROBE_DEADLINE_MS + 30_000;
export const READINGS = Object.freeze(['network', 'reachable', 'minibase']);
export const NO_USAGE = Object.freeze({ source: null, h5: { used_pct: null, resets_at: null }, week: { used_pct: null, resets_at: null } });

/** Runs `fn` with a hard time limit. → { value, failed, reason }. Never throws; a late answer is dropped. */
export async function timed(fn, ms, what) {
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), ms); });
  try {
    const r = await Promise.race([Promise.resolve().then(fn).then((value) => ({ value }), (e) => ({ error: e })), late]);
    if (r.late) return { value: null, failed: true, reason: `${what} did not answer within ${ms} ms` };
    if (r.error) return { value: null, failed: true, reason: `${what} failed (${String(r.error?.message ?? r.error).slice(0, 80)})` };
    return { value: r.value ?? null, failed: false, reason: null };
  } finally { clearTimeout(timer); }
}

/**
 * One pass. `rec` is the record; `ports` as above; `now()` → Date. → { wrote: {id: {ok, unknown, reason}}, problems: [...] }.
 * A problem is a read that failed or a write the record refused; the rest of the pass still runs.
 */
export async function sensorsPass({ rec, ports, now = () => new Date(), deadlineMs = PROBE_DEADLINE_MS }) {
  const writer = makeFactWriter(rec, { actor: 'sensors', now });
  const wrote = {}; const problems = [];
  const note = (id, r, read) => {
    wrote[id] = { ok: r?.ok === true, unknown: read.failed || read.value === null, reason: r?.ok === true ? read.reason : (r?.reason ?? read.reason) };
    if (read.failed) problems.push(`${id}: ${read.reason}`);
    if (r?.ok !== true) problems.push(`${id}: not written (${r?.reason ?? 'refused'})`);
  };
  // Each read is stamped from the clock taken before it starts; the writer gets that time as its clock.
  const read = async (fn, what) => { const before = now(); const r = await timed(fn, deadlineMs, what); return { ...r, before }; };
  const clockAt = (r) => () => r.before;

  const who = await read(() => ports.whoIsSignedIn(), 'the signed-in account read');
  note('signed-in-account', await writeSignedInAccount(writer, async () => who.value, { now: clockAt(who) }), who);

  const [usage, ...values] = await Promise.all([
    typeof ports.readUsage === 'function' && who.value ? read(() => ports.readUsage(who.value), 'the usage read') : Promise.resolve(null),
    ...READINGS.map((k) => read(() => ports.probes[k](), `the ${k} read`)),
  ]);

  if (who.value) {
    const u = usage ?? { value: null, failed: false, reason: 'no usage source yet (R-0b-66)', before: now() };
    // A failed, missing or empty usage read is written as a reading with no figures (and its time), never skipped.
    const reading = u.value && typeof u.value === 'object' ? u.value : NO_USAGE;
    const r = await writeUsageFact(writer, async () => reading, who.value, { now: clockAt(u) });
    note(`usage-${who.value}`, r, { ...u, value: u.value ?? null });
    if (!usage) problems.push('usage: no usage source yet (R-0b-66); written as unknown');
  } else problems.push('usage: no signed-in account, so no usage reading was written');

  for (const [i, k] of READINGS.entries()) {
    const v = values[i];
    note(k === 'reachable' ? 'frontdoor-reachable' : k === 'minibase' ? 'minibase-running' : 'network-up', await writeReading(writer, k, async () => v.value, { now: clockAt(v) }), v);
  }
  return { wrote, problems };
}

export function readConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof c?.wiring !== 'string' || !isAbsolute(c.wiring)) throw new Error('config: wiring must be an absolute path');
  return c;
}

export async function main(argv, { now = () => new Date(), log = (s) => process.stderr.write(`${s}\n`), runDeadlineMs = RUN_DEADLINE_MS } = {}) {
  let wired;
  try {
    if (!argv[0]) throw new Error('usage: loop.mjs <config.json>');
    const config = readConfig(argv[0]);
    const mod = await import(pathToFileURL(config.wiring).href);
    if (typeof mod.wire !== 'function') throw new Error('the wiring module has no wire()');
    wired = await mod.wire(config);
    if (!wired?.rec || !wired?.ports?.probes || typeof wired.ports.whoIsSignedIn !== 'function') throw new Error('wire() must return { rec, ports: { whoIsSignedIn, probes } }');
  } catch (e) { log(`sensors: not started: ${e.message}`); return 1; }
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok({ late: true }), runDeadlineMs); });
  let r;
  try { r = await Promise.race([sensorsPass({ ...wired, now }), late]); } finally { clearTimeout(timer); }
  if (r.late) { log(`sensors: the pass did not finish within ${runDeadlineMs} ms; exiting so the next start can run`); return 2; }
  for (const p of r.problems) log(`sensors: ${p}`);
  return 0;
}

const realOf = (p) => { try { return realpathSync(p); } catch { return null; } };
const self = realOf(fileURLToPath(import.meta.url));
if (self && process.argv[1] && self === realOf(process.argv[1])) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

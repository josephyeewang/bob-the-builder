#!/usr/bin/env node
// loop.mjs — the Sensors' loop for the Dispatcher's readings (R-0b-169). One run is one pass; a background job runs it
// every EVERY_S seconds (sensors-job.mjs, the Dispatcher's job layout).
//
// WHAT IT DOES. Each pass walks M11's READ_FACTS (the families the Dispatcher decides on) and calls each family's writer
// from R-0b-168's WRITERS (state-facts.mjs), never a writer of its own: the signed-in account, that account's usage,
// whether the network, the Front Door and Mini Base are up, and each pull request's reading. LOOP below says how each
// family is fed; a family M11 reads that LOOP lacks is named in the pass's problems, and the test fails on it.
// `limit-hit-` is not polled: the worker's exit result is written by writeLimitHit when the worker ends (lane 2 wires
// that call from M4).
//
// THE TIME ON A READING. The writers stamp observed_at from the clock just BEFORE they call their port (L97 M-2). Every
// port the loop hands them has a hard time limit (PROBE_DEADLINE_MS): a read that throws or runs past it answers
// "unknown" (null; for usage a reading with no figures; for a pull request pr-facts' unknown reading), so the fact is
// rewritten as unknown with its time and never keeps an old good value.
//
// Usage has no real source yet (R-0b-66, milestone 0b-6): with no `readUsage` port the pass writes the unknown reading
// every time, which is the honest state and what the heartbeat's "usage: unknown" already says.
//
// RUN AS A SCRIPT: `node loop.mjs <config.json>` with { "wiring": "/abs/path/wiring.mjs" }, the same shape as M11's
// main.mjs. The wiring exports `async function wire(config)` returning
//   { rec, ports: { whoIsSignedIn, readUsage?, probes: { network, reachable, minibase }, github?: { gh, owner, repo } } }
// (`rec` the real record; the probes from ./probes/, built from the wiring's own config, so no machine, product or
// account name lives here; `github` the robot's client M6 uses). Exit 0 when the pass ran, 1 when the config or wiring
// could not be loaded, 2 when the pass ran past RUN_DEADLINE_MS (the script then ends outright so the next start runs).

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeFactWriter } from './facts.mjs';
import { WRITERS } from './state-facts.mjs';
import { READ_FACTS } from '../M11-dispatcher/read-facts.mjs';
import { prReader, prsToRead } from './probes/github-pr.mjs';

export const EVERY_S = 60;
export const PROBE_DEADLINE_MS = 10_000;
// The account read, then everything else at once (each read within PROBE_DEADLINE_MS), then the writes.
export const RUN_DEADLINE_MS = 20_000 + PROBE_DEADLINE_MS + 30_000;
export const NO_USAGE = Object.freeze({ source: null, h5: { used_pct: null, resets_at: null }, week: { used_pct: null, resets_at: null } });
export const EVENT = 'written when it happens, not polled';

// How each family M11 reads is fed. Keys are READ_FACTS families (the test holds them equal both ways).
export const LOOP = Object.freeze({
  'signed-in-account': 'every pass: ports.whoIsSignedIn',
  'usage-': 'every pass, for the signed-in account: ports.readUsage (none yet: unknown)',
  'network-up': 'every pass: ports.probes.network',
  'frontdoor-reachable': 'every pass: ports.probes.reachable',
  'minibase-running': 'every pass: ports.probes.minibase',
  'pr-': 'every pass, each pull request prsToRead names: ports.github',
  'limit-hit-': EVENT,
});

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
export async function sensorsPass({ rec, ports, now = () => new Date(), deadlineMs = PROBE_DEADLINE_MS, loop = LOOP }) {
  const writer = makeFactWriter(rec, { actor: 'sensors', now });
  const wrote = {}; const problems = [];
  // A port with a time limit: a failure is noted and answers `fallback` (unknown).
  const port = (fn, what, fallback = null) => async (...a) => {
    if (typeof fn !== 'function') return fallback;
    const r = await timed(() => fn(...a), deadlineMs, what);
    if (r.failed) problems.push(`${what}: ${r.reason}`);
    return r.failed ? fallback : r.value;
  };
  const note = (id, r, unknown) => {
    wrote[id] = { ok: r?.ok === true, unknown, reason: r?.ok === true ? null : (r?.reason ?? 'refused') };
    if (r?.ok !== true) problems.push(`${id}: not written (${r?.reason ?? 'refused'})`);
  };
  const run = (family, p, opts = {}) => WRITERS[family](writer, p, { ...opts, now });
  const valueOf = (id) => rec.read('fact', id)?.doc;

  // The signed-in account first: usage is read for the account it stored (one of M4's names, or null).
  let who = null;
  const feed = {
    'signed-in-account': async () => {
      const r = await run('signed-in-account', port(ports.whoIsSignedIn, 'the signed-in account read'));
      who = r?.ok === true ? valueOf('signed-in-account')?.account ?? null : null;
      note('signed-in-account', r, who === null);
    },
    'usage-': async () => {
      if (!who) { problems.push('usage: no signed-in account, so no usage reading was written'); return; }
      if (typeof ports.readUsage !== 'function') problems.push('usage: no usage source yet (R-0b-66); written as unknown');
      const read = port(ports.readUsage, 'the usage read', NO_USAGE);
      const r = await run('usage-', async (a) => { const v = await read(a); return v && typeof v === 'object' ? v : NO_USAGE; }, { account: who });
      note(`usage-${who}`, r, valueOf(`usage-${who}`)?.h5?.used_pct == null);
    },
    'pr-': async () => {
      const g = ports.github;
      if (!g?.gh) { problems.push('pr: no GitHub client in the wiring, so no pull request was read'); return; }
      const list = await timed(() => prsToRead({ ...g, rec }), deadlineMs, 'the pull request list');
      if (list.failed) { problems.push(`pr: ${list.reason}`); return; }
      const { numbers, dropped, problem } = list.value;
      if (problem) problems.push(problem);
      if (dropped.length) problems.push(`pr: ${dropped.length} pull request(s) over this pass's limit, not read: ${dropped.join(', ')}`);
      const reader = prReader(g);
      // Each GitHub call with a time limit; a failure throws, and pr-facts writes the reading as unknown with its time.
      const strict = (fn, what) => async (...a) => { const r = await timed(() => fn(...a), deadlineMs, what); if (r.failed) throw new Error(r.reason); return r.value; };
      const gh = { pr: strict(reader.pr, 'pr'), files: strict(reader.files, 'files'), checks: strict(reader.checks, 'checks'),
        threads: strict(reader.threads, 'threads'), behindBy: strict(reader.behindBy, 'behind') };
      await Promise.all(numbers.map(async (n) => {
        const r = await run('pr-', gh, { number: n });
        const unknown = valueOf(`pr-${n}`)?.state == null;
        if (unknown) problems.push(`pr-${n}: GitHub could not be read; written as unknown`);
        note(`pr-${n}`, r, unknown);
      }));
    },
  };
  for (const [family, k] of [['network-up', 'network'], ['frontdoor-reachable', 'reachable'], ['minibase-running', 'minibase']]) {
    feed[family] = async () => {
      const r = await run(family, port(ports.probes?.[k], `the ${k} read`));
      note(family, r, valueOf(family)?.value == null);
    };
  }

  const families = READ_FACTS.map((f) => f.family);
  for (const f of families) if (!Object.hasOwn(loop, f)) problems.push(`${f}: M11 reads it and the Sensors loop has no entry for it`);
  const polled = families.filter((f) => Object.hasOwn(loop, f) && loop[f] !== EVENT);
  for (const f of polled) if (!feed[f]) problems.push(`${f}: the loop names it but has no feed for it`);
  if (polled.includes('signed-in-account')) await feed['signed-in-account']();
  await Promise.all(polled.filter((f) => f !== 'signed-in-account' && feed[f]).map((f) => feed[f]()));
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

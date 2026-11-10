#!/usr/bin/env node
// Part C, runner step 5: the script the worker runner's LaunchAgent runs as the owner's user (runner-job.mjs):
// `node runner-main.mjs <config.json>`. Unlike the review runner (one pass a run), this run is the loop
// (runner-loop.mjs runRunner): a tick every RUNNER_TICK_MS until launchd stops it. launchd starts it at load and, once it
// has ended, again within 60 s, under the Dispatcher's stale window (STATUS_STALE_MS), so a runner that dies is "not
// known" for at most that long, never answered for.
//
// The config is read through the shared job-config reader (L253; the owner-side runner case, L248): opened by
// descriptor, inside the installed copy, and owned by root or this user alone. It names every path:
//   { "installRoot": "/abs", "requestsDir": "/abs", "statusFile": "/abs", "orchestrateUid": <uid>,
//     "outboxRoot": "/abs", "copiesRoot": "/abs", "home": "/abs", "path": "/abs:/abs", "claudeBin": "/abs",
//     "recordRoot": "/abs", "recordUid": <uid>, "claimMs": <ms>,
//     "products": { "<name>": { "repo": "owner/name", "mirror": "/abs", "render": { "paths": {...}, "product": {...},
//                   "rulesHosts": [], "productionFiles": [], "proposalOutboxes": [] }, "rules": {...}? } },
//     "pin": "<claude version>"?, "machineWide": "/abs"? }
// The launch checks (runner-checks.mjs, step 6) read pin, machineWide and each product's rules; one that is left out
// leaves its check without a port, so launch() refuses there and no session starts. The budget (check 12) and the
// pinned Bob file list (check 13) have no config field yet, so no session starts until they do; a worker is refused
// first at check 4 (no install port), a script session at check 12.
// Each product's render.paths.deny must name the Record, ~/.ssh, the gh config, ~/.claude and the robot keys (full paths,
// not /), and list the secrets with the approvals and rules state (#364 r1 M2): a config missing any is refused.
// The runner's own folder is the status file's folder: it holds the status, the memory (memory.json, 0o600), the
// sessions' settings files (settings/) and the one-runner lock (M9 makeLock: a second runner stops at once; a dead one's
// lock is broken). The wall (step 2) denies that folder and the requests folder to every session.
// Exit 0 when launchd stopped it (SIGTERM), 1 when it could not start or stopped on an error (its memory could not be
// read back, or a start the loop must refuse).

import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobConfig } from '../shared/job-config.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { PRODUCT_NAME } from '../modules/M10-rules/reader.mjs';
import { processGroupPorts, runRunner } from './runner-loop.mjs';
import { drainedPort, pauseLeadPort, saveWorkPort, sizePort, startPort } from './runner-ports.mjs';
import { workerChecks } from './runner-checks.mjs';
import { holdersOf } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { keepSnapshotFresh, writeSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { spawn as childSpawn } from 'node:child_process';
import { fullPath } from './runner-job.mjs';

const ABS = ['installRoot', 'requestsDir', 'statusFile', 'outboxRoot', 'copiesRoot', 'home', 'claudeBin', 'recordRoot'];
const UIDS = ['orchestrateUid', 'recordUid'];
// The read-deny entries every product's sessions must have (#364 r1 M2): the Record, the keys, the sign-in and the home's.
export const DENY_KEYS = Object.freeze(['record', 'ssh', 'gh', 'claudeHome', 'robotKeys']);
// The product rule is M10's, as the pass and owner-asks.mjs check it.
const productName = (p) => p.length <= 64 && PRODUCT_NAME.test(p);

/** The config's fields, checked after the reader has checked the file. → the config with the runner's own paths added, or a throw. */
export function checkRunnerConfig(c) {
  const fail = (why) => { throw new Error(`config: ${why}`); };
  for (const k of ABS) if (!fullPath(c?.[k])) fail(`${k} must be a full path in its simplest form, not / itself`);
  for (const k of UIDS) if (!Number.isInteger(c[k]) || c[k] < 0) fail(`${k} must be a uid`);
  if (typeof c.path !== 'string' || !c.path || !c.path.split(':').every(fullPath)) fail('path must be full folders in their simplest form joined by ":"');
  if (!Number.isFinite(c.claimMs) || c.claimMs <= 0) fail('claimMs must be the claim timeout in ms');
  if (!c.products || typeof c.products !== 'object' || Array.isArray(c.products) || !Object.keys(c.products).length) fail('products must name at least one product');
  for (const [name, p] of Object.entries(c.products)) {
    if (!productName(name)) fail(`product ${JSON.stringify(name)} is not a product name`);
    if (typeof p?.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(p.repo)) fail(`product ${name}: repo must be owner/name`);
    if (!fullPath(p.mirror)) fail(`product ${name}: mirror must be a full path in its simplest form`);
    if (!p.render?.paths || typeof p.render.paths !== 'object') fail(`product ${name}: render.paths must hold the session settings' fixed paths`);
    if (p.rules !== undefined && (!p.rules || typeof p.rules !== 'object' || Array.isArray(p.rules))) fail(`product ${name}: rules must be the product's rules`);
    // The rules' production lists, as review-runner-main.mjs readConfig requires them (#369 m4): check 8 must not pass on
    // an empty snapshot.
    const prod = p.rules?.production;
    if (p.rules !== undefined && !(prod && ['env_files', 'programs', 'hosts'].every((k) => Array.isArray(prod[k]) && prod[k].every((v) => typeof v === 'string')))) fail(`product ${name}: rules.production must list env_files, programs and hosts`);
    // Every deny entry a worker session must have (#364 r1 M2, as review-runner-main.mjs refuses an empty deny list):
    // render-settings leaves a missing one out without a word, so here a missing one stops the runner instead.
    const d = p.render.paths.deny;
    for (const k of DENY_KEYS) if (!fullPath(d?.[k])) fail(`product ${name}: render.paths.deny.${k} must be a full path in its simplest form, not / itself`);
    if (!Array.isArray(d.secrets) || !d.secrets.length || !d.secrets.every(fullPath)) fail(`product ${name}: render.paths.deny.secrets must list full paths in their simplest form (the secrets, and the approvals and rules state)`);
  }
  if (c.pin !== undefined && (typeof c.pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.pin))) fail('pin must be a Claude Code version');
  if (c.machineWide !== undefined && !fullPath(c.machineWide)) fail('machineWide must be a full path in its simplest form');
  const own = dirname(c.statusFile);
  if (own === c.requestsDir) fail('the status file must sit in the runner\'s own folder, apart from the requests folder');
  // Each product's rules snapshot is the runner's own file, in its own folder outside every copy, one per product
  // (#369 m4; as review-runner-main.mjs keeps its snapshot inside its root): the sessions' hooks read it.
  const snaps = new Set();
  for (const [name, p] of Object.entries(c.products)) {
    const s = p.render.paths.snapshot;
    if (s === undefined) continue;
    if (!fullPath(s) || dirname(s) !== own) fail(`product ${name}: render.paths.snapshot must be a file in the runner's own folder (${own})`);
    // Not one of the runner's own files there (#369 r1 m4): check 8 would rename the snapshot over it.
    if ([basename(c.statusFile), 'memory.json', 'settings', 'lock', 'break.lock'].some((n) => n.toLowerCase() === basename(s).toLowerCase())) fail(`product ${name}: render.paths.snapshot is named as one of the runner's own files`);
    if (snaps.has(s.toLowerCase())) fail(`product ${name}: render.paths.snapshot is another product's`);
    snaps.add(s.toLowerCase());
  }
  return { ...c, ownDir: own, memoryFile: join(own, 'memory.json'), settingsDir: join(own, 'settings'),
    workerRunner: { requestsDir: c.requestsDir, statusFile: c.statusFile } };
}

/** What the launch checks read for one start (runner-checks.mjs workerChecks): the start port's x and the config's. */
export function workerCheckInputs(c, x, { log = () => {} } = {}) {
  const p = c.products[x.product];
  return { ...x, mirror: p.mirror, pin: c.pin, hooksDir: p.render.paths.hooksDir, rules: p.rules, snapshot: p.render.paths.snapshot, writeSnapshot,
    machineWide: c.machineWide, busy: holdersOf, alert: (t) => log(`worker runner: ${x.sessionId}: ${t}`), spawn: childSpawn, home: c.home,
    testCommand: p.render.product?.commands?.test, budget: null, bobFolder: p.render.paths.bobFolder, bobManifest: null };
}

/** The checks run once more just before claude starts (#369 M1, r1 m1 and m2): the copy (its folder and HEAD), its setup
 * files, the outbox, and the rules snapshot written afresh. */
export const RECHECK = Object.freeze([1, 2, 3, 8]);
/** The start port's ports from the config: the stop flag, check 0's pinned version, the worker launch checks, and the
 * RECHECK checks once more just before claude starts. */
export const startDeps = (c, { stopped = () => false, log } = {}) => ({ stopped, names: { version: c.pin },
  checksFor: (x) => workerChecks(workerCheckInputs(c, x, { log })),
  beforeStart: async (x) => {
    const k = workerChecks(workerCheckInputs(c, x, { log }));
    for (const n of RECHECK) {
      if (typeof k[n] !== 'function') return `check ${n} has no port`;
      let a; try { a = await k[n](); } catch (e) { a = { ok: false, reason: e?.message ?? String(e) }; }
      if (!a?.ok) return `check ${n}: ${a?.reason ?? 'no answer'}`;
    }
    return null;
  } });
/** Every SIGTERM is listened for, not only the first (#364 r1 m4): a second one during the drain must not end the run. */
export const listenStop = (fn) => { process.on('SIGTERM', fn); };

/** The ports from the config; `over` replaces any (a test's fakes). `stopped` tells the start port the runner is stopping. */
export function realRunnerPorts(c, over = {}, { stopped = () => false, log } = {}) {
  return {
    ...processGroupPorts(),
    start: startPort(c, startDeps(c, { stopped, log })),
    saveWork: saveWorkPort({ mirrorOf: (product) => c.products[product]?.mirror }),
    pauseLead: pauseLeadPort(),
    // No Record fact reader is exported yet (lane 2's), so an outbox holding a file stays open (runner-ports.mjs drainedPort).
    outboxDrained: drainedPort(),
    size: sizePort(),
    ...over,
  };
}

/**
 * argv: [config]. opts (tests only): readConfig, lock, ports, run, log, onStop (how a SIGTERM is listened for).
 * → the exit code.
 */
export async function main(argv, { readConfig = (f) => { const self = selfPath(); if (!self) throw new Error('its own script\'s path can\'t be read, so it can\'t be checked'); return readJobConfig(f, { code: [], self }); }, lock = (dir) => makeLock({ dir, timeoutMs: 2_000 }),
  ports = {}, run = runRunner, log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`), onStop = listenStop, fresh = keepSnapshotFresh } = {}) {
  let c;
  try { c = checkRunnerConfig(readConfig(argv[0])); } catch (e) { log(`the worker runner did not start: ${e.message}`); return 1; }
  let l; let held;
  // The runner's own folder is setup's, with the access the Dispatcher's reads need: only settings/ is made here (#364 m6).
  try { try { mkdirSync(c.settingsDir, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') throw e; } l = lock(c.ownDir); held = l.acquire(); } catch (e) {
    log(`the worker runner did not start: ${/busy/.test(e?.message ?? '') ? 'another worker runner is running' : e?.message ?? e}`); return 1;
  }
  if (held.broke) log('the last worker runner\'s lock was left by a runner that is gone; it was broken');
  let stopping = false;
  onStop(() => { stopping = true; });
  // Each product's rules snapshot is kept fresh for the runner's life (#369 r1 m2): the sessions' hooks refuse every call
  // once it is 5 minutes old. A rewrite that fails stops its refresher; the snapshot then goes stale, failing safe.
  const kept = [];
  try {
    for (const [name, p] of Object.entries(c.products)) {
      if (typeof p.render.paths.snapshot !== 'string' || !p.rules) continue;
      try { kept.push([name, fresh(p.render.paths.snapshot, p.rules)]); } catch (e) { log(`product ${name}'s rules snapshot can't be written (${e?.code ?? e?.message}); its sessions are refused`); }
    }
    await run({ requestsDir: c.requestsDir, statusFile: c.statusFile, memoryFile: c.memoryFile, orchestrateUid: c.orchestrateUid, uid: process.getuid(),
      outboxRoot: c.outboxRoot, copiesRoot: c.copiesRoot, claimMs: c.claimMs, ports: realRunnerPorts(c, ports, { stopped: () => stopping, log }), note: log, stopWhen: () => stopping });
    return 0;
  } catch (e) { log(`the worker runner stopped: ${e?.message ?? e}`); return 1; } finally {
    for (const [name, k] of kept) { try { k.stop(); if (k.error()) log(`product ${name}'s rules snapshot stopped being kept fresh (${k.error()?.code ?? k.error()?.message})`); } catch { /* stopped */ } }
    try { l.release(held.nonce); } catch { /* gone */ }
  }
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));

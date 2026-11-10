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
//                   "rulesHosts": [], "productionFiles": [], "proposalOutboxes": [] } } } }
// Each product's render.paths.deny must name the Record, ~/.ssh, the gh config, ~/.claude and the robot keys (full paths,
// not /), and list the secrets with the approvals and rules state (#364 r1 M2): a config missing any is refused.
// The runner's own folder is the status file's folder: it holds the status, the memory (memory.json, 0o600), the
// sessions' settings files (settings/) and the one-runner lock (M9 makeLock: a second runner stops at once; a dead one's
// lock is broken). The wall (step 2) denies that folder and the requests folder to every session.
// Exit 0 when launchd stopped it (SIGTERM), 1 when it could not start or stopped on an error (its memory could not be
// read back, or a start the loop must refuse).

import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobConfig } from '../shared/job-config.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { PRODUCT, runnerPlaces } from '../shared/product-paths.mjs';
import { loadMemory, processGroupPorts, runRunner } from './runner-loop.mjs';
import { drainedPort, liveWallProblem, pauseLeadPort, saveWorkPort, sessionSettingsOf, sizePort, startPort } from './runner-ports.mjs';
import { fullPath } from './runner-job.mjs';
import { productRoleClash } from './owner-status.mjs';

const ABS = ['installRoot', 'requestsDir', 'statusFile', 'outboxRoot', 'copiesRoot', 'home', 'claudeBin', 'recordRoot'];
const UIDS = ['orchestrateUid', 'recordUid'];
// The read-deny entries every product's sessions must have (#364 r1 M2): the Record, the keys, the sign-in and the home's.
export const DENY_KEYS = Object.freeze(['record', 'ssh', 'gh', 'claudeHome', 'robotKeys']);
// The product rule is setup's (shared/product-paths.mjs PRODUCT, #378 M1): each product's folders are setup's, named as on disk.
const productName = (p) => PRODUCT.test(p);

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
    if (productRoleClash(name)) fail(`product ${name} is named as a role, and its outbox folder would be that role's (L836)`);
    if (typeof p?.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(p.repo)) fail(`product ${name}: repo must be owner/name`);
    if (!fullPath(p.mirror)) fail(`product ${name}: mirror must be a full path in its simplest form`);
    if (!p.render?.paths || typeof p.render.paths !== 'object') fail(`product ${name}: render.paths must hold the session settings' fixed paths`);
    // Every deny entry a worker session must have (#364 r1 M2, as review-runner-main.mjs refuses an empty deny list):
    // render-settings leaves a missing one out without a word, so here a missing one stops the runner instead.
    const d = p.render.paths.deny;
    for (const k of DENY_KEYS) if (!fullPath(d?.[k])) fail(`product ${name}: render.paths.deny.${k} must be a full path in its simplest form, not / itself`);
    if (!Array.isArray(d.secrets) || !d.secrets.length || !d.secrets.every(fullPath)) fail(`product ${name}: render.paths.deny.secrets must list full paths in their simplest form (the secrets, and the approvals and rules state)`);
  }
  const own = dirname(c.statusFile);
  if (own === c.requestsDir) fail('the status file must sit in the runner\'s own folder, apart from the requests folder');
  return { ...c, ownDir: own, memoryFile: join(own, 'memory.json'), settingsDir: join(own, 'settings'),
    workerRunner: { requestsDir: c.requestsDir, statusFile: c.statusFile } };
}

/**
 * Why the runner must not start (#378 r1 M1), or null: a session it carries over (listed and not shown gone, or a start
 * still waiting) whose settings do not deny some other product of this config whole, a product added after it started.
 * groupGone(s) is the process-group port; a group it can't tell about counts as live.
 */
export function carriedOverProblem(c, memory, { groupGone, readSettings = sessionSettingsOf(c.settingsDir) } = {}) {
  const live = [];
  for (const s of Array.isArray(memory?.sessions) ? memory.sessions : []) {
    if (!(s?.alive === true || (s?.alive !== false && s?.ended !== true))) continue;
    let gone = false; try { gone = groupGone(s) === true; } catch { gone = false; }
    if (!gone) live.push({ id: s.id, product: s.product });
  }
  for (const [id, r] of Object.entries(memory?.requests ?? {})) if (r?.state === 'waiting') live.push({ id, product: r.product, unstarted: true });
  for (const q of Object.keys(c.products)) {
    const why = liveWallProblem(live, q, runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product: q }), readSettings);
    if (why) return why;
  }
  return null;
}

/** Every SIGTERM is listened for, not only the first (#364 r1 m4): a second one during the drain must not end the run. */
export const listenStop = (fn) => { process.on('SIGTERM', fn); };

/** The ports from the config; `over` replaces any (a test's fakes). `stopped` tells the start port the runner is stopping. */
export function realRunnerPorts(c, over = {}, { stopped = () => false } = {}) {
  return {
    ...processGroupPorts(),
    start: startPort(c, { stopped }),
    saveWork: saveWorkPort({ mirrorOf: (product) => c.products[product]?.mirror }),
    pauseLead: pauseLeadPort(),
    outboxDrained: drainedPort(),
    size: sizePort(),
    ...over,
  };
}

/**
 * argv: [config]. opts (tests only): readConfig, lock, ports, run, log, onStop (how a SIGTERM is listened for), realpath,
 * memory (the memory reader).
 * → the exit code.
 */
export async function main(argv, { readConfig = (f) => { const self = selfPath(); if (!self) throw new Error('its own script\'s path can\'t be read, so it can\'t be checked'); return readJobConfig(f, { code: [], self }); }, lock = (dir) => makeLock({ dir, timeoutMs: 2_000 }),
  ports = {}, run = runRunner, log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`), onStop = listenStop,
  realpath = (p) => realpathSync.native(p), memory = loadMemory } = {}) {
  let c;
  try { c = checkRunnerConfig(readConfig(argv[0])); } catch (e) { log(`the worker runner did not start: ${e.message}`); return 1; }
  // The roots each deny is spelled from are their real paths (#378 r1 m4): the Mac's sandbox does not apply a deny reached
  // through a link (render-settings.mjs), so a root behind one would leave every product's folders open.
  for (const k of ['copiesRoot', 'outboxRoot']) {
    let real; try { real = realpath(c[k]); } catch (e) { log(`the worker runner did not start: ${k} can't be read (${e?.code ?? e?.message})`); return 1; }
    if (real !== c[k]) { log(`the worker runner did not start: ${k} is reached through a link (it is ${real})`); return 1; }
  }
  let l; let held;
  // The runner's own folder is setup's, with the access the Dispatcher's reads need: only settings/ is made here (#364 m6).
  try { try { mkdirSync(c.settingsDir, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') throw e; } l = lock(c.ownDir); held = l.acquire(); } catch (e) {
    log(`the worker runner did not start: ${/busy/.test(e?.message ?? '') ? 'another worker runner is running' : e?.message ?? e}`); return 1;
  }
  if (held.broke) log('the last worker runner\'s lock was left by a runner that is gone; it was broken');
  let stopping = false;
  onStop(() => { stopping = true; });
  const P = realRunnerPorts(c, ports, { stopped: () => stopping });
  try {
    // A memory that can't be read is the loop's to refuse; one read is checked for carried-over sessions first.
    let m = null; try { m = memory(c.memoryFile, { uid: process.getuid() }); } catch { m = null; }
    const why = m ? carriedOverProblem(c, m, { groupGone: P.groupGone }) : null;
    if (why) { log(`the worker runner did not start: ${why}`); return 1; }
    await run({ requestsDir: c.requestsDir, statusFile: c.statusFile, memoryFile: c.memoryFile, orchestrateUid: c.orchestrateUid, uid: process.getuid(),
      outboxRoot: c.outboxRoot, copiesRoot: c.copiesRoot, claimMs: c.claimMs, ports: P, note: log, stopWhen: () => stopping });
    return 0;
  } catch (e) { log(`the worker runner stopped: ${e?.message ?? e}`); return 1; } finally { try { l.release(held.nonce); } catch { /* gone */ } }
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));

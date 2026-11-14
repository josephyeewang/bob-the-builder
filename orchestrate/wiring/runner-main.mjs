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
//     "recordRoot": "/abs", "recordUid": <uid>, "claimMs": <ms>, "lockedMs": <ms>? (the install job's limit, at most runner-locked.mjs LOCKED_MS; save-work's is LOCKED_SAVE_MS),
//     "products": { "<name>": { "repo": "owner/name", "mirror": "/abs", "render": { "paths": {...}, "product": {...},
//                   "rulesHosts": [], "productionFiles": [], "proposalOutboxes": [] }, "rules": {...}? } },
//     "pin": "<claude version>"?, "machineWide": "/Library/Application Support/ClaudeCode/managed-settings.json"? (that file only, L913),
//     "budget": "/abs.mjs"?, "bobManifest": "/abs"?,        inside installRoot and root's alone, each loaded once at start (L1001)
//     "dispatcherRules": "/abs"?, "reviewStatusFile": "/abs"?, "reviewUid": <uid>?  required with budget }
// The launch checks (runner-checks.mjs, step 6) read pin, machineWide and each product's rules; one that is left out
// leaves its check without a port, so launch() refuses there and no session starts. `budget` names M11's budget module
// (launch check 12: the rules the Dispatcher's snapshot at dispatcherRules holds, the Record, and the running count from
// this runner's status file and the review runner's), `bobManifest` the pinned Bob file list (check 13); each is root's
// own file in the copy, and one that can't be loaded is logged and leaves its check without a port. Until both are
// named no session starts; a worker is refused first at check 4 when its product declares no install command
// (render.product.commands.install; its registry hosts in render.registryHosts). Check 4 and save-work run through one
// lock-down runner (lockedWiring, L969, #456 r1 m3), so neither is ever on without the other.
// Each product's render.paths.deny must name the Record, ~/.ssh, the gh config, ~/.claude and the robot keys (full paths,
// not /), and list the secrets with the approvals and rules state (#364 r1 M2): a config missing any is refused.
// The runner's own folder is the status file's folder: it holds the status, the memory (memory.json, 0o600), the
// sessions' settings files (settings/) and the one-runner lock (M9 makeLock: a second runner stops at once; a dead one's
// lock is broken). The wall (step 2) denies that folder and the requests folder to every session, so each product's rules
// snapshot (render.paths.snapshot), which its sessions' hooks read, sits in a folder of its own apart from both (L916),
// a real folder only the runner can write, under folders no one else can change (L926): checked before the lock, a
// missing one holding its product until it is made.
// Exit 0 when launchd stopped it (SIGTERM), 1 when it could not start or stopped on an error (its memory could not be
// read back, or a start the loop must refuse). It does not start when a copies or outbox root is missing or reached
// through a link (#378 r1 m4), when a session it carries over may read a product's folders (#378 r1 M1,
// carriedOverProblem), or when it has no memory but earlier sessions' settings files are there (#378 self-review M3).

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJobConfig } from '../shared/job-config.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { PRODUCT, runnerPlaces } from '../shared/product-paths.mjs';
import { foldKey } from '../shared/plan-fingerprint.mjs';
import { loadMemory, processGroupPorts, runRunner } from './runner-loop.mjs';
import { drainedPort, liveWallProblem, pauseLeadPort, productWallGap, saveSettingsName, saveWorkPort, sessionEnv, sessionSettingsOf, sizePort, startPort } from './runner-ports.mjs';
import { workerChecks } from './runner-checks.mjs';
import { NO_BUDGET_PORTS, budgetShapeOk, holdersOf, readFactFile, readSessionFile } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { keepSnapshotFresh, writeSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { fullPath } from './runner-job.mjs';
import { productRoleClash } from './owner-status.mjs';
import { CLAUDE_FILE, MANAGED_SOURCES_CHECKED_ON } from '../modules/M4-workshop/launcher/env-check.mjs';
import { accountInUse } from '../modules/M4-workshop/launcher/accounts.mjs';
import { LOCKED_MS, lockedRunner } from './runner-locked.mjs';
import { apart } from '../modules/M4-workshop/launcher/render-settings.mjs';
import { installProblem } from '../modules/M4-workshop/launcher/install-check.mjs';
import { INTERACTIVE_ROLES, hookStore, nodeHookFs } from '../modules/M4-workshop/send-safe/hook-store.mjs';
import { writeStatus } from './runner-files.mjs';

const ABS = ['installRoot', 'requestsDir', 'statusFile', 'outboxRoot', 'copiesRoot', 'home', 'claudeBin', 'recordRoot'];
const UIDS = ['orchestrateUid', 'recordUid'];
// Launch checks 12 and 13's files (L1001): optional, each root's own in the copy; budget needs the three after it.
const PINNED = ['budget', 'bobManifest'];
const BUDGET_NEEDS = ['dispatcherRules', 'reviewStatusFile', 'reviewUid'];
// The read-deny entries every product's sessions must have (#364 r1 M2): the Record, the keys, the sign-in and the home's.
export const DENY_KEYS = Object.freeze(['record', 'ssh', 'gh', 'claudeHome', 'robotKeys']);
// The product rule is setup's (shared/product-paths.mjs PRODUCT, #378 M1): each product's folders are setup's, named as on disk.
const productName = (p) => PRODUCT.test(p);

// The session's own folders in render.paths that the config may give (L915).
export const RENDER_PATHS = Object.freeze(['node', 'hooksDir', 'notes', 'bobFolder']);

/** The config's fields, checked after the reader has checked the file. → the config with the runner's own paths added, or a throw. */
export function checkRunnerConfig(c) {
  const fail = (why) => { throw new Error(`config: ${why}`); };
  for (const k of ABS) if (!fullPath(c?.[k])) fail(`${k} must be a full path in its simplest form, not / itself`);
  for (const k of UIDS) if (!Number.isInteger(c[k]) || c[k] < 0) fail(`${k} must be a uid`);
  if (typeof c.path !== 'string' || !c.path || !c.path.split(':').every(fullPath)) fail('path must be full folders in their simplest form joined by ":"');
  if (!Number.isFinite(c.claimMs) || c.claimMs <= 0) fail('claimMs must be the claim timeout in ms');
  if (c.lockedMs !== undefined && (!Number.isInteger(c.lockedMs) || c.lockedMs <= 0 || c.lockedMs > LOCKED_MS)) fail('lockedMs must be the install job\'s time limit in ms, at most 10 minutes, the lock-down\'s own cap (left out: 10 minutes)');
  if (!c.products || typeof c.products !== 'object' || Array.isArray(c.products) || !Object.keys(c.products).length) fail('products must name at least one product');
  for (const [name, p] of Object.entries(c.products)) {
    if (!productName(name)) fail(`product ${JSON.stringify(name)} is not a product name`);
    if (productRoleClash(name)) fail(`product ${name} is named as a role, and its outbox folder would be that role's (L836)`);
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
    // L915 (#420 m2): the session's own folders, when given, in their simplest form here, at load, rather than
    // every launch refused later by render-settings.
    for (const k of RENDER_PATHS) if (p.render.paths[k] !== undefined && !fullPath(p.render.paths[k])) fail(`product ${name}: render.paths.${k} must be a full path in its simplest form, not / itself`);
  }
  if (c.pin !== undefined && (typeof c.pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.pin))) fail('pin must be a Claude Code version');
  for (const k of [...PINNED, 'dispatcherRules', 'reviewStatusFile']) if (c[k] !== undefined && !fullPath(c[k])) fail(`${k} must be a full path in its simplest form, not / itself`);
  if (c.reviewUid !== undefined && (!Number.isInteger(c.reviewUid) || c.reviewUid < 0)) fail('reviewUid must be a uid');
  if (c.budget !== undefined) for (const k of BUDGET_NEEDS) if (c[k] === undefined) fail(`${k} must be set with budget (launch check 12 reads it)`);
  for (const k of PINNED) if (c[k] !== undefined && !insideCopy(c.installRoot, c[k])) fail(`${k} must be inside installRoot (${c.installRoot})`);
  // L913 (a): claude reads only its fixed managed file, so it is the one value taken, spelled exactly (its name has a
  // space, which the full-path rule refuses elsewhere); any other would refuse every session at check 10 instead. Any
  // other value, a near miss too, is told the fixed file (#419 r3 c1).
  if (c.machineWide !== undefined && c.machineWide !== CLAUDE_FILE) fail(`machineWide must be ${CLAUDE_FILE}: claude ${MANAGED_SOURCES_CHECKED_ON} reads only that file`);
  const own = dirname(c.statusFile);
  if (!apart(own, c.requestsDir)) fail('the status file must sit in the runner\'s own folder, apart from the requests folder');
  // The runner's two folders are walled off from every worker session (render-settings runnerWallDirs), and render
  // refuses a launch whose own folders are not apart from them: so a product's hooks, notes, node or Bob inside either
  // is refused here, at load, rather than every launch later (L916 self-review m1).
  for (const [name, p] of Object.entries(c.products)) {
    for (const k of RENDER_PATHS) {
      const v = p.render.paths[k];
      if (v !== undefined && (!apart(v, c.requestsDir) || !apart(v, own))) fail(`product ${name}: render.paths.${k} must be apart from the runner's requests folder (${c.requestsDir}) and its own folder (${own}), which worker sessions are walled off from`);
    }
  }
  // Each product's rules snapshot is the runner's to write, one per product: the sessions' hooks read it. It sits in a
  // folder of its own, apart from both runner folders (L916, #423 M2): a snapshot in either would refuse every launch.
  // That also keeps it off the runner's own files there (#369 r1 m4), which check 8 would rename it over. And nowhere a
  // worker session can write (#369 m4; L916 self-review M1): not in the copies, the outboxes, the sessions' home or a
  // product's mirror, where a worker could rewrite the rules its own hooks enforce. This list compares spellings only: the
  // rule that decides is who can write the folder, checked on the disk by main (snapshotFolderProblem, L926).
  const writable = [['the copies', c.copiesRoot], ['the outboxes', c.outboxRoot], ["the sessions' home", c.home],
    ...Object.entries(c.products).map(([n, q]) => [`product ${n}'s mirror`, q.mirror])];
  const snaps = new Set();
  for (const [name, p] of Object.entries(c.products)) {
    const s = p.render.paths.snapshot;
    if (s === undefined) continue;
    if (!fullPath(s) || dirname(s) === '/' || !apart(s, c.requestsDir) || !apart(s, own)) fail(`product ${name}: render.paths.snapshot must be a file in a folder of its own, apart from the runner's requests folder (${c.requestsDir}) and its own folder (${own}), which worker sessions are walled off from`);
    for (const [what, dir] of writable) if (!apart(s, dir)) fail(`product ${name}: render.paths.snapshot must not sit in ${what} (${dir}), where a worker session can write it`);
    if (snaps.has(foldKey(s))) fail(`product ${name}: render.paths.snapshot is another product's`);
    snaps.add(foldKey(s));
  }
  // R-0b-175a: the interactive sessions' hook store, optional until R-0b-174 starts those sessions (left out: no store,
  // and the status has no held list). A folder only the owner opens (checked on the disk by main, hookStoreOf), apart
  // from the folder the Dispatcher reads, the requests folder, and everywhere a worker session can write, where a session
  // could write a hook line for another.
  if (c.hookStateDir !== undefined) {
    if (!fullPath(c.hookStateDir)) fail('hookStateDir must be a full path in its simplest form, not / itself');
    if (!apart(c.hookStateDir, own) || !apart(c.hookStateDir, c.requestsDir)) fail(`hookStateDir must be apart from the runner's own folder (${own}) and its requests folder (${c.requestsDir})`);
    for (const [what, dir] of writable) if (!apart(c.hookStateDir, dir)) fail(`hookStateDir must not sit in ${what} (${dir}), where a worker session can write`);
  }
  if (c.start_timeout_s !== undefined) {
    const t = c.start_timeout_s;
    if (c.hookStateDir === undefined) fail('start_timeout_s needs hookStateDir');
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail('start_timeout_s must give seconds per interactive role');
    for (const [role, v] of Object.entries(t)) {
      if (!INTERACTIVE_ROLES.includes(role)) fail(`start_timeout_s: ${role} is not one of ${INTERACTIVE_ROLES.join(', ')}`);
      if (!Number.isFinite(v) || v <= 0 || v > 3600) fail(`start_timeout_s.${role} must be seconds, above 0 and at most 3600`);
    }
  }
  return { ...c, ownDir: own, memoryFile: join(own, 'memory.json'), settingsDir: join(own, 'settings'),
    workerRunner: { requestsDir: c.requestsDir, statusFile: c.statusFile } };
}

const insideCopy = (root, p) => p.startsWith(`${root}/`);

/** R-0b-175a: the hook store at `c.hookStateDir`, its folder and hooks/ made 0o700 if missing; either one not a folder,
 * not the owner's, or open to anyone else is a throw (the runner does not start). An unreadable store file is not: it
 * holds every send, and is told (hook-store.mjs). */
export function hookStoreOf(c, { uid = process.getuid(), lstat = lstatSync, mkdir = mkdirSync, open = hookStore } = {}) {
  for (const d of [c.hookStateDir, join(c.hookStateDir, 'hooks')]) {
    try { mkdir(d, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') throw new Error(`hookStateDir ${d} can't be made (${e?.code ?? e?.message})`); }
    const st = lstat(d);
    if (!st.isDirectory()) throw new Error(`hookStateDir ${d} is not a folder`);
    if (st.uid !== uid) throw new Error(`hookStateDir ${d} is not the owner's`);
    if (st.mode & 0o077) throw new Error(`hookStateDir ${d} can be opened by others; it must be 0700`);
  }
  return open({ dir: c.hookStateDir, fs: nodeHookFs(), saveFile: (f, text, { mode }) => writeStatus(f, text, { mode }), startTimeoutS: c.start_timeout_s ?? {} });
}

/**
 * What the launch checks read for one start (runner-checks.mjs workerChecks): the start port's x and the config's, the
 * lock-down runner check 4 runs the install through, and the budget and Bob file list main loaded once at start from the
 * config's `budget` and `bobManifest` (null: none, so checks 12 and 13 have no port).
 */
export function workerCheckInputs(c, x, { log = () => {}, runLocked = null, budget = null, bobManifest = null } = {}) {
  const p = c.products[x.product];
  return { ...x, runLocked, installCommand: p.render.product?.commands?.install, registryHosts: p.render.registryHosts, mirror: p.mirror, pin: c.pin, hooksDir: p.render.paths.hooksDir, rules: p.rules, snapshot: p.render.paths.snapshot, writeSnapshot,
    machineWide: c.machineWide, busy: holdersOf, alert: (t) => log(`worker runner: ${x.sessionId}: ${t}`), spawn: childSpawn, home: c.home,
    testCommand: p.render.product?.commands?.test, budget, bobFolder: p.render.paths.bobFolder, bobManifest };
}

/** The checks run once more just before claude starts (#369 M1, r1 m1 and m2): the copy (its folder and HEAD), its setup
 * files, the outbox, and the rules snapshot written afresh. */
export const RECHECK = Object.freeze([1, 2, 3, 8]);
/** The start port's ports from the config: the stop flag, check 0's pinned version, the worker launch checks, and the
 * RECHECK checks once more just before claude starts. */
export const startDeps = (c, { stopped = () => false, log, productHeld, runLocked = null, budget = null, bobManifest = null, checksOf = (x) => workerChecks(workerCheckInputs(c, x, { log, runLocked, budget, bobManifest })) } = {}) => ({ stopped, log, productHeld, names: { version: c.pin },
  checksFor: checksOf,
  beforeStart: async (x) => {
    const k = checksOf(x);
    for (const n of RECHECK) {
      if (typeof k[n] !== 'function') return `check ${n} has no port`;
      let a; try { a = await k[n](); } catch (e) { a = { ok: false, reason: e?.message ?? String(e) }; }
      if (!a?.ok) return `check ${n}: ${a?.reason ?? 'no answer'}`;
    }
    return null;
  } });

/**
 * Why the runner must not start (#378 r1 M1), or null: a session it carries over (listed and not shown gone, or a start
 * still waiting) whose settings do not deny some other product of this config whole, a product added after it started.
 * groupGone(s) is the process-group port; a group it can't tell about counts as live.
 */
export function carriedOverProblem(c, memory, { groupGone, readSettings = sessionSettingsOf(c.settingsDir), readSaveSettings = sessionSettingsOf(c.settingsDir, saveSettingsName), listSettings = () => readdirSync(c.settingsDir) } = {}) {
  // No memory (a first run, or one lost) while settings files of earlier sessions are there (#378 self-review M3): a
  // session started with one may still run, and the runner knows nothing of it, so it can't be told about.
  // A memory with no sessions and no requests is no memory either (#378 r2 n4: one restored or edited to empty lists).
  const none = (v) => v === undefined || (Array.isArray(v) ? v.length === 0 : (v && typeof v === 'object' && Object.keys(v).length === 0));
  if (memory && typeof memory === 'object' && none(memory.sessions) && none(memory.requests)) {
    let files; try { files = listSettings().filter((n) => n.endsWith('.json')); } catch (e) { return `its settings folder can't be listed (${e?.code ?? e?.message})`; }
    if (files.length) return `it has no memory, but its settings folder holds ${files.length} earlier session${files.length === 1 ? '\'s' : 's\''} settings (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}); a session started with one may still run. Once none does, remove them from ${c.settingsDir}`;
    return null;
  }
  const live = [];
  for (const s of Array.isArray(memory?.sessions) ? memory.sessions : []) {
    if (!(s?.alive === true || (s?.alive !== false && s?.ended !== true))) continue;
    let gone = false; try { gone = groupGone(s) === true; } catch { gone = false; }
    if (!gone) live.push({ id: s.id, product: s.product });
  }
  // Waiting rows are not counted here (#378 self-review M2): no group of theirs can be shown gone, and they are never
  // dropped, so the runner would stay down, serving no stop. Each start still checks them (worker-runner.mjs `live`).
  for (const q of Object.keys(c.products)) {
    const places = { ...runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product: q }), mirror: c.products[q]?.mirror };
    const why = liveWallProblem(live, q, places, readSettings);
    if (why) return why;
    // Its save settings too (#463 r2 m5): a later save of that session runs claude with them. A save comes after the stop,
    // so every listed session that can still be saved counts (self-review M-1), live or not: one whose row keeps the
    // hash of its save settings. None written is no gap: a row with no hash is never saved (worker-runner.mjs).
    for (const s of Array.isArray(memory?.sessions) ? memory.sessions : []) {
      if (!s?.save_settings_sha || s.product === q) continue;
      if (typeof s.product !== 'string') return `session ${s.id} names no product, so whether its saves may read product ${q}'s folders can't be told`;
      let set; try { set = readSaveSettings(s.id); } catch (e) {
        if (e?.code === 'ENOENT') continue;
        return `session ${s.id}'s save settings can't be read (${e?.code ?? e?.message}), so whether its saves may read product ${q}'s folders can't be told`;
      }
      const gap = productWallGap(set, places);
      if (gap) return `session ${s.id} (product ${s.product})'s save settings were written before product ${q}'s folders were on their deny list (${gap}); start product ${q}'s sessions once it has ended`;
    }
  }
  return null;
}

/**
 * The one lock-down runner of this runner (L969): null when the config names no claude to run a job with. The sign-in is
 * read for each save, as the start port reads it for each start (runner-ports.mjs sessionEnv, the one form), and the
 * environment is held to launch check 9 (checkRoleEnv) as the session's is; the install is given the start's own (#463 r1 m6). `who` and `base` stand in for accountInUse and process.env in a test.
 */
export function lockedOf(c, { make = lockedRunner, who: account = accountInUse, base = process.env } = {}) {
  if (typeof c.claudeBin !== 'string' || !c.claudeBin.startsWith('/')) return null;
  return make({ claudeBin: c.claudeBin, ...(c.lockedMs !== undefined ? { ms: c.lockedMs } : {}), envOf: () => {
    const who = account({ home: c.home });
    if (!who?.account) throw new Error(who?.reason ?? 'no answer');
    const built = sessionEnv(c, who, base);
    if (!built?.ok) throw new Error(built?.reason ?? 'check 9 gave no answer');
    return built.env;
  } });
}

/**
 * Save-work and launch check 4 from ONE runLocked (#456 r1 m3): a launch is never possible while its work could not be
 * saved. Without one, save-work refuses ("lock-down") and no worker passes check 4 (no port); with one, both run.
 */
export function lockedWiring(c, { runLocked = lockedOf(c), stopped, log, productHeld, budget = null, bobManifest = null } = {}) {
  return {
    runLocked,
    saveWork: saveWorkPort({ mirrorOf: (product) => c.products[product]?.mirror, runLocked, settingsDir: c.settingsDir }),
    startDeps: startDeps(c, { stopped, log, productHeld, runLocked, budget, bobManifest }),
  };
}

/** Every SIGTERM is listened for, not only the first (#364 r1 m4): a second one during the drain must not end the run. */
export const listenStop = (fn) => { process.on('SIGTERM', fn); };

/** The ports from the config; `over` replaces any (a test's fakes). `stopped` tells the start port the runner is stopping. */
export function realRunnerPorts(c, over = {}, { stopped = () => false, log, productHeld, runLocked, budget = null, bobManifest = null, wire = lockedWiring } = {}) {
  const locked = wire(c, { stopped, log, productHeld, budget, bobManifest, ...(runLocked !== undefined ? { runLocked } : {}) });
  return {
    ...processGroupPorts(),
    start: startPort(c, locked.startDeps),
    saveWork: locked.saveWork,
    pauseLead: pauseLeadPort(),
    // The Record's read-only fact reader (L852, M4 readFactFile): an outbox is drained once every file in it is taken or told.
    // The session reader (L899) gives the attempt whose push took the card's bundle (L898).
    outboxDrained: drainedPort({ readFact: (fact) => readFactFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, fact }), readSession: (session) => readSessionFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, session }) }),
    size: sizePort(),
    ...over,
  };
}

/**
 * Who can change a product's rules snapshot's folder (L926, #419 r3 M1), decided on the disk rather than by a list of
 * places. The folder is its own real path (no link on the way, a link into a copy included), a real folder (not a link),
 * owned by the runner's uid with no group or other write bit. The runner's sessions run as that same Mac user
 * (runner-ports.mjs), so owning the folder keeps out other users only: the folder right above it must be root's, with no
 * group or other write bit and no access list write entry (#419 r4 M1, option b), so a session can't rename the folder
 * away or put another in its place. Every folder further up is root's too, with no group or other write bit unless it
 * is sticky (/private/tmp): a session may rename a folder in one it can write, even a folder it can't (L939 self-review
 * M-A: renaming <home>/orch with root's worker-runner/ in it would move the snapshots out from under the deny entries).
 * So a folder in or under claude's per-user sandbox temp folder (/private/tmp/claude-<uid>), the temp folder or the home
 * folder fails this, and so does a copy; setup's <base>/worker-runner/ passes when <base> sits in root's folders. (The
 * home folder itself, its parent /Users being root's, passes; it is no snapshot folder anyone would name.) Writing into
 * the folder itself only the sessions' sandbox and tool walls stop (the snapshot deny, a lane 4 card).
 * No folder on the way carries an access list entry that lets anyone write (L926 self-review M1: a 0755 folder with
 * "everyone allow add_file" is everyone's to write; macOS's own "deny" entries, as on a home folder, are fine).
 * What this can't stop (L942 m4): the folder's owner, the runner's user and so its sessions, may give itself "delete" on
 * the folder in its access list and then rename it away. That fails safe: the snapshot goes missing, and the product is
 * held. So the whole check, the folder's own access list included, runs again at each start (keepSnapshots `recheck`,
 * L942 c5), and a folder that fails it holds the product. A disk image mounted over the folder is not checked here; the
 * L921 snapshot deny is meant to stop a session mounting one, which is not yet shown (a real-sandbox hdiutil attach test
 * is on the Mini list).
 * A missing folder whose parent is there is held to the rule for the folders above it (L942 m2), so a bad place is told
 * as that, not as a folder to make. → null | { missing, reason }. opts (tests): lstat, realpath, uid, aclWrites.
 */
export function snapshotFolderProblem(dir, { lstat = lstatSync, realpath = (p) => realpathSync.native(p), uid = process.getuid(), aclWrites = aclWriteEntries } = {}) {
  const no = (why) => ({ missing: false, reason: `its folder ${dir} ${why}` });
  if (typeof dir !== 'string' || !isAbsolute(dir)) return no('is not a full path');
  const acl = (a) => { try { return aclWrites(a); } catch (e) { return [`its access list can't be read (${e?.message ?? e})`]; } };
  // The folder above it: root's alone (#419 r4 M1); every one above that root's, or sticky if others can write it.
  const above = () => {
    const parent = dirname(dir);
    let ps; try { ps = lstat(parent); } catch (e) { return `sits in ${parent}, which can't be read (${e?.code ?? e?.message})`; }
    if (ps.uid !== 0 || (ps.mode & 0o022)) return `sits in ${parent}, which is not root's alone (its owner is uid ${ps.uid}, mode ${(ps.mode & 0o7777).toString(8).padStart(4, '0')}): the runner's sessions are the runner's own user, so only a folder of root's that no one else can write keeps them from moving this one`;
    for (let a = parent; ; a = dirname(a)) {
      let s; try { s = lstat(a); } catch (e) { return `sits in ${a}, which can't be read (${e?.code ?? e?.message})`; }
      if (s.uid !== 0 || ((s.mode & 0o022) && !(s.mode & 0o1000))) return `sits in ${a}, which others than root can change (its owner is uid ${s.uid}, mode ${(s.mode & 0o7777).toString(8).padStart(4, '0')})`;
      const up = acl(a);
      if (up.length) return `sits in ${a}, which has an access list entry that lets others write (${up[0]})`;
      if (a === '/') return null;
    }
  };
  let st; try { st = lstat(dir); } catch (e) {
    if (e?.code !== 'ENOENT') return no(`can't be read (${e?.code ?? e?.message})`);
    // Missing. Where its parent is there, that place is held to the rule first (L942 m2): a folder made there would fail.
    // Its parent reached through a link (/tmp is /private/tmp) is refused as such, as the folder would be (L942 self-review M1).
    const parent = dirname(dir);
    let parentThere = true; try { lstat(parent); } catch (x) {
      if (x?.code !== 'ENOENT') return no(`sits in ${parent}, which can't be read (${x?.code ?? x?.message})`);
      parentThere = false;
    }
    if (parentThere) {
      let rp; try { rp = realpath(parent); } catch (x) { return no(`sits in ${parent}, which can't be read (${x?.code ?? x?.message})`); }
      if (rp !== parent) return no(foldKey(rp) === foldKey(parent) ? `sits in ${parent}, which is spelled otherwise on the disk (it is ${rp})` : `sits in ${parent}, which is reached through a link (it is ${rp})`);
      const bad = above();
      if (bad) return no(bad);
    }
    return { missing: true, reason: `its folder ${dir} is missing: make it, owned by the runner's user, mode 0755, in a folder of root's that no one else can write (setup does not make it yet)` };
  }
  if (st.isSymbolicLink()) return no('is a link');
  if (!st.isDirectory()) return no('is not a folder');
  let real; try { real = realpath(dir); } catch (e) { return no(`can't be read (${e?.code ?? e?.message})`); }
  if (real !== dir) return no(foldKey(real) === foldKey(dir) ? `is spelled otherwise on the disk (it is ${real})` : `is reached through a link (it is ${real})`);
  if (st.uid !== uid) return no(`is not owned by the runner's user (its owner is uid ${st.uid}, the runner is ${uid})`);
  if (st.mode & 0o022) return no('can be written by others than the runner (a group or other write bit)');
  const own = acl(dir);
  if (own.length) return no(`has an access list entry that lets others write (${own[0]})`);
  const bad = above();
  return bad ? no(bad) : null;
}

// The access list rights that change nothing (macOS chmod(1), "ACL MANIPULATION"): reading, and the inheritance flags.
// Any other right in an allow entry counts as a write, a name this list doesn't know included.
const ACL_HARMLESS = new Set(['read', 'list', 'search', 'execute', 'readattr', 'readextattr', 'readsecurity', 'file_inherit', 'directory_inherit', 'limit_inherit', 'only_inherit']);
// An entry line as ls -le prints it: "<n>: <who> [inherited ]allow|deny <rights>". Who may hold spaces ("group:Domain
// Users"); the rights, a comma list, are the line's last word.
const ACL_LINE = /^\d+: .+? (?:inherited )?(allow|deny) ([a-z_]+(?:,[a-z_]+)*)$/;
/**
 * A folder's access list entries that may let someone write, read with /bin/ls -lde (macOS); none off a Mac. Every
 * non-empty line after the folder's own line counts, unless it is plainly a deny, or an allow whose rights are all
 * harmless (#419 r4 m1: a line this can't parse is a write entry, never skipped; L942 m1: a numbered one or not). The
 * folder's own line runs on one line for each newline in its path, which ls prints as it is.
 */
export function aclWriteEntries(dir, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return [];
  const r = run('/bin/ls', ['-lde', dir], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`/bin/ls -lde failed (${r.error?.code ?? r.status})`);
  return String(r.stdout).split('\n').slice(1 + (String(dir).match(/\n/g)?.length ?? 0)).map((l) => l.trim()).filter((l) => l !== '')
    .filter((l) => { const m = ACL_LINE.exec(l); return !m || (m[1] === 'allow' && m[2].split(',').some((p) => !ACL_HARMLESS.has(p))); });
}

/**
 * Each product's rules snapshot kept fresh for the runner's life (#369 r1 m2): the sessions' hooks refuse every call once
 * it is 5 minutes old. A rewrite that fails stops its refresher (snapshot.mjs), failing safe. Until it is kept fresh again
 * that product starts no session (#369 r2 m2): `held(product)` starts the refresher once more at each start and, while
 * that fails too, answers why (told once with `log`), so the start is refused. Sessions already running are kept fresh
 * again by the next start that succeeds in this. `recheck(path)` (L942 c5) checks the snapshot's folder again at each
 * start, even while it is kept fresh (its owner may have changed its access list since): a folder that fails holds the
 * product. → { held(product) → reason | null, stop() }.
 */
export function keepSnapshots(c, { fresh = keepSnapshotFresh, log = () => {}, recheck = () => null } = {}) {
  const kept = new Map(); const failed = new Map(); const told = new Set();
  const wanted = (name) => { const p = c.products[name]; return typeof p?.render?.paths?.snapshot === 'string' && p.rules ? p : null; };
  for (const name of Object.keys(c.products)) {
    const p = wanted(name);
    if (!p) continue;
    try { kept.set(name, fresh(p.render.paths.snapshot, p.rules)); } catch (e) { failed.set(name, e); told.add(name); log(`product ${name}'s rules snapshot can't be written (${e?.code ?? e?.message}); its sessions are refused`); }
  }
  const folderTold = new Map();
  const held = (name) => {
    const p = wanted(name);
    if (!p) return null;
    const k = kept.get(name);
    let e; try { e = k ? k.error() : failed.get(name); } catch (x) { e = x; }
    if (!e) {
      let why; try { why = recheck(p.render.paths.snapshot); } catch (x) { why = `it can't be checked (${x?.message ?? x})`; }
      if (!why) { folderTold.delete(name); return null; }
      const reason = `product ${name}'s rules snapshot: ${why}, so its sessions are not started`;
      // Told once for each reason: a new one (an entry added, then the folder renamed away) is told too.
      if (folderTold.get(name) !== why) { folderTold.set(name, why); log(reason); }
      return reason;
    }
    if (k) { try { k.stop(); } catch { /* stopped */ } kept.delete(name); }
    try { kept.set(name, fresh(p.render.paths.snapshot, p.rules)); failed.delete(name); told.delete(name); log(`product ${name}'s rules snapshot is kept fresh again`); return null; } catch (x) {
      failed.set(name, x);
      const reason = `product ${name}'s rules snapshot is not kept fresh (${x?.code ?? x?.message}), so its sessions are not started`;
      if (!told.has(name)) { told.add(name); log(reason); }
      return reason;
    }
  };
  const stop = () => { for (const [name, k] of kept) { try { k.stop(); if (k.error()) log(`product ${name}'s rules snapshot stopped being kept fresh (${k.error()?.code ?? k.error()?.message})`); } catch { /* stopped */ } } };
  return { held, stop };
}

/**
 * argv: [config]. opts (tests only): readConfig, lock, ports, run, log, onStop (how a SIGTERM is listened for), realpath,
 * memory (the memory reader), folderProblem (snapshotFolderProblem).
 * → the exit code.
 */
export async function main(argv, { readConfig = (f) => { const self = selfPath(); if (!self) throw new Error('its own script\'s path can\'t be read, so it can\'t be checked'); return readJobConfig(f, { code: [], optionalCode: ['budget'], self }); }, lock = (dir) => makeLock({ dir, timeoutMs: 2_000 }),
  ports = {}, run = runRunner, log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`), onStop = listenStop, fresh = keepSnapshotFresh,
  realpath = (p) => realpathSync.native(p), memory = loadMemory, folderProblem = (dir) => snapshotFolderProblem(dir),
  pinnedProblem = (root, files) => installProblem(root, files, { owner: 0 }), loadBudget = importBudget, readManifest = readRootFile, portsOf = realRunnerPorts, hooksOf = hookStoreOf } = {}) {
  let c;
  try { c = checkRunnerConfig(readConfig(argv[0])); } catch (e) { log(`the worker runner did not start: ${e.message}`); return 1; }
  // The roots each deny is spelled from are their real paths (#378 r1 m4): the Mac's sandbox does not apply a deny reached
  // through a link (render-settings.mjs), so a root behind one would leave every product's folders open.
  for (const k of ['copiesRoot', 'outboxRoot']) {
    let real; try { real = realpath(c[k]); } catch (e) { log(`the worker runner did not start: ${k} can't be read (${e?.code ?? e?.message})`); return 1; }
    if (real !== c[k]) { log(`the worker runner did not start: ${k} is reached through a link (it is ${real})`); return 1; }
  }
  // Launch checks 12 and 13's files are root's alone in the copy (L1001), as the review runner's are: the budget module
  // runs inside the runner, and the Bob file list decides check 13. One that isn't stops the runner here.
  const pinned = PINNED.map((k) => c[k]).filter((p) => p !== undefined);
  if (pinned.length) {
    let bad; try { bad = pinnedProblem(c.installRoot, pinned); } catch (e) { bad = e?.message ?? String(e); }
    if (bad) { log(`the worker runner did not start: its budget or Bob file list is not root's alone in the installed copy: ${bad}`); return 1; }
  }
  // Each is loaded once (L1001). One that can't be is logged; its check then has no port, so no session starts.
  let budget = null; let bobManifest = null;
  if (c.budget !== undefined) {
    try { budget = await loadBudget(c.budget, { ...c, workerStatusFile: c.statusFile, workerUid: process.getuid() }); } catch (e) { log(`worker runner: the budget module could not be loaded (${e?.message ?? e}); no session starts`); }
    if (budget && !budgetShapeOk(budget)) { log(`worker runner: ${NO_BUDGET_PORTS}; no session starts`); budget = null; }
  }
  if (c.bobManifest !== undefined) {
    try { bobManifest = JSON.parse(readManifest(c.bobManifest)); } catch (e) { log(`worker runner: the Bob file list could not be read (${e?.message ?? e}); no session starts`); }
  }
  // Each product's rules snapshot's folder, only the runner's to write (L926, #419 r3 M1): one anyone else could write
  // stops the runner here, before its lock; a missing one holds that product instead (keepSnapshots, below).
  for (const [name, p] of Object.entries(c.products)) {
    if (typeof p?.render?.paths?.snapshot !== 'string' || !p.rules) continue;
    const f = folderProblem(dirname(p.render.paths.snapshot));
    if (f && !f.missing) { log(`the worker runner did not start: product ${name}'s rules snapshot: ${f.reason}`); return 1; }
  }
  let l; let held;
  // The runner's own folder is setup's, with the access the Dispatcher's reads need: only settings/ is made here (#364 m6).
  try { try { mkdirSync(c.settingsDir, { mode: 0o700 }); } catch (e) { if (e?.code !== 'EEXIST') throw e; } l = lock(c.ownDir); held = l.acquire(); } catch (e) {
    log(`the worker runner did not start: ${/busy/.test(e?.message ?? '') ? 'another worker runner is running' : e?.message ?? e}`); return 1;
  }
  if (held.broke) log('the last worker runner\'s lock was left by a runner that is gone; it was broken');
  let stopping = false;
  onStop(() => { stopping = true; });
  // Each product's rules snapshot is kept fresh for the runner's life (#369 r1 m2, r2 m2: keepSnapshots), in a folder only
  // the runner can write (L926): one anyone else could write refuses the start; a missing one holds the product, saying
  // which folder to make, and is checked again, folder and all, at each later try.
  // Checked again here at each try on purpose (also right after the check above): a missing folder may be made later.
  const guarded = (path, rules) => { const f = folderProblem(dirname(path)); if (f) throw new Error(f.reason); return fresh(path, rules); };
  const snaps = keepSnapshots(c, { fresh: guarded, log, recheck: (path) => folderProblem(dirname(path))?.reason ?? null });
  let P;
  try {
    P = portsOf(c, ports, { stopped: () => stopping, log, productHeld: snaps.held, budget, bobManifest });
    // A memory that can't be read is the loop's to refuse; one read is checked for carried-over sessions first.
    let m = null; try { m = memory(c.memoryFile, { uid: process.getuid() }); } catch { m = null; }
    const why = m ? carriedOverProblem(c, m, { groupGone: P.groupGone }) : null;
    if (why) { log(`the worker runner did not start: ${why}`); return 1; }
    let hooks = null;
    if (c.hookStateDir !== undefined) {
      try { hooks = hooksOf(c); } catch (e) { log(`the worker runner did not start: ${e?.message ?? e}`); return 1; }
      if (hooks.broken) log(`worker runner: ${hooks.broken}; no Lead, Front Door or Mini Base session is typed into until it is fixed by hand`);
    }
    await run({ ...(hooks ? { hooks } : {}), requestsDir: c.requestsDir, statusFile: c.statusFile, memoryFile: c.memoryFile, orchestrateUid: c.orchestrateUid, uid: process.getuid(),
      outboxRoot: c.outboxRoot, copiesRoot: c.copiesRoot, claimMs: c.claimMs, ports: P, note: log, stopWhen: () => stopping });
    return 0;
  } catch (e) { log(`the worker runner stopped: ${e?.message ?? e}`); return 1; } finally {
    snaps.stop();
    try { l.release(held.nonce); } catch { /* gone */ }
  }
}

/** M11's budget module at `file`, called with the runner's config (budget.mjs `budget`). */
export async function importBudget(file, config) { return (await import(pathToFileURL(file).href)).budget(config); }

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** A plain file of root's that no one else writes, read whole without following a link. → its text, or throws. */
export function readRootFile(p, { uid = 0 } = {}) {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.mode & 0o022 || st.size > MAX_MANIFEST_BYTES) throw new Error(`${p} is not root's own plain file`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));

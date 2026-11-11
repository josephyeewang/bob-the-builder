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
//     "pin": "<claude version>"?, "machineWide": "/Library/Application Support/ClaudeCode/managed-settings.json"? (that file only, L913) }
// The launch checks (runner-checks.mjs, step 6) read pin, machineWide and each product's rules; one that is left out
// leaves its check without a port, so launch() refuses there and no session starts. The budget (check 12) and the
// pinned Bob file list (check 13) have no config field yet, so no session starts until they do; a worker is refused
// first at check 4 (no install port), a script session at check 12.
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

import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobConfig } from '../shared/job-config.mjs';
import { makeLock } from '../modules/M9-record/lock.mjs';
import { PRODUCT, runnerPlaces } from '../shared/product-paths.mjs';
import { foldKey } from '../shared/plan-fingerprint.mjs';
import { loadMemory, processGroupPorts, runRunner } from './runner-loop.mjs';
import { drainedPort, liveWallProblem, pauseLeadPort, saveWorkPort, sessionSettingsOf, sizePort, startPort } from './runner-ports.mjs';
import { workerChecks } from './runner-checks.mjs';
import { holdersOf } from '../modules/M4-workshop/launcher/review-runner-main.mjs';
import { keepSnapshotFresh, writeSnapshot } from '../modules/M4-workshop/hooks/snapshot.mjs';
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { fullPath } from './runner-job.mjs';
import { productRoleClash } from './owner-status.mjs';
import { CLAUDE_FILE, MANAGED_SOURCES_CHECKED_ON } from '../modules/M4-workshop/launcher/env-check.mjs';
import { apart } from '../modules/M4-workshop/launcher/render-settings.mjs';

const ABS = ['installRoot', 'requestsDir', 'statusFile', 'outboxRoot', 'copiesRoot', 'home', 'claudeBin', 'recordRoot'];
const UIDS = ['orchestrateUid', 'recordUid'];
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
export const startDeps = (c, { stopped = () => false, log, productHeld, checksOf = (x) => workerChecks(workerCheckInputs(c, x, { log })) } = {}) => ({ stopped, log, productHeld, names: { version: c.pin },
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
export function carriedOverProblem(c, memory, { groupGone, readSettings = sessionSettingsOf(c.settingsDir), listSettings = () => readdirSync(c.settingsDir) } = {}) {
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
    const why = liveWallProblem(live, q, { ...runnerPlaces({ copiesRoot: c.copiesRoot, outboxRoot: c.outboxRoot, product: q }), mirror: c.products[q]?.mirror }, readSettings);
    if (why) return why;
  }
  return null;
}

/** Every SIGTERM is listened for, not only the first (#364 r1 m4): a second one during the drain must not end the run. */
export const listenStop = (fn) => { process.on('SIGTERM', fn); };

/** The ports from the config; `over` replaces any (a test's fakes). `stopped` tells the start port the runner is stopping. */
export function realRunnerPorts(c, over = {}, { stopped = () => false, log, productHeld } = {}) {
  return {
    ...processGroupPorts(),
    start: startPort(c, startDeps(c, { stopped, log, productHeld })),
    saveWork: saveWorkPort({ mirrorOf: (product) => c.products[product]?.mirror }),
    pauseLead: pauseLeadPort(),
    outboxDrained: drainedPort(),
    size: sizePort(),
    ...over,
  };
}

/**
 * Who can write a product's rules snapshot's folder (L926, #419 r3 M1): the runner alone, decided on the disk rather than
 * by a list of places. The folder is its own real path (no link on the way, a link into a copy included), a real folder
 * (not a link), owned by the runner's uid with no group or other write bit; and every folder above it is root's or the
 * runner's, with no group or other write bit unless it is sticky (/private/tmp), so no one else can swap it out (claude's
 * per-user sandbox temp folder is the worker's, and so is a folder under it). No folder on the way carries an access
 * list entry that lets anyone write (L926 self-review M1: a 0755 folder with "everyone allow add_file" is everyone's to
 * write; macOS's own "deny" entries, as on a home folder, are fine). → null | { missing, reason }.
 * opts (tests): lstat, realpath, uid, aclWrites.
 */
export function snapshotFolderProblem(dir, { lstat = lstatSync, realpath = (p) => realpathSync.native(p), uid = process.getuid(), aclWrites = aclWriteEntries } = {}) {
  const no = (why) => ({ missing: false, reason: `its folder ${dir} ${why}` });
  let st; try { st = lstat(dir); } catch (e) {
    if (e?.code === 'ENOENT') return { missing: true, reason: `its folder ${dir} is missing: make it, owned by the runner, mode 0755 (readable by its sessions, writable by the runner alone; setup does not make it yet)` };
    return no(`can't be read (${e?.code ?? e?.message})`);
  }
  if (st.isSymbolicLink()) return no('is a link');
  if (!st.isDirectory()) return no('is not a folder');
  let real; try { real = realpath(dir); } catch (e) { return no(`can't be read (${e?.code ?? e?.message})`); }
  if (real !== dir) return no(foldKey(real) === foldKey(dir) ? `is spelled otherwise on the disk (it is ${real})` : `is reached through a link (it is ${real})`);
  if (st.uid !== uid) return no(`is not the runner's own (its owner is uid ${st.uid}, the runner is ${uid})`);
  if (st.mode & 0o022) return no('can be written by others than the runner (a group or other write bit)');
  const acl = (a) => { try { return aclWrites(a); } catch (e) { return [`its access list can't be read (${e?.message ?? e})`]; } };
  const own = acl(dir);
  if (own.length) return no(`has an access list entry that lets others write (${own[0]})`);
  for (let a = dirname(dir); ; a = dirname(a)) {
    let s; try { s = lstat(a); } catch (e) { return no(`sits in ${a}, which can't be read (${e?.code ?? e?.message})`); }
    if ((s.uid !== 0 && s.uid !== uid) || ((s.mode & 0o022) && !(s.mode & 0o1000))) return no(`sits in ${a}, which others than the runner can change`);
    const up = acl(a);
    if (up.length) return no(`sits in ${a}, which has an access list entry that lets others write (${up[0]})`);
    if (a === '/') return null;
  }
}

// The access list rights that change a folder's entries or the folder itself (macOS chmod(1), "ACL MANIPULATION").
const ACL_WRITES = new Set(['add_file', 'add_subdirectory', 'delete_child', 'delete', 'write', 'append', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
/** A folder's access list "allow" entries that grant a write right, read with /bin/ls -lde (macOS); none off a Mac. */
export function aclWriteEntries(dir, { run = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return [];
  const r = run('/bin/ls', ['-lde', dir], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`/bin/ls -lde failed (${r.error?.code ?? r.status})`);
  return String(r.stdout).split('\n').slice(1).map((l) => l.trim()).filter((l) => /^\d+: /.test(l))
    .filter((l) => { const m = /^\d+: \S+ (?:inherited )?allow (\S+)/.exec(l); return m && m[1].split(',').some((p) => ACL_WRITES.has(p)); });
}

/**
 * Each product's rules snapshot kept fresh for the runner's life (#369 r1 m2): the sessions' hooks refuse every call once
 * it is 5 minutes old. A rewrite that fails stops its refresher (snapshot.mjs), failing safe. Until it is kept fresh again
 * that product starts no session (#369 r2 m2): `held(product)` starts the refresher once more at each start and, while
 * that fails too, answers why (told once with `log`), so the start is refused. Sessions already running are kept fresh
 * again by the next start that succeeds in this. → { held(product) → reason | null, stop() }.
 */
export function keepSnapshots(c, { fresh = keepSnapshotFresh, log = () => {} } = {}) {
  const kept = new Map(); const failed = new Map(); const told = new Set();
  const wanted = (name) => { const p = c.products[name]; return typeof p?.render?.paths?.snapshot === 'string' && p.rules ? p : null; };
  for (const name of Object.keys(c.products)) {
    const p = wanted(name);
    if (!p) continue;
    try { kept.set(name, fresh(p.render.paths.snapshot, p.rules)); } catch (e) { failed.set(name, e); told.add(name); log(`product ${name}'s rules snapshot can't be written (${e?.code ?? e?.message}); its sessions are refused`); }
  }
  const held = (name) => {
    const p = wanted(name);
    if (!p) return null;
    const k = kept.get(name);
    let e; try { e = k ? k.error() : failed.get(name); } catch (x) { e = x; }
    if (!e) return null;
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
export async function main(argv, { readConfig = (f) => { const self = selfPath(); if (!self) throw new Error('its own script\'s path can\'t be read, so it can\'t be checked'); return readJobConfig(f, { code: [], self }); }, lock = (dir) => makeLock({ dir, timeoutMs: 2_000 }),
  ports = {}, run = runRunner, log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`), onStop = listenStop, fresh = keepSnapshotFresh,
  realpath = (p) => realpathSync.native(p), memory = loadMemory, folderProblem = (dir) => snapshotFolderProblem(dir) } = {}) {
  let c;
  try { c = checkRunnerConfig(readConfig(argv[0])); } catch (e) { log(`the worker runner did not start: ${e.message}`); return 1; }
  // The roots each deny is spelled from are their real paths (#378 r1 m4): the Mac's sandbox does not apply a deny reached
  // through a link (render-settings.mjs), so a root behind one would leave every product's folders open.
  for (const k of ['copiesRoot', 'outboxRoot']) {
    let real; try { real = realpath(c[k]); } catch (e) { log(`the worker runner did not start: ${k} can't be read (${e?.code ?? e?.message})`); return 1; }
    if (real !== c[k]) { log(`the worker runner did not start: ${k} is reached through a link (it is ${real})`); return 1; }
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
  const snaps = keepSnapshots(c, { fresh: guarded, log });
  let P;
  try {
    P = realRunnerPorts(c, ports, { stopped: () => stopping, log, productHeld: snaps.held });
    // A memory that can't be read is the loop's to refuse; one read is checked for carried-over sessions first.
    let m = null; try { m = memory(c.memoryFile, { uid: process.getuid() }); } catch { m = null; }
    const why = m ? carriedOverProblem(c, m, { groupGone: P.groupGone }) : null;
    if (why) { log(`the worker runner did not start: ${why}`); return 1; }
    await run({ requestsDir: c.requestsDir, statusFile: c.statusFile, memoryFile: c.memoryFile, orchestrateUid: c.orchestrateUid, uid: process.getuid(),
      outboxRoot: c.outboxRoot, copiesRoot: c.copiesRoot, claimMs: c.claimMs, ports: P, note: log, stopWhen: () => stopping });
    return 0;
  } catch (e) { log(`the worker runner stopped: ${e?.message ?? e}`); return 1; } finally {
    snaps.stop();
    try { l.release(held.nonce); } catch { /* gone */ }
  }
}

function selfPath() { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return undefined; } }
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (invoked && invoked === selfPath()) process.exitCode = await main(process.argv.slice(2));

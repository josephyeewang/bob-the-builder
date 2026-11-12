// The Dispatcher's seven worker and cleanup config keys (L739, L748): what setup can check about them before the Dispatcher
// runs (`check-dispatcher`). Their values come from layout.mjs `dispatcherKeys` (the one place). The mirror and the seal
// folder are rows of the folder table, so `check` already compares their owner and mode exactly; this adds what the table
// can't say:
//   - the review runner's folder (reviewRoot) holds its `launches` folder, so it is the runner's (the Dispatcher refuses
//     to start otherwise);
//   - the owner's host.lock is the owner's file, one plain file the Dispatcher's reader takes, and the Dispatcher's user
//     (orchestrate) can read it. When it can't, the line says why in plain words: a folder above it orchestrate can't go
//     into, the file's own permissions, or macOS privacy protection. A host.lock in a folder macOS guards (a synced cloud
//     folder, Desktop, Documents, Downloads, another volume) is NOT TRIED for the background job: a read from the Terminal
//     is judged by the Terminal's privacy access, not the job's. That holds when host.lock is missing too: the job would be
//     refused the read, not told "no such file" (L763). The place is judged on its real path, with the disk's own case.
// Read only. The read as orchestrate needs root (`sudo -u orchestrate`); without it those lines say NEEDS ROOT.

import { realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { FOLDERS as RUNNER_FOLDERS } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { dispatcherKeys } from './layout.mjs';
import { readUser } from './users-folders.mjs';
import { installPaths } from './install.mjs';                                  // cycles (they read this file's dispatcherKeysOn):
import { DISPATCHER_CONFIG, dispatcherSourcePath } from './dispatcher-setup.mjs';   // all used only when called
import { HOST_LOCK_MAX } from '../wiring/worker-ports.mjs';
import { currentCopy } from '../modules/M4-workshop/launcher/install-check.mjs';
import { PRODUCT } from '../shared/product-paths.mjs';
import { COPY_MAX_AGE_MS, stampProblem } from './host-lock-copy.mjs';

const SUDO = '/usr/bin/sudo';
const DISPATCHER_USER = 'orchestrate';
const asDispatcher = (io, args) => io.run(SUDO, ['-n', '-H', '-u', DISPATCHER_USER, ...args]);

/** The folders above `file`, top first: '/', '/Users', ... its own folder. */
export function foldersAbove(file) {
  const out = []; let d = dirname(file);
  for (;;) { out.unshift(d); const up = dirname(d); if (up === d) break; d = up; }
  return out;
}

// Folders macOS's privacy protection guards whatever the permissions say: a synced cloud folder (for example a Dropbox or an
// iCloud Drive folder), the Desktop, Documents and Downloads folders of a home, and another volume (/Volumes/<name>: a
// removable or network disk). Judged on the real path (realpathSync.native, the disk's own case), and without regard to
// case as well, since the Mac's disk ignores it: `library/cloudStorage` is the same folder (r1 m1, L763).
const GUARDED = /^(\/Users\/[^/]+\/(Library\/CloudStorage|Library\/Mobile Documents|Desktop|Documents|Downloads)|\/Volumes\/[^/]+)(\/|$)/i;
export const guardedFolder = (real) => GUARDED.test(real);

/** The Dispatcher's worker keys on this Mac: dispatcherKeys, with host.lock's owner read as the owner's Mac user id. */
export function dispatcherKeysOn(io, cfg) {
  const o = readUser(io, cfg.owner);
  return dispatcherKeys(cfg, { hostLockUid: o.exists ? o.uid : undefined });
}

/** The first folder above `paths` (each, top first, without repeats) orchestrate can't go into, or null. */
function unsearchable(io, paths) {
  const seen = new Set();
  for (const p of paths) for (const d of foldersAbove(p)) {
    if (seen.has(d)) continue; seen.add(d);
    if (asDispatcher(io, ['/bin/test', '-x', d]).status !== 0) return d;
  }
  return null;
}

/**
 * Why orchestrate can't read `file`, in plain words, once a read as orchestrate has failed. The folders are those of the
 * path as the config names it and of its real place (a link's own parents count: the Dispatcher opens the path as named).
 * Privacy protection is named only when the read was refused as "Operation not permitted" with the permissions allowing it.
 */
export function unreadableWhy(io, file, real, stderr = '', mode) {
  const d = unsearchable(io, [file, real]);
  if (d) return `folder permissions: ${DISPATCHER_USER} can't go into ${d}, a folder above host.lock (every folder above it must let others search it, mode o+x)`;
  const m = Number.isInteger(mode) ? ` is mode ${(mode & 0o777).toString(8).padStart(3, '0')}, which` : '';
  if (asDispatcher(io, ['/bin/test', '-r', real]).status !== 0) return `file permissions: host.lock itself${m} doesn't let ${DISPATCHER_USER} read it (it must be readable by others, mode o+r, for example 644)`;
  if (/Operation not permitted/.test(stderr)) return `macOS privacy protection: the permissions allow it, but macOS refused the read${real !== file ? ` (${file} is really ${real})` : ''}. macOS guards synced cloud folders (under ~/Library/CloudStorage), the Desktop, Documents and Downloads folders, and other disks under /Volumes; keep host.lock outside them`;
  return `the read failed: ${String(stderr).split('\n')[0].trim().slice(0, 160) || 'no reason given'}`;
}

// The two roots the Dispatcher finds each product's folder under (L871, L885 m1): its pass and undo-starts check a
// session's outbox as <outboxRoot>/<product>/<role>/<id>, and cleanup looks for copies at <copiesRoot>/<product>/<card>.
// A root set to a product's own folder would put every outbox and copy one level too deep, so each is named here.
const ROOTS = Object.freeze([['outboxRoot', 'the top outbox root'], ['copiesRoot', 'the workers\' top copies root']]);

/**
 * check-dispatcher's rows for outboxRoot and copiesRoot: the dispatcher.json the job reads (the copy's once there is a copy,
 * else the base's) names each as exactly the root users-folders makes (dispatcherKeys). Read only.
 */
export function rootRows(io, cfg, k) {
  const inCopy = join(installPaths(cfg).installRoot, DISPATCHER_CONFIG); const src = dispatcherSourcePath(cfg);
  // The job reads the copy's file once there is a copy (L871 review m1): a copy without it FAILs, never passes on the base's.
  const cur = currentCopy(io.at(installPaths(cfg).installRoot), { owner: io.rootUid });
  const file = cur.missing ? src : inCopy; let text = null;   // a broken copy is the copy's file too: the job's plist names it
  try { text = io.readText(file); } catch { /* told below */ }
  let c = null; try { c = text === null ? null : JSON.parse(text); } catch { c = null; }
  return ROOTS.map(([key, name]) => {
    const want = io.at(k[key]); const what = `${file} names ${name} ${want} as ${key} (the Dispatcher's ${key})`;
    if (text === null) return { ok: false, what, why: `${file} can't be read${file === inCopy ? ' (the job reads the copy\'s)' : ''}; run dispatcher-config${file === inCopy ? ', then install again if the copy does not keep it' : ''}` };
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, what, why: `${file} is not a JSON object; run dispatcher-config` };
    if (!Object.hasOwn(c, key)) return { ok: false, what, why: `it has no ${key}, so an existing dispatcher.json without it won't start the Dispatcher until dispatcher-config is run again (an older setup wrote it)` };
    const got = c[key];
    if (got === want) return { ok: true, what };
    // A folder right under the root with a product's name: this config's products, or one it dropped.
    const prod = typeof got === 'string' && dirname(got) === want && PRODUCT.test(basename(got)) ? basename(got) : undefined;
    if (prod) return { ok: false, what, why: `it names ${got}, product ${prod}'s own folder, not the root above it: the Dispatcher finds each product's folder under the root, so every outbox or copy would be looked for one level too deep; run dispatcher-config` };
    return { ok: false, what, why: `it names ${JSON.stringify(got)?.slice(0, 160)}, not ${want}; run dispatcher-config` };
  });
}

/**
 * Read only → [{ ok, what, why? } | { ok: true, skip: true, what, why } | { ok: false, notTried: true, what, why }].
 * Not part of checkInstall (install.mjs): `daemons load` and the watch cutover wait on that, and a host.lock the
 * Dispatcher can't read must not stop the review or watch jobs. Its own command is `check-dispatcher`.
 */
export function checkDispatcherKeys(io, cfg, { dispatcher = cfg.dispatcher !== undefined, refused, now = Date.now() } = {}) {
  const out = [];
  const item = (ok, what, why) => out.push({ ok, what, ...(ok ? {} : { why }) });
  const skip = (what, why) => out.push({ ok: true, skip: true, what, why });
  const notTried = (what, why) => out.push({ ok: false, notTried: true, what, why });
  const root = io.euid() === 0;
  let k; try { k = dispatcherKeysOn(io, cfg); } catch (e) { item(false, 'the Dispatcher\'s config keys can be named', e.message); return out; }

  const launches = join(k.reviewRoot, RUNNER_FOLDERS.launches);
  let ls = null; try { ls = io.lstat(launches); } catch { /* reported below */ }
  item(!!ls && ls.isDirectory() && !ls.isSymbolicLink(), `the review runner's folder ${k.reviewRoot} holds its ${RUNNER_FOLDERS.launches} folder (the Dispatcher's reviewRoot)`,
    !ls ? `${launches} is not there yet: the review runner makes it on its first run, so load the review jobs first` : `${launches} is not a plain folder`);

  // With a dispatcher entry (check-dispatcher reads the plain config, so setup.mjs says whether its parser takes one).
  if (dispatcher) for (const row of rootRows(io, cfg, k)) out.push(row);
  // An entry setup refuses (`refused`, its parser's reason): the roots can't be named, which is never a PASS (L905 m1).
  else if (refused !== undefined) item(false, 'the config\'s dispatcher entry is one setup takes, so its outboxRoot and copiesRoot can be checked', `the dispatcher entry is refused (${refused}); its roots can't be checked`);

  const what = `the owner's host.lock (${k.hostLockPath}) is ${cfg.owner}'s and ${DISPATCHER_USER} can read it (the Dispatcher's hostLockPath)`;
  const owner = readUser(io, cfg.owner); const me = readUser(io, DISPATCHER_USER);
  if (!me.exists) { item(false, what, `the ${DISPATCHER_USER} user doesn't exist yet; run users-folders first`); return out; }
  // With the owner's copier (hostLockSource, L1029 E), hostLockPath is its copy: the copy is only as good as the copier's last
  // run, so a stamp older than COPY_MAX_AGE_MS (or none) is a FAIL, whatever the copy says (host-lock-copy.mjs).
  if (cfg.hostLockSource !== undefined) {
    const copied = `the owner's host.lock copier has copied ${cfg.hostLockSource} to ${k.hostLockPath} in the last ${COPY_MAX_AGE_MS / 60_000} minutes`;
    const bad = owner.exists ? stampProblem(io, k.hostLockPath, { now, ownerUid: owner.uid }) : `the owner ${cfg.owner} is not a user on this Mac`;
    item(bad === null, copied, bad);
  }
  const needsRoot = `reading it as ${DISPATCHER_USER} needs root; run check-dispatcher with sudo`;
  // The real place, with the disk's own case (r1 m1): the guarded-folder test reads it.
  const realOf = (p) => { const at = realpathSync.native(io.at(p)); return io.prefix ? at.slice(realpathSync.native(io.prefix).length) || sep : at; };
  // A read from here is judged by macOS as the app this command runs in (the Terminal), not the Dispatcher's background job.
  // In a guarded folder that proves only the permissions, so it is never a PASS for the job.
  const job = `the Dispatcher's own background job can read host.lock (macOS privacy protection)`;
  const jobLine = (real, { missing = false } = {}) => {
    if (guardedFolder(real)) notTried(job, missing
      ? `host.lock is not there now, and would be ${real}, in a folder macOS's privacy protection guards. The Dispatcher's background job doesn't have this Terminal's privacy access: it would be refused the read ("Operation not permitted"), not told "no such file", and would say "not known" on every pass. Keep host.lock outside the guarded folders, or prove the read from the job itself`
      : `host.lock is really ${real}, in a folder macOS's privacy protection guards. The read above ran with this Terminal's privacy access, which the Dispatcher's background job doesn't have, so it proves only the permissions. Keep host.lock outside the guarded folders, or prove the read from the job itself`);
    else if (root) item(true, job);
  };
  let st;
  try { st = io.lstat(k.hostLockPath); } catch (e) {
    if (e?.code === 'EACCES' && !root) { skip(what, needsRoot); jobLine(k.hostLockPath); return out; }
    if (e?.code !== 'ENOENT') { item(false, what, `it can't be looked at (${e?.code ?? e})`); return out; }
    // Missing is what the Dispatcher reads as "no host claimed", but only if it can reach the folder to see that, and only
    // if macOS lets its job look there at all (r1 M1, L763): the guarded-folder test runs on the folder's real place.
    const gone = `the owner's host.lock (${k.hostLockPath}) is not there, which the Dispatcher reads as no host claimed, and ${DISPATCHER_USER} can reach its folder`;
    let real;
    try { real = join(realOf(dirname(k.hostLockPath)), basename(k.hostLockPath)); } catch (e2) {
      if (e2?.code === 'EACCES' && !root) { skip(gone, needsRoot); jobLine(k.hostLockPath, { missing: true }); return out; }
      item(false, gone, e2?.code === 'ENOENT' ? `its folder ${dirname(k.hostLockPath)} is not there, so the path is wrong; the Dispatcher would say "not known" on every pass` : `its folder's real place can't be found (${e2?.code ?? e2})`); return out;
    }
    if (!root) skip(gone, needsRoot);
    else { const d = unsearchable(io, [k.hostLockPath, real]); item(d === null, gone, `folder permissions: ${DISPATCHER_USER} can't go into ${d}, so the Dispatcher would say "not known" on every pass instead`); }
    jobLine(real, { missing: true }); return out;
  }
  if (st.uid === me.uid) { item(false, what, `it is ${DISPATCHER_USER}'s own file; it must be ${cfg.owner}'s, so the Dispatcher can't have written it`); return out; }
  if (!owner.exists || st.uid !== owner.uid) { item(false, what, `its owner is uid ${st.uid}, not ${cfg.owner}${owner.exists ? ` (uid ${owner.uid})` : ''}`); return out; }
  // The Dispatcher reads it without following a link, as one plain file with one name, of at most HOST_LOCK_MAX bytes (worker-ports.mjs).
  if (!st.isFile()) { item(false, what, st.isSymbolicLink() ? 'it is a link; the Dispatcher reads it without following one, so it must be the file itself' : 'it is not a plain file'); return out; }
  if (st.nlink !== 1) { item(false, what, `it has ${st.nlink} names (hard links); the Dispatcher refuses that`); return out; }
  if (st.size > HOST_LOCK_MAX) { item(false, what, `it is ${st.size} bytes; the Dispatcher reads at most ${HOST_LOCK_MAX}`); return out; }
  let real;
  try { real = realOf(k.hostLockPath); } catch (e) {
    if (e?.code === 'EACCES' && !root) { skip(what, needsRoot); jobLine(k.hostLockPath); return out; }
    item(false, what, `its real place can't be found (${e?.code ?? e})`); return out;
  }
  if (!root) { skip(what, needsRoot); jobLine(real); return out; }
  const r = asDispatcher(io, ['/bin/cat', k.hostLockPath]);
  if (r.status !== 0) { item(false, what, `${DISPATCHER_USER} can't read it, so the Dispatcher would say "not known" on every pass. Why: ${unreadableWhy(io, k.hostLockPath, real, r.stderr, st.mode)}`); return out; }
  item(true, what);
  jobLine(real);
  return out;
}

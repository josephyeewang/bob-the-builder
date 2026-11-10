// The ports that start, find and stop a worker (PR C and the worker half of D), and the cleanup group.
//
// `wire()` calls `workerPorts(ctx)` and adds what it returns. To wire a port: answer it here and take its name off
// NOT_WIRED_WORKER, in the same change. dispatcher-wiring.mjs stays as it is.
//
// WIRED (C, L739):
//   hostLock()           → the text of Joe's host.lock (config hostLockPath, a file of config hostLockUid's), or null when there is no such file in a
//                          folder that is there. A file or folder that can't be read throws: pass.mjs reads a throw as
//                          "not known" and tells it, never as "no host". The read runs through limitedSync (a Dropbox
//                          file may hang while it downloads).
//   reviewEnded(session) → M9 runnerEnded on the runner's ended records (<reviewRoot>/ended), for the session's own
//                          role, card and head. A runner folder that is gone, or not the review user's, is a refusal
//                          with its reason, never "not ended yet".
//   cleanup.mirrorFor    → the product's mirror (config mirror) for a card of this Dispatcher's product, else null.
//   cleanup.git          → safe-git, on the mirror only, and only the two reads cleanup makes (ls-tree, merge-base).
//   cleanup.sealRoot     → config sealRoot, a private folder of this user's, checked at start and on each read.
// The mirror and the seal folder are checked when the wiring starts, so a wrong path stops the start.

import { lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRefusing, refusing } from './not-wired.mjs';
import { privateFolder } from './private-folder.mjs';
import { checkMirror, git as safeGit } from '../modules/M4-workshop/git/safe-git.mjs';
import { ENDED_FOLDER, runnerEnded } from '../modules/M9-record/outbox.mjs';
import { FOLDERS as RUNNER_FOLDERS } from '../modules/M4-workshop/launcher/review-runner.mjs';

const RUNNER_LAUNCHES = RUNNER_FOLDERS.launches;

export const NOT_WIRED_WORKER = Object.freeze(['sessions', 'probe', 'launch', 'stopGroup', 'saveWork', 'pauseLead',
  'board', 'outboxSessions', 'stopSession']);
// What the cleanup step reads (cleanupPass's own parameters, less what the tick gives every step: a test pins the two
// together), and which of those aren't wired yet. To wire one: answer it in `cleanup` below and take it off NOT_WIRED_CLEANUP.
export const CLEANUP_PORTS = Object.freeze(['mirrorFor', 'git', 'saveWork', 'copiesRoot', 'sealRoot']);
export const NOT_WIRED_CLEANUP = Object.freeze(['saveWork', 'copiesRoot']);

/** Why the cleanup group can't start, or null. The same rules as the tick's ports, inside the one port the tick reads as a group. */
export function cleanupProblem(cleanup) {
  const d = Object.getOwnPropertyDescriptors(cleanup);
  const refuses = (k) => isRefusing(d[k]?.get ?? d[k]?.value);
  const names = (list) => list.map((k) => `cleanup.${k}`).join(', ');
  const listed = CLEANUP_PORTS.filter((k) => NOT_WIRED_CLEANUP.includes(k) && !refuses(k));
  if (listed.length) return `these ports are wired but still listed as not wired: ${names(listed)}`;
  const neither = CLEANUP_PORTS.filter((k) => !NOT_WIRED_CLEANUP.includes(k) && (!d[k] || refuses(k)));
  if (neither.length) return `nothing answers or lists these ports, which the tick needs: ${names(neither)}`;
  const other = Object.keys(d).filter((k) => !CLEANUP_PORTS.includes(k));
  return other.length ? `no tick step reads these ports: ${names(other)}` : null;
}

/**
 * The product's git mirror (config mirror): a plain folder, not a link, of this user's, that no one else can write
 * (setup makes it orchestrate's, 0755). Throws saying why. Checked at start and again on each use, so a mirror that goes
 * away later is told, never read as "no mirror". The one check: review-ports.mjs filesOf uses it too.
 */
export function mirrorProblem(mirror, uid, { lstat = lstatSync, shape = checkMirror } = {}) {
  let st;
  try { st = lstat(mirror); } catch (e) { return `the product's mirror (mirror) ${mirror} can't be read (${e?.code ?? e})`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `the product's mirror (mirror) ${mirror} is not a plain folder`;
  if (st.uid !== uid) return `the product's mirror (mirror) ${mirror} belongs to uid ${st.uid}, not to this job's uid ${uid}`;
  if (st.mode & 0o022) return `the product's mirror (mirror) ${mirror} can be written by others (mode ${(st.mode & 0o777).toString(8)})`;
  // safe-git's own mirror check, as worker-copy and push run it: its config is the template, and nothing in it (grafts,
  // shallow, commit-graph, alternates, hooks) changes what a commit's parents or files are read as (r1 m2, L763).
  const m = shape(mirror);
  if (!m?.ok) return `the product's mirror (mirror) ${mirror} can't be used: ${m?.reason ?? 'its check gave no answer'}`;
  return null;
}
export function checkedMirror(mirror, uid, opts) {
  const why = mirrorProblem(mirror, uid, opts);
  if (why) throw new Error(why);
  return mirror;
}

// The two reads cleanup.mjs makes of the mirror (mirrorTree's ls-tree, the on-main merge-base). Anything else is refused.
export const CLEANUP_GIT = Object.freeze(['ls-tree', 'merge-base']);
export const CLEANUP_GIT_MS = 60_000;

/** The cleanup group's wired ports for one product. `run` is safe-git's runner (a port for a test). */
export function cleanupPorts({ config: c, selfUid }, { run = safeGit } = {}) {
  checkedMirror(c.mirror, selfUid);
  const sealWhat = 'the seal folder (sealRoot)';
  privateFolder({ path: c.sealRoot, uid: selfUid, what: sealWhat, create: true, writable: true });
  const ports = {
    // One Dispatcher runs one product (M9): a card of another product has no mirror here.
    mirrorFor: (doc) => (doc?.product === c.product ? checkedMirror(c.mirror, selfUid) : null),
    git: (args, opts = {}) => {
      if (opts.gitDir !== c.mirror) return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: `cleanup git: refused: only the product's mirror is read here, not ${opts.gitDir}` });
      if (!CLEANUP_GIT.includes(args?.[0])) return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: `cleanup git: refused: only ${CLEANUP_GIT.join(' and ')} run on the mirror` });
      const bad = mirrorProblem(c.mirror, selfUid);
      if (bad) return Promise.resolve({ code: -1, stdout: Buffer.alloc(0), stderr: `cleanup git: refused: ${bad}` });
      // Only these options reach safe-git: no other program, path, work tree or config can be asked for (self-review m2).
      // The time limit is at most CLEANUP_GIT_MS, given or not: cleanup.mjs gives none (r1 m1, L763).
      return run(args, { gitDir: c.mirror, purpose: opts.purpose, timeoutMs: Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.min(opts.timeoutMs, CLEANUP_GIT_MS) : CLEANUP_GIT_MS });
    },
  };
  // A folder, read on each pass: one that can't be used throws inside the step, so the sweep is never skipped in silence.
  Object.defineProperty(ports, 'sealRoot', { enumerable: true, get: () => privateFolder({ path: c.sealRoot, uid: selfUid, what: sealWhat, writable: true }) });
  return ports;
}

// host.lock is read in a child under limitedSync (the Dropbox read is held to its time limit), opened without following a
// link and checked on the opened file: a plain file of the owner's (config hostLockUid), with one name, at most
// HOST_LOCK_MAX bytes. The folder is one the owner's user can write, so it can point the name at another file by a link in
// the folders above, a hard link, or a link made and removed in the gap between the open and the check (r1 M1: 44 of 400
// reads got another file's text). The owner check is on the file that was opened, so none of those gets a file that is
// not the owner's own into the Record, and the owner can read their own files anyway (L739 self-review M1, L763).
export const HOST_LOCK_MAX = 4096;
/** Why `uid` can't be host.lock's owner (config hostLockUid), or null. The Dispatcher can write its own files, so a host.lock
 * of its own would let it say who the host is (L739 self-review M1); root's files are not the owner's to give, nor the review
 * user's (L763 self-review). */
export function hostLockOwnerProblem(uid, selfUid, reviewUid) {
  if (!Number.isSafeInteger(uid) || uid < 0) return "hostLockUid (the owner's Mac user id, host.lock's owner) must be a Mac user id";
  if (uid === 0) return "hostLockUid is root; host.lock must be the owner's";
  if (uid === selfUid) return "hostLockUid is the Dispatcher's own user; host.lock must be the owner's";
  if (uid === reviewUid) return "hostLockUid is the review user; host.lock must be the owner's";
  return null;
}
const HOST_LOCK_READ = `const fs = require('fs'); const [p, owner, max] = process.argv.slice(1); const say = (o) => process.stdout.write(JSON.stringify(o));
let fd; try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) { say({ code: e.code || String(e) }); process.exit(0); }
const st = fs.fstatSync(fd);
if (st.uid !== Number(owner)) say({ no: "is not the owner's file (its owner is uid " + st.uid + ', not ' + owner + ')' });
else if (!st.isFile()) say({ no: 'is not a plain file' }); else if (st.nlink !== 1) say({ no: 'has another name too (a hard link)' });
else if (st.size > Number(max)) say({ no: 'is over ' + max + ' bytes' });
else { const b = Buffer.alloc(Number(max) + 1); let n = 0; for (;;) { const k = fs.readSync(fd, b, n, b.length - n, null); if (k === 0) break; n += k; if (n === b.length) break; }
  if (n > Number(max)) say({ no: 'is over ' + max + ' bytes' }); else say({ text: b.subarray(0, n).toString('utf8') }); }`;

/**
 * hostLock for Joe's host.lock at `path`, which must be owner `ownerUid`'s file (config hostLockUid), read as Dispatcher
 * user `selfUid`. Missing file in a folder that is there → null (no host claimed). Anything else that stops the read
 * throws, so the pass reads it as "not known". Read by `run` (limitedSync's), in a child of this Node.
 */
export function hostLockPort({ path, run, ownerUid, selfUid, stat = statSync, node = process.execPath }) {
  return () => {
    if (typeof run !== 'function') throw new Error('host.lock: the wiring was given no limitedSync to read it with');
    if (!Number.isSafeInteger(selfUid)) throw new Error("host.lock: the wiring was given no Dispatcher uid to check it against");
    const bad = hostLockOwnerProblem(ownerUid, selfUid);
    if (bad) throw new Error(`host.lock: the config's ${bad}`);
    const r = run(node, ['-e', HOST_LOCK_READ, path, String(ownerUid), String(HOST_LOCK_MAX)], { timeoutMs: 10_000 });
    if (!r?.ok) throw new Error(`host.lock ${path} can't be read (${r?.why ?? 'no answer'})`);
    let got;
    try { got = JSON.parse(String(r.stdout)); } catch { throw new Error(`host.lock ${path} can't be read (its reader said nothing it could parse)`); }
    if (typeof got?.text === 'string') return got.text;
    if (got?.no) throw new Error(`host.lock ${path} ${got.no}`);
    if (got?.code === 'ELOOP') throw new Error(`host.lock ${path} is not a plain file`);
    if (got?.code !== 'ENOENT') throw new Error(`host.lock ${path} can't be read (${got?.code ?? 'no answer'})`);
    // Missing is "no host" only when its folder is there and is a folder: a wrong path is told, never "no host".
    let up;
    try { up = stat(dirname(path)); } catch (u) { throw new Error(`host.lock's folder ${dirname(path)} can't be read (${u?.code ?? u})`); }
    if (!up.isDirectory()) throw new Error(`host.lock's folder ${dirname(path)} is not a folder`);
    return null;
  };
}

/**
 * reviewEnded for the runner at `root` (config reviewRoot), as review user `uid`: M9 runnerEnded on <root>/ended. A
 * runner folder that is gone, a link or not the review user's answers a refusal with its reason, never `none`: M9 reads
 * a missing ended folder as "not ended yet", which a wrong path would make for ever.
 */
export function reviewEndedPort({ root, uid, lstat = lstatSync, ended = runnerEnded }) {
  return (s) => {
    let st;
    try { st = lstat(root); } catch (e) { return { ok: false, reason: `the review runner's folder (reviewRoot) ${root} can't be read (${e?.code ?? e})` }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `the review runner's folder (reviewRoot) ${root} is not a plain folder` };
    if (st.uid !== uid) return { ok: false, reason: `the review runner's folder (reviewRoot) ${root} is not owned by the review user` };
    return ended({ root: join(root, ENDED_FOLDER), uid, role: s?.role, card: s?.card, head: s?.head, sessionId: s?.sessionId });
  };
}

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function workerPorts(ctx) {
  const c = ctx.config;
  // The runner's folder must be there at start (a typo would read as "not ended" for ever); its owner is checked on each
  // call, as the other review ports check theirs (L674).
  let rs;
  try { rs = lstatSync(c.reviewRoot); } catch (e) { throw new Error(`the review runner's folder (reviewRoot) ${c.reviewRoot} can't be read (${e?.code ?? e})`); }
  if (rs.isSymbolicLink() || !rs.isDirectory()) throw new Error(`the review runner's folder (reviewRoot) ${c.reviewRoot} is not a plain folder`);
  // A real folder that is not the runner's would read as "not ended" for ever: the runner's launch records must be in it.
  let ls;
  try { ls = lstatSync(join(c.reviewRoot, RUNNER_LAUNCHES)); } catch (e) { throw new Error(`the review runner's folder (reviewRoot) ${c.reviewRoot} has no ${RUNNER_LAUNCHES} folder, so it is not the runner's (${e?.code ?? e})`); }
  if (ls.isSymbolicLink() || !ls.isDirectory()) throw new Error(`the review runner's folder (reviewRoot) ${c.reviewRoot} has no ${RUNNER_LAUNCHES} folder, so it is not the runner's`);
  // Every unwired cleanup port refuses when READ, not only when called: cleanupPass reads a folder it can't use (a
  // function in its place included) as nothing to do (cleanup.mjs), which would pass in silence (audit #127 r2 m-C;
  // #310 audit m-2: no hand-kept list of which ones are folders). The tick spreads this object into the step, so the
  // read throws inside the step. The wired ones come first, so the first refusal is NOT_WIRED_CLEANUP[0].
  // A host.lock owner that can't be right stops the start, before anything is made, rather than making every pass "not known"
  // (L763). Root's files and the review user's are not the owner's to name the host with.
  const lockOwner = hostLockOwnerProblem(c.hostLockUid, ctx.selfUid, c.reviewUid);
  if (lockOwner) throw new Error(`config: ${lockOwner}`);
  const cleanup = cleanupPorts(ctx);
  for (const k of NOT_WIRED_CLEANUP) Object.defineProperty(cleanup, k, { enumerable: true, get: refusing(`cleanup.${k}`) });
  return {
    cleanup,
    hostLock: hostLockPort({ path: c.hostLockPath, run: ctx.limitedSync, ownerUid: c.hostLockUid, selfUid: ctx.selfUid }),
    reviewEnded: reviewEndedPort({ root: c.reviewRoot, uid: c.reviewUid }),
  };
}

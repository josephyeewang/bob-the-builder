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
//   cleanup.copiesRoot   → config copiesRoot, the TOP worker-copies folder (<base>/worker-copies; cleanupPass enters
//                          each product's folder under it, L836): a real folder, not a link, checked on each read (L887).
//                          cleanupPass, as the orchestrate user, lists, reads and deletes in it directly, so setup gives
//                          orchestrate an access list of its own there (L747): list, search, read (file contents and
//                          attributes, so a copy can be hashed) and delete, inherited by every file and folder made under
//                          it; no add, no write; it deletes only after cleanupPass's checks (or on Joe's counted Yes).
//   outboxRoot           → config outboxRoot, the TOP outboxes folder (<base>/outboxes): the pass checks a launch's
//                          outbox in <outboxRoot>/<product>/<role>/<id> under it (#403 r1 M1, L887).
//   product              → config product, this Dispatcher's (a value, L927): the stop step acts only on the sessions
//                          whose own product it is (pass.mjs stopPass).
//
// WIRED (B, L925, L927, L933), from the worker runner's status (config workerStatusFile, the owner's, workerUid) and the
// review runner's (config reviewStatusFile, the review user's), each read whole on every call (owner-status.mjs):
//   sessions()           → Mac-wide, every product's: the worker runner's live sessions, then the review runner's
//                          reviewers and auditors (kind review and audit, from their role, each with runner_stop when
//                          its row shows a stop, L968; reviewSessions below). Either
//                          status missing, stale or not of its runner's shape throws: never one runner's half. Plan
//                          reviewers are left out: planReviewsRunning counts them, so they would count twice (L933).
//   board()              → this product's worker sessions only, by the product the status names (L927); a dead one's
//                          claim is read from this Record (recordHolds).
//   outboxSessions()     → this product's open worker and script outboxes: another product's are its own Dispatcher's.
//   probe(session)       → the worker runner's, for the kinds it starts (RUNNER_KINDS). Every other kind throws: the
//                          review runner reports no size or activity, and no runner here starts the rest (L925 rule 2).
//   stopSession(id)      → the worker runner's: true once the launch request is used up, else a stop request in its
//                          requests folder (config workerRequestsDir, the owner's, which orchestrate may add files to; its owner, mode and
//                          access list are checked on each write, L943 m4).
//
// WIRED (C, L963), the four asks (owner-asks.mjs ownerAsyncPorts): each writes one request through the same checked writer
// as stopSession (runnerRequestWriter) and waits until the same status file bears its answer out, or its own limit
// (ASK_GIVE_UP_MS) answers { ok: false, timedOut: true }; the tick's limit (pass.mjs guarded) answers first.
//   launch(x)            → launch-<sessionId>.json; ok once the runner lists the session it started.
//   stopGroup(session)   → stopGroup-<id>-<nonce>.json; ok once the session is listed stopped (ok: false: it may still run).
//   saveWork(session)    → saveWork-<id>-<nonce>.json; review, audit and the other kinds with no copy are ok unasked.
//   pauseLead({product}) → pauseLead-<product>-<nonce>.json; any failure is a throw.
// On the runner's side three still refuse, each with its reason in the answer (cutover blockers, not this file's): a
// launch ("not wired: no worker prompt is given to the runner", runner-ports.mjs promptFor), a save (M4 save-work with no
// lock-down runner, runLocked) and a pause ("not wired: the Lead's wrap-up needs the activity tracker's feed"). Until
// they are given, no worker starts, no stop is cleared as saved, and every pause throws and is told.
// cleanup.saveWork stays unwired (NOT_WIRED_CLEANUP).
// The mirror and the seal folder are checked when the wiring starts, so a wrong path stops the start.

import { lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { isRefusing, refusing } from './not-wired.mjs';
import { privateFolder } from './private-folder.mjs';
import { checkMirror, git as safeGit } from '../modules/M4-workshop/git/safe-git.mjs';
import { ENDED_FOLDER, runnerEnded } from '../modules/M9-record/outbox.mjs';
import { FOLDERS as RUNNER_FOLDERS, STOP_SHOWN, readReviewStatus, stopStamp } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { CLOCK_SKEW_MS, RUNNER_KINDS, ownerSyncPorts, requestWriter } from './owner-status.mjs';
import { ownerAsyncPorts } from './owner-asks.mjs';
import { PLAN_REVIEW_ROLE } from '../shared/review-roles.mjs';
import { WORKER_REQUESTS_ACL, aclText } from '../setup/layout.mjs';

const RUNNER_LAUNCHES = RUNNER_FOLDERS.launches;

export const NOT_WIRED_WORKER = Object.freeze([]);
// What the cleanup step reads (cleanupPass's own parameters, less what the tick gives every step: a test pins the two
// together), and which of those aren't wired yet. To wire one: answer it in `cleanup` below and take it off NOT_WIRED_CLEANUP.
export const CLEANUP_PORTS = Object.freeze(['mirrorFor', 'git', 'saveWork', 'copiesRoot', 'sealRoot']);
export const NOT_WIRED_CLEANUP = Object.freeze(['saveWork']);

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

/** `path` when it is a real folder (not a link), else a throw naming `what` (L887). */
function realFolder(path, what) {
  let s;
  try { s = lstatSync(path); } catch (e) { throw new Error(`${what} ${path} can't be read (${e?.code ?? e})`); }
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`${what} ${path} is not a plain folder`);
  return path;
}

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
  // The top copies folder (L887), the owner's (setup layout.mjs, read and deleted in through its access-list entry): a
  // missing one, a link or a file throws inside the step, never reads as "no copies".
  Object.defineProperty(ports, 'copiesRoot', { enumerable: true, get: () => realFolder(c.copiesRoot, 'the worker copies folder (copiesRoot)') });
  return ports;
}

// host.lock is read in a child under limitedSync (the Dropbox read is held to its time limit), opened without following a
// link and checked on the opened file: a plain file of the owner's (config hostLockUid), with one name, at most
// HOST_LOCK_MAX bytes. The folder is one the owner's user can write, so it can point the name at another file by a link in
// the folders above, a hard link, or a link made and removed in the gap between the open and the check (r1 M1: 44 of 400
// reads got another file's text). The owner check is on the file that was opened, so none of those gets a file that is
// not the owner's own into the Record, and the owner can read their own files anyway (L739 self-review M1, L763).
export const HOST_LOCK_MAX = 4096;
/** Why the config's workerUid can't be the worker runner's user, or null: it must be a Mac user id and host.lock's owner's
 * (hostLockUid). The runner is a LaunchAgent of the owner's own user (runner-job.mjs, L896), so one check on hostLockUid
 * covers it (not root, not the Dispatcher's, not the review user's), and a config naming two owners stops at the config
 * check (dispatcher-wiring.mjs checkConfig, before wire() makes a folder; L943 m3) and again at workerPorts. */
export function workerUidProblem(c) {
  if (!Number.isSafeInteger(c?.workerUid) || c.workerUid < 0 || c.workerUid !== c.hostLockUid) return "workerUid must be the owner's Mac user id, hostLockUid's: the worker runner runs as the owner";
  return null;
}

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

// The review runner's roles as sessions() kinds (gate.mjs: review and audit, both free of the caps). The plan reviewer
// is counted by planReviewsRunning instead; any other role is not the review runner's, and makes the list "not known".
export const REVIEW_KIND_OF = Object.freeze({ reviewer: 'review', auditor: 'audit' });
const HEX40 = /^[0-9a-f]{40}$/;
// The hold id review-runner.mjs lists while its memory file can't be read.
export const REVIEW_STATE_CORRUPT = 'state-corrupt';

/**
 * The review runner's running reviewers and auditors as sessions() rows, from its checked status (readReviewStatus), or
 * a throw. The status names no product, process group, sign-in or settings folder, so those are null: product null is no
 * product's, so the worker stop never reaches one. Each row carries the head it reviews (40 hex, as the runner's stop
 * file needs it): the stop step asks the runner to end one only for a card of this Record at that very head (pass.mjs
 * stopPass, L946). A status whose runner could not read its own memory lists none running, so that one is a throw.
 */
export function reviewSessions(status, { now = Date.now() } = {}) {
  // review-runner.mjs: with its memory unreadable it starts nothing and writes running: [] with this hold; the reviewers
  // still running are then not known, so neither is the list (L925 rule 1, #B self-review m2).
  // Latent (L943 c4, M4's to change): readReviewStatus (M4 review-runner.mjs) reads a `holds` that is not a list as [],
  // so a status whose holds were written wrong would hide a state-corrupt hold here. The runner always writes a list today.
  if ((status?.holds ?? []).some((h) => h?.id === REVIEW_STATE_CORRUPT)) throw new Error('the review runner can\'t read its own memory, so which reviewers run is not known');
  const out = [];
  for (const r of status?.running ?? []) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('a session in the review runner\'s status is not what the runner writes');
    if (r.role === PLAN_REVIEW_ROLE) continue;
    if (!Object.hasOwn(REVIEW_KIND_OF, r.role)) throw new Error(`a session in the review runner's status has role ${JSON.stringify(r.role)}, which the review runner does not start`);
    if (typeof r.session_id !== 'string' || !r.session_id) throw new Error('a session in the review runner\'s status has no session id');
    if (typeof r.card !== 'string' || !r.card) throw new Error(`review session ${r.session_id} in the review runner's status has no card`);
    if (typeof r.head !== 'string' || !HEX40.test(r.head)) throw new Error(`review session ${r.session_id} in the review runner's status names no head (40 hex)`);
    // The stop the runner shows on the row (L968, review-runner.mjs STOP_SHOWN): made, given up on, or tried again. One that
    // is not a time is not what the runner writes, so the list is not known (as for the head): only a stopStamp, ISO to the
    // millisecond and not later than now by more than CLOCK_SKEW_MS (#458 r1 m-c).
    for (const f of STOP_SHOWN) if (r[f] !== undefined && !stopStamp(r[f], now, CLOCK_SKEW_MS)) throw new Error(`review session ${r.session_id} in the review runner's status has a ${f} that is not a time (ISO, not in the future)`);
    const shown = r.stopped_by_request ? 'stopped' : r.stop_failed ? 'failed' : r.stop_wanted ? 'wanted' : null;
    out.push({ id: r.session_id, product: null, kind: REVIEW_KIND_OF[r.role], card: r.card, head: r.head, lead: null, role: r.role, pgid: null, signin: null, config_dir: null, bundle_files: [], ...(shown ? { runner_stop: shown } : {}) });
  }
  return out;
}

/**
 * holds({ card, sessionId }) for the board (owner-status.mjs): is `card` still claimed or running under that session's
 * claim in this Record? A card not in the Record is false; one the Record reports corrupt, or a read that throws, throws.
 */
export function recordHolds(rec) {
  return ({ card, sessionId }) => {
    const o = rec.read('card', card);
    if (o == null) return false;
    if (o.corrupt || !o.doc) throw new Error(`card ${card} can't be read from the Record (${o.reason ?? 'no document'})`);
    return (o.doc.state === 'claimed' || o.doc.state === 'running') && o.doc.claim?.kind === 'session' && o.doc.claim.session_id === sessionId;
  };
}

/** Why the worker runner's requests folder can't take a request, or null: a plain folder (not a link) of the runner's user,
 * that group and others can't write, with no access-list entry letting anyone write it but setup's own (L943 m4). */
export function requestsFolderProblem(dir, uid, { lstat = lstatSync, acl = requestsAclProblem } = {}) {
  const what = `the worker runner's requests folder (workerRequestsDir) ${dir}`;
  let st;
  try { st = lstat(dir); } catch (e) { return `${what} can't be read (${e?.code ?? e})`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${what} is not a plain folder`;
  if (st.uid !== uid) return `${what} is not the owner's (workerUid)`;
  // As the other folder checks (L943 m4): no group or other write, and no access-list entry that lets anyone write but
  // setup's own (orchestrate may only add a file, setup/layout.mjs WORKER_REQUESTS_ACL).
  if (st.mode & 0o022) return `${what} can be written by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  const bad = acl(dir);
  return bad ? `${what} ${bad}` : null;
}

// The rights an access-list entry can give on a folder that let its holder change what is in it (macOS chmod +a names).
const ACL_WRITES = Object.freeze(['write', 'add_file', 'add_subdirectory', 'append', 'delete', 'delete_child', 'writeattr', 'writeextattr', 'writesecurity', 'chown']);
const REQUESTS_ENTRY = aclText(WORKER_REQUESTS_ACL);
/**
 * Why the requests folder's access list lets someone write it other than through setup's one entry, or null (L943 m4).
 * Read with /bin/ls -led, as M4's aclProblem and setup's aclEntries read one. A deny entry and an entry that only reads
 * pass; setup's own entry passes only as made on the folder itself (an inherited copy is not setup's). A list that can't
 * be read, or an entry that can't be parsed, is a refusal. `run` and `platform` are ports for a test.
 */
export function requestsAclProblem(dir, { run = spawnSync, platform = process.platform } = {}) {
  const r = run('/bin/ls', [platform === 'darwin' ? '-led' : '-ld', '--', dir], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 30_000 });
  if (r?.error || r?.status !== 0) return `has an access list that could not be read (${String(r?.error?.message ?? r?.stderr ?? `exit ${r?.status}`).trim().slice(0, 120)})`;
  const lines = String(r.stdout).split('\n');
  // Off macOS, `ls -l` shows only a `+` after the mode: any list at all is refused, since it can't be read entry by entry.
  if (platform !== 'darwin') return /^[-d][-rwxsStT]{9}\+/.test(lines[0] ?? '') ? 'has an access list (ACL), which can let others write it' : null;
  for (const line of lines) {
    if (!/^\s+\d+: /.test(line)) continue;
    const m = /^\s+\d+: ((?:user|group):\S+) (inherited )?(allow|deny) (\S+)\s*$/.exec(line);
    if (!m) return `has an access-list entry that can't be read (${line.trim().slice(0, 80)})`;
    if (m[3] === 'deny') continue;
    const perms = m[4].split(',');
    if (!perms.some((x) => ACL_WRITES.includes(x))) continue;
    if (!m[2] && `${m[1]} allow ${[...perms].sort().join(',')}` === REQUESTS_ENTRY) continue;
    return `has an access-list entry letting ${m[1]} write it (${m[2] ? 'inherited ' : ''}allow ${m[4]}); only setup's own entry (${REQUESTS_ENTRY}) may`;
  }
  return null;
}

/**
 * The one writer of the worker runner's requests (stopSession and the four asks): the folder's owner, mode and access list
 * are checked before each write (L943 m4), and a folder that fails is a throw, with nothing written.
 */
export function runnerRequestWriter(c, io = {}) {
  const toRequests = requestWriter(c.workerRequestsDir, io.writeFile);
  return (name, text) => { const bad = requestsFolderProblem(c.workerRequestsDir, c.workerUid, { lstat: io.lstat, acl: io.requestsAcl }); if (bad) throw new Error(bad); toRequests(name, text); };
}

/**
 * The worker runner's four asks for this Dispatcher (PR C, L963): owner-asks.mjs ownerAsyncPorts, writing through
 * runnerRequestWriter and reading the same status file the sync ports read. `io` lets a test stand in for the files
 * (stat, open, realpath, lstat, requestsAcl, writeFile), the wait (sleep, pollMs, giveUpMs) and the nonce.
 */
export function runnerAsyncPorts({ config: c, now = Date.now }, io = {}) {
  return ownerAsyncPorts({ statusFile: c.workerStatusFile, uid: c.workerUid, outboxRoot: c.outboxRoot, copiesRoot: c.copiesRoot, clock: now,
    writeRequest: runnerRequestWriter(c, io), stat: io.stat, open: io.open, realpath: io.realpath,
    ...Object.fromEntries(['sleep', 'nonce', 'pollMs', 'giveUpMs'].filter((k) => io[k] !== undefined).map((k) => [k, io[k]])) });
}

/**
 * The worker runner's sync ports for this Dispatcher (L925): `c` its config, `rec` its Record. `io` lets a test stand in
 * for the files (stat, open, realpath, lstat, requestsAcl, writeFile, reviewStatus).
 */
export function runnerSyncPorts({ config: c, rec, now = Date.now }, io = {}) {
  const sync = ownerSyncPorts({ statusFile: c.workerStatusFile, uid: c.workerUid, outboxRoot: c.outboxRoot, product: c.product, clock: now,
    stat: io.stat, open: io.open, realpath: io.realpath, holds: recordHolds(rec), writeRequest: runnerRequestWriter(c, io) });
  const review = io.reviewStatus ?? (() => readReviewStatus({ file: c.reviewStatusFile, now: now(), uid: c.reviewUid }));
  return {
    // Both read before either is used: one that throws makes the whole list "not known" (L925 rule 1).
    sessions: () => { const own = sync.sessions(); const rv = reviewSessions(review(), { now: now() }); return [...own, ...rv]; },
    board: () => sync.board(),
    outboxSessions: () => sync.outboxSessions().filter((x) => x.product === c.product),
    probe: (session) => {
      if (RUNNER_KINDS.includes(session?.kind)) return sync.probe(session);
      throw new Error(Object.hasOwn(REVIEW_KIND_OF, session?.role) || Object.values(REVIEW_KIND_OF).includes(session?.kind)
        ? `session ${session?.id} is the review runner's, which reports no size or activity for its sessions`
        : `no runner here reports on a ${session?.kind ?? 'kindless'} session (${session?.id})`);
    },
    stopSession: (sessionId) => sync.stopSession(sessionId),
  };
}

/** @param {object} ctx see `wire()` in dispatcher-wiring.mjs */
export function workerPorts(ctx, io = {}) {
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
  // The worker runner's user is host.lock's (L896): workerUidProblem, which checkConfig made first (L943 m3).
  const workerUid = workerUidProblem(c);
  if (workerUid) throw new Error(`config: ${workerUid}`);
  // A typo would make every request go nowhere: the folder must be there at start (its owner, mode and access list are checked on each write, L943 m4).
  realFolder(c.workerRequestsDir, "the worker runner's requests folder (workerRequestsDir)");
  const cleanup = cleanupPorts(ctx);
  for (const k of NOT_WIRED_CLEANUP) Object.defineProperty(cleanup, k, { enumerable: true, get: refusing(`cleanup.${k}`) });
  return {
    cleanup,
    // A value the tick hands the pass (L887): the TOP outboxes folder, checked a real folder at start.
    outboxRoot: realFolder(c.outboxRoot, 'the outboxes folder (outboxRoot)'),
    hostLock: hostLockPort({ path: c.hostLockPath, run: ctx.limitedSync, ownerUid: c.hostLockUid, selfUid: ctx.selfUid }),
    reviewEnded: reviewEndedPort({ root: c.reviewRoot, uid: c.reviewUid }),
    product: c.product,
    ...runnerSyncPorts({ config: c, rec: ctx.rec, ...(ctx.now ? { now: ctx.now } : {}) }, io),
    ...runnerAsyncPorts({ config: c, ...(ctx.now ? { now: ctx.now } : {}) }, io),
  };
}

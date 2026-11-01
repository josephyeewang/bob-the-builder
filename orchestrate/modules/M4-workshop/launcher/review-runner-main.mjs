#!/usr/bin/env node
// The script the review runner's LaunchDaemon runs as `review` (L65): `node review-runner-main.mjs <config.json>`.
// One run is one pass (review-runner.mjs `runnerPass`); launchd starts it once a minute and when a request arrives.
//
// It runs from the installed copy, never from the repository: the repository can be written by the workers' Mac user,
// so code there could be changed to run as `review`. The wall is the LaunchDaemon itself (root's, in the system
// folder), which names the installed copy; this file can't guard its own loading. What the run adds is a tripwire:
// before a pass it checks that the installed folder, the config and the wiring are still root's and that no one else
// can write them (`installProblem`), so a copy installed wrong, or made writable later, starts nothing. The same goes
// for what a review session runs (L66 M2): the claude program, the node this runs on and the hooks folder the
// reviewer's settings point at are inside the installed copy and root's alone (`programsProblem`), or no review starts.
// Every folder above the installed copy, up to /, must be root's and written by no one else too (item 20(b)): a folder
// another user could write could have the copy renamed away and another put in its place.
//
// The config names every path; nothing here names a machine:
//   { "installRoot": "/abs", "root": "/abs", "outboxRoot": "/abs", "reviewHome": "/abs",
//     "uids": { "<role>": <uid>, ... },            every role of the design table (m-1); both review roles name review
//     "recordRoot": "/abs", "recordUid": <uid>,     the Record, read only (its docs/card/ and docs/verdict/)
//     "mirror": "/abs",                             the git mirror, read only (refs/heads/card/<card>)
//     "claudeBin": "/abs",                          the pinned claude program (checked on each pin bump, m-8), inside installRoot
//     "hooksDir": "/abs",                           the hooks folder a reviewer's settings point at, inside installRoot
//     "accountCopy": "/abs",                        root's copy of the account in use (review-account-copy.plist)
//     "ownerHome": "/abs", "ownerUid": <uid>,       the fallback: the owner's own account file, read only
//     "ownerTaps": "/abs",                          optional: Joe's "review again" taps (L70 point 3), a folder of the
//                                                   owner's that no one else writes, holding <session>.json files of
//                                                   the owner's; the Front Door, which runs as Joe, writes them
//     "wiring": "/abs/wiring.mjs",                  exports `start(x)` (review-runner.mjs `runnerPass`, `ctx.start`)
//     "snapshot": "/abs", "bobFolder": "/abs",      the session settings' fixed paths (L67 addendum 2, review-settings.mjs):
//     "deny": ["/abs", ...],                        the rules snapshot (inside root), the Bob folder, the read-deny list,
//     "reviewCopies": "/abs", "workerCopies": "/abs",   and the review copies' folder, apart from the workers' copies'
//                                                   folder (which the deny list covers whole). All five are checked at
//                                                   daemon start (R-0b-163), so a typo stops the daemon, not each review
//     "rules": { "production": { "env_files": [], "programs": [], "hosts": [] }, "secrets": { "paths": [] } } }
//                                                   the rules the review sessions' hooks read: each run writes them to
//                                                   `snapshot`, well inside the hooks' 5-minute limit (item 7)
// The wiring (review-wiring.mjs) exports `start` and nothing else (R-0b-163, L78 n4): a wiring with any other export is
// refused at daemon start. Each review copy is <reviewCopies>/<session>: the runner names it, the wiring fills it with
// `makeCopy`, and the runner removes it once that session's ended record is written (L77 m9).
// The wiring's start runs the launcher (launch.mjs, checks 1 to 13) for a reviewer or an auditor, with `--session-id`
// set to the runner's id, and returns { ok, pid }, where pid is claude's own process (L66: never the launcher's; the
// runner checks the pid's command is the pinned claude before it counts the start, and before it stops anything). It
// gets `claudeBin`, `node` and `hooksDir` (checked above) to run and to render the settings with, and `earlier`: the
// card's earlier failing verdicts for this role on other trees, [{ session_id, head, notes }], which the reviewer's
// prompt must include (L69 point 4), as quoted data from an earlier reviewer and never as instructions: the wiring
// renders them with `earlierBlock` (review-runner.mjs, L70 point 5; since L71 C3 the runner passes the rendered block, a
// string the wiring puts in the prompt as it is). `ok: false` from start means claude was never spawned (L71 point 2).
// The session's settings (L67): once it has made the review copy, the wiring calls `settingsFor(copy)`, which fills the
// role's root-owned template (templates/, copied in by the updater) with this session's outbox and copy and the config's
// fixed paths, checks it, and writes it to <root>/settings/<session>.json → { ok, file } or { ok: false, reason }. The
// wiring launches with `--settings <file>` and no other settings; on a refusal it starts nothing and returns ok: false.
// Joe's taps: only a plain handler for Joe's button, running as Joe, writes `ownerTaps`; the Front Door's own tools get
// a deny rule on that folder, and the handler removes a tap once the status lists it in `taps_read` (L71 points 5, C1).
// Exit 0 when the pass ran clean, 1 when it refused or could not run.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerPass, CARD_ID, isClaudeCommand } from './review-runner.mjs';
import { installProblem, readInstallStamp, aclProblem, currentCopy, copyPath } from './install-check.mjs';
import { sessionVerdict, verdictFromFile } from '../../M9-record/outbox.mjs';
import { SESSION_ID } from '../../../shared/record.mjs';
import { readAccountFile, ACCOUNT_FILE } from './accounts.mjs';
import { REVIEW_USER } from './review-user.mjs';
import { git, gitOk } from '../git/safe-git.mjs';
import { sessionSettings, templateFile } from './review-settings.mjs';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { removeProtected, restoreMainCopies } from './worker-copy.mjs';
import { writeSnapshot } from '../hooks/snapshot.mjs';
import { finalize, headFileReader } from '../../M5-review-audit/findings.mjs';

const ABS = ['installRoot', 'root', 'outboxRoot', 'reviewHome', 'recordRoot', 'mirror', 'claudeBin', 'hooksDir', 'ownerHome', 'wiring',
  'snapshot', 'bobFolder', 'reviewCopies', 'workerCopies'];
// The one export a wiring may have (R-0b-163, L78 n4).
export const WIRING_EXPORTS = Object.freeze(['start']);
const absList = (v) => Array.isArray(v) && v.every((p) => typeof p === 'string' && isAbsolute(p));
const MAX_CARD_BYTES = 1024 * 1024;
const CHILD_MS = 10_000;

/**
 * The config, checked. `lstat` and `top` are ports for a test (as for `installProblem`): the runner's folder and review's
 * outbox root, and every folder above each up to `top` (/), must be root's or the review user's, written by no one
 * else, and not links (L71 point 1, the item 20(b) rule). A folder the workers' Mac user could write could have the
 * role folder renamed away, so a fail would read as silence.
 */
export function readConfig(file, { lstat = lstatSync, top = '/', acl = aclProblem } = {}) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ABS) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.accountCopy !== undefined && (typeof c.accountCopy !== 'string' || !isAbsolute(c.accountCopy))) throw new Error('config: accountCopy must be an absolute path');
  if (c.ownerTaps !== undefined && (typeof c.ownerTaps !== 'string' || !isAbsolute(c.ownerTaps))) throw new Error('config: ownerTaps must be an absolute path');
  if (!absList(c.deny) || c.deny.length === 0) throw new Error('config: deny must list absolute paths');
  const prod = c.rules?.production;
  if (!prod || !['env_files', 'programs', 'hosts'].every((k) => Array.isArray(prod[k]) && prod[k].every((v) => typeof v === 'string'))) throw new Error('config: rules.production must list env_files, programs and hosts');
  if (!absList(prod.env_files) || (c.rules.secrets !== undefined && !absList(c.rules.secrets?.paths))) throw new Error('config: the rules\' env_files and secrets.paths must be absolute paths');
  for (const k of ['recordUid', 'ownerUid']) if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`config: ${k} must be a uid`);
  if (!c.uids || typeof c.uids !== 'object') throw new Error('config: uids must map each role to a uid');
  // The runner's folder and review's outbox are two walls (L68 (4)): review sessions write the outbox, and only the
  // runner writes its launch and ended records. One inside the other (or the same folder) would let a session's
  // folder stand where a runner's record is read. Compared on real paths, so a link or a change of case can't hide it
  // (L73 point 7(a)).
  const r = realPath(c.root).toLowerCase();
  const o = realPath(c.outboxRoot).toLowerCase();
  if (inside(r, o) || inside(o, r)) throw new Error(`config: root (${c.root}) and outboxRoot (${c.outboxRoot}) must be two separate folders, neither inside the other`);
  // The rules snapshot is the runner's own file, behind its wall (item 7); the review copies sit apart from the workers'.
  const snap = realPath(c.snapshot).toLowerCase();
  if (snap === r || !inside(snap, r)) throw new Error(`config: snapshot (${c.snapshot}) must be a file inside root (${c.root})`);
  const rc = realPath(c.reviewCopies).toLowerCase();
  const wc = realPath(c.workerCopies).toLowerCase();
  if (inside(rc, wc) || inside(wc, rc)) throw new Error('config: reviewCopies and workerCopies must be two separate folders, neither inside the other');
  const owners = [0, c.uids.reviewer].filter((u) => Number.isInteger(u) && u >= 0);
  for (const k of ['root', 'outboxRoot']) {
    const bad = wallProblem(c[k], owners, { lstat, top, acl });
    if (bad) throw new Error(`config: ${k}: ${bad}`);
  }
  return c;
}

// A folder and every folder above it, up to `top`: plain folders (not links) of one of `owners`, written by no one else,
// with no access list (L73 point 7(c)).
function wallProblem(path, owners, { lstat, top, acl }) {
  const p0 = resolve(path);
  const rel = relative(top, p0);
  if (!isAbsolute(top) || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return `${p0} is not under ${top}`;
  const seen = [];
  for (let p = p0; ; p = dirname(p)) {
    const what = p === p0 ? p : `${p}, above it,`;
    let st; try { st = lstat(p); } catch { return `${what} is missing`; }
    if (st.isSymbolicLink()) return `${what} is a link (name the folder by its real path)`;
    if (!st.isDirectory()) return `${what} is not a folder`;
    if (!owners.includes(st.uid)) return `${what} is not owned by root or the review user`;
    if (st.mode & 0o022) return `${what} can be written by others`;
    seen.push(p);
    if (p === top || p === dirname(p)) return acl(seen);
  }
}

/**
 * A path's real path: its nearest folder that exists, with links resolved and in the case the disk holds it
 * (realpathSync.native: the plain one keeps the case it was given, L73 point 7(a)), and the rest of the path as given.
 */
function realPath(p) {
  let head = resolve(p);
  const rest = [];
  for (;;) {
    try { return join(realpathSync.native(head), ...rest); } catch { /* not there yet */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.unshift(basename(head));
    head = up;
  }
}
/** Is `p` the folder `dir` or inside it? */
const inside = (p, dir) => { const rel = relative(dir, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

// installProblem, the stamp reader and the access-list check live in install-check.mjs, which root's updater runs
// too; they are passed on here for the runner's own callers and tests.
export { installProblem, readInstallStamp };

/**
 * What a review session runs (L66 M2), named one by one: the runner itself, its config, the wiring, the claude
 * program, the node this runs on, the hooks folder and each review role's settings template (L67). Each must be inside
 * the installed copy and root's alone. installRoot must be the copy's link (L75 c-7): a plain folder can't be updated
 * whole, so the runner refuses one, and the copy's commit stamp must be the commit its folder is named for.
 */
export function programsProblem(c, { self, config, node = realpathSync.native(process.execPath), ...opts } = {}) {
  const bad = installProblem(c.installRoot, [self, config, c.wiring, c.claudeBin, node, c.hooksDir, ...REVIEW_ROLES.map((r) => templateFile(c.installRoot, r))], opts);
  if (bad) return bad;
  const owner = opts.owner ?? 0;
  const cur = currentCopy(c.installRoot, { owner, ...(opts.lstat ? { lstat: opts.lstat } : {}), ...(opts.readlink ? { readlink: opts.readlink } : {}) });
  if (!cur.real) return cur.problem;
  if (!cur.link) return `${c.installRoot} is a plain folder, not the installed copy's link (the install step makes the link)`;
  const stamp = readInstallStamp(c.installRoot, { owner });
  if (stamp !== cur.commit) return `the copy's commit stamp (${stamp ?? 'none'}) is not the commit its folder is named for (${cur.commit})`;
  return null;
}

// A folder of the Record: a plain folder of the Record's owner that no one else writes. Null, or the problem.
function recordFolderProblem(d, recordUid) {
  let st; try { st = lstatSync(d); } catch { return `${d} is missing`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${d} is not a plain folder`;
  if (st.uid !== recordUid || st.mode & 0o022) return `${d} is not the Record owner's alone`;
  return null;
}

// One document of the Record, read only: a plain file of the Record's owner that no one else writes, never a link.
function readRecordFile(p, recordUid, entity, id, missing) {
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, reason: e?.code === 'ENOENT' ? missing : `it can't be read (${e?.code ?? e})` }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== recordUid || st.mode & 0o022 || st.size > MAX_CARD_BYTES) return { ok: false, reason: 'its file is not the Record\'s own plain file' };
    const d = JSON.parse(readFileSync(fd, 'utf8'));
    if (d?.entity !== entity || d?.id !== id || !d.doc || typeof d.doc !== 'object') return { ok: false, reason: `its file is not a ${entity} document` };
    return { ok: true, doc: d.doc, rev: Number.isInteger(d.rev) ? d.rev : null };
  } catch { return { ok: false, reason: 'its file is not JSON' }; } finally { closeSync(fd); }
}

/** A card from the Record, read only: docs/card/<id>.json, with its revision (`rev`). */
export function readCardFile({ recordRoot, recordUid, card }) {
  if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return { ok: false, reason: 'not a card id' };
  for (const d of [recordRoot, join(recordRoot, 'docs'), join(recordRoot, 'docs', 'card')]) {
    const bad = recordFolderProblem(d, recordUid);
    if (bad) return { ok: false, reason: bad };
  }
  return readRecordFile(join(recordRoot, 'docs', 'card', `${card}.json`), recordUid, 'card', card, 'no such card');
}

/**
 * Whether the Record took a review session's verdict (item 20(a)): a verdict row of that session (docs/verdict/), for
 * that role, card and head, whose file in review's outbox still reads true (M9 `verdictFromFile`). → { ok: true } |
 * { ok: false, reason }. A Record that can't be read throws. The runner only tells Joe what this says, and never starts
 * a review again on it (L68): a worker can write the Record. The Merge Gate reads the verdict files itself.
 */
export function recordVerdictTaken({ recordRoot, recordUid, outboxRoot, uids, role, sessionId, card, head }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { ok: false, reason: 'the start names no session' };
  for (const d of [recordRoot, join(recordRoot, 'docs')]) {
    const bad = recordFolderProblem(d, recordUid);
    if (bad) throw new Error(bad);
  }
  const dir = join(recordRoot, 'docs', 'verdict');
  try { lstatSync(dir); } catch (e) { if (e?.code === 'ENOENT') return { ok: false, reason: 'the Record holds no verdicts yet' }; throw e; }
  const bad = recordFolderProblem(dir, recordUid);
  if (bad) throw new Error(bad);
  const names = readdirSync(dir).filter((n) => n.startsWith(`verdict-${sessionId}-`) && n.endsWith('.json'));
  let why = `the Record holds no verdict of session ${sessionId}`;
  for (const n of names) {
    const r = readRecordFile(join(dir, n), recordUid, 'verdict', n.slice(0, -'.json'.length), 'it is gone');
    if (!r.ok) { why = `its verdict row ${n}: ${r.reason}`; continue; }
    const d = r.doc;
    if (d.session_id !== sessionId) continue;
    if (d.role !== role || d.card !== card || d.head !== head) { why = `its verdict row names ${d.role} on ${d.card} at ${String(d.head).slice(0, 7)}`; continue; }
    const f = verdictFromFile({ outboxRoot, uids, row: { doc: d } });
    if (f.ok) return { ok: true };
    why = f.reason;
  }
  return { ok: false, reason: why };
}

/** `dseditgroup` answers "yes ..." or "no ..."; anything else is not an answer (and the runner counts it as an admin). */
export function adminAnswer(r) {
  const out = String(r?.stdout ?? '').trim();
  if (/^yes\b/.test(out)) return true;
  if (/^no\b/.test(out)) return false;
  throw new Error(`the admin check gave no answer (${r?.error?.code ?? `exit ${r?.status}`})`);
}

const TAP_NAME = /^([A-Za-z0-9-]{1,128})\.json$/;
const MAX_TAP_BYTES = 4096;
/**
 * Joe's "review again" taps (L70 point 3): files in a folder of the owner's that no one else writes (and whose own
 * folder no one else writes either, so it can't be swapped), each a plain file of the owner's that no one else writes,
 * named <session>.json and holding { "session_id": "<session>" }. Nothing the workers' Mac user writes can be one: not
 * the Dispatcher, the Record or requests/. A file that fails a check is ignored. No folder configured → none. A folder
 * that fails its check is a throw (the pass says why). Each tap has a key (name, time and bytes), so it is read once.
 * `lstat` and `fstat` are ports for a test. → [{ session_id, key }]
 */
export function readJoeTaps({ dir, ownerUid, lstat = lstatSync, fstat = fstatSync } = {}) {
  if (dir === undefined) return [];
  if (typeof dir !== 'string' || !isAbsolute(dir) || !Number.isInteger(ownerUid) || ownerUid < 0) throw new Error('the taps folder or the owner\'s uid is not set');
  for (const [p, what] of [[dir, 'the taps folder'], [dirname(dir), 'the folder above the taps folder']]) {
    let st; try { st = lstat(p); } catch (e) { throw new Error(`${what} is missing (${e?.code ?? e})`); }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${what} is not a plain folder`);
    if (st.uid !== ownerUid && !(p !== dir && st.uid === 0)) throw new Error(`${what} is not owned by the owner`);
    if (st.mode & 0o022) throw new Error(`${what} can be written by others than the owner`);
  }
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const m = TAP_NAME.exec(name);
    if (!m) continue;
    let fd;
    try { fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { continue; }
    try {
      const st = fstat(fd);
      if (!st.isFile() || st.uid !== ownerUid || st.mode & 0o022 || st.size > MAX_TAP_BYTES) continue;
      const buf = readFileSync(fd);
      let doc; try { doc = JSON.parse(buf.toString('utf8')); } catch { continue; }
      if (!doc || typeof doc !== 'object' || doc.session_id !== m[1] || !SESSION_ID.test(m[1])) continue;
      out.push({ session_id: m[1], key: `${name}:${st.mtimeMs}:${createHash('sha256').update(buf).digest('hex')}` });
    } catch { continue; } finally { closeSync(fd); }
  }
  return out;
}

/** `ps -o pid=,command=` lines → the processes of `bin`, with their --session-id; this process left out. */
export function sessionsFrom(text, bin, self = process.pid) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === self || !isClaudeCommand(cmd, bin)) continue;
    const sid = /(?:^|\s)--session-id[ =]([A-Za-z0-9-]{1,128})(?:\s|$)/.exec(cmd)?.[1];
    out.push(sid ? { pid, sessionId: sid } : { pid });
  }
  return out;
}

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', timeout: CHILD_MS, stdio: ['ignore', 'pipe', 'pipe'] });

/** A session's review copy: the one path the wiring fills and the runner removes (L77 m9, L78 c4). */
export function reviewCopyPath(c, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error('not a session id');
  return join(c.reviewCopies, sessionId);
}

/**
 * The review copy (launch checks 1 and 2 for a review role): a new folder holding the card's branch at `head` from the
 * mirror, with main beside it for the diff, what the branch brought under a protected name removed and main's own put
 * back, as for a worker's copy (worker-copy.mjs). A folder already there is refused, never reused. → { ok } | { ok: false, reason }
 */
export async function prepareReviewCopy({ mirror, card, head, dest }) {
  if (typeof card !== 'string' || !CARD_ID.test(card)) return { ok: false, reason: 'not a card id' };
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'the head is not 40 hex' };
  try { lstatSync(dest); return { ok: false, reason: `${dest} is there already` }; } catch { /* good */ }
  mkdirSync(dest, { mode: 0o700 });
  const branch = `card/${card.toLowerCase()}`;
  const opts = (purpose) => ({ gitDir: join(dest, '.git'), workTree: dest, cwd: dest, purpose, timeoutMs: 120_000 });
  try {
    // Born on a branch name nothing fetches into: git refuses to fetch into the branch a folder is on, and a plain
    // init sits on main.
    await gitOk(['init', '-q', '--initial-branch=review-copy-unborn', dest], opts('review-copy-init'));
    await gitOk(['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', mirror, `${head}:refs/heads/${branch}`, 'refs/heads/main:refs/heads/main'], opts('review-copy-fetch'));
    await gitOk(['checkout', '-q', '-f', branch], opts('review-copy-checkout'));
    if ((await gitOk(['rev-parse', 'HEAD'], opts('review-copy-head'))).trim() !== head) throw new Error('the checked-out commit is not the head');
    removeProtected(dest);
    await restoreMainCopies({ mirror, dest });
    return { ok: true };
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/** The real ports (the wiring gives `start`). */
export function realPorts(c, wiring, { node = realpathSync.native(process.execPath), owner = 0 } = {}) {
  const uid = c.uids.reviewer;
  return {
    root: c.root, outboxRoot: c.outboxRoot, uids: c.uids, reviewHome: c.reviewHome, claudeBin: c.claudeBin,
    now: () => Date.now(), ownUid: () => process.getuid(),
    isAdmin: () => adminAnswer(run('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', REVIEW_USER, 'admin'])),
    readCard: (card) => readCardFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, card }),
    verdictTaken: ({ role, sessionId, card, head }) => recordVerdictTaken({ recordRoot: c.recordRoot, recordUid: c.recordUid, outboxRoot: c.outboxRoot, uids: c.uids, role, sessionId, card, head }),
    currentHead: async (card) => {
      const r = await git(['rev-parse', '--verify', '-q', `refs/heads/card/${card.toLowerCase()}^{commit}`], { gitDir: c.mirror, purpose: 'review-runner-head', timeoutMs: CHILD_MS });
      if (r.code !== 0) throw new Error(`the card's branch is not in the mirror (${r.code})`);
      return r.stdout.toString('utf8').trim();
    },
    // The head's tree (L69): one start per card, tree and role. The head is the one currentHead just read.
    treeOf: async (card, head) => {
      if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) throw new Error('the head is not 40 hex');
      const r = await git(['rev-parse', '--verify', '-q', `${head}^{tree}`], { gitDir: c.mirror, purpose: 'review-runner-tree', timeoutMs: CHILD_MS });
      if (r.code !== 0) throw new Error(`the head's tree is not in the mirror (${r.code})`);
      return r.stdout.toString('utf8').trim();
    },
    // Joe's "review again" taps (L70 point 3): only the owner's own files; none until `ownerTaps` is set.
    setAsideByJoe: () => readJoeTaps({ dir: c.ownerTaps, ownerUid: c.ownerUid }),
    sessions: () => {
      const r = run('/bin/ps', ['-U', String(uid), '-o', 'pid=', '-o', 'command=']);
      if (r.status !== 0 && r.status !== 1) throw new Error(`ps failed (${r.error?.code ?? `exit ${r.status}`})`);
      return sessionsFrom(r.stdout, c.claudeBin);
    },
    stop: ({ pid }) => { process.kill(pid, 'SIGTERM'); },
    processName: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const r = run('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
      return r.status === 0 ? String(r.stdout).trim() : null;
    },
    installedCommit: () => readInstallStamp(c.installRoot),
    // The hooks by the real path of the folder the copy's link names now (L75 M-1), the same path the settings name,
    // so the launcher's hook check (check 7) and the settings agree. A flip between the two makes them differ, and the
    // start is refused; the next pass starts it.
    start: (x) => {
      const hooksDir = copyPath(c.installRoot, currentCopy(c.installRoot, { owner }), c.hooksDir);
      const copy = reviewCopyPath(c, x.sessionId);
      return wiring.start({ ...x, claudeBin: c.claudeBin, node, hooksDir, copy, spawn,
        makeCopy: () => prepareReviewCopy({ mirror: c.mirror, card: x.card, head: x.head, dest: copy }),
        settingsFor: (dir) => sessionSettings({ ...c, hooksDir }, { role: x.role, sessionId: x.sessionId, copy: dir, node }, { owner }) });
    },
    // Only once the session's ended record is written (review-runner.mjs `markEnded`, L77 m9). rmSync removes a link,
    // never what it points at.
    removeCopy: (sessionId) => rmSync(reviewCopyPath(c, sessionId), { recursive: true, force: true }),
    accountInUse: () => {
      const copy = c.accountCopy ? readAccountFile({ file: c.accountCopy, uid: 0 }) : { ok: false };
      if (copy.ok) return copy.account;
      // Failing the copy, the owner's own file, read only; missing means account a, as for the owner.
      const own = join(c.ownerHome, ACCOUNT_FILE);
      try { lstatSync(own); } catch (e) { if (e?.code === 'ENOENT') return 'a'; return null; }
      const r = readAccountFile({ file: own, uid: c.ownerUid });
      return r.ok ? r.account : null;
    },
    finalize: ({ role, sessionId, card, head }) => finalize({ outboxRoot: c.outboxRoot, uids: c.uids, role, sessionId, card, head, owner: c.uids[role], readFile: headFileReader({ gitDir: c.mirror, head }) }),
    handedIn: ({ role, sessionId, card, head }) => sessionVerdict({ outboxRoot: c.outboxRoot, uids: c.uids, role, sessionId, card, head }),
  };
}

/**
 * The last two steps before a pass (L78, L77 (2)): the loaded wiring must export exactly `start` (a second export is a
 * second door the runner never checks), and the rules snapshot the review sessions' hooks read is written from the
 * runner's own config; the hooks refuse every call once it is 5 minutes old, so each pass writes it afresh.
 * `write` is a port for a test. Returns what is wrong, or null.
 */
export function readyProblem(c, wiring, { write = writeSnapshot } = {}) {
  const names = Object.keys(wiring ?? {}).sort();
  if (names.length !== WIRING_EXPORTS.length || names.some((n, i) => n !== WIRING_EXPORTS[i])) return `the wiring must export only start, not ${names.join(', ') || 'nothing'}`;
  if (typeof wiring.start !== 'function') return 'the wiring has no start';
  try { write(c.snapshot, c.rules); } catch (e) { return `the rules snapshot could not be written (${e?.code ?? e?.message})`; }
  return null;
}

export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (!argv[0]) { log('usage: review-runner-main.mjs <config.json>'); return 1; }
  let c;
  try { c = readConfig(argv[0]); } catch (e) { log(`review runner: ${e.message}`); return 1; }
  const self = realpathSync.native(fileURLToPath(import.meta.url));
  const bad = programsProblem(c, { self, config: realpathSync.native(argv[0]) });
  if (bad) { log(`review runner: refused, the installed copy is not root's alone: ${bad}`); return 1; }
  let wiring;
  try { wiring = await import(pathToFileURL(c.wiring).href); } catch (e) { log(`review runner: the wiring could not be loaded (${e.message})`); return 1; }
  const notReady = readyProblem(c, wiring);
  if (notReady) { log(`review runner: ${notReady}`); return 1; }
  const r = await runnerPass(realPorts(c, wiring));
  for (const s of r.started) log(`started ${s.role} ${s.session_id} for ${s.card} at ${s.head.slice(0, 7)}`);
  for (const x of r.refused) log(`refused ${x.request}: ${x.reason}`);
  if (!r.ok) log(`review runner: ${r.error}`);
  return r.ok ? 0 : 1;
}

const me = (() => { try { return realpathSync.native(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync.native(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) process.exitCode = await main(process.argv.slice(2));

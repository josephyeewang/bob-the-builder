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
//     "wiring": "/abs/wiring.mjs" }                 exports `start(x)` (review-runner.mjs `runnerPass`, `ctx.start`)
// The wiring's start runs the launcher (launch.mjs, checks 1 to 13) for a reviewer or an auditor, with `--session-id`
// set to the runner's id, and returns { ok, pid }, where pid is claude's own process (L66: never the launcher's; the
// runner checks the pid's command is the pinned claude before it counts the start, and before it stops anything). It
// gets `claudeBin`, `node` and `hooksDir` (checked above) to run and to render the settings with, and `earlier`: the
// card's earlier failing verdicts for this role on other trees, [{ session_id, head, notes }], which the reviewer's
// prompt must include (L69 point 4). Exit 0 when the pass ran clean, 1 when it refused or could not run.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerPass, CARD_ID, isClaudeCommand } from './review-runner.mjs';
import { STAMP } from './review-daemons.mjs';
import { sessionVerdict, verdictFromFile } from '../../M9-record/outbox.mjs';
import { SESSION_ID } from '../../../shared/record.mjs';
import { readAccountFile, ACCOUNT_FILE } from './accounts.mjs';
import { REVIEW_USER } from './review-user.mjs';
import { git } from '../git/safe-git.mjs';

const ABS = ['installRoot', 'root', 'outboxRoot', 'reviewHome', 'recordRoot', 'mirror', 'claudeBin', 'hooksDir', 'ownerHome', 'wiring'];
const MAX_CARD_BYTES = 1024 * 1024;
const CHILD_MS = 10_000;

export function readConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ABS) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.accountCopy !== undefined && (typeof c.accountCopy !== 'string' || !isAbsolute(c.accountCopy))) throw new Error('config: accountCopy must be an absolute path');
  for (const k of ['recordUid', 'ownerUid']) if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`config: ${k} must be a uid`);
  if (!c.uids || typeof c.uids !== 'object') throw new Error('config: uids must map each role to a uid');
  // The runner's folder and review's outbox are two walls (L68 (4)): review sessions write the outbox, and only the
  // runner writes its launch and ended records. One inside the other (or the same folder) would let a session's
  // folder stand where a runner's record is read. Compared on real paths, so a link can't hide it.
  const r = realPath(c.root);
  const o = realPath(c.outboxRoot);
  if (inside(r, o) || inside(o, r)) throw new Error(`config: root (${c.root}) and outboxRoot (${c.outboxRoot}) must be two separate folders, neither inside the other`);
  return c;
}

/** A path's real path: its nearest folder that exists, with links resolved, and the rest of the path as given. */
function realPath(p) {
  let head = resolve(p);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch { /* not there yet */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.unshift(basename(head));
    head = up;
  }
}
/** Is `p` the folder `dir` or inside it? */
const inside = (p, dir) => { const rel = relative(dir, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/**
 * The installed copy: every folder and file under `installRoot` owned by `owner` (root) and written by no one else, no
 * links; each of `files` inside it; and every folder above it, up to `top` (/), root's, written by no one else and not a
 * link (item 20(b)). `lstat` is a port so a test can stand in for root, and `top` lets a test stop in its own throwaway
 * folder. Null, or the first problem.
 */
export function installProblem(installRoot, files, { owner = 0, lstat = lstatSync, list = readdirSync, top = '/' } = {}) {
  for (const f of files) {
    const rel = typeof f === 'string' && isAbsolute(f) ? relative(installRoot, f) : '..';
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return `${f} is not inside the installed copy ${installRoot}`;
    // Each named file itself too, so a missing one is named rather than passed over by the walk below.
    let st; try { st = lstat(f); } catch { return `${f} is missing`; }
    if (st.isSymbolicLink()) return `${f} is a link`;
    if (st.uid !== owner) return `${f} is not owned by root`;
    if (st.mode & 0o022) return `${f} can be written by others than root`;
  }
  const above = (p) => { const r = relative(top, p); return r === '..' || r.startsWith('../') || isAbsolute(r); };
  if (!isAbsolute(top) || above(installRoot)) return `${installRoot} is not under ${top}`;
  for (let p = dirname(installRoot); !above(p); p = dirname(p)) {
    let st; try { st = lstat(p); } catch { return `${p}, above the installed copy, is missing`; }
    if (st.isSymbolicLink()) return `${p}, above the installed copy, is a link (name the copy by its real path)`;
    if (!st.isDirectory()) return `${p}, above the installed copy, is not a folder`;
    if (st.uid !== owner) return `${p}, above the installed copy, is not owned by root`;
    if (st.mode & 0o022) return `${p}, above the installed copy, can be written by others than root`;
    if (p === top || p === dirname(p)) break;
  }
  const walk = (p) => {
    let st; try { st = lstat(p); } catch { return `${p} is missing`; }
    if (st.isSymbolicLink()) return `${p} is a link`;
    if (st.uid !== owner) return `${p} is not owned by root`;
    if (st.mode & 0o022) return `${p} can be written by others than root`;
    if (!st.isDirectory()) return null;
    for (const n of list(p)) { const bad = walk(join(p, n)); if (bad) return bad; }
    return null;
  };
  return walk(installRoot);
}

/**
 * What a review session runs (L66 M2), named one by one: the runner itself, its config, the wiring, the claude
 * program, the node this runs on and the hooks folder. Each must be inside the installed copy and root's alone.
 */
export function programsProblem(c, { self, config, node = realpathSync(process.execPath), ...opts } = {}) {
  return installProblem(c.installRoot, [self, config, c.wiring, c.claudeBin, node, c.hooksDir], opts);
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

/**
 * The installed copy's commit stamp (review-daemons.mjs `STAMP`), read as root's plain file: 40 hex, or null when it is
 * missing or not root's alone (the status then shows none, and the Dispatcher tells Joe).
 */
export function readInstallStamp(installRoot, { owner = 0 } = {}) {
  let fd;
  try { fd = openSync(join(installRoot, STAMP), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== owner || st.mode & 0o022 || st.size > 64) return null;
    const t = readFileSync(fd, 'utf8').trim();
    return /^[0-9a-f]{40}$/.test(t) ? t : null;
  } catch { return null; } finally { closeSync(fd); }
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

/** The real ports (the wiring gives `start`). */
export function realPorts(c, wiring, { node = realpathSync(process.execPath) } = {}) {
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
    // Joe's "review again" taps (L69): a port now, wired to the phone link at the cutover. None until then.
    setAsideByJoe: () => [],
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
    start: (x) => wiring.start({ ...x, claudeBin: c.claudeBin, node, hooksDir: c.hooksDir }),
    accountInUse: () => {
      const copy = c.accountCopy ? readAccountFile({ file: c.accountCopy, uid: 0 }) : { ok: false };
      if (copy.ok) return copy.account;
      // Failing the copy, the owner's own file, read only; missing means account a, as for the owner.
      const own = join(c.ownerHome, ACCOUNT_FILE);
      try { lstatSync(own); } catch (e) { if (e?.code === 'ENOENT') return 'a'; return null; }
      const r = readAccountFile({ file: own, uid: c.ownerUid });
      return r.ok ? r.account : null;
    },
    handedIn: ({ role, sessionId, card, head }) => sessionVerdict({ outboxRoot: c.outboxRoot, uids: c.uids, role, sessionId, card, head }),
  };
}

export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (!argv[0]) { log('usage: review-runner-main.mjs <config.json>'); return 1; }
  let c;
  try { c = readConfig(argv[0]); } catch (e) { log(`review runner: ${e.message}`); return 1; }
  const self = realpathSync(fileURLToPath(import.meta.url));
  const bad = programsProblem(c, { self, config: realpathSync(argv[0]) });
  if (bad) { log(`review runner: refused, the installed copy is not root's alone: ${bad}`); return 1; }
  let wiring;
  try { wiring = await import(pathToFileURL(c.wiring).href); } catch (e) { log(`review runner: the wiring could not be loaded (${e.message})`); return 1; }
  if (typeof wiring.start !== 'function') { log('review runner: the wiring has no start'); return 1; }
  const r = await runnerPass(realPorts(c, wiring));
  for (const s of r.started) log(`started ${s.role} ${s.session_id} for ${s.card} at ${s.head.slice(0, 7)}`);
  for (const x of r.refused) log(`refused ${x.request}: ${x.reason}`);
  if (!r.ok) log(`review runner: ${r.error}`);
  return r.ok ? 0 : 1;
}

const me = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return null; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (me && me === invoked) process.exitCode = await main(process.argv.slice(2));

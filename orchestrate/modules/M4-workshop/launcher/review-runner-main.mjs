#!/usr/bin/env node
// The script the review runner's LaunchDaemon runs as `review` (L65): `node review-runner-main.mjs <config.json>`.
// One run is one pass (review-runner.mjs `runnerPass`); launchd starts it once a minute and when a request arrives.
//
// It runs from the installed copy, never from the repository: the repository can be written by the workers' Mac user,
// so code there could be changed to run as `review`. The wall is the LaunchDaemon itself (root's, in the system
// folder), which names the installed copy; this file can't guard its own loading. What the run adds is a tripwire:
// before a pass it checks that the installed folder, the config and the wiring are still root's and that no one else
// can write them (`installProblem`), so a copy installed wrong, or made writable later, starts nothing.
//
// The config names every path; nothing here names a machine:
//   { "installRoot": "/abs", "root": "/abs", "outboxRoot": "/abs", "reviewHome": "/abs",
//     "uids": { "<role>": <uid>, ... },            every role of the design table (m-1); both review roles name review
//     "recordRoot": "/abs", "recordUid": <uid>,     the Record, read only (its docs/card/<id>.json)
//     "mirror": "/abs",                             the git mirror, read only (refs/heads/card/<card>)
//     "claudeBin": "/abs",                          the pinned claude program (checked on each pin bump, m-8)
//     "accountCopy": "/abs",                        root's copy of the account in use (review-account-copy.plist)
//     "ownerHome": "/abs", "ownerUid": <uid>,       the fallback: the owner's own account file, read only
//     "wiring": "/abs/wiring.mjs" }                 exports `start(x)` (review-runner.mjs `runnerPass`, `ctx.start`)
// The wiring's start runs the launcher (launch.mjs, checks 1 to 13) for a reviewer or an auditor, with `--session-id`
// set to the runner's id, and returns { ok, pid }. Exit 0 when the pass ran clean, 1 when it refused or could not run.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runnerPass, CARD_ID } from './review-runner.mjs';
import { readAccountFile, ACCOUNT_FILE } from './accounts.mjs';
import { REVIEW_USER } from './review-user.mjs';
import { git } from '../git/safe-git.mjs';

const ABS = ['installRoot', 'root', 'outboxRoot', 'reviewHome', 'recordRoot', 'mirror', 'claudeBin', 'ownerHome', 'wiring'];
const MAX_CARD_BYTES = 1024 * 1024;
const CHILD_MS = 10_000;

export function readConfig(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ABS) if (typeof c?.[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  if (c.accountCopy !== undefined && (typeof c.accountCopy !== 'string' || !isAbsolute(c.accountCopy))) throw new Error('config: accountCopy must be an absolute path');
  for (const k of ['recordUid', 'ownerUid']) if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`config: ${k} must be a uid`);
  if (!c.uids || typeof c.uids !== 'object') throw new Error('config: uids must map each role to a uid');
  return c;
}

/**
 * The installed copy: every folder and file under `installRoot` owned by `owner` (root) and written by no one else, no
 * links; and each of `files` inside it. `lstat` is a port so a test can stand in for root. Null, or the first problem.
 */
export function installProblem(installRoot, files, { owner = 0, lstat = lstatSync, list = readdirSync } = {}) {
  for (const f of files) {
    const rel = relative(installRoot, f);
    if (rel.startsWith('..') || isAbsolute(rel)) return `${f} is not inside the installed copy ${installRoot}`;
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

/** A card from the Record, read only: docs/card/<id>.json, a plain file of the Record's owner that no one else writes. */
export function readCardFile({ recordRoot, recordUid, card }) {
  if (typeof card !== 'string' || !CARD_ID.test(card) || card.startsWith('.')) return { ok: false, reason: 'not a card id' };
  for (const d of [recordRoot, join(recordRoot, 'docs'), join(recordRoot, 'docs', 'card')]) {
    let st; try { st = lstatSync(d); } catch { return { ok: false, reason: `${d} is missing` }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${d} is not a plain folder` };
    if (st.uid !== recordUid || st.mode & 0o022) return { ok: false, reason: `${d} is not the Record owner's alone` };
  }
  const p = join(recordRoot, 'docs', 'card', `${card}.json`);
  let fd;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, reason: e?.code === 'ENOENT' ? 'no such card' : `it can't be read (${e?.code ?? e})` }; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== recordUid || st.mode & 0o022 || st.size > MAX_CARD_BYTES) return { ok: false, reason: 'its file is not the Record\'s own plain file' };
    const d = JSON.parse(readFileSync(fd, 'utf8'));
    if (d?.entity !== 'card' || d?.id !== card || !d.doc || typeof d.doc !== 'object') return { ok: false, reason: 'its file is not a card document' };
    return { ok: true, doc: d.doc };
  } catch { return { ok: false, reason: 'its file is not JSON' }; } finally { closeSync(fd); }
}

/** `dseditgroup` answers "yes ..." or "no ..."; anything else is not an answer (and the runner counts it as an admin). */
export function adminAnswer(r) {
  const out = String(r?.stdout ?? '').trim();
  if (/^yes\b/.test(out)) return true;
  if (/^no\b/.test(out)) return false;
  throw new Error(`the admin check gave no answer (${r?.error?.code ?? `exit ${r?.status}`})`);
}

/** `ps -o pid=,command=` lines → the processes of `bin`, with their --session-id; this process left out. */
export function sessionsFrom(text, bin, self = process.pid) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === self || !(cmd === bin || cmd.startsWith(`${bin} `))) continue;
    const sid = /(?:^|\s)--session-id[ =]([A-Za-z0-9-]{1,128})(?:\s|$)/.exec(cmd)?.[1];
    out.push(sid ? { pid, sessionId: sid } : { pid });
  }
  return out;
}

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', timeout: CHILD_MS, stdio: ['ignore', 'pipe', 'pipe'] });

/** The real ports (the wiring gives `start`). */
export function realPorts(c, wiring) {
  const uid = c.uids.reviewer;
  return {
    root: c.root, outboxRoot: c.outboxRoot, uids: c.uids, reviewHome: c.reviewHome,
    now: () => Date.now(), ownUid: () => process.getuid(),
    isAdmin: () => adminAnswer(run('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', REVIEW_USER, 'admin'])),
    readCard: (card) => readCardFile({ recordRoot: c.recordRoot, recordUid: c.recordUid, card }),
    currentHead: async (card) => {
      const r = await git(['rev-parse', '--verify', '-q', `refs/heads/card/${card.toLowerCase()}^{commit}`], { gitDir: c.mirror, purpose: 'review-runner-head', timeoutMs: CHILD_MS });
      if (r.code !== 0) throw new Error(`the card's branch is not in the mirror (${r.code})`);
      return r.stdout.toString('utf8').trim();
    },
    sessions: () => {
      const r = run('/bin/ps', ['-U', String(uid), '-o', 'pid=', '-o', 'command=']);
      if (r.status !== 0 && r.status !== 1) throw new Error(`ps failed (${r.error?.code ?? `exit ${r.status}`})`);
      return sessionsFrom(r.stdout, c.claudeBin);
    },
    stop: ({ pid }) => { process.kill(pid, 'SIGTERM'); },
    start: (x) => wiring.start(x),
    accountInUse: () => {
      const copy = c.accountCopy ? readAccountFile({ file: c.accountCopy, uid: 0 }) : { ok: false };
      if (copy.ok) return copy.account;
      // Failing the copy, the owner's own file, read only; missing means account a, as for the owner.
      const own = join(c.ownerHome, ACCOUNT_FILE);
      try { lstatSync(own); } catch (e) { if (e?.code === 'ENOENT') return 'a'; return null; }
      const r = readAccountFile({ file: own, uid: c.ownerUid });
      return r.ok ? r.account : null;
    },
    handedIn: ({ outbox }) => readdirSync(outbox).some((n) => n.startsWith('verdict')),
  };
}

export async function main(argv, { log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (!argv[0]) { log('usage: review-runner-main.mjs <config.json>'); return 1; }
  let c;
  try { c = readConfig(argv[0]); } catch (e) { log(`review runner: ${e.message}`); return 1; }
  const self = realpathSync(fileURLToPath(import.meta.url));
  const bad = installProblem(c.installRoot, [self, realpathSync(argv[0]), c.wiring]);
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

// The review runner (lead call L65). Reviewers and auditors run as a separate plain Mac user, `review`, so a worker
// can't hand in a reviewer's verdict. No other user can start them: there is no sudo rule. A LaunchDaemon owned by
// root runs this program as `review` once a minute and whenever a request arrives (review-runner.plist). It is the only
// thing that starts a review session.
//
// The Dispatcher only asks. It writes a request { card, head, role, request_id } into requests/, a folder anyone may
// add to (sticky, so no one but review removes another's file). The runner trusts nothing in a request:
//   - the card must be in the Record (read only) and in a state that needs this role (an auditor only on a Tier-1 card);
//   - `head` must be the card's head in the Record and its current head in git (read only);
//   - the role must be reviewer or auditor;
//   - nothing may already be running for that card, tree and role;
//   - per card, tree and role there is one start (L69: an amend with no code change keeps its tree, so it gets no new
//     roll). A start where claude never ran may be tried again after 15 minutes, 3 tries in all, and then Joe is told.
// Nothing a worker can write starts a review again (lead call L68), and a session that ran never starts again on its
// own (L69). A session that ended with no verdict file (a crash, a context-limit stop or a kill does this too) or with
// one that can't be counted holds its head: the Merge Gate counts it as a failure, and Joe is told, with a "review
// again" tap. The tap (`setAsideByJoe`) sets that session aside in set-aside/, so it has no say, and the next request
// may start a new one. A verdict the Record has not taken 15 minutes after its session ended is told to Joe, and
// nothing starts again: the Merge Gate and the Record's move to verified read the verdict files themselves.
// When a session ends, the runner writes its ended record into ended/ (L68), with the verdict file's sha256 at that
// moment (L69): only that version counts. Each pass on which every live review session is the runner's own, it also
// marks ended any launched session it is not running (a start it lost track of), once that launch is 5 minutes old,
// reading its verdict file as at any end. A new reviewer's prompt holds the notes of the card's earlier failing
// verdicts on other trees (`earlier`, L69). A launch record that fails its checks is told to Joe once.
// Every request name is read each pass (L66): a name that is not a request's is moved aside into rejected/, so junk
// can't hold real requests back, and more than 200 waiting is told to Joe. Only starts are capped, 50 a pass, oldest
// first by when the runner first saw each request.
// The runner makes the session id itself, and writes the launch record into launches/, which only review can write.
// A verdict counts only when it matches one of those records (M9 outbox.mjs `runnerLaunchFor`); the Dispatcher's copy
// in the Record never counts. status.json (anyone may read it) lists what is running and the alerts for Joe, with
// `written_at`; the Dispatcher's `hasReviewer` reads it, and a status that is missing or older than 3 minutes is an
// error, never "no reviewer" (L63).
//
// The runner refuses to start anything when `review` is an admin (m-3), and stops any review session it did not start,
// telling Joe (m-7). It stops nothing that isn't claude: before a stop it reads the process's command through a port
// (`processName`), so a pid reused by another program is left alone. The contract of `start` (L66): it returns claude's
// own pid, never the launcher's, and the runner checks that too. The status carries the installed copy's commit stamp
// (`installed_commit`), so the Dispatcher can tell Joe when the copy is behind main. Every outside effect is a port, so the tests run on fakes: starting claude, git, the Record read,
// the admin check, the session list and the stop. review-runner-main.mjs joins the real ones.
//
// The review folder (`root`), owned by review:
//   requests/    1733   anyone adds a request; only review reads and removes them
//   rejected/    0700   files in requests/ whose names are not a request's, moved aside unread
//   launches/    0755   the launch records (M9 reads them)
//   ended/       0755   the ended records, one per launched session once it has ended (M9 `runnerEnded` reads them)
//   set-aside/   0755   Joe's "review again": one record per session Joe set aside (M9 `runnerAside` reads them)
//   status.json  0644   { written_at, ok, error, installed_commit, running, refused, alerts }
//   state.json   0600   the runner's own memory: running sessions, tries per card, head and role, request ids seen

import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { REVIEW_ROLES } from '../../../shared/review-roles.mjs';
import { SESSION_ID } from '../../../shared/record.mjs';
import { ASIDE_FOLDER, ENDED_FOLDER, PASSES, launchesFolderProblem, reviewUid, runnerLaunches, CARD_ID } from '../../M9-record/outbox.mjs';
import { checkReviewOutbox, reviewOutbox, uidsProblem } from './review-user.mjs';
import { ACCOUNT_NAMES, accountDir, accountEnv } from './accounts.mjs';

export const RETRY_MS = 15 * 60_000;
// How long after a session ends the Record has to take its verdict before Joe is told (item 20(a); L68: told, never restarted).
export const INTAKE_WAIT_MS = 15 * 60_000;
// How old a launch must be before a pass marks it ended when the runner is not running it (L68).
export const SWEEP_AFTER_MS = 5 * 60_000;
export const MAX_FAILED_STARTS = 3;
export const STATUS_STALE_MS = 3 * 60_000;
export const MAX_REQUEST_BYTES = 4096;
export const MAX_STARTS_PER_PASS = 50;
export const MAX_PENDING = 200;
const KEEP_SEEN = 500;
const KEEP_LIST = 50;
export const REQUEST_NAME = /^[A-Za-z0-9-]{1,64}\.json$/;
export const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
export { CARD_ID };
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// The earlier failing verdicts' notes a new reviewer gets in its prompt (L69 point 4): the newest few, each cut short.
export const MAX_EARLIER = 5;
export const MAX_EARLIER_NOTES = 4000;
export const FOLDERS = Object.freeze({ requests: 'requests', rejected: 'rejected', launches: 'launches', ended: ENDED_FOLDER, aside: ASIDE_FOLDER, status: 'status.json', state: 'state.json' });
const REQUEST_KEYS = ['card', 'head', 'request_id', 'role'];

const iso = (t) => new Date(t).toISOString();

/** Is a `ps` command line the pinned claude's? The one reading, for the session list and the check before a stop. */
export const isClaudeCommand = (cmd, bin) => typeof cmd === 'string' && typeof bin === 'string' && bin.length > 0 && (cmd === bin || cmd.startsWith(`${bin} `));
// One start per card, tree and role (L69 point 4): an amend with no code change keeps its tree, so it gets no new roll.
const keyOf = (card, tree, role) => `${card}:${tree}:${role}`;

/** Does a card in this state need a session of this role? A reviewer for every card in review; an auditor too on Tier 1 (m-6). */
export function needsRole(doc, role) {
  if (!doc || doc.state !== 'in_review') return false;
  if (role === 'reviewer') return true;
  return role === 'auditor' && doc.tier === 1;
}

/** The roles a card in review needs (the Dispatcher asks for each, the runner checks each). */
export const rolesFor = (doc) => REVIEW_ROLES.filter((r) => needsRole(doc, r));

function folderProblem(path, uid, mode) {
  let st; try { st = lstatSync(path); } catch { return `${path} is missing`; }
  if (st.isSymbolicLink()) return `${path} is a link`;
  if (!st.isDirectory()) return `${path} is not a folder`;
  if (st.uid !== uid) return `${path} is not owned by the review user`;
  if (mode === undefined ? st.mode & 0o022 : (st.mode & 0o7777) !== mode) return mode === undefined ? `${path} can be written by others` : `${path} has mode ${(st.mode & 0o7777).toString(8)}, not ${mode.toString(8)}`;
  return null;
}
function ensureFolder(path, mode) {
  try { lstatSync(path); return; } catch { /* make it */ }
  mkdirSync(path, { mode });
  chmodSync(path, mode);
}

/** One request file, read without following a link or waiting on a pipe; it is always removed after. → { ok, req } | { ok: false, reason } */
export function readRequest(dir, name) {
  const p = join(dir, name);
  const out = (() => {
    if (!REQUEST_NAME.test(name)) return { ok: false, reason: 'the file name is not letters, digits and dashes with .json' };
    let fd;
    try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) { return { ok: false, reason: e?.code === 'ELOOP' ? 'it is a link' : `it can't be read (${e?.code ?? e})` }; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: 'it is not a plain file' };
      if (st.nlink !== 1) return { ok: false, reason: 'it has more than one name' };
      if (st.size > MAX_REQUEST_BYTES) return { ok: false, reason: 'it is too big' };
      let req; try { req = JSON.parse(readFileSync(fd, 'utf8')); } catch { return { ok: false, reason: 'it is not JSON' }; }
      if (!req || typeof req !== 'object' || Array.isArray(req)) return { ok: false, reason: 'it is not an object' };
      const keys = Object.keys(req).sort();
      if (keys.join() !== REQUEST_KEYS.join()) return { ok: false, reason: `it must hold exactly ${REQUEST_KEYS.join(', ')}` };
      if (typeof req.card !== 'string' || !CARD_ID.test(req.card)) return { ok: false, reason: 'the card id is not a plain id' };
      if (typeof req.head !== 'string' || !HEX40.test(req.head)) return { ok: false, reason: 'the head is not 40 hex' };
      if (typeof req.role !== 'string' || req.role.length > 40) return { ok: false, reason: 'the role is not a short word' };
      if (typeof req.request_id !== 'string' || !REQUEST_ID.test(req.request_id)) return { ok: false, reason: 'the request id is not letters, digits and dashes' };
      return { ok: true, req };
    } finally { closeSync(fd); }
  })();
  try { unlinkSync(p); } catch { /* gone already */ }
  return out;
}

function readState(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return { ok: true, state: { running: [], attempts: {}, seen: [], alerts: [], told: [] } }; return { ok: false, reason: `the runner's state can't be read (${e?.code ?? e})` }; }
  try {
    const s = JSON.parse(text);
    if (!Array.isArray(s.running) || !s.attempts || typeof s.attempts !== 'object' || !Array.isArray(s.seen)) throw new Error('shape');
    return { ok: true, state: { alerts: [], told: [], ...s } };
  } catch { return { ok: false, reason: 'the runner\'s state is not what the runner writes' }; }
}
// A new file put in place in one step, so a reader never sees half of it.
function writeWhole(path, value, mode) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
/** A launch or ended record: written under a temp name, then given its real name only if that name is free (never written over). */
function writeLaunch(dir, sid, doc) {
  const tmp = join(dir, `.${sid}.json.tmp`);
  const final = join(dir, `${sid}.json`);
  try { unlinkSync(tmp); } catch { /* none left from a pass that stopped part way */ }
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o644, flag: 'wx' });
  try { chmodSync(tmp, 0o644); linkSync(tmp, final); } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  return final;
}

/**
 * One pass. `ctx`:
 *   root, outboxRoot, uids (the M9 map; both review roles name the review user), reviewHome (review's home folder)
 *   now(), ownUid(), newId() (default randomUUID)
 *   isAdmin() → true | false; a throw counts as an admin (m-3)
 *   readCard(card) → { ok, doc, rev } (the Record, read only)      currentHead(card, doc) → 40 hex (git, read only)
 *   treeOf(card, head) → the head's tree, 40 hex (git, read only; L69): one start per card, tree and role
 *   setAsideByJoe() → [{ session_id }] Joe's "review again" taps since the last pass (L69; a port now, wired to the phone
 *     link at the cutover). Each sets that session aside (it has no say) and lets a new session start
 *   verdictTaken({ role, sessionId, card, head }) → { ok: true } when the Record holds this session's verdict and its
 *     file still reads true (M9 `verdictFromFile`); { ok: false, reason } when it doesn't; a throw when the Record can't
 *     be read (item 20(a)). Only ever told to Joe: nothing starts again on what it says (L68)
 *   sessions() → [{ pid, sessionId? }] the review sessions alive now     stop({ pid, sessionId })
 *   claudeBin, processName(pid) → the process's command line: nothing is stopped, and no start counts, unless it is
 *     claude's (`isClaudeCommand`)
 *   start({ role, card, head, tree, sessionId, outbox, configDir, env, signin, earlier }) → { ok, pid } | { ok: false,
 *     reason }; the pid is claude's own process, never the launcher's (L66). `earlier` is [{ session_id, head, notes }],
 *     the card's earlier failing verdicts for this role on other trees, newest first (L69): the prompt includes them
 *   accountInUse() → 'a' | 'b' (which sign-in folder of review's to start on)
 *   handedIn({ role, sessionId, outbox, card, head }) → { ok: true, verdict } when the session left a verdict that can be
 *     counted (verdict.sha256 is the file's); { ok: false, none: true } when it left none; { ok: false, reason } when it
 *     left one that can't be counted (M9 `sessionVerdict`, the same read the Merge Gate makes)
 *   installedCommit() → the installed copy's commit stamp (40 hex), shown in the status
 * Returns { ok, error?, started: [...], refused: [...], stopped: [...], alerts: [...] } (also what status.json shows).
 */
export async function runnerPass(ctx) {
  const now = ctx.now();
  const newId = ctx.newId ?? randomUUID;
  const result = { ok: true, error: null, started: [], refused: [], stopped: [], alerts: [], setAside: [] };
  let installed = null;
  try { const c = await ctx.installedCommit?.(); installed = typeof c === 'string' && HEX40.test(c) ? c : null; } catch { installed = null; }
  // Who we are and where we write come first: a runner that is not review, or a folder that is not review's, writes nothing.
  const mapBad = uidsProblem(ctx.uids);
  const who = mapBad ? { ok: false, reason: mapBad } : reviewUid(ctx.uids);
  if (!who.ok) return { ...result, ok: false, error: `the review user is not set up: ${who.reason}`, wrote: false };
  const uid = who.uid;
  let own; try { own = ctx.ownUid(); } catch { own = null; }
  if (own !== uid) return { ...result, ok: false, error: `the review runner runs only as the review user (uid ${uid}), not uid ${own}`, wrote: false };
  const rootBad = folderProblem(ctx.root, uid);
  if (rootBad) return { ...result, ok: false, error: `the review folder: ${rootBad}`, wrote: false };

  const P = { requests: join(ctx.root, FOLDERS.requests), rejected: join(ctx.root, FOLDERS.rejected), launches: join(ctx.root, FOLDERS.launches), ended: join(ctx.root, FOLDERS.ended), aside: join(ctx.root, FOLDERS.aside), status: join(ctx.root, FOLDERS.status), state: join(ctx.root, FOLDERS.state) };
  const st = readState(P.state);
  const state = st.ok ? st.state : { running: [], attempts: {}, seen: [], alerts: [], told: [] };
  // `at` is the alert's time; the Dispatcher tells each id and time once, so a trouble that keeps the state from being
  // saved passes the time it began (the file's), not this pass's.
  // `offer` adds what Joe can do about it (L69: { action: 'review-again', session_id }).
  const alert = (id, text, at = iso(now), offer = null) => {
    if (state.told.includes(id)) return;
    state.told = [...state.told, id].slice(-KEEP_SEEN);
    const a = { id, at, text, ...(offer ?? {}) };
    state.alerts = [...state.alerts, a].slice(-KEEP_LIST);
    result.alerts.push(a);
  };
  const fail = (error) => { result.ok = false; result.error = result.error ? `${result.error}; ${error}` : error; };
  const finish = () => {
    const status = { written_at: iso(now), ok: result.ok, error: result.error, installed_commit: installed,
      running: state.running.map(({ card, head, role, session_id, started_at }) => ({ card, head, role, session_id, started_at })),
      refused: [...(state.refused ?? []), ...result.refused].slice(-KEEP_LIST), alerts: state.alerts };
    state.refused = status.refused;
    // A corrupt state is never written over: Joe looks at it first (the status says why).
    if (st.ok) writeWhole(P.state, state, 0o600);
    writeWhole(P.status, status, 0o644);
    return { ...result, wrote: true, status };
  };
  if (!st.ok) {
    let since = iso(now);
    try { since = lstatSync(P.state).mtime.toISOString(); } catch { /* keep now */ }
    fail(st.reason);
    alert('state-corrupt', `The review runner's memory file can't be read, so it starts nothing: ${st.reason}.`, since);
    return finish();
  }

  // m-3: an admin can become anyone, so a review user that is an admin keeps nothing apart.
  let admin; try { admin = await ctx.isAdmin(); } catch { admin = true; }
  if (admin !== false) { fail('the review user is an admin (or that could not be checked), so no review starts'); alert('review-admin', 'The review user is an admin Mac user (or the check failed). No reviewer or auditor starts until it is a standard user.'); return finish(); }
  // A trouble that has cleared may be told again if it comes back.
  state.told = state.told.filter((t) => t !== 'review-admin' && t !== 'state-corrupt');

  try {
    ensureFolder(P.requests, 0o1733);
    ensureFolder(P.rejected, 0o700);
    ensureFolder(P.launches, 0o755);
    ensureFolder(P.ended, 0o755);
    ensureFolder(P.aside, 0o755);
  } catch (e) { fail(`the review folders could not be made (${e?.code ?? e?.message})`); return finish(); }
  const reqBad = folderProblem(P.requests, uid, 0o1733) ?? folderProblem(P.rejected, uid, 0o700) ?? launchesFolderProblem(P.launches, uid)
    ?? ((b) => b && `the ended records: ${b}`)(launchesFolderProblem(P.ended, uid)) ?? ((b) => b && `the set-aside records: ${b}`)(launchesFolderProblem(P.aside, uid));
  if (reqBad) { fail(`the review folders: ${reqBad}`); return finish(); }

  // The sessions alive now. One the runner did not start is stopped, and Joe is told (m-7); one that ended leaves `running`.
  let live;
  try { live = await ctx.sessions(); } catch (e) { fail(`the review sessions could not be listed (${e?.message ?? e}), so none starts`); return finish(); }
  const mine = new Set(state.running.map((r) => r.pid));
  let strayClaude = false;
  for (const s of live) {
    if (mine.has(s.pid)) continue;
    // The pid may have ended and been reused since the list: only a process that is still claude is stopped.
    let cmd = null; try { cmd = await ctx.processName(s.pid); } catch { cmd = null; }
    const isClaude = isClaudeCommand(cmd, ctx.claudeBin);
    if (isClaude) strayClaude = true;
    let stopped = false;
    if (isClaude) { stopped = true; try { await ctx.stop(s); } catch { stopped = false; } }
    result.stopped.push({ pid: s.pid, sessionId: s.sessionId ?? null, stopped });
    const what = isClaude ? (stopped ? 'stopped' : 'could not be stopped') : 'not stopped, because the process is no longer claude';
    alert(`stray-${s.pid}-${s.sessionId ?? ''}`, `A review session the review runner did not start was found (process ${s.pid}${s.sessionId ? `, session ${s.sessionId}` : ''}) and ${what}.`);
  }
  // The ended record (L68, L69): a session the runner launched has its say at the Merge Gate through its verdict file,
  // and holds the head until it is marked here. The record says what the file was at the end (`verdict_sha256`: its
  // sha256, `none` or `refused`), and only that version counts. Written once, never over; one that can't be written
  // fails the pass, and the sweep below tries again.
  const markEnded = (doc, said, how) => {
    try {
      writeLaunch(P.ended, doc.session_id, { session_id: doc.session_id, role: doc.role, card: doc.card, head: doc.head, ...(doc.tree ? { tree: doc.tree } : {}), ended_at: iso(now), verdict_sha256: said, how });
      return true;
    } catch (e) {
      if (e?.code === 'EEXIST') return true;   // marked already
      fail(`session ${doc.session_id} could not be marked ended (${e?.code ?? e?.message})`);
      return false;
    }
  };
  const reviewAgain = 'A tap on "review again" sets that session aside so a new one can start; a new push also gets a new review.';
  // A session the runner launched has ended (or was swept): read its verdict, mark it ended, and settle its try. Silence
  // is a failure (L69 point 1): a session that ran and left no verdict, or one that can't be counted, holds the head, and
  // Joe is told. Nothing starts again on its own; Joe's "review again" sets the session aside.
  const endSession = async (doc, how) => {
    const k = keyOf(doc.card, doc.tree ?? doc.head, doc.role);
    const a = state.attempts[k] ?? { failures: 0 };
    let h;
    try { h = await ctx.handedIn({ role: doc.role, sessionId: doc.session_id, outbox: reviewOutbox({ outboxRoot: ctx.outboxRoot, role: doc.role, sessionId: doc.session_id }), card: doc.card, head: doc.head }); } catch (e) { h = { ok: false, reason: `its verdict could not be read (${e?.message ?? e})` }; }
    const sha = h?.ok === true && HEX64.test(h.verdict?.sha256 ?? '') ? h.verdict.sha256 : null;
    const said = sha ?? (h?.ok !== true && h?.none === true ? 'none' : 'refused');
    if (!markEnded(doc, said, how)) return false;
    const done = { ...a, started: true, ended_at: iso(now), session_id: doc.session_id };
    const where = `card ${doc.card} at ${doc.head.slice(0, 7)}`;
    const offer = { action: 'review-again', session_id: doc.session_id };
    if (sha) state.attempts[k] = { ...done, held: false };
    else if (said === 'none') {
      state.attempts[k] = { ...done, held: true, last_reason: 'ended with no verdict' };
      alert(`silent-${doc.session_id}`, `The ${doc.role} session ${doc.session_id} for ${where} ended without handing in a verdict (a crash, a context-limit stop or a kill does this too). That counts as a failure, so this head can't pass, and nothing starts again on its own. ${reviewAgain}`, undefined, offer);
    } else {
      const why = typeof h?.reason === 'string' && h.reason ? h.reason.slice(0, 300) : h?.ok === true ? 'the file\'s sha256 was not given' : 'no reason given';
      state.attempts[k] = { ...done, held: true, last_reason: `its verdict can't be counted: ${why}` };
      alert(`held-${doc.session_id}`, `The ${doc.role} session ${doc.session_id} for ${where} handed in a verdict that can't be counted (${why}). It counts as a failure, so this head can't pass; no new ${doc.role} starts on it on its own. ${reviewAgain}`, undefined, offer);
    }
    return true;
  };
  const alive = new Set(live.map((s) => s.pid));
  for (const r of state.running.filter((x) => !alive.has(x.pid))) await endSession(r, 'ended');
  state.running = state.running.filter((x) => alive.has(x.pid));

  // The launch records, read once for the sweep, Joe's taps and the requests. One that fails its checks is told to Joe
  // once: the Merge Gate refuses the card it belongs to, or skips it when it names no card (L69 point 3).
  const rl = runnerLaunches({ root: P.launches, uids: ctx.uids });
  if (!rl.ok) fail(`the launch records could not be read: ${rl.reason}`);
  for (const b of rl.ok ? rl.refused : []) {
    const whose = b.tie?.card ? `It belongs to card ${b.tie.card}, which can't pass until it is fixed${b.tie.role ? `; a tap on "review again" for session ${b.sid} sets it aside` : ''}.` : 'It names no card, so the Merge Gate skips it.';
    alert(`bad-record-${b.name}`, `The review runner's launch record ${b.name.slice(0, 80)} fails its checks (${b.reason}). ${whose}`, undefined, b.tie?.role ? { action: 'review-again', session_id: b.sid } : null);
  }
  let asideIds = new Set();
  try { asideIds = new Set(readdirSync(P.aside).filter((n) => !n.startsWith('.')).map((n) => n.replace(/\.json$/, ''))); } catch (e) { fail(`the set-aside records could not be listed (${e?.code ?? e})`); }

  // The sweep (L68): a launched session the runner is not running, with no ended record, is one it lost track of (it
  // stopped between the launch record and saving its memory, or the start gave a pid that wasn't claude's). It is marked
  // ended only on a pass where every live claude session of review's is the runner's own, so none can still hand in a
  // verdict, and only once its launch is 5 minutes old, so the session list has had time to show it. Its verdict file is
  // read as at any end, so a session that handed in a pass before it was lost still counts.
  if (!strayClaude && rl.ok) {
    const runningIds = new Set(state.running.map((x) => x.session_id));
    for (const { doc } of rl.launches) {
      if (runningIds.has(doc.session_id)) continue;
      const at = Date.parse(doc.launched_at ?? '');
      if (Number.isFinite(at) && now - at < SWEEP_AFTER_MS) continue;
      try { lstatSync(join(P.ended, `${doc.session_id}.json`)); continue; } catch { /* not marked */ }
      if (await endSession(doc, 'swept')) alert(`swept-${doc.session_id}`, `The ${doc.role} session ${doc.session_id} for card ${doc.card} at ${doc.head.slice(0, 7)} was not being tracked by the review runner; it is now marked ended.`);
    }
  }

  // Joe's "review again" (L69 point 1). A tap names a session; the runner checks it is one it holds a head for (it ended
  // without a verdict that counts) or one whose launch record fails its checks, and not running. It then writes the
  // set-aside record (the Merge Gate gives that session no say) and clears the hold, so the next request may start a new
  // session. Taps come only through this port, never from requests/: anyone can write there.
  let taps = [];
  try { const t = await ctx.setAsideByJoe?.(); taps = Array.isArray(t) ? t : []; } catch (e) { fail(`Joe's "review again" taps could not be read (${e?.message ?? e})`); }
  for (const t of taps) {
    const sid = t?.session_id;
    const no = (reason) => result.refused.push({ at: iso(now), request: null, card: null, role: null, request_id: null, reason: `Joe's "review again" for session ${String(sid).slice(0, 80)}: ${reason}` });
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) { no('that is not a session id'); continue; }
    if (!rl.ok) { no('the launch records could not be read'); continue; }
    if (state.running.some((r) => r.session_id === sid)) { no('that session is still running'); continue; }
    const good = rl.launches.find((l) => l.doc.session_id === sid)?.doc;
    const bad = good ? null : rl.refused.find((b) => b.sid === sid && b.tie?.role);
    const doc = good ?? (bad ? { session_id: sid, ...bad.tie } : null);
    if (!doc) { no('the runner launched no such session, or its record names no role, card and head'); continue; }
    const k = keyOf(doc.card, doc.tree ?? doc.head, doc.role);
    const a = state.attempts[k];
    const held = a?.held === true && a.session_id === sid;
    if (!held && !bad) { no('only a session that ended without a verdict that counts, or whose launch record fails its checks, can be set aside'); continue; }
    try {
      writeLaunch(P.aside, sid, { session_id: sid, role: doc.role, card: doc.card, head: doc.head, ...(doc.tree ? { tree: doc.tree } : {}), set_aside_at: iso(now), by: 'joe' });
    } catch (e) { if (e?.code !== 'EEXIST') { fail(`session ${sid} could not be set aside (${e?.code ?? e?.message})`); continue; } }
    asideIds.add(sid);
    if (held) state.attempts[k] = { failures: a.failures ?? 0, set_aside: [...(a.set_aside ?? []), sid].slice(-KEEP_LIST) };
    result.setAside.push({ session_id: sid, card: doc.card, role: doc.role });
  }

  // Every request name, each pass (L66 starvation). A name that is not a request's is moved aside unread; the rest are
  // taken oldest first by when this runner first saw them (a name can't buy a place in the queue), each removed once
  // read. Only starts are capped: at most 50 a pass, and what is left waits for the next pass.
  let all = [];
  try { all = readdirSync(P.requests).filter((n) => !n.startsWith('.')); } catch (e) { fail(`the requests could not be listed (${e?.code ?? e})`); }
  let moved = 0;
  for (const n of all.filter((x) => !REQUEST_NAME.test(x))) {
    try { renameSync(join(P.requests, n), join(P.rejected, `${now}-${randomUUID()}`)); moved += 1; } catch (e) { fail(`a file in requests/ could not be moved aside (${e?.code ?? e})`); break; }
  }
  if (moved) result.refused.push({ at: iso(now), request: null, card: null, role: null, request_id: null, reason: `${moved} file(s) whose names are not a request's were moved aside to rejected/` });
  const firstSeen = state.first_seen ?? {};
  const pending = all.filter((x) => REQUEST_NAME.test(x));
  state.first_seen = Object.fromEntries(pending.map((n) => [n, firstSeen[n] ?? iso(now)]));
  const names = pending.sort((x, y) => (state.first_seen[x] < state.first_seen[y] ? -1 : state.first_seen[x] > state.first_seen[y] ? 1 : x < y ? -1 : 1));
  if (names.length > MAX_PENDING) alert('requests-pending', `${names.length} review requests are waiting (more than ${MAX_PENDING}); something may be asking far too often.`);
  else state.told = state.told.filter((t) => t !== 'requests-pending');
  let starts = 0;
  for (const name of names) {
    if (starts >= MAX_STARTS_PER_PASS) break;
    delete state.first_seen[name];
    const got = readRequest(P.requests, name);
    const refuse = (reason, req = got.req) => result.refused.push({ at: iso(now), request: name, card: req?.card ?? null, role: req?.role ?? null, request_id: req?.request_id ?? null, reason });
    if (!got.ok) { refuse(`the request ${got.reason}`); continue; }
    const { card, head, role, request_id: rid } = got.req;
    if (state.seen.includes(rid)) { refuse(`request id ${rid} was seen before`); continue; }
    state.seen = [...state.seen, rid].slice(-KEEP_SEEN);
    if (!REVIEW_ROLES.includes(role)) { refuse(`"${role}" is not a review role`); continue; }
    let c; try { c = await ctx.readCard(card); } catch (e) { c = { ok: false, reason: e?.message ?? String(e) }; }
    if (!c?.ok) { refuse(`card ${card} is not in the Record${c?.reason ? ` (${c.reason})` : ''}`); continue; }
    if (!needsRole(c.doc, role)) { refuse(`card ${card} does not need a ${role} (it is ${c.doc?.state ?? 'in no state'}${role === 'auditor' ? `, tier ${c.doc?.tier ?? 'none'}` : ''})`); continue; }
    if (c.doc.head !== head) { refuse(`the request names head ${head.slice(0, 7)}, but the card's head is ${String(c.doc.head ?? 'none').slice(0, 7)}`); continue; }
    let gitHead; try { gitHead = await ctx.currentHead(card, c.doc); } catch (e) { gitHead = null; refuse(`the card's head in git could not be read (${e?.message ?? e})`); continue; }
    if (gitHead !== head) { refuse(`the request names head ${head.slice(0, 7)}, but the card's branch is at ${String(gitHead ?? 'nothing').slice(0, 7)}`); continue; }
    let tree; try { tree = await ctx.treeOf(card, head); } catch (e) { refuse(`the tree of ${head.slice(0, 7)} could not be read (${e?.message ?? e})`); continue; }
    if (typeof tree !== 'string' || !HEX40.test(tree)) { refuse(`the tree of ${head.slice(0, 7)} could not be read`); continue; }
    if (!rl.ok) { refuse(`the launch records could not be read, so no ${role} starts`); continue; }
    const k = keyOf(card, tree, role);
    if (state.running.some((r) => keyOf(r.card, r.tree ?? r.head, r.role) === k)) { refuse(`a ${role} is already running for card ${card} at ${head.slice(0, 7)} (or a head with the same tree)`); continue; }
    let a = state.attempts[k] ?? { failures: 0 };
    // The launch records say it too, whatever the runner's memory says: a session on this card's tree (or head) for this
    // role, not set aside by Joe, is a start already made.
    const made = rl.launches.some(({ doc: d }) => d.card === card && d.role === role && (d.head === head || d.tree === tree) && !asideIds.has(d.session_id));
    if (a.started || made) {
      // One start per tree, for good (L68, L69): what the Record says is never a reason to start again, since a worker
      // can write the Record, and an amend with no code change keeps its tree. A verdict the Record has not taken 15
      // minutes after its session ended is told to Joe once; the Merge Gate reads the verdict file itself either way. A
      // held head (silent, or a verdict that can't be counted) was told already, with the "review again" tap.
      const sid = a.session_id;
      const ended = Date.parse(a.ended_at ?? '');
      if (!a.held && Number.isFinite(ended) && now - ended >= INTAKE_WAIT_MS) {
        let t;
        try { t = await ctx.verdictTaken({ role, sessionId: sid, card, head }); } catch (e) { t = { ok: false, reason: `the Record could not be read (${e?.message ?? e})` }; }
        if (t?.ok !== true) {
          const why = typeof t?.reason === 'string' && t.reason ? t.reason.slice(0, 300) : 'no reason given';
          alert(`not-taken-${sid ?? k}`, `The ${role} for card ${card} at ${head.slice(0, 7)} handed in a verdict the Record has not taken (${why}). Nothing starts again: the Merge Gate reads the verdict file itself, and the card waits for Joe.`);
        }
      }
      refuse(`a ${role} was already started for card ${card} at ${head.slice(0, 7)} (or a head with the same tree); one start per head and tree`);
      continue;
    }
    if ((a.failures ?? 0) >= MAX_FAILED_STARTS) {
      refuse(`${MAX_FAILED_STARTS} starts of a ${role} for card ${card} at ${head.slice(0, 7)} failed; Joe is told`);
      alert(`gave-up-${k}`, `No ${role} could be started for card ${card} at ${head.slice(0, 7)} after ${MAX_FAILED_STARTS} tries (last: ${a.last_reason ?? 'ended with no verdict'}).`);
      continue;
    }
    if (a.last_failed_at && now - Date.parse(a.last_failed_at) < RETRY_MS) { refuse(`the last start of a ${role} for card ${card} failed less than 15 minutes ago`); continue; }

    // Start it: the session id is the runner's own, the outbox is made fresh, the launch record is written before the start.
    starts += 1;
    const sid = newId();
    const failStart = (reason) => {
      state.attempts[k] = { ...a, started: false, failures: (a.failures ?? 0) + 1, last_failed_at: iso(now), last_reason: reason };
      refuse(`the ${role} could not be started: ${reason}`);
      if (state.attempts[k].failures >= MAX_FAILED_STARTS) alert(`gave-up-${k}`, `No ${role} could be started for card ${card} at ${head.slice(0, 7)} after ${MAX_FAILED_STARTS} tries (last: ${reason}).`);
    };
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) { failStart('the new session id is not letters, digits and dashes'); continue; }
    let acct; try { acct = await ctx.accountInUse(); } catch (e) { acct = null; }
    if (!ACCOUNT_NAMES.includes(acct)) { failStart('the account in use could not be read'); continue; }
    let outbox;
    try {
      ensureFolder(join(ctx.outboxRoot, role), 0o755);
      outbox = reviewOutbox({ outboxRoot: ctx.outboxRoot, role, sessionId: sid });
      mkdirSync(outbox, { mode: 0o755 });   // never there before: a session id is never reused
      chmodSync(outbox, 0o755);
    } catch (e) { failStart(`its outbox could not be made (${e?.code ?? e?.message})`); continue; }
    const ob = checkReviewOutbox({ outboxRoot: ctx.outboxRoot, role, sessionId: sid, uid });
    if (!ob.ok) { failStart(ob.reason); continue; }
    const configDir = accountDir(ctx.reviewHome, acct);
    // The card's earlier failing verdicts for this role, on other trees (L69 point 4): the new reviewer's prompt holds
    // their notes, so a new push is checked against what failed before. Joe's set-aside sessions are left out.
    const earlier = [];
    for (const { doc: d } of [...rl.launches].sort((x, y) => String(y.doc.launched_at).localeCompare(String(x.doc.launched_at)))) {
      if (earlier.length >= MAX_EARLIER) break;
      if (d.card !== card || d.role !== role || d.head === head || d.tree === tree || asideIds.has(d.session_id)) continue;
      let h; try { h = await ctx.handedIn({ role, sessionId: d.session_id, outbox: reviewOutbox({ outboxRoot: ctx.outboxRoot, role, sessionId: d.session_id }), card, head: d.head }); } catch { continue; }
      if (h?.ok !== true || PASSES[role](h.verdict)) continue;
      const n = h.verdict?.notes;
      earlier.push({ session_id: d.session_id, head: d.head, notes: (typeof n === 'string' ? n : JSON.stringify(n ?? null)).slice(0, MAX_EARLIER_NOTES) });
    }
    let recPath;
    try {
      recPath = writeLaunch(P.launches, sid, { session_id: sid, role, card, head, tree, request_id: rid, launched_at: iso(now), signin: acct, config_dir: configDir });
    } catch (e) { failStart(`its launch record could not be written (${e?.code ?? e?.message})`); continue; }
    let r;
    try { r = await ctx.start({ role, card, head, tree, sessionId: sid, outbox, configDir, env: accountEnv(ctx.reviewHome, acct), signin: acct, earlier }); } catch (e) { r = { ok: false, reason: e?.message ?? String(e) }; }
    if (!r?.ok || !Number.isInteger(r.pid)) {
      // Claude never ran: the one case a start is tried again on its own (L69 point 1).
      try { unlinkSync(recPath); } catch { /* gone */ }
      failStart(r?.reason ?? 'the start gave no process id');
      continue;
    }
    // The pid must be claude's own (L66): one that is the launcher's would not match the session list, and the next pass
    // would stop claude as a stray. Claude may have run, so this is no failed start (L69): the launch record stays, the
    // head is held as started, and the sweep marks the session ended once it is 5 minutes old, reading its verdict file
    // as at any end. Joe is told.
    let cmd = null; try { cmd = await ctx.processName(r.pid); } catch { cmd = null; }
    if (!isClaudeCommand(cmd, ctx.claudeBin)) {
      state.attempts[k] = { ...a, started: true, started_at: iso(now), session_id: sid, last_reason: `the start gave process ${r.pid}, which is not claude` };
      refuse(`the ${role} start gave process ${r.pid}, which is not claude; the session is held until the runner marks it ended`);
      alert(`untracked-${sid}`, `The ${role} session ${sid} for card ${card} at ${head.slice(0, 7)} was started, but the start gave process ${r.pid}, which is not claude. The runner can't follow it; it is marked ended after ${SWEEP_AFTER_MS / 60_000} minutes, and what it handed in by then counts.`);
      continue;
    }
    state.attempts[k] = { ...a, started: true, started_at: iso(now), session_id: sid };
    state.running.push({ card, head, tree, role, session_id: sid, pid: r.pid, started_at: iso(now) });
    result.started.push({ card, head, role, session_id: sid, signin: acct });
  }
  return finish();
}

/**
 * The Dispatcher's read of status.json (for `hasReviewer`): the list of review sessions running, or a throw when the
 * status is missing, unreadable, not the runner's shape or older than 3 minutes (L63: never read as "none").
 * `stat` lets a test stand in for the file's owner. → { running, alerts, ok, error }
 */
export function readReviewStatus({ file, now, uid, stat = lstatSync }) {
  // The owner check is never skipped: a status anyone could write would say what runs.
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the review user\'s uid is not known, so its status can\'t be checked');
  // Its folder too: one someone else could write lets them swap the file between the check and the read.
  let ds;
  try { ds = stat(dirname(file)); } catch { throw new Error('the review runner\'s folder is missing'); }
  if (ds.isSymbolicLink() || !ds.isDirectory()) throw new Error('the review runner\'s folder is not a plain folder');
  if (ds.uid !== uid) throw new Error('the review runner\'s folder is not owned by the review user');
  if (ds.mode & 0o022) throw new Error('the review runner\'s folder can be written by others');
  let st;
  try { st = stat(file); } catch { throw new Error('the review runner\'s status is missing'); }
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('the review runner\'s status is not a plain file');
  if (st.nlink !== 1) throw new Error('the review runner\'s status has more than one name');
  if (st.uid !== uid) throw new Error('the review runner\'s status is not owned by the review user');
  if (st.mode & 0o022) throw new Error('the review runner\'s status can be written by others');
  let s;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('the review runner\'s status can\'t be read'); }
  const at = Date.parse(s?.written_at ?? '');
  if (!Number.isFinite(at) || !Array.isArray(s.running)) throw new Error('the review runner\'s status is not what the runner writes');
  if (now - at > STATUS_STALE_MS) throw new Error(`the review runner's status is ${Math.round((now - at) / 60_000)} minutes old; the runner may be stopped`);
  if (at - now > STATUS_STALE_MS) throw new Error('the review runner\'s status is dated in the future; a clock is wrong');
  return { running: s.running, alerts: Array.isArray(s.alerts) ? s.alerts : [], ok: s.ok === true, error: s.error ?? null,
    installed_commit: typeof s.installed_commit === 'string' && HEX40.test(s.installed_commit) ? s.installed_commit : null };
}

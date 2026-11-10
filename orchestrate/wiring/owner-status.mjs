// Part C, runner step 1 (L741, L747): the Dispatcher's side of the worker runner's status file, and the sync ports built
// on it (owner-ports.mjs fixes their shape). Nothing here is wired yet: owner-ports.mjs still hands out refusing ports.
//
// The runner (a LaunchAgent of the owner's user) writes one status file. This module reads it as the orchestrate user and
// trusts it only when the file and its folder are the owner's, plain, written by no one else, of the runner's shape and
// fresh (STATUS_STALE_MS). Anything short of that throws: "not known", never an empty or partial answer.
//
// The workers run as that same owner's user, so the owner check alone can't tell the runner's file from one a worker
// wrote (step 1 self-review M3). Two things cover that: the workers' lock-down must deny their sessions the runner's
// folders (a ruling for the lane that owns render-settings), and here every field that can be derived is checked against
// what it must be (outbox, uid, role from kind), so a forged file can at worst lie about liveness, card or product, never
// widen which file kinds or which outbox a session may use. The wiring cross-checks card against the launch record.
//
// The status file's folder is the runner's own, apart from the requests folder the Dispatcher writes into (that one
// would fail the folder's write check). The owner and mode checks do not see macOS access lists; that is moot while the
// workers share the owner's user (the runner wall, L751), and is a check to add once they do not.
//
// The status file (the runner writes it; this is the only reader):
//   { written_at: ISO, sessions: [SESSION], requests: { <sessionId>: { state } }, answers?: { <ask>: ANSWER } }
//   SESSION: { id, product, kind, card, lead, role, pgid, signin, config_dir, bundle_files, outbox, uid, outbox_open,
//              stop_requested, alive?, ended?, last_write_at?, size?, activity? }
//   - kind: one of RUNNER_KINDS, and role exactly RUNNER_ROLE_OF[kind]; outbox <outboxRoot>/worker/<id>, which exists
//     while outbox_open (a closed one must still be named exactly so); uid the owner's. product, signin, config_dir non-empty; lead a string or null.
//   - outbox_open: true while the outbox may hold a file intake has not taken or told (listed after the end until then).
//   - stop_requested: true once the runner acts on a stop it was asked for (a stop request or stopGroup), written before
//     it acts, and at the latest in the same write that first shows the session not live; it stays true even if the stop
//     fails or times out (r2 audit M1: the Dispatcher's own stop is never counted as a death). A live session stays on the
//     board whatever the flag says (a stop that failed leaves it running: r1 audit m4); a session stopped on request
//     leaves the board once it is no longer live. stopGroup's ok still needs the process group gone. One that
//     ends without it stays on the board only while its card's claim is still its own (`holds`): the outage step sees it
//     die once, and once the card has been handled (waiting on Joe, back in the queue, run again) it is off.
//   - requests[id].state: 'waiting' (seen, not yet acted on), 'started', 'refused', 'stopped' (started and since stopped)
//     or 'cancelled' (a stop request reached it first). A launch request the runner has not seen has no entry. A listed
//     session always has its entry, 'started' while it is live (and then its outbox is open) and 'started' or 'stopped'
//     once it is not; anything else makes the whole status "not known" (r1 audit m1). The runner
//     keeps a used-up entry for at least RUNNER_KEEP_USED_UP_MS (the longest claim timeout plus the stale window), and marks
//     a session that ends on its own 'stopped' once it is no longer live.
//   - answers (step 2, owner-asks.mjs): the runner's answer to each ask request, keyed by the request file's name
//     without .json (ANSWER_KEY). ANSWER: { ok: true|false, reason (a non-empty string when ok is false), ...the port's
//     fields }. The asking port checks each answer against the rest of the same status before it trusts it. The runner
//     keeps an answer as long as a used-up request entry.
// The runner's probe answers only for its own sessions: the wiring routes each session to its own kind's probe.
// The shared reader with review-runner's readReviewStatus is a later extraction that keeps behaviour (L739, L248).

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { STATUS_STALE_MS } from './owner-ports.mjs';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { workerOutboxProblem } from '../modules/M4-workshop/git/session-outbox.mjs';
import { State } from '../modules/M4-workshop/send-safe/activity.mjs';

export const REQUEST_STATES = Object.freeze(['waiting', 'started', 'refused', 'stopped', 'cancelled']);
/** The states in which a launch request is used up: it can never start a session from now on. */
export const USED_UP = Object.freeze(['refused', 'stopped', 'cancelled']);
/** The kinds the worker runner starts and the one role each runs (pass.mjs kindOf and startRole): nothing else. */
export const RUNNER_ROLE_OF = Object.freeze({ editing: 'worker', undo: 'worker', script: 'script' });
export const RUNNER_KINDS = Object.freeze(Object.keys(RUNNER_ROLE_OF));
/** How long the runner keeps a used-up request entry: a day, more than any claim timeout plus the stale window. */
export const RUNNER_KEEP_USED_UP_MS = 24 * 3_600_000;
/** The largest status file read: a bigger one is not the runner's. */
export const STATUS_MAX_BYTES = 1_000_000;
/** How far ahead of this clock a status may be dated: a small clock difference, not the stale window. */
export const CLOCK_SKEW_MS = 30_000;
/** The ask verbs (owner-ports.mjs's async ports) and the name of an answer: <verb>-<a request id or product>[-<nonce>]. */
export const ASK_VERBS = Object.freeze(['launch', 'stopGroup', 'saveWork', 'pauseLead']);
export const ANSWER_KEY = /^(launch|stopGroup|saveWork|pauseLead)-[A-Za-z0-9._-]{1,140}$/;
const SESSION_FIELDS = Object.freeze(['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
/** The activity tracker's states (send-safe/activity.mjs State): probe passes on no other. */
const ACTIVITY_STATES = Object.freeze(Object.values(State));
const SIZE_FIELDS = Object.freeze(['tokens', 'compactions', 'turnEnded', 'endedAt', 'openTools']);

const plainOwned = (st, uid, what) => {
  if (st.isSymbolicLink()) throw new Error(`the worker runner's ${what} is a link`);
  if (st.uid !== uid) throw new Error(`the worker runner's ${what} is not owned by the owner's user`);
  if (st.mode & 0o022) throw new Error(`the worker runner's ${what} can be written by others`);
};

/**
 * Open the file once, never through a link and never waiting (a pipe in its place can't hang the pass), check that same
 * open file, and only then read it (no gap between check and read). → { st, text }; text is null when it is not read.
 */
export function openRead(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    throw new Error(e?.code === 'ELOOP' ? 'the worker runner\'s status is a link' : e?.code === 'ENOENT' ? 'the worker runner\'s status is missing' : `the worker runner's status can't be opened (${e?.code ?? e?.message})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > STATUS_MAX_BYTES) return { st, text: null };
    const text = readFileSync(fd, 'utf8');
    return { st, text: Buffer.byteLength(text) > STATUS_MAX_BYTES ? null : text };
  } finally { closeSync(fd); }
}

// Running: its process group is known to be there, or nothing says it is gone or ended.
export const live = (x) => x.alive === true || (x.alive !== false && x.ended !== true);
const bad = (x, why) => { throw new Error(`session ${x.id} in the worker runner's status ${why}`); };
function checkSession(x, { uid, outboxRoot, realpath }) {
  if (!x || typeof x !== 'object' || !REQUEST_ID.test(x.id ?? '')) throw new Error('a session in the worker runner\'s status is not what the runner writes');
  for (const f of SESSION_FIELDS) if (x[f] === undefined) bad(x, `has no ${f}`);
  if (!Object.hasOwn(RUNNER_ROLE_OF, x.kind)) bad(x, `has kind ${JSON.stringify(x.kind)}, which the runner does not start`);
  if (x.role !== RUNNER_ROLE_OF[x.kind]) bad(x, `has role ${JSON.stringify(x.role)}, which is not the role a ${x.kind} session runs`);
  for (const f of ['product', 'signin', 'config_dir']) if (typeof x[f] !== 'string' || !x[f]) bad(x, `has a ${f} that is not a name`);
  if (!(x.lead === null || typeof x.lead === 'string')) bad(x, 'has a lead that is not a name');
  if (!Number.isInteger(x.pgid) || x.pgid <= 1) bad(x, 'has no process group');
  if (typeof x.card !== 'string' || !x.card) bad(x, 'has no card (every session the runner starts has one)');
  if (!Array.isArray(x.bundle_files)) bad(x, 'has bundle_files that are not a list');
  if (x.uid !== uid) bad(x, 'names a Mac user other than the owner\'s');
  const wrong = workerOutboxProblem(x.outbox, x.id, x.outbox_open === true ? { root: outboxRoot, realpath } : {}); if (wrong) bad(x, `has an outbox that ${wrong}`);
  if (x.outbox !== join(outboxRoot, 'worker', x.id)) bad(x, 'has an outbox that is not inside the outbox root');
  if ('request' in x) bad(x, 'names a read-only request, which the runner never starts');
  for (const f of ['outbox_open', 'stop_requested']) if (typeof x[f] !== 'boolean') bad(x, `has no ${f}`);
  for (const f of ['alive', 'ended']) if (f in x && typeof x[f] !== 'boolean') bad(x, `has ${f} that is not true or false`);
  if ('last_write_at' in x && !Number.isFinite(x.last_write_at)) bad(x, 'has last_write_at that is not a time in ms');
}

/**
 * The worker runner's status, checked whole, or a throw. `uid` is the owner's user (who runs the runner). `stat` and
 * `open` let a test stand in for the folder and the file.
 * → { sessions, requests }
 */
export function readOwnerStatus({ file, now, uid, outboxRoot, realpath, stat = lstatSync, open = openRead }) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('the worker runner\'s status file is not a full path');
  if (!Number.isFinite(now)) throw new Error('the clock gave no time, so the worker runner\'s status can\'t be dated');
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the owner\'s uid is not known, so the worker runner\'s status can\'t be checked');
  if (typeof outboxRoot !== 'string' || !isAbsolute(outboxRoot)) throw new Error('the outbox root is not known, so the worker runner\'s outboxes can\'t be checked');
  let ds; try { ds = stat(dirname(file)); } catch { throw new Error('the worker runner\'s folder is missing'); }
  plainOwned(ds, uid, 'folder'); if (!ds.isDirectory()) throw new Error('the worker runner\'s folder is not a folder');
  const { st, text } = open(file);
  plainOwned(st, uid, 'status');
  if (!st.isFile() || st.nlink !== 1) throw new Error('the worker runner\'s status is not a plain file of its own');
  if (typeof text !== 'string') throw new Error(`the worker runner's status is ${st.size} bytes, more than the runner writes`);
  let s; try { s = JSON.parse(text); } catch { throw new Error('the worker runner\'s status can\'t be read'); }
  const at = Date.parse(s?.written_at ?? '');
  if (!Number.isFinite(at) || !Array.isArray(s.sessions) || !s.requests || typeof s.requests !== 'object' || Array.isArray(s.requests)) throw new Error('the worker runner\'s status is not what the runner writes');
  if (now - at > STATUS_STALE_MS) throw new Error(`the worker runner's status is ${Math.round((now - at) / 60_000)} minutes old; the runner may be stopped`);
  if (at - now > CLOCK_SKEW_MS) throw new Error('the worker runner\'s status is dated in the future; a clock is wrong');
  // One entry not of the runner's shape makes the whole answer "not known": never the entries that could be read.
  const ids = new Set();
  for (const x of s.sessions) { checkSession(x, { uid, outboxRoot, realpath }); if (ids.has(x.id)) bad(x, 'is listed twice'); ids.add(x.id); }
  for (const [id, r] of Object.entries(s.requests)) if (!REQUEST_ID.test(id) || !REQUEST_STATES.includes(r?.state)) throw new Error('a request in the worker runner\'s status is not what the runner writes');
  // A status that contradicts itself is not known: never a session that silently drops off the board or out of intake.
  for (const x of s.sessions) {
    const state = Object.hasOwn(s.requests, x.id) ? s.requests[x.id].state : undefined;
    if (live(x)) {
      if (state !== 'started') bad(x, state === undefined ? 'is running with no launch request entry' : `is running under a launch request marked ${state}`);
      if (!x.outbox_open) bad(x, 'is running with its outbox marked closed');
    } else if (state !== 'started' && state !== 'stopped') bad(x, state === undefined ? 'is listed with no launch request entry' : `is listed under a launch request marked ${state}`);
  }
  const answers = Object.hasOwn(s, 'answers') ? s.answers : {};
  if (answers === null) throw new Error('the worker runner\'s answers are not what the runner writes');
  if (typeof answers !== 'object' || Array.isArray(answers)) throw new Error('the worker runner\'s answers are not what the runner writes');
  for (const [k, a] of Object.entries(answers)) {
    if (!ANSWER_KEY.test(k) || !a || typeof a !== 'object' || typeof a.ok !== 'boolean' || (a.ok === false && (typeof a.reason !== 'string' || !a.reason))) throw new Error('an answer in the worker runner\'s status is not what the runner writes');
  }
  return { sessions: s.sessions, requests: s.requests, answers };
}

const pick = (x, fields) => Object.fromEntries(fields.map((f) => [f, x[f]]));
const requestOf = (s, id) => (Object.hasOwn(s.requests, id) ? s.requests[id] : undefined);

/**
 * The runner's part of the sync ports, read fresh on every call. `sessions` and `outboxSessions` are the worker runner's
 * share only: the wiring merges them with every other kind before the tick sees them (owner-ports.mjs). `stopSession` may
 * write a stop request (`writeRequest(name, text)`, made exclusive by the caller) and never waits for it. `holds({ card,
 * sessionId })` is the Record's answer: is that card still claimed or running under that session's claim? A card it can't
 * read is a throw, never false; any answer but true or false makes the board "not known".
 */
export function ownerSyncPorts({ statusFile, uid, outboxRoot, clock = Date.now, stat, open, realpath, writeRequest, holds }) {
  if (typeof holds !== 'function') throw new Error('the board needs the Record\'s holds({ card, sessionId })');
  const held = (x) => {
    const h = holds({ card: x.card, sessionId: x.id });
    if (typeof h !== 'boolean') throw new Error(`the Record can't tell whether card ${x.card} is still held by session ${x.id}`);
    return h;
  };
  const status = () => readOwnerStatus({ file: statusFile, now: clock(), uid, outboxRoot, realpath, stat, open });
  return {
    sessions: () => status().sessions.filter(live).map((x) => pick(x, SESSION_FIELDS)),
    // The sessions meant to run: every live one (a stop that failed leaves it running, so it stays, r1 audit m4). One that
    // is no longer live leaves when it was stopped on request; one that ended without a stop request stays only while its
    // card's claim is still its own, so the outage step sees each death once, not on every pass after.
    board: () => { const s = status();
      return s.sessions.filter((x) => live(x) || (!x.stop_requested && held(x))).map((x) => {
      const row = { id: x.id, card: x.card };
      if ('alive' in x) row.alive = x.alive;
      if ('ended' in x) row.ended = x.ended;
      if ('last_write_at' in x) row.lastWriteAt = x.last_write_at;
      return row;
    }); },
    outboxSessions: () => status().sessions.filter((x) => x.outbox_open).map((x) => ({ sessionId: x.id, role: x.role, outbox: x.outbox, uid: x.uid, card: x.card, product: x.product })),
    probe: (session) => {
      const x = status().sessions.find((s) => s.id === session?.id);
      if (!x) throw new Error(`session ${session?.id} is not in the worker runner's status`);
      const z = x.size;
      const full = z && typeof z === 'object' && (z.tokens === null || Number.isFinite(z.tokens)) && Number.isInteger(z.compactions)
        && typeof z.turnEnded === 'boolean' && (z.endedAt === null || Number.isFinite(z.endedAt)) && Array.isArray(z.openTools);
      if (!full) throw new Error(`session ${x.id} has no full size in the worker runner's status`);
      if (!ACTIVITY_STATES.includes(x.activity?.state)) throw new Error(`session ${x.id} has no activity state the tracker gives in the worker runner's status`);
      return { size: pick(z, SIZE_FIELDS), activity: { state: x.activity.state } };
    },
    stopSession: (sessionId) => {
      if (!REQUEST_ID.test(sessionId ?? '')) return false;
      const s = status();
      const r = requestOf(s, sessionId);
      // True only when the launch request is used up and every session listed under the id is known gone (alive false):
      // a request the runner has not yet seen (no entry) is never true, as it could still start a second session.
      if (r && USED_UP.includes(r.state) && !s.sessions.some((x) => x.id === sessionId && x.alive !== false)) return true;
      writeRequest(`stop-${sessionId}.json`, `${JSON.stringify({ stop: sessionId })}\n`);
      return false;
    },
  };
}

/** The Dispatcher's write of one request file: exclusive, so a second ask for the same thing is the same file. */
export function requestWriter(requestsDir, write = writeFileSync) {
  return (name, text) => {
    try { write(join(requestsDir, name), text, { flag: 'wx', mode: 0o644 }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  };
}

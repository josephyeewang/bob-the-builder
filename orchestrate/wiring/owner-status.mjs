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
// what it must be (outbox, uid, role, kind), so a forged file can at worst lie about liveness, never widen intake.
//
// The status file (the runner writes it; this is the only reader):
//   { written_at: ISO, sessions: [SESSION], requests: { <sessionId>: { state } } }
//   SESSION: { id, product, kind, card, lead, role, pgid, signin, config_dir, bundle_files, outbox, uid, outbox_open,
//              stop_requested, alive?, ended?, last_write_at?, size?, activity? }
//   - kind: one of RUNNER_KINDS; role: one of RUNNER_ROLES; outbox <outboxRoot>/worker/<id>; uid the owner's.
//   - outbox_open: true while the outbox may hold a file intake has not taken or told (listed after the end until then).
//   - stop_requested: true once the runner acted on a stop request for it. A session that ends without one stays on
//     the board (a crash is for the outage step to see); one stopped on request leaves it.
//   - requests[id].state: 'waiting' (seen, not yet acted on), 'started', 'refused', 'stopped' (started and since stopped)
//     or 'cancelled' (a stop request reached it first). A launch request the runner has not seen has no entry. The runner
//     keeps a used-up entry until the claim lapses, and marks a session that ends on its own 'stopped'.
// The runner's probe answers only for its own sessions: the wiring routes each session to its own kind's probe.
// The shared reader with review-runner's readReviewStatus is a later extraction that keeps behaviour (L739, L248).

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATUS_STALE_MS } from './owner-ports.mjs';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';
import { workerOutboxProblem } from '../modules/M4-workshop/git/session-outbox.mjs';
import { AI_ROLES } from '../shared/record.mjs';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';

export const REQUEST_STATES = Object.freeze(['waiting', 'started', 'refused', 'stopped', 'cancelled']);
/** The states in which a launch request is used up: it can never start a session from now on. */
export const USED_UP = Object.freeze(['refused', 'stopped', 'cancelled']);
/** gate.mjs's kinds (its header) less those the wiring takes from their own status (owner-ports.mjs: lead, readonly, review, front_door). */
export const RUNNER_KINDS = Object.freeze(['editing', 'undo', 'script', 'audit', 'merge', 'undo_merge']);
/** The roles the runner starts: every AI role but the Lead's and the review roles'. */
export const RUNNER_ROLES = Object.freeze(AI_ROLES.filter((r) => r !== 'lead' && !REVIEW_ROLES.includes(r)));
/** How far ahead of this clock a status may be dated: a small clock difference, not the stale window. */
export const CLOCK_SKEW_MS = 30_000;
const SESSION_FIELDS = Object.freeze(['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
const SIZE_FIELDS = Object.freeze(['tokens', 'compactions', 'turnEnded', 'endedAt', 'openTools']);

const plainOwned = (st, uid, what) => {
  if (st.isSymbolicLink()) throw new Error(`the worker runner's ${what} is a link`);
  if (st.uid !== uid) throw new Error(`the worker runner's ${what} is not owned by the owner's user`);
  if (st.mode & 0o022) throw new Error(`the worker runner's ${what} can be written by others`);
};

/** Open the file once, never through a link, and check and read that same open file (no gap between check and read). */
export function openRead(file) {
  let fd; try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { throw new Error(e?.code === 'ELOOP' ? 'the worker runner\'s status is a link' : 'the worker runner\'s status is missing'); }
  try { return { st: fstatSync(fd), text: readFileSync(fd, 'utf8') }; } finally { closeSync(fd); }
}

const bad = (x, why) => { throw new Error(`session ${x.id} in the worker runner's status ${why}`); };
function checkSession(x, { uid, outboxRoot, realpath }) {
  if (!x || typeof x !== 'object' || !REQUEST_ID.test(x.id ?? '')) throw new Error('a session in the worker runner\'s status is not what the runner writes');
  for (const f of SESSION_FIELDS) if (x[f] === undefined) bad(x, `has no ${f}`);
  if (!RUNNER_KINDS.includes(x.kind)) bad(x, `has kind ${JSON.stringify(x.kind)}, which the runner does not start`);
  if (!RUNNER_ROLES.includes(x.role)) bad(x, `has role ${JSON.stringify(x.role)}, which the runner does not start`);
  if (!Number.isInteger(x.pgid) || x.pgid <= 1) bad(x, 'has no process group');
  if (!(x.card === null || typeof x.card === 'string')) bad(x, 'has a card that is not a card id');
  if (!Array.isArray(x.bundle_files)) bad(x, 'has bundle_files that are not a list');
  if (x.uid !== uid) bad(x, 'names a Mac user other than the owner\'s');
  const wrong = workerOutboxProblem(x.outbox, x.id, { root: outboxRoot, realpath }); if (wrong) bad(x, `has an outbox that ${wrong}`);
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
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the owner\'s uid is not known, so the worker runner\'s status can\'t be checked');
  let ds; try { ds = stat(dirname(file)); } catch { throw new Error('the worker runner\'s folder is missing'); }
  plainOwned(ds, uid, 'folder'); if (!ds.isDirectory()) throw new Error('the worker runner\'s folder is not a folder');
  const { st, text } = open(file);
  plainOwned(st, uid, 'status');
  if (!st.isFile() || st.nlink !== 1) throw new Error('the worker runner\'s status is not a plain file of its own');
  let s; try { s = JSON.parse(text); } catch { throw new Error('the worker runner\'s status can\'t be read'); }
  const at = Date.parse(s?.written_at ?? '');
  if (!Number.isFinite(at) || !Array.isArray(s.sessions) || !s.requests || typeof s.requests !== 'object' || Array.isArray(s.requests)) throw new Error('the worker runner\'s status is not what the runner writes');
  if (now - at > STATUS_STALE_MS) throw new Error(`the worker runner's status is ${Math.round((now - at) / 60_000)} minutes old; the runner may be stopped`);
  if (at - now > CLOCK_SKEW_MS) throw new Error('the worker runner\'s status is dated in the future; a clock is wrong');
  // One entry not of the runner's shape makes the whole answer "not known": never the entries that could be read.
  const ids = new Set();
  for (const x of s.sessions) { checkSession(x, { uid, outboxRoot, realpath }); if (ids.has(x.id)) bad(x, 'is listed twice'); ids.add(x.id); }
  for (const [id, r] of Object.entries(s.requests)) if (!REQUEST_ID.test(id) || !REQUEST_STATES.includes(r?.state)) throw new Error('a request in the worker runner\'s status is not what the runner writes');
  return { sessions: s.sessions, requests: s.requests };
}

const pick = (x, fields) => Object.fromEntries(fields.map((f) => [f, x[f]]));
// Running: its process group is known to be there, or nothing says it is gone or ended.
const live = (x) => x.alive === true || (x.alive !== false && x.ended !== true);

/**
 * The runner's part of the sync ports, read fresh on every call. `sessions` and `outboxSessions` are the worker runner's
 * share only: the wiring merges them with every other kind before the tick sees them (owner-ports.mjs). `stopSession` may
 * write a stop request (`writeRequest(name, text)`, made exclusive by the caller) and never waits for it.
 */
export function ownerSyncPorts({ statusFile, uid, outboxRoot, clock = Date.now, stat, open, realpath, writeRequest }) {
  const status = () => readOwnerStatus({ file: statusFile, now: clock(), uid, outboxRoot, realpath, stat, open });
  return {
    sessions: () => status().sessions.filter(live).map((x) => pick(x, SESSION_FIELDS)),
    // The sessions meant to run: started and never stopped on request (an end without one is the outage step's to see),
    // and not replaced: an ended session whose card now runs another session has left the board.
    board: () => { const s = status(); const runs = new Set(s.sessions.filter(live).map((x) => x.card).filter((c) => c !== null));
      return s.sessions.filter((x) => !x.stop_requested && ['started', 'stopped'].includes(s.requests[x.id]?.state) && (live(x) || !runs.has(x.card))).map((x) => {
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
      const full = z && typeof z === 'object' && Number.isFinite(z.tokens) && Number.isInteger(z.compactions)
        && typeof z.turnEnded === 'boolean' && (z.endedAt === null || Number.isFinite(z.endedAt)) && Array.isArray(z.openTools);
      if (!full) throw new Error(`session ${x.id} has no full size in the worker runner's status`);
      if (typeof x.activity?.state !== 'string') throw new Error(`session ${x.id} has no activity in the worker runner's status`);
      return { size: pick(z, SIZE_FIELDS), activity: { state: x.activity.state } };
    },
    stopSession: (sessionId) => {
      if (!REQUEST_ID.test(sessionId ?? '')) return false;
      const s = status();
      const r = s.requests[sessionId];
      // True only when the launch request is used up and nothing under the id runs: a request the runner has not yet seen
      // (no entry) is never true, as it could still start a second session for the card.
      if (r && USED_UP.includes(r.state) && !s.sessions.some((x) => x.id === sessionId && live(x))) return true;
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

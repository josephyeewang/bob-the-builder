// Part C, runner step 1 (L741, L747): the Dispatcher's side of the worker runner's status file, and the sync ports built
// on it (owner-ports.mjs fixes their shape). Nothing here is wired yet: owner-ports.mjs still hands out refusing ports.
//
// The runner (a LaunchAgent of the owner's user) writes one status file. This module reads it as the orchestrate user and
// trusts it only when the file and its folder are the owner's, plain, written by no one else, of the runner's shape and
// fresh (STATUS_STALE_MS). Anything short of that throws: "not known", never an empty or partial answer.
//
// The status file (the runner writes it; this is the only reader):
//   { written_at: ISO, sessions: [SESSION], requests: { <sessionId>: { state } } }
//   SESSION: { id, product, kind, card, lead, role, pgid, signin, config_dir, bundle_files, outbox, uid, alive?, ended?,
//              last_write_at?, size?, activity?, request?, outbox_open }
//   - outbox_open: true while the outbox may hold a file intake has not taken or told (the session stays listed after it
//     ends until then).
//   - requests[id].state: 'waiting' (seen, not yet acted on), 'started', 'refused', 'stopped' (started and since stopped)
//     or 'cancelled' (a stop request reached it first). A launch request the runner has not seen has no entry.
// The shared reader with review-runner's readReviewStatus is a later extraction that keeps behaviour (L739, L248).

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATUS_STALE_MS } from './owner-ports.mjs';
import { REQUEST_ID } from '../modules/M4-workshop/launcher/review-runner.mjs';

export const REQUEST_STATES = Object.freeze(['waiting', 'started', 'refused', 'stopped', 'cancelled']);
/** The states in which a launch request is used up: it can never start a session from now on. */
export const USED_UP = Object.freeze(['refused', 'stopped', 'cancelled']);
const SESSION_FIELDS = Object.freeze(['id', 'product', 'kind', 'card', 'lead', 'role', 'pgid', 'signin', 'config_dir', 'bundle_files']);
const SIZE_FIELDS = Object.freeze(['tokens', 'compactions', 'turnEnded', 'endedAt', 'openTools']);

const plainOwned = (st, uid, what) => {
  if (st.isSymbolicLink()) throw new Error(`the worker runner's ${what} is a link`);
  if (st.uid !== uid) throw new Error(`the worker runner's ${what} is not owned by the owner's user`);
  if (st.mode & 0o022) throw new Error(`the worker runner's ${what} can be written by others`);
};

/**
 * The worker runner's status, checked whole, or a throw. `uid` is the owner's user (who runs the runner); `stat` lets a
 * test stand in for the file's owner. → { sessions, requests }
 */
export function readOwnerStatus({ file, now, uid, stat = lstatSync, read = (f) => readFileSync(f, 'utf8') }) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error('the owner\'s uid is not known, so the worker runner\'s status can\'t be checked');
  let ds; try { ds = stat(dirname(file)); } catch { throw new Error('the worker runner\'s folder is missing'); }
  plainOwned(ds, uid, 'folder'); if (!ds.isDirectory()) throw new Error('the worker runner\'s folder is not a folder');
  let st; try { st = stat(file); } catch { throw new Error('the worker runner\'s status is missing'); }
  plainOwned(st, uid, 'status'); if (!st.isFile()) throw new Error('the worker runner\'s status is not a plain file');
  let s; try { s = JSON.parse(read(file)); } catch { throw new Error('the worker runner\'s status can\'t be read'); }
  const at = Date.parse(s?.written_at ?? '');
  if (!Number.isFinite(at) || !Array.isArray(s.sessions) || !s.requests || typeof s.requests !== 'object' || Array.isArray(s.requests)) throw new Error('the worker runner\'s status is not what the runner writes');
  if (now - at > STATUS_STALE_MS) throw new Error(`the worker runner's status is ${Math.round((now - at) / 60_000)} minutes old; the runner may be stopped`);
  if (at - now > STATUS_STALE_MS) throw new Error('the worker runner\'s status is dated in the future; a clock is wrong');
  for (const x of s.sessions) {
    // One entry not of the runner's shape makes the whole answer "not known": never the entries that could be read.
    if (!x || typeof x !== 'object' || !REQUEST_ID.test(x.id ?? '') || typeof x.outbox_open !== 'boolean') throw new Error('a session in the worker runner\'s status is not what the runner writes');
    for (const f of SESSION_FIELDS) if (!(f in x)) throw new Error(`session ${x.id} in the worker runner's status has no ${f}`);
  }
  for (const [id, r] of Object.entries(s.requests)) if (!REQUEST_ID.test(id) || !REQUEST_STATES.includes(r?.state)) throw new Error('a request in the worker runner\'s status is not what the runner writes');
  return { sessions: s.sessions, requests: s.requests };
}

const pick = (x, fields) => Object.fromEntries(fields.map((f) => [f, x[f]]));
const live = (x) => x.ended !== true && x.alive !== false;

/**
 * The runner's part of the sync ports, read fresh on every call. `sessions` and `outboxSessions` are the worker runner's
 * share only: the wiring merges them with every other kind before the tick sees them (owner-ports.mjs). `stopSession` may
 * write a stop request (`writeRequest(name, text)`, made exclusive by the caller) and never waits for it.
 */
export function ownerSyncPorts({ statusFile, uid, clock = Date.now, stat, read, writeRequest }) {
  const status = () => readOwnerStatus({ file: statusFile, now: clock(), uid, stat, read });
  return {
    sessions: () => status().sessions.filter(live).map((x) => pick(x, SESSION_FIELDS)),
    board: () => status().sessions.map((x) => {
      const row = { id: x.id, card: x.card };
      if (typeof x.alive === 'boolean') row.alive = x.alive;
      if (typeof x.ended === 'boolean') row.ended = x.ended;
      if (Number.isFinite(x.last_write_at)) row.lastWriteAt = x.last_write_at;
      return row;
    }),
    outboxSessions: () => status().sessions.filter((x) => x.outbox_open).map((x) => {
      const row = { sessionId: x.id, role: x.role, outbox: x.outbox, uid: x.uid, card: x.card, product: x.product };
      if (typeof x.request === 'string' && x.request.length > 0) row.request = x.request;
      return row;
    }),
    probe: (session) => {
      const x = status().sessions.find((s) => s.id === session?.id);
      if (!x) throw new Error(`session ${session?.id} is not in the worker runner's status`);
      const size = x.size;
      if (!size || typeof size !== 'object' || !SIZE_FIELDS.every((f) => f in size) || !Array.isArray(size.openTools)) throw new Error(`session ${x.id} has no full size in the worker runner's status`);
      if (typeof x.activity?.state !== 'string') throw new Error(`session ${x.id} has no activity in the worker runner's status`);
      return { size: pick(size, SIZE_FIELDS), activity: { state: x.activity.state } };
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

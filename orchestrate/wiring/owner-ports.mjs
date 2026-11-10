// Part C's interface (R-0b-162 C, L248, L741): the ports the Dispatcher reaches only through the owner-side worker runner.
// This file only fixes their shape. Each answers "not wired yet" until the runner is built behind it. Lane 2's phone ports
// build against it, so a change of shape needs a lead ruling.
//
// The Dispatcher (the orchestrate user) never starts, reads or stops a worker itself, because workers run as the owner's
// user. It writes a request into the runner's requests folder. The runner, a LaunchAgent of the owner's user, writes one
// status file. Requests trust nothing, and the runner stops only what it started.
//
// Two kinds of port:
// - A sync port reads status files only and never waits on the runner. If a file it needs is older than STATUS_STALE_MS,
//   or can't be read, the answer is "not known", which is a throw (the tick's step fails and the owner is told), never an
//   empty or partial answer.
// - An async port writes one request and waits for the runner's answer. The time limit is the tick's (pass.mjs guarded(),
//   portDeadlineMs or saveDeadlineMs, which the tick may override); the port sets none of its own except where noted.
//   `{ ok: false, reason }` means the outcome is known and nothing (more) happened. A port never answers ok: false while
//   the outcome is unknown: it keeps waiting and lets the tick's limit answer, because pass.mjs reads only that limit's
//   answer as "it may still start" (a launch that answers its own time-out could put a card back to ready while a session
//   may be starting). This holds whether or not pass.mjs also reads timedOut. The stub below is the one exception to "never throws": it refuses by throwing, as every unwired port does.

import { PORT_DEADLINE_MS, SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { refusing } from './not-wired.mjs';

export const STATUS_STALE_MS = 180_000;   // L248: a status file older than 3 minutes is "not known", and told

const sync = (inp, out, notKnown) => Object.freeze({ sync: true, in: inp, out, notKnown, deadlineMs: null });
const ask = (inp, out, fails, deadlineMs) => Object.freeze({ sync: false, in: inp, out, fails, deadlineMs });
const NO = 'throws (a status file is stale or unreadable)';
const SESSION = '{ id, product, kind, card, lead, role, pgid, signin, config_dir, bundle_files }';

/** Each owner-side port: what goes in, what comes out, how a failure is answered, and its default time limit. */
export const OWNER_PORTS = Object.freeze({
  sessions: sync('()', `[${SESSION}]: every session running Mac-wide (pass.mjs). The wiring merges the runner's worker sessions with every other kind (lead, readonly, review, front_door) from their own status; the start caps count from it`,
    `${NO}, if any one source can't be read: never the sources it could read; [] only when every fresh source lists none`),
  probe: sync(`(session)`, '{ size: { tokens, compactions, turnEnded, endedAt, openTools: [ids] }, activity: { state } }: size is transcript.mjs readSize, state the activity tracker\'s (exited, blocked, waiting_input, active, ...)',
    'throws; the stop step reads that as "not at a safe point" (the late hard stop still applies). Never a partial size'),
  board: sync('()', '[{ id, card, alive, ended, lastWriteAt }]: the sessions meant to run (the outage step); lastWriteAt is epoch ms. An alive or ended the runner does not know is left out, never false',
    `${NO}; the outage step fails and is told`),
  outboxSessions: sync('()', '[{ sessionId, role, outbox, uid, card, product, request? }]: each running worker\'s outbox, as its launch named it; uid is the Mac user that must own the outbox\'s files',
    `${NO}; intake fails and is told`),
  stopSession: sync('(sessionId)', 'true only when everything started under that id is stopped, or nothing ran under it',
    'false or a throw: the claim stays, and the owner is told once a day (M9 lapseClaims)'),
  launch: ask('({ card, kind, product, sessionId })',
    '{ ok: true, sessionId, pid, pidStart, pgid, head, outbox, signin, configDir, copy }: the session started under the claimed id, in its own copy',
    '{ ok: false, reason }: nothing was started (the claim is given back). Unknown: no answer, so the tick\'s limit answers and the card stays claimed', PORT_DEADLINE_MS),
  stopGroup: ask('(session): works from { id, pgid } alone (pass.mjs also stops a session it just launched, not yet in any status)', '{ ok: true, how }: the session\'s process group is gone',
    '{ ok: false, reason }: it may still run', PORT_DEADLINE_MS),
  saveWork: ask('(session)', '{ ok: true }: the work is pushed to the card branch (M4 save-work, inside the worker\'s lock-down)', '{ ok: false, reason }: unsaved, and told', SAVE_DEADLINE_MS),
  pauseLead: ask('({ product })', 'resolves: the product\'s Lead was asked to wrap up (lead-restart\'s WRAP flow)',
    'throws (rejects): pass.mjs ignores what it resolves to, so a refusal answered as { ok: false } would read as asked', PORT_DEADLINE_MS),
});

/**
 * The cleanup group's owner-side members. The copies are the owner's user's, so cleanup reaches them through the runner.
 * cleanupCopy puts no time limit on saveWork, so that port keeps its own.
 */
export const OWNER_CLEANUP_PORTS = Object.freeze({
  copiesRoot: Object.freeze({ sync: true, in: 'a value, read on use', out: 'the full path of the folder of worker copies (<copiesRoot>/<card>), fixed at start; the orchestrate user must be able to list and read it (cleanupPass reads it directly)',
    notKnown: 'the read throws: cleanupPass would read a missing or unreadable folder as nothing to do', deadlineMs: null }),
  saveWork: ask('({ clone, mirror, card, branch, outbox })', '{ ok: true, bundle }: a fresh bundle file inside outbox',
    '{ ok: false, reason }, or { ok: false, timedOut: true, reason } at its own limit', SAVE_DEADLINE_MS),
});

/**
 * Where a worker session's facts live (L744, correcting L739): the launch doc holds what writeLaunch (M11 pass.mjs) writes;
 * the push script's inputs (branch, outbox, attempt) are in the `session` record the Dispatcher writes at launch (#248,
 * L589), the one source for them. Read them there; the launch doc does not gain them.
 */
export const LAUNCH_DOC_FIELDS = Object.freeze(['session_id', 'role', 'kind', 'card', 'head', 'rev', 'product', 'signin', 'config_dir', 'copy', 'launched_at']);
export const SESSION_RECORD_PUSH_FIELDS = Object.freeze(['branch', 'outbox', 'attempt']);

/**
 * The owner-side ports, given the runner's two paths: `requestsDir` (where the Dispatcher writes a request) and `statusFile`
 * (where the runner writes its status). Until the runner is built each port refuses, so behaviour stays the same:
 * worker-ports.mjs still lists them, with the same refusal.
 * @returns {{ ports: object, cleanup: object }}
 */
export function ownerPorts({ requestsDir, statusFile, clock = Date.now } = {}) {
  void requestsDir; void statusFile; void clock;
  const ports = Object.fromEntries(Object.keys(OWNER_PORTS).map((k) => [k, refusing(k)]));
  const cleanup = { saveWork: refusing('cleanup.saveWork') };
  Object.defineProperty(cleanup, 'copiesRoot', { enumerable: true, get: refusing('cleanup.copiesRoot') });
  return { ports, cleanup };
}

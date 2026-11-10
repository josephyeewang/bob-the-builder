// Part C's interface (R-0b-162 C, L248, L741): the ports the Dispatcher reaches only through the owner-side worker runner.
// This file only fixes their shape. Each answers "not wired yet" until the runner is built behind it. Lane 2's phone ports
// build against it, so a change of shape needs a lead ruling.
//
// The Dispatcher (the orchestrate user) never starts, reads or stops a worker itself, because workers run as the owner's
// user. It writes a request into the runner's requests folder. The runner, a LaunchAgent of the owner's user, writes one
// status file. Requests trust nothing, and the runner stops only what it started. probe, stopGroup and saveWork take any
// session sessions() lists (pass.mjs's stop step reaches review, audit, merge and undo sessions of a cancelled card too):
// the wiring routes each by kind to the runner that started it, never all to this one (#317 audit r1 M1, r2 n1):
//   - the worker kinds, editing, undo and script, to this runner (overnight, an editing kind gate.mjs counts, too, once
//     something starts one);
//   - review and audit to the review runner;
//   - lead, readonly, front_door, merge and undo_merge each to the runner that starts that kind.
// A kind no runner owns is never a silent ok: probe throws and stopGroup answers { ok: false, reason }. stopSession takes
// only an id: the wiring routes it by the claim's session id to the runner that received its launch request.
//
// Two kinds of port:
// - A sync port reads status files only (stopSession may also write a stop request) and never waits on the runner. If a file it needs is older than STATUS_STALE_MS,
//   or can't be read, the answer is "not known", which is a throw (the tick's step fails and the owner is told), never an
//   empty or partial answer.
// - An async port writes one request and waits for the runner's answer. The time limit is the tick's (pass.mjs guarded(),
//   portDeadlineMs or saveDeadlineMs, which the tick may override); the port sets none of its own except where noted.
//   `{ ok: false, reason }` means the outcome is known and nothing (more) happened. Except where noted (stopGroup's
//   ok: false means it may still run; cleanup.saveWork answers timedOut at its own limit; the worker runner's asks, owner-asks.mjs, stop waiting at a limit past
//   every tick limit and answer there as the tick's limit does, { ok: false, timedOut: true }), a port never answers ok: false
//   while the outcome is unknown: it keeps waiting and lets the tick's limit answer, because pass.mjs reads only that limit's
//   answer as "it may still start" (a launch that answers its own time-out could put a card back to ready while a session
//   may be starting). This holds whether or not pass.mjs also reads timedOut. An async port does not throw, except
//   pauseLead (its failure is a throw) and launch before its request is written (a throw reads as refused). The stub
//   below refuses by throwing, as every unwired port does.

import { PORT_DEADLINE_MS, SAVE_DEADLINE_MS } from '../modules/M11-dispatcher/pass.mjs';
import { refusing } from './not-wired.mjs';

export const STATUS_STALE_MS = 180_000;   // L248: a status file older than 3 minutes is "not known", and told

const sync = (inp, out, notKnown) => Object.freeze({ sync: true, in: inp, out, notKnown, deadlineMs: null });
const ask = (inp, out, fails, deadlineMs) => Object.freeze({ sync: false, in: inp, out, fails, deadlineMs });
const NO = 'throws (a status file is stale or unreadable)';
const SESSION = '{ id, product, kind, card, lead, role, pgid, signin, config_dir, bundle_files }';   // kind: one of gate.mjs's kinds, which the start caps count by

/** Each owner-side port: what goes in, what comes out, how a failure is answered, and its default time limit. */
export const OWNER_PORTS = Object.freeze({
  sessions: sync('()', `[${SESSION}]: every session running Mac-wide (pass.mjs). The wiring merges the runner's worker sessions (editing, undo, script) with every other kind gate.mjs counts (readonly, review, audit, merge, undo_merge, lead, front_door) from their own status; the start caps count from it`,
    `${NO}, if any one source can't be read: never the sources it could read; [] only when every fresh source lists none`),
  probe: sync('(session): any session sessions() lists, routed by kind', '{ size: { tokens, compactions, turnEnded, endedAt, openTools: [ids] }, activity: { state } }: size is transcript.mjs readSize, state the activity tracker\'s (exited, blocked, waiting_input, active, ...)',
    'throws; the stop step reads that as "not at a safe point" (the late hard stop still applies). Never a partial size, and a state the tracker can\'t tell is a throw, never a missing or null state (atSafePoint reads a missing state as safe)'),
  board: sync('()', '[{ id, card, alive, ended, lastWriteAt }]: the sessions meant to run (the outage step); lastWriteAt is epoch ms. An alive or ended the runner does not know is left out of that row (the field, never the row), never false',
    `${NO}; the outage step fails and is told`),
  outboxSessions: sync('()', '[{ sessionId, role, outbox, uid, card, product, request? }]: every session whose outbox may still hold a file not yet taken, Mac-wide: running, or ended until intake has taken or told every file in it (workers, Leads, read-only helpers, reviewers, auditors: a verdict is taken only after its session\'s ended record exists, and a worker\'s last files after the stop step), merged in the wiring as for sessions; outbox as its launch named it; uid is the numeric Mac user id (not a name) that must own the outbox\'s files; request (a non-empty value) is there only for a read-only request session, and narrows its hand-ins to report- files',
    `${NO}; intake fails and is told`),
  stopSession: sync('(sessionId): may write a stop request without waiting for it', 'true only when the status file shows the launch request for that id used up (started and since stopped, refused, or cancelled by this stop request); a request the runner has not yet seen is never true, and the runner refuses a launch request older than the claim timeout. It saves nothing: a session that started late, under a claim that never moved to running, leaves its work in its copy, and cleanup asks Joe about it',
    'false or a throw: the claim stays, and the owner is told once a day (M9 lapseClaims)'),
  launch: ask('({ card, kind, product, sessionId })',
    '{ ok: true, sessionId, pid, pidStart, pgid, head, base, outbox, signin, configDir, copy }: the session started under the claimed id; base (optional, 40 hex) is the commit the copy was started on (L825-2); outbox is <outboxRoot>/worker/<sessionId> and copy <copiesRoot>/<card>',
    '{ ok: false, reason }: nothing was started (the claim is given back); a throw reads the same, so throw only before the request is written. Unknown: no answer, so the tick\'s limit answers and the card stays claimed', PORT_DEADLINE_MS),
  stopGroup: ask('(session): any session sessions() lists, routed by kind to the runner that started it; it needs only { id, pgid, kind } (pass.mjs also stops a session it just launched, not yet in any status), and the rest of the session (signin, config_dir) is passed as well', '{ ok: true, how }: the session\'s process group is gone, and the runner has set stop_requested for it in a status written before it answers',
    '{ ok: false, reason }: it may still run; stop_requested stays set once the runner has acted on the stop, even though the stop failed or timed out, so a session the Dispatcher stopped is never counted as a death', PORT_DEADLINE_MS),
  saveWork: ask('(session): any session sessions() lists, routed by kind', '{ ok: true }: the work is pushed to the card branch (M4 save-work, inside the worker\'s lock-down), or the session has no work copy to save: only the kinds named here, review, audit, readonly, lead and front_door (by kind, never by role: M11 records role worker for a script card too), so a stop never reads as unsaved work. Every other kind is saved or told: editing, undo, script and overnight save, a worker kind whose copy is missing or unreadable is { ok: false, reason }, and any kind not named (merge and undo_merge included, until it is settled that they have no copy) is { ok: false, reason: no runner saves that kind }', '{ ok: false, reason }: unsaved, and told', SAVE_DEADLINE_MS),
  pauseLead: ask('({ product })', 'resolves { ok: true }: the product\'s Lead was asked to wrap up (lead-restart\'s WRAP flow). An unknown outcome is answered by the tick\'s limit and asked again next pass, so asking twice must be harmless',
    'throws (rejects): a failed pause whether or not the pass reads the answer (pass.mjs now also reads a resolved { ok: false } as failed, so either holds there; the port throws)', PORT_DEADLINE_MS),
});

/**
 * The cleanup group's owner-side members. The copies are the owner's user's, so cleanup reaches them through the runner.
 * cleanupCopy puts no time limit on saveWork, so that port keeps its own.
 */
export const OWNER_CLEANUP_PORTS = Object.freeze({
  copiesRoot: Object.freeze({ sync: true, in: 'a value, read on use', out: 'the full path of the folder of worker copies (<copiesRoot>/<card>), fixed at start. cleanupPass, as the orchestrate user, lists, reads and deletes in it directly, so setup gives orchestrate an access list of its own there (L747): list, search, read (file contents and attributes, so a copy can be hashed) and delete, inherited by every file and folder made under it; no add, no write; it deletes only after cleanupPass\'s checks (or on Joe\'s counted Yes). The runner never moves a file in from outside it, so a delete never stops partway',
    notKnown: 'the read throws, never a folder that reads as empty', deadlineMs: null }),
  saveWork: ask('({ clone, mirror, card, branch, outbox })', '{ ok: true, bundle }: a fresh bundle file inside outbox, which is orchestrate\'s private staging folder: the runner writes the bundle where orchestrate can read it, and the port (orchestrate-side) copies it into outbox',
    '{ ok: false, reason }, or { ok: false, timedOut: true, reason } at its own limit', SAVE_DEADLINE_MS),
});

/**
 * Where a worker session's facts live (L744, correcting L739): the launch doc holds what writeLaunch (M11 pass.mjs) writes;
 * the push script's inputs (branch, outbox, attempt) are in the `session` record the Dispatcher writes at launch (#248,
 * L589), the one source for them. Read them there; the launch doc does not gain them.
 */
export const LAUNCH_DOC_FIELDS = Object.freeze(['session_id', 'role', 'kind', 'card', 'head', 'base', 'rev', 'product', 'signin', 'config_dir', 'copy', 'launched_at']);
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
  // Every cleanup member refuses when read, as worker-ports.mjs's do (L745): cleanupPass reads a folder it can't use as
  // nothing to do, so a stand-in must never be readable.
  const cleanup = {};
  for (const k of Object.keys(OWNER_CLEANUP_PORTS)) Object.defineProperty(cleanup, k, { enumerable: true, get: refusing(`cleanup.${k}`) });
  return { ports, cleanup };
}

// record-names.mjs — the Record's names that M9's own tables are built from: the outbox kinds, the card kinds and the
// state models. record.mjs re-exports every one, so callers import them from there as before.
//
// WHY A FILE OF ITS OWN (L72). The test stand-in in record.mjs (memoryRecord) checks writes with M9's own tables
// (permissions.mjs, moves.mjs), and those tables are built from these names when they load. If the names stayed in
// record.mjs, record.mjs would need M9 and M9 would need record.mjs before either had loaded. This file needs nothing
// but the outbox-kind rule, which lives in M4's hook folder (that folder is copied alone, see outbox-kind.mjs) and
// needs nothing itself.

import { KIND_SHAPE, kindAmong } from '../modules/M4-workshop/hooks/outbox-kind.mjs';

// Outbox file kinds (design v4 §14.1.2 "Outbox names", lead call L2, 0b-2 round 2 R2-M9, round 3 R3-M2): the file name
// starts with the kind. M10's role-profile loader refuses a kind not listed here or not listed for that role.
//   kind → { roles, entity, mode }: `create` makes a new document with no header; `move` needs the
//   { entity, id, expectRev } header.
// Every kind is one of three things (L137, L140, L151):
//   - a record kind, with an entity. A kind stored as a report is inert: nothing acts on it unless a reader picks it up,
//     so each one says who reads it. `reader: '<file>:<fn>[, <file>:<fn>]'` names a live reader. `pending: '<module> join
//     item(s) <n>, lane <n>'` names the join item in that module's README that wires one. `latent: '<why>'` says why
//     nothing writes it today. `kept: '<why>'` (only the three kinds written before L140) says storing it is the point.
//     M9's outbox-kinds.test fails on a report kind with none of them (no kind is a black hole). A `pending` kind's
//     join item must name the kind, and no text shown to Joe for it may promise an action nothing performs (L151).
//   - not a record: `record: 'none'` with `handledBy`, the module that takes the file in itself. applyOutbox answers
//     NOT_A_RECORD for it (see notARecord below), which is neither stored nor refused.
//   - refused, `entity: null`, with `refused: '<module> join item(s) <n>, lane <n>'`, the join item that lands its
//     consumer: the text Joe is shown for it promises an action (pause, resume…) that nothing performs yet, so the
//     Record refuses it and Joe hears "Not filed" rather than a promise. It flips to a record kind only in the PR that
//     lands that consumer (L151 M-1). A kind with none of the three is refused too, but the test fails on one.
const NONE = (roles) => ({ roles, entity: null, mode: 'create', record: 'none', handledBy: 'M11-dispatcher/outbox-intake.mjs' });
export const OUTBOX_KINDS = Object.freeze(Object.fromEntries(Object.entries({
  'report-': { roles: ['worker', 'reviewer', 'scout', 'writer', 'thinking', 'script'], entity: 'report', mode: 'create',
    kept: 'a session\'s own account of its work, kept with the card for the history and for audits; nothing acts on it' },
  'report-compact-': { roles: ['worker'], entity: 'report', mode: 'create',
    kept: 'the worker\'s note at a compaction, kept for the history; nothing acts on it' },
  'state-compact-': { roles: ['front_door'], entity: 'report', mode: 'create',
    kept: 'the Front Door\'s note at a compaction, kept for the history; nothing acts on it' },
  'handoff-': { roles: ['lead', 'learning'], entity: 'handoff', mode: 'create' },
  'handin-': { roles: ['worker'], entity: 'card', mode: 'move' },   // the worker's running → in_review (0b-2 R3-M4)
  'lesson-': { roles: ['learning'], entity: 'lesson', mode: 'create' },
  'verdict-': { roles: ['reviewer', 'auditor'], entity: 'verdict', mode: 'move' },
  // Stored as an inert request document; only approvals turns it into an ask (0b-2 R3-M2), so it is never an `ask` here.
  'ask-request-': { roles: ['front_door', 'incident'], entity: 'report', mode: 'create',
    reader: 'M2-approvals/research-ask.mjs:openResearchAsks, M2-approvals/undo-flag.mjs:openUndoFlags' },
  'wish-': { roles: ['lead'], entity: 'report', mode: 'create', latent: 'no Lead prompt writes one yet; only the role lists (M10 lead profile, M4 DESIGN_PROFILES) name it' },
  // A request for a read-only session: M11's intake starts it and records the hand-in itself (L140).
  'think-': NONE(['lead']),
  'scout-': NONE(['lead']),
  'write-': NONE(['lead']),
  'roadmap-': { roles: ['lead'], entity: 'card', mode: 'move' },
  'history-': { roles: ['lead'], entity: 'report', mode: 'create', latent: 'no Lead prompt writes one yet, and M12 history.mjs answer() has no caller' },
  // Refused until their consumers land (L151 M-1). The skill says "Filed: resume X / wrap up / rotate K" and "Filed:
  // pause X / away X": stored, nothing would resume, rotate or pause anything, so the Record refuses them and Joe hears
  // "Not filed". request- waits on the push (item 7), the rotate steps (8) and the mode requests (9); state- on
  // approvals writing the product's state (item 13). Never a product write by an AI.
  'request-': { roles: ['front_door'], entity: null, mode: 'create', refused: 'M1 join items 7, 8 and 9, lane 2' },
  'state-': { roles: ['front_door'], entity: null, mode: 'create', refused: 'M1 join item 13, lane 2' },
  // Stored is the whole act ("Filed: idea X"); the Lead reads it once its input file's idea-file section is fed.
  'idea-': { roles: ['front_door', 'thinking'], entity: 'report', mode: 'create', pending: 'M3 join item 1, lane 2' },
  'check-': { roles: ['learning'], entity: 'report', mode: 'create', latent: 'its only role, learning, is NEVER_STARTED (M10 roles.mjs)' },
  'prune-': { roles: ['learning'], entity: 'report', mode: 'create', latent: 'its only role, learning, is NEVER_STARTED (M10 roles.mjs)' },
}).map(([k, v]) => [k, Object.freeze({ ...v, roles: Object.freeze(v.roles) })])));
// applyOutbox's answer for a `record: 'none'` kind: not stored, not refused, no diary line, no refusal, no alert.
// The file is handledBy's; a caller tests for it with isNotARecord, never by matching the reason text.
export const NOT_A_RECORD = 'not_a_record';
export function notARecord(kind) {
  return { ok: false, notARecord: true, reason: NOT_A_RECORD, kind, handledBy: OUTBOX_KINDS[kind]?.handledBy ?? null };
}
export const isNotARecord = (r) => r?.ok === false && r?.notARecord === true && r?.reason === NOT_A_RECORD;
export const OUTBOX_KIND_PATTERN = KIND_SHAPE;
// A session id: capped so an id made from it stays a legal file name (0b-2 audit round 6). record.mjs re-exports it.
export const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
// The one outbox file name rule: `<kind>-<id>.(md|json|txt)`, ASCII letters, digits and dashes only. The write hook
// and the M4 intake check names with the same pattern (they keep their own copies for now, L121), and M9 applies it
// before it takes a kind from a name, so a name the hook refuses (a U+2011 dash, a dot in the id) has no kind anywhere.
export const OUTBOX_NAME = /^([a-z]+)-[A-Za-z0-9-]+\.(md|json|txt)$/;
// The longest listed kind a good file name starts with (so `report-compact-x.md` is report-compact-, not report-), or
// null; a compaction note (`-compact` in its name, in any case: the reserved form, M4 outbox-kind.mjs, L121) is only
// ever a `-compact-` kind (L101). A name that fails OUTBOX_NAME has no kind. M9's outbox, the test stand-in, M4's
// intake read and M11's intake read a file's kind with this one function; the plain-files hook uses the same rule
// (kindAmong) on the kinds the launcher hands it.
export const outboxKindOf = (name) => (typeof name === 'string' && OUTBOX_NAME.test(name) ? kindAmong(name, Object.keys(OUTBOX_KINDS)) : null);

// Card kinds (0b-2 R3-M3). Set once, at create, by the creator M9's permissions name. `exact_reverse` is the undo card.
export const CARD_KINDS = Object.freeze(['ordinary', 'fix', 'exact_reverse', 'lead_daily_card', 'research_copy']);

// State models (design v3 §2.4, v4 §8 A4–A5, D8). The moves between them are M9's; the names are here.
export const STATES = Object.freeze({
  card: ['draft', 'ready', 'claimed', 'running', 'in_review', 'verified', 'approved', 'merging', 'merged', 'closed',
    'waiting', 'failed', 'cancelled', 'closed_no_answer', 'reverted'],
  ask: ['open', 'pushed', 'answered', 'consumed', 'expired', 'withdrawn'],
  session: ['preparing', 'running', 'waiting_input', 'waiting_limit', 'reporting', 'ended', 'stuck', 'retrying',
    'quarantined', 'recycling'],
  merge: ['requested', 'queued', 'catching_up', 'held', 'returned_to_builder', 'checking', 'merging', 'merged',
    'audited_ok', 'audit_flagged', 'refused'],
  product: ['light', 'active', 'away', 'paused'],
});

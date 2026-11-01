// record-names.mjs — the Record's names that M9's own tables are built from: the outbox kinds, the card kinds and the
// state models. record.mjs re-exports every one, so callers import them from there as before.
//
// WHY A FILE OF ITS OWN (L72). The test stand-in in record.mjs (memoryRecord) checks writes with M9's own tables
// (permissions.mjs, moves.mjs), and those tables are built from these names when they load. If the names stayed in
// record.mjs, record.mjs would need M9 and M9 would need record.mjs before either had loaded. This file needs nothing.

// Outbox file kinds (design v4 §14.1.2 "Outbox names", lead call L2, 0b-2 round 2 R2-M9, round 3 R3-M2): the file name
// starts with the kind. M10's role-profile loader refuses a kind not listed here or not listed for that role.
//   kind → { roles, entity, mode }: `create` makes a new document with no header; `move` needs the
//   { entity, id, expectRev } header. `entity: null` means the Store Writer has no rule for the kind yet, so
//   applyOutbox refuses it (fails closed) until the 0b-2 build gives it one.
export const OUTBOX_KINDS = Object.freeze(Object.fromEntries(Object.entries({
  'report-': { roles: ['worker', 'reviewer', 'scout', 'writer', 'thinking', 'script'], entity: 'report', mode: 'create' },
  'report-compact-': { roles: ['worker'], entity: 'report', mode: 'create' },
  'state-compact-': { roles: ['front_door'], entity: 'report', mode: 'create' },
  'handoff-': { roles: ['lead', 'learning'], entity: 'handoff', mode: 'create' },
  'handin-': { roles: ['worker'], entity: 'card', mode: 'move' },   // the worker's running → in_review (0b-2 R3-M4)
  'lesson-': { roles: ['learning'], entity: 'lesson', mode: 'create' },
  'verdict-': { roles: ['reviewer', 'auditor'], entity: 'verdict', mode: 'move' },
  // Stored as an inert request document; only approvals turns it into an ask (0b-2 R3-M2), so it is never an `ask` here.
  'ask-request-': { roles: ['front_door', 'incident'], entity: 'report', mode: 'create' },
  'wish-': { roles: ['lead'], entity: null, mode: 'create' },
  'think-': { roles: ['lead'], entity: null, mode: 'create' },
  'scout-': { roles: ['lead'], entity: null, mode: 'create' },
  'write-': { roles: ['lead'], entity: null, mode: 'create' },
  'roadmap-': { roles: ['lead'], entity: 'card', mode: 'move' },
  'history-': { roles: ['lead'], entity: null, mode: 'create' },
  'request-': { roles: ['front_door'], entity: null, mode: 'create' },
  'state-': { roles: ['front_door'], entity: null, mode: 'create' },
  'idea-': { roles: ['front_door', 'thinking'], entity: null, mode: 'create' },
  'check-': { roles: ['learning'], entity: null, mode: 'create' },
  'prune-': { roles: ['learning'], entity: null, mode: 'create' },
}).map(([k, v]) => [k, Object.freeze({ ...v, roles: Object.freeze(v.roles) })])));
export const OUTBOX_KIND_PATTERN = /^[a-z]+(-[a-z]+)*-$/;

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

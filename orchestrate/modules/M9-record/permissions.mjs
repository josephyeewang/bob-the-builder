// permissions.mjs — who may create or change which document, and which fields (0b-2 M-1, R2-M12, R3-M2, R3-M3, R3-m5).
//
// WHY. Moves alone don't protect a card: a hand-in that also clears `needs_joe` would drop the owner's step (R2-M12). So
// every write is checked twice: the move against moves.mjs, and every changed field against this table. A field not
// listed for that actor, entity and moment is refused, never silently dropped. Anything not listed is refused.
//
// Said plainly: every plain script runs as the same `orchestrate` user, so the rows between scripts catch bugs, not
// attackers. The real boundary is between the AI roles (whose tag comes from their outbox folder) and the scripts.
//
//   WRITERS[entity][actorName] = { create?: fields | '*', update?: fields | '*', kinds?: [...] }
//   actorName is a script actor, or an AI role (the part before ':' in `role:session`).
//   fieldsAllowed(entity, actor, { create, state }) → Set of fields, or '*' (any), or null (may not write at all)

import { OUTBOX_KINDS, CARD_KINDS } from '../../shared/record.mjs';

// Fields a card is created with; never changed after create (R3-m5). Plan inputs are separate below.
export const CARD_CREATE_ONLY = Object.freeze(['product', 'module', 'lane', 'kind', 'depends_on', 'what', 'fix_of', 'source', 'research_ask']);
// The go binds these (0b-5 M7). The Lead may change them only while the card is a draft; never on a fix card (R3-m2).
export const PLAN_INPUTS = Object.freeze(['files', 'done_when', 'tier', 'plan_sha256', 'main_commit']);
// Fields only the Store Writer itself sets or clears (round from fix_of, claim cleared on hand-in, wait on return).
export const WRITER_FIELDS = Object.freeze(['round']);

// Which card kinds each creator may make (R3-M3). The writer also checks a creator's evidence (an answered Undo ask,
// an open research ask) and, at draft → ready, that the card's first diary line was written by an allowed creator.
export const CARD_CREATORS = Object.freeze({
  lead: Object.freeze(['ordinary', 'lead_daily_card']),
  dispatcher: Object.freeze(['fix', 'exact_reverse', 'research_copy']),
});

const f = (...a) => Object.freeze(a.flat());
const createOnly = (fields = '*') => Object.freeze({ create: fields });
const ANY = Object.freeze({ create: '*', update: '*' });

// AI roles that hand in a report, from the one outbox list (R2-M9), so the two tables can't drift.
const reportRoles = [...new Set(Object.values(OUTBOX_KINDS).filter((k) => k.entity === 'report').flatMap((k) => k.roles))];

export const WRITERS = Object.freeze({
  card: Object.freeze({
    lead: Object.freeze({
      create: f('state', CARD_CREATE_ONLY.filter((x) => !['fix_of', 'source', 'research_ask'].includes(x)), PLAN_INPUTS, 'brief', 'desired', 'merge_requested', 'needs_joe'),
      update: f('brief', 'desired', 'merge_requested', 'needs_joe'),
      updateInDraft: PLAN_INPUTS,
      kinds: CARD_CREATORS.lead,
    }),
    dispatcher: Object.freeze({
      create: f('state', CARD_CREATE_ONLY, PLAN_INPUTS, 'brief', 'desired', 'merge_requested', 'needs_joe', 'round'),
      // claim only on a claim move, wait only into waiting, failure only into failed, summary/report_ref only on a
      // tab's hand-in: the writer checks each against the move.
      update: f('claim', 'wait', 'failure', 'summary', 'report_ref', 'needs_joe'),
      kinds: CARD_CREATORS.dispatcher,
    }),
    worker: Object.freeze({ update: f('summary', 'report_ref') }),
    workshop: Object.freeze({ update: f('head') }),
    approvals: Object.freeze({ update: f('needs_joe', 'approval_required', 'cancel_reason') }),
    merge_gate: Object.freeze({ update: f('needs_joe', 'merge_commit') }),
  }),
  // approvals is the only writer of asks and gos (L17, R3-M2); its own module checks ask kinds.
  ask: Object.freeze({ approvals: ANY }),
  go: Object.freeze({ approvals: ANY }),
  // A verdict comes only through a reviewer's or auditor's own outbox (R2-M7).
  verdict: Object.freeze({ reviewer: createOnly(), auditor: createOnly() }),
  session: Object.freeze({ dispatcher: ANY, workshop: Object.freeze({ update: '*' }) }),
  merge: Object.freeze({ merge_gate: ANY }),
  // Facts at a fixed id are read and written again with the read rev, so each writer that does so may update (L112):
  // the Sensors' readings and the Ledger's alerts (M12 facts.mjs), the Dispatcher's alert queue, notes, usage band,
  // outage and restart facts (M11), and the Workshop's push fact (M4 push.mjs). live_check only ever creates.
  // The real-code check is modules/M9-record/write-sites.test.mjs: every write site in a module must have its row here,
  // and every row here is used by a write site or says why not. Only a fact's creator may change it (L118 M1, writer.mjs).
  fact: Object.freeze({ sensors: ANY, ledger: ANY, dispatcher: ANY, workshop: ANY, live_check: createOnly() }),
  product: Object.freeze({ approvals: ANY }),
  // The Dispatcher writes the restart handoff for a Lead that stopped, and rewrites it on the next stop (M11
  // lead-restart.mjs, L112). It has no ask row: asks are approvals' alone (L17, L72).
  handoff: Object.freeze({ lead: createOnly(), learning: createOnly(), dispatcher: ANY }),
  report: Object.freeze({ ledger: createOnly(), ...Object.fromEntries(reportRoles.map((r) => [r, createOnly()])) }),
  // learning is Phase 1 (0b-1 MAT-11): listed so its row exists, but no learning session starts in 0b.
  lesson: Object.freeze({ dispatcher: createOnly(), learning: ANY }),
  launch: Object.freeze({ dispatcher: createOnly() }),
  // Create-only (L118 M2): a request asked again gets its own id (lane 2, mr-<card>-<head12>-r<n>), so no one rewrites one
  // the Merge Gate may already be reading.
  merge_request: Object.freeze({ dispatcher: createOnly() }),
});

export const actorName = (actor) => String(actor).split(':')[0];

// The fields this actor may set on this write, or null when it may not write this entity this way at all.
export function fieldsAllowed(entity, actor, { create, state } = {}) {
  const row = WRITERS[entity]?.[actorName(actor)];
  if (!row || !Object.hasOwn(WRITERS[entity], actorName(actor))) return null;
  const base = create ? row.create : row.update;
  if (base === undefined) return null;
  if (base === '*') return '*';
  const out = new Set(base);
  if (!create && state === 'draft' && row.updateInDraft) for (const x of row.updateInDraft) out.add(x);
  return out;
}

export function mayCreateKind(actor, kind) {
  return CARD_KINDS.includes(kind) && (CARD_CREATORS[actorName(actor)] ?? []).includes(kind);
}

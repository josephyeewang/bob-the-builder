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

import { OUTBOX_KINDS, CARD_KINDS } from '../../shared/record-names.mjs';

// Fields a card is created with; never changed after create (R3-m5). Plan inputs are separate below.
export const CARD_CREATE_ONLY = Object.freeze(['product', 'module', 'lane', 'kind', 'depends_on', 'what', 'fix_of', 'source', 'research_ask']);
// The go binds these (0b-5 M7). The Lead may change them only while the card is a draft; never on a fix card (R3-m2).
export const PLAN_INPUTS = Object.freeze(['files', 'done_when', 'tier', 'plan_sha256', 'main_commit']);
// Fields only the Store Writer itself sets or clears (round from fix_of, claim cleared on hand-in, wait on return).
export const WRITER_FIELDS = Object.freeze(['round']);

// A card's `attempts`: the counts that drive a decision (L74). Each key has one writer, the role that adds to it, and
// a shape. A count that is only shown or logged is never kept on the card; the diary has it.
//   reviewer_starts  how many review requests in a row failed to start a reviewer (two → the owner is asked)
//   merge_refusals   the reasons the gate refused this card's merges (the same reason twice → the owner is asked)
export const ATTEMPTS = Object.freeze({
  reviewer_starts: Object.freeze({ writer: 'dispatcher', shape: 'count' }),
  merge_refusals: Object.freeze({ writer: 'merge_gate', shape: 'reasons' }),
});

// Fact ids by family (L74): each role may create a fact only under its own families, and may change only a fact it
// created. So no role can take another's id first (the Dispatcher can't make `pr-7` before the Sensors do), and a
// gating reader can tell the writer from the id. A family ending in `-` or `.` is a prefix; any other is one exact id.
// No two roles' families may overlap (familyOverlaps, tested). A role listed here with no row in WRITERS.fact holds
// its names but can write none. `store` is the Store Writer's own (an outbox refusal), written inside M9, never by write().
// Not yet named (lead calls L74): a tab heartbeat has no family, so none counts and a tab claim lapses on the running
// limit alone; live_check has a row but no family, so it creates nothing.
export const FACT_FAMILIES = Object.freeze(Object.fromEntries(Object.entries({
  store: ['outbox-refused-'],
  sensors: ['pr-', 'usage-', 'signed-in-account', 'limit-hit-', 'network-up', 'frontdoor-reachable', 'minibase-running',
    'power-source', 'outside-no-push', 'outside-robot-merges-', 'start_gate.', 'prod-watch-', 'audit-run-',
    'undo-issue-', 'blueprint_freshness_alarm'],
  ledger: ['air-health', 'alert-', 'idea-issue-', 'push-request-', 'heartbeat-', 'signed-out-'],
  workshop: ['push.'],
  merge_gate: ['reverse-'],
  dispatcher: ['unsent-alerts', 'outage', 'rules-missing-alert', 'compactions-', 'stop-', 'host-lock-', 'pause-',
    'undo-held-', 'undo-note-', 'step-error-', 'last-full-pass', 'band-usage', 'unknown-usage-alert', 'lead-restart-',
    'phone-link', 'phone-link-', 'intake-applied-', 'intake-note', 'hold-', 'review-alert-', 'reconciled-', 'cleanup-',
    'pass-lock-note'],
  live_check: [],
}).map(([k, v]) => [k, Object.freeze(v)])));

const isPrefix = (f) => f.endsWith('-') || f.endsWith('.');
const covers = (f, id) => (isPrefix(f) ? id.startsWith(f) && id.length > f.length : id === f);

/** The role whose family holds this fact id, or null. */
export function factFamilyOf(id) {
  if (typeof id !== 'string') return null;
  for (const [role, fams] of Object.entries(FACT_FAMILIES)) if (fams.some((f) => covers(f, id))) return role;
  return null;
}

/** Pairs of families of different roles where one id could fall in both. [] when the table is sound. */
export function familyOverlaps(table = FACT_FAMILIES) {
  const out = [];
  const all = Object.entries(table).flatMap(([role, fams]) => fams.map((f) => [role, f]));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [ra, a] = all[i]; const [rb, b] = all[j];
      if (ra === rb) continue;
      const clash = a === b || (isPrefix(a) && b.startsWith(a)) || (isPrefix(b) && a.startsWith(b));
      if (clash) out.push([`${ra}:${a}`, `${rb}:${b}`]);
    }
  }
  return out;
}

/**
 * A gating reader's one test of a fact taken as proof (L74 addendum): its id is in `role`'s family (and in `family`,
 * when one is named, which must be one of `role`'s) AND `role` created it. Never one without the other, and never the
 * fact's `type` alone: any role can write any type into its own family.
 */
export function factFrom(role, entry, family) {
  if (typeof role !== 'string' || !entry || typeof entry.id !== 'string') return false;
  if (factFamilyOf(entry.id) !== role || actorName(entry.createdBy ?? '') !== role) return false;
  if (family === undefined) return true;
  return (FACT_FAMILIES[role] ?? []).includes(family) && covers(family, entry.id);
}

// Which card kinds each creator may make (R3-M3). The writer also checks a creator's evidence (an answered Undo ask,
// an open research ask) and, at draft → ready, that the card's first diary line was written by an allowed creator.
export const CARD_CREATORS = Object.freeze({
  lead: Object.freeze(['ordinary', 'lead_daily_card']),
  dispatcher: Object.freeze(['fix', 'exact_reverse', 'research_copy']),
});

const f = (...a) => Object.freeze(a.flat());
const createOnly = (fields = '*') => Object.freeze({ create: fields });
const ANY = Object.freeze({ create: '*', update: '*' });
// Create under its own families, and change only what it created (L74); the guard checks both.
const OWN_FACTS = Object.freeze({ create: '*', update: '*', own: true });

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
      // attempts: only its own keys (ATTEMPTS), checked by the guard.
      update: f('claim', 'wait', 'failure', 'summary', 'report_ref', 'needs_joe', 'attempts'),
      kinds: CARD_CREATORS.dispatcher,
    }),
    worker: Object.freeze({ update: f('summary', 'report_ref') }),
    workshop: Object.freeze({ update: f('head') }),
    approvals: Object.freeze({ update: f('needs_joe', 'approval_required', 'cancel_reason') }),
    merge_gate: Object.freeze({ update: f('needs_joe', 'merge_commit', 'attempts') }),
  }),
  // approvals is the only writer of asks and gos (L17, R3-M2); its own module checks ask kinds.
  ask: Object.freeze({ approvals: ANY }),
  go: Object.freeze({ approvals: ANY }),
  // A verdict comes only through a reviewer's or auditor's own outbox (R2-M7).
  verdict: Object.freeze({ reviewer: createOnly(), auditor: createOnly() }),
  session: Object.freeze({ dispatcher: ANY, workshop: Object.freeze({ update: '*' }) }),
  merge: Object.freeze({ merge_gate: ANY }),
  // Each under its own families (FACT_FAMILIES), changing only facts it created (L74). The workshop is worker-side:
  // nothing that gates takes a workshop fact as proof (factFrom names the one role a proof must come from).
  fact: Object.freeze({ sensors: OWN_FACTS, ledger: OWN_FACTS, workshop: OWN_FACTS, dispatcher: OWN_FACTS, merge_gate: OWN_FACTS, live_check: OWN_FACTS }),
  product: Object.freeze({ approvals: ANY }),
  handoff: Object.freeze({ lead: createOnly(), learning: createOnly() }),
  report: Object.freeze({ ledger: createOnly(), ...Object.fromEntries(reportRoles.map((r) => [r, createOnly()])) }),
  // learning is Phase 1 (0b-1 MAT-11): listed so its row exists, but no learning session starts in 0b.
  lesson: Object.freeze({ dispatcher: createOnly(), learning: ANY }),
  launch: Object.freeze({ dispatcher: createOnly() }),
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

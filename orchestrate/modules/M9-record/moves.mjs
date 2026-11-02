// moves.mjs — the complete set of legal state moves, and who may make each (0b-2 M-2, R2-M2, R2-M7, R3-M1, R3-M4).
//
// WHY. "Illegal moves are refused" can only be tested against a table nobody had to guess (spec round 1, M-2). This
// is that table. Every pair not listed is refused; the pair-walk test computes every pair from shared STATES, so a
// state added later with no moves is refused everywhere until a row is written here.
//
//   MOVES[entity][from][to] = [actors who may make it]
//   CREATE_STATES[entity] = { state: [actors] }   (a stateless entity is created by the actors permissions.mjs names)
//   moveActors(entity, from, to) → actors | null
//
// The Store Writer adds conditions on top (ready rule, verdict for the head, wait fields, reask count, one merge at a
// time); this file says only which pairs exist and whose they are.

import { STATES } from '../../shared/record-names.mjs';

const freeze = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(Object.fromEntries(Object.entries(v).map(([t, a]) => [t, Object.freeze(a)])))])));

const D = ['dispatcher'];
const A = ['approvals'];
const G = ['merge_gate'];
const W = ['workshop'];

export const MOVES = Object.freeze({
  card: freeze({
    draft: { ready: D, cancelled: A },
    ready: { claimed: D, waiting: D, cancelled: A },
    // claimed → ready: the holder's release, a lapse or a dead owner's claim broken (always with the claim cleared).
    claimed: { running: D, ready: D, cancelled: A },
    // running → in_review: a worker's hand-in through its own outbox, or the Dispatcher for a tab's accepted proposal.
    running: { in_review: ['worker', 'dispatcher'], failed: D, waiting: D, cancelled: A },
    in_review: { verified: D, failed: D, waiting: D, cancelled: A },
    // → in_review from verified or approved: a new head pushed after verification (workshop, R2-M7).
    // verified/approved → merged: only the Merge Gate's reconcile of an interrupted merge GitHub shows merged (L85 M-1 b);
    // the writer asks for this card's merged merge document at the same commit, as for every move into merged.
    verified: { in_review: W, approved: A, merging: G, merged: G, waiting: D, cancelled: A },
    // approved → waiting: an approved card whose merge is refused twice is put on the owner, and comes back to approved
    // (L116; the wait's resume: continue returns to approved).
    approved: { merging: G, merged: G, verified: A, in_review: W, waiting: D, cancelled: A },
    merging: { merged: G, verified: G, in_review: G },
    merged: { closed: D, reverted: G },
    closed: { reverted: G },
    // A wait returns only to its own return_to (checked by the writer); these are the states a return_to can name.
    waiting: { ready: D, in_review: D, verified: D, approved: D, closed_no_answer: D, cancelled: A },
  }),
  ask: freeze({
    // open → expired: an ask whose box was released lapses a second time without being shown again (0b-5 M5-2).
    open: { pushed: A, withdrawn: A, expired: A },
    // → open: the first lapse (reask_count 0 → 1) or a released question box (count unchanged), R3-M1. An answered
    // ask goes back to open only on its first lapse (the 24-hour rule), never on a release (0b-5 M5-2).
    pushed: { answered: A, expired: A, withdrawn: A, open: A },
    answered: { consumed: A, expired: A, withdrawn: A, open: A },
  }),
  session: freeze({
    preparing: { running: W, ended: W },
    running: { waiting_input: W, waiting_limit: W, reporting: W, stuck: W, recycling: W, ended: W },
    waiting_input: { running: D, stuck: D, ended: D },
    waiting_limit: { running: D, ended: D },
    reporting: { ended: D, stuck: D },
    stuck: { retrying: D, quarantined: D, ended: D },
    retrying: { running: D, stuck: D, quarantined: D },
    recycling: { ended: D },
    quarantined: { ended: D },
  }),
  merge: freeze({
    requested: { queued: G, refused: G },
    queued: { catching_up: G, held: G, checking: G, returned_to_builder: G, refused: G },
    catching_up: { queued: G, returned_to_builder: G, refused: G },
    held: { queued: G, refused: G },
    checking: { merging: G, held: G, refused: G },
    merging: { merged: G, refused: G },
    merged: { audited_ok: G, audit_flagged: G },
    // The one move out of a final merge state (L85 M-1 b): an interrupted merge GitHub shows merged at the judged head.
    // The writer asks for the Sensors pr- reading that proves it (data.fact).
    refused: { merged: G },
  }),
  product: freeze({
    light: { active: A, paused: A },
    active: { away: A, paused: A },
    away: { active: A, paused: A },
    // A paused product goes back only to the state it was paused from (its return_to), never light → active.
    paused: { light: A, active: A, away: A },
  }),
});

// Moves no write() may make: only the Store Writer's own release (by the holder), claim break and lapse make them,
// with the claim cleared. claimed → ready by a plain write would let anyone release a claim it doesn't hold.
export const INTERNAL_MOVES = Object.freeze({ card: Object.freeze({ claimed: Object.freeze(['ready']), running: Object.freeze(['ready']) }) });

// The state each entity is created in, and by whom (R2-M5). A fix card over the round cap is created in `waiting`
// by the writer itself, whatever state the Dispatcher asked for (M-8).
export const CREATE_STATES = Object.freeze({
  card: Object.freeze({ draft: Object.freeze(['lead', 'dispatcher']) }),
  ask: Object.freeze({ open: A }),
  session: Object.freeze({ preparing: D }),
  merge: Object.freeze({ requested: G }),
  // A product is created only by the seeding rule: the state its onboarding entry names (R2-M2).
  product: Object.freeze({ light: A, active: A, away: A, paused: A }),
});

export function moveActors(entity, from, to) {
  const row = Object.hasOwn(MOVES, entity) && Object.hasOwn(MOVES[entity], from) ? MOVES[entity][from] : null;
  return row && Object.hasOwn(row, to) ? row[to] : null;
}

export const STATEFUL = Object.freeze(Object.keys(STATES));

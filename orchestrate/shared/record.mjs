// record.mjs — the one interface every module uses to read and write M9 Record (the Work Store).
//
// WHY. The record holds every card, ask, claim, wait and fact for a product, and only the Store Writer
// (orchestrate/modules/M9-record/) writes it (rails A1–A5). Plain Do-plane scripts call write() under their own
// actor name; AI sessions never do — the Dispatcher hands their outbox files to applyOutbox() tagged with the
// session's role. This file fixes the call shapes and the names (actors, entities, states) so every lane uses
// the same ones. The real store plugs in through makeRecord(); a test uses memoryRecord().
//
//   const rec = makeRecord(impl);
//   rec.read('card', 'C-12')                     // → { id, doc, rev } or null
//   rec.list('card')                             // → [{ id, doc, rev }, …]
//   rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-12', expectRev: 3, doc, kind: 'claim' })
//                                                // → { ok: true, rev, seq } or { ok: false, reason }
//   rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-12' }, '/path/report-C-12.md')
//                                                // → { ok: true, … } or { ok: false, reason }
//   rec.diary({ since: 0 })                      // → diary lines, oldest first
//   rec.ready()                                  // → cards that may start now (M9's ready rule)
//   rec.overdue(now)                             // → [{ entity, id, state, since, limit }] past their time limit
//   rec.release({ card, session_id })            // the claim's holder gives the card back (claimed → ready)
//   rec.breakIfDead({ card }, probe?)            // break a claim whose owner is provably dead (G1)
//   rec.lapseClaims(now)                         // claims past their time limit lapse, each with a diary line
//
// RULES EVERY IMPLEMENTATION KEEPS. Every write is "only if unchanged since read": expectRev is the rev the caller
// read (0 to create). A mismatch is refused. Every accepted write appends exactly one diary line; a refused one
// appends none. write() and applyOutbox() never throw: any failure is { ok: false, reason }. read() of a corrupt document
// gives { id, entity, corrupt: true, reason } with no doc (never null, which means "absent"); list() leaves corrupt ones
// out, and a list that can't be read at all comes back as one such corrupt entry, so a caller never takes it for empty.
// diary() is the one call that throws when the store can't be read: its callers walk every line, and an empty answer
// would read as "nothing happened" (round 10 m2: fail closed by throwing, not by an empty list).

import { CARD_KINDS, OUTBOX_KINDS, OUTBOX_KIND_PATTERN, STATES } from './record-names.mjs';
export { CARD_KINDS, OUTBOX_KINDS, OUTBOX_KIND_PATTERN, STATES };
// The test stand-in's field and move check is M9's own (L72); guard.mjs needs only record-names.mjs, so no load loop.
import { guardWrite } from '../modules/M9-record/guard.mjs';

// Plain-script actors write under their own name; AI roles only through applyOutbox, as `<role>:<sessionId>`.
// `joe` writes nothing in 0b (the owner acts through `approvals`); it stays a name so old diary lines still parse.
export const SCRIPT_ACTORS = Object.freeze(['dispatcher', 'workshop', 'merge_gate', 'approvals', 'sensors', 'ledger',
  'live_check', 'joe']);
export const AI_ROLES = Object.freeze(['lead', 'worker', 'reviewer', 'auditor', 'incident', 'scout', 'writer',
  'front_door', 'thinking', 'learning', 'script']);

// A claim is a field on its card, set and cleared in the same write as the card's move (0b-2 R2-M6); `claim` stays
// a diary kind only.
export const ENTITIES = Object.freeze(['card', 'ask', 'go', 'verdict', 'session', 'merge', 'fact', 'product',
  'handoff', 'report', 'lesson', 'launch', 'merge_request']);

// The reviewer's fixed checklist (design I1): one line per Quality leg, each with the worst finding on it. A reviewer
// verdict missing a line is no verdict (Merge Gate refusal 5). An auditor's verdict says its Material count instead.
export const VERDICT_CHECKLIST = Object.freeze(['correct', 'well_built', 'works_for_user', 'holds_up']);
export const CHECKLIST_LEVELS = Object.freeze(['clean', 'cosmetic', 'minor', 'material']);

// Fields a document must carry on every write, checked here so a fake record refuses what the real one would.
// launch and merge_request are the Dispatcher's (D12, refusals 5 and 11); a verdict names the session and head it is
// for; a card names its module (held decisions, F3). Who may write which entity is M9's table, not this file's.
export const REQUIRED_FIELDS = Object.freeze({
  card: ['state', 'module'],
  launch: ['session_id', 'role', 'card', 'head', 'rev', 'launched_at'],
  merge_request: ['card', 'pr', 'session_id', 'head', 'rev', 'requested_at'],
  verdict: ['session_id', 'head'],
});
// A launch names a card and head only for the roles that work on one card (0b-5: a Front Door or thinking session has
// neither; with no role, all are needed). The one check both the fake and the real writer use.
export const CARD_ROLES = Object.freeze(['worker', 'reviewer', 'auditor']);
export function missingFields(entity, doc) {
  const blank = (f) => doc?.[f] === undefined || doc?.[f] === null || doc?.[f] === '';
  const need = (REQUIRED_FIELDS[entity] ?? []).filter((f) => entity !== 'launch' || !['card', 'head'].includes(f) || !doc?.role || CARD_ROLES.includes(doc.role));
  return need.filter(blank);
}

// Final states need no time limit (A4); every other state has one or a named reason, in the rules' timeouts.
// closed → reverted is the one move out of a final state (D8).
export const FINAL_STATES = Object.freeze({
  card: ['closed', 'failed', 'cancelled', 'closed_no_answer', 'reverted'],
  ask: ['consumed', 'expired', 'withdrawn'],
  session: ['ended'],
  merge: ['returned_to_builder', 'audited_ok', 'audit_flagged', 'refused'],
  product: [],
});

// "Open" cards: neither final nor merged. Derived here, never retyped (0b-1 round 2, R2-M7).
export const OPEN_CARD_STATES = Object.freeze(STATES.card.filter((s) => !FINAL_STATES.card.includes(s) && s !== 'merged'));
// The one "is it still open" test for any entity with states (0b-2 R2-M3): not final and not merged.
export function isOpen(entity, state) {
  return Object.hasOwn(STATES, entity) && STATES[entity].includes(state) && !FINAL_STATES[entity].includes(state) && state !== 'merged';
}

// The one reading of a state's time limit from the rules (0b-2 round 2, R2-M1). M9's overdue check and M10's
// validator both call it. `timeouts.<entity>.<state>` is { minutes ≥ 1, then } or { no_limit_reason, recheck_max_min? }.
//   → null for a final state; { minutes, then } | { no_limit_reason, recheck_max_min }; or undefined if the row is
//     missing or malformed (the caller treats that as corrupt rules, never as "no limit").
export function timeoutFor(rules, entity, state) {
  if (!Object.hasOwn(STATES, entity) || !STATES[entity].includes(state)) return undefined;
  if (FINAL_STATES[entity].includes(state)) return null;
  const row = rules?.timeouts?.[entity]?.[state];
  if (!row || typeof row !== 'object') return undefined;
  const whole = (v) => (typeof v === 'number' || (typeof v === 'string' && /^[1-9]\d*$/.test(v))) && Number.isInteger(Number(v)) && Number(v) >= 1 ? Number(v) : undefined;
  if (Object.hasOwn(row, 'no_limit_reason')) {
    if (Object.hasOwn(row, 'minutes') || typeof row.no_limit_reason !== 'string' || !row.no_limit_reason.trim()) return undefined;
    const recheck = row.recheck_max_min === undefined ? 1440 : whole(row.recheck_max_min);
    return recheck === undefined ? undefined : { no_limit_reason: row.no_limit_reason, recheck_max_min: recheck };
  }
  const minutes = whole(row.minutes);
  if (minutes === undefined || typeof row.then !== 'string' || !row.then) return undefined;
  return { minutes, then: row.then };
}

// A wait must say who and what it waits on, since when, and when it is next checked (A5).
// They sit in the document's `wait` field. A card's wait also says how it resumes and where to (R2-m10, R2-m1).
export const WAIT_FIELDS = Object.freeze(['who', 'what', 'since', 'next_check']);
export const WAIT_RETURN_FIELDS = Object.freeze(['resume', 'return_to']);
export const WAIT_WHO = Object.freeze(['joe', 'usage', 'dependency', 'incident', 'date']);   // `date` also needs a reason
export const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;   // capped so an id made from it stays a legal file name (0b-2 audit round 6)

export function isActor(a) {
  if (SCRIPT_ACTORS.includes(a)) return true;
  const m = /^([a-z_]+):(.+)$/s.exec(String(a));
  return !!m && AI_ROLES.includes(m[1]) && SESSION_ID.test(m[2]);   // one session-id rule, not a copy (round 7 m-3)
}

function refused(reason) { return { ok: false, reason }; }

// Wrap an implementation so bad arguments and thrown errors come back as a refusal, never an exception.
export function makeRecord(impl) {
  const errText = (e) => { try { return String(e?.message ?? e).slice(0, 300); } catch { return 'unreadable error'; } };
  const guard = (fn) => { try { const r = fn(); return r && typeof r.ok === 'boolean' ? r : refused('record gave no valid answer'); } catch (e) { return refused(`record error: ${errText(e)}`); } };
  const corrupt = (entity, id, e) => ({ id: id ?? null, entity, corrupt: true, reason: `record error: ${errText(e)}` });
  const optional = (name, fallback) => (...a) => (typeof impl[name] === 'function' ? impl[name](...a) : fallback(...a));
  return Object.freeze({
    read(entity, id) { if (!ENTITIES.includes(entity)) return null; try { return impl.read(entity, id); } catch (e) { return corrupt(entity, id, e); } },
    list(entity) { if (!ENTITIES.includes(entity)) return []; try { return impl.list(entity); } catch (e) { return [corrupt(entity, null, e)]; } },
    diary(opts = {}) { return impl.diary(opts); },
    write(w) {
      if (!w || !isActor(w.actor)) return refused(`unknown actor "${w?.actor}"`);
      if (!SCRIPT_ACTORS.includes(w.actor)) return refused('AI roles write only through their outbox');
      if (w.actor === 'joe') return refused('joe writes nothing; the owner answers through approvals');
      if (!ENTITIES.includes(w.entity)) return refused(`unknown entity "${w.entity}"`);
      if (typeof w.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(w.id) || w.id.length > 200 || /^\.+$/.test(w.id)) return refused('bad id');
      if (!Number.isInteger(w.expectRev) || w.expectRev < 0) return refused('expectRev must be the rev read (0 to create)');
      const missing = missingFields(w.entity, w.doc);
      if (missing.length) return refused(`${w.entity} is missing ${missing.join(', ')}`);
      // A launch names a session that can hand in: the outbox refuses any other session id (round 7 m-2).
      if (w.entity === 'launch' && !(typeof w.doc.session_id === 'string' && SESSION_ID.test(w.doc.session_id))) return refused('a launch needs a session_id of letters, digits and dashes, at most 128');
      return guard(() => impl.write(w));
    },
    applyOutbox(tag, file) {
      if (!tag || !AI_ROLES.includes(tag.role)) return refused(`unknown role "${tag?.role}"`);
      if (typeof tag.sessionId !== 'string' || !SESSION_ID.test(tag.sessionId)) return refused('outbox tag needs the session id');
      return guard(() => impl.applyOutbox(tag, file));
    },
    // Read-side helpers fail closed: an error is "nothing ready" and "everything we know is overdue" can't be faked,
    // so overdue() errors come back as one entry the caller alerts on.
    ready() { try { const r = optional('ready', () => [])(); return Array.isArray(r) ? r : []; } catch { return []; } },
    overdue(now) { try { return optional('overdue', () => [])(now); } catch (e) { return [{ entity: null, id: null, corrupt: true, reason: `record error: ${errText(e)}` }]; } },
    release(r) { return guard(() => optional('release', () => refused('this record has no claims'))(r)); },
    breakIfDead(r, probe) { return guard(() => optional('breakIfDead', () => refused('this record has no claims'))(r, probe)); },
    lapseClaims(now) { return guard(() => optional('lapseClaims', () => ({ ok: true, lapsed: [] }))(now)); },
  });
}

// For other modules' tests: an in-memory record that keeps the rev check, the diary, and M9's own check of who may
// set which fields and make which move (M9-record/guard.mjs, imported, not copied: L72). A stand-in looser than the
// real Record let writes pass every test that the real one refuses. What it still does not check is the rest of the
// Store Writer: the ready rule, a claim's and a wait's shape, verdicts and merges. applyOutbox records the hand-in only.
// The claim fakes are simple: ready() is every `ready` card with no claim, release() hands a claimed card back when the
// session holds it, breakIfDead() never breaks (the fake can't tell a dead owner), overdue() and lapseClaims() find none.
export function memoryRecord() {
  const docs = new Map();
  const lines = [];
  const key = (e, id) => `${e}/${id}`;
  const log = (actor, kind, entity, id, from, to, data) => {
    const line = { seq: lines.length + 1, ts: new Date().toISOString(), actor, kind, entity, id, from_state: from ?? null, to_state: to ?? null, data: data ?? null };
    lines.push(line);
    return line.seq;
  };
  return makeRecord({
    read(entity, id) { const d = docs.get(key(entity, id)); return d ? structuredClone(d) : null; },
    list(entity) { return [...docs.values()].filter((d) => d.entity === entity).map((d) => structuredClone(d)); },
    diary({ since = 0 } = {}) { return lines.filter((l) => l.seq > since).map((l) => ({ ...l })); },
    write({ actor, entity, id, expectRev, doc, kind = 'write' }) {
      const cur = docs.get(key(entity, id));
      if ((cur?.rev ?? 0) !== expectRev) return refused(`changed since read (rev ${cur?.rev ?? 0}, expected ${expectRev})`);
      const g = guardWrite({ entity, id, actor, old: cur?.doc ?? null, doc });
      if (!g.ok) return refused(g.reason);
      const rev = expectRev + 1;
      docs.set(key(entity, id), { entity, id, doc: g.doc, rev });
      const seq = log(actor, kind, entity, id, cur?.doc?.state, doc?.state);
      return { ok: true, rev, seq };
    },
    applyOutbox(tag, file) {
      const seq = log(`${tag.role}:${tag.sessionId}`, 'outbox', 'report', String(file).split('/').pop(), null, null, { card: tag.card ?? null });
      return { ok: true, seq };
    },
    ready() { return [...docs.values()].filter((d) => d.entity === 'card' && d.doc?.state === 'ready' && !d.doc.claim).map((d) => structuredClone(d)); },
    overdue() { return []; },
    release({ card, session_id } = {}) {
      const cur = docs.get(key('card', card));
      if (!cur || cur.doc?.state !== 'claimed' || cur.doc.claim?.session_id !== session_id) return refused('only the claim\'s holder may release it');
      const { claim, ...rest } = cur.doc;   // eslint-disable-line no-unused-vars
      cur.doc = { ...rest, state: 'ready' };
      cur.rev += 1;
      return { ok: true, rev: cur.rev, seq: log('dispatcher', 'claim_release', 'card', card, 'claimed', 'ready') };
    },
    breakIfDead() { return refused('the memory record never breaks a claim'); },
    lapseClaims() { return { ok: true, lapsed: [] }; },
  });
}

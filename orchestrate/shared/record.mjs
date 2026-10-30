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
//
// RULES EVERY IMPLEMENTATION KEEPS. Every write is "only if unchanged since read": expectRev is the rev the caller
// read (0 to create). A mismatch is refused. Every accepted write appends exactly one diary line; a refused one
// appends none. write() and applyOutbox() never throw: any failure is { ok: false, reason }.

// Plain-script actors write under their own name; AI roles only through applyOutbox, as `<role>:<sessionId>`.
// `joe` writes nothing in 0b (Joe acts through `approvals`); it stays a name so old diary lines still parse.
export const SCRIPT_ACTORS = Object.freeze(['dispatcher', 'workshop', 'merge_gate', 'approvals', 'sensors', 'ledger',
  'live_check', 'joe']);
export const AI_ROLES = Object.freeze(['lead', 'worker', 'reviewer', 'auditor', 'incident', 'scout', 'writer',
  'front_door', 'thinking', 'learning']);

export const ENTITIES = Object.freeze(['card', 'ask', 'go', 'verdict', 'session', 'merge', 'claim', 'fact', 'product',
  'handoff', 'report', 'lesson', 'launch', 'merge_request']);

// Fields a document must carry on every write, checked here so a fake record refuses what the real one would.
// launch and merge_request are the Dispatcher's (D12, refusals 5 and 11); a verdict names the session and head it is
// for; a card names its module (held decisions, F3). Who may write which entity is M9's table, not this file's.
export const REQUIRED_FIELDS = Object.freeze({
  card: ['state', 'module'],
  launch: ['session_id', 'role', 'card', 'head', 'rev', 'launched_at'],
  merge_request: ['card', 'pr', 'session_id', 'head', 'rev', 'requested_at'],
  verdict: ['session_id', 'head'],
});

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

// Final states need no time limit (A4); every other state has one or a named reason, in the rules' timeouts.
// closed → reverted is the one move out of a final state (D8).
export const FINAL_STATES = Object.freeze({
  card: ['closed', 'failed', 'cancelled', 'closed_no_answer', 'reverted'],
  ask: ['consumed', 'expired', 'withdrawn'],
  session: ['ended'],
  merge: ['audited_ok', 'audit_flagged', 'refused'],
  product: [],
});

// "Open" cards: neither final nor merged. Derived here, never retyped (0b-1 round 2, R2-M7).
export const OPEN_CARD_STATES = Object.freeze(STATES.card.filter((s) => !FINAL_STATES.card.includes(s) && s !== 'merged'));

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
export const WAIT_FIELDS = Object.freeze(['who', 'what', 'since', 'next_check']);

export function isActor(a) {
  if (SCRIPT_ACTORS.includes(a)) return true;
  const m = /^([a-z_]+):([A-Za-z0-9-]+)$/.exec(String(a));
  return !!m && AI_ROLES.includes(m[1]);
}

function refused(reason) { return { ok: false, reason }; }

// Wrap an implementation so bad arguments and thrown errors come back as a refusal, never an exception.
export function makeRecord(impl) {
  const guard = (fn) => { try { const r = fn(); return r && typeof r.ok === 'boolean' ? r : refused('record gave no valid answer'); } catch (e) { return refused(`record error: ${e.message}`); } };
  return Object.freeze({
    read(entity, id) { return ENTITIES.includes(entity) ? impl.read(entity, id) : null; },
    list(entity) { return ENTITIES.includes(entity) ? impl.list(entity) : []; },
    diary(opts = {}) { return impl.diary(opts); },
    write(w) {
      if (!w || !isActor(w.actor)) return refused(`unknown actor "${w?.actor}"`);
      if (!SCRIPT_ACTORS.includes(w.actor)) return refused('AI roles write only through their outbox');
      if (!ENTITIES.includes(w.entity)) return refused(`unknown entity "${w.entity}"`);
      if (typeof w.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(w.id)) return refused('bad id');
      if (!Number.isInteger(w.expectRev) || w.expectRev < 0) return refused('expectRev must be the rev read (0 to create)');
      const missing = (REQUIRED_FIELDS[w.entity] ?? []).filter((f) => w.doc?.[f] === undefined || w.doc?.[f] === null || w.doc?.[f] === '');
      if (missing.length) return refused(`${w.entity} is missing ${missing.join(', ')}`);
      return guard(() => impl.write(w));
    },
    applyOutbox(tag, file) {
      if (!tag || !AI_ROLES.includes(tag.role)) return refused(`unknown role "${tag?.role}"`);
      if (typeof tag.sessionId !== 'string' || !tag.sessionId) return refused('outbox tag needs the session id');
      return guard(() => impl.applyOutbox(tag, file));
    },
  });
}

// For other modules' tests: an in-memory record that keeps the rev check and the diary, and nothing else (no
// state moves, no who-may-change-what — those are M9's real Store Writer). applyOutbox records the hand-in only.
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
      const rev = expectRev + 1;
      docs.set(key(entity, id), { entity, id, doc: structuredClone(doc), rev });
      const seq = log(actor, kind, entity, id, cur?.doc?.state, doc?.state);
      return { ok: true, rev, seq };
    },
    applyOutbox(tag, file) {
      const seq = log(`${tag.role}:${tag.sessionId}`, 'outbox', 'report', String(file).split('/').pop(), null, null, { card: tag.card ?? null });
      return { ok: true, seq };
    },
  });
}

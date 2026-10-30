// Small record moves the Dispatcher makes, each one rev-checked write under the actor `dispatcher`.
// Every move stamps `changed_at`, which the time limits read. A wait always carries who, what,
// since and next_check (rail A5, WAIT_FIELDS).

import { WAIT_FIELDS } from '../../shared/record.mjs';

const iso = (ms) => new Date(ms).toISOString();

/** Re-reads the entry and writes `patch` over it. Returns the write's answer. */
export function move(rec, entity, id, patch, { now, kind = 'move' }) {
  const cur = rec.read(entity, id);
  if (!cur) return { ok: false, reason: `${entity} ${id} is not in the record` };
  return rec.write({ actor: 'dispatcher', entity, id, expectRev: cur.rev, doc: { ...cur.doc, ...patch, changed_at: iso(now) }, kind });
}

/** Puts a card in `waiting`, with every wait field. */
export function waitOn(rec, id, { who, what, now, nextCheckMs = 60_000, link, kind = 'wait' }) {
  const waiting = { who, what, since: iso(now), next_check: iso(now + nextCheckMs), ...(link ? { link } : {}) };
  for (const f of WAIT_FIELDS) if (!waiting[f]) return { ok: false, reason: `a wait needs ${f}` };
  return move(rec, 'card', id, { state: 'waiting', waiting }, { now, kind });
}

/** Writes a note the diary keeps (one accepted write is one diary line). */
export function note(rec, id, text, { now }) {
  const cur = rec.read('fact', id);
  return rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: { text, at: iso(now) }, kind: 'note' });
}

export const ageMs = (doc, now) => {
  const t = Date.parse(doc?.changed_at ?? '');
  return Number.isFinite(t) ? now - t : Infinity;
};

// The way a cause is marked told is `tellThen` in alerts.mjs (L47).

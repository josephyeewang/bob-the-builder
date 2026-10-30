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

export const ALERT_DEADLINE_MS = 30_000;
/**
 * The one way a cause is marked told (audit 0b-6 r5 MAT-2): `markTold` runs only after the alert was sent.
 * An alert that throws, rejects, answers false or takes longer than `ms` leaves the cause untold, so the
 * next pass tells it again. The send is not queued (the step itself tries again). Returns whether it was sent.
 * Every "told" mark in this folder is written inside a `tellThen` call: the sweep in tick.test.mjs checks it.
 */
export async function tellThen(alert, text, markTold, ms = ALERT_DEADLINE_MS) {
  let timer;
  let sent;
  try {
    const late = new Promise((ok) => { timer = setTimeout(() => ok(false), ms); });
    sent = (await Promise.race([Promise.resolve().then(() => alert(text, { queue: false })), late])) !== false;
  } catch { sent = false; } finally { clearTimeout(timer); }
  if (sent) markTold();
  return sent;
}

// Small record moves the Dispatcher makes, each one rev-checked write under the actor `dispatcher`.
// The Dispatcher writes only the fields M9 lets it write, by M9's names (L72): a wait is `wait`, a failure `failure`,
// and no move stamps a time. The time limits read the Record's own clock (`rec.meta`): when an entry reached its state,
// and when it was last written. A wait carries who, what, since, next_check, and for a card resume and return_to
// (rail A5, WAIT_FIELDS; M9 writer checkWait).

import { WAIT_FIELDS, WAIT_WHO } from '../../shared/record.mjs';

const iso = (ms) => new Date(ms).toISOString();

/** Re-reads the entry and writes `patch` over it. Returns the write's answer. */
export function move(rec, entity, id, patch, { kind = 'move' } = {}) {
  const cur = rec.read(entity, id);
  if (!cur) return { ok: false, reason: `${entity} ${id} is not in the record` };
  if (cur.corrupt) return { ok: false, reason: `${entity} ${id} can't be read: ${cur.reason}` };
  return rec.write({ actor: 'dispatcher', entity, id, expectRev: cur.rev, doc: { ...cur.doc, ...patch }, kind });
}

/**
 * Puts a card in `waiting`, with every wait field. `resume` is how the card goes on once the wait is over: 'retry'
 * starts it again from ready (the only way out of running, whose claim ends), 'continue' returns it to the state it
 * waited from. Defaults: retry from running or ready, continue otherwise; a card already waiting keeps its own.
 */
export function waitOn(rec, id, { who, what, now, nextCheckMs = 60_000, link, resume, kind = 'wait', attempts }) {
  const cur = rec.read('card', id);
  if (!cur) return { ok: false, reason: `card ${id} is not in the record` };
  if (cur.corrupt) return { ok: false, reason: `card ${id} can't be read: ${cur.reason}` };
  const from = cur.doc.state;
  // A card already waiting is re-waited (a new who or what): it keeps the way back it had (M9: a re-check keeps resume
  // and return_to).
  const again = from === 'waiting' && cur.doc.wait;
  const how = again ? cur.doc.wait.resume : resume ?? (from === 'running' || from === 'ready' ? 'retry' : 'continue');
  const back = again ? cur.doc.wait.return_to : how === 'retry' ? 'ready' : from;
  const wait = { who, what, since: iso(now), next_check: iso(now + nextCheckMs), resume: how, return_to: back, ...(link ? { link } : {}) };
  for (const f of WAIT_FIELDS) if (!wait[f]) return { ok: false, reason: `a wait needs ${f}` };
  if (!WAIT_WHO.includes(who)) return { ok: false, reason: `wait.who must be one of ${WAIT_WHO.join(', ')}` };
  // `attempts`: the Dispatcher's own counts to set in the same write (merge_asks, L110 m-1).
  const doc = { ...cur.doc, state: 'waiting', wait, ...(attempts ? { attempts: { ...(cur.doc.attempts ?? {}), ...attempts } } : {}) };
  return rec.write({ actor: 'dispatcher', entity: 'card', id, expectRev: cur.rev, doc, kind });
}

/** Writes a note the diary keeps (one accepted write is one diary line). */
export function note(rec, id, text, { now }) {
  const cur = rec.read('fact', id);
  return rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc: { text, at: iso(now) }, kind: 'note' });
}

/**
 * How long the entry has been as it is, by the Record's clock: `since: 'state'` (default) from the write that put it
 * in its state, `since: 'write'` from its last write. Unknown (absent, or a Record that can't say) is Infinity, so a
 * limit that only alerts or asks fires rather than waiting forever.
 */
export const ageMs = (rec, entity, id, now, { since = 'state' } = {}) => {
  const m = rec.meta?.(entity, id);
  const t = Date.parse((since === 'write' ? m?.ts : m?.stateSince) ?? '');
  return Number.isFinite(t) ? now - t : Infinity;
};

// The way a cause is marked told is `tellThen` in alerts.mjs (L47).

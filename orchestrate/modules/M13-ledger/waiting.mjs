// waiting.mjs — who and what each waiting item waits on, and since when, for the digest and status replies
// (R-0b-77; design v4 §8 A5, §9.2 M13 "the 'waiting on' roll-up").
//
// A waiting item is any record doc in state `waiting`, or any doc carrying a `wait` object (an ask waiting on Joe, a
// card held on a date). Its fields are the record's WAIT_FIELDS (who, what, since, next_check), read, never guessed.
// An item missing who, what or since is shown as a RECORD ERROR naming the missing fields, never as a blank line:
// a silent blank is how a stuck item hides (A5: every waiting state names who and what, and since when).

import { WAIT_FIELDS } from '../../shared/record.mjs';

export const WAITING_ENTITIES = Object.freeze(['card', 'ask', 'go', 'merge', 'claim']);
const SHOWN = ['who', 'what', 'since'];

export function waitingItems(rec, { entities = WAITING_ENTITIES } = {}) {
  const items = [];
  for (const entity of entities) {
    for (const { id, doc } of rec.list(entity)) {
      if (!doc || (doc.state !== 'waiting' && !doc.wait)) continue;
      const w = doc.wait ?? {};
      const missing = SHOWN.filter((f) => w[f] === undefined || w[f] === null || String(w[f]).trim() === '');
      const item = { entity, id };
      for (const f of WAIT_FIELDS) if (w[f] !== undefined) item[f] = w[f];
      if (missing.length) item.record_error = `record error: ${entity} ${id} is waiting with no ${missing.join(', ')}`;
      items.push(item);
    }
  }
  return items.sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
}

export function waitingLines(items) {
  return items.map((i) => i.record_error ?? `${i.entity} ${i.id}: waits on ${i.who} for ${i.what}, since ${i.since}`);
}

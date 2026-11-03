// refused-writes.mjs — a Record write the Dispatcher makes and the Store Writer refuses is told to Joe (lead call L323).
//
// WHY. A stopped session's park, a card put on Joe, a stop's own record and a review's failure count were each written
// and their answer dropped (pass.mjs moveAfterStop, tick.mjs's dead-session ask, the limit asks, merges.mjs). When the
// Store Writer refused one (L321: a tick's `now` gone more than 60 s stale), the card stayed where it was and nobody
// was told: a silent hold (L38). A fresh clock fixes that cause; this makes any other refusal of those writes loud.
//
// HOW. watchWrites(rec) gives the tick a Record whose write() notes each refusal of a WATCHED kind under its cause.
// tellRefused(), at the end of the pass, tells Joe once per cause through stillWaiting (shared/still-waiting.mjs):
// told at once, again every 24 h while each pass still has one, and cleared when a pass has none. Each of these
// writes is made again on the next pass (a park by pass.mjs reparkStopped, the asks by the next pass meeting the same
// card), so "still refused" is what the pass sees. A cause whose step did not finish is left as it is that pass: no
// answer is not "ended".
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { dropCause, tellThen } from './alerts.mjs';
import { HOLD_FACT } from './pass.mjs';

// A refused write is a hold (L38): its fact is in the Dispatcher's `hold-` family (pass.mjs HOLD_FACT; M9 permissions).
export const REFUSED_FACT = (cause) => HOLD_FACT(`write-refused-${cause}`);

// Each cause: what Joe reads, the tick steps that make its writes, and the write kinds it covers.
export const REFUSED_CAUSES = Object.freeze({
  park: { what: "a stopped session's card could not be parked", steps: ['stops'], kinds: ['park_paused', 'park_red', 'needs_split'] },
  stop_record: { what: 'a session stop could not be recorded', steps: ['stops'], kinds: ['stop_wanted', 'stop_dropped', 'stop_done', 'stop_moved'] },
  joe_wait: { what: 'a card could not be put on you', steps: ['outage', 'pass', 'limits'],
    kinds: ['dead_ask', 'usage_unknown', 'limit_no_account', 'limit_no_run', 'limit_no_hit', 'limit_no_reset', 'limit_reset', 'no_reviewer_ask'] },
  review_count: { what: "a card's failed review requests could not be counted, so it would never reach you", steps: ['limits'], kinds: ['review_request'] },
});
const CAUSE_OF = new Map(Object.entries(REFUSED_CAUSES).flatMap(([cause, c]) => c.kinds.map((k) => [k, cause])));

/** A Record like `inner` whose write() notes each refused write of a watched kind in `refused` (cause → [{ id, reason }]). */
export function watchWrites(inner) {
  const refused = new Map();
  const watched = Object.create(inner);
  Object.defineProperty(watched, 'write', {
    value: (args) => {
      const r = inner.write(args);
      const cause = CAUSE_OF.get(args?.kind);
      if (cause && r?.ok !== true) {
        const list = refused.get(cause) ?? [];
        list.push({ id: args.id, reason: r?.reason ?? 'no answer' });
        refused.set(cause, list);
      }
      return r;
    },
  });
  return { rec: watched, refused };
}

const iso = (ms) => new Date(ms).toISOString();
const textOf = (cause, items) => `the Dispatcher: ${REFUSED_CAUSES[cause].what}: ${items.map((x) => `${x.id} (${x.reason})`).join('; ')}; it tries again each pass`;

/**
 * Told once per cause, again each day it lasts, cleared when a pass has none. `ran(step)` answers whether that step
 * finished this pass. Returns [[cause, did]].
 */
export function tellRefused({ rec, alert, now, refused, ran = () => true }) {
  const out = [];
  for (const cause of Object.keys(REFUSED_CAUSES)) {
    const items = refused.get(cause) ?? [];
    if (!items.length && !REFUSED_CAUSES[cause].steps.every(ran)) continue;
    const fact = REFUSED_FACT(cause);
    const r = stillWaiting({
      now,
      waiting: items.length > 0,
      read: () => rec.read('fact', fact)?.doc ?? null,
      tell: (fields) => tellThen(alert, textOf(cause, items), { fact, fields, kind: 'write_refused' }),
      clear: () => {
        dropCause(rec, fact);
        const cur = rec.read('fact', fact);
        if (cur?.doc?.told_at != null) rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: cur.rev, doc: { ...cur.doc, told_at: null, cleared_at: iso(now) }, kind: 'write_refused_cleared' });
      },
    });
    out.push([cause, r.did]);
  }
  return out;
}

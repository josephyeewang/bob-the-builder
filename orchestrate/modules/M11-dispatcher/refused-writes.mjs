// refused-writes.mjs — a Record write the Dispatcher makes and the Store Writer refuses is told to Joe (lead call L323).
//
// WHY. A stopped session's park, a card put on Joe, a stop's own record, a review's failure count, a parked card put
// back in the queue and a time limit's end were each written and their answer dropped (pass.mjs moveAfterStop and the
// resume moves, tick.mjs's dead-session ask, the limit asks, merges.mjs). When the Store Writer refused one (L321: a
// tick's `now` gone more than 60 s stale), the card stayed where it was and nobody was told: a silent hold (L38). A
// fresh clock fixes that cause; this makes any other refusal of those writes loud.
//
// HOW. watchWrites(rec) gives the tick a Record whose write() notes each refused write of a WATCHED kind under its
// cause, with the state its target was in (`from`), and each one the Writer took. tellRefused(), at the end of the
// pass, keeps the refused ones on the cause's fact (L332 MAT-1): some writes are tried only once (outage.mjs decides
// the held dead sessions at the outage's end), so "no refusal this pass" is not "ended". A kept one stays while its
// target is still in the state it was in when the write was refused and no later write of it was taken. The cause is
// told through stillWaiting (shared/still-waiting.mjs): at once, again every 24 h while any is kept, and cleared when
// none is. A pass whose steps did not all finish, with nothing kept and nothing new, leaves the cause as it is: no
// answer is not "ended". A throw in one cause never skips the others; they are thrown on together at the end.
// Nothing that can't be read clears a cause (L352): a target read that throws, now or when refused, is still refused;
// a kept list or entry that can't be read, and refused writes past the cap, are counted in `more`, named in the alert
// with the fact a lead resets, and keep the cause told. Nothing in the product resets it yet (L361: loud, not silent).
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { dropCause, tellThen } from './alerts.mjs';
import { HOLD_FACT } from './pass.mjs';

// A refused write is a hold (L38): its fact is in the Dispatcher's `hold-` family (pass.mjs HOLD_FACT; M9 permissions).
export const REFUSED_FACT = (cause) => HOLD_FACT(`write-refused-${cause}`);
// The most refused writes one cause keeps (the newest), and how many of those one alert lists (L361: the list is
// re-checked in full; the alert stays short enough to read).
export const REFUSED_KEEP_MAX = 200;
export const REFUSED_LIST_MAX = 20;

// Each cause: what Joe reads, the tick steps that make its writes, and the write kinds it covers.
export const REFUSED_CAUSES = Object.freeze({
  park: { what: "a stopped session's card could not be parked", steps: ['stops'], kinds: ['park_paused', 'park_red', 'needs_split'] },
  stop_record: { what: 'a session stop could not be recorded', steps: ['stops'], kinds: ['stop_wanted', 'stop_dropped', 'stop_done', 'stop_moved'] },
  joe_wait: { what: 'a card could not be put on you', steps: ['outage', 'pass', 'limits'],
    kinds: ['dead_ask', 'usage_unknown', 'limit_no_account', 'limit_no_run', 'limit_no_hit', 'limit_no_reset', 'limit_reset', 'no_reviewer_ask'] },
  review_count: { what: "a card's failed review requests could not be counted, so it would never reach you", steps: ['limits'], kinds: ['review_request'] },
  resume: { what: 'a parked card could not be put back in the queue', steps: ['pass'], kinds: ['resume_usage_band', 'resume_limit_hit', 'resume_paused'] },
  // The text names what was refused (L352 c1): a session's end, its card's failing, or both.
  timeout: { what: (items) => {
    const s = items.some((x) => x.entity === 'session');
    const c = items.some((x) => x.entity === 'card');
    return c && !s ? "a card past its time limit could not be failed" : s && !c ? 'a session past its time limit could not be ended'
      : 'a session past its time limit could not be ended, or its card failed';
  }, steps: ['limits'], kinds: ['timeout'] },
});
const CAUSE_OF = new Map(Object.entries(REFUSED_CAUSES).flatMap(([cause, c]) => c.kinds.map((k) => [k, cause])));

// What a refused write's target looked like: a card by its state and wait, anything else by its revision.
const stateOf = (rec, entity, id) => {
  let cur;
  try { cur = rec.read(entity, id); } catch { return 'unreadable'; }
  if (cur == null) return 'absent';
  return entity === 'card' ? JSON.stringify([cur.doc?.state ?? null, cur.doc?.wait?.who ?? null, cur.doc?.wait?.what ?? null]) : `rev ${cur.rev}`;
};
const keyOf = (x) => `${x.entity}/${x.id}`;

/**
 * A Record like `inner` whose write() notes, per cause, each refused write of a watched kind in `refused`
 * (cause → [{ entity, id, kind, reason, from }]) and each one taken in `taken` (cause → Set of `entity/id`).
 */
export function watchWrites(inner) {
  const refused = new Map();
  const taken = new Map();
  const watched = Object.create(inner);
  Object.defineProperty(watched, 'write', {
    value: (args) => {
      const cause = CAUSE_OF.get(args?.kind);
      const from = cause ? stateOf(inner, args.entity, args.id) : null;
      const r = inner.write(args);
      if (cause && r?.ok === true) {
        const set = taken.get(cause) ?? new Set();
        set.add(keyOf(args));
        taken.set(cause, set);
      } else if (cause) {
        const list = refused.get(cause) ?? [];
        list.push({ entity: args.entity, id: args.id, kind: args.kind, reason: String(r?.reason ?? 'no answer').slice(0, 300), from });
        refused.set(cause, list);
      }
      return r;
    },
  });
  return { rec: watched, refused, taken };
}

const iso = (ms) => new Date(ms).toISOString();
const whatOf = (cause, items) => { const w = REFUSED_CAUSES[cause].what; return typeof w === 'function' ? w(items) : w; };
// What Joe reads: the newest kept ones, how many other kept ones there are, whether the kept list could be read, and
// how many could not be kept, with what ends that (L361: `more` can't be re-checked, so the reminder has to say so).
const textOf = (cause, items, more, unreadable) => {
  const shown = items.slice(-REFUSED_LIST_MAX);
  const hidden = items.length - shown.length;
  return `the Dispatcher: ${whatOf(cause, items)}: ${[
    shown.map((x) => `${x.id} (${x.reason})`).join('; ') || null,
    hidden > 0 ? `and ${hidden} more still refused` : null,
    unreadable ? 'the kept list could not be read' : null,
    more > 0 ? `${more} more refused ${more === 1 ? 'write was' : 'writes were'} not listed, so once the listed ones are fixed the lead resets this reminder (fact ${REFUSED_FACT(cause)})` : null,
  ].filter(Boolean).join('; ')}; told again each day while it stays so`;
};
const isItem = (x) => x && typeof x === 'object' && typeof x.entity === 'string' && typeof x.id === 'string' && typeof x.from === 'string';

// The kept list on a cause's fact. A list that is there but can't be read, or an entry that can't, is not "nothing
// kept" (L352 MAT-2): it counts as more refused writes than are kept, so the cause stays told and is never cleared for
// it. A mark with no list at all (from before lists were kept) has nothing kept.
function keptOf(doc) {
  const raw = doc?.items;
  const prior = doc?.more;
  // A `more` count that can't be read is at least one unknown refused write.
  let more = prior === undefined ? 0 : Number.isInteger(prior) && prior >= 0 ? prior : 1;
  if (raw === undefined) return { kept: [], more, unreadable: prior !== undefined && more !== prior };
  if (!Array.isArray(raw)) return { kept: [], more: more + 1, unreadable: true };
  const kept = raw.filter(isItem);
  return { kept, more: more + raw.length - kept.length, unreadable: kept.length < raw.length || (prior !== undefined && more !== prior) };
}

// A kept one stays refused while its target is as it was, unless a write of it was taken since. An 'unreadable' target,
// now or when it was refused, has not been seen to move (L352 MAT-1).
const stillRefused = (rec, k) => {
  const now = stateOf(rec, k.entity, k.id);
  return now === k.from || now === 'unreadable' || k.from === 'unreadable';
};

function tellCause({ rec, alert, now, cause, fresh, taken, ran }) {
  const fact = REFUSED_FACT(cause);
  const cur = rec.read('fact', fact);
  const { kept, more: prior, unreadable } = keptOf(cur?.doc);
  if (!fresh.length && !kept.length && !prior && !REFUSED_CAUSES[cause].steps.every(ran)) return 'kept';
  const freshKeys = new Set(fresh.map(keyOf));
  const still = kept.filter((k) => !freshKeys.has(keyOf(k)) && !taken.has(keyOf(k)) && stillRefused(rec, k));
  const all = [...still, ...fresh];
  const items = all.slice(-REFUSED_KEEP_MAX);
  // The oldest beyond the cap are dropped from the list but counted (L352 m1): they can't be re-checked, so any count
  // keeps the cause told and blocks its clear.
  const more = prior + (all.length - items.length);
  let cleared = null;
  const r = stillWaiting({
    now,
    waiting: items.length > 0 || more > 0,
    read: () => rec.read('fact', fact)?.doc ?? null,
    tell: (fields) => tellThen(alert, textOf(cause, items, more, unreadable), { fact, fields, kind: 'write_refused' }),
    clear: () => {
      dropCause(rec, fact);
      const c = rec.read('fact', fact);
      if (c?.doc?.told_at == null && !(c?.doc?.items ?? []).length && !c?.doc?.more) return;
      cleared = rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: c.rev, doc: { ...c.doc, items: [], more: 0, told_at: null, cleared_at: iso(now) }, kind: 'write_refused_cleared' });
      // A refused clear keeps the cause (L332 m6): a stale told_at would keep a refusal within 24 h quiet.
      if (cleared?.ok !== true) throw new Error(`its clear was refused (${cleared?.reason ?? 'no answer'})`);
    },
  });
  if ((items.length || more) && (unreadable || more !== prior || JSON.stringify(items) !== JSON.stringify(kept))) {
    const c = rec.read('fact', fact);
    const w = rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: c?.rev ?? 0, doc: { ...(c?.doc ?? {}), items, more }, kind: 'write_refused_kept' });
    if (w?.ok !== true) throw new Error(`its list could not be kept (${w?.reason ?? 'no answer'}), so it may clear while still refused`);
  }
  return r.did;
}

/**
 * Told once per cause, again each day while any refused write of it is kept, cleared when none is. `ran(step)`
 * answers whether that step finished this pass; left out, no step did, so nothing is cleared for want of an answer
 * (L332 c4). `taken` is watchWrites' map of writes the Writer took. Returns [[cause, did]]; a cause that threw is
 * 'error', and once every cause has been tried the throws are thrown on together.
 */
export function tellRefused({ rec, alert, now, refused, taken = new Map(), ran = () => false }) {
  const out = [];
  const errors = [];
  for (const cause of Object.keys(REFUSED_CAUSES)) {
    try { out.push([cause, tellCause({ rec, alert, now, cause, fresh: refused.get(cause) ?? [], taken: taken.get(cause) ?? new Set(), ran })]); }
    catch (e) { out.push([cause, 'error']); errors.push(`${cause}: ${e?.message ?? e}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return out;
}

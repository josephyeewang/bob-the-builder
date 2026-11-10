// refused-writes.mjs — a Record write the Dispatcher makes and the Store Writer refuses is told to the owner (lead call L323).
//
// WHY. A stopped session's park, a card put on the owner, a stop's own record, a review's failure count, a parked card put
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
// a kept list or entry that can't be read, and refused writes past both lists, are counted in `more`, named in the
// alert with the fact a lead resets, and keep the cause told. Nothing in the product resets it yet (L361: loud, not
// silent). Past REFUSED_KEEP_MAX the oldest stay on `over` by id alone and are re-checked the same way, so a refusal
// repeated each pass is one refusal, and the count falls as they move (L366 m-A). `more` is "at least": its highest
// count, never a sum, as what it counts can't be told apart from a repeat.
import { stillWaiting } from '../../shared/still-waiting.mjs';
import { dropAnswer, tellThen, writeFrom } from './alerts.mjs';
import { HOLD_FACT } from './pass.mjs';
import { WAIT_TELL_FACT } from './joe-waits.mjs';

// A refused write is a hold (L38): its fact is in the Dispatcher's `hold-` family (pass.mjs HOLD_FACT; M9 permissions).
export const REFUSED_FACT = (cause) => HOLD_FACT(`write-refused-${cause}`);
// The most refused writes one cause keeps (the newest), and how many of those one alert lists (L361: the list is
// re-checked in full; the alert stays short enough to read).
export const REFUSED_KEEP_MAX = 200;
export const REFUSED_LIST_MAX = 20;
// The most refused writes kept past REFUSED_KEEP_MAX, by id alone (L366 m-A).
export const REFUSED_OVER_MAX = 1000;

// Each cause: what the owner reads, the tick steps that make its writes, and the write kinds it covers.
export const REFUSED_CAUSES = Object.freeze({
  park: { what: "a stopped session's card could not be parked", steps: ['stops'], kinds: ['park_paused', 'park_red', 'needs_split'] },
  stop_record: { what: 'a session stop could not be recorded', steps: ['stops'], kinds: ['stop_wanted', 'stop_dropped', 'stop_done', 'stop_moved'] },
  joe_wait: { what: 'a card could not be put on you', steps: ['outage', 'pass', 'limits', 'merges'],
    kinds: ['wait_tell', 'dead_ask', 'usage_unknown', 'limit_no_account', 'limit_no_run', 'limit_no_hit', 'limit_no_reset', 'limit_reset', 'no_reviewer_ask', 'merge_repeat_ask'] },
  review_count: { what: "a card's failed review requests could not be counted, so it would never reach you", steps: ['limits'], kinds: ['review_request'] },
  resume: { what: 'a parked card could not be put back in the queue', steps: ['pass'], kinds: ['resume_usage_band', 'resume_limit_hit', 'resume_paused'] },
  // The text names what was refused (L352 c1): a session's end, its card's failing, or both.
  timeout: { what: (items) => {
    const s = items.some((x) => x.entity === 'session');
    const c = items.some((x) => x.entity === 'card');
    return c && !s ? "a card past its time limit could not be failed" : s && !c ? 'a session past its time limit could not be ended'
      : 'a session past its time limit could not be ended, or its card could not be failed';
  }, steps: ['limits'], kinds: ['timeout'] },
});
const CAUSE_OF = new Map(Object.entries(REFUSED_CAUSES).flatMap(([cause, c]) => c.kinds.map((k) => [k, cause])));

// What a refused write is about. A refused tell (L386) is about its card, not its fact: a card that moved on needs no
// tell, and nothing else would ever change that fact. It is still matched by the fact, as a tell taken is not a wait
// taken (keyOf, `taken`).
const aboutOf = (x) => (x.kind === 'wait_tell' ? { entity: 'card', id: x.id.slice(WAIT_TELL_FACT('').length) } : x);

// What a refused write's target looked like: a card by its state and wait, anything else by its revision.
const stateOf = (rec, entity, id) => {
  let cur;
  try { cur = rec.read(entity, id); } catch { return 'unreadable'; }
  if (cur == null) return 'absent';
  if (cur.corrupt) return 'unreadable';  // L797: the store reports a corrupt document this way; it has not been seen to move
  return entity === 'card' ? JSON.stringify([cur.doc?.state ?? null, cur.doc?.wait?.who ?? null, cur.doc?.wait?.what ?? null]) : `rev ${cur.rev}`;
};
const keyOf = (x) => `${x.entity}/${x.id}`;

/**
 * A Record like `inner` whose write() notes, per cause, each refused write of a watched kind in `refused`
 * (cause → [{ entity, id, kind, reason, from }]) and each one taken in `taken` (cause → Set of `entity/id`). A refused
 * write it noted answers with `watched: cause`.
 */
export function watchWrites(inner) {
  const refused = new Map();
  const taken = new Map();
  const watched = Object.create(inner);
  Object.defineProperty(watched, 'write', {
    value: (args) => {
      const cause = CAUSE_OF.get(args?.kind);
      const about = cause ? aboutOf(args) : null;
      const from = cause ? stateOf(inner, about.entity, about.id) : null;
      const r = inner.write(args);
      if (cause && r?.ok === true) {
        const set = taken.get(cause) ?? new Set();
        set.add(keyOf(args));
        taken.set(cause, set);
      } else if (cause) {
        const list = refused.get(cause) ?? [];
        list.push({ entity: args.entity, id: args.id, kind: args.kind, reason: String(r?.reason ?? 'no answer').slice(0, 300), from });
        refused.set(cause, list);
        // The refusal is on its way to the owner, so a caller need not tell it again (L405 m2).
        return { ...r, watched: cause };
      }
      return r;
    },
  });
  return { rec: watched, refused, taken };
}

const iso = (ms) => new Date(ms).toISOString();
const whatOf = (cause, items) => { const w = REFUSED_CAUSES[cause].what; return typeof w === 'function' ? w(items) : w; };
// What the owner reads: the newest kept ones, how many other kept ones there are, whether the kept list could be read,
// and how many could not be kept, with what ends that (L361: `more` can't be re-checked, so the reminder has to say so).
const textOf = (cause, { items, over, more, unreadable }) => {
  const shown = items.slice(-REFUSED_LIST_MAX);
  const hidden = over.length + items.length - shown.length;
  return `the Dispatcher: ${whatOf(cause, [...over, ...items])}: ${[
    shown.map((x) => (x.reason ? `${aboutOf(x).id} (${x.reason})` : aboutOf(x).id)).join('; ') || null,
    hidden > 0 ? `and ${hidden} more still refused` : null,
    unreadable ? 'the kept list could not be read' : null,
    more > 0 ? `at least ${more} more refused ${more === 1 ? 'write was' : 'writes were'} not listed, so once the listed ones are fixed the lead resets this reminder (fact ${REFUSED_FACT(cause)})` : null,
  ].filter(Boolean).join('; ')}; told again each day while it stays so`;
};
const isItem = (x) => x && typeof x === 'object' && typeof x.entity === 'string' && typeof x.id === 'string' && typeof x.from === 'string';

// One kept list as stored: what can be read of it, and how many entries can't. No list at all is an empty one.
const listOf = (raw) => {
  if (raw === undefined) return { list: [], bad: 0 };
  if (!Array.isArray(raw)) return { list: [], bad: 1 };
  const list = raw.filter(isItem);
  return { list, bad: raw.length - list.length };
};

// The kept lists on a cause's fact. A list that is there but can't be read, or an entry that can't, is not "nothing
// kept" (L352 MAT-2): it counts as more refused writes than are kept, so the cause stays told and is never cleared for
// it. A mark with no list at all (from before lists were kept) has nothing kept. Once set, `unreadable` stays on the
// fact with the count it explains (L366 m-B): the next alert may be a day after the pass that found it.
function keptOf(doc) {
  const prior = doc?.more;
  const items = listOf(doc?.items);
  const over = listOf(doc?.over);
  // A `more` count that can't be read is at least one unknown refused write.
  const base = prior === undefined ? 0 : Number.isInteger(prior) && prior >= 0 ? prior : 1;
  const bad = items.bad + over.bad;
  return { kept: items.list, over: over.list, more: base + bad, unreadable: doc?.unreadable === true || bad > 0 || (prior !== undefined && base !== prior) };
}

// A kept one stays refused while its target is as it was, unless a write of it was taken since. An 'unreadable' target,
// now or when it was refused, has not been seen to move (L352 MAT-1).
const stillRefused = (rec, k) => {
  const { entity, id } = aboutOf(k);
  const now = stateOf(rec, entity, id);
  return now === k.from || now === 'unreadable' || k.from === 'unreadable';
};

// This pass's refusals, once each, as the kept list holds them (L366 m-A: a write refused twice is one refusal, the latest).
const onceOf = (fresh) => [...new Map(fresh.map((x) => [keyOf(x), x])).values()];
// This pass's refusals, named in the error a corrupt kept list raises (#367 r1 M1), so they are told now whatever the list.
// Where they are kept, the latest REFUSED_LIST_MAX are named and the rest counted; with `all` (the list could not be
// restored, so nothing is kept: #367 r2 m2) every one is named, since the error is all that tells them.
const namedOf = (fresh, { all = false } = {}) => {
  const once = onceOf(fresh);
  if (!once.length) return '';
  const shown = (all ? once : once.slice(-REFUSED_LIST_MAX)).map((x) => `${aboutOf(x).id} (${x.reason})`).join('; ');
  return `; refused this pass: ${shown}${!all && once.length > REFUSED_LIST_MAX ? ` and ${once.length - REFUSED_LIST_MAX} more` : ''}`;
};
// #367 r2 m3: the check write below is refused on purpose, and the Record tells that refusal as any other (its `refused`
// alert). Its reason varies: the tamper found in this process, "changed since read ... expected 9007199254740991" in a new
// one, or a store error. The error names the fact instead, so Joe doesn't read that alert as a lost write (self-review m1).
const probeNote = (fact) => `; the Record's "refused" alert for fact ${fact} this pass, whatever its reason, is this check, not a lost write`;

function tellCause(args) {
  const { rec, cause, fresh } = args;
  const fact = REFUSED_FACT(cause);
  const cur = rec.read('fact', fact);
  // L797 self-review M1: a kept list the store reports corrupt is not "nothing kept"; the pass tells it (tick.mjs).
  if (!cur?.corrupt) return tellKept(args, cur, null);
  // #367 r1 M1: nor may it drop this pass's refusals. A write makes the store check the file first (M9 writer.mjs, before
  // the version check): one changed outside the Store Writer is restored from the diary, a stray one is moved aside. The
  // write itself is at version Number.MAX_SAFE_INTEGER, which no fact reaches, so the Store Writer's version check
  // refuses it and it is never taken (#367 r2 c1; -1 would not do: the Record refuses a version below 0 before the
  // store sees it, so no file check would run). The list is then read again; if it reads, or
  // is now absent, this pass goes on as any other and keeps this pass's refusals. Whatever happens after, the error
  // names them, so they are told this pass even when the daily tell is not due.
  const why = cur.reason ?? 'corrupt';
  try { rec.write({ actor: 'dispatcher', entity: 'fact', id: fact, expectRev: Number.MAX_SAFE_INTEGER, doc: {}, kind: 'write_refused_kept' }); } catch { /* the read below says */ }
  const again = rec.read('fact', fact);
  if (again?.corrupt) throw new Error(`its kept list could not be read (${why}) or restored, so this pass's refusals are not kept${namedOf(fresh, { all: true })}${probeNote(fact)}`);
  const how = again ? 'it was restored from the Record\'s diary' : 'no list was on record, so it starts again';
  try { tellKept(args, again, how); } catch (e) {
    throw new Error(`its kept list could not be read (${why}); ${how}, then ${e?.message ?? e}${namedOf(fresh)}${probeNote(fact)}`);
  }
  // #367 r2 c2: "kept with it" only when this pass refused something.
  const keptNow = onceOf(fresh).length ? ', and this pass\'s refusals are kept with it' : '';
  throw new Error(`its kept list could not be read (${why}); ${how}${keptNow}${namedOf(fresh)}${probeNote(fact)}`);
}

function tellKept({ rec, alert, now, cause, fresh, taken, ran }, cur) {
  const fact = REFUSED_FACT(cause);
  const { kept, over: keptOver, more: prior, unreadable } = keptOf(cur?.doc);
  if (!fresh.length && !kept.length && !keptOver.length && !prior && !REFUSED_CAUSES[cause].steps.every(ran)) return 'kept';
  // A write refused twice in a pass is one refusal, the latest (L366 m-A).
  const once = onceOf(fresh);
  const freshKeys = new Set(once.map(keyOf));
  const still = [...keptOver, ...kept].filter((k) => !freshKeys.has(keyOf(k)) && !taken.has(keyOf(k)) && stillRefused(rec, k));
  const all = [...still, ...once];
  const items = all.slice(-REFUSED_KEEP_MAX);
  const older = all.slice(0, Math.max(0, all.length - REFUSED_KEEP_MAX));
  const over = older.slice(-REFUSED_OVER_MAX).map(({ entity, id, kind, from }) => ({ entity, id, kind, from }));
  // Those past both lists can't be re-checked, so any count keeps the cause told and blocks its clear (L352 m1). The
  // same ones repeated each pass count once (L366 m-A).
  const more = Math.max(prior, older.length - over.length);
  let cleared = null;
  const r = stillWaiting({
    now,
    waiting: items.length > 0 || over.length > 0 || more > 0,
    read: () => rec.read('fact', fact)?.doc ?? null,
    tell: (fields) => tellThen(alert, textOf(cause, { items, over, more, unreadable }), { fact, fields, kind: 'write_refused' }),
    clear: () => {
      const d = dropAnswer(rec, fact);
      if (!d.ok) throw new Error('its queued alert could not be dropped');
      const c = rec.read('fact', fact);
      if (c?.corrupt) throw new Error(`its kept list could not be read (${c.reason ?? 'corrupt'})`);
      // Written when something shows or was queued, so a mark on its way conflicts (L449 m1, m2); this runs every pass.
      if (!d.removed && c?.doc?.told_at == null && !(c?.doc?.items ?? []).length && !(c?.doc?.over ?? []).length && !c?.doc?.more) return;
      // Through writeFrom (L454): a mark that lands during this write is a lost race to try again, and told_at must win.
      cleared = writeFrom(rec, fact, c?.doc, { ...c?.doc, items: [], over: [], more: 0, unreadable: false, told_at: null, cleared_at: iso(now) }, 'write_refused_cleared', { force: ['told_at'] });
      // A refused clear keeps the cause (L332 m6): a stale told_at would keep a refusal within 24 h quiet.
      if (cleared?.ok !== true) throw new Error(`its clear was refused (${cleared?.reason ?? 'no answer'})`);
    },
  });
  const c = rec.read('fact', fact);
  const keep = { items, over, more, unreadable };
  if ((items.length || more) && Object.entries(keep).some(([k, v]) => JSON.stringify(c?.doc?.[k]) !== JSON.stringify(v))) {
    const w = writeFrom(rec, fact, c?.doc, { ...(c?.doc ?? {}), ...keep }, 'write_refused_kept');
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

// The one outbox for Joe's alerts (LEAD-CALLS L47; audit 0b-6 r6 MAT-A, MAT-B, MAT-C).
//
// Every alert site only drops an entry in a saved queue (the fact `unsent-alerts`): `outbox(rec, now)`
// gives the `alert(text)` every step gets, and it never sends, waits or throws. One sender,
// `sendAlerts`, delivers the queue at the end of each pass, each send with a short deadline. An entry
// leaves the queue only after its send went through; a send that fails, answers false or does not
// answer in time leaves it queued for the next pass. A cause is marked told (`mark`) only when a copy
// of its alert is delivered, by the sender, so a crash between queueing and sending loses nothing.
// No other file calls the alert port: the sweep in alert-sites.test.mjs checks it.
// When a cause clears, its step drops the cause's queued entry (`dropCause`, audit 0b-6 r7 M2), so a copy
// delivered later can neither mark the next occurrence as told nor tell Joe about what has passed.

import { randomUUID } from 'node:crypto';
import { note } from './moves.mjs';
import { STATES } from '../../shared/record.mjs';
import { pastTime, STILL_WAITING_MS } from '../../shared/still-waiting.mjs';

const iso = (ms) => new Date(ms).toISOString();
// Every write here is "only if unchanged since read" (L288 MAT-4): `change(doc)` builds the new doc from the one
// read, and it is written at that read's rev. The rev used to be read again at write time, so a write from another
// process in between (the alert channel's robot job beside the Dispatcher) was silently overwritten. If another
// writer got in first, the fact is read and the doc built again, up to WRITE_TRIES times; `change` returning null
// writes nothing. Any other refusal is returned as it is.
export const WRITE_TRIES = 5;
function updateFact(rec, id, change, kind) {
  for (let i = 0; i < WRITE_TRIES; i += 1) {
    const cur = rec.read('fact', id);
    const doc = change(cur?.doc);
    if (doc === null) return { ok: true, unchanged: true };
    const r = rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: cur?.rev ?? 0, doc, kind });
    if (r?.ok === true || (rec.read('fact', id)?.rev ?? 0) === (cur?.rev ?? 0)) return r;
  }
  return { ok: false, reason: `${id} kept changing under the write (${WRITE_TRIES} tries)` };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Writes `doc` over fact `id` as a change from `base`, the doc the caller read (L335 m-1): through updateFact, so at
 * the version it reads and again on a conflict, and on each try only what the caller changed (the keys where `doc`
 * differs from `base`, set or removed) goes onto the doc as it is now. Nothing else written: exactly `doc`; something
 * else written meanwhile: its own fields stay. A key in `force` is written as `doc` has it even when `base` had the same
 * (a clear that must win over a mark written after the read). Answers updateFact's answer; a read or write that throws fails the step, as a direct write does.
 */
export function writeFrom(rec, id, base, doc, kind, { force = [] } = {}) {
  const was = base ?? {};
  const keys = new Set([...Object.keys(was), ...Object.keys(doc), ...force]);
  return updateFact(rec, id, (cur) => {
    const next = { ...(cur ?? {}) };
    for (const k of keys) {
      if (same(was[k], doc[k]) && !force.includes(k)) continue;
      if (Object.hasOwn(doc, k)) next[k] = doc[k]; else delete next[k];
    }
    // The Record refuses a write that changes nothing; here that is nothing to do.
    return cur && same(next, cur) ? null : next;
  }, kind);
}

export const ALERT_QUEUE_FACT = 'unsent-alerts';
export const ALERT_QUEUE_MAX = 50;
// The cap on entries not yet tried (a Minor from the review of the first Dispatcher build): while the port is
// down each round tries one entry, so without it the untried grow without limit. Well above a burst, so one
// burst is all sent.
export const ALERT_UNTRIED_MAX = 200;
export const ALERT_SEND_MS = 10_000;
// One sender's time in a pass (audit 0b-6 r7 m1): the pass sends twice, at its start and at its end, and
// every step at its deadline plus both sends fits inside main.mjs's run deadline.
export const ALERT_BUDGET_MS = 2 * ALERT_SEND_MS;

const entriesOf = (d) => (Array.isArray(d?.entries) ? d.entries : []);
// One cause, one entry: the key is the fact its told mark goes on, with the fields it sets.
const keyOf = (mark) => (mark ? `${mark.fact}:${Object.keys(mark.fields ?? {}).sort().join(',')}` : null);
// The sends out and not yet settled, per record (#39 check, m1; round 2, m-A): the cap never drops an entry one
// of them has out, or its send would settle nothing, and a new round carries only the count none of them carries.
// Every round adds to the one set, so overlapping rounds see each other. Kept in memory, as a send lives within
// one process.
const inFlightOf = new WeakMap();
const outFor = (rec) => { if (!inFlightOf.has(rec)) inFlightOf.set(rec, new Set()); return inFlightOf.get(rec); };
const isInFlight = (rec, x) => [...outFor(rec)].some((sent) => sameAs(sent)(x));
// Every drop is counted (L52): a one-off adds one to `dropped`; a cause-tied entry adds its cause to
// `dropped_causes`, once however often it is queued and dropped again, and the cause leaves that list when an
// alert for it is delivered or the cause clears (`dropCause`). The number told is both together. Each listed
// drop has an id of its own (#39 round 3, L56): a delivery clears only the drops its text carried, or its own
// cause's drops listed when it was sent, never one of the same cause dropped again while it was out.
const causesOf = (d) => (Array.isArray(d?.dropped_causes) ? d.dropped_causes : []);
export const droppedCount = (d) => (d?.dropped ?? 0) + causesOf(d).length;
// A cause already listed is not listed again, unless every drop of it listed is out in a send's text: that text
// was written before this drop, so it is listed anew (#39 round 3, L56).
const carriedIds = (rec) => new Set([...outFor(rec)].flatMap((s) => [...(s.carried?.causes ?? []), ...(s.carried?.own ?? [])]));
const addCauses = (rec, d, gone) => {
  const out = carriedIds(rec);
  const have = new Set(causesOf(d).filter((c) => !out.has(c.id)).map((c) => c.key));
  const add = gone.filter((e) => e.key && !have.has(e.key) && have.add(e.key)).map((e) => ({ key: e.key, fact: e.mark?.fact ?? null, id: randomUUID() }));
  return [...causesOf(d), ...add];
};
// Listings of one cause that are no longer out merge into the oldest (#39 round 3 recheck, N1): a send that
// failed carrying a listing brings it back beside the one listed while it was out, and both stand for one cause.
// So a cause has at most one listing that is not out, plus one per send still out, and the list cannot grow
// through an outage.
const mergeFree = (rec, list) => {
  const out = carriedIds(rec);
  const seen = new Set();
  return list.filter((c) => out.has(c.id) || (!seen.has(c.key) && seen.add(c.key)));
};
// Two caps. Entries that have waited through a failed send (`held`; audit 0b-6 r7 M3) keep ALERT_QUEUE_MAX,
// so a burst queued while sending works is all sent. Entries not yet tried keep ALERT_UNTRIED_MAX, so a long
// outage cannot grow the queue without limit. Only entries not out for sending count, and none of those is
// dropped (#39 check, m1; round 2, m-B). As many go as the classes are over their caps, and entries tied to a
// cause (a stop, unsaved work, the phone link) go before any one-off, across both caps (L52, m-C): first each
// class's own causes, oldest first, then the other class's in place of a one-off (that class then stays over its
// cap by as many until the next queueing), and a class's own one-offs, oldest first, only when no cause is left.
const capQueue = (rec, all) => {
  const free = all.filter((e) => !isInFlight(rec, e));
  const gone = new Set();
  const left = (held) => free.filter((e) => !!e.held === held && !gone.has(e.id));
  const over = (held) => Math.max(0, left(held).length - (held ? ALERT_QUEUE_MAX : ALERT_UNTRIED_MAX));
  for (const held of [true, false]) for (const e of left(held).filter((x) => x.key).slice(0, over(held))) gone.add(e.id);
  for (const held of [true, false]) for (let n = over(held); n > 0; n -= 1) gone.add((left(!held).find((x) => x.key) ?? left(held)[0]).id);
  const dropped = all.filter((e) => gone.has(e.id));
  return { entries: all.filter((e) => !gone.has(e.id)), dropped };
};
// The queue record after a cap: the one-offs dropped counted, the causes dropped listed.
const withDrops = (rec, d, entries, dropped) => ({ ...d, entries, dropped: (d.dropped ?? 0) + dropped.filter((e) => !e.key).length, dropped_causes: mergeFree(rec, addCauses(rec, d, dropped)) });

/**
 * Queues one alert. `mark` = { fact, fields, kind }: written onto that fact (merged into it) once the alert
 * is delivered. A second alert for the same cause, or with the same text, replaces the queued one in place.
 * Of the entries that waited through a failed send, the queue keeps ALERT_QUEUE_MAX, and of those not yet tried
 * ALERT_UNTRIED_MAX (capQueue says which go); every one dropped is counted in the next text sent.
 * Returns the entry's id, or null when the record refused it or the cap dropped this very entry (L130 m18: the
 * drop is still counted, but the caller is not told it was queued).
 */
// L545: an alert with nowhere to wait goes to the store's own unsent file, which the alert channel delivers with no queue
// and no Dispatcher. The call needs no Record write, as that is what just failed. If the file can't take it either, the
// store's log line is all that is left.
const keepOutside = (rec, text, key) => { try { rec.keepAlert?.(text, key); } catch { /* the log line stands */ } };

export function queueAlert(rec, text, { now, mark = null } = {}) {
  const key = keyOf(mark);
  let entry;
  let dropped = [];
  let saved;
  try { saved = updateFact(rec, ALERT_QUEUE_FACT, (doc) => {
    const d = doc ?? {};
    const next = (d.next ?? 0) + 1;
    entry = { id: `a${next}`, key, text: String(text), mark, queued_at: iso(now) };
    const all = entriesOf(d).slice();
    const i = all.findIndex((e) => (key ? e.key === key : !e.key && e.text === entry.text));
    // A copy already delivered whose mark could not be saved stays held (see holdsDelivered): a site that sees no mark
    // tells again each pass, and that must not start the day over.
    if (i >= 0) { const { delivered_at: at, delivered_text: said } = all[i]; all[i] = at ? { ...entry, delivered_at: at, delivered_text: said } : entry; } else all.push(entry);
    const capped = capQueue(rec, all);
    dropped = capped.dropped;
    return { ...withDrops(rec, d, capped.entries, dropped), next };
  }, 'alert_queued'); } catch (e) { keepOutside(rec, `${text} (it could not be queued: ${String(e?.message ?? e).slice(0, 200)})`, key ?? text); throw e; }
  // updateFact's answer is final: a conflict was tried again in there, so this is never a first refused try (L545).
  if (saved?.ok !== true) { keepOutside(rec, `${text} (it could not be queued: ${String(saved?.reason ?? 'no answer').slice(0, 200)})`, key ?? text); return null; }
  return !dropped.some((e) => e.id === entry.id) ? entry.id : null;
}

/**
 * The cause on `fact` has cleared: its queued entries leave unsent (audit 0b-6 r7 M2), and a drop of it no
 * longer counts (L52). Every fact a told
 * mark goes on has a step that calls this where the cause clears, or a line in alert-sites.test.mjs saying
 * why a late mark there is harmless. Returns whether the queue was written; never throws.
 */
export function dropCause(rec, fact) { return dropAnswer(rec, fact).ok; }

/** dropCause's answer in full: `removed` says the queue held something of this cause (L449 m2). */
export function dropAnswer(rec, fact) {
  let removed = false;
  try {
    const ok = updateFact(rec, ALERT_QUEUE_FACT, (d) => {
      const left = entriesOf(d).filter((e) => e.mark?.fact !== fact);
      const causes = causesOf(d).filter((c) => c.fact !== fact);
      removed = left.length !== entriesOf(d).length || causes.length !== causesOf(d).length;
      return removed ? { ...d, entries: left, dropped_causes: causes } : null;
    }, 'alert_cause_cleared').ok === true;
    return { ok, removed };
  } catch { return { ok: false, removed }; }
}

/**
 * The one order where a cause clears (L335 M-1, L354): its queued alert leaves first, then `clear` runs, so no told mark
 * can land after the clear. A drop that fails is told through `report`. With `hold` (the default, for a step that comes
 * back to this cause next pass) the clear waits for a drop that works; `hold: false` is for a clear with no next pass,
 * which goes ahead. A clear that writes told fields forces them (writeFrom): a diff would keep a mark.
 * `clear(moved)`: `moved` says something of this cause was in the queue, so a mark may be on its way and the clear must
 * write, moving the fact's version so that mark conflicts (L449 m1, m2). With nothing queued and no mark there is
 * nothing to race, and a clear that runs every pass writes nothing. `report(line, fact)`.
 */
export function clearCause(rec, fact, clear, report, { hold = true } = {}) {
  const { ok, removed } = dropAnswer(rec, fact);
  if (!ok) report(`the queued alert for ${fact} could not be dropped; ${hold ? 'the clear waits for the next pass' : 'the cause was cleared anyway, so it may still be sent'}`, fact);
  return ok || !hold ? clear(removed) : undefined;
}

/** Whether an alert whose mark names `fact` waits in the queue (a re-ask that would only replace it can be skipped). */
export function isQueued(rec, fact) {
  try { return entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc).some((e) => e.mark?.fact === fact); } catch { return false; }
}

/** The mark facts of the queued alerts whose mark starts with `prefix`, each once: a cause told for the first time has
 * a queue entry before it has a fact, so a step that clears such causes looks here too (L347 m1). */
export function queuedMarks(rec, prefix) {
  try {
    const ids = entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc).map((e) => e.mark?.fact).filter((f) => typeof f === 'string' && f.startsWith(prefix));
    return [...new Set(ids)];
  } catch { return []; }
}

/** The `alert(text, { mark })` every step gets: it queues and returns whether it did; it never sends, waits or throws. */
export function outbox(rec, now) {
  const alert = (text, { mark = null } = {}) => { try { return queueAlert(rec, text, { now, mark }) !== null; } catch { return false; } };
  alert.queues = true;
  return alert;
}

/**
 * The one way a cause is marked told (audit 0b-6 r5 MAT-2; L47): the alert is queued with its mark, and the
 * mark is written by `sendAlerts` once a copy is delivered. Until then the cause stays untold; a step that asks
 * again queues the same entry, not a second one, and an entry dropped at a cap is counted (L52). Every "told" write in this folder sits in a
 * `tellThen` call: the sweep in alert-sites.test.mjs checks it.
 */
/**
 * The outbox `alert` for a module whose alerts are objects (M6 settleMerge: { type, note, reason, merge }), as text.
 * Only ever wraps the step's own outbox `alert` (the sweep in alert-sites.test.mjs allows `textAlerts(alert)` alone).
 */
export const textAlerts = (alert, who = 'merge gate') => (e) => alert(alertText(e, who));
/**
 * The `alert` for an M6 call whose alerts the step sends itself once it has M6's answer (L127): each is kept in `into`
 * and nothing is queued, so the step can send them as they are, or as the one alert a told note is the mark of. It
 * never sends: the sweep in alert-sites.test.mjs allows `heldAlerts(` beside `textAlerts(alert)`.
 */
export const heldAlerts = (into) => (e) => { into.push(e); return true; };
// The one list of what an alert object shows the owner (L373, L397): its line is built from these known fields only, so
// nothing else it carries (a GitHub answer, a token) reaches the owner's phone. approvalsAlertText (tick.mjs) and
// alertText both read it, and alert-fields.test.mjs holds every field of every M2 and M6 alert to it. A named list is
// capped so a long one can't bury the line; the record holds the rest.
// `to` reads "moving to" only for a state of the record the alert names, a card if it names one (L421 m-A).
const shows = (v) => ['string', 'number'].includes(typeof v);
export const ALERT_FIELDS = [['merge', 'merge'], ['ask', 'ask'], ['card', 'card'], ['session', 'session'], ['kind', 'kind'], ['pr', 'PR'], ['commit', 'commit'],
  ['report', 'report'], ['to', (v, e) => (STATES[shows(e.card) ? 'card' : 'merge'].includes(v) ? 'moving to' : 'writing')], ['context', 'check'], ['status', 'status'], ['judged_main', 'judged main'], ['parent', 'parent'],
  ['waiting_since', 'waiting since']];
export const ALERT_LIST_MAX = 50;
export const plain = (v, n = 200) => String(v).replace(/[\r\n\t]+/g, ' ').slice(0, n);
// What is left off is counted, a capped name or an item that isn't text alike (L408 m1): no list reads shorter than it is.
export const listed = (list) => {
  const names = list.filter((x) => typeof x === 'string').slice(0, ALERT_LIST_MAX).map((x) => plain(x));
  const left = list.length - names.length;
  return [names.join(', '), left > 0 ? `${left} more` : ''].filter(Boolean).join(names.length ? ' and ' : '');
};
/** The list's fields an alert has, as `label value`. */
export const alertFields = (e, skip = []) => ALERT_FIELDS.filter(([k]) => !skip.includes(k) && shows(e?.[k]))
  .map(([k, label]) => `${typeof label === 'function' ? label(e[k], e) : label} ${plain(e[k], 80)}`);
const listedAs = (label, list) => (Array.isArray(list) && listed(list) ? `${label}: ${listed(list)}` : null);

/** An alert object (or text) as the text the outbox sends: textAlerts' words, for a step that sends it itself. */
export function alertText(e, who = 'merge gate') {
  if (typeof e === 'string') return e;
  const parts = alertFields(e);
  const tail = [listedAs('reasons', e?.reasons), typeof e?.ask_owner === 'string' ? plain(e.ask_owner) : null].filter(Boolean).join('; ');
  return `${who}: ${plain(e?.note ?? e?.reason ?? e?.type ?? 'no detail', Infinity)}${parts.length ? ` (${parts.join(', ')})` : ''}${tail ? `: ${tail}` : ''}`;
}

export function tellThen(alert, text, mark) {
  return alert(text, { mark });
}

/** The text sent for entry `e` carrying `n` dropped alerts. */
export const textToSend = (e, n) => (n ? `${e.text} (${n} older alerts could not be sent and were dropped)` : e.text);

// What a send of `e` carries (#39 round 2, m-A): the dropped one-offs and causes no unsettled send carries
// already. Its own cause is not carried: the alert itself tells it.
// `causes` are the ids of the listed drops its text counts, `k` how many causes they are (listings of one cause
// left by a restart count once); `own` the ids of every listing of its own cause now, out or not, which the
// alert itself tells (#39 round 3, L56; recheck N2).
const carryFor = (rec, d, e) => {
  const out = [...outFor(rec)];
  const n = Math.max(0, (d.dropped ?? 0) - out.reduce((sum, s) => sum + (s.carried?.n ?? 0), 0));
  const taken = carriedIds(rec);
  const free = causesOf(d).filter((c) => !taken.has(c.id));
  const others = free.filter((c) => c.key !== e.key);
  return { n, causes: others.map((c) => c.id), k: new Set(others.map((c) => c.key)).size, own: e.key ? causesOf(d).filter((c) => c.key === e.key).map((c) => c.id) : [] };
};
const carriedCount = (c) => (c?.n ?? 0) + (c?.k ?? c?.causes?.length ?? 0);

// The queued entry a send settles: the same one, or the copy its step queued for the same cause (or with
// the same text) while the send was out. None, when its cause cleared meanwhile (`dropCause`).
const sameAs = (sent) => (x) => x.id === sent.id || (sent.key ? x.key === sent.key : !x.key && x.text === sent.text);

// L527: a delivered alert whose told mark the Record refuses stays on the queue with `delivered_at`, because every site
// reads a missing mark as "not told". Without this it was told every pass, for every alert on the queue. A held entry
// is not sent for a day from that delivery; each pass its mark is tried again, and once it is saved the entry leaves.
// A day on it goes out again, so the cause is told daily at most and never lost. The cap lives on the queue, not on the
// mark that can't be saved. A time that can't be read is no hold: it is sent. `delivered_text` is what went out: a site
// may replace a held entry with a new fact (a different refusal), so when the mark saves, an entry whose text changed
// loses its hold and goes out once instead of leaving unsent (L533). A pass is one process, so nothing in memory can cap
// a queue write refused as well: the entry is then sent each round, which the alert channel turns into an edit of one issue.
const holdsDelivered = (e, now) => {
  if (!e.delivered_at) return false;
  const at = pastTime(e.delivered_at, now);
  return at !== null && now - at < STILL_WAITING_MS;
};
const markRefusedText = (fact, reason) => `a delivered alert's told mark on ${fact} could not be saved (${reason}): that alert now goes out once a day until the mark can be saved`;

/**
 * After one send of entry `sent`: delivered, its mark is written, then it (or the copy that replaced it)
 * leaves the queue (a crash between the two sends it again: twice, never lost). Not delivered, it goes to
 * the back of the queue. An entry whose cause cleared before this ran is gone, and nothing is marked.
 * Delivered with its mark refused, it stays held (holdsDelivered) and the refusal is told once, as an alert of its own;
 * `sent.retry` is that held entry's mark tried again, with nothing sent.
 * `sent.carried` is what its text counted ({ n one-offs, causes }): delivered, only that comes off, so alerts
 * dropped while the send was out are told on the next one (#39 check, M1), and its own cause's drop is cleared.
 */
export function settleAlert(rec, sent, ok, now, why = 'it was not delivered') {
  if (!ok) {
    const held = updateFact(rec, ALERT_QUEUE_FACT, (doc) => {
      const d = doc ?? {};
      const e = entriesOf(d).find(sameAs(sent));
      if (!e) return null;
      // Only the entry that was tried is held, so the held cap counts it; an entry not yet tried counts only
      // against the larger untried cap (audit 0b-6 r8 MAT-2: one text the port always refuses, or one timeout,
      // ahead of a burst).
      const { entries, dropped } = capQueue(rec, [...entriesOf(d).filter((x) => x.id !== e.id), { ...e, held: true, tries: (e.tries ?? 0) + 1 }]);
      return { ...withDrops(rec, d, entries, dropped), error: `an alert could not be sent: ${why}`, at: iso(now) };
    }, 'alert_failed');
    return held?.ok === true ? { ok: true } : { ok: false, reason: `the queue (holding it): ${held?.reason ?? 'no answer'}` };
  }
  const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  const e = entriesOf(d).find(sameAs(sent));
  const told = new Set([...(sent.carried?.causes ?? []), ...(sent.carried?.own ?? [])]);
  if (!e && !carriedCount(sent.carried) && !causesOf(d).some((c) => told.has(c.id))) return { ok: true };
  const gave = [];
  let markRefused = null;
  // The mark goes on only while the entry is still queued, read after the fact and written at the fact's version
  // read (updateFact's loop): every clear site drops its cause before its clear write, so a mark that would land
  // after the clear finds the entry gone (L335 M-1, L341).
  if (e && sent.mark?.fact) {
    const queued = () => entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc).some((x) => x.id === e.id);
    // A mark already on the fact (a copy sent again after a crash) is nothing to write: the Record refuses a write that
    // changes nothing, and that is no refusal to hold on.
    const m = updateFact(rec, sent.mark.fact, (doc) => {
      if (!queued()) return null;
      const next = { ...doc, ...sent.mark.fields };
      return doc && same(next, doc) ? null : next;
    }, sent.mark.kind ?? 'alert_told');
    if (m?.ok !== true) markRefused = String(m?.reason ?? 'no answer').slice(0, 300);
  }
  // Tried again and still refused: it was told when it began, and the entry stays as it is.
  if (markRefused && sent.retry) return { ok: true };
  const firstRefusal = markRefused && !e.delivered_at;
  if (firstRefusal) gave.push(`its mark on ${sent.mark.fact}: ${markRefused}`);
  const queueStuck = (why) => keepOutside(rec, `the alert queue can't be written, so a delivered alert may go out again each round: ${String(why).slice(0, 200)}`, ALERT_QUEUE_FACT);
  let q;
  try { q = updateFact(rec, ALERT_QUEUE_FACT, (doc) => {
    const cur = doc ?? {};
    const dropped = Math.max(0, (cur.dropped ?? 0) - (sent.carried?.n ?? 0));
    const causes = causesOf(cur).filter((c) => !told.has(c.id));
    const unsaid = ({ delivered_at: _at, delivered_text: _said, ...x }) => x;
    const entries = markRefused
      ? entriesOf(cur).map((x) => (x.id === e.id ? { ...x, delivered_at: iso(now), delivered_text: sent.text } : x))
      : entriesOf(cur).flatMap((x) => (x.id !== e?.id ? [x] : sent.retry && x.text !== x.delivered_text ? [unsaid(x)] : []));
    return { ...cur, entries, dropped, dropped_causes: causes, ...(e && { error: null, at: iso(now) }) };
  }, 'alert_sent'); } catch (err) { queueStuck(err?.message ?? err); throw err; }
  if (q?.ok !== true) {
    gave.push(`the queue: ${q?.reason ?? 'no answer'}`);
    queueStuck(q?.reason ?? 'no answer');
  }
  else if (firstRefusal) queueAlert(rec, markRefusedText(sent.mark.fact, markRefused), { now });
  return gave.length ? { ok: false, reason: gave.join('; ') } : { ok: true };
}

// Why one send failed, or null when it was delivered: it threw, answered false, or did not answer within `ms`.
// The port also gets the entry (L237), so a channel can key its issue on the entry's mark; `port(text)` ports ignore it.
async function sendOne(port, text, ms, entry) {
  let timer;
  try {
    const late = new Promise((ok) => { timer = setTimeout(() => ok(LATE), ms); });
    const r = await Promise.race([Promise.resolve().then(() => port(text, entry)), late]);
    return r === LATE ? `it did not answer within ${ms} ms` : r === false ? 'the sender said no' : null;
  } catch (e) { return String(e?.message ?? e); } finally { clearTimeout(timer); }
}
const LATE = Symbol('late');

/**
 * The one sender. Sends the queue in order, each send within `sendMs`, until `budgetMs` is spent. A delivered
 * entry has its mark written, then leaves the queue. The first send that fails stops this round (the port is
 * likely down) and goes to the back of the queue, so one text the port always refuses cannot hold the rest.
 * With `later`, nothing is settled until the returned `settle()` is called: a send running alongside other
 * steps then changes none of their facts under them (audit 0b-6 r7 M1).
 * Returns { sent, failed, left, settle }; never throws.
 */
export async function sendAlerts(rec, port, now, { sendMs = ALERT_SEND_MS, budgetMs = ALERT_BUDGET_MS, clock = Date.now, later = false, report = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const done = [];
  const inFlight = outFor(rec);
  const settle = () => {
    for (const [e, ok, why] of done.splice(0)) {
      inFlight.delete(e);
      let r;
      try { r = settleAlert(rec, e, ok, now, why); } catch (err) { r = { ok: false, reason: String(err?.message ?? err) }; }
      // A settle that gave up is a diary line, never ignored (L335 m-2, L323): the entry may be sent again.
      if (r?.ok === false) {
        let noted;
        try { noted = note(rec, `step-error-alert-settle-${e.id}` /* the Dispatcher's own family (alert- is the ledger's) */, `alert ${e.id} was ${ok ? 'sent' : 'not sent'}, but its record could not be written (${String(r.reason).slice(0, 300)}); it may be sent again`, { now }); } catch (err) { noted = { ok: false, reason: String(err?.message ?? err) }; }
        // Refused too: the log line is what is left (L354 item 6).
        if (noted?.ok !== true) report(`alert ${e.id}: the settle gave up (${String(r.reason).slice(0, 300)}) and its note was refused (${noted?.reason ?? 'no answer'})`);
      }
    }
  };
  const out = Object.defineProperty({ sent: 0, failed: 0, left: 0 }, 'settle', { value: settle });
  try {
    const start = clock();
    for (const e of entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc)) {
      if (clock() - start + sendMs > budgetMs && out.sent + out.failed > 0) break;
      const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
      if (!entriesOf(d).some((x) => x.id === e.id)) continue;
      // Held, delivered within the day: nothing is sent, and its mark is tried again when the round settles.
      if (holdsDelivered(e, now)) { done.push([{ ...e, retry: true }, true, null]); if (!later) settle(); continue; }
      // The count of dropped alerts rides on the next copy sent; the copy keeps what it carried, so a second
      // copy, in this round or one alongside it, carries only what none still out carries.
      const sent = { ...e, carried: carryFor(rec, d, e) };
      inFlight.add(sent);
      const why = await sendOne(port, textToSend(e, carriedCount(sent.carried)), sendMs, sent);
      const ok = why === null;
      done.push([sent, ok, why]);
      if (!later) settle();
      if (!ok) { out.failed += 1; break; }
      out.sent += 1;
    }
    out.left = entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc).length;
  } catch { /* the record is unreadable: the pass itself fails and tells */ }
  return out;
}

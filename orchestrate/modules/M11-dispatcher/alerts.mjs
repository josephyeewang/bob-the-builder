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

const iso = (ms) => new Date(ms).toISOString();
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

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
 * Returns the entry's id, or null when the record refused it.
 */
export function queueAlert(rec, text, { now, mark = null } = {}) {
  const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  const key = keyOf(mark);
  const next = (d.next ?? 0) + 1;
  const entry = { id: `a${next}`, key, text: String(text), mark, queued_at: iso(now) };
  const all = entriesOf(d).slice();
  const i = all.findIndex((e) => (key ? e.key === key : !e.key && e.text === entry.text));
  if (i >= 0) all[i] = entry; else all.push(entry);
  const { entries, dropped } = capQueue(rec, all);
  return putFact(rec, ALERT_QUEUE_FACT, { ...withDrops(rec, d, entries, dropped), next }, 'alert_queued').ok === true ? entry.id : null;
}

/**
 * The cause on `fact` has cleared: its queued entries leave unsent (audit 0b-6 r7 M2), and a drop of it no
 * longer counts (L52). Every fact a told
 * mark goes on has a step that calls this where the cause clears, or a line in alert-sites.test.mjs saying
 * why a late mark there is harmless. Returns whether the queue was written; never throws.
 */
export function dropCause(rec, fact) {
  try {
    const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc;
    const left = entriesOf(d).filter((e) => e.mark?.fact !== fact);
    const causes = causesOf(d).filter((c) => c.fact !== fact);
    if (left.length === entriesOf(d).length && causes.length === causesOf(d).length) return true;
    return putFact(rec, ALERT_QUEUE_FACT, { ...d, entries: left, dropped_causes: causes }, 'alert_cause_cleared').ok === true;
  } catch { return false; }
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

/**
 * After one send of entry `sent`: delivered, its mark is written, then it (or the copy that replaced it)
 * leaves the queue (a crash between the two sends it again: twice, never lost). Not delivered, it goes to
 * the back of the queue. An entry whose cause cleared before this ran is gone, and nothing is marked.
 * `sent.carried` is what its text counted ({ n one-offs, causes }): delivered, only that comes off, so alerts
 * dropped while the send was out are told on the next one (#39 check, M1), and its own cause's drop is cleared.
 */
export function settleAlert(rec, sent, ok, now, why = 'it was not delivered') {
  const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  const e = entriesOf(d).find(sameAs(sent));
  if (!ok) {
    if (!e) return;
    // Only the entry that was tried is held, so the held cap counts it; an entry not yet tried counts only
    // against the larger untried cap (audit 0b-6 r8 MAT-2: one text the port always refuses, or one timeout,
    // ahead of a burst).
    const { entries, dropped } = capQueue(rec, [...entriesOf(d).filter((x) => x.id !== e.id), { ...e, held: true, tries: (e.tries ?? 0) + 1 }]);
    putFact(rec, ALERT_QUEUE_FACT, { ...withDrops(rec, d, entries, dropped), error: `an alert could not be sent: ${why}`, at: iso(now) }, 'alert_failed');
    return;
  }
  const told = new Set([...(sent.carried?.causes ?? []), ...(sent.carried?.own ?? [])]);
  if (!e && !carriedCount(sent.carried) && !causesOf(d).some((c) => told.has(c.id))) return;
  if (e && sent.mark?.fact) putFact(rec, sent.mark.fact, { ...rec.read('fact', sent.mark.fact)?.doc, ...sent.mark.fields }, sent.mark.kind ?? 'alert_told');
  const cur = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  const dropped = Math.max(0, (cur.dropped ?? 0) - (sent.carried?.n ?? 0));
  const causes = causesOf(cur).filter((c) => !told.has(c.id));
  putFact(rec, ALERT_QUEUE_FACT, { ...cur, entries: entriesOf(cur).filter((x) => x.id !== e?.id), dropped, dropped_causes: causes, ...(e && { error: null, at: iso(now) }) }, 'alert_sent');
}

// Why one send failed, or null when it was delivered: it threw, answered false, or did not answer within `ms`.
async function sendOne(port, text, ms) {
  let timer;
  try {
    const late = new Promise((ok) => { timer = setTimeout(() => ok(LATE), ms); });
    const r = await Promise.race([Promise.resolve().then(() => port(text)), late]);
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
export async function sendAlerts(rec, port, now, { sendMs = ALERT_SEND_MS, budgetMs = ALERT_BUDGET_MS, clock = Date.now, later = false } = {}) {
  const done = [];
  const inFlight = outFor(rec);
  const settle = () => {
    for (const [e, ok, why] of done.splice(0)) {
      inFlight.delete(e);
      try { settleAlert(rec, e, ok, now, why); } catch { /* the next pass sends it again */ }
    }
  };
  const out = Object.defineProperty({ sent: 0, failed: 0, left: 0 }, 'settle', { value: settle });
  try {
    const start = clock();
    for (const e of entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc)) {
      if (clock() - start + sendMs > budgetMs && out.sent + out.failed > 0) break;
      const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
      if (!entriesOf(d).some((x) => x.id === e.id)) continue;
      // The count of dropped alerts rides on the next copy sent; the copy keeps what it carried, so a second
      // copy, in this round or one alongside it, carries only what none still out carries.
      const sent = { ...e, carried: carryFor(rec, d, e) };
      inFlight.add(sent);
      const why = await sendOne(port, textToSend(e, carriedCount(sent.carried)), sendMs);
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

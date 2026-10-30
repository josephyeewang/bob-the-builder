// The one outbox for Joe's alerts (LEAD-CALLS L47; audit 0b-6 r6 MAT-A, MAT-B, MAT-C).
//
// Every alert site only drops an entry in a saved queue (the fact `alert-unsent`): `outbox(rec, now)`
// gives the `alert(text)` every step gets, and it never sends, waits or throws. One sender,
// `sendAlerts`, delivers the queue at the end of each pass, each send with a short deadline. An entry
// leaves the queue only after its send went through; a send that fails, answers false or does not
// answer in time leaves it queued for the next pass. A cause is marked told (`mark`) only when a copy
// of its alert is delivered, by the sender, so a crash between queueing and sending loses nothing.
// No other file calls the alert port: the sweep in alert-sites.test.mjs checks it.
// When a cause clears, its step drops the cause's queued entry (`dropCause`, audit 0b-6 r7 M2), so a copy
// delivered later can neither mark the next occurrence as told nor tell Joe about what has passed.

const iso = (ms) => new Date(ms).toISOString();
const putFact = (rec, id, doc, kind) => rec.write({ actor: 'dispatcher', entity: 'fact', id, expectRev: rec.read('fact', id)?.rev ?? 0, doc, kind });

export const ALERT_QUEUE_FACT = 'alert-unsent';
export const ALERT_QUEUE_MAX = 50;
export const ALERT_SEND_MS = 10_000;
// One sender's time in a pass (audit 0b-6 r7 m1): the pass sends twice, at its start and at its end, and
// every step at its deadline plus both sends fits inside main.mjs's run deadline.
export const ALERT_BUDGET_MS = 2 * ALERT_SEND_MS;

const entriesOf = (d) => (Array.isArray(d?.entries) ? d.entries : []);
// One cause, one entry: the key is the fact its told mark goes on, with the fields it sets.
const keyOf = (mark) => (mark ? `${mark.fact}:${Object.keys(mark.fields ?? {}).sort().join(',')}` : null);
// The cap counts only entries that have waited through a failed send (`held`; audit 0b-6 r7 M3): a burst
// queued while sending works is all sent. The oldest held entries go first; the number dropped is told.
const capHeld = (all) => {
  const held = all.filter((e) => e.held);
  const over = Math.max(0, held.length - ALERT_QUEUE_MAX);
  const gone = new Set(held.slice(0, over).map((e) => e.id));
  return { entries: all.filter((e) => !gone.has(e.id)), over };
};

/**
 * Queues one alert. `mark` = { fact, fields, kind }: written onto that fact (merged into it) once the alert
 * is delivered. A second alert for the same cause, or with the same text, replaces the queued one in place.
 * Of the entries that waited through a failed send, the queue keeps the newest ALERT_QUEUE_MAX; the dropped
 * are counted in the next text sent.
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
  const { entries, over } = capHeld(all);
  return putFact(rec, ALERT_QUEUE_FACT, { ...d, entries, next, dropped: (d.dropped ?? 0) + over }, 'alert_queued').ok === true ? entry.id : null;
}

/**
 * The cause on `fact` has cleared: its queued entries leave unsent (audit 0b-6 r7 M2). Every fact a told
 * mark goes on has a step that calls this where the cause clears, or a line in alert-sites.test.mjs saying
 * why a late mark there is harmless. Returns whether the queue was written; never throws.
 */
export function dropCause(rec, fact) {
  try {
    const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc;
    const left = entriesOf(d).filter((e) => e.mark?.fact !== fact);
    if (left.length === entriesOf(d).length) return true;
    return putFact(rec, ALERT_QUEUE_FACT, { ...d, entries: left }, 'alert_cause_cleared').ok === true;
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
 * mark is written by `sendAlerts` once a copy is delivered. Until then the cause stays untold, so its step
 * queues it again (the same entry, not a second one). Every "told" write in this folder sits in a
 * `tellThen` call: the sweep in alert-sites.test.mjs checks it.
 */
export function tellThen(alert, text, mark) {
  return alert(text, { mark });
}

/** The text the sender sends for the first entry: the count of dropped alerts rides on it. */
export const textToSend = (d, e) => (d?.dropped ? `${e.text} (${d.dropped} older alerts could not be sent and were dropped)` : e.text);

// The queued entry a send settles: the same one, or the copy its step queued for the same cause (or with
// the same text) while the send was out. None, when its cause cleared meanwhile (`dropCause`).
const sameAs = (sent) => (x) => x.id === sent.id || (sent.key ? x.key === sent.key : !x.key && x.text === sent.text);

/**
 * After one send of entry `sent`: delivered, its mark is written, then it (or the copy that replaced it)
 * leaves the queue (a crash between the two sends it again: twice, never lost). Not delivered, it goes to
 * the back of the queue. An entry whose cause cleared before this ran is gone, and nothing is marked.
 */
export function settleAlert(rec, sent, ok, now, why = 'it was not delivered') {
  const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  const e = entriesOf(d).find(sameAs(sent));
  if (!e) return;
  const rest = entriesOf(d).filter((x) => x.id !== e.id);
  if (!ok) {
    // Every entry still queued has now waited through a failed send, so the cap counts it.
    const { entries, over } = capHeld([...rest, { ...e, tries: (e.tries ?? 0) + 1 }].map((x) => ({ ...x, held: true })));
    putFact(rec, ALERT_QUEUE_FACT, { ...d, entries, dropped: (d.dropped ?? 0) + over, error: `an alert could not be sent: ${why}`, at: iso(now) }, 'alert_failed');
    return;
  }
  if (sent.mark?.fact) putFact(rec, sent.mark.fact, { ...rec.read('fact', sent.mark.fact)?.doc, ...sent.mark.fields }, sent.mark.kind ?? 'alert_told');
  const cur = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
  putFact(rec, ALERT_QUEUE_FACT, { ...cur, entries: entriesOf(cur).filter((x) => x.id !== e.id), dropped: 0, error: null, at: iso(now) }, 'alert_sent');
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
  const settle = () => { for (const [e, ok, why] of done.splice(0)) { try { settleAlert(rec, e, ok, now, why); } catch { /* the next pass sends it again */ } } };
  const out = Object.defineProperty({ sent: 0, failed: 0, left: 0 }, 'settle', { value: settle });
  try {
    const start = clock();
    let droppedTold = false;
    for (const e of entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc)) {
      if (clock() - start + sendMs > budgetMs && out.sent + out.failed > 0) break;
      const d = rec.read('fact', ALERT_QUEUE_FACT)?.doc ?? {};
      if (!entriesOf(d).some((x) => x.id === e.id)) continue;
      // The count of dropped alerts rides on the first copy delivered, once.
      const text = droppedTold ? e.text : textToSend(d, e);
      const why = await sendOne(port, text, sendMs);
      const ok = why === null;
      done.push([e, ok, why]);
      if (!later) settle();
      if (!ok) { out.failed += 1; break; }
      droppedTold = true;
      out.sent += 1;
    }
    out.left = entriesOf(rec.read('fact', ALERT_QUEUE_FACT)?.doc).length;
  } catch { /* the record is unreadable: the pass itself fails and tells */ }
  return out;
}

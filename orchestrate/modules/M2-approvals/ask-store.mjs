// ask-store.mjs — how M2 reads and writes its asks and gos in the M9 record (0b-5 spec review round 1 m6, round 2 m2-9).
//
// WHY. Only the `approvals` actor may write an ask or a go (M9's who-may-change-what table). M2's reader checks it again:
// an ask or go whose latest diary line was written by anyone else is not trusted, and is alerted once per pass. Every
// write carries the whole document (the writer compares every field), as actor `approvals`, at the rev just read.
//
//   const st = askStore(record);           one snapshot of the diary's writers, taken now
//   st.asks() → [{ id, rev, doc }]          trusted asks only
//   st.ask(id) / st.go(id) → { id, rev, doc } | null
//   st.gos() → [{ id, rev, doc }]
//   st.untrusted → [`ask/<id>`, …]          for the caller's alert
//   writeDoc(record, entity, cur, doc) → the record's answer (cur = null to create)   M2's own modules only (L85 m-3)
//   consumeAsk(ctx, id, note = {}) → the record's answer | { ok: false, reason }        for modules outside M2
//   markPushSent(ctx, id, kinds) → the record's answer | { ok: false, reason }        once a pass's push has gone out
//
// consumeAsk is the one way another module (e.g. the Dispatcher's cleanup) closes an ask, and it does only that: a
// trusted ask that is `answered` becomes `consumed`, with `consumed_at` set here. Every other state is refused. `note`
// may hold only the fields in NOTE_KEYS (L95, audit stack r3 Minor 7: a free note could add a `wait`, which puts the ask
// back on the owner's waiting list, or a `request`, which stops a report from ever opening): each a string of at most
// 500 characters, a finite number, or null, and never a field already on the ask. (A research ask's open → consumed
// joins once the record's research move is on main.)
// No module outside M2 imports writeDoc: consume-ask.test.mjs fails on one that does.

const ACTOR = 'approvals';

export function lastWriters(record) {
  const by = new Map();
  for (const line of record.diary({ since: 0 })) {
    for (const w of line.writes ?? []) by.set(`${w.entity}/${w.id}`, line.actor);
  }
  return by;
}

export function askStore(record) {
  const writers = lastWriters(record);
  const untrusted = [];
  const trusted = (entity, e) => {
    if (!e || e.corrupt || !e.doc || typeof e.doc !== 'object') return null;
    if (writers.get(`${entity}/${e.id}`) !== ACTOR) { untrusted.push(`${entity}/${e.id}`); return null; }
    return { id: e.id, rev: e.rev, doc: structuredClone(e.doc) };
  };
  const all = (entity) => record.list(entity).map((e) => trusted(entity, e)).filter(Boolean);
  return {
    untrusted,
    asks: () => all('ask'),
    gos: () => all('go'),
    ask: (id) => trusted('ask', record.read('ask', id)),
    go: (id) => trusted('go', record.read('go', id)),
  };
}

export function writeDoc(record, entity, cur, doc) {
  return record.write({ actor: ACTOR, entity, id: cur.id, expectRev: cur.rev ?? 0, doc });
}

// What the Dispatcher's copy cleanup records when it consumes its delete-copy ask (lane 2's M11 cleanup.mjs): the card
// change it kept the copy at, and why a delete didn't happen. A new key is added here, with its reader named.
export const NOTE_KEYS = Object.freeze(['kept_at_card_change', 'not_deleted']);
const isPlain = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
const noteValue = (v) => v === null || (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v));

export function consumeAsk(ctx, id, note = {}) {
  const a = askStore(ctx.record).ask(id);
  if (!a) return { ok: false, reason: `no trusted ask ${id}` };
  if (a.doc.state !== 'answered') return { ok: false, reason: `ask ${id} is ${a.doc.state}, not answered` };
  if (!isPlain(note)) return { ok: false, reason: 'the note is not a plain object' };
  for (const k of Reflect.ownKeys(note)) {
    if (typeof k !== 'string' || !NOTE_KEYS.includes(k) || Object.hasOwn(a.doc, k)) return { ok: false, reason: `the note may not set ${String(k)}` };
    if (!noteValue(note[k])) return { ok: false, reason: `the note's ${k} is not a short text, a number or null` };
  }
  const add = Object.fromEntries(NOTE_KEYS.filter((k) => Object.hasOwn(note, k)).map((k) => [k, note[k]]));
  return writeDoc(ctx.record, 'ask', a, { ...a.doc, ...add, state: 'consumed', consumed_at: new Date(ctx.now()).toISOString() });
}

// A push a pass hands back (a research ask's "on your waiting list", an undo-by-hand note) is handed back on every pass
// until its sender marks it sent here (L95, audit stack r3 Minors 1 and 3). Only an open, trusted ask of the kinds given;
// once set, push_sent_at is never moved, so a second call is refused and nothing is pushed twice.
export function markPushSent(ctx, id, kinds) {
  const a = askStore(ctx.record).ask(id);
  if (!a) return { ok: false, reason: `no trusted ask ${id}` };
  if (!Array.isArray(kinds) || !kinds.includes(a.doc.kind)) return { ok: false, reason: `ask ${id} is not a ${[].concat(kinds).join(' or ')} ask` };
  if (a.doc.state !== 'open') return { ok: false, reason: `ask ${id} is ${a.doc.state}, not open` };
  if (a.doc.push_sent_at) return { ok: false, reason: `ask ${id}'s push is already marked sent` };
  return writeDoc(ctx.record, 'ask', a, { ...a.doc, push_sent_at: new Date(ctx.now()).toISOString() });
}
